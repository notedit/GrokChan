#!/usr/bin/env node
/**
 * Manual smoke: start wrangler dev (workerd), call POST /api/dev/elevenlabs-smoke.
 * Validates outbound fetch+Upgrade to ElevenLabs from inside the Worker.
 *   ELEVENLABS_API_KEY=... node scripts/elevenlabs-worker-smoke.mjs
 * Never prints the key. Not part of `npm test`.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.log("FAIL ELEVENLABS_API_KEY is not set");
  process.exit(2);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => res(port));
    });
  });
}

const port = await freePort();
const inspector = await freePort();
const persist = mkdtempSync(join(tmpdir(), "gc-el-smoke-"));
const pass = "smoke-passcode-local";
const mcp = "smoke-mcp-key-local";
const args = [
  "dev",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--inspector-port", String(inspector),
  "--persist-to", persist,
  "--log-level", "error",
  "--var", `PUBLIC_ORIGIN:http://127.0.0.1:${port}`,
  "--var", `SITE_PASSCODE:${pass}`,
  "--var", `MCP_API_KEY:${mcp}`,
  "--var", "STACKCHAN_ENABLED:true",
  "--var", "TTS_PROVIDER:elevenlabs",
  "--var", "ASR_PROVIDER:elevenlabs",
  "--var", `ELEVENLABS_API_KEY:${key}`,
];
if (process.env.ELEVENLABS_VOICE_ID) args.push("--var", `ELEVENLABS_VOICE_ID:${process.env.ELEVENLABS_VOICE_ID}`);
if (process.env.ELEVENLABS_TTS_MODEL) args.push("--var", `ELEVENLABS_TTS_MODEL:${process.env.ELEVENLABS_TTS_MODEL}`);
if (process.env.ELEVENLABS_ASR_MODEL) args.push("--var", `ELEVENLABS_ASR_MODEL:${process.env.ELEVENLABS_ASR_MODEL}`);

const bin = resolve(root, "node_modules/.bin/wrangler");
const child = spawn(bin, args, {
  cwd: root,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    console.log("FAIL wrangler exited early");
    console.log(out.slice(-2000));
    process.exit(1);
  }
  try {
    const r = await fetch(base + "/api/health");
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 400));
}
if (!ready) {
  child.kill("SIGKILL");
  console.log("FAIL wrangler not ready");
  console.log(out.slice(-2000));
  process.exit(1);
}

let status = 0;
let body = {};
try {
  const r = await fetch(base + "/api/dev/elevenlabs-smoke", {
    method: "POST",
    headers: { "x-passcode": pass, "content-type": "application/json" },
    body: "{}",
  });
  status = r.status;
  body = await r.json();
} catch (e) {
  console.log("FAIL request:", e instanceof Error ? e.message : e);
  status = 0;
}

const stop = () =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.kill("SIGTERM");
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
await stop();
rmSync(persist, { recursive: true, force: true });

console.log(`HTTP ${status}`);
console.log(JSON.stringify(body, null, 2));
if (!body?.ok) {
  if (body?.note) console.log("NOTE:", body.note);
  console.log("HINT: if workerd blocks outbound Upgrade, use: npm run smoke:elevenlabs (Node path)");
  process.exit(1);
}
console.log("OK worker elevenlabs smoke");
process.exit(0);
