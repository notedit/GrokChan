import { AsrError, type AsrProvider, type AsrSession } from "../asr/types";
import { RPC, UPLINK, type DecodedFrame, type HelloInfo, type TurnState, type VoiceReason } from "../device/protocol";
import { openSpeechStream } from "../tts/stream";
import type { TtsProvider } from "../tts/types";
import { Pacer } from "./pacer";
import { parseUplinkBegin, uplinkLimits, UplinkStream, type UplinkLimits } from "./uplink";

/**
 * Voice turn engine (one per device, lives inside the DeviceHub DO).
 *
 *   idle ──speech_start / audio.begin(uplink)──▶ listening
 *   listening ──audio.end | speech_end──▶ transcribing ──final text──▶ thinking
 *   thinking ──agent reply (turn_id matches)──▶ speaking ──playback ended──▶ idle
 *   ANY state ──new speech_start/audio.begin(uplink) | stop_audio | emergency_stop |
 *               MCP speak interrupt | disconnect | error | timeout──▶ idle
 *
 * Interruption model: every turn owns an AbortController and a random
 * turn_id. finish() aborts it (ASR, TTS and pacing stop), sends
 * `audio.end reason=aborted` for a half-sent reply and clears this.turn.
 * Late results (ASR, TTS, agent reply) check `this.turn === turn` /
 * turn_id and are dropped when stale. Pure logic over VoiceHost, so it is
 * unit-testable with a fake host; see test/voice.unit.test.ts.
 */

export interface VoiceConfig {
  maxUtteranceMs: number;
  /** extra wall-clock slack on top of maxUtteranceMs before a never-ending uplink is cut */
  uplinkGraceMs: number;
  uplinkIdleMs: number;
  beginTimeoutMs: number;
  asrTimeoutMs: number;
  agentTimeoutMs: number;
  replyMaxChars: number;
  turnsPerMin: number;
  /** test knob: pause between downlink frames */
  chunkDelayMs: number;
  /** wait this long past the expected end of audio for playback.state ended */
  playbackSlackMs: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  maxUtteranceMs: UPLINK.DEFAULT_MAX_MS,
  uplinkGraceMs: 2000,
  uplinkIdleMs: 3000,
  beginTimeoutMs: 3000,
  asrTimeoutMs: 10_000,
  agentTimeoutMs: 60_000,
  replyMaxChars: 1000,
  turnsPerMin: 20,
  chunkDelayMs: 0,
  playbackSlackMs: 3000,
};

export type DeliverResult = { ok: true } | { ok: false; reason: VoiceReason; message?: string };

