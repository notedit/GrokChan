import { DurableObject } from "cloudflare:workers";
import { getTtsProvider, TtsError } from "../tts";
import type { DeviceCall, DeviceError, DeviceOutcome, SpeakCall } from "./gateway";
import type { DeviceRegistry } from "./registry";
import {
  classify,
  encodeFrame,
  FRAME_DOWNLINK_AUDIO,
  isObject,
  mapDeviceError,
  parseHello,
  PING_TEXT,
  PONG_TEXT,
  RPC,
  rpcError,
  rpcNotification,
  rpcRequest,
  rpcResult,
  type HelloInfo,
  type RpcErrorObject,
  type RpcId,
  type RpcRequest,
  type RpcNotification,
  type RpcResponse,
} from "./protocol";

export interface DeviceEnv {
  REGISTRY: DurableObjectNamespace<DeviceRegistry>;
  TTS_PROVIDER?: string;
  /** Wait for a JSON-RPC response from the device (3000; speak 5000). */
  DEVICE_CMD_TIMEOUT_MS?: string;
  /** Device must send session.hello within this (10000). */
  HELLO_TIMEOUT_MS?: string;
  /** Non-emergency commands per second per device (20). */
  DEVICE_RATE_LIMIT_PER_SEC?: string;
  /** Test knob: pause between audio chunks (0). */
  AUDIO_CHUNK_DELAY_MS?: string;
}

const DEDUP_WINDOW_MS = 60_000;
const MAX_QUEUED_SPEAKS = 3;
const MAX_STATE_BYTES = 8192;
const HEARTBEAT_S = 20;
const STATE_KEYS = ["battery", "volume", "muted", "brightness", "pose", "expression", "led", "playback", "uptime_s", "privacy", "wifi_rssi"] as const;

interface Attachment {
  device_id: string;
  hello: boolean;
  session_id?: string;
  connected_at: number;
}

interface Pending {
  ws: WebSocket;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: RpcResult) => void;
}
type RpcResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: DeviceError };

interface StreamCtx {
  aborted: boolean;
  playback: "none" | "started" | "ended" | "interrupted" | "error";
  message?: string;
  wake: Set<() => void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const randId = (prefix: string) => prefix + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * One Durable Object per device (addressed by device id). Holds the device's
 * hibernating WebSocket and speaks JSON-RPC 2.0 (`grokchan-rpc/1`) with it:
 * commands are requests, state/events are notifications, audio is binary
 * frames delimited by audio.begin / audio.end. See docs/mcp-plan.zh-CN.md 3.
 *
 * TODO(auth): authenticate the WebSocket handshake with a per-device token
 * (hashed at rest) in the Worker router before it reaches this object.
 */
export class DeviceHub extends DurableObject<DeviceEnv> {
  private pending = new Map<string, Pending>();
  private inflight = new Map<string, Promise<DeviceOutcome>>();
  private streams = new Map<number, StreamCtx>();
  private activeStream: StreamCtx | null = null;
  private speakTail: Promise<void> = Promise.resolve();
  private speakQueued = 0;
  private epoch = 0;
  private rate = { start: 0, count: 0 };
  private seq = 0;

  constructor(ctx: DurableObjectState, env: DeviceEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
  }

