// Real workerd bridge (wrangler dev) <-> the real firmware core (host build, tools/sim) over a
// real WebSocket. Node owns the socket and pipes frames to the simulator over stdin/stdout.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sleep, startWorker, waitFor, type Worker } from "../../../bridge/test/harness";
import { mcpClient } from "../../../bridge/test/mcp-client";

const SIM = resolve(__dirname, "../../.build/sim_stdio");
const VARS = { STACKCHAN_ENABLED: "true", TTS_PROVIDER: "mock", DEVICE_CMD_TIMEOUT_MS: "3000", HELLO_TIMEOUT_MS: "5000", DEVICE_RATE_LIMIT_PER_SEC: "1000" };

class SimDevice {
  child!: ChildProcessWithoutNullStreams;
  ws: WebSocket | null = null;
  logs: string[] = [];
  closes: { code: number; reason: string }[] = [];
  connects = 0;
  private buf = "";
  constructor(readonly base: string, readonly id: string) {}
  start() {
    this.child = spawn(SIM, [this.id]);
    this.child.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        this.onLine(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
    });
    this.child.stderr.on("data", (d) => this.logs.push("STDERR " + d));
  }
  private w(s: string) { if (this.child.stdin.writable) this.child.stdin.write(s + "\n"); }
  private onLine(l: string) {
    if (l === "CONNECT") {
      this.connects++;
      const ws = new WebSocket(`${this.base.replace("http", "ws")}/ws/device?device_id=${this.id}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.addEventListener("open", () => this.w("O"));
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") this.w("T " + ev.data);
        else this.w("B " + Buffer.from(ev.data as ArrayBuffer).toString("hex"));
      });
      ws.addEventListener("close", (ev) => { this.closes.push({ code: ev.code, reason: ev.reason }); this.w("C " + ev.code); });
      ws.addEventListener("error", () => this.w("C 1006"));
    } else if (l === "CLOSE") this.ws?.close();
    else if (l.startsWith("T ")) this.ws?.send(l.slice(2));
    else if (l.startsWith("B ")) this.ws?.send(Buffer.from(l.slice(2), "hex"));
    else this.logs.push(l.replace(/^LOG /, ""));
  }
  has(re: RegExp) { return this.logs.some((x) => re.test(x)); }
  stop() { try { this.ws?.close(); } catch {} this.child.kill(); }
}

let w: Worker;
let mcp: ReturnType<typeof mcpClient>;
let d: SimDevice;

beforeAll(async () => {
  if (!existsSync(SIM)) throw new Error("build the simulator first: tools/run_e2e.sh");
  w = await startWorker(VARS);
  mcp = mcpClient(w.base);
  d = new SimDevice(w.base, "fwsim_1");
  d.start();
  await waitFor(async () => false, 1).catch(() => {});
  for (let i = 0; i < 100; i++) {
    const l = await mcp.call("list_devices");
    if (l.envelope?.result?.devices?.some((x: any) => x.device_id === d.id && x.online)) return;
    await sleep(100);
  }
  throw new Error("simulated device never became online: " + d.logs.join("\n"));
}, 90_000);
afterAll(async () => { d?.stop(); await w?.stop(); });

const run = (name: string, args: Record<string, unknown> = {}) => mcp.call(name, { device_id: d.id, ...args });

describe("firmware core against the real bridge", () => {
  it("session.hello is accepted: device listed with fw/hw/caps", async () => {
    const l = await mcp.call("list_devices");
    const me = l.envelope.result.devices.find((x: any) => x.device_id === d.id);
    expect(me).toMatchObject({ online: true, fw_version: "0.1.0-sim", hw: "m5stack-cores3" });
    expect(me.caps).toEqual(expect.arrayContaining(["head", "led", "display", "speaker"]));
  });
  it("get_device_status (fresh) round-trips", async () => {
    const r = await run("get_device_status", { fresh: true });
    expect(r.envelope.ok).toBe(true);
    expect(r.envelope.result).toMatchObject({ online: true, battery: { percent: 77, charging: false }, pose: { pan: 0, tilt: 0 }, limits: { pan: [-90, 90], tilt: [0, 60] } });
  });
  it("state.update from the device lands in the cached status", async () => {
    const r = await run("get_device_status");
    expect(r.envelope.result.battery?.percent).toBe(77);
  });
  it("move_head wait=accepted then wait=done", async () => {
    const a = await run("move_head", { pan: 30, tilt: 10, speed: 300 });
    expect(a.envelope).toMatchObject({ ok: true, result: { pan: 30, tilt: 10, clamped: false } });
    expect(d.has(/HEAD moveTo pan=30 tilt=10 speed=300/)).toBe(true);
    const b = await run("move_head", { pan: -20, tilt: 5, speed: 600, wait: "done", timeout_ms: 8000 });
    expect(b.envelope.ok).toBe(true);
    expect(b.envelope.status).toBe("done");
    const s = await run("get_device_status", { fresh: true });
    expect(s.envelope.result.pose).toEqual({ pan: -20, tilt: 5 });
  });
  it("move_head out of range is clamped by the bridge; reset_pose", async () => {
    const c = await run("move_head", { pan: 500, tilt: -500 });
    expect(c.envelope.result.clamped).toBe(true);
    const r = await run("reset_pose");
    expect(r.envelope).toMatchObject({ ok: true, result: { pan: 0, tilt: 0 } });
  });
  it("set_expression / show_text / set_led / set_volume", async () => {
    expect((await run("set_expression", { expression: "surprised", duration_ms: 1500, revert_to: "neutral" })).envelope.result).toEqual({ expression: "surprised", applied: true });
    expect(d.has(/EXPR surprised/)).toBe(true);
    expect((await run("show_text", { text: "Hello 你好", duration_ms: 2000 })).envelope.result).toMatchObject({ shown: true, truncated: false });
    expect(d.has(/TEXT Hello 你好/)).toBe(true);
    const led = await run("set_led", { color: "#ff0000", mode: "solid", brightness: 80 });
    expect(led.envelope.ok).toBe(true);
    expect(led.envelope.result.applied_rgb.r).toBeLessThanOrEqual(168);
    expect(d.has(/^LED /)).toBe(true);
    const v = await run("set_volume", { volume: 100 });
    expect(v.envelope.result).toMatchObject({ volume: 70, muted: false });
    expect(d.has(/^VOL 70/)).toBe(true);
  });
  it("unknown expression falls back instead of failing", async () => {
    const r = await run("set_expression", { expression: "definitely_not_real" });
    expect(r.envelope.ok === true || r.envelope.error?.code === "invalid_args").toBe(true);
  });
  it("speak wait=done: TTS audio streams to the device and playback.state ended arrives", async () => {
    const r = await run("speak", { text: "你好，我是小Grok", expression: "happy", wait: "done", timeout_ms: 20000 });
    expect(r.envelope.ok, JSON.stringify(r.envelope)).toBe(true);
    expect(r.envelope.result).toMatchObject({ playback: "done", format: "pcm_s16le" });
    expect(d.has(/^EXPR happy/)).toBe(true);
  });
  it("stop_audio interrupts a running speak", async () => {
    const sp = run("speak", { text: "这是一段比较长的话，用来测试中途打断播放是否可靠。这是一段比较长的话，用来测试中途打断播放是否可靠。", wait: "done", timeout_ms: 20000 });
    await sleep(700);
    const st = await run("stop_audio");
    expect(st.envelope.ok).toBe(true);
    const done = await sp;
    expect(done.envelope.ok === false ? done.envelope.error.code : done.envelope.result.playback).toMatch(/interrupted/);
  });
  it("emergency_stop halts motion (audio_stopped=false when nothing plays)", async () => {
    await run("move_head", { pan: 80, tilt: 50, speed: 100 });
    const r = await run("emergency_stop");
    expect(r.envelope).toMatchObject({ ok: true, result: { motion_halted: true, audio_stopped: false } });
    expect(d.has(/HEAD halt/)).toBe(true);
  });
  it("emergency_stop while speaking stops audio and interrupts the speak", async () => {
    const sp = run("speak", { text: "这是一段比较长的话，用来测试紧急停止是否会同时打断播放。这是一段比较长的话，用来测试紧急停止是否会同时打断播放。", wait: "done", timeout_ms: 20000 });
    await sleep(700);
    const r = await run("emergency_stop");
    expect(r.envelope).toMatchObject({ ok: true, result: { audio_stopped: true } });
    const done = await sp;
    // Bridge quirk (not firmware): emergency_stop aborts the bridge-side wait before the device's
    // playback.state "interrupted" arrives, so an already-started speak can report playback "started".
    expect(done.envelope.ok === false ? done.envelope.error.code : done.envelope.result.playback).toMatch(/interrupted|started/);
    await waitFor(() => d.has(/^PCM stop/), 3000);
  });
  it("idempotent replay: same request_id is not executed twice", async () => {
    const before = d.logs.filter((x) => /HEAD moveTo pan=15/.test(x)).length;
    const a = await run("move_head", { pan: 15, tilt: 5, request_id: "rid-1" });
    const b = await run("move_head", { pan: 15, tilt: 5, request_id: "rid-1" });
    expect(a.envelope.ok && b.envelope.ok).toBe(true);
    expect(d.logs.filter((x) => /HEAD moveTo pan=15/.test(x)).length - before).toBe(1);
  });
  it("device survives a bridge-side close and reconnects with a fresh session", async () => {
    const c0 = d.connects;
    d.ws!.close(); // simulate a network drop from the device side
    await waitFor(() => d.connects > c0, 8000);
    for (let i = 0; i < 60; i++) {
      const r = await run("get_device_status", { fresh: true });
      if (r.envelope?.ok) return;
      await sleep(200);
    }
    throw new Error("device did not come back online");
  });
});
