import { beforeEach, describe, expect, it } from "vitest";
import { handleMcp, SUPPORTED_VERSIONS } from "../src/mcp/server";
import { buildTools, DEFAULT_LIMITS } from "../src/mcp/tools";
import type { DeviceCall, DeviceGateway, DeviceOutcome, DeviceSummary, SpeakCall } from "../src/device/gateway";

/** In-memory gateway: records what the MCP layer asks the device layer to do. */
class FakeGateway implements DeviceGateway {
  devices: DeviceSummary[] = [{ device_id: "sc1", online: true, last_seen: Date.now(), caps: ["head"] }];
  calls: { id: string; call: DeviceCall }[] = [];
  speaks: { id: string; call: SpeakCall }[] = [];
  statusCalls: { id: string; fresh: boolean }[] = [];
  next: ((call: DeviceCall) => DeviceOutcome | undefined) | null = null;
  async listDevices() {
    return this.devices;
  }
  async hasDevice(id: string) {
    return this.devices.some((d) => d.device_id === id);
  }
  private ok(id: string, result: Record<string, unknown> = {}): DeviceOutcome {
    return { ok: true, device_id: id, command_id: "c_1", status: "accepted", result, latency_ms: 3 };
  }
  async call(id: string, call: DeviceCall) {
    this.calls.push({ id, call });
    return this.next?.(call) ?? this.ok(id);
  }
  async speak(id: string, call: SpeakCall) {
    this.speaks.push({ id, call });
    return this.ok(id, { playback: "started", stream_id: 1 });
  }
  async status(id: string, fresh: boolean) {
    this.statusCalls.push({ id, fresh });
    return this.ok(id, { online: true, battery: { percent: 90 } });
  }
}

let gw: FakeGateway;
beforeEach(() => (gw = new FakeGateway()));

let rid = 0;
async function rpc(method: string, params?: unknown, init: RequestInit = {}, origin?: string) {
  const req = new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }), headers: { "content-type": "application/json" }, ...init });
  const res = await handleMcp(req, { gateway: gw }, origin);
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return { envelope: r.json.result.structuredContent as any, isError: r.json.result.isError as boolean, result: r.json.result };
}
const lastCall = () => gw.calls[gw.calls.length - 1]!;

describe("MCP protocol", () => {
  it("initialize negotiates version and advertises tools only", async () => {
    const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe("2025-03-26");
    expect(r.json.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.json.result.serverInfo.name).toBe("grokchan-bridge");
    expect(typeof r.json.result.instructions).toBe("string");
    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.json.result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
  });

  it("tools/list returns exactly the 11 M1 tools with object schemas", async () => {
    const r = await rpc("tools/list");
    const names = r.json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["emergency_stop", "get_device_status", "list_devices", "move_head", "reset_pose", "set_expression", "set_led", "set_volume", "show_text", "speak", "stop_audio"]);
    for (const t of r.json.result.tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(r.json.result.tools.find((t: any) => t.name === "get_device_status").annotations.readOnlyHint).toBe(true);
  });

  it("notifications get 202 with no body; ping works; unknown method and tool are JSON-RPC errors", async () => {
    const n = await handleMcp(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), { gateway: gw });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect((await rpc("ping")).json.result).toEqual({});
    expect((await rpc("resources/list")).json.error.code).toBe(-32601);
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).json.error.code).toBe(-32602);
    expect((await rpc("tools/call", { arguments: {} })).json.error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "list_devices", arguments: [] })).json.error.code).toBe(-32602);
  });

  it("rejects bad JSON (400/-32700), GET (405), oversized bodies (413) and foreign Origins (403)", async () => {
    const bad = await handleMcp(new Request("http://x/mcp", { method: "POST", body: "{nope" }), { gateway: gw });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    expect((await handleMcp(new Request("http://x/mcp", { method: "GET" }), { gateway: gw })).status).toBe(405);
    const big = await handleMcp(new Request("http://x/mcp", { method: "POST", body: "x".repeat(70_000) }), { gateway: gw });
    expect(big.status).toBe(413);
    const evil = await rpc("ping", undefined, { headers: { origin: "https://evil.example" } }, "https://bridge.example");
    expect(evil.status).toBe(403);
    const same = await rpc("ping", undefined, { headers: { origin: "https://bridge.example" } }, "https://bridge.example");
    expect(same.status).toBe(200);
  });

  it("handles JSON-RPC batches", async () => {
    const res = await handleMcp(new Request("http://x/mcp", { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) }), { gateway: gw });
    const j = (await res.json()) as any[];
    expect(j.map((x) => x.id)).toEqual([1, 2]);
  });

  it("tool results carry both text content and structuredContent, and isError mirrors ok", async () => {
    const good = await call("get_device_status");
    expect(good.isError).toBe(false);
    expect(JSON.parse(good.result.content[0].text)).toEqual(good.envelope);
    const bad = await call("set_led", { color: "red" });
    expect(bad.isError).toBe(true);
    expect(bad.envelope.error.code).toBe("invalid_args");
  });

  it("an exception in a tool becomes a generic internal_error without leaking details", async () => {
    const tools = buildTools();
    tools[0]!.run = async () => {
      throw new Error("secret stack detail");
    };
    const res = await handleMcp(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_devices" } }) }), { gateway: gw, tools });
    const j = (await res.json()) as any;
    expect(j.result.isError).toBe(true);
    expect(JSON.stringify(j)).not.toContain("secret stack detail");
  });
});

