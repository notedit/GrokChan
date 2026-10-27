import { AsrError, type AsrResult, type AsrSession, type AsrStartOptions } from "./types";

/** Adapt a whole-utterance transcribe(pcm) function into an AsrSession (buffers pushes until finish). */
export function createBufferedSession(opts: AsrStartOptions, transcribe: (pcm: Uint8Array, opts: AsrStartOptions) => Promise<AsrResult>): AsrSession {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  return {
    push(chunk) {
      if (done) return;
      parts.push(chunk);
      bytes += chunk.byteLength;
    },
    async finish() {
      if (done) throw new AsrError("session already finished");
      done = true;
      if (opts.signal.aborted) throw new AsrError("aborted", "aborted");
      const pcm = new Uint8Array(bytes);
      let at = 0;
      for (const p of parts) {
        pcm.set(p, at);
        at += p.byteLength;
      }
      parts.length = 0;
      return transcribe(pcm, opts);
    },
    abort() {
      done = true;
      parts.length = 0;
    },
  };
}
