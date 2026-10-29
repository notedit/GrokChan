import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseWsAuth, scrubWsAuthHeaders } from "../src/auth";
import { simCsp } from "../src/sim";

const req = (h: Record<string, string>) => new Request("http://x/ws/device", { headers: h });
const TOK = "tok_ABCDEFGHIJKLMNOP-1234567890";

describe("parseWsAuth", () => {
  it("takes the token from the gc-auth subprotocol and echoes only the plain protocol", () => {
    const r = parseWsAuth(req({ "sec-websocket-protocol": `mediasession-rpc.v1, gc-auth.${TOK}` }));
    expect(r).toEqual({ token: TOK, echo: "mediasession-rpc.v1" });
  });
  it("Bearer wins over the subprotocol", () => {
    const r = parseWsAuth(req({ authorization: "Bearer bearer-token-0123456789", "sec-websocket-protocol": `mediasession-rpc.v1, gc-auth.${TOK}` }));
    expect(r.token).toBe("bearer-token-0123456789");
  });
  it("no echo without the plain protocol; malformed tokens are ignored", () => {
    expect(parseWsAuth(req({ "sec-websocket-protocol": `gc-auth.${TOK}` })).echo).toBeNull();
    expect(parseWsAuth(req({ "sec-websocket-protocol": "mediasession-rpc.v1, gc-auth.short" })).token).toBeNull();
    expect(parseWsAuth(req({ "sec-websocket-protocol": "mediasession-rpc.v1, gc-auth." + "a".repeat(200) })).token).toBeNull();
    expect(parseWsAuth(req({})).token).toBeNull();
  });
  it("scrubWsAuthHeaders never keeps the secret entry", () => {
    const h = new Headers({ "sec-websocket-protocol": `mediasession-rpc.v1, gc-auth.${TOK}` });
    scrubWsAuthHeaders(h, "mediasession-rpc.v1");
    expect(h.get("sec-websocket-protocol")).toBe("mediasession-rpc.v1");
    scrubWsAuthHeaders(h, null);
    expect(h.get("sec-websocket-protocol")).toBeNull();
  });
});

describe("sim assets", () => {
  it("src/sim/assets.gen.ts is up to date (run `npm run gen:sim`)", async () => {
    const gen = await import("../scripts/gen-sim-assets.mjs");
    expect(readFileSync(gen.OUT, "utf8")).toBe(gen.buildAssetsSource());
  });
  it("the committed gc_core.wasm matches the firmware core + adapter sources (run tools/webdevice/build_wasm.sh)", () => {
    const fw = resolve(__dirname, "..", "..", "firmware");
    const { readdirSync } = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
    const core = resolve(fw, "lib/grokchan_core/src");
    const names = readdirSync(core);
    const cpp = names.filter((n) => /^gc_.*\.cpp$/.test(n)).sort();
    const hs = names.filter((n) => /\.h$/.test(n)).sort();
    const h = createHash("sha256");
    for (const f of [resolve(fw, "tools/webdevice/web_platform.cpp"), ...cpp.map((n) => resolve(core, n)), ...hs.map((n) => resolve(core, n))]) h.update(readFileSync(f));
    expect(h.digest("hex")).toBe(readFileSync(resolve(fw, "tools/webdevice/web/gc_core.sources.sha256"), "utf8").trim());
  });
  it("CSP is strict: no inline, no unsafe-eval, ws only to this origin", () => {
    const csp = simCsp(new URL("https://bridge.example.workers.dev/sim/"));
    expect(csp).not.toMatch(/unsafe-inline|(?<!wasm-)unsafe-eval|\*/);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self' wss://bridge.example.workers.dev");
    expect(csp).toContain("default-src 'none'");
  });
  it("the page has no inline script/style and no localStorage use", () => {
    const html = readFileSync(resolve(__dirname, "../../firmware/tools/webdevice/web/index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|style=/);
    for (const f of ["app.js", "device.js"]) expect(readFileSync(resolve(__dirname, "../../firmware/tools/webdevice/web", f), "utf8")).not.toMatch(/\blocalStorage\s*[.\[]/);
  });
});