describe("device resolution", () => {
  it("uses the only device by default", async () => {
    await call("reset_pose");
    expect(lastCall().id).toBe("sc1");
  });
  it("no device registered -> device_not_found", async () => {
    gw.devices = [];
    expect((await call("reset_pose")).envelope.error.code).toBe("device_not_found");
  });
  it("several devices and no device_id -> device_required (lists ids)", async () => {
    gw.devices.push({ device_id: "sc2", online: false, last_seen: null, caps: [] });
    const e = (await call("reset_pose")).envelope;
    expect(e.error.code).toBe("device_required");
    expect(e.error.devices).toEqual(["sc1", "sc2"]);
    expect(gw.calls).toHaveLength(0);
  });
  it("unknown or malformed device_id", async () => {
    expect((await call("reset_pose", { device_id: "ghost" })).envelope.error.code).toBe("device_not_found");
    expect((await call("reset_pose", { device_id: "bad id!" })).envelope.error.code).toBe("invalid_args");
    expect(gw.calls).toHaveLength(0);
  });
  it("list_devices does not need a device and formats last_seen as ISO", async () => {
    gw.devices = [{ device_id: "sc1", online: false, last_seen: Date.parse("2026-01-02T03:04:05Z"), caps: ["head"], fw_version: "1.0" }];
    const e = (await call("list_devices")).envelope;
    expect(e.ok).toBe(true);
    expect(e.result.devices).toEqual([{ device_id: "sc1", online: false, last_seen: "2026-01-02T03:04:05.000Z", fw_version: "1.0", hw: null, caps: ["head"] }]);
  });
});

