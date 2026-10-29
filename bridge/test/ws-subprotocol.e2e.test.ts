import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker, waitFor, issueDeviceToken, PASSCODE, MCP_API_KEY, type Worker } from "./harness";
import { MockDevice } from "./mock-device";
import { mcpClient } from "./mcp-client";

// Browser device auth: token in Sec-WebSocket-Protocol. Real workerd; Node's WebSocket behaves like a browser here
// (it fails the handshake when the server does not select one of the offered subprotocols).
const VARS = { STACKCHAN_ENABLED: "true", TTS_PROVIDER: "mock", SITE_PASSCODE: PASSCODE, MCP_API_KEY };
let w: Worker;
let n = 0;
const id = () => `sp_${++n}_${Math.random().toString(36).slice(2, 7)}`;
const opened: WebSocket[] = [];

function openWs(base: string, deviceId: string, protocols: string[], headers?: Record<string, string>): Promise<{ ws: WebSocket; opened: boolean; code?: number; reason?: string; protocol: string }> {
  return new Promise((resolve) => {
    const WS = WebSocket as unknown as new (u: string, p?: string[] | { headers?: Record<string, string>; protocols?: string[] }) => WebSocket;
    const url = `${base.replace("http", "ws")}/ws/device?device_id=${deviceId}`;
    const ws = new WS(url, headers ? { headers, protocols } : protocols);
    opened.push(ws);
    let wasOpen = false;
    ws.addEventListener("open", () => { wasOpen = true; });
    ws.addEventListener("close", (ev) => resolve({ ws, opened: wasOpen, code: ev.code, reason: ev.reason, protocol: ws.protocol }));
    // a failed handshake (server did not select an offered subprotocol): browsers fire error+close(1006); undici only error
    ws.addEventListener("error", () => setTimeout(() => resolve({ ws, opened: wasOpen, protocol: ws.protocol }), 100));
    // for the success case resolve shortly after open (the connection stays up)
    ws.addEventListener("open", () => setTimeout(() => resolve({ ws, opened: true, protocol: ws.protocol }), 150));
  });
}

beforeAll(async () => { w = await startWorker(VARS); });
afterAll(async () => { for (const s of opened) try { s.close(); } catch {} await w?.stop(); });

describe("browser auth via Sec-WebSocket-Protocol", () => {
  it("valid token: handshake succeeds, server echoes ONLY the non-secret subprotocol, full session works", async () => {
    const d = id();
    const token = await issueDeviceToken(w.base, d);
    const r = await openWs(w.base, d, ["mediasession-rpc.v1", `gc-auth.${token}`]);
    expect(r.opened).toBe(true);
    expect(r.protocol).toBe("mediasession-rpc.v1");
    expect(r.protocol).not.toContain(token);
    r.ws.close();

    const dev = new MockDevice(w.base, d, { token, viaSubprotocol: true });
    await dev.start();
    expect(dev.helloResult.session_id).toBeTruthy();
    // MCP -> device over the subprotocol-authenticated socket
    const mcp = mcpClient(w.base, { authorization: `Bearer ${MCP_API_KEY}` });
    const res = await mcp.call("get_device_status", { device_id: d });
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res)).not.toContain(token);
    dev.close();
  });

  it("wrong token -> close 4003 (and the browser still sees the code: server selected a subprotocol)", async () => {
    const d = id();
    await issueDeviceToken(w.base, d);
    const r = await openWs(w.base, d, ["mediasession-rpc.v1", `gc-auth.${"A".repeat(43)}`]);
    expect(r.code).toBe(4003);
    expect(r.reason).toBe("unauthorized");
    expect(r.opened).toBe(true); // a 101 + immediate close, like the Bearer path
    // the secret was never echoed
    expect(r.protocol).toBe("mediasession-rpc.v1");
  });

  it("missing token / only the plain subprotocol / token for another device / malformed token -> 4003", async () => {
    const a = id(), b = id();
    const ta = await issueDeviceToken(w.base, a);
    await issueDeviceToken(w.base, b);
    expect((await openWs(w.base, a, ["mediasession-rpc.v1"])).code).toBe(4003);
    expect((await openWs(w.base, b, ["mediasession-rpc.v1", `gc-auth.${ta}`])).code).toBe(4003);
    expect((await openWs(w.base, a, ["mediasession-rpc.v1", "gc-auth.short"])).code).toBe(4003);
    // token without the plain protocol: the server does not select anything -> the browser handshake fails (1006); nothing is accepted
    const noPlain = await openWs(w.base, a, [`gc-auth.${ta}`]);
    expect(noPlain.opened).toBe(false);
  });

  it("Bearer still works unchanged and takes precedence; a revoked token no longer works over the subprotocol", async () => {
    const d = id();
    const token = await issueDeviceToken(w.base, d);
    const bearer = new MockDevice(w.base, d, { token });
    await bearer.start();
    bearer.close();
    // Bearer wins over a bogus subprotocol token
    const r = await openWs(w.base, d, ["mediasession-rpc.v1", `gc-auth.${"B".repeat(43)}`], { Authorization: `Bearer ${token}`, "Device-Id": d });
    expect(r.opened).toBe(true);
    expect(r.code).toBeUndefined();
    r.ws.close();
    // wrong Bearer + right subprotocol token must NOT authenticate (Bearer is authoritative when present)
    const r2 = await openWs(w.base, d, ["mediasession-rpc.v1", `gc-auth.${token}`], { Authorization: `Bearer ${"C".repeat(43)}`, "Device-Id": d });
    expect(r2.code).toBe(4003);
    // revoke
    await fetch(`${w.base}/api/devices/${d}/token`, { method: "DELETE", headers: { "x-passcode": PASSCODE } });
    expect((await openWs(w.base, d, ["mediasession-rpc.v1", `gc-auth.${token}`])).code).toBe(4003);
  });

  it("failed attempts share the per-IP rate limit with Bearer failures (auth not weakened)", async () => {
    const strict = await startWorker(VARS);
    try {
      const d = id();
      await issueDeviceToken(strict.base, d);
      let last: number | undefined;
      for (let i = 0; i < 12; i++) last = (await openWs(strict.base, d, ["mediasession-rpc.v1", `gc-auth.${"D".repeat(43)}`])).code;
      expect(last).toBe(4003);
      // now even the right token is rate limited for this IP
      const token = await issueDeviceToken(strict.base, d);
      const r = await openWs(strict.base, d, ["mediasession-rpc.v1", `gc-auth.${token}`]);
      expect(r.code).toBe(4003);
      expect(r.reason).toBe("rate limited");
    } finally { await strict.stop(); }
  });
});
