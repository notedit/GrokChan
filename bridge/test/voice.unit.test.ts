import { describe, expect, it } from "vitest";
import { splitSentences } from "../src/tts/sentences";
import { openSpeechStream } from "../src/tts/stream";
import { createMockTts } from "../src/tts/mock";
import { createMockAsr } from "../src/asr/mock";
import { getAsrProvider } from "../src/asr";
import { getTtsProvider } from "../src/tts";
import { Pacer } from "../src/voice/pacer";
import { parseUplinkBegin, UplinkStream, uplinkLimits } from "../src/voice/uplink";
import { AsyncQueue } from "../src/net/queue";
import { FRAME_UPLINK_AUDIO } from "../src/device/protocol";

const ACCEPT = [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }];
const frame = (seq: number, n: number, last = false) => ({ type: FRAME_UPLINK_AUDIO, flags: last ? 1 : 0, streamId: 5, seq, last, payload: new Uint8Array(n) }) as never;

describe("splitSentences", () => {
  it("splits on CJK/ASCII terminators, keeps decimals, cuts the first sentence early", () => {
    expect(splitSentences("你好。今天天气不错！出去走走吧？")).toEqual(["你好。", "今天天气不错！", "出去走走吧？"]);
    expect(splitSentences("Pi is 3.14. Next one.")).toEqual(["Pi is 3.14.", "Next one."]);
    const long = "这是一个很长很长很长很长很长很长很长很长很长很长很长很长很长很长，后面还有内容。";
    expect(splitSentences(long, { firstMaxChars: 20 })[0]!.length).toBeLessThanOrEqual(21);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("Pacer", () => {
  it("lets the device buffer fill, then paces at 1.2x real time; credit lowers the wait", () => {
    const p = new Pacer(32, 1000, 1.2); // 32 B/ms
    expect(p.delayMs(0)).toBe(0);
    for (let i = 0; i < 10; i++) p.sent(3200, 0); // 1000 ms of audio in the burst window
    expect(p.delayMs(0)).toBe(0);
    p.sent(3200, 0); // 1100 ms sent at t=0 -> wait (1100-1000)/1.2 = 84 ms
    expect(p.delayMs(0)).toBe(84);
    expect(p.delayMs(100)).toBe(0);
    p.onCredit(200, 100); // device says only 200 ms buffered -> estimate stays under burst, no extra wait
    expect(p.delayMs(100)).toBe(0);
    expect(p.audioMs).toBeCloseTo(1100);
  });
});

describe("uplink validation", () => {
  const lim = uplinkLimits(1000);
  it("accepts pcm_s16le 16k mono only; rejects declared oversize", () => {
    expect(parseUplinkBegin({ stream_id: 7, format: "pcm_s16le", sample_rate: 16000, channels: 1, lang: "zh" }, lim)).toMatchObject({ ok: true, begin: { streamId: 7, lang: "zh" } });
    expect(parseUplinkBegin({ stream_id: 7, format: "opus" }, lim)).toMatchObject({ ok: false, reason: "unsupported_format" });
    expect(parseUplinkBegin({ stream_id: 7, format: "pcm_s16le", sample_rate: 8000 }, lim)).toMatchObject({ ok: false, reason: "unsupported_format" });
    expect(parseUplinkBegin({ stream_id: 7, format: "pcm_s16le", total_bytes: lim.maxBytes + 2 }, lim)).toMatchObject({ ok: false, reason: "too_large" });
  });
  it("UplinkStream: contiguous seq, even length, size limit, nothing after LAST", () => {
    const u = new UplinkStream(5, lim);
    expect(u.accept(frame(0, 3200)).ok).toBe(true);
    expect(u.accept(frame(2, 3200))).toMatchObject({ ok: false, reason: "seq_gap" });
    expect(u.accept(frame(1, 3))).toMatchObject({ ok: false, reason: "bad_frame" });
    for (let i = 1; i < 10; i++) expect(u.accept(frame(i, 3200)).ok).toBe(true);
    expect(u.durationMs).toBeCloseTo(1000);
    expect(u.accept(frame(10, 2))).toMatchObject({ ok: false, reason: "too_large" });
    const v = new UplinkStream(6, lim);
    expect(v.accept(frame(0, 100, true)).ok).toBe(true);
    expect(v.accept(frame(1, 100))).toMatchObject({ ok: false, reason: "bad_frame" });
  });
});

describe("AsyncQueue", () => {
  it("delivers in order, fails once, and discard() ends cleanly", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    setTimeout(() => q.fail(new Error("boom")), 10);
    const got: number[] = [];
    await expect(
      (async () => {
        for await (const v of q) got.push(v);
      })(),
    ).rejects.toThrow("boom");
    expect(got).toEqual([1, 2]);
    const d = new AsyncQueue<number>();
    d.push(1);
    d.discard();
    const rest: number[] = [];
    for await (const v of d) rest.push(v);
    expect(rest).toEqual([]);
  });
});

describe("provider registries", () => {
  it("nothing is enabled unless named; elevenlabs only when chosen explicitly", () => {
    expect(getTtsProvider({})).toBeUndefined();
    expect(getAsrProvider({})).toBeUndefined();
    expect(getTtsProvider({ TTS_PROVIDER: "mock" })?.id).toBe("mock");
    expect(getAsrProvider({ ASR_PROVIDER: "mock" })?.id).toBe("mock");
    expect(getTtsProvider({ TTS_PROVIDER: "elevenlabs" })?.id).toBe("elevenlabs");
    expect(getAsrProvider({ ASR_PROVIDER: "elevenlabs" })?.id).toBe("elevenlabs");
    expect(getTtsProvider({ TTS_PROVIDER: "mock-stream" })?.id).toBe("mock-stream");
  });
});

describe("mock ASR (streaming)", () => {
  it("emits growing partials per pushed frame, then the final text on finish()", async () => {
    const parts: string[] = [];
    const s = createMockAsr().start({ format: "pcm_s16le", sampleRate: 16000, channels: 1, signal: new AbortController().signal, onPartial: (t) => parts.push(t) });
    const enc = (t: string) => new TextEncoder().encode(t);
    s.push(enc("你好 "));
    s.push(enc("世界"));
    expect(parts).toEqual(["你好", "你好 世界"]);
    expect((await s.finish()).text).toBe("你好 世界");
  });
  it("abort() rejects a slow transcription", async () => {
    const ac = new AbortController();
    const s = createMockAsr().start({ format: "pcm_s16le", sampleRate: 16000, channels: 1, signal: ac.signal });
    s.push(new TextEncoder().encode("[asr-slow]x "));
    const p = s.finish();
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "aborted" });
  });
});

async function collect(it: AsyncIterable<{ sentence: number; audio: Uint8Array }>) {
  const out: { sentence: number; audio: Uint8Array }[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("openSpeechStream", () => {
  it("per-sentence providers: chunks arrive in sentence order, tagged with the sentence index", async () => {
    const s = await openSpeechStream(createMockTts(), { text: "第一句。第二句。第三句。", accept: ACCEPT });
    expect(s.sentences).toHaveLength(3);
    const chunks = await collect(s.chunks);
    const order = chunks.map((c) => c.sentence);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order)).toEqual(new Set([0, 1, 2]));
  });
  it("push-text providers: one session, every sentence sent, audio in order", async () => {
    const s = await openSpeechStream(createMockTts({ inputStream: true }), { text: "第一句。第二句。", accept: ACCEPT });
    expect(s.provider).toBe("mock-stream");
    const bytes = (await collect(s.chunks)).reduce((n, c) => n + c.audio.byteLength, 0);
    expect(bytes).toBeGreaterThan(2 * 3 * 40 * 32 - 64);
  });
  it("abort signal stops the stream and ends the iterator", async () => {
    const ac = new AbortController();
    const s = await openSpeechStream(createMockTts({ inputStream: true }), { text: "很长的一句话".repeat(20), accept: ACCEPT }, { signal: ac.signal });
    let n = 0;
    for await (const _ of s.chunks) {
      if (++n === 2) ac.abort();
    }
    expect(n).toBeLessThan(40);
  });
  it("[tts-fail] rejects before any audio", async () => {
    await expect(openSpeechStream(createMockTts(), { text: "[tts-fail]坏。", accept: ACCEPT })).rejects.toThrow();
  });
});
