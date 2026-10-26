import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { sleep, startWorker, waitFor, type Worker } from "./harness";
import { MockDevice, type MockOptions } from "./mock-device";
import { mcpClient } from "./mcp-client";
import { FRAME_DOWNLINK_AUDIO, PING_TEXT } from "../src/device/protocol";

// Real workerd (wrangler dev) + a WebSocket mock device speaking grokchan-rpc/1.
const VARS = { STACKCHAN_ENABLED: "true", TTS_PROVIDER: "mock", DEVICE_CMD_TIMEOUT_MS: "400", HELLO_TIMEOUT_MS: "1500", DEVICE_RATE_LIMIT_PER_SEC: "1000" };

let w: Worker; // main worker
let strict: Worker; // low rate limit + slow audio pacing
let off: Worker; // STACKCHAN_ENABLED unset
let mcp: ReturnType<typeof mcpClient>;
let smcp: ReturnType<typeof mcpClient>;
const devices: MockDevice[] = [];
let n = 0;

/** Raw WebSocket upgrade attempt (fetch() forbids the Upgrade header): resolves with the HTTP status. */
function upgradeStatus(base: string, path: string, upgrade = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: upgrade ? { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } : {} });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
const did = (p = "mock") => `${p}_${++n}_${Math.random().toString(36).slice(2, 7)}`;

async function dev(base: string, opts: MockOptions = {}, id = did()): Promise<MockDevice> {
  const d = new MockDevice(base, id, opts);
  devices.push(d);
  await d.start();
  return d;
}

beforeAll(async () => {
  [w, strict, off] = await Promise.all([
    startWorker(VARS),
    startWorker({ ...VARS, DEVICE_RATE_LIMIT_PER_SEC: "3", AUDIO_CHUNK_DELAY_MS: "120" }),
    startWorker({}),
  ]);
  mcp = mcpClient(w.base);
  smcp = mcpClient(strict.base);
});
afterAll(async () => {
  for (const d of devices) try { d.close(); } catch {}
  await Promise.all([w?.stop(), strict?.stop(), off?.stop()]);
});

describe("gating", () => {
  it("/mcp and /ws/device are 404 unless STACKCHAN_ENABLED=true (no auth yet)", async () => {
    expect((await mcpClient(off.base).rpc("ping")).status).toBe(404);
    expect(await upgradeStatus(off.base, "/ws/device?device_id=x")).toBe(404);
  });
  it("existing chat API still works next to the device endpoints", async () => {
    const r = await fetch(w.base + "/api/health");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).ok).toBe(true);
    expect((await fetch(w.base + "/")).status).toBe(200);
  });
});

