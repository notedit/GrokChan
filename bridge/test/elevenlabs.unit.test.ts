import { describe, expect, it } from "vitest";
import { createElevenLabsAsr } from "../src/asr/elevenlabs";
import { createElevenLabsTts } from "../src/tts/elevenlabs";
import { elevenConfig } from "../src/elevenlabs/config";
import { b64decode, b64encode, type WsConnector, type WsLike } from "../src/net/ws";
import { openSpeechStream } from "../src/tts/stream";

// ElevenLabs adapters against an in-process fake WebSocket: no network, no real key.
const FAKE_KEY = "fake-key-for-tests-only";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeWs implements WsLike {
  sent: any[] = [];
  closed: { code?: number } | null = null;
  private h: Record<string, ((ev: any) => void)[]> = {};
  send(d: string) {
    if (this.closed) throw new Error("send after close");
    this.sent.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closed = { code };
  }
  addEventListener(t: string, fn: (ev: any) => void) {
    (this.h[t] ??= []).push(fn);
  }
  emit(obj: unknown) {
    for (const f of this.h.message ?? []) f({ data: JSON.stringify(obj) });
  }
  serverClose(code = 1000) {
    for (const f of this.h.close ?? []) f({ code });
  }
}
function fake() {
  const ws = new FakeWs();
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const connect: WsConnector = async (url, headers) => {
    calls.push({ url, headers });
    return ws;
  };
  return { ws, calls, connect };
}
const env = { ELEVENLABS_API_KEY: FAKE_KEY };
const ASR_OPTS = { format: "pcm_s16le" as const, sampleRate: 16000, channels: 1 };
const pcm = (n: number, v = 1) => new Uint8Array(n).fill(v);

describe("config", () => {
  it("defaults, host validation, missing key error never contains a value", () => {
    const c = elevenConfig(env);
    expect(c).toMatchObject({ voiceId: "JBFqnCBsd6RMkjVDRZzb", ttsModel: "eleven_flash_v2_5", asrModel: "scribe_v2_realtime", host: "api.elevenlabs.io" });
    expect(() => elevenConfig({})).toThrow("ELEVENLABS_API_KEY is not set");
    expect(() => elevenConfig({ ...env, ELEVENLABS_HOST: "evil.com/x?y" })).toThrow();
  });
});

describe("ElevenLabs streaming ASR (Scribe realtime)", () => {
  it("forwards frames as they arrive, maps partial/committed, commits on finish; key only in a header", async () => {
    const f = fake();
    const parts: string[] = [];
    const s = createElevenLabsAsr(env, { connect: f.connect }).start({ ...ASR_OPTS, lang: "zh-CN", signal: new AbortController().signal, onPartial: (t) => parts.push(t) });
    s.push(pcm(3200, 1)); // before session_started: queued
    s.push(pcm(3200, 2));
    await sleep(5);
    expect(f.calls).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.host).toBe("api.elevenlabs.io");
    expect(u.pathname).toBe("/v1/speech-to-text/realtime");
    expect(Object.fromEntries(u.searchParams)).toEqual({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "manual", language_code: "zh" });
    expect(f.calls[0]!.url).not.toContain(FAKE_KEY);
    expect(f.calls[0]!.headers).toEqual({ "xi-api-key": FAKE_KEY });
    expect(f.ws.sent).toHaveLength(0);

    f.ws.emit({ message_type: "session_started", session_id: "s1" });
    expect(f.ws.sent).toHaveLength(1); // first frame flushed; the newest one is held back for the commit
    s.push(pcm(3200, 3));
    expect(f.ws.sent).toHaveLength(2); // frames are forwarded as they arrive, not buffered until the end
    f.ws.emit({ message_type: "partial_transcript", text: " 你好 " });
    f.ws.emit({ message_type: "partial_transcript", text: "你好世界" });
    expect(parts).toEqual(["你好", "你好世界"]);

    const fin = s.finish();
    const last = f.ws.sent.at(-1);
    expect(last).toMatchObject({ message_type: "input_audio_chunk", commit: true, sample_rate: 16000 });
    expect(b64decode(last.audio_base_64)[0]).toBe(3);
    expect(f.ws.sent.slice(0, -1).every((m) => m.commit === false)).toBe(true);
    f.ws.emit({ message_type: "committed_transcript", text: "你好世界。" });
    expect(await fin).toMatchObject({ text: "你好世界。", provider: "elevenlabs", lang: "zh" });
    expect(f.ws.closed).not.toBeNull();
    expect(JSON.stringify(f.ws.sent)).not.toContain(FAKE_KEY);
  });

  it("abort() closes the upstream socket and rejects; upstream errors reject; insufficient audio is an empty result", async () => {
    const f = fake();
    const ac = new AbortController();
    const s = createElevenLabsAsr(env, { connect: f.connect }).start({ ...ASR_OPTS, signal: ac.signal });
    await sleep(5);
    f.ws.emit({ message_type: "session_started" });
    s.push(pcm(320));
    const p = s.finish().catch((e) => e);
    ac.abort();
    expect(await p).toMatchObject({ code: "aborted" });
    expect(f.ws.closed).not.toBeNull();

    const g = fake();
    const s2 = createElevenLabsAsr(env, { connect: g.connect }).start({ ...ASR_OPTS, signal: new AbortController().signal });
    await sleep(5);
    g.ws.emit({ message_type: "session_started" });
    s2.push(pcm(320));
    const p2 = s2.finish();
    g.ws.emit({ message_type: "quota_exceeded", error: "limit" });
    await expect(p2).rejects.toThrow("quota_exceeded");

    const h = fake();
    const s3 = createElevenLabsAsr(env, { connect: h.connect }).start({ ...ASR_OPTS, signal: new AbortController().signal });
    await sleep(5);
    h.ws.emit({ message_type: "session_started" });
    s3.push(pcm(320));
    const p3 = s3.finish();
    h.ws.emit({ message_type: "insufficient_audio_activity" });
    expect((await p3).text).toBe("");
  });

  it("missing key / refused upgrade / finish without audio fail without leaking anything", async () => {
    expect(() => createElevenLabsAsr({}, {}).start({ ...ASR_OPTS, signal: new AbortController().signal })).toThrow("ELEVENLABS_API_KEY is not set");
    const refuse: WsConnector = async () => {
      throw new Error("websocket upgrade refused (HTTP 401)");
    };
    const s = createElevenLabsAsr(env, { connect: refuse }).start({ ...ASR_OPTS, signal: new AbortController().signal });
    s.push(pcm(320));
    await expect(s.finish()).rejects.toThrow("HTTP 401");
    const f = fake();
    const e = createElevenLabsAsr(env, { connect: f.connect }).start({ ...ASR_OPTS, signal: new AbortController().signal });
    await expect(e.finish()).rejects.toThrow("no audio");
  });
});

