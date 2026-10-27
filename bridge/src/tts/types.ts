import type { AudioFormat, PlayCapability } from "../device/protocol";

export interface TtsRequest {
  text: string;
  voice?: string;
  lang?: string;
  /** Formats the target device can decode, in preference order. */
  accept: PlayCapability[];
}

export interface TtsResult {
  audio: Uint8Array;
  format: AudioFormat;
  sampleRate?: number;
  channels: number;
  /** Used for pacing when the format is compressed. */
  bitrateKbps?: number;
  provider: string;
  voice: string;
  cached: boolean;
}

/** Streaming synthesis of one text segment: audio arrives as chunks while the provider is still working. */
export interface TtsStreamResult {
  format: AudioFormat;
  sampleRate?: number;
  channels: number;
  provider: string;
  voice: string;
  chunks: AsyncIterable<Uint8Array>;
}
export interface TtsStreamRequest extends TtsRequest {
  /** Abort synthesis (barge-in / stop). */
  signal?: AbortSignal;
}

/**
 * Push-text / pull-audio synthesis session (one upstream connection for a whole reply, e.g. ElevenLabs
 * WebSocket stream-input). Audio is available through `chunks` while text is still being pushed.
 */
export interface TtsInputSession extends TtsStreamResult {
  /** Queue more text for synthesis (call once per sentence or LLM delta). */
  sendText(text: string): void;
  /** No more text: flush what is buffered and finish `chunks` after the last audio. */
  end(): void;
  /** Interrupt: close the upstream connection, drop all pending/later audio. Idempotent. */
  abort(): void;
}

/** Cloud TTS adapter. The bridge never transcodes; it asks for a format the device can decode. */
export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
  /**
   * Optional chunked synthesis. Providers without it are wrapped by
   * openSpeechStream(), which falls back to synthesize() per sentence.
   */
  synthesizeStream?(req: TtsStreamRequest): Promise<TtsStreamResult>;
  /**
   * Optional push-text session; preferred by openSpeechStream() when present. Resolves once the upstream
   * is connected (so auth/format errors surface before any audio.begin). `req.text` is ignored here.
   */
  openInputStream?(req: TtsStreamRequest): Promise<TtsInputSession>;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly code: "tts_failed" | "unsupported" = "tts_failed",
  ) {
    super(message);
  }
}
