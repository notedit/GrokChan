import { createBufferedSession } from "./buffered";
import { AsrError, type AsrProvider, type AsrSession, type AsrStartOptions } from "./types";

/** Minimal Workers AI binding shape (declare `[ai] binding = "AI"` in wrangler.toml to use this). */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export interface WorkersAiAsrEnv {
  AI?: AiBinding;
  /** default @cf/openai/whisper-large-v3-turbo */
  ASR_MODEL?: string;
}

export const DEFAULT_WORKERS_AI_ASR_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** Wrap 16-bit PCM in a 44-byte WAV header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

function base64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Whole-utterance Whisper on Workers AI. UNTESTED against the real service
 * (no binding in this repo's wrangler.toml and no key/credentials involved);
 * kept as the reference adapter for ASR_PROVIDER=workers-ai.
 * A Deepgram nova adapter would register the same way (registerAsrProvider)
 * and could use the streaming interface (push → partials → finish).
 */
export function createWorkersAiAsr(env: WorkersAiAsrEnv): AsrProvider {
  return {
    id: "workers-ai",
    start(opts: AsrStartOptions): AsrSession {
      if (!env.AI) throw new AsrError("Workers AI binding `AI` is not configured", "unsupported");
      const ai = env.AI;
      return createBufferedSession(opts, async (pcm) => {
        const model = env.ASR_MODEL || DEFAULT_WORKERS_AI_ASR_MODEL;
        const wav = pcmToWav(pcm, opts.sampleRate, opts.channels);
        let out: unknown;
        try {
          out = await ai.run(model, { audio: base64(wav), ...(opts.lang ? { language: opts.lang } : {}) });
        } catch (e) {
          throw new AsrError(`workers-ai: ${e instanceof Error ? e.message : String(e)}`);
        }
        const text = typeof out === "object" && out !== null && typeof (out as { text?: unknown }).text === "string" ? (out as { text: string }).text.trim() : "";
        return { text, ...(opts.lang ? { lang: opts.lang } : {}), provider: "workers-ai" };
      });
    },
  };
}
