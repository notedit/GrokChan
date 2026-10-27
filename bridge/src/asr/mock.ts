import { createBufferedSession } from "./buffered";
import { AsrError, type AsrProvider, type AsrSession, type AsrStartOptions } from "./types";

export const MOCK_ASR_SLOW_MS = 1500;

/**
 * Deterministic fake ASR for tests/bring-up. The "audio" is expected to carry
 * UTF-8 text (tests encode what they "say" as the PCM payload); the transcript
 * is that text. Hooks inside the text: "[asr-fail]" rejects, "[asr-slow]"
 * waits 1.5 s (abortable) before answering, "[asr-empty]" returns "".
 * A "partial" is emitted per pushed chunk when onPartial is set, so
 * transcript.partial events can be tested.
 */
export function createMockAsr(): AsrProvider {
  return {
    id: "mock",
    start(opts: AsrStartOptions): AsrSession {
      const dec = new TextDecoder();
      let acc = "";
      const inner = createBufferedSession(opts, async (pcm) => {
        const text = new TextDecoder().decode(pcm);
        if (text.includes("[asr-fail]")) throw new AsrError("mock asr failure");
        if (text.includes("[asr-slow]")) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, MOCK_ASR_SLOW_MS);
            opts.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new AsrError("aborted", "aborted"));
              },
              { once: true },
            );
          });
        }
        if (opts.signal.aborted) throw new AsrError("aborted", "aborted");
        const clean = text.replace(/\[asr-(fail|slow|empty)\]/g, "").trim();
        return { text: text.includes("[asr-empty]") ? "" : clean, lang: opts.lang ?? "zh", provider: "mock" };
      });
      return {
        push(chunk) {
          inner.push(chunk);
          if (opts.onPartial) {
            acc += dec.decode(chunk, { stream: true });
            opts.onPartial(acc.replace(/\[asr-(fail|slow|empty)\]/g, "").trim());
          }
        },
        finish: () => inner.finish(),
        abort: () => inner.abort(),
      };
    },
  };
}