export interface VoiceHost {
  readonly deviceId: string;
  hello(): HelloInfo | undefined;
  /** JSON-RPC notification to the device (dropped silently when offline). */
  notify(method: string, params: Record<string, unknown>): void;
  sendFrame(streamId: number, seq: number, payload: Uint8Array, last: boolean): void;
  /** `device.speak` request (display text, expression, interrupt). Resolves with the device's answer. */
  deviceSpeak(streamId: number, text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Best-effort device.stop_audio when a speak was accepted but audio.begin was never sent. */
  stopDeviceAudio(streamId: number): void;
  nextStreamId(): Promise<number>;
  /** Abort any non-voice (MCP speak) audio before the reply starts. */
  preemptAudio(): void;
  /** Forward the final transcript to the agent; the reply comes back via onAgentReply(). */
  deliver(t: { turnId: string; text: string; lang?: string }): Promise<DeliverResult>;
  now(): number;
}

export interface VoiceDeps {
  asr(): AsrProvider | undefined;
  tts(): TtsProvider | undefined;
}

interface UplinkState {
  stream: UplinkStream;
  asr: AsrSession;
  closed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}
interface SpeakState {
  streamId: number;
  acked: boolean;
  begun: boolean;
  ended: boolean;
  seq: number;
  bytes: number;
  pacer?: Pacer;
  playback: "none" | "started" | "ended" | "interrupted" | "error";
  message?: string;
  wake?: () => void;
}
interface Turn {
  id: string;
  gen: number;
  state: TurnState;
  ac: AbortController;
  startedAt: number;
  lang?: string;
  uplink?: UplinkState;
  speak?: SpeakState;
  beginTimer?: ReturnType<typeof setTimeout>;
  agentTimer?: ReturnType<typeof setTimeout>;
  partialSeq: number;
  lastPartial?: string;
}

const ALLOWED: Record<TurnState, TurnState[]> = {
  idle: ["listening"],
  listening: ["transcribing"],
  transcribing: ["thinking"],
  thinking: ["speaking"],
  speaking: [],
};
const TIMEOUT = Symbol("timeout");
const randTurn = () => "t_" + [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function voiceConfigFromEnv(env: Record<string, string | undefined>): VoiceConfig {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d;
  };
  const d = DEFAULT_VOICE_CONFIG;
  return {
    maxUtteranceMs: Math.max(1, n("UPLINK_MAX_MS", d.maxUtteranceMs)),
    uplinkGraceMs: n("UPLINK_GRACE_MS", d.uplinkGraceMs),
    uplinkIdleMs: n("UPLINK_IDLE_TIMEOUT_MS", d.uplinkIdleMs),
    beginTimeoutMs: n("UPLINK_BEGIN_TIMEOUT_MS", d.beginTimeoutMs),
    asrTimeoutMs: n("ASR_TIMEOUT_MS", d.asrTimeoutMs),
    agentTimeoutMs: n("AGENT_REPLY_TIMEOUT_MS", d.agentTimeoutMs),
    replyMaxChars: Math.max(1, n("VOICE_REPLY_MAX_CHARS", d.replyMaxChars)),
    turnsPerMin: Math.max(1, n("VOICE_TURNS_PER_MIN", d.turnsPerMin)),
    chunkDelayMs: n("AUDIO_CHUNK_DELAY_MS", d.chunkDelayMs),
    playbackSlackMs: n("PLAYBACK_SLACK_MS", d.playbackSlackMs),
  };
}

export class VoiceEngine {
  private turn: Turn | null = null;
  private gen = 0;
  private starts: number[] = [];
  readonly limits: UplinkLimits;

  constructor(
    private readonly host: VoiceHost,
    private readonly deps: VoiceDeps,
    private readonly cfg: VoiceConfig = DEFAULT_VOICE_CONFIG,
  ) {
    this.limits = uplinkLimits(cfg.maxUtteranceMs);
  }

  // ------------------------------------------------------------ public surface

  get config(): VoiceConfig {
    return this.cfg;
  }
  /** True while a turn is anywhere but idle. */
  get active(): boolean {
    return this.turn !== null;
  }
  snapshot(): { state: TurnState; turn_id: string | null; gen: number } {
    return { state: this.turn?.state ?? "idle", turn_id: this.turn?.id ?? null, gen: this.gen };
  }
  get available(): boolean {
    return this.deps.asr() !== undefined;
  }

  /** Device VAD / button: the user started speaking. Barge-in when a turn is running. */
  onSpeechStart(p: Record<string, unknown> = {}): void {
    if (!this.requireAsr()) return;
    if (this.turn?.state === "listening") return; // duplicate trigger inside the same utterance
    const t = this.startTurn(typeof p.lang === "string" ? p.lang.slice(0, 16) : undefined);
    if (t) t.beginTimer = setTimeout(() => this.finish(t, "no_audio"), this.cfg.beginTimeoutMs);
  }

  /** Device VAD / button: the user stopped speaking. Finalizes an open uplink. */
  onSpeechEnd(): void {
    const t = this.turn;
    if (!t || t.state !== "listening") return;
    if (t.uplink) this.finalize(t);
    else this.finish(t, "no_audio");
  }

