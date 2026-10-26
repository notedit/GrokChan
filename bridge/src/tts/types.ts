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

/** Cloud TTS adapter. The bridge never transcodes; it asks for a format the device can decode. */
export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly code: "tts_failed" | "unsupported" = "tts_failed",
  ) {
    super(message);
  }
}
