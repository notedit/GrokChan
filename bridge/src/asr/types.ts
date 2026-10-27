/**
 * Speech-to-text adapter (mirrors tts/). One AsrSession per utterance:
 * the voice engine push()es PCM chunks as uplink frames arrive and calls
 * finish() when the device ends the utterance. Streaming providers can emit
 * partial transcripts through `onPartial`; whole-utterance providers wrap
 * themselves with createBufferedSession() and only produce the final text.
 */
export interface AsrStartOptions {
  /** S1: always pcm_s16le 16 kHz mono. */
  format: "pcm_s16le";
  sampleRate: number;
  channels: number;
  lang?: string;
  /** Aborted on barge-in / stop / disconnect. Providers must stop work and may reject. */
  signal: AbortSignal;
  onPartial?: (text: string) => void;
}

export interface AsrResult {
  text: string;
  lang?: string;
  provider: string;
}

export interface AsrSession {
  push(chunk: Uint8Array): void;
  /** End of utterance: resolve with the final transcript. */
  finish(): Promise<AsrResult>;
  abort(): void;
}

export interface AsrProvider {
  readonly id: string;
  start(opts: AsrStartOptions): AsrSession;
}

export class AsrError extends Error {
  constructor(
    message: string,
    readonly code: "asr_failed" | "unsupported" | "aborted" = "asr_failed",
  ) {
    super(message);
  }
}
