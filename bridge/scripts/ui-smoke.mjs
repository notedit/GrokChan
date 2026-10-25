// Optional browser smoke test of the real page (not part of `npm test`).
//   npm i --no-save puppeteer-core && CHROME=/usr/bin/google-chrome node scripts/ui-smoke.mjs
// Starts a mock webhook + `wrangler dev` with fake secrets, then drives the UI headlessly.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASS = "ui-pass-FAKE", KEY = "ui-key-FAKE", WPORT = 18791, MPORT = 18792;
const events = [];
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const ev = JSON.parse(b); events.push(ev);
    res.writeHead(200).end("{}");
    // behave like the routine: reply after 2.5s (shows the "thinking" state)
    setTimeout(() => fetch(ev.reply.url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `收到：${ev.message}\n链接 https://example.com/x?y=1。<b>不是HTML</b>` }) }), 2500);
  });
}).listen(MPORT, "127.0.0.1");

const wr = spawn("node_modules/.bin/wrangler", ["dev", "--ip", "127.0.0.1", "--port", String(WPORT), "--inspector-port", "19239",
  "--persist-to", mkdtempSync(join(tmpdir(), "gc-ui-")),
  "--var", `PUBLIC_ORIGIN:http://127.0.0.1:${WPORT}`, "--var", `GROK_WEBHOOK_URL:http://127.0.0.1:${MPORT}/hook`,
  "--var", `GROK_WEBHOOK_KEY:${KEY}`, "--var", `SITE_PASSCODE:${PASS}`], { stdio: "ignore", env: { ...process.env, CI: "1" } });
const done = (code) => { wr.kill("SIGTERM"); mock.close(); process.exit(code); };
let ok = false;
for (let i = 0; i < 200 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${WPORT}/api/health`)).ok; } catch {} if (!ok) await new Promise((r) => setTimeout(r, 300)); }
if (!ok) { console.error("worker did not start"); done(1); }

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && !/401/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${WPORT}/`);
  await page.waitForSelector("#passcode", { visible: true });
  await page.type("#passcode", "wrong"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("loginErr").textContent.includes("Incorrect"));
  await page.$eval("#passcode", (e) => (e.value = ""));
  await page.type("#passcode", PASS); await page.keyboard.press("Enter");
  await page.waitForSelector("#input", { visible: true });
  await page.type("#input", "你好"); await page.keyboard.press("Enter");
  await page.waitForSelector(".thinking");
  console.log("thinking indicator shown: true");
  await page.waitForSelector(".msg.assistant", { timeout: 15000 });
  const r = await page.evaluate(() => ({
    thinkingGone: !document.querySelector(".thinking"),
    text: document.querySelector(".msg.assistant").innerText,
    href: document.querySelector(".msg.assistant a")?.href,
    injected: !!document.querySelector(".msg.assistant b"),
    users: [...document.querySelectorAll(".msg.user")].map((e) => e.innerText),
  }));
  console.log(JSON.stringify(r));
  if (!r.thinkingGone || r.injected || r.href !== "https://example.com/x?y=1" || !r.text.startsWith("收到：你好")) throw new Error("UI assertion failed");
  await page.reload(); await page.waitForSelector(".msg.assistant");
  console.log("history restored after reload: true");
  await page.click("#newChat"); await page.waitForSelector(".empty");
  const left = await page.evaluate(() => document.querySelectorAll(".msg").length);
  console.log("messages after New chat:", left);
  await page.reload(); await page.waitForSelector(".empty");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log("dark bg:", bg, "events:", events.length, "page errors:", JSON.stringify(errors));
  if (left !== 0 || errors.length) throw new Error("UI assertion failed");
  console.log("UI SMOKE OK"); await browser.close(); done(0);
} catch (e) { console.error("UI SMOKE FAIL", e); await browser.close(); done(1); }
