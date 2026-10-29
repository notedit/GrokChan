import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { client, MockWebhook, sleep, startWorker, waitFor, WEBHOOK_KEY, PASSCODE, MCP_API_KEY, type Worker } from "./harness";
import { mcpClient } from "./mcp-client";

// Browser smoke test of the web virtual device (the REAL firmware core compiled to wasm) against a local
// `wrangler dev` with mock ASR/TTS and a mock Grok Bot webhook. Needs Chrome (CHROME_PATH or /usr/bin/google-chrome);
// skipped when it is not installed. Fake secrets only.
const CHROME = process.env.CHROME_PATH || ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
const SHOT = resolve(__dirname, "..", "..", "docs", "images", "webdevice.png");

const VARS = {
  STACKCHAN_ENABLED: "true",
  SIM_UI_ENABLED: "true",
  TTS_PROVIDER: "mock",
  ASR_PROVIDER: "mock",
  DEVICE_CMD_TIMEOUT_MS: "3000",
  HELLO_TIMEOUT_MS: "5000",
  DEVICE_RATE_LIMIT_PER_SEC: "1000",
  UPLINK_MAX_MS: "3000",
  UPLINK_GRACE_MS: "500",
  AGENT_REPLY_TIMEOUT_MS: "8000",
  ASR_TIMEOUT_MS: "5000",
  SITE_PASSCODE: PASSCODE,
  MCP_API_KEY,
};

let hook: MockWebhook, w: Worker, browser: Browser, ctx: BrowserContext, page: Page;
let mcp: ReturnType<typeof mcpClient>, http: ReturnType<typeof client>;
const DEVICE = "stackchan-web";
// The page runs under a strict CSP without unsafe-eval, so the test never evals strings in it: only real functions
// (injected over CDP) with serialisable arguments.
type Cond = [path: string, op: "==" | "!=" | "~" | ">", value: unknown, tol?: number];
const pageState = () => page.evaluate(() => (window as any).__wd.state());
const q = <T = any>(what: string, arg?: unknown) =>
  page.evaluate(([w, a]) => {
    const d = (window as any).__wd;
    const logs = (dir: string, m?: string) => d.logs.filter((e: any) => e.dir === dir && (!m || e.method === m));
    switch (w) {
      case "stat": return d.stats[a as string];
      case "on": return d.powered;
      case "turns": return d.turns.filter((t: any) => t.kind === a);
      case "txMethods": return logs("tx").filter((e: any) => e.method).map((e: any) => e.method);
      case "txParams": return logs("tx", a as string).map((e: any) => e.j.params);
      case "rxParams": return logs("rx", a as string).map((e: any) => e.j.params);
      case "txById": return logs("tx").filter((e: any) => e.j && e.j.id === a).length;
      case "logText": return JSON.stringify(d.logs.map((e: any) => e.text || ""));
      case "export": return JSON.stringify(d.exportLog());
      case "ensureAudio": return d.ensureAudio().then(() => true);
      case "loudNoise": d.loudNoise(a as number); return true;
      case "face": { const c = document.getElementById("face") as HTMLCanvasElement; const px = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; const set = new Set<number>(); for (let i = 0; i < px.length; i += 4 * 97) set.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]); return set.size; }
      case "storage": return JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]);
    }
    throw new Error("unknown query " + w);
  }, [what, arg]) as Promise<T>;
const waitState = (conds: Cond[], ms = 8000) =>
  page.waitForFunction((cs) => {
    const s = (window as any).__wd.state();
    if (!s) return false;
    return (cs as any[]).every(([path, op, v, tol]) => {
      const x = String(path).split(".").reduce((o: any, k) => (o == null ? o : o[k]), s);
      return op === "==" ? x === v : op === "!=" ? x !== v : op === ">" ? x > (v as number) : Math.abs(x - (v as number)) <= (tol ?? 1);
    });
  }, conds, { timeout: ms });
/** harness.waitFor only handles sync predicates; this one awaits async ones. */
async function until(fn: () => Promise<unknown> | unknown, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`until timed out: ${fn.toString().slice(0, 120)}`);
    await sleep(50);
  }
}
const hookReq = (i = 0) => hook.requests.filter((r) => r.body?.device?.id === DEVICE)[i];