describe("MCP over HTTP (real worker)", () => {
  it("initialize + tools/list + notification", async () => {
    const init = await mcp.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.json.result.serverInfo.name).toBe("grokchan-bridge");
    expect((await mcp.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await mcp.rpc("tools/list");
    expect(list.json.result.tools).toHaveLength(11);
  });
  it("GET /mcp is 405 and a foreign Origin is 403", async () => {
    expect((await fetch(w.base + "/mcp")).status).toBe(405);
    expect((await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("with no device ever connected: list_devices is empty and tools say device_not_found", async () => {
    // must run before any mock device connects to this worker
    const l = await mcp.call("list_devices");
    expect(l.envelope.result.devices).toEqual([]);
    expect((await mcp.call("move_head", { pan: 1 })).envelope.error.code).toBe("device_not_found");
    expect((await mcp.call("move_head", { pan: 1, device_id: "ghost" })).envelope.error.code).toBe("device_not_found");
  });
  it("a single device is the default target (device_id optional)", async () => {
    const solo = await startWorker(VARS);
    try {
      const d = await dev(solo.base);
      const c = mcpClient(solo.base);
      const r = await c.call("set_expression", { expression: "happy" });
      expect(r.envelope).toMatchObject({ ok: true, device_id: d.deviceId });
      await dev(solo.base); // second device -> ambiguous
      const amb = await c.call("set_expression", { expression: "happy" });
      expect(amb.envelope.error.code).toBe("device_required");
    } finally {
      await solo.stop();
    }
  });
});

describe("device WebSocket handshake (JSON-RPC session.hello)", () => {
  it("hello request returns session config; device shows online with metadata", async () => {
    const d = await dev(w.base);
    expect(d.helloResult).toMatchObject({ heartbeat_s: expect.any(Number), audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1, chunk_bytes: 4096 } });
    expect(d.helloResult.session_id).toMatch(/^s_/);
    const l = await mcp.call("list_devices");
    const me = l.envelope.result.devices.find((x: any) => x.device_id === d.deviceId);
    expect(me).toMatchObject({ online: true, fw_version: "0.1.0-mock", hw: "m5stack-stackchan", caps: ["head", "led", "display", "speaker"] });
  });
  it("rejects bad device ids on the HTTP route", async () => {
    expect(await upgradeStatus(w.base, "/ws/device?device_id=bad%20id!")).toBe(400);
    expect(await upgradeStatus(w.base, "/ws/device")).toBe(400);
    expect(await upgradeStatus(w.base, "/ws/device?device_id=ok_id", false)).toBe(426);
  });
  it("unsupported protocol / wrong device id in hello -> error response and close 4009", async () => {
    const d = new MockDevice(w.base, did());
    devices.push(d);
    await d.connect();
    const r = await d.request("session.hello", { ...d.helloParams(), protocol: "other/9" });
    expect(r.error.code).toBe(-32602);
    expect((await d.waitClosed()).code).toBe(4009);
    const d2 = new MockDevice(w.base, did());
    devices.push(d2);
    await d2.connect();
    const r2 = await d2.request("session.hello", { ...d2.helloParams(), device_id: "somebody_else" });
    expect(r2.error.code).toBe(-32602);
  });
  it("no hello within HELLO_TIMEOUT_MS -> closed with 4001; other messages before hello are ignored", async () => {
    const d = new MockDevice(w.base, did());
    devices.push(d);
    await d.connect();
    d.notify("state.update", { battery: { percent: 1 } });
    const t0 = Date.now();
    const c = await d.waitClosed();
    expect(c.code).toBe(4001);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect((await mcp.call("list_devices")).envelope.result.devices.some((x: any) => x.device_id === d.deviceId)).toBe(false);
  });
  it("malformed JSON gets -32700; unknown device->bridge method gets -32601; ping/pong auto-response", async () => {
    const d = await dev(w.base);
    d.send("{not json");
    const perr = await waitFor(() => d.log.find((e) => e.kind === "response" && e.msg.error?.code === -32700));
    expect(perr).toBeTruthy();
    const r = await d.request("device.nonsense", {});
    expect(r.error.code).toBe(-32601);
    d.send(PING_TEXT); // answered by the runtime's auto-response without waking the DO
    await waitFor(() => d.notifications("pong")[0]);
  });
  it("a second connection with the same id replaces the first (4000)", async () => {
    const id = did();
    const a = await dev(w.base, {}, id);
    const b = await dev(w.base, {}, id);
    expect((await a.waitClosed()).code).toBe(4000);
    const r = await mcp.call("set_expression", { device_id: id, expression: "happy" });
    expect(r.envelope.ok).toBe(true);
    expect(a.requests("device.set_expression")).toHaveLength(0);
    expect(b.requests("device.set_expression")).toHaveLength(1);
  });
});

describe("tool -> device JSON-RPC mapping (every M1 tool)", () => {
  let d: MockDevice;
  beforeAll(async () => {
    d = await dev(w.base);
  });
  const run = (name: string, args: Record<string, unknown> = {}) => mcp.call(name, { device_id: d.deviceId, ...args });
  const last = (method: string) => d.requests(method).at(-1);

  it("get_device_status: cached snapshot from state.update; fresh=true asks the device", async () => {
    d.notify("state.update", { battery: { percent: 55, charging: true }, volume: 33, pose: { pan: 5, tilt: 6 }, expression: "happy", evil_extra: "x".repeat(10) });
    await sleep(150);
    const s = await run("get_device_status");
    expect(s.envelope.result).toMatchObject({ online: true, battery: { percent: 55, charging: true }, volume: 33, pose: { pan: 5, tilt: 6 }, caps: ["head", "led", "display", "speaker"], limits: { pan: [-90, 90] } });
    expect(s.envelope.result.evil_extra).toBeUndefined();
    expect(d.requests("device.get_status")).toHaveLength(0);
    const f = await run("get_device_status", { fresh: true });
    expect(d.requests("device.get_status")).toHaveLength(1);
    expect(f.envelope.result.battery.percent).toBe(87);
  });

  it("move_head", async () => {
    const r = await run("move_head", { pan: 30, tilt: 10, speed: 300 });
    const m = last("device.move_head");
    expect(m.params).toMatchObject({ pan: 30, tilt: 10, speed: 300, relative: false, wait: "accepted" });
    expect(m.params._meta).toMatchObject({ ttl_ms: expect.any(Number), seq: expect.any(Number) });
    expect(m.id).toMatch(/^c_/);
    expect(r.envelope).toMatchObject({ ok: true, status: "accepted", command_id: m.id, result: { pan: 30, tilt: 10, clamped: false } });
  });
  it("reset_pose", async () => {
    const r = await run("reset_pose");
    expect(last("device.reset_pose").params).toMatchObject({ reset_face: true });
    expect(r.envelope.result).toEqual({ pan: 0, tilt: 0 });
  });
  it("set_expression", async () => {
    const r = await run("set_expression", { expression: "surprised", duration_ms: 1500, revert_to: "neutral" });
    expect(last("device.set_expression").params).toMatchObject({ expression: "surprised", duration_ms: 1500, revert_to: "neutral" });
    expect(r.envelope.result).toEqual({ expression: "surprised", applied: true });
  });
  it("show_text", async () => {
    const r = await run("show_text", { text: "Hello 你好", duration_ms: 2000 });
    expect(last("device.show_text").params).toMatchObject({ text: "Hello 你好", duration_ms: 2000, position: "bubble", clear: false });
    expect(r.envelope.result).toEqual({ shown: true, truncated: false });
  });
  it("set_led", async () => {
    const r = await run("set_led", { color: "#ff0000", mode: "blink", brightness: 80 });
    expect(last("device.set_led").params).toMatchObject({ r: 255, g: 0, b: 0, side: "both", mode: "blink", brightness: 80 });
    expect(r.envelope.result.applied_rgb).toEqual({ r: 168, g: 0, b: 0 });
  });
  it("set_volume (capped at 70)", async () => {
    const r = await run("set_volume", { volume: 100, persist: true });
    expect(last("device.set_volume").params).toMatchObject({ volume: 70, persist: true });
    expect(r.envelope.result).toMatchObject({ volume: 70, muted: false, clamped: true });
  });
  it("stop_audio", async () => {
    const r = await run("stop_audio", { stream_id: 9 });
    expect(last("device.stop_audio").params).toMatchObject({ stream_id: 9, clear_queue: true });
    expect(r.envelope.result).toEqual({ stopped: [9], cleared: 0 });
  });
  it("emergency_stop", async () => {
    const r = await run("emergency_stop");
    expect(last("device.emergency_stop").params._meta.ttl_ms).toBeLessThanOrEqual(2000);
    expect(r.envelope.result).toEqual({ motion_halted: true, audio_stopped: true });
  });
  it("speak maps to device.speak with the text and expression", async () => {
    const r = await run("speak", { text: "你好，我是小Grok", expression: "happy", volume: 90 });
    expect(last("device.speak").params).toMatchObject({ text: "你好，我是小Grok", expression: "happy", volume: 70, interrupt: false });
    expect(r.envelope.ok).toBe(true);
  });
  it("parameter limits are enforced before anything reaches the device", async () => {
    const before = d.requests().length;
    const bad: [string, Record<string, unknown>][] = [
      ["set_led", { color: { r: 300, g: 0, b: 0 } }],
      ["set_led", { color: "#fff" }],
      ["speak", { text: "" }],
      ["speak", { text: "a".repeat(501) }],
      ["show_text", { text: "x".repeat(201) }],
      ["set_volume", { volume: 101 }],
      ["move_head", {}],
    ];
    for (const [name, args] of bad) expect((await run(name, args)).envelope.error.code, name).toBe("invalid_args");
    expect(d.requests().length).toBe(before);
    const c = await run("move_head", { pan: 500, tilt: -500 });
    expect(last("device.move_head").params).toMatchObject({ pan: 90, tilt: 0 });
    expect(c.envelope.result.clamped).toBe(true);
  });
});

describe("failure modes", () => {
  it("device offline: disconnect -> device_offline with last_seen; list shows online=false; reconnect recovers", async () => {
    const d = await dev(w.base);
    d.close();
    await sleep(300);
    const r = await mcp.call("move_head", { device_id: d.deviceId, pan: 10 });
    expect(r.isError).toBe(true);
    expect(r.envelope.error).toMatchObject({ code: "device_offline", retry_after_ms: expect.any(Number) });
    const l = (await mcp.call("list_devices")).envelope.result.devices.find((x: any) => x.device_id === d.deviceId);
    expect(l.online).toBe(false);
    expect(typeof l.last_seen).toBe("string");
    expect((await mcp.call("speak", { device_id: d.deviceId, text: "hi" })).envelope.error.code).toBe("device_offline");
    expect((await mcp.call("emergency_stop", { device_id: d.deviceId })).envelope.error.code).toBe("device_offline");
    const st = await mcp.call("get_device_status", { device_id: d.deviceId });
    expect(st.envelope.result.online).toBe(false);
    expect((await mcp.call("get_device_status", { device_id: d.deviceId, fresh: true })).envelope.error.code).toBe("device_offline");
    const d2 = await dev(w.base, {}, d.deviceId);
    expect((await mcp.call("move_head", { device_id: d.deviceId, pan: 10 })).envelope.ok).toBe(true);
    expect(d2.requests("device.move_head")).toHaveLength(1);
  });

  it("command timeout: device never answers -> timeout error, and the command is NOT resent", async () => {
    const d = await dev(w.base, { ignore: new Set(["device.move_head"]) });
    const t0 = Date.now();
    const r = await mcp.call("move_head", { device_id: d.deviceId, pan: 10 });
    const dt = Date.now() - t0;
    expect(r.envelope.error.code).toBe("timeout");
    expect(dt).toBeGreaterThanOrEqual(350);
    expect(dt).toBeLessThan(3000);
    await sleep(800);
    expect(d.requests("device.move_head")).toHaveLength(1);
  });

  it("wait=done uses the longer timeout_ms and reports status done", async () => {
    const d = await dev(w.base, { delay: { "device.move_head": 900 } });
    const quick = await mcp.call("move_head", { device_id: d.deviceId, pan: 10 });
    expect(quick.envelope.error.code).toBe("timeout");
    const slow = await mcp.call("move_head", { device_id: d.deviceId, pan: 20, wait: "done", timeout_ms: 5000 });
    expect(slow.envelope).toMatchObject({ ok: true, status: "done" });
  });

  it("disconnect while a command is pending fails fast with device_offline (not after the long timeout)", async () => {
    const d = await dev(w.base, { ignore: new Set(["device.move_head"]) });
    const p = mcp.call("move_head", { device_id: d.deviceId, pan: 10, wait: "done", timeout_ms: 20000 });
    await d.waitForRequest("device.move_head");
    const t0 = Date.now();
    d.close();
    const r = await p;
    expect(r.envelope.error.code).toBe("device_offline");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("device JSON-RPC errors are passed through with the mapped MCP code and the raw device code", async () => {
    const cases: [number, string][] = [[-32000, "busy"], [-32001, "rejected_limit"], [-32002, "low_battery"], [-32003, "timeout"], [-32009, "device_fault"],[-32011, "busy"],[-32012, "stream_error"],[-32007, "rate_limited"],[-32005, "privacy_blocked"],[-32004, "unauthorized"],[-32006, "unsupported"],[-32010, "payload_too_large"], [-32602, "invalid_args"]];
    for (const [code, expected] of cases) {
      const d = await dev(w.base, { errors: { "device.move_head": { code, message: "boom", data: { retry_after_ms: 500, hint: "x" } } } });
      const r = await mcp.call("move_head", { device_id: d.deviceId, pan: 10 });
      expect(r.isError).toBe(true);
      expect(r.envelope.error, String(code)).toMatchObject({ code: expected, message: "boom", data: { device_code: code, hint: "x" }, retry_after_ms: 500 });
    }
    const d = await dev(w.base, { errors: { "device.move_head": { code: -1234, message: "weird" } } });
    expect((await mcp.call("move_head", { device_id: d.deviceId, pan: 10 })).envelope.error).toMatchObject({ code: "device_error", data: { device_code: -1234 } });
  });

  it("dedup: same request_id executes once; a new id executes again; failures are not cached", async () => {
    const d = await dev(w.base);
    const a = await mcp.call("set_led", { device_id: d.deviceId, color: "#00ff00", request_id: "rq-1" });
    const b = await mcp.call("set_led", { device_id: d.deviceId, color: "#00ff00", request_id: "rq-1" });
    expect(a.envelope.ok && b.envelope.ok).toBe(true);
    expect(a.envelope.deduplicated).toBeUndefined();
    expect(b.envelope.deduplicated).toBe(true);
    expect(b.envelope.command_id).toBe(a.envelope.command_id);
    expect(d.requests("device.set_led")).toHaveLength(1);
    expect(d.requests("device.set_led")[0].params._meta.idempotency_key).toBe("rq-1");
    await mcp.call("set_led", { device_id: d.deviceId, color: "#00ff00", request_id: "rq-2" });
    expect(d.requests("device.set_led")).toHaveLength(2);
    // same request_id on a different tool is a different command
    await mcp.call("show_text", { device_id: d.deviceId, text: "x", request_id: "rq-1" });
    expect(d.requests("device.show_text")).toHaveLength(1);
    // concurrent duplicates share one execution
    const slow = await dev(w.base, { delay: { "device.set_expression": 150 } });
    const [x, y] = await Promise.all([1, 2].map(() => mcp.call("set_expression", { device_id: slow.deviceId, expression: "happy", request_id: "same" })));
    expect(x.envelope.ok && y.envelope.ok).toBe(true);
    expect(slow.requests("device.set_expression")).toHaveLength(1);
    // errors are not cached: after a device error the same request_id is attempted again
    const flaky = await dev(w.base, { errors: { "device.reset_pose": { code: -32000, message: "busy" } } });
    await mcp.call("reset_pose", { device_id: flaky.deviceId, request_id: "e1" });
    await mcp.call("reset_pose", { device_id: flaky.deviceId, request_id: "e1" });
    expect(flaky.requests("device.reset_pose")).toHaveLength(2);
  });

  it("status/state survive an idle period (DO hibernation) and the socket stays usable", async () => {
    const d = await dev(w.base);
    d.notify("state.update", { volume: 11 });
    await sleep(12_000);
    const r = await mcp.call("get_device_status", { device_id: d.deviceId });
    expect(r.envelope.result).toMatchObject({ online: true, volume: 11 });
    expect((await mcp.call("move_head", { device_id: d.deviceId, pan: 5 })).envelope.ok).toBe(true);
  }, 30_000);
});

describe("speak: TTS -> device.speak -> audio.begin -> binary frames -> audio.end", () => {
  it("message order, frame headers and totals", async () => {
    const d = await dev(w.base);
    const text = "x".repeat(60); // 60 * 40 ms = 2.4 s of 16 kHz PCM = 76800 bytes = 19 chunks of 4096
    const r = await mcp.call("speak", { device_id: d.deviceId, text, wait: "done" });
    expect(r.envelope).toMatchObject({ ok: true, status: "done", result: { playback: "done", chunks: 19, bytes: 76800, format: "pcm_s16le", tts: { provider: "mock" } } });
    const trace = d.trace().filter((x) => x !== "session.hello");
    expect(trace[0]).toBe("device.speak");
    expect(trace[1]).toBe("audio.begin");
    const bins = trace.filter((x) => x.startsWith("bin:"));
    expect(bins).toHaveLength(19);
    expect(trace.slice(2, 2 + 19)).toEqual(bins); // all frames sit between begin and end
    expect(trace[2 + 19]).toBe("audio.end");
    const frames = d.frames();
    const speakReq = d.requests("device.speak")[0];
    const begin = d.notifications("audio.begin")[0].params;
    const end = d.notifications("audio.end")[0].params;
    expect(begin).toMatchObject({ stream_id: speakReq.params.stream_id, format: "pcm_s16le", sample_rate: 16000, channels: 1, chunk_bytes: 4096, total_bytes: 76800, total_chunks: 19 });
    expect(end).toEqual({ stream_id: begin.stream_id, total_chunks: 19, total_bytes: 76800, reason: "complete" });
    expect(frames.map((f) => f.seq)).toEqual([...Array(19).keys()]);
    expect(frames.every((f) => f.type === FRAME_DOWNLINK_AUDIO && f.streamId === begin.stream_id)).toBe(true);
    expect(frames.map((f) => f.last)).toEqual([...Array(18).fill(false), true]);
    expect(frames.reduce((s, f) => s + f.payload.byteLength, 0)).toBe(76800);
    expect(frames[0]!.payload.byteLength).toBe(4096);
    expect(frames[18]!.payload.byteLength).toBe(76800 - 18 * 4096);
    // playback.state flows back after audio.end
    expect(d.trace().at(-1)).toBe("audio.end");
  });

  it("wait=queued returns after delivery, wait=started when playback starts", async () => {
    const d = await dev(w.base);
    const q = await mcp.call("speak", { device_id: d.deviceId, text: "hello", wait: "queued" });
    expect(q.envelope).toMatchObject({ ok: true, status: "accepted", result: { playback: "queued" } });
    const s = await mcp.call("speak", { device_id: d.deviceId, text: "hello again" });
    expect(s.envelope).toMatchObject({ ok: true, result: { playback: "started" } });
  });

  it("wait=started times out when the device never reports playback", async () => {
    const d = await dev(w.base, { playback: false });
    const r = await mcp.call("speak", { device_id: d.deviceId, text: "hello", timeout_ms: 1000 });
    expect(r.envelope.error).toMatchObject({ code: "timeout" });
    expect(d.frames()).toHaveLength(2); // audio itself was delivered (200 ms = 2 chunks)
  });

  it("device-reported stream error surfaces as stream_error", async () => {
    const d = await dev(w.base, { playback: false });
    const p = mcp.call("speak", { device_id: d.deviceId, text: "hello", wait: "done" });
    const begin = await waitFor(() => d.notifications("audio.begin")[0]);
    d.notify("playback.state", { stream_id: begin.params.stream_id, state: "error", message: "decoder underrun" });
    const r = await p;
    expect(r.envelope.error).toMatchObject({ code: "stream_error", message: "decoder underrun" });
  });

  it("TTS failure -> tts_failed and the device never receives device.speak", async () => {
    const d = await dev(w.base);
    const r = await mcp.call("speak", { device_id: d.deviceId, text: "boom [tts-fail]" });
    expect(r.envelope.error.code).toBe("tts_failed");
    expect(d.requests("device.speak")).toHaveLength(0);
    expect(d.frames()).toHaveLength(0);
  });

  it("device rejects device.speak -> error passthrough and no audio is sent", async () => {
    const d = await dev(w.base, { errors: { "device.speak": { code: -32010, message: "too big" } } });
    const r = await mcp.call("speak", { device_id: d.deviceId, text: "hello" });
    expect(r.envelope.error).toMatchObject({ code: "payload_too_large", data: { device_code: -32010 } });
    expect(d.notifications("audio.begin")).toHaveLength(0);
    expect(d.frames()).toHaveLength(0);
  });

  it("speak dedup: same request_id plays once", async () => {
    const d = await dev(w.base);
    await mcp.call("speak", { device_id: d.deviceId, text: "once", request_id: "sp1", wait: "queued" });
    const b = await mcp.call("speak", { device_id: d.deviceId, text: "once", request_id: "sp1", wait: "queued" });
    expect(b.envelope.deduplicated).toBe(true);
    expect(d.requests("device.speak")).toHaveLength(1);
    expect(d.notifications("audio.begin")).toHaveLength(1);
  });

  it("two queued speaks play in order, one after the other", async () => {
    const d = await dev(w.base);
    const [a, b] = await Promise.all([mcp.call("speak", { device_id: d.deviceId, text: "first", wait: "done" }), (async () => { await sleep(30); return mcp.call("speak", { device_id: d.deviceId, text: "second", wait: "done" }); })()]);
    expect(a.envelope.ok && b.envelope.ok).toBe(true);
    const order = d.trace().filter((x) => x === "device.speak" || x === "audio.begin" || x === "audio.end");
    expect(order).toEqual(["device.speak", "audio.begin", "audio.end", "device.speak", "audio.begin", "audio.end"]);
    expect(d.requests("device.speak").map((r) => r.params.text)).toEqual(["first", "second"]);
  });
});

describe("emergency_stop priority and audio interruption", () => {
  it("emergency_stop reaches the device while a speak is still synthesizing; the speak ends as interrupted and no audio is sent", async () => {
    const d = await dev(w.base);
    const speak = mcp.call("speak", { device_id: d.deviceId, text: "long [tts-slow]", wait: "done" });
    await sleep(300); // TTS (1.5 s) is in flight
    const t0 = Date.now();
    const stop = await mcp.call("emergency_stop", { device_id: d.deviceId });
    expect(stop.envelope.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000); // did not wait for TTS
    const sp = await speak;
    expect(sp.envelope.error.code).toBe("interrupted");
    expect(d.requests("device.emergency_stop")).toHaveLength(1);
    expect(d.requests("device.speak")).toHaveLength(0);
    expect(d.frames()).toHaveLength(0);
  });

  it("emergency_stop mid-stream: frames stop, audio.end(aborted) is sent, speak -> interrupted", async () => {
    const d = await dev(strict.base, { playback: false });
    const text = "y".repeat(200); // 8 s of audio, 120 ms between chunks
    const speak = smcp.call("speak", { device_id: d.deviceId, text, wait: "done" });
    await waitFor(() => d.frames().length >= 2, 5000);
    const stop = await smcp.call("emergency_stop", { device_id: d.deviceId });
    expect(stop.envelope.ok).toBe(true);
    const sp = await speak;
    expect(sp.envelope.error.code).toBe("interrupted");
    const end = await waitFor(() => d.notifications("audio.end")[0], 3000);
    expect(end.params.reason).toBe("aborted");
    const count = d.frames().length;
    expect(count).toBeLessThan(63);
    await sleep(500);
    expect(d.frames().length).toBe(count); // nothing after audio.end
    // the emergency request was written before audio.end
    const t = d.trace();
    expect(t.indexOf("device.emergency_stop")).toBeLessThan(t.indexOf("audio.end"));
  });

  it("stop_audio mid-stream aborts the stream too", async () => {
    const d = await dev(strict.base, { playback: false });
    const speak = smcp.call("speak", { device_id: d.deviceId, text: "z".repeat(200), wait: "done" });
    await waitFor(() => d.frames().length >= 2, 5000);
    const r = await smcp.call("stop_audio", { device_id: d.deviceId });
    expect(r.envelope.ok).toBe(true);
    expect((await speak).envelope.error.code).toBe("interrupted");
    expect((await waitFor(() => d.notifications("audio.end")[0], 3000)).params.reason).toBe("aborted");
  });

  it("speak with interrupt=true cuts the current speech", async () => {
    const d = await dev(strict.base, { playback: false });
    const first = smcp.call("speak", { device_id: d.deviceId, text: "a".repeat(200), wait: "done" });
    await waitFor(() => d.frames().length >= 2, 5000);
    const second = await smcp.call("speak", { device_id: d.deviceId, text: "short", interrupt: true, wait: "queued" });
    expect((await first).envelope.error.code).toBe("interrupted");
    expect(second.envelope.ok).toBe(true);
    expect(d.requests("device.speak").map((r) => r.params.text)).toEqual(["a".repeat(200), "short"]);
    expect(d.requests("device.speak")[1].params.interrupt).toBe(true);
  });

  it("rate limit saturates normal commands but emergency_stop always gets through", async () => {
    const d = await dev(strict.base);
    const burst = await Promise.all(Array.from({ length: 10 }, () => smcp.call("set_led", { device_id: d.deviceId, color: "#0000ff" })));
    const limited = burst.filter((r) => r.envelope.error?.code === "rate_limited");
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(limited[0]!.envelope.error.retry_after_ms).toBeGreaterThan(0);
    expect(d.requests("device.set_led").length).toBe(10 - limited.length);
    const stop = await smcp.call("emergency_stop", { device_id: d.deviceId });
    expect(stop.envelope.ok).toBe(true);
    expect(d.requests("device.emergency_stop")).toHaveLength(1);
  });
});
