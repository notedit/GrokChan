import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client, MockWebhook, sleep, startWorker, waitFor, WEBHOOK_KEY, PASSCODE, MCP_API_KEY, issueDeviceToken, type Worker } from "./harness";
import { MockDevice, type MockOptions } from "./mock-device";
import { mcpClient } from "./mcp-client";

// Voice conversation chain, real workerd: mock device -> uplink -> mock ASR -> mock grokbot webhook ->
// reply URL -> mock TTS -> downlink audio. No network, no real keys.
const VARS = {
  STACKCHAN_ENABLED: "true",
  TTS_PROVIDER: "mock",
  ASR_PROVIDER: "mock",
  DEVICE_CMD_TIMEOUT_MS: "800",
  HELLO_TIMEOUT_MS: "1500",
  DEVICE_RATE_LIMIT_PER_SEC: "1000",
  UPLINK_IDLE_TIMEOUT_MS: "500",
  UPLINK_MAX_MS: "1000", // 32000 B
  UPLINK_GRACE_MS: "300",
  AGENT_REPLY_TIMEOUT_MS: "1500",
  ASR_TIMEOUT_MS: "3000",
  RETRY_BASE_MS: "10",
  SITE_PASSCODE: PASSCODE,
  MCP_API_KEY,
};

let hook: MockWebhook;
let w: Worker;
let strict: Worker;
let mcp: ReturnType<typeof mcpClient>;
let http: ReturnType<typeof client>;
const devices: MockDevice[] = [];
let n = 0;
const did = () => `voice_${++n}_${Math.random().toString(36).slice(2, 7)}`;

async function dev(opts: MockOptions = {}, id = did(), base = w.base): Promise<MockDevice> {
  const token = opts.token ?? (await issueDeviceToken(base, id));
  const d = new MockDevice(base, id, { ...opts, token });
  devices.push(d);
  await d.start();
  return d;
}
/** Webhook request number `i` (0-based) for this device. */
const hookFor = (d: MockDevice, i = 0) => hook.requests.filter((r) => r.body?.device?.id === d.deviceId)[i];
const waitHook = (d: MockDevice, i = 0) => waitFor(() => hookFor(d, i), 5000);

beforeAll(async () => {
  hook = new MockWebhook();
  await hook.start();
  const hv = { GROK_WEBHOOK_URL: hook.url, GROK_WEBHOOK_KEY: WEBHOOK_KEY };
  [w, strict] = await Promise.all([startWorker({ ...VARS, ...hv }), startWorker({ ...VARS, ...hv, VOICE_TURNS_PER_MIN: "2" })]);
  mcp = mcpClient(w.base, { authorization: `Bearer ${MCP_API_KEY}` });
  http = client(w.base);
});
afterAll(async () => {
  for (const d of devices) try { d.close(); } catch {}
  await Promise.all([w?.stop(), strict?.stop(), hook?.stop()]);
});

