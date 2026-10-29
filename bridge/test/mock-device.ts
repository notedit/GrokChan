import { decodeFrame, encodeFrame, FRAME_UPLINK_AUDIO, PROTOCOL, type DecodedFrame } from "../src/device/protocol";
import { sleep, waitFor } from "./harness";

export type LogEntry =
  | { kind: "request"; method: string; msg: any }
  | { kind: "notification"; method: string; msg: any }
  | { kind: "binary"; frame: DecodedFrame }
  | { kind: "response"; msg: any };

export interface MockOptions {
  /** Per-method delay before the response (ms). */
  delay?: Record<string, number>;
  /** Per-method forced JSON-RPC error. */
  errors?: Record<string, { code: number; message: string; data?: unknown }>;
  /** Methods that are never answered. */
  ignore?: Set<string>;
  /** Per-method result override. */
  results?: Record<string, (params: any) => unknown>;
  /** Send playback.state notifications for speak streams (default true). */
  playback?: boolean;
  /** Delay between `audio.end complete` and `playback.state ended` (default 0). Use a big value to keep a turn in `speaking`. */
  playbackEndDelayMs?: number;
  /** Extra session.hello params. */
  hello?: Record<string, unknown>;
  /** Cache by params._meta.idempotency_key like a real device (default true). */
  dedup?: boolean;
  /** Device Bearer token for /ws/device (required when STACKCHAN auth is on). */
  token?: string;
}

/** A fake Stack-chan: speaks mediasession-rpc/1 over a real WebSocket to `wrangler dev`. */
export class MockDevice {
  ws!: WebSocket;
  log: LogEntry[] = [];
  closed: { code: number; reason: string } | null = null;
  helloResult: any = null;
  private idem = new Map<string, unknown>();
  private n = 0;
  opts: MockOptions;

  constructor(
    readonly base: string,
    readonly deviceId: string,
    opts: MockOptions = {},
  ) {
    this.opts = { playback: true, dedup: true, ...opts };
  }