describe.skipIf(!CHROME)("web virtual device (real Chrome, real wrangler dev, mock ASR/TTS)", () => {
  beforeAll(async () => {
    hook = new MockWebhook();
    await hook.start();
    w = await startWorker({ ...VARS, GROK_WEBHOOK_URL: hook.url, GROK_WEBHOOK_KEY: WEBHOOK_KEY });
    mcp = mcpClient(w.base, { authorization: `Bearer ${MCP_API_KEY}` });
    http = client(w.base);
    browser = await chromium.launch({
      executablePath: CHROME, headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"],
    });
    ctx = await browser.newContext({ viewport: { width: 1360, height: 980 }, deviceScaleFactor: 1 });
    // SITE_PASSCODE login (same as typing it on the bridge home page) -> gc_auth cookie for /sim and the token button
    const login = await fetch(w.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }) });
    const c = (login.headers.get("set-cookie") ?? "").split(";")[0];
    await ctx.addCookies([{ name: c.split("=")[0], value: c.slice(c.indexOf("=") + 1), url: w.base }]);
    page = await ctx.newPage();
    page.on("pageerror", (e) => { throw e; });
    await page.goto(w.base + "/sim/");
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    await Promise.all([w?.stop(), hook?.stop()]);
  });

  it("the page is served under the strict CSP with no violations, token only in memory", async () => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    await page.reload();
    expect(await page.title()).toMatch(/StackChan|GrokChan/i);
    expect(await page.evaluate(() => typeof (window as any).__wd)).toBe("object");
    expect(violations).toEqual([]);
  });

  it("issue token (same-origin) -> power on -> session.hello -> ready; face renders; the device registers under its own id", async () => {
    await page.click("#btn-issue");
    await until(async () => (await page.inputValue("#in-token")).length >= 20, 5000);
    await page.click("#btn-power");
    await waitState([["session", "==", "ready"]]);
    const s = await pageState();
    expect(s.session_id).toBeTruthy();
    expect(s.heartbeat_s).toBeGreaterThan(0);
    const log = await q<string>("logText");
    expect(log).toContain("selected subprotocol: mediasession-rpc.v1");
    expect(log).toContain("session.hello");
    // the token is neither in the log nor in any storage
    const token = await page.inputValue("#in-token");
    expect(log).not.toContain(token);
    expect(await q<string>("storage")).not.toContain(token);
    expect(await q<number>("face")).toBeGreaterThan(1);
    expect(JSON.stringify((await mcp.call("list_devices")).envelope)).toContain(DEVICE);
  });

  it("MCP device.* methods drive the virtual device (pose, limits, expression, text, led, volume)", async () => {
    expect((await mcp.call("move_head", { device_id: DEVICE, pan: 30, tilt: 20 })).isError).toBe(false);
    await waitState([["pose.pan", "~", 30], ["pose.tilt", "~", 20]], 10000);
    // out of range: never accepted at 500
    const over = await mcp.call("move_head", { device_id: DEVICE, pan: 500, tilt: 20 });
    expect(JSON.stringify(over.envelope) + (over.text ?? "")).toMatch(/clamp|range|invalid|limit|-3200|error/i);
    expect((await pageState()).pose.pan).toBeLessThanOrEqual(90);

    expect((await mcp.call("set_expression", { device_id: DEVICE, expression: "happy" })).isError).toBe(false);
    await waitState([["expression", "==", "happy"]]);
    expect((await mcp.call("show_text", { device_id: DEVICE, text: "你好 web" })).isError).toBe(false);
    await waitState([["text", "==", "你好 web"]]);
    expect((await mcp.call("set_led", { device_id: DEVICE, color: { r: 255, g: 0, b: 0 }, mode: "solid", brightness: 100 })).isError).toBe(false);
    await waitState([["led.0.r", ">", 100], ["led.0.g", "==", 0], ["led.0.mode", "==", "solid"]]);
    expect((await mcp.call("set_volume", { device_id: DEVICE, volume: 55 })).isError).toBe(false);
    await waitState([["volume", "==", 55]]);
    expect((await mcp.call("reset_pose", { device_id: DEVICE })).isError).toBe(false);
    await waitState([["pose.pan", "~", 0], ["pose.tilt", "~", 0]], 10000);
    expect((await mcp.call("get_device_status", { device_id: DEVICE })).isError).toBe(false);
  });

  it("MCP speak -> downlink 0x01 frames -> WebAudio playback -> playback.state ended; latency row recorded", async () => {
    await q("ensureAudio");
    const r = await mcp.call("speak", { device_id: DEVICE, text: "你好,这是一个测试。" });
    expect(r.isError).toBe(false);
    await until(async () => (await q<number>("stat", "rxBin")) > 3, 8000);
    await until(async () => (await q<any[]>("turns", "speak")).some((t) => t.playbackEnd !== undefined), 20000);
    const t = (await q<any[]>("turns", "speak")).at(-1);
    expect(t.firstFrame).toBeGreaterThan(0);
    expect(t.playbackEnd).toBeGreaterThan(t.firstFrame);
    const states = (await q<any[]>("txParams", "playback.state")).map((p) => p.state);
    expect(states).toContain("started");
    expect(states).toContain("ended");
    expect(await q<number>("stat", "pcmDropped")).toBe(0);
  });

  it("voice turn: virtual mic -> real VAD -> speech_start/end + 0x02 uplink -> ASR -> webhook -> reply -> TTS -> playback; table row filled", async () => {
    const before = hook.requests.length;
    await page.fill("#in-say", "今天天气怎么样");
    await page.click("#btn-say");
    await waitFor(() => hook.requests.length > before, 15000);
    const req = hook.requests.at(-1)!;
    expect(String(req.body.message).replace(/[\0\s]+$/, "")).toBe("今天天气怎么样"); // mock ASR pads the PCM-as-text up to the VAD minimum
    expect(req.body.device).toMatchObject({ id: DEVICE, modality: "voice" });
    await waitState([["turn", "==", "thinking"]]);
    expect((await http.reply(req.body.reply.url, { text: "今天晴天。适合出门散步。" })).status).toBe(200);
    await until(async () => (await q<any[]>("turns", "voice")).some((t) => t.playbackEnd !== undefined), 25000);
    const t = (await q<any[]>("turns", "voice")).at(-1);
    expect(t.text).toBe("今天天气怎么样");
    for (const k of ["asrFinal", "reply", "firstFrame", "playbackEnd"]) expect(t[k], k).toBeGreaterThan(0);
    const sent = await q<string[]>("txMethods");
    expect(sent.indexOf("event.speech_start")).toBeGreaterThan(-1);
    expect(sent.lastIndexOf("event.speech_end")).toBeGreaterThan(sent.indexOf("event.speech_start"));
    expect(await page.locator("#lat tbody tr").count()).toBeGreaterThanOrEqual(2);
    await waitState([["turn", "==", "idle"]], 10000);
  });

  it("interruption: a touch while the reply plays stops playback (playback.state interrupted) and the bridge aborts the stream", async () => {
    const LONG = "这是一段很长的回答,需要播放好几秒钟。我们继续往下说,直到被用户打断为止。再多说几句话,让音频足够长。最后一句话在这里结束。";
    const before = hook.requests.length;
    await page.fill("#in-say", "讲个长故事");
    await page.click("#btn-say");
    await waitFor(() => hook.requests.length > before, 15000);
    await http.reply(hook.requests.at(-1)!.body.reply.url, { text: LONG });
    await waitState([["speaking", "==", true]], 15000);
    const n0 = (await q<any[]>("txParams", "playback.state")).length;
    await page.click("#btn-touch"); // a tap interrupts in the firmware
    await until(async () => (await q<any[]>("txParams", "playback.state")).length > n0, 8000);
    expect((await q<any[]>("txParams", "playback.state")).at(-1).state).toBe("interrupted");
    await waitState([["turn", "==", "idle"], ["speaking", "==", false]], 10000);
    expect((await q<any[]>("rxParams", "audio.end")).length).toBeGreaterThan(0);
  });

  it("screenshot", async () => {
    await mcp.call("set_expression", { device_id: DEVICE, expression: "happy" });
    await mcp.call("show_text", { device_id: DEVICE, text: "Hello StackChan" });
    await mcp.call("set_led", { device_id: DEVICE, color: "#00a0ff", mode: "solid" });
    await mcp.call("move_head", { device_id: DEVICE, pan: 25, tilt: 15 });
    await sleep(2500);
    await page.screenshot({ path: SHOT, fullPage: true });
    expect(existsSync(SHOT)).toBe(true);
  });

  it("fault injection: oversize utterance, low battery, overheat, emergency stop", async () => {
    // 5 s of loud noise vs the advertised limit (UPLINK_MAX_MS=3000): like the firmware (VoiceUplink honours
    // hello.voice.limits), the core ends the utterance itself at the limit, so the bridge never sees an oversize stream.
    const before = hook.requests.length;
    await sleep(1500); // the firmware VAD holds off after playback (echo guard); noise starting inside that window is learnt as the floor
    const nEnd = (await q<any[]>("txParams", "audio.end")).length;
    await q("loudNoise", 5000);
    await until(async () => (await q<any[]>("txParams", "audio.end")).length > nEnd, 15000);
    const end = (await q<any[]>("txParams", "audio.end")).at(-1);
    expect(end.total_bytes).toBeLessThanOrEqual(3000 * 32 + 1280);
    expect((await q<any[]>("rxParams", "stream.error")).length).toBe(0);
    await waitFor(() => hook.requests.length > before, 15000);
    await http.reply(hook.requests.at(-1)!.body.reply.url, { text: "收到。" });
    await waitState([["turn", "==", "idle"]], 20000);

    await page.click("[data-fault=lowbat]");
    await waitState([["battery", "==", 5]]);
    await page.click("[data-fault=bat]");
    await waitState([["battery", "==", 77]]);

    await page.click("[data-fault=overheat]");
    await waitState([["overheated", "==", true]]);
    expect((await mcp.call("move_head", { device_id: DEVICE, pan: 10, tilt: 10 })).isError).toBe(true);
    await page.click("[data-fault=cool]");
    await waitState([["overheated", "==", false]]);

    await mcp.call("move_head", { device_id: DEVICE, pan: 40, tilt: 10 });
    await page.click("[data-fault=estop]");
    const sent = await q<string[]>("txMethods");
    expect(sent.some((m) => /emergency|stop/.test(m))).toBe(true);
  });

  it("manual RPC box: tx a raw frame and inject a raw rx frame; exported log has no token", async () => {
    await page.fill("#in-raw", '{"jsonrpc":"2.0","method":"event.touch","params":{"kind":"tap"}}');
    await page.click("#btn-raw-tx");
    await page.fill("#in-raw", '{"jsonrpc":"2.0","id":9001,"method":"device.get_status"}');
    await page.click("#btn-raw-rx");
    await until(async () => (await q<number>("txById", 9001)) > 0, 5000);
    const token = await page.inputValue("#in-token");
    const exp = await q<string>("export");
    expect(exp).not.toContain(token);
    expect(exp).not.toContain(PASSCODE);
    expect(exp).toContain("session.hello");
  });

  it("connection fault: drop -> exponential-backoff reconnect -> ready again (same device_id, new session)", async () => {
    const sid = (await pageState()).session_id;
    await page.click("[data-fault=drop]");
    await waitState([["session", "!=", "ready"]], 5000);
    await waitState([["session", "==", "ready"]], 30000);
    const s = await pageState();
    expect(s.reconnects).toBeGreaterThan(0);
    expect(s.session_id).not.toBe(sid);
  }, 60_000);


  it("wrong token -> close 4003 shown in the UI, auto power-off after 3 consecutive 4003s (protects the IP rate limit), then the real token works again", async () => {
    await page.click("[data-fault=badtoken]"); // drops the live link; the reconnects then present a wrong token
    await until(async () => (await q<any>("stat", "lastClose"))?.code === 4003, 10000);
    expect(await q<number>("stat", "authFailed")).toBeGreaterThanOrEqual(1);
    await until(async () => !(await q<boolean>("on")), 60000);
    await page.click("#btn-power"); // the wrong-token fault is cleared by a manual power-on
    await waitState([["session", "==", "ready"]], 20000);
  }, 120_000);
});
