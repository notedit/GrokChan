import { AsyncQueue } from "../net/queue";
import { TtsError, type TtsInputSession, type TtsProvider, type TtsRequest, type TtsResult, type TtsStreamRequest, type TtsStreamResult } from "./types";

export const MOCK_MS_PER_CHAR = 40;
export const MOCK_MAX_MS = 20_000;
export const MOCK_SAMPLE_RATE = 16000;
/** Streaming mock emits this much audio per chunk. */
export const MOCK_STREAM_CHUNK_MS = 100;

/**
 * Deterministic fake TTS for tests and bring-up: a quiet sine tone whose
 * length depends on the text (40 ms per character, 20 s max). No network.
 * Test hooks inside the text: "[tts-fail]" throws, "[tts-slow]" waits 1.5 s.
 * synthesizeStream() yields the same audio in 100 ms chunks (PCM only); the
 * "[tts-slow]" delay happens before the first chunk, "[tts-midfail]" throws
 * after the first chunk.
 */
export function createMockTts(opts: { inputStream?: boolean } = {}): TtsProvider {
  return {
    id: opts.inputStream ? "mock-stream" : "mock",
    ...(opts.inputStream ? { openInputStream: openMockInput } : {}),
    async synthesizeStream(req: TtsStreamRequest): Promise<TtsStreamResult> {
      if (req.text.includes("[tts-fail]")) throw new TtsError("mock tts failure");
      const chosen = req.accept.find((a) => a.format === "pcm_s16le");
      if (!chosen) throw new TtsError("streaming needs pcm_s16le", "unsupported");
      const rate = chosen.sample_rate ?? MOCK_SAMPLE_RATE;
      const channels = chosen.channels ?? 1;
      const ms = Math.min(MOCK_MAX_MS, Math.max(100, [...req.text].length * MOCK_MS_PER_CHAR));
      const voice = req.voice ?? "mock-voice";
      const slow = req.text.includes("[tts-slow]");
      const midfail = req.text.includes("[tts-midfail]");
      const chunkSamples = Math.floor((rate * MOCK_STREAM_CHUNK_MS) / 1000);
      const total = Math.floor((rate * ms) / 1000);
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (slow) await new Promise((r) => setTimeout(r, 1500));
        for (let at = 0; at < total; at += chunkSamples) {
          if (req.signal?.aborted) return;
          if (midfail && at > 0) throw new TtsError("mock tts failure mid-stream");
          const n = Math.min(chunkSamples, total - at);
          const out = new Uint8Array(n * 2 * channels);
          const dv = new DataView(out.buffer);
          for (let i = 0; i < n; i++) {
            const v = Math.round(Math.sin((2 * Math.PI * 440 * (at + i)) / rate) * 2000);
            for (let c = 0; c < channels; c++) dv.setInt16((i * channels + c) * 2, v, true);
          }
          yield out;
        }
      }
      return { format: "pcm_s16le", sampleRate: rate, channels, provider: "mock", voice, chunks: chunks() };
    },
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      if (req.text.includes("[tts-fail]")) throw new TtsError("mock tts failure");
      if (req.text.includes("[tts-slow]")) await new Promise((r) => setTimeout(r, 1500));
      const chosen = req.accept.find((a) => a.format === "pcm_s16le") ?? req.accept.find((a) => a.format === "mp3");
      if (!chosen) throw new TtsError("device accepts no format the mock can produce", "unsupported");
      const ms = Math.min(MOCK_MAX_MS, Math.max(100, [...req.text].length * MOCK_MS_PER_CHAR));
      const voice = req.voice ?? "mock-voice";
      if (chosen.format === "mp3") {
        // Not decodable audio, just a deterministic payload with an ID3 header.
        const n = Math.ceil((ms * 16) / 8);
        const audio = new Uint8Array(n);
        audio.set([0x49, 0x44, 0x33, 0x04, 0, 0]);
        for (let i = 6; i < n; i++) audio[i] = i & 0xff;
        return { audio, format: "mp3", channels: 1, bitrateKbps: 128, provider: "mock", voice, cached: false };
      }
      const rate = chosen.sample_rate ?? MOCK_SAMPLE_RATE;
      const samples = Math.floor((rate * ms) / 1000);
      const audio = new Uint8Array(samples * 2);
      const dv = new DataView(audio.buffer);
      for (let i = 0; i < samples; i++) dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), true);
      return { audio, format: "pcm_s16le", sampleRate: rate, channels: chosen.channels ?? 1, provider: "mock", voice, cached: false };
    },
  };
}

/**
 * Push-text session (TTS_PROVIDER=mock-stream): each sendText() is synthesized in order, audio chunks
 * appear in `chunks` while later text is still being pushed. Same hooks as the per-sentence mock.
 */
async function openMockInput(req: TtsStreamRequest): Promise<TtsInputSession> {
  const chosen = req.accept.find((a) => a.format === "pcm_s16le");
  if (!chosen) throw new TtsError("streaming needs pcm_s16le", "unsupported");
  const rate = chosen.sample_rate ?? MOCK_SAMPLE_RATE;
  const channels = chosen.channels ?? 1;
  const out = new AsyncQueue<Uint8Array>();
  const texts = new AsyncQueue<string>();
  let aborted = false;
  const chunkSamples = Math.floor((rate * MOCK_STREAM_CHUNK_MS) / 1000);
  void (async () => {
    try {
      let at = 0;
      for await (const text of texts) {
        if (text.includes("[tts-fail]")) throw new TtsError("mock tts failure");
        if (text.includes("[tts-slow]")) await new Promise((r) => setTimeout(r, 1500));
        const total = Math.floor((rate * Math.min(MOCK_MAX_MS, Math.max(100, [...text].length * MOCK_MS_PER_CHAR))) / 1000);
        for (let o = 0; o < total; o += chunkSamples) {
          if (aborted || req.signal?.aborted) return;
          if (text.includes("[tts-midfail]") && o > 0) throw new TtsError("mock tts failure mid-stream");
          const n = Math.min(chunkSamples, total - o);
          const buf = new Uint8Array(n * 2 * channels);
          const dv = new DataView(buf.buffer);
          for (let i = 0; i < n; i++) {
            const v = Math.round(Math.sin((2 * Math.PI * 440 * (at + o + i)) / rate) * 2000);
            for (let c = 0; c < channels; c++) dv.setInt16((i * channels + c) * 2, v, true);
          }
          out.push(buf);
          await Promise.resolve();
        }
        at += total;
      }
      out.close();
    } catch (e) {
      out.fail(e);
    }
  })();
  req.signal?.addEventListener("abort", () => session.abort(), { once: true });
  const session: TtsInputSession = {
    format: "pcm_s16le",
    sampleRate: rate,
    channels,
    provider: "mock-stream",
    voice: req.voice ?? "mock-voice",
    chunks: out,
    sendText: (t) => texts.push(t),
    end: () => texts.close(),
    abort: () => {
      aborted = true;
      texts.discard();
      out.discard();
    },
  };
  return session;
}