describe("tool -> device command mapping", () => {
  it("get_device_status -> gateway.status(fresh)", async () => {
    await call("get_device_status");
    await call("get_device_status", { fresh: true });
    expect(gw.statusCalls).toEqual([{ id: "sc1", fresh: false }, { id: "sc1", fresh: true }]);
    expect((await call("get_device_status", { fresh: "yes" })).envelope.error.code).toBe("invalid_args");
  });

  it("move_head -> device.move_head with defaults", async () => {
    const r = await call("move_head", { pan: 30, tilt: 10 });
    expect(lastCall().call).toMatchObject({ tool: "move_head", method: "device.move_head", params: { pan: 30, tilt: 10, speed: 150, relative: false, wait: "accepted" } });
    expect(r.envelope).toMatchObject({ ok: true, status: "accepted", result: { pan: 30, tilt: 10, clamped: false, requested: { pan: 30, tilt: 10 } } });
  });
  it("move_head only sends the axes given; wait=done uses timeout", async () => {
    await call("move_head", { tilt: 20, wait: "done", timeout_ms: 5000, speed: 400, request_id: "r1" });
    const c = lastCall().call;
    expect(c.params).toEqual({ tilt: 20, speed: 400, relative: false, wait: "done" });
    expect(c).toMatchObject({ wait: "done", timeout_ms: 5000, request_id: "r1" });
  });
  it("move_head clamps to the safe range and says so", async () => {
    const r = await call("move_head", { pan: 200, tilt: -20, speed: 5000 });
    expect(lastCall().call.params).toMatchObject({ pan: 90, tilt: 0, speed: 1000 });
    expect(r.envelope.result).toMatchObject({ clamped: true, requested: { pan: 200, tilt: -20 } });
    await call("move_head", { pan: -91, tilt: 61 });
    expect(lastCall().call.params).toMatchObject({ pan: -90, tilt: 60 });
  });
  it("move_head respects configurable limits and relative moves", async () => {
    const res = await handleMcp(new Request("http://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "move_head", arguments: { pan: 80 } } }) }), { gateway: gw, limits: { ...DEFAULT_LIMITS, panMax: 45 } });
    expect(((await res.json()) as any).result.structuredContent.result.clamped).toBe(true);
    expect(lastCall().call.params.pan).toBe(45);
    await call("move_head", { pan: -15, relative: true });
    expect(lastCall().call.params).toMatchObject({ pan: -15, relative: true });
    const huge = await call("move_head", { pan: 1000, relative: true });
    expect(lastCall().call.params.pan).toBe(180);
    expect(huge.envelope.result.clamped).toBe(true);
  });
  it("move_head validation", async () => {
    for (const args of [{}, { pan: "left" }, { pan: NaN }, { pan: null, tilt: null }, { pan: 1, wait: "later" }, { pan: 1, wait: "done", timeout_ms: 5 }]) {
      const r = await call("move_head", args as any);
      expect(r.envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    }
    expect(gw.calls).toHaveLength(0);
  });

  it("reset_pose -> device.reset_pose", async () => {
    await call("reset_pose");
    expect(lastCall().call).toMatchObject({ method: "device.reset_pose", params: { reset_face: true, wait: "accepted" } });
    await call("reset_pose", { speed: 50, reset_face: false });
    expect(lastCall().call.params).toMatchObject({ speed: 100, reset_face: false });
  });

  it("set_expression -> device.set_expression (+ look_at clamped)", async () => {
    await call("set_expression", { expression: "happy", duration_ms: 3000, revert_to: "neutral", look_at: { pan: 120, tilt: 10 } });
    expect(lastCall().call).toMatchObject({ method: "device.set_expression", params: { expression: "happy", duration_ms: 3000, revert_to: "neutral", look_at: { pan: 90, tilt: 10 } } });
    for (const args of [{}, { expression: "rage" }, { expression: "happy", duration_ms: -1 }, { expression: "happy", look_at: {} }, { expression: "happy", look_at: "left" }, { expression: "happy", revert_to: "x" }]) {
      expect((await call("set_expression", args as any)).envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    }
    expect(gw.calls).toHaveLength(1);
  });

  it("show_text -> device.show_text; limits, control chars and clear", async () => {
    await call("show_text", { text: "你好 Leo" });
    expect(lastCall().call).toMatchObject({ method: "device.show_text", params: { text: "你好 Leo", clear: false, duration_ms: 5000, position: "bubble" } });
    await call("show_text", { text: "a\u0007b\u001b[2Jc\nd", duration_ms: 0, position: "center", size: "l" });
    expect(lastCall().call.params).toMatchObject({ text: "a b [2Jc\nd", duration_ms: 0, position: "center", size: "l" });
    await call("show_text", { clear: true });
    expect(lastCall().call.params).toEqual({ clear: true, duration_ms: 5000, position: "bubble" });
    expect((await call("show_text", { text: "x".repeat(200) })).envelope.ok).toBe(true);
    for (const args of [{}, { text: "" }, { text: "   " }, { text: "x".repeat(201) }, { text: 5 }, { text: "a", position: "top" }, { text: "a", size: "xl" }]) {
      expect((await call("show_text", args as any)).envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    }
  });

  it("set_led -> device.set_led (hex and rgb object)", async () => {
    await call("set_led", { color: "#ff8000" });
    expect(lastCall().call).toMatchObject({ method: "device.set_led", params: { r: 255, g: 128, b: 0, side: "both", mode: "solid", brightness: 40 } });
    await call("set_led", { color: { r: 1, g: 2, b: 3 }, side: "left", mode: "breathe", brightness: 100, duration_ms: 2000 });
    expect(lastCall().call.params).toEqual({ r: 1, g: 2, b: 3, side: "left", mode: "breathe", brightness: 100, duration_ms: 2000 });
    await call("set_led", { mode: "off" });
    expect(lastCall().call.params).toMatchObject({ r: 0, g: 0, b: 0, mode: "off" });
  });
  it("set_led validation: range, format, enums", async () => {
    const bad: any[] = [{}, { color: "red" }, { color: "#fff" }, { color: "#gggggg" }, { color: { r: 256, g: 0, b: 0 } }, { color: { r: -1, g: 0, b: 0 } }, { color: { r: 1.5, g: 0, b: 0 } }, { color: { r: 1, g: 2 } }, { color: 12 }, { color: "#ffffff", brightness: 101 }, { color: "#ffffff", brightness: -1 }, { color: "#ffffff", side: "top" }, { color: "#ffffff", mode: "strobe" }];
    for (const args of bad) expect((await call("set_led", args)).envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    expect(gw.calls).toHaveLength(0);
  });

  it("speak -> gateway.speak with defaults, cap and cleaned text", async () => {
    const r = await call("speak", { text: " 你好\u0000世界 " });
    expect(gw.speaks[0]!.call).toMatchObject({ text: "你好 世界", lang: "zh", interrupt: false, wait: "started", timeout_ms: 30000 });
    expect(r.envelope.ok).toBe(true);
    await call("speak", { text: "hi", volume: 100, interrupt: true, wait: "done", timeout_ms: 60000, expression: "happy", voice: "v1", lang: "en", request_id: "q1" });
    expect(gw.speaks[1]!.call).toMatchObject({ volume: 70, interrupt: true, wait: "done", timeout_ms: 60000, expression: "happy", voice: "v1", lang: "en", request_id: "q1" });
    expect((await call("speak", { text: "hi", volume: 100 })).envelope.result.volume_clamped_to).toBe(70);
  });
  it("speak validation: text length, enums, ranges", async () => {
    expect((await call("speak", { text: "字".repeat(500) })).envelope.ok).toBe(true);
    for (const args of [{}, { text: "" }, { text: "   " }, { text: "a".repeat(501) }, { text: 1 }, { text: "a", wait: "never" }, { text: "a", volume: 101 }, { text: "a", volume: -1 }, { text: "a", volume: 1.5 }, { text: "a", timeout_ms: 10 }, { text: "a", expression: "x" }, { text: "a", interrupt: "yes" }]) {
      expect((await call("speak", args as any)).envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    }
    expect(gw.speaks).toHaveLength(1);
  });

  it("stop_audio -> device.stop_audio (clear_queue default true)", async () => {
    await call("stop_audio");
    expect(lastCall().call).toMatchObject({ method: "device.stop_audio", params: { clear_queue: true } });
    await call("stop_audio", { stream_id: 7, clear_queue: false });
    expect(lastCall().call.params).toEqual({ stream_id: 7, clear_queue: false });
    expect((await call("stop_audio", { stream_id: 0 })).envelope.error.code).toBe("invalid_args");
    expect((await call("stop_audio", { stream_id: 70000 })).envelope.error.code).toBe("invalid_args");
  });

  it("set_volume -> device.set_volume; cap applied and reported", async () => {
    await call("set_volume", { volume: 30 });
    expect(lastCall().call).toMatchObject({ method: "device.set_volume", params: { volume: 30, persist: false } });
    gw.next = () => undefined;
    const r = await call("set_volume", { volume: 95, persist: true });
    expect(lastCall().call.params).toEqual({ volume: 70, persist: true });
    expect(r.envelope.result).toMatchObject({ volume: 70, clamped: true, requested: 95 });
    await call("set_volume", { mute: true });
    expect(lastCall().call.params).toEqual({ mute: true, persist: false });
    for (const args of [{}, { volume: 101 }, { volume: -5 }, { volume: "loud" }, { mute: "yes" }]) {
      expect((await call("set_volume", args as any)).envelope.error.code, JSON.stringify(args)).toBe("invalid_args");
    }
  });

  it("emergency_stop -> device.emergency_stop with no request_id/dedup and nothing else in params", async () => {
    const r = await call("emergency_stop", { request_id: "ignored" });
    expect(lastCall().call).toEqual({ tool: "emergency_stop", method: "device.emergency_stop", params: {} });
    expect(r.envelope.result).toEqual({ motion_halted: true, audio_stopped: true });
  });

  it("device errors pass through the envelope", async () => {
    gw.next = () => ({ ok: false, device_id: "sc1", error: { code: "low_battery", message: "battery 4%", data: { device_code: -32002 } } });
    const r = await call("move_head", { pan: 1 });
    expect(r.isError).toBe(true);
    expect(r.envelope).toMatchObject({ ok: false, device_id: "sc1", error: { code: "low_battery", data: { device_code: -32002 } } });
  });
});