  /** Open the socket (no hello yet). Sends Authorization + Device-Id when a token is configured. */
  async connect(query = `device_id=${this.deviceId}`): Promise<void> {
    const headers: Record<string, string> = { "Device-Id": this.deviceId };
    if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;
    // Node 22+ undici WebSocket accepts { headers }; browsers cannot set Authorization on WS.
    this.ws = new (WebSocket as unknown as new (u: string, o?: { headers?: Record<string, string> }) => WebSocket)(
      `${this.base.replace("http", "ws")}/ws/device?${query}`,
      { headers },
    );
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (ev) => this.onMessage(ev.data as string | ArrayBuffer));
    this.ws.addEventListener("close", (ev) => (this.closed = { code: ev.code, reason: ev.reason }));
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res(), { once: true });
      this.ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
    });
  }

  helloParams(): Record<string, unknown> {
    return {
      protocol: PROTOCOL,
      device_id: this.deviceId,
      fw: "0.1.0-mock",
      hw: "m5stack-stackchan",
      caps: ["head", "led", "display", "speaker"],
      limits: { pan: [-90, 90], tilt: [0, 60], volume_cap: 70 },
      expressions: ["neutral", "happy"],
      audio: { play: [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }], max_chunk_bytes: 4096, buffer_ms: 2000 },
      ...this.opts.hello,
    };
  }

  /** connect + session.hello, waits for the response. */
  async start(): Promise<this> {
    await this.connect();
    const r = await this.request("session.hello", this.helloParams());
    if (r.error) throw new Error("hello failed: " + JSON.stringify(r.error));
    this.helloResult = r.result;
    return this;
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }
  /** Device-initiated JSON-RPC request; resolves with the full response object. */
  request(method: string, params?: unknown): Promise<any> {
    const id = `d_${++this.n}`;
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return waitFor(() => {
      const e = this.log.find((x) => x.kind === "response" && x.msg.id === id);
      return e && e.kind === "response" ? e.msg : undefined;
    }, 5000);
  }
  close(code = 1000): void {
    this.ws.close(code);
  }
  async waitClosed(): Promise<{ code: number; reason: string }> {
    return waitFor(() => this.closed ?? undefined, 8000);
  }

  // ---- inspection helpers ----
  requests(method?: string): any[] {
    return this.log.filter((e): e is Extract<LogEntry, { kind: "request" }> => e.kind === "request" && (!method || e.method === method)).map((e) => e.msg);
  }
  notifications(method?: string): any[] {
    return this.log.filter((e): e is Extract<LogEntry, { kind: "notification" }> => e.kind === "notification" && (!method || e.method === method)).map((e) => e.msg);
  }
  frames(): DecodedFrame[] {
    return this.log.filter((e): e is Extract<LogEntry, { kind: "binary" }> => e.kind === "binary").map((e) => e.frame);
  }
  /** Order of everything the bridge sent, as short labels, e.g. ["device.speak","audio.begin","bin:0","audio.end"]. */
  trace(): string[] {
    return this.log.flatMap((e) => (e.kind === "request" ? [e.method] : e.kind === "notification" ? [e.method] : e.kind === "binary" ? [`bin:${e.frame.seq}`] : []));
  }
  // ---- voice (uplink) helpers ----
  private upStream = 100;
  speechStart(params: Record<string, unknown> = {}): void {
    this.notify("event.speech_start", params);
  }
  speechEnd(params: Record<string, unknown> = {}): void {
    this.notify("event.speech_end", params);
  }
  /** audio.begin (uplink). Returns the stream id. */
  uplinkBegin(extra: Record<string, unknown> = {}, streamId = ++this.upStream): number {
    this.notify("audio.begin", { stream_id: streamId, direction: "uplink", format: "pcm_s16le", sample_rate: 16000, channels: 1, ...extra });
    return streamId;
  }
  /** One 0x02 frame. The mock ASR reads the payload as UTF-8 text, so odd lengths are space-padded. */
  uplinkFrame(streamId: number, seq: number, data: string | Uint8Array, last = false): void {
    let bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (bytes.byteLength % 2) {
      const p = new Uint8Array(bytes.byteLength + 1);
      p.set(bytes);
      p[bytes.byteLength] = 0x20;
      bytes = p;
    }
    this.ws.send(encodeFrame(FRAME_UPLINK_AUDIO, streamId, seq, bytes, last));
  }
  uplinkEnd(streamId: number, extra: Record<string, unknown> = {}): void {
    this.notify("audio.end", { stream_id: streamId, reason: "complete", ...extra });
  }
  /** Whole utterance: speech_start, begin, frames (the text is split in `chunks` parts), audio.end, speech_end. */
  async say(text: string, o: { chunks?: number; chunkDelayMs?: number; speech?: boolean; end?: boolean; lang?: string } = {}): Promise<number> {
    const parts = Math.max(1, o.chunks ?? 1);
    const chars = [...text];
    const per = Math.ceil(chars.length / parts);
    if (o.speech !== false) this.speechStart();
    const id = this.uplinkBegin(o.lang ? { lang: o.lang } : {});
    for (let i = 0; i < parts; i++) {
      this.uplinkFrame(id, i, chars.slice(i * per, (i + 1) * per).join("") || " ", false);
      if (o.chunkDelayMs) await sleep(o.chunkDelayMs);
    }
    if (o.end !== false) {
      this.uplinkEnd(id, { total_chunks: parts });
      if (o.speech !== false) this.speechEnd();
    }
    return id;
  }
  /** turn.state notifications, in order (labels like "listening", "idle:barge_in"). */
  turnStates(): string[] {
    return this.notifications("turn.state").map((m) => m.params.state + (m.params.state === "idle" && m.params.reason ? ":" + m.params.reason : ""));
  }
  lastTurnId(): string | undefined {
    return this.notifications("turn.state").filter((m) => m.params.turn_id).at(-1)?.params.turn_id;
  }
  transcripts(final?: boolean): any[] {
    return this.notifications("asr.transcript").map((m) => m.params).filter((p) => final === undefined || p.final === final);
  }
  /** Downlink audio streams as the device saw them. */
  audioStreams(): { id: number; begin: any; frames: DecodedFrame[]; end?: any; bytes: number }[] {
    const out = new Map<number, { id: number; begin: any; frames: DecodedFrame[]; end?: any; bytes: number }>();
    for (const e of this.log) {
      if (e.kind === "notification" && e.method === "audio.begin") out.set(e.msg.params.stream_id, { id: e.msg.params.stream_id, begin: e.msg.params, frames: [], bytes: 0 });
      else if (e.kind === "binary" && e.frame.type === 0x01) {
        const st = out.get(e.frame.streamId);
        if (st) {
          st.frames.push(e.frame);
          st.bytes += e.frame.payload.byteLength;
        }
      } else if (e.kind === "notification" && e.method === "audio.end") {
        const st = out.get(e.msg.params.stream_id);
        if (st) st.end = e.msg.params;
      }
    }
    return [...out.values()];
  }
  async waitForState(state: string, ms = 5000): Promise<void> {
    await waitFor(() => this.turnStates().at(-1)?.startsWith(state) || undefined, ms).catch(() => {
      throw new Error(`turn never reached ${state}; saw ${JSON.stringify(this.turnStates())}`);
    });
  }
  async waitForRequest(method: string, ms = 5000): Promise<any> {
    return waitFor(() => this.requests(method)[0], ms);
  }

  // ---- internals ----
  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      const frame = decodeFrame(data);
      if (frame) this.log.push({ kind: "binary", frame: { ...frame, payload: frame.payload.slice() } });
      return;
    }
    const msg = JSON.parse(data);
    if (msg.method && msg.id !== undefined) {
      this.log.push({ kind: "request", method: msg.method, msg });
      void this.handle(msg);
    } else if (msg.method) {
      this.log.push({ kind: "notification", method: msg.method, msg });
      if (this.opts.playback && msg.method === "audio.begin") this.notify("playback.state", { stream_id: msg.params.stream_id, state: "started" });
      if (this.opts.playback && msg.method === "audio.end" && msg.params.reason === "complete") {
        const sid = msg.params.stream_id;
        const ms = this.opts.playbackEndDelayMs ?? 0;
        if (ms > 0)
          setTimeout(() => {
            if (this.ws.readyState === WebSocket.OPEN) this.notify("playback.state", { stream_id: sid, state: "ended" });
          }, ms);
        else this.notify("playback.state", { stream_id: sid, state: "ended" });
      }
    } else {
      this.log.push({ kind: "response", msg });
    }
  }

  private async handle(req: any): Promise<void> {
    const { method, params = {}, id } = req;
    if (this.opts.ignore?.has(method)) return;
    const d = this.opts.delay?.[method];
    if (d) await sleep(d);
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const key = params._meta?.idempotency_key as string | undefined;
    if (this.opts.dedup && key && this.idem.has(key)) {
      const prev = this.idem.get(key) as any;
      return this.send({ jsonrpc: "2.0", id, result: { ...prev, _meta: { deduplicated: true } } });
    }
    const err = this.opts.errors?.[method];
    if (err) return this.send({ jsonrpc: "2.0", id, error: err });
    const result = this.opts.results?.[method] ? this.opts.results[method]!(params) : this.defaultResult(method, params);
    if (result === undefined) return this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    if (key) this.idem.set(key, result);
    this.send({ jsonrpc: "2.0", id, result });
  }

  private defaultResult(method: string, p: any): unknown {
    switch (method) {
      case "device.get_status":
        return { battery: { percent: 87, charging: false }, volume: 40, muted: false, pose: { pan: 0, tilt: 0 }, expression: "neutral", uptime_s: 12 };
      case "device.move_head":
        return { pan: p.pan ?? 0, tilt: p.tilt ?? 0 };
      case "device.reset_pose":
        return { pan: 0, tilt: 0 };
      case "device.set_expression":
        return { expression: p.expression };
      case "device.show_text":
        return { shown: !p.clear, truncated: false };
      case "device.set_led":
        return { applied_rgb: { r: Math.min(p.r, 168), g: Math.min(p.g, 168), b: Math.min(p.b, 168) } };
      case "device.speak":
        return { accepted: true, stream_id: p.stream_id, queue_position: 0 };
      case "device.stop_audio":
        return { stopped: p.stream_id ? [p.stream_id] : [], cleared: 0 };
      case "device.set_volume":
        return { volume: p.volume ?? 40, muted: p.mute ?? false };
      case "device.emergency_stop":
        return { motion_halted: true, audio_stopped: true };
      default:
        return undefined;
    }
  }
}