  /** Uplink `audio.begin`. */
  onAudioBegin(p: Record<string, unknown>): void {
    if (!this.requireAsr(typeof p.stream_id === "number" ? p.stream_id : undefined)) return;
    const parsed = parseUplinkBegin(p, this.limits);
    if (!parsed.ok) {
      this.streamError(parsed.streamId, parsed.reason, parsed.message);
      const t = this.turn;
      if (t?.state === "listening" && !t.uplink) this.finish(t, parsed.reason);
      return;
    }
    let t = this.turn;
    if (!(t && t.state === "listening" && !t.uplink)) t = this.startTurn(parsed.begin.lang);
    if (!t) {
      this.streamError(parsed.begin.streamId, "rate_limited", "too many voice turns");
      return;
    }
    if (t.beginTimer) clearTimeout(t.beginTimer);
    t.beginTimer = undefined;
    const provider = this.deps.asr()!;
    let asr: AsrSession;
    try {
      asr = provider.start({
        format: UPLINK.FORMAT,
        sampleRate: UPLINK.SAMPLE_RATE,
        channels: UPLINK.CHANNELS,
        ...(parsed.begin.lang ?? t.lang ? { lang: (parsed.begin.lang ?? t.lang)! } : {}),
        signal: t.ac.signal,
        onPartial: (text) => this.onPartial(t!, text),
      });
    } catch (e) {
      this.streamError(parsed.begin.streamId, "asr_unavailable", e instanceof Error ? e.message : "asr start failed");
      this.finish(t, "asr_unavailable");
      return;
    }
    const up: UplinkState = { stream: new UplinkStream(parsed.begin.streamId, this.limits), asr, closed: false };
    t.uplink = up;
    this.armIdle(t);
    up.deadlineTimer = setTimeout(() => this.failUplink(t!, "too_long", `utterance still open after ${this.cfg.maxUtteranceMs} ms`), this.cfg.maxUtteranceMs + this.cfg.uplinkGraceMs);
  }

  /** Uplink binary frame (type 0x02). Frames for unknown / closed streams are dropped silently. */
  onFrame(f: DecodedFrame): void {
    const t = this.turn;
    const up = t?.uplink;
    if (!t || !up || up.closed || t.state !== "listening" || up.stream.streamId !== f.streamId) return;
    const r = up.stream.accept(f);
    if (!r.ok) {
      this.failUplink(t, r.reason, r.message);
      return;
    }
    up.asr.push(r.payload);
    this.armIdle(t);
  }

  /** Uplink `audio.end`. */
  onAudioEnd(p: Record<string, unknown>): void {
    const t = this.turn;
    const up = t?.uplink;
    if (!t || !up || up.closed || t.state !== "listening") return;
    if (p.stream_id !== up.stream.streamId) return;
    if (p.reason === "aborted") {
      up.closed = true;
      this.finish(t, "uplink_aborted");
      return;
    }
    if ((typeof p.total_chunks === "number" && p.total_chunks !== up.stream.chunks) || (typeof p.total_bytes === "number" && p.total_bytes !== up.stream.bytes)) {
      this.failUplink(t, "count_mismatch", `audio.end says ${String(p.total_chunks)} chunks / ${String(p.total_bytes)} B, received ${up.stream.chunks} / ${up.stream.bytes}`);
      return;
    }
    this.finalize(t);
  }

  /** Device `audio.credit` / playback buffer report for the active reply stream. */
  onCredit(p: Record<string, unknown>): void {
    const s = this.turn?.speak;
    if (!s || !s.pacer || p.stream_id !== s.streamId) return;
    const buf = typeof p.buffer_ms === "number" ? p.buffer_ms : typeof p.buffered_ms === "number" ? p.buffered_ms : undefined;
    if (buf !== undefined) {
      s.pacer.onCredit(buf, this.host.now());
      s.wake?.();
    }
  }

  /** Device `playback.state` for the reply stream. */
  onPlayback(streamId: number, state: string, message?: string): void {
    const t = this.turn;
    const s = t?.speak;
    if (!t || !s || s.streamId !== streamId) return;
    if (state === "started" || state === "ended" || state === "interrupted" || state === "error") {
      s.playback = state;
      if (message) s.message = message.slice(0, 200);
      if (state === "interrupted" || state === "error") {
        // the device stopped on its own (local stop button, fault): the turn is over
        this.finish(t, state === "interrupted" ? "device_interrupted" : "device_error");
        return;
      }
      s.wake?.();
    }
  }

  /** stop_audio / emergency_stop / MCP interrupt / disconnect: cut whatever is going on. */
  interrupt(reason: VoiceReason = "stop"): void {
    if (this.turn) this.finish(this.turn, reason);
  }

