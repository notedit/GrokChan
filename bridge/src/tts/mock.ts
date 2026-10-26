import { TtsError, type TtsProvider, type TtsRequest, type TtsResult } from "./types";

export const MOCK_MS_PER_CHAR = 40;
export const MOCK_MAX_MS = 20_000;
export const MOCK_SAMPLE_RATE = 16000;

/**
 * Deterministic fake TTS for tests and bring-up: a quiet sine tone whose
 * length depends on the text (40 ms per character, 20 s max). No network.
 * Test hooks inside the text: "[tts-fail]" throws, "[tts-slow]" waits 1.5 s.
 */
export function createMockTts(): TtsProvider {
  return {
    id: "mock",
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