describe("ElevenLabs streaming TTS (stream-input)", () => {
  const ACCEPT = [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }];
  const audioMsg = (n: number, v = 1) => ({ audio: b64encode(pcm(n, v)), isFinal: null });

  it("pcm_16000, key in header only, text pushed per sentence, audio yielded while text is still being sent", async () => {
    const f = fake();
    const s = await createElevenLabsTts(env, { connect: f.connect }).openInputStream!({ text: "", accept: ACCEPT });
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ model_id: "eleven_flash_v2_5", output_format: "pcm_16000", auto_mode: "true" });
    expect(f.calls[0]!.url).not.toContain(FAKE_KEY);
    expect(f.calls[0]!.headers).toEqual({ "xi-api-key": FAKE_KEY });
    expect(f.ws.sent[0].text).toBe(" "); // init message
    expect(s).toMatchObject({ format: "pcm_s16le", sampleRate: 16000, channels: 1, provider: "elevenlabs" });

    s.sendText("第一句。");
    expect(f.ws.sent.at(-1)).toEqual({ text: "第一句。 " });
    const it = s.chunks[Symbol.asyncIterator]();
    f.ws.emit(audioMsg(3200));
    expect((await it.next()).value).toHaveLength(3200); // audio is out before end() was even called
    s.sendText("第二句。");
    s.end();
    expect(f.ws.sent.at(-1)).toEqual({ text: "" });
    f.ws.emit(audioMsg(3, 7)); // odd byte count: the stray byte is carried to the next message
    f.ws.emit(audioMsg(3, 8));
    f.ws.emit({ audio: null, isFinal: true });
    const rest: Uint8Array[] = [];
    for (let r = await it.next(); !r.done; r = await it.next()) rest.push(r.value);
    expect(rest.reduce((n, c) => n + c.byteLength, 0)).toBe(6);
    expect(rest.every((c) => c.byteLength % 2 === 0)).toBe(true);
    expect(f.ws.closed).not.toBeNull();
  });

  it("abort() closes the socket and discards later audio (barge-in)", async () => {
    const f = fake();
    const ac = new AbortController();
    const s = await createElevenLabsTts(env, { connect: f.connect }).openInputStream!({ text: "", accept: ACCEPT, signal: ac.signal });
    s.sendText("会被打断。");
    f.ws.emit(audioMsg(640));
    ac.abort();
    expect(f.ws.closed).not.toBeNull();
    f.ws.emit(audioMsg(640)); // arrives after the abort
    const got: number[] = [];
    for await (const c of s.chunks) got.push(c.byteLength);
    expect(got).toEqual([]); // queued audio was dropped, nothing delivered after abort
    expect(() => s.sendText("more")).not.toThrow(); // no send on a closed socket
  });

  it("server error and refused upgrade surface as TtsError; unsupported accept list is rejected", async () => {
    const f = fake();
    const s = await createElevenLabsTts(env, { connect: f.connect }).openInputStream!({ text: "", accept: ACCEPT });
    f.ws.emit({ error: "quota", message: "Quota exceeded" });
    await expect((async () => { for await (const _ of s.chunks); })()).rejects.toThrow("Quota exceeded");

    const refuse: WsConnector = async () => {
      throw new Error("websocket upgrade refused (HTTP 401)");
    };
    await expect(createElevenLabsTts(env, { connect: refuse }).openInputStream!({ text: "", accept: ACCEPT })).rejects.toThrow("HTTP 401");
    await expect(createElevenLabsTts(env, { connect: f.connect }).openInputStream!({ text: "", accept: [{ format: "pcm_s16le", sample_rate: 8000, channels: 1 }] })).rejects.toThrow();
    await expect(createElevenLabsTts({}, { connect: f.connect }).openInputStream!({ text: "", accept: ACCEPT })).rejects.toThrow("ELEVENLABS_API_KEY is not set");
  });

  it("works through openSpeechStream (sentences pushed, audio relayed, session closed at the end)", async () => {
    const f = fake();
    const sp = await openSpeechStream(createElevenLabsTts(env, { connect: f.connect }), { text: "你好。再见。", accept: ACCEPT });
    expect(f.ws.sent.map((m) => m.text)).toEqual([" ", "你好。 ", "再见。 ", ""]);
    f.ws.emit(audioMsg(1600));
    f.ws.emit({ isFinal: true });
    const got: number[] = [];
    for await (const c of sp.chunks) got.push(c.audio.byteLength);
    expect(got).toEqual([1600]);
    expect(f.ws.closed).not.toBeNull();
  });
});