  /**
   * The agent's reply arrived (possibly via HTTP from another request). Accepted only for the
   * current turn while it is `thinking`; anything else is stale and must be dropped.
   */
  onAgentReply(turnId: string, text: string): "accepted" | "stale" {
    const t = this.turn;
    if (!t || t.id !== turnId || t.state !== "thinking") return "stale";
    if (t.agentTimer) clearTimeout(t.agentTimer);
    t.agentTimer = undefined;
    let clipped = text.replace(/\s+/g, " ").trim();
    if ([...clipped].length > this.cfg.replyMaxChars) clipped = [...clipped].slice(0, this.cfg.replyMaxChars).join("");
    this.host.notify("turn.reply", { turn_id: t.id, text: clipped });
    if (!clipped) {
      this.finish(t, "done");
      return "accepted";
    }
    void this.speak(t, clipped).catch((e) => {
      console.log("voice speak error:", e instanceof Error ? e.message : String(e));
      this.finish(t, "tts_failed");
    });
    return "accepted";
  }

  // ------------------------------------------------------------ turn lifecycle

  private requireAsr(streamId?: number): boolean {
    if (this.deps.asr()) return true;
    if (streamId !== undefined) this.streamError(streamId, "asr_unavailable", "no ASR provider configured on the bridge");
    this.host.notify("turn.state", { turn_id: null, state: "idle", prev: "idle", reason: "asr_unavailable" });
    return false;
  }

  private startTurn(lang?: string): Turn | null {
    const now = this.host.now();
    this.starts = this.starts.filter((x) => now - x < 60_000);
    if (this.turn) this.finish(this.turn, "barge_in"); // interruption always wins, even if the new turn is then refused
    this.host.preemptAudio();
    if (this.starts.length >= this.cfg.turnsPerMin) {
      this.host.notify("turn.state", { turn_id: null, state: "idle", prev: "idle", reason: "rate_limited" });
      return null;
    }
    this.starts.push(now);
    const t: Turn = { id: randTurn(), gen: ++this.gen, state: "idle", ac: new AbortController(), startedAt: now, partialSeq: 0, ...(lang ? { lang } : {}) };
    this.turn = t;
    this.setState(t, "listening");
    return t;
  }

  private setState(t: Turn, next: TurnState, reason?: VoiceReason): void {
    if (!ALLOWED[t.state].includes(next)) throw new Error(`illegal turn transition ${t.state} -> ${next}`);
    const prev = t.state;
    t.state = next;
    this.host.notify("turn.state", { turn_id: t.id, state: next, prev, gen: t.gen, ...(reason ? { reason } : {}) });
  }

  /** End the turn (back to idle) and tear down everything it owns. Idempotent; stale callers are no-ops. */
  private finish(t: Turn, reason: VoiceReason): void {
    if (this.turn !== t) return;
    this.turn = null;
    const prev = t.state;
    t.state = "idle";
    t.ac.abort();
    if (t.beginTimer) clearTimeout(t.beginTimer);
    if (t.agentTimer) clearTimeout(t.agentTimer);
    const up = t.uplink;
    if (up) {
      up.closed = true;
      if (up.idleTimer) clearTimeout(up.idleTimer);
      if (up.deadlineTimer) clearTimeout(up.deadlineTimer);
      try {
        up.asr.abort();
      } catch {}
    }
    const s = t.speak;
    if (s) {
      if (s.begun && !s.ended) {
        s.ended = true;
        this.host.notify("audio.end", { stream_id: s.streamId, total_chunks: s.seq, total_bytes: s.bytes, reason: "aborted" });
      } else if (s.acked && !s.begun) {
        this.host.stopDeviceAudio(s.streamId);
      }
      s.wake?.();
    }
    this.host.notify("turn.state", { turn_id: t.id, state: "idle", prev, gen: t.gen, reason });
  }

  private streamError(streamId: number, reason: VoiceReason, message: string): void {
    this.host.notify("stream.error", { stream_id: streamId, direction: "up", code: RPC.STREAM_ERROR, reason, message: message.slice(0, 200) });
  }

  private failUplink(t: Turn, reason: VoiceReason, message: string): void {
    if (this.turn !== t) return;
    if (t.uplink) this.streamError(t.uplink.stream.streamId, reason, message);
    this.finish(t, reason);
  }

