/**
 * Device/session wire protocol: JSON-RPC 2.0 over WebSocket (`mediasession-rpc/1`).
 * Same kernel for MCP tools and device control: MCP tool schemas and `device.*`
 * methods share DEVICE_METHODS below. Spec: docs/audio-sdk-plan.zh-CN.md,
 * docs/mcp-plan.zh-CN.md §3. Pure helpers (no Workers APIs).
 *
 * S1 keeps audio delimited by audio.begin / binary frames / audio.end
 * (no stream.open yet — deferred to S2). Playback path uses pcm_s16le;
 * opus remains in AudioFormat for negotiation only.
 */

export const PROTOCOL = "mediasession-rpc/1";

export type RpcId = string | number;

export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}
export interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId | null;
  result?: unknown;
  error?: RpcErrorObject;
}
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** Standard JSON-RPC codes + the custom range -32000..-32099 (doc 3.6). */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  BUSY: -32000,
  LIMIT_EXCEEDED: -32001,
  LOW_BATTERY: -32002,
  TIMEOUT: -32003,
  UNAUTHORIZED: -32004,
  PRIVACY_BLOCKED: -32005,
  UNSUPPORTED: -32006,
  RATE_LIMITED: -32007,
  EXPIRED: -32008,
  DEVICE_FAULT: -32009,
  PAYLOAD_TOO_LARGE: -32010,
  QUIET_HOURS: -32011,
  STREAM_ERROR: -32012,
  INTERRUPTED: -32013,
} as const;

/** WebSocket close codes (docs/audio-sdk-plan.zh-CN.md §3.6). */
export const WS_CLOSE = {
  REPLACED: 4000,
  HELLO_TIMEOUT: 4001,
  PROTOCOL_MISMATCH: 4002,
  AUTH_FAILED: 4003, // reserved; auth not implemented yet
} as const;

/**
 * Single source: MCP tool name → device JSON-RPC method.
 * list_devices has no device RPC (registry only). speak adds TTS + audio frames
 * around device.speak. Keep in sync with buildTools() in mcp/tools.ts.
 */
export const DEVICE_METHODS = {
  get_device_status: "device.get_status",
  move_head: "device.move_head",
  reset_pose: "device.reset_pose",
  set_expression: "device.set_expression",
  show_text: "device.show_text",
  set_led: "device.set_led",
  speak: "device.speak",
  stop_audio: "device.stop_audio",
  set_volume: "device.set_volume",
  emergency_stop: "device.emergency_stop",
} as const;
export type DeviceMethodTool = keyof typeof DEVICE_METHODS;


/** Device JSON-RPC error code -> MCP-side tool error code (doc 3.6). */
export function mapDeviceError(code: number): string {
  switch (code) {
    case RPC.BUSY:
    case RPC.QUIET_HOURS:
      return "busy";
    case RPC.LIMIT_EXCEEDED:
      return "rejected_limit";
    case RPC.LOW_BATTERY:
      return "low_battery";
    case RPC.TIMEOUT:
    case RPC.EXPIRED:
      return "timeout";
    case RPC.UNAUTHORIZED:
      return "unauthorized";
    case RPC.PRIVACY_BLOCKED:
      return "privacy_blocked";
    case RPC.UNSUPPORTED:
    case RPC.METHOD_NOT_FOUND:
      return "unsupported";
    case RPC.RATE_LIMITED:
      return "rate_limited";
    case RPC.DEVICE_FAULT:
      return "device_fault";
    case RPC.PAYLOAD_TOO_LARGE:
      return "payload_too_large";
    case RPC.STREAM_ERROR:
      return "stream_error";
    case RPC.INTERRUPTED:
      return "interrupted";
    case RPC.INVALID_PARAMS:
    case RPC.INVALID_REQUEST:
      return "invalid_args";
    default:
      return "device_error";
  }
}

export const rpcRequest = (id: RpcId, method: string, params?: Record<string, unknown>): RpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
export const rpcNotification = (method: string, params?: Record<string, unknown>): RpcNotification => ({
  jsonrpc: "2.0",
  method,
  ...(params ? { params } : {}),
});
export const rpcResult = (id: RpcId | null, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type Classified =
  | { kind: "request"; msg: RpcRequest }
  | { kind: "notification"; msg: RpcNotification }
  | { kind: "response"; msg: RpcResponse }
  | { kind: "invalid"; id: RpcId | null };

/** Classify one decoded JSON value. Batches (arrays) are not used on this wire. */
export function classify(v: unknown): Classified {
  if (!isObject(v) || v.jsonrpc !== "2.0") return { kind: "invalid", id: isObject(v) && isId(v.id) ? v.id : null };
  const id = v.id;
  if (typeof v.method === "string") {
    if (v.params !== undefined && !isObject(v.params)) return { kind: "invalid", id: isId(id) ? id : null };
    if (id === undefined) return { kind: "notification", msg: v as unknown as RpcNotification };
    if (!isId(id)) return { kind: "invalid", id: null };
    return { kind: "request", msg: v as unknown as RpcRequest };
  }
  if (isId(id) && ("result" in v || (isObject(v.error) && typeof v.error.code === "number"))) {
    return { kind: "response", msg: v as unknown as RpcResponse };
  }
  return { kind: "invalid", id: isId(id) ? id : null };
}
function isId(v: unknown): v is RpcId {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

// ---- binary audio frames: [type u8][flags u8][stream u16 LE][seq u32 LE][payload] ----

export const FRAME_HEADER_BYTES = 8;
export const FRAME_DOWNLINK_AUDIO = 0x01;
export const FRAME_UPLINK_AUDIO = 0x02;
export const FRAME_PHOTO = 0x03;
export const FLAG_LAST = 0x01;

export function encodeFrame(type: number, streamId: number, seq: number, payload: Uint8Array, last: boolean): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, type);
  dv.setUint8(1, last ? FLAG_LAST : 0);
  dv.setUint16(2, streamId, true);
  dv.setUint32(4, seq, true);
  new Uint8Array(buf, FRAME_HEADER_BYTES).set(payload);
  return buf;
}

