import { UPLINK } from "../device/protocol";
import type { DecodedFrame } from "../device/protocol";
import type { VoiceReason } from "../device/protocol";

export interface UplinkLimits {
  maxMs: number;
  maxBytes: number;
}

export function uplinkLimits(maxMs: number): UplinkLimits {
  const ms = Math.max(1, maxMs);
  const bytes = Math.floor((UPLINK.SAMPLE_RATE * UPLINK.CHANNELS * 2 * ms) / 1000);
  return { maxMs: ms, maxBytes: Math.min(bytes, UPLINK.HARD_MAX_BYTES) };
}

export interface UplinkBegin {
  streamId: number;
  lang?: string;
}
export type UplinkBeginResult = { ok: true; begin: UplinkBegin } | { ok: false; streamId: number; reason: VoiceReason; message: string };

/** Validate an uplink audio.begin. Only pcm_s16le 16 kHz mono is accepted in S1 (opus is a reserved type). */
export function parseUplinkBegin(p: Record<string, unknown>, limits: UplinkLimits): UplinkBeginResult {
  const streamId = typeof p.stream_id === "number" && Number.isInteger(p.stream_id) && p.stream_id >= 0 && p.stream_id <= 0xffff ? p.stream_id : -1;
  if (streamId < 0) return { ok: false, streamId: 0, reason: "bad_frame", message: "stream_id must be a u16" };
  if (p.format !== UPLINK.FORMAT) return { ok: false, streamId, reason: "unsupported_format", message: `uplink format must be ${UPLINK.FORMAT} (opus reserved for S2)` };
  const rate = p.sample_rate === undefined ? UPLINK.SAMPLE_RATE : p.sample_rate;
  const ch = p.channels === undefined ? UPLINK.CHANNELS : p.channels;
  if (rate !== UPLINK.SAMPLE_RATE || ch !== UPLINK.CHANNELS) return { ok: false, streamId, reason: "unsupported_format", message: "uplink must be 16000 Hz mono" };
  if (typeof p.total_bytes === "number" && p.total_bytes > limits.maxBytes) {
    return { ok: false, streamId, reason: "too_large", message: `declared ${p.total_bytes} B exceeds ${limits.maxBytes} B` };
  }
  return { ok: true, begin: { streamId, ...(typeof p.lang === "string" ? { lang: p.lang.slice(0, 16) } : {}) } };
}

export type UplinkAccept = { ok: true; payload: Uint8Array } | { ok: false; reason: VoiceReason; message: string };

/** Per-utterance receive state: contiguous seq, size and duration limits. */
export class UplinkStream {
  bytes = 0;
  chunks = 0;
  private nextSeq = 0;
  private sawLast = false;
  constructor(
    readonly streamId: number,
    readonly limits: UplinkLimits,
  ) {}

  get durationMs(): number {
    return (this.bytes / (UPLINK.SAMPLE_RATE * UPLINK.CHANNELS * 2)) * 1000;
  }

  accept(f: DecodedFrame): UplinkAccept {
    if (this.sawLast) return { ok: false, reason: "bad_frame", message: "frame after LAST" };
    if (f.seq !== this.nextSeq) return { ok: false, reason: "seq_gap", message: `expected seq ${this.nextSeq}, got ${f.seq}` };
    const n = f.payload.byteLength;
    if (n === 0 || n % 2 !== 0 || n > UPLINK.MAX_FRAME_BYTES) return { ok: false, reason: "bad_frame", message: `bad payload length ${n}` };
    if (this.bytes + n > this.limits.maxBytes) return { ok: false, reason: "too_large", message: `utterance exceeds ${this.limits.maxBytes} B (${this.limits.maxMs} ms)` };
    this.nextSeq++;
    this.chunks++;
    this.bytes += n;
    if (f.last) this.sawLast = true;
    return { ok: true, payload: f.payload };
  }
}