  private armIdle(t: Turn): void {
    const up = t.uplink;
    if (!up) return;
    if (up.idleTimer) clearTimeout(up.idleTimer);
    up.idleTimer = setTimeout(() => this.failUplink(t, "timeout", `no uplink data for ${this.cfg.uplinkIdleMs} ms`), this.cfg.uplinkIdleMs);
  }

  private onPartial(t: Turn, text: string): void {
    if (this.turn !== t || (t.state !== "listening" && t.state !== "transcribing")) return;
    if (!text || text === t.lastPartial) return;
    t.lastPartial = text;
    this.host.notify("asr.transcript", { turn_id: t.id, final: false, text: text.slice(0, 500), seq: ++t.partialSeq });
  }

  // ------------------------------------------------------------ listening -> transcribing -> thinking

  private finalize(t: Turn): void {
    const up = t.uplink;
    if (!up || up.closed || this.turn !== t) return;
    up.closed = true;
    if (up.idleTimer) clearTimeout(up.idleTimer);
    if (up.deadlineTimer) clearTimeout(up.deadlineTimer);
    if (up.stream.bytes === 0) return this.finish(t, "empty_audio");
    this.setState(t, "transcribing");
    void this.transcribe(t, up);
  }

  private async transcribe(t: Turn, up: UplinkState): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res;
    try {
      const timeout = new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), this.cfg.asrTimeoutMs)));
      const out = await Promise.race([up.asr.finish(), timeout]);
      if (out === TIMEOUT) {
        up.asr.abort();
        if (this.turn === t) this.finish(t, "asr_timeout");
        return;
      }
      res = out;
    } catch (e) {
      if (this.turn !== t) return; // interrupted meanwhile: the rejection is expected
      console.log("asr error:", e instanceof AsrError || e instanceof Error ? e.message : String(e));
      this.finish(t, "asr_failed");
      return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.turn !== t || t.ac.signal.aborted) return; // stale result
    const text = res.text.trim();
    this.host.notify("asr.transcript", { turn_id: t.id, final: true, text: text.slice(0, 1000), seq: ++t.partialSeq, provider: res.provider, ...(res.lang ? { lang: res.lang } : {}) });
    if (!text) return this.finish(t, "empty_transcript");
    this.setState(t, "thinking");
    t.agentTimer = setTimeout(() => this.finish(t, "agent_timeout"), this.cfg.agentTimeoutMs);
    let d: DeliverResult;
    try {
      d = await this.host.deliver({ turnId: t.id, text, ...(res.lang ?? t.lang ? { lang: (res.lang ?? t.lang)! } : {}) });
    } catch (e) {
      console.log("deliver error:", e instanceof Error ? e.message : String(e));
      d = { ok: false, reason: "agent_unavailable" };
    }
    if (this.turn !== t || t.state !== "thinking") return;
    if (!d.ok) this.finish(t, d.reason);
  }

  // ------------------------------------------------------------ thinking -> speaking -> idle

  private async speak(t: Turn, text: string): Promise<void> {
    const hello = this.host.hello();
    const tts = this.deps.tts();
    this.setState(t, "speaking");
    if (!tts || !hello) return this.finish(t, "tts_unavailable");
    this.host.preemptAudio();
    const signal = t.ac.signal;
    const streamId = await this.host.nextStreamId();
    if (this.turn !== t) return;
    const s: SpeakState = { streamId, acked: false, begun: false, ended: false, seq: 0, bytes: 0, playback: "none" };
    t.speak = s;

    const accept = hello.play.filter((p) => p.format === "pcm_s16le");
    // first-sentence synthesis and the device.speak handshake run in parallel
    const speechP = openSpeechStream(tts, { text, ...(t.lang ? { lang: t.lang } : {}), accept }, { signal }).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const ack = await this.host.deviceSpeak(streamId, text);
    const sp = await speechP;
    if (this.turn !== t) {
      if (sp.ok) void sp.v.chunks.return();
      return;
    }
    if (!ack.ok) {
      if (sp.ok) void sp.v.chunks.return();
      return this.finish(t, "device_rejected");
    }
    s.acked = true;
    if (!sp.ok) {
      console.log("tts error:", sp.e instanceof Error ? sp.e.message : String(sp.e));
      return this.finish(t, "tts_failed");
    }
    const speech = sp.v;
    const bytesPerFrame = speech.channels * 2;
    const bytesPerMs = (speech.sampleRate * bytesPerFrame) / 1000;
    const chunkBytes = Math.max(bytesPerFrame, Math.floor(Math.min(hello.max_chunk_bytes, 4096) / bytesPerFrame) * bytesPerFrame);
    const pacer = new Pacer(bytesPerMs, hello.buffer_ms);
    s.pacer = pacer;
    this.host.notify("audio.begin", { stream_id: streamId, format: speech.format, sample_rate: speech.sampleRate, channels: speech.channels, chunk_bytes: chunkBytes, turn_id: t.id });
    s.begun = true;

    let pending = new Uint8Array(0);
    let lastSentence = -1;
    const sendFrame = async (payload: Uint8Array) => {
      if (s.seq > 0 && this.cfg.chunkDelayMs > 0) await this.sleep(this.cfg.chunkDelayMs, t, s);
      // re-evaluated after every wake-up: an audio.credit may shorten (or lengthen) the wait
      for (let w = pacer.delayMs(this.host.now()); w > 0 && this.turn === t && !s.ended; w = pacer.delayMs(this.host.now())) await this.sleep(w, t, s);
      if (this.turn !== t || s.ended) return false;
      this.host.sendFrame(streamId, s.seq++, payload, false);
      s.bytes += payload.byteLength;
      pacer.sent(payload.byteLength, this.host.now());
      return true;
    };
    const drain = async (all: boolean) => {
      while (pending.byteLength >= chunkBytes || (all && pending.byteLength >= bytesPerFrame)) {
        const n = Math.min(chunkBytes, Math.floor(pending.byteLength / bytesPerFrame) * bytesPerFrame);
        if (!(await sendFrame(pending.slice(0, n)))) return false;
        pending = pending.slice(n);
      }
      return true;
    };
    try {
      for await (const c of speech.chunks) {
        if (this.turn !== t || s.ended) return;
        if (c.sentence !== lastSentence && pending.byteLength > 0) {
          if (!(await drain(true))) return; // sentence boundary: do not hold audio back waiting for more
        }
        lastSentence = c.sentence;
        const merged = new Uint8Array(pending.byteLength + c.audio.byteLength);
        merged.set(pending);
        merged.set(c.audio, pending.byteLength);
        pending = merged;
        if (!(await drain(false))) return;
      }
    } catch (e) {
      if (this.turn !== t) return;
      // Mid-stream TTS failure: abort immediately (audio.end aborted + idle:tts_failed). Do not
      // play out a partial reply as if it completed — the device must stop and the turn ends.
      console.log("tts stream error:", e instanceof Error ? e.message : String(e));
      return this.finish(t, "tts_failed");
    }
    if (!(await drain(true))) return;
    if (this.turn !== t || s.ended) return;
    if (s.bytes === 0) return this.finish(t, "tts_failed");
    s.ended = true;
    this.host.notify("audio.end", { stream_id: streamId, total_chunks: s.seq, total_bytes: s.bytes, reason: "complete" });

    // wait for the device to finish playing (playback.state ended) or give up
    const total = pacer.audioMs;
    const deadline = this.host.now() + total + hello.buffer_ms + this.cfg.playbackSlackMs;
    while (this.turn === t && s.playback !== "ended") {
      const left = deadline - this.host.now();
      if (left <= 0) return this.finish(t, "playback_timeout");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        function done() {
          clearTimeout(timer);
          s.wake = undefined;
          resolve();
        }
        s.wake = done;
        t.ac.signal.addEventListener("abort", done, { once: true });
      });
    }
    if (this.turn === t) this.finish(t, "done");
  }

  /** Abortable sleep that also wakes early on `audio.credit` so pacing re-evaluates. */
  private sleep(ms: number, t: Turn, s: SpeakState): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        s.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      s.wake = done;
      t.ac.signal.addEventListener("abort", done, { once: true });
    });
  }
}