describe("full voice turn", () => {
  it("hello advertises uplink limits; utterance -> partial/final transcript -> grokbot (device ctx) -> streamed TTS -> idle", async () => {
    const d = await dev();
    expect(d.helloResult.voice.uplink).toMatchObject({ format: "pcm_s16le", sample_rate: 16000, channels: 1, max_ms: 1000, max_bytes: 32000 });

    const sid = await d.say("你好 今天天气怎么样", { chunks: 3, chunkDelayMs: 30, lang: "zh" });
    await d.waitForState("thinking");
    const final = d.transcripts(true)[0];
    expect(final.text).toBe("你好 今天天气怎么样");
    expect(d.transcripts(false).length).toBeGreaterThanOrEqual(2); // partials arrive while frames are still coming
    expect(d.transcripts(false).at(-1).seq).toBeLessThan(final.seq);

    const req = await waitHook(d);
    expect(req.body.schema).toBe("grokbot-web.inbound.v1");
    expect(req.body.message).toBe("你好 今天天气怎么样");
    expect(req.body.device).toMatchObject({ id: d.deviceId, modality: "voice", turn_id: d.lastTurnId(), hw: "m5stack-stackchan", lang: "zh" });
    expect(req.body.reply.url).toMatch(/\/api\/reply\//);
    expect(d.audioStreams()).toHaveLength(0); // nothing is spoken before the reply exists

    const rr = await http.reply(req.body.reply.url, { text: "今天晴天。适合出门散步。" });
    expect(rr.status).toBe(200);
    await d.waitForState("idle");
    expect(d.turnStates()).toEqual(["listening", "transcribing", "thinking", "speaking", "idle:done"]);

    const [a] = d.audioStreams();
    expect(a.begin).toMatchObject({ format: "pcm_s16le", sample_rate: 16000, channels: 1, turn_id: d.lastTurnId() });
    expect(a.begin.total_bytes).toBeUndefined(); // streaming: length unknown at audio.begin
    expect(a.end).toMatchObject({ reason: "complete", total_bytes: a.bytes, total_chunks: a.frames.length });
    expect(a.bytes).toBeGreaterThan(8 * 40 * 32 - 3200); // ~12 chars x 40 ms @ 32 B/ms
    expect(a.frames.map((f) => f.seq)).toEqual(a.frames.map((_, i) => i)); // contiguous seq; audio.end (not a LAST flag) terminates a streamed reply
    expect(d.notifications("turn.reply")[0].params.text).toBe("今天晴天。适合出门散步。");
    expect(sid).toBeGreaterThan(0);
    // the uplink stream was acknowledged in order: begin before final transcript before audio.begin
    const tr = d.trace();
    expect(tr.indexOf("asr.transcript")).toBeLessThan(tr.lastIndexOf("audio.begin"));
  });

  it("streams sentence by sentence: audio of sentence 1 reaches the device while sentence 2 is still synthesizing", async () => {
    const d = await dev();
    await d.say("讲个故事");
    const req = await waitHook(d);
    await http.reply(req.body.reply.url, { text: "第一句话在这里。[tts-slow]第二句话稍后才到。" });
    await waitFor(() => d.audioStreams()[0]?.frames.length, 3000);
    const early = d.audioStreams()[0];
    expect(early.end).toBeUndefined(); // still open
    expect(early.bytes).toBeGreaterThan(0);
    const before = early.bytes;
    await d.waitForState("idle", 6000);
    const done = d.audioStreams()[0];
    expect(done.end.reason).toBe("complete");
    expect(done.bytes).toBeGreaterThan(before);
    expect(d.audioStreams()).toHaveLength(1); // one continuous stream, not one per sentence
  });
});

describe("interruption", () => {
  const LONG = "这是一段很长的回答，需要播放好几秒钟。我们继续往下说，直到被用户打断为止。再多说几句话，让音频足够长。最后一句话在这里结束。";

  it("a new speech_start while the reply is playing aborts the stream (audio.end aborted) and starts a new turn", async () => {
    const d = await dev();
    await d.say("先说点什么");
    const req = await waitHook(d);
    await http.reply(req.body.reply.url, { text: LONG });
    await waitFor(() => d.audioStreams()[0]?.frames.length, 3000);

    d.speechStart();
    await waitFor(() => d.audioStreams()[0]?.end, 2000);
    const a = d.audioStreams()[0];
    expect(a.end.reason).toBe("aborted");
    expect(a.frames.at(-1)!.last).not.toBe(true);
    const bytesAtAbort = a.bytes;
    await sleep(300);
    expect(d.audioStreams()[0].bytes).toBe(bytesAtAbort); // nothing more after the abort
    expect(d.turnStates()).toContain("idle:barge_in");
    expect(d.turnStates().at(-1)).toBe("listening");
    // the new turn works end to end
    const id = d.uplinkBegin();
    d.uplinkFrame(id, 0, "新的问题", true);
    d.uplinkEnd(id, { total_chunks: 1 });
    d.speechEnd();
    await waitHook(d, 1);
    expect(hookFor(d, 1).body.message).toBe("新的问题");
  });

  it("MCP stop_audio and emergency_stop cut the reply immediately", async () => {
    for (const tool of ["stop_audio", "emergency_stop"]) {
      const d = await dev();
      await d.say("说话");
      const req = await waitHook(d);
      await http.reply(req.body.reply.url, { text: LONG });
      await waitFor(() => d.audioStreams()[0]?.frames.length, 3000);
      const r = await mcp.call(tool, { device_id: d.deviceId });
      expect(r.isError).toBe(false);
      await waitFor(() => d.audioStreams()[0]?.end, 2000);
      expect(d.audioStreams()[0].end.reason).toBe("aborted");
      await d.waitForState("idle");
      expect(d.turnStates().at(-1)).toMatch(/^idle:/);
    }
  });

  it("interrupting while transcribing cancels ASR: no final transcript, nothing forwarded, nothing spoken", async () => {
    const d = await dev();
    await d.say("[asr-slow]这句话转录很慢");
    await d.waitForState("transcribing");
    d.speechStart(); // user starts talking again
    await d.waitForState("listening");
    expect(d.turnStates()).toEqual(["listening", "transcribing", "idle:barge_in", "listening"]);
    await sleep(1800); // longer than the mock's slow ASR
    expect(d.transcripts(true)).toHaveLength(0);
    expect(hookFor(d)).toBeUndefined();
    expect(d.audioStreams()).toHaveLength(0);
  });

  it("a reply that arrives after its turn was interrupted is dropped (stale generation)", async () => {
    const d = await dev();
    await d.say("第一个问题");
    const first = await waitHook(d);
    await d.waitForState("thinking");
    await d.say("第二个问题"); // barge-in during thinking
    const second = await waitHook(d, 1);
    expect(second.body.device.turn_id).not.toBe(first.body.device.turn_id);

    const stale = await http.reply(first.body.reply.url, { text: "这是过期的回答。" });
    expect(stale.status).toBe(200);
    expect(stale.data.dropped).toBe("stale_turn");
    await sleep(300);
    expect(d.audioStreams()).toHaveLength(0);
    expect(d.notifications("turn.reply")).toHaveLength(0);

    await http.reply(second.body.reply.url, { text: "这是当前的回答。" });
    await d.waitForState("idle");
    expect(d.audioStreams()).toHaveLength(1);
    expect(d.notifications("turn.reply")[0].params.text).toBe("这是当前的回答。");
  });

  it("barge-in during the playback tail (all audio sent, device still draining) ends the turn without a stream abort", async () => {
    const d = await dev({ playbackEndDelayMs: 5000 });
    await d.say("短问题");
    const req = await waitHook(d);
    await http.reply(req.body.reply.url, { text: "好的。" });
    await waitFor(() => d.audioStreams()[0]?.end, 3000);
    expect(d.turnStates().at(-1)).toBe("speaking");
    d.speechStart();
    await d.waitForState("listening");
    expect(d.audioStreams()[0].end.reason).toBe("complete");
    expect(d.turnStates()).toContain("idle:barge_in");
  });
});

describe("uplink limits and failures", () => {
  it("idle uplink (frames stop, no audio.end) times out", async () => {
    const d = await dev();
    d.speechStart();
    const id = d.uplinkBegin();
    d.uplinkFrame(id, 0, "只说了一半");
    await d.waitForState("idle", 3000);
    expect(d.turnStates().at(-1)).toBe("idle:timeout");
    expect(d.notifications("stream.error")[0].params).toMatchObject({ stream_id: id, direction: "up", reason: "timeout" });
    expect(hookFor(d)).toBeUndefined();
  });

  it("an utterance over the byte limit is rejected (too_large) and never forwarded", async () => {
    const d = await dev();
    d.speechStart();
    const id = d.uplinkBegin();
    const big = new Uint8Array(12000).fill(0x61);
    for (let i = 0; i < 4; i++) d.uplinkFrame(id, i, big);
    await d.waitForState("idle", 3000);
    expect(d.notifications("stream.error")[0].params.reason).toMatch(/too_large|too_long/);
    expect(d.turnStates().at(-1)).toMatch(/^idle:too_/);
    await sleep(200);
    expect(hookFor(d)).toBeUndefined();
  });

  it("utterance exactly at maxBytes is accepted, ends normally, and is transcribed", async () => {
    const d = await dev();
    d.speechStart();
    const id = d.uplinkBegin();
    // UPLINK_MAX_MS=1000 -> 32000 B. Send exactly 10 x 3200 B frames.
    const chunk = new Uint8Array(3200);
    chunk.set(new TextEncoder().encode("exact-limit-ok".padEnd(32, " ")));
    for (let i = 0; i < 10; i++) d.uplinkFrame(id, i, chunk);
    d.uplinkEnd(id, { total_chunks: 10, total_bytes: 32000 });
    d.speechEnd();
    await d.waitForState("thinking", 5000);
    expect(d.notifications("stream.error")).toHaveLength(0);
    const final = d.transcripts(true)[0];
    expect(final).toBeTruthy();
    expect(final.text.length).toBeGreaterThan(0);
  });

  it("declared total_bytes over the limit fails at audio.begin; unsupported format and a seq gap are rejected", async () => {
    const d = await dev();
    d.speechStart();
    d.uplinkBegin({ total_bytes: 999999 });
    await d.waitForState("idle");
    expect(d.notifications("stream.error")[0].params.reason).toBe("too_large");

    const d2 = await dev();
    d2.speechStart();
    d2.uplinkBegin({ format: "opus", sample_rate: 16000 });
    await d2.waitForState("idle");
    expect(d2.notifications("stream.error")[0].params.reason).toBe("unsupported_format");

    const d3 = await dev();
    d3.speechStart();
    const id = d3.uplinkBegin();
    d3.uplinkFrame(id, 0, "ab");
    d3.uplinkFrame(id, 2, "cd");
    await d3.waitForState("idle");
    expect(d3.notifications("stream.error")[0].params.reason).toBe("seq_gap");
  });

  it("audio.end without any frames is empty_audio", async () => {
    const d = await dev();
    d.speechStart();
    const id = d.uplinkBegin();
    d.uplinkEnd(id, { total_chunks: 0 });
    await d.waitForState("idle");
    expect(d.turnStates().at(-1)).toMatch(/^idle:(empty_audio|no_audio)/);
  });

  it("ASR failure / empty transcript end the turn with a reason and forward nothing", async () => {
    const d = await dev();
    await d.say("[asr-fail]坏了");
    await d.waitForState("idle");
    expect(d.turnStates().at(-1)).toBe("idle:asr_failed");
    const e = await dev();
    await e.say("[asr-empty]");
    await e.waitForState("idle");
    expect(e.turnStates().at(-1)).toBe("idle:empty_transcript");
    expect(hookFor(d)).toBeUndefined();
    expect(hookFor(e)).toBeUndefined();
  });

  it("agent that never replies: idle:agent_timeout; webhook refusing: idle:agent_unavailable; TTS failure: idle:tts_failed", async () => {
    const a = await dev();
    await a.say("没人回答");
    await waitHook(a);
    await a.waitForState("idle", 5000);
    expect(a.turnStates().at(-1)).toBe("idle:agent_timeout");

    hook.statuses.push(500, 500, 500, 500);
    const b = await dev();
    await b.say("网关坏了");
    await b.waitForState("idle", 5000);
    expect(b.turnStates().at(-1)).toBe("idle:agent_unavailable");
    hook.statuses.length = 0;

    const c = await dev();
    await c.say("合成会失败");
    const req = await waitHook(c);
    await http.reply(req.body.reply.url, { text: "[tts-fail]这句话合成失败。" });
    await c.waitForState("idle");
    expect(c.turnStates().at(-1)).toBe("idle:tts_failed");
    expect(c.audioStreams().every((s) => s.end?.reason !== "complete")).toBe(true);
  });

  it("TTS failing mid-stream: abort immediately (audio.end aborted + idle:tts_failed)", async () => {
    const d = await dev();
    await d.say("中途失败");
    const req = await waitHook(d);
    await http.reply(req.body.reply.url, { text: "前面正常。[tts-midfail]这里坏掉了。" });
    await d.waitForState("idle");
    const s = d.audioStreams()[0];
    expect(s?.end?.reason).toBe("aborted");
    expect(d.turnStates().at(-1)).toBe("idle:tts_failed");
  });

  it("per-device turn rate limit", async () => {
    const d = await dev({}, did(), strict.base);
    for (let i = 0; i < 3; i++) {
      await d.say(`第${i}次`);
      await sleep(150);
    }
    await waitFor(() => d.turnStates().includes("idle:rate_limited") || undefined, 3000);
  });
});

describe("connection lifecycle", () => {
  it("turn state is reset on reconnect and the old turn's reply is dropped", async () => {
    const id = did();
    const d1 = await dev({}, id);
    await d1.say("会断线的问题");
    const req = await waitHook(d1);
    await d1.waitForState("thinking");
    d1.close();
    await d1.waitClosed();
    await sleep(100);

    const d2 = await dev({}, id);
    expect(d2.turnStates()).toEqual([]); // fresh session: idle
    const st = await mcp.call("get_status", { device_id: id });
    expect(st.isError).toBe(false);
    const late = await http.reply(req.body.reply.url, { text: "断线前的回答。" });
    expect(late.status).toBe(200);
    expect(late.data.dropped).toBe("stale_turn");
    await sleep(300);
    expect(d2.audioStreams()).toHaveLength(0);
    // and the new session can run a full turn
    await d2.say("重连后的问题");
    const req2 = await waitHook(d2, 1).catch(() => waitHook(d2, 0));
    await http.reply(req2.body.reply.url, { text: "重连后正常。" });
    await d2.waitForState("idle");
    expect(d2.audioStreams()[0].end.reason).toBe("complete");
  });

  it("MCP speak while a voice turn is speaking is refused (busy); after the turn it works", async () => {
    const d = await dev({ playbackEndDelayMs: 1500 });
    await d.say("占线测试");
    const req = await waitHook(d);
    await http.reply(req.body.reply.url, { text: "好的。" });
    await d.waitForState("speaking");
    const busy = await mcp.call("speak", { device_id: d.deviceId, text: "插话" });
    expect(busy.envelope?.error?.code ?? (busy.isError ? "error" : "none")).not.toBe("none");
    await d.waitForState("idle", 4000);
    const ok = await mcp.call("speak", { device_id: d.deviceId, text: "现在可以了" });
    expect(ok.isError).toBe(false);
  });
});