export interface DecodedFrame {
  type: number;
  last: boolean;
  streamId: number;
  seq: number;
  payload: Uint8Array;
}
export function decodeFrame(buf: ArrayBuffer): DecodedFrame | null {
  if (buf.byteLength < FRAME_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  return {
    type: dv.getUint8(0),
    last: (dv.getUint8(1) & FLAG_LAST) !== 0,
    streamId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    payload: new Uint8Array(buf, FRAME_HEADER_BYTES),
  };
}

// ---- audio formats ----

export type AudioFormat = "pcm_s16le" | "mp3" | "opus" | "wav";
export const AUDIO_FORMATS: readonly AudioFormat[] = ["pcm_s16le", "mp3", "opus", "wav"];
export interface PlayCapability {
  format: AudioFormat;
  sample_rate?: number;
  channels?: number;
}
export const DEFAULT_CHUNK_BYTES = 4096;

/** S1: prefer pcm_s16le from negotiated play list; fall back to first entry. */
export function preferPlayFormat(play: readonly PlayCapability[]): PlayCapability {
  return play.find((p) => p.format === "pcm_s16le") ?? play[0] ?? { format: "pcm_s16le", sample_rate: 16000, channels: 1 };
}

/** Device hello params (validated subset). */
export interface HelloInfo {
  protocol: string;
  device_id: string;
  fw?: string;
  hw?: string;
  caps: string[];
  limits?: Record<string, unknown>;
  expressions?: string[];
  play: PlayCapability[];
  max_chunk_bytes: number;
  buffer_ms: number;
}

export function parseHello(params: Record<string, unknown> | undefined, expectedDeviceId: string): { ok: true; hello: HelloInfo } | { ok: false; message: string } {
  if (!params) return { ok: false, message: "params required" };
  if (params.protocol !== PROTOCOL) return { ok: false, message: `unsupported protocol (expected ${PROTOCOL})` };
  if (typeof params.device_id !== "string" || params.device_id !== expectedDeviceId) return { ok: false, message: "device_id mismatch" };
  const caps = Array.isArray(params.caps) ? params.caps.filter((c): c is string => typeof c === "string").slice(0, 32) : [];
  const expressions = Array.isArray(params.expressions) ? params.expressions.filter((c): c is string => typeof c === "string").slice(0, 64) : undefined;
  const audio = isObject(params.audio) ? params.audio : {};
  const play: PlayCapability[] = [];
  if (Array.isArray(audio.play)) {
    for (const p of audio.play) {
      if (isObject(p) && typeof p.format === "string" && (AUDIO_FORMATS as readonly string[]).includes(p.format)) {
        play.push({
          format: p.format as AudioFormat,
          ...(typeof p.sample_rate === "number" ? { sample_rate: p.sample_rate } : {}),
          ...(typeof p.channels === "number" ? { channels: p.channels } : {}),
        });
      }
    }
  }
  if (play.length === 0) play.push({ format: "pcm_s16le", sample_rate: 16000, channels: 1 });
  const maxChunk = typeof audio.max_chunk_bytes === "number" && audio.max_chunk_bytes >= 256 ? Math.min(Math.floor(audio.max_chunk_bytes), 65536) : DEFAULT_CHUNK_BYTES;
  const bufferMs = typeof audio.buffer_ms === "number" && audio.buffer_ms > 0 ? Math.min(audio.buffer_ms, 10000) : 2000;
  return {
    ok: true,
    hello: {
      protocol: PROTOCOL,
      device_id: params.device_id,
      ...(typeof params.fw === "string" ? { fw: params.fw.slice(0, 32) } : {}),
      ...(typeof params.hw === "string" ? { hw: params.hw.slice(0, 32) } : {}),
      caps,
      ...(isObject(params.limits) ? { limits: params.limits } : {}),
      ...(expressions ? { expressions } : {}),
      play,
      max_chunk_bytes: maxChunk,
      buffer_ms: bufferMs,
    },
  };
}

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Exact-match keepalive handled by a DO auto-response, so idle sockets never wake the object. */
export const PING_TEXT = '{"jsonrpc":"2.0","method":"ping"}';
export const PONG_TEXT = '{"jsonrpc":"2.0","method":"pong"}';
