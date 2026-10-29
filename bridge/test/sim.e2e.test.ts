import { afterAll, describe, expect, it } from "vitest";
import { startWorker, PASSCODE, MCP_API_KEY, type Worker } from "./harness";

const base = { STACKCHAN_ENABLED: "true", SITE_PASSCODE: PASSCODE, MCP_API_KEY };
const workers: Worker[] = [];
const start = async (v: Record<string, string>) => { const w = await startWorker(v); workers.push(w); return w; };
afterAll(async () => { for (const w of workers) await w.stop(); });

describe("/sim route", () => {
  it("is 404 unless SIM_UI_ENABLED=true (default off), even with a valid passcode", async () => {
    const off = await start(base);
    expect((await fetch(off.base + "/sim/", { headers: { "x-passcode": PASSCODE } })).status).toBe(404);
    const noStack = await start({ SIM_UI_ENABLED: "true", SITE_PASSCODE: PASSCODE });
    expect((await fetch(noStack.base + "/sim/", { headers: { "x-passcode": PASSCODE } })).status).toBe(404);
  });

  it("requires SITE_PASSCODE, serves assets with strict CSP, wasm type, redirect", async () => {
    const w = await start({ ...base, SIM_UI_ENABLED: "true" });
    // unauthenticated / wrong
    const anon = await fetch(w.base + "/sim/");
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain("gc_core");
    expect((await fetch(w.base + "/sim/gc_core.wasm")).status).toBe(401);
    expect((await fetch(w.base + "/sim/", { headers: { "x-passcode": "wrong" } })).status).toBe(401);

    // login cookie
    const login = await fetch(w.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("gc_auth=");
    const h = { cookie };

    const redir = await fetch(w.base + "/sim", { headers: h, redirect: "manual" });
    expect(redir.status).toBe(308);
    expect(redir.headers.get("location")).toBe("/sim/");

    const page = await fetch(w.base + "/sim/", { headers: h });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).toContain(`connect-src 'self' ws://${new URL(w.base).host}`);
    expect(page.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain('id="face"');
    expect(html).not.toMatch(new RegExp(PASSCODE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const wasm = await fetch(w.base + "/sim/gc_core.wasm", { headers: h });
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    const bytes = new Uint8Array(await wasm.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);

    for (const f of ["app.js", "device.js", "mic-worklet.js", "face_draw.js", "style.css"]) {
      const r = await fetch(`${w.base}/sim/${f}`, { headers: h });
      expect(r.status, f).toBe(200);
      expect(await r.text()).not.toContain(PASSCODE);
    }
    expect((await fetch(w.base + "/sim/nope.js", { headers: h })).status).toBe(404);
    expect((await fetch(w.base + "/sim/..%2fapi%2fdevices", { headers: h })).status).toBe(404);
    expect((await fetch(w.base + "/sim/", { method: "POST", headers: h })).status).toBe(405);
    // X-Passcode works for tooling as well
    expect((await fetch(w.base + "/sim/", { headers: { "x-passcode": PASSCODE } })).status).toBe(200);
  });
});