  // ------------------------------------------------------------------ WebSocket

  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const deviceId = req.headers.get("x-device-id");
    if (!deviceId) return new Response("missing device id", { status: 400 });
    await this.ctx.storage.put("device_id", deviceId);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ device_id: deviceId, hello: false, connected_at: Date.now() } satisfies Attachment);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + num(this.env.HELLO_TIMEOUT_MS, 10_000));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    const timeout = num(this.env.HELLO_TIMEOUT_MS, 10_000);
    const now = Date.now();
    let next = Infinity;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a || a.hello) continue;
      if (a.connected_at + timeout <= now) {
        try {
          ws.close(4001, "hello timeout");
        } catch {}
        this.failPending(ws, "device_offline", "connection closed before session.hello");
      } else next = Math.min(next, a.connected_at + timeout);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (typeof message !== "string") return; // M1: no device->bridge binary frames (mic/photo are M3)
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.send(ws, rpcError(null, RPC.PARSE_ERROR, "Parse error"));
      return;
    }
    const c = classify(parsed);
    if (c.kind === "invalid") {
      if (att.hello) this.send(ws, rpcError(c.id, RPC.INVALID_REQUEST, "Invalid Request"));
      return;
    }
    if (c.kind === "request") return this.onDeviceRequest(ws, att, c.msg);
    if (!att.hello) return; // everything except session.hello is dropped before hello
    if (c.kind === "response") return this.onResponse(ws, c.msg);
    return this.onNotification(c.msg);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
    await this.onGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket): Promise<void> {
    this.failPending(ws, "device_offline", "device disconnected");
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.hello && !this.live()) {
      this.abortAudio();
      await this.registry().seen(att.device_id).catch(() => {});
    }
  }

  private async onDeviceRequest(ws: WebSocket, att: Attachment, req: RpcRequest): Promise<void> {
    if (req.method !== "session.hello") {
      if (att.hello) this.send(ws, rpcError(req.id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`));
      return;
    }
    const parsed = parseHello(req.params, att.device_id);
    if (!parsed.ok) {
      this.send(ws, rpcError(req.id, RPC.INVALID_PARAMS, parsed.message));
      try {
        ws.close(4009, "protocol error");
      } catch {}
      return;
    }
    const hello = parsed.hello;
    // A new session replaces any previous one for this device.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const oa = other.deserializeAttachment() as Attachment | null;
      if (oa?.hello) {
        this.failPending(other, "device_offline", "replaced by a newer connection");
        try {
          other.close(4000, "replaced");
        } catch {}
      }
    }
    const sessionId = randId("s_");
    const chosen = hello.play[0]!;
    const audio = { format: chosen.format, sample_rate: chosen.sample_rate, channels: chosen.channels ?? 1, chunk_bytes: Math.min(hello.max_chunk_bytes, 4096) };
    ws.serializeAttachment({ ...att, hello: true, session_id: sessionId } satisfies Attachment);
    await this.ctx.storage.put({ hello, last_seen: Date.now(), device_id: att.device_id });
    await this.registry().touch({ device_id: att.device_id, caps: hello.caps, ...(hello.fw ? { fw_version: hello.fw } : {}), ...(hello.hw ? { hw: hello.hw } : {}) });
    this.send(ws, rpcResult(req.id, { session_id: sessionId, server_time: Date.now(), heartbeat_s: HEARTBEAT_S, audio }));
  }

  private onResponse(ws: WebSocket, msg: RpcResponse): void {
    if (msg.id === null) return;
    const key = String(msg.id);
    const p = this.pending.get(key);
    if (!p || p.ws !== ws) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    if (msg.error) {
      const e = msg.error as RpcErrorObject;
      p.resolve({
        ok: false,
        error: {
          code: mapDeviceError(e.code),
          message: typeof e.message === "string" ? e.message.slice(0, 200) : "device error",
          data: { device_code: e.code, ...(isObject(e.data) ? e.data : {}) },
          ...(isObject(e.data) && typeof e.data.retry_after_ms === "number" ? { retry_after_ms: e.data.retry_after_ms } : {}),
        },
      });
    } else p.resolve({ ok: true, result: isObject(msg.result) ? msg.result : { value: msg.result ?? null } });
  }

  private onNotification(msg: RpcNotification): void {
    const p = msg.params ?? {};
    if (msg.method === "state.update") {
      void this.storeState(p);
    } else if (msg.method === "playback.state") {
      const id = p.stream_id;
      const st = p.state;
      if (typeof id === "number" && typeof st === "string") {
        const s = this.streams.get(id);
        if (s && (st === "started" || st === "ended" || st === "interrupted" || st === "error")) {
          s.playback = st;
          if (typeof p.message === "string") s.message = p.message.slice(0, 200);
          for (const w of s.wake) w();
        }
      }
      void this.storeState({ playback: { state: st, stream_id: id } });
    } else if (msg.method.startsWith("event.")) {
      // Only the name is kept (no payload: transcripts are untrusted/private). M3 adds a ring + get_events.
      void this.ctx.storage.put("last_event", { name: msg.method.slice(6, 64), ts: Date.now() });
    }
    // unknown notifications are ignored
  }

  private async storeState(p: Record<string, unknown>): Promise<void> {
    const prev = (await this.ctx.storage.get<Record<string, unknown>>("state")) ?? {};
    const next = { ...prev };
    for (const k of STATE_KEYS) if (p[k] !== undefined) next[k] = p[k];
    if (p.rssi !== undefined) next.wifi_rssi = p.rssi;
    if (JSON.stringify(next).length > MAX_STATE_BYTES) return;
    await this.ctx.storage.put({ state: next, state_ts: Date.now(), last_seen: Date.now() });
  }

  // ------------------------------------------------------------------ helpers

  private registry(): DurableObjectStub<DeviceRegistry> {
    return this.env.REGISTRY.getByName("registry");
  }

  private send(ws: WebSocket, msg: unknown): void {
    ws.send(JSON.stringify(msg));
  }

  /** The current authenticated (hello'd) socket, if any. */
  private live(): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.hello) return ws;
    }
    return undefined;
  }

  private failPending(ws: WebSocket, code: string, message: string): void {
    for (const [id, p] of this.pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ ok: false, error: { code, message } });
    }
  }

  private cmdTimeout(tool: string): number {
    return num(this.env.DEVICE_CMD_TIMEOUT_MS, tool === "speak" ? 5000 : 3000);
  }

  private nextSeq(): number {
    this.seq = Math.max(this.seq + 1, Date.now());
    return this.seq;
  }

  /** Send one JSON-RPC request to the device and wait for its response. Never retried here. */
  private request(ws: WebSocket, method: string, params: Record<string, unknown>, o: { timeoutMs: number; ttlMs: number; key?: string }): { id: string; done: Promise<RpcResult> } {
    const id = randId("c_");
    const meta: Record<string, unknown> = { ttl_ms: o.ttlMs, seq: this.nextSeq() };
    if (o.key) meta.idempotency_key = o.key;
    const done = new Promise<RpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "timeout", message: `device did not answer ${method} within ${o.timeoutMs} ms` } });
      }, o.timeoutMs);
      this.pending.set(id, { ws, timer, resolve });
      try {
        this.send(ws, rpcRequest(id, method, { ...params, _meta: meta }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "device_offline", message: "device socket is closed" } });
      }
    });
    return { id, done };
  }

  private async offline(deviceId: string): Promise<DeviceOutcome> {
    const last = await this.ctx.storage.get<number>("last_seen");
    return { ok: false, device_id: deviceId, error: { code: "device_offline", message: "device is not connected", retry_after_ms: 5000, ...(last ? { last_seen: last } : {}) } };
  }

  private rateLimited(): boolean {
    const now = Date.now();
    if (now - this.rate.start >= 1000) this.rate = { start: now, count: 0 };
    this.rate.count++;
    return this.rate.count > num(this.env.DEVICE_RATE_LIMIT_PER_SEC, 20);
  }

  private async deviceId(): Promise<string> {
    return (await this.ctx.storage.get<string>("device_id")) ?? "unknown";
  }

  /** Stop bridge-side audio work: abort the active stream and invalidate queued speaks. */
  private abortAudio(): void {
    this.epoch++;
    const a = this.activeStream;
    if (a) {
      a.aborted = true;
      for (const w of a.wake) w();
    }
  }

  // ------------------------------------------------------------------ RPC methods used by the MCP layer

  async summary(): Promise<{ device_id: string; online: boolean; last_seen: number | null; fw_version?: string; hw?: string; caps: string[] }> {
    const hello = await this.ctx.storage.get<HelloInfo>("hello");
    const last = (await this.ctx.storage.get<number>("last_seen")) ?? null;
    const online = !!this.live();
    return {
      device_id: await this.deviceId(),
      online,
      last_seen: online ? Date.now() : last,
      ...(hello?.fw ? { fw_version: hello.fw } : {}),
      ...(hello?.hw ? { hw: hello.hw } : {}),
      caps: hello?.caps ?? [],
    };
  }

  async status(fresh: boolean): Promise<DeviceOutcome> {
    const t0 = Date.now();
    const deviceId = await this.deviceId();
    const ws = this.live();
    if (fresh) {
      if (!ws) return this.offline(deviceId);
      let r: RpcResult | undefined;
      let id = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        // read-only: one retry on timeout is safe
        const req = this.request(ws, "device.get_status", {}, { timeoutMs: this.cmdTimeout("get_device_status"), ttlMs: 5000 });
        id = req.id;
        r = await req.done;
        if (r.ok || r.error.code !== "timeout") break;
      }
      if (!r || !r.ok) return { ok: false, device_id: deviceId, command_id: id, error: r?.ok === false ? r.error : { code: "timeout", message: "no answer" } };
      await this.storeState(r.result);
    }
    const hello = await this.ctx.storage.get<HelloInfo>("hello");
    const state = (await this.ctx.storage.get<Record<string, unknown>>("state")) ?? {};
    const stateTs = await this.ctx.storage.get<number>("state_ts");
    const last = await this.ctx.storage.get<number>("last_seen");
    const lastEvent = await this.ctx.storage.get<{ name: string; ts: number }>("last_event");
    const online = !!ws;
    return {
      ok: true,
      device_id: deviceId,
      command_id: randId("c_"),
      status: "done",
      latency_ms: Date.now() - t0,
      result: {
        online,
        last_seen: online ? Date.now() : (last ?? null),
        fw_version: hello?.fw ?? null,
        hw: hello?.hw ?? null,
        caps: hello?.caps ?? [],
        expressions: hello?.expressions ?? [],
        limits: hello?.limits ?? null,
        ...state,
        state_age_ms: stateTs ? Date.now() - stateTs : null,
        ...(lastEvent ? { last_event: lastEvent } : {}),
      },
    };
  }

  async call(call: DeviceCall): Promise<DeviceOutcome> {
    const deviceId = await this.deviceId();
    const emergency = call.tool === "emergency_stop";
    const key = call.request_id && !emergency ? `${call.tool}:${call.request_id}` : undefined;
    if (!key) return this.runCall(deviceId, call, emergency);
    return this.dedup(key, () => this.runCall(deviceId, call, false));
  }

  async speak(call: SpeakCall): Promise<DeviceOutcome> {
    const deviceId = await this.deviceId();
    const key = call.request_id ? `speak:${call.request_id}` : undefined;
    if (!key) return this.runSpeak(deviceId, call);
    return this.dedup(key, () => this.runSpeak(deviceId, call));
  }

  /** Same (tool, request_id) within 60 s -> first successful result; concurrent duplicates share one execution. */
  private async dedup(key: string, run: () => Promise<DeviceOutcome>): Promise<DeviceOutcome> {
    const running = this.inflight.get(key);
    if (running) return markDedup(await running);
    const cached = await this.ctx.storage.get<{ ts: number; outcome: DeviceOutcome }>(`dd:${key}`);
    if (cached && Date.now() - cached.ts < DEDUP_WINDOW_MS) return markDedup(cached.outcome);
    const p = run();
    this.inflight.set(key, p);
    try {
      const outcome = await p;
      if (outcome.ok) {
        await this.ctx.storage.put(`dd:${key}`, { ts: Date.now(), outcome });
        await this.pruneDedup();
      }
      return outcome;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async pruneDedup(): Promise<void> {
    const all = await this.ctx.storage.list<{ ts: number }>({ prefix: "dd:", limit: 500 });
    const stale = [...all].filter(([, v]) => Date.now() - v.ts >= DEDUP_WINDOW_MS).map(([k]) => k);
    if (stale.length) await this.ctx.storage.delete(stale);
  }

  private async runCall(deviceId: string, call: DeviceCall, emergency: boolean): Promise<DeviceOutcome> {
    const t0 = Date.now();
    const ws = this.live();
    if (!ws) {
      if (emergency) this.abortAudio();
      return this.offline(deviceId);
    }
    // emergency_stop bypasses the rate limit and any bridge-side queue, and goes out first.
    if (!emergency && this.rateLimited()) {
      return { ok: false, device_id: deviceId, error: { code: "rate_limited", message: "too many commands for this device", retry_after_ms: 1000 } };
    }
    const timeoutMs = emergency ? Math.min(this.cmdTimeout(call.tool), 2000) : (call.timeout_ms ?? this.cmdTimeout(call.tool));
    const req = this.request(ws, call.method, call.params, {
      timeoutMs,
      ttlMs: emergency ? 2000 : (call.ttl_ms ?? 5000),
      ...(call.request_id ? { key: call.request_id } : {}),
    });
    if (emergency) this.abortAudio(); // after the frame is on the wire
    const r = await req.done;
    if (call.tool === "stop_audio" && r.ok) this.abortAudio();
    if (!r.ok) return { ok: false, device_id: deviceId, command_id: req.id, error: r.error };
    return {
      ok: true,
      device_id: deviceId,
      command_id: req.id,
      status: call.wait === "done" ? "done" : "accepted",
      result: r.result,
      latency_ms: Date.now() - t0,
    };
  }

  // ------------------------------------------------------------------ speak: TTS -> device.speak -> audio.begin / frames / audio.end

  private async runSpeak(deviceId: string, call: SpeakCall): Promise<DeviceOutcome> {
    const t0 = Date.now();
    if (!this.live()) return this.offline(deviceId);
    if (this.rateLimited()) return { ok: false, device_id: deviceId, error: { code: "rate_limited", message: "too many commands for this device", retry_after_ms: 1000 } };
    if (this.speakQueued >= MAX_QUEUED_SPEAKS) return { ok: false, device_id: deviceId, error: { code: "busy", message: "speak queue is full", retry_after_ms: 2000 } };
    if (call.interrupt) this.abortAudio();
    const epoch = this.epoch;
    const interrupted = (): DeviceOutcome => ({ ok: false, device_id: deviceId, error: { code: "interrupted", message: "speech was interrupted (stop_audio / emergency_stop / interrupt)" } });
    const prev = this.speakTail;
    let release!: () => void;
    this.speakTail = new Promise<void>((r) => (release = r));
    this.speakQueued++;
    const ctx: StreamCtx = { aborted: false, playback: "none", wake: new Set() };
    let streamId = 0;
    try {
      await prev;
      if (this.epoch !== epoch) return interrupted();
      this.activeStream = ctx;

      const hello = await this.ctx.storage.get<HelloInfo>("hello");
      const tts = getTtsProvider(this.env);
      if (!tts || !hello) return { ok: false, device_id: deviceId, error: { code: "tts_failed", message: "TTS provider is not configured" } };
      let synth;
      try {
        synth = await tts.synthesize({ text: call.text, ...(call.voice ? { voice: call.voice } : {}), ...(call.lang ? { lang: call.lang } : {}), accept: hello.play });
      } catch (e) {
        const unsupported = e instanceof TtsError && e.code === "unsupported";
        console.log("tts error:", e instanceof Error ? e.message : String(e));
        return { ok: false, device_id: deviceId, error: { code: unsupported ? "unsupported" : "tts_failed", message: unsupported ? "device cannot decode any supported audio format" : "TTS synthesis failed" } };
      }
      if (synth.audio.byteLength === 0) return { ok: false, device_id: deviceId, error: { code: "tts_failed", message: "TTS returned no audio" } };
      if (ctx.aborted) return interrupted();
      const ws = this.live();
      if (!ws) return this.offline(deviceId);

      streamId = await this.nextStreamId();
      this.streams.set(streamId, ctx);
      const req = this.request(
        ws,
        "device.speak",
        {
          stream_id: streamId,
          text: call.text,
          interrupt: call.interrupt,
          ...(call.expression ? { expression: call.expression } : {}),
          ...(call.volume !== undefined ? { volume: call.volume } : {}),
        },
        { timeoutMs: this.cmdTimeout("speak"), ttlMs: 10_000, ...(call.request_id ? { key: call.request_id } : {}) },
      );
      const ack = await req.done;
      if (!ack.ok) return { ok: false, device_id: deviceId, command_id: req.id, error: ack.error };
      if (ctx.aborted) return interrupted();

      const chunkBytes = Math.min(hello.max_chunk_bytes, 4096);
      const total = synth.audio.byteLength;
      const nChunks = Math.ceil(total / chunkBytes);
      this.send(
        ws,
        rpcNotification("audio.begin", {
          stream_id: streamId,
          format: synth.format,
          ...(synth.sampleRate ? { sample_rate: synth.sampleRate } : {}),
          channels: synth.channels,
          chunk_bytes: chunkBytes,
          total_bytes: total,
          total_chunks: nChunks,
        }),
      );
      const bytesPerMs = synth.format === "pcm_s16le" ? ((synth.sampleRate ?? 16000) * synth.channels * 2) / 1000 : synth.bitrateKbps ? synth.bitrateKbps / 8 : 0;
      const burst = bytesPerMs * hello.buffer_ms;
      const fixedDelay = num(this.env.AUDIO_CHUNK_DELAY_MS, 0);
      let sent = 0;
      let i = 0;
      for (; i < nChunks; i++) {
        if (ctx.aborted || this.live() !== ws) break;
        const payload = synth.audio.subarray(i * chunkBytes, Math.min(total, (i + 1) * chunkBytes));
        ws.send(encodeFrame(FRAME_DOWNLINK_AUDIO, streamId, i, payload, i === nChunks - 1));
        sent += payload.byteLength;
        // Initial burst of ~buffer_ms, then ~1.2x realtime so the device buffer is never flooded.
        const pace = bytesPerMs > 0 && sent > burst ? payload.byteLength / bytesPerMs / 1.2 : 0;
        if (fixedDelay + pace > 0 && i < nChunks - 1) await sleep(fixedDelay + pace);
      }
      const complete = i === nChunks && !ctx.aborted;
      if (this.live() === ws) {
        this.send(ws, rpcNotification("audio.end", { stream_id: streamId, total_chunks: i, total_bytes: sent, reason: complete ? "complete" : "aborted" }));
      }
      if (!complete) return this.live() === ws ? interrupted() : this.offline(deviceId);

      const meta = {
        stream_id: streamId,
        queued_position: typeof ack.result.queue_position === "number" ? ack.result.queue_position : 0,
        duration_ms: bytesPerMs > 0 ? Math.round(total / bytesPerMs) : null,
        tts: { provider: synth.provider, voice: synth.voice, cached: synth.cached },
        chunks: nChunks,
        bytes: total,
        format: synth.format,
      };
      if (call.wait === "queued") return { ok: true, device_id: deviceId, command_id: req.id, status: "accepted", latency_ms: Date.now() - t0, result: { ...meta, playback: "queued" } };

      const want = call.wait === "done" ? ["ended", "interrupted", "error"] : ["started", "ended", "interrupted", "error"];
      const outcome = await this.waitPlayback(ctx, want, call.timeout_ms);
      if (outcome === "timeout") return { ok: false, device_id: deviceId, command_id: req.id, error: { code: "timeout", message: `no playback.state ${call.wait} within ${call.timeout_ms} ms`, data: { stream_id: streamId } } };
      if (ctx.playback === "error") return { ok: false, device_id: deviceId, command_id: req.id, error: { code: "stream_error", message: ctx.message ?? "device reported a stream error", data: { stream_id: streamId } } };
      const pb = ctx.playback === "ended" ? "done" : ctx.playback;
      return { ok: true, device_id: deviceId, command_id: req.id, status: pb === "done" ? "done" : "accepted", latency_ms: Date.now() - t0, result: { ...meta, playback: pb } };
    } finally {
      this.speakQueued--;
      if (this.activeStream === ctx) this.activeStream = null;
      if (streamId && (ctx.playback === "ended" || ctx.playback === "interrupted" || ctx.playback === "error")) this.streams.delete(streamId);
      else if (streamId) {
        // keep for late playback.state notifications, but don't leak
        setTimeout(() => this.streams.delete(streamId), 5 * 60_000);
      }
      release();
    }
  }

  private waitPlayback(ctx: StreamCtx, want: string[], timeoutMs: number): Promise<"ok" | "timeout"> {
    return new Promise((resolve) => {
      const check = () => {
        if (want.includes(ctx.playback)) return done("ok");
        if (ctx.aborted) {
          ctx.playback = ctx.playback === "none" ? "interrupted" : ctx.playback;
          return done("ok");
        }
      };
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      const done = (r: "ok" | "timeout") => {
        clearTimeout(timer);
        ctx.wake.delete(check);
        resolve(r);
      };
      ctx.wake.add(check);
      check();
    });
  }

  private async nextStreamId(): Promise<number> {
    const prev = (await this.ctx.storage.get<number>("stream_counter")) ?? 0;
    const n = (prev % 65535) + 1;
    await this.ctx.storage.put("stream_counter", n);
    return n;
  }
}

function markDedup(o: DeviceOutcome): DeviceOutcome {
  return o.ok ? { ...o, deduplicated: true } : o;
}
