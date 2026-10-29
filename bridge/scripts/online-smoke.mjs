#!/usr/bin/env node
/**
 * Online smoke against a DEPLOYED bridge using a simulated Stack-chan (Node >= 22: global WebSocket w/ headers).
 *   node scripts/online-smoke.mjs                 # reads /home/box/secrets/grokchan.env (or GC_ENV_FILE)
 *   GC_SMOKE_SKIP_AGENT=1 node ...                # do not send the real test message to grokbot
 * Secrets are read from the env file and NEVER printed. The voice step sends exactly ONE test message to grokbot.
 */
import { readFileSync } from "node:fs";

const ENV_FILE = process.env.GC_ENV_FILE || "/home/box/secrets/grokchan.env";
const E = {};
for (const l of readFileSync(ENV_FILE, "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(l);
  if (m) E[m[1]] = m[2];
}
const BASE = (E.GC_ORIGIN || "").replace(/\/$/, "");
const DEVICE = E.GC_DEVICE_ID || "stackchan-01";
const TOKEN = E.GC_DEVICE_TOKEN;
const MCP_KEY = E.MCP_API_KEY;
for (const [k, v] of Object.entries({ GC_ORIGIN: BASE, GC_DEVICE_TOKEN: TOKEN, MCP_API_KEY: MCP_KEY, ELEVENLABS_API_KEY: E.ELEVENLABS_API_KEY })) if (!v) throw new Error("missing " + k + " in env file");
const TEST_PHRASE = process.env.GC_SMOKE_PHRASE || "GrokChan integration test, please ignore this message.";

const results = [];
const now = () => performance.now();
const ms = (t0) => Math.round(now() - t0);
function rec(name, ok, detail = "", lat) {
  results.push({ name, ok, detail, lat });
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${name}${lat !== undefined ? ` [${lat} ms]` : ""}${detail ? "  - " + detail : ""}`);
}
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function waitFor(fn, t = 8000, step = 20) {
  const end = now() + t;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (now() > end) throw new Error("timeout");
    await sleep(step);
  }
}

// ---- frame helpers (mediasession-rpc/1): type u8 | flags u8 | stream u16 LE | seq u32 LE | payload
function frame(type, stream, seq, payload, last) {
  const b = new ArrayBuffer(8 + payload.byteLength);
  const dv = new DataView(b);
  dv.setUint8(0, type);
  dv.setUint8(1, last ? 1 : 0);
  dv.setUint16(2, stream, true);
  dv.setUint32(4, seq, true);
  new Uint8Array(b, 8).set(payload);
  return b;
}

class Sim {
  constructor(token) {
    this.token = token;
    this.log = [];
    this.bin = [];
    this.closed = null;
    this.n = 0;
    this.vol = 40;
  }
  async connect() {
    const headers = { "Device-Id": DEVICE };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    this.ws = new WebSocket(`${BASE.replace("https", "wss")}/ws/device?device_id=${DEVICE}`, { headers });
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (ev) => this.onMsg(ev.data));
    this.ws.addEventListener("close", (ev) => (this.closed = { code: ev.code, reason: ev.reason }));
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
      this.ws.addEventListener("close", () => rej(new Error("ws closed before open")), { once: true });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }
  async request(method, params) {
    const id = "d_" + ++this.n;
    this.send({ jsonrpc: "2.0", id, method, params });
    return waitFor(() => this.log.find((x) => x.id === id && !x.method), 8000);
  }
  async hello() {
    return this.request("session.hello", {
      protocol: "mediasession-rpc/1", device_id: DEVICE, fw: "0.1.0-online-smoke", hw: "m5stack-stackchan",
      caps: ["head", "led", "display", "speaker", "mic"],
      limits: { pan: [-90, 90], tilt: [0, 60], volume_cap: 70 },
      expressions: ["neutral", "happy", "sad", "angry", "surprised", "sleepy", "confused", "love", "wink"],
      audio: { play: [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }], max_chunk_bytes: 4096, buffer_ms: 2000 },
    });
  }
  notes(m) { return this.log.filter((x) => x.method === m && x.id === undefined); }
  states() { return this.notes("turn.state").map((x) => x.params.state + (x.params.reason ? ":" + x.params.reason : "")); }
  onMsg(data) {
    if (typeof data !== "string") {
      const dv = new DataView(data);
      this.bin.push({ t: now(), type: dv.getUint8(0), flags: dv.getUint8(1), stream: dv.getUint16(2, true), seq: dv.getUint32(4, true), bytes: data.byteLength - 8 });
      return;
    }
    const msg = JSON.parse(data);
    msg._t = now();
    this.log.push(msg);
    if (msg.method && msg.id !== undefined) return this.handle(msg);
    if (msg.method === "audio.begin" && msg.params.direction !== "uplink") this.notify("playback.state", { stream_id: msg.params.stream_id, state: "started" });
    if (msg.method === "audio.end" && msg.params.reason === "complete") this.notify("playback.state", { stream_id: msg.params.stream_id, state: "ended" });
  }
  handle(r) {
    const p = r.params || {};
    const ok = (result) => this.send({ jsonrpc: "2.0", id: r.id, result });
    switch (r.method) {
      case "device.get_status": return ok({ battery: { percent: 87, charging: false }, volume: this.vol, muted: false, pose: { pan: 0, tilt: 0 }, expression: "neutral", uptime_s: 12 });
      case "device.move_head": return ok({ pan: p.pan ?? 0, tilt: p.tilt ?? 0 });
      case "device.reset_pose": return ok({ pan: 0, tilt: 0 });
      case "device.set_expression": return ok({ expression: p.expression });
      case "device.show_text": return ok({ shown: !p.clear, truncated: false });
      case "device.set_led": return ok({ applied_rgb: { r: Math.min(p.r ?? 0, 168), g: Math.min(p.g ?? 0, 168), b: Math.min(p.b ?? 0, 168) } });
      case "device.speak": return ok({ accepted: true, stream_id: p.stream_id, queue_position: 0 });
      case "device.stop_audio": return ok({ stopped: p.stream_id ? [p.stream_id] : [], cleared: 0 });
      case "device.set_volume": this.vol = p.volume ?? this.vol; return ok({ volume: this.vol, muted: p.mute ?? false });
      case "device.emergency_stop": return ok({ motion_halted: true, audio_stopped: true });
      default: return this.send({ jsonrpc: "2.0", id: r.id, error: { code: -32601, message: "Method not found" } });
    }
  }
  close() { try { this.ws.close(1000); } catch {} }
}

// ---- MCP
let rid = 0;
async function mcpPost(body, key = MCP_KEY) {
  const t0 = now();
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, lat: ms(t0) };
}
async function tool(name, args = {}) {
  const r = await mcpPost({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } });
  return { ...r, env: r.json?.result?.structuredContent, isError: !!r.json?.result?.isError };
}

async function elevenlabsPcm(text) {
  const voice = E.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
  const t0 = now();
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": E.ELEVENLABS_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
  });
  if (!r.ok) throw new Error("elevenlabs tts http " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { buf, lat: ms(t0) };
}

async function main() {
  console.log("target:", BASE, " device:", DEVICE);

  // 0. health
  let t0 = now();
  const h = await (await fetch(BASE + "/api/health")).json();
  rec("health", h.ok && h.stackchan && h.mcp_auth && h.configured, `configured=${h.configured} stackchan=${h.stackchan} mcp_auth=${h.mcp_auth}`, ms(t0));

  // 1. wrong token -> 4003
  {
    const bad = new Sim("wrong-token-for-smoke-test");
    t0 = now();
    let note = "";
    try { await bad.connect(); await waitFor(() => bad.closed, 5000); } catch (e) { note = String(e.message); await sleep(300); }
    // Workers upgrade handshake may be accepted then closed with 4003, or rejected with HTTP 401 before open.
    rec("device wrong token rejected (close 4003 / HTTP 401)", bad.closed?.code === 4003 || /closed before open|ws error/.test(note), `close=${bad.closed?.code ?? "n/a"} ${note}`, ms(t0));
    bad.close();
  }
  {
    const none = new Sim(null);
    t0 = now();
    let note = "";
    try { await none.connect(); await waitFor(() => none.closed, 5000); } catch (e) { note = String(e.message); await sleep(300); }
    rec("device no token rejected", none.closed?.code === 4003 || /closed before open|ws error/.test(note), `close=${none.closed?.code ?? "n/a"} ${note}`, ms(t0));
  }

  // 2. correct token -> hello
  const dev = new Sim(TOKEN);
  t0 = now();
  await dev.connect();
  const tConn = ms(t0);
  t0 = now();
  const hello = await dev.hello();
  const hr = hello.result;
  rec("ws connect (TLS+upgrade)", true, "", tConn);
  rec("session.hello ok", !!hr && !hello.error, hello.error ? JSON.stringify(hello.error) : `keys=${Object.keys(hr).join(",")}`, ms(t0));
  rec("hello advertises voice.uplink", !!hr?.voice?.uplink, hr?.voice?.uplink ? `uplink=${JSON.stringify(hr.voice.uplink)}` : "voice.uplink missing (ASR_PROVIDER?)");

  // 3. MCP
  let r = await mcpPost({ jsonrpc: "2.0", id: ++rid, method: "tools/list" }, null);
  rec("mcp no key -> 401", r.status === 401, `status=${r.status}`, r.lat);
  r = await mcpPost({ jsonrpc: "2.0", id: ++rid, method: "tools/list" }, "wrong-key-smoke");
  rec("mcp wrong key -> 401", r.status === 401, `status=${r.status}`, r.lat);
  r = await mcpPost({ jsonrpc: "2.0", id: ++rid, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "online-smoke", version: "0" } } });
  rec("mcp initialize", r.status === 200 && !!r.json?.result, `status=${r.status}`, r.lat);
  r = await mcpPost({ jsonrpc: "2.0", id: ++rid, method: "tools/list" });
  const names = (r.json?.result?.tools || []).map((x) => x.name);
  const want = ["list_devices", "get_device_status", "move_head", "reset_pose", "set_expression", "show_text", "set_led", "speak", "stop_audio", "set_volume", "emergency_stop"];
  rec("mcp tools/list", want.every((n) => names.includes(n)), `${names.length} tools`, r.lat);

  const checks = [
    ["list_devices", {}, (e) => e.result.devices.some((d) => d.device_id === DEVICE && d.online !== false)],
    ["get_device_status", { device_id: DEVICE, fresh: true }, (e) => e.ok],
    ["move_head", { device_id: DEVICE, pan: 20, tilt: 10 }, (e) => e.ok],
    ["reset_pose", { device_id: DEVICE }, (e) => e.ok],
    ["set_expression", { device_id: DEVICE, expression: "happy" }, (e) => e.ok],
    ["show_text", { device_id: DEVICE, text: "GrokChan online" }, (e) => e.ok],
    ["set_led", { device_id: DEVICE, color: "#00aa44" }, (e) => e.ok],
    ["set_volume", { device_id: DEVICE, volume: 30 }, (e) => e.ok],
  ];
  for (const [name, args, pred] of checks) {
    const x = await tool(name, args);
    let ok = false;
    try { ok = !!x.env && !x.isError && pred(x.env); } catch {}
    rec(`mcp ${name}`, ok, ok ? "" : JSON.stringify(x.env?.error ?? x.json).slice(0, 200), x.lat);
  }

  // speak with real ElevenLabs TTS
  {
    dev.bin.length = 0;
    const nBefore = dev.notes("audio.begin").length;
    const x = await tool("speak", { device_id: DEVICE, text: "Hello from GrokChan. The bridge is online.", wait: "done", timeout_ms: 20000 });
    const begin = dev.notes("audio.begin").slice(nBefore)[0];
    const down = dev.bin.filter((b) => b.type === 1);
    const bytes = down.reduce((a, b) => a + b.bytes, 0);
    const first = down[0] && begin ? Math.round(down[0].t - begin._t) : undefined;
    rec("mcp speak (real ElevenLabs TTS -> downlink PCM frames)", !!x.env?.ok && bytes > 8000, `ok=${x.env?.ok} frames=${down.length} bytes=${bytes} (~${Math.round(bytes / 32)} ms audio) first_frame_after_begin=${first}ms ${x.env?.ok ? "" : JSON.stringify(x.env?.error)}`, x.lat);
  }
  {
    const x = await tool("stop_audio", { device_id: DEVICE });
    rec("mcp stop_audio", !!x.env?.ok, x.env?.ok ? "" : JSON.stringify(x.env?.error), x.lat);
    const y = await tool("emergency_stop", { device_id: DEVICE });
    rec("mcp emergency_stop", !!y.env?.ok, y.env?.ok ? "" : JSON.stringify(y.env?.error), y.lat);
  }

  // 4. voice turn: synthesize PCM via ElevenLabs, upload as uplink, ASR -> (grokbot)
  if (!hr?.voice?.uplink) {
    rec("voice turn", false, "no uplink advertised");
  } else {
    const { buf: pcm, lat: synthLat } = await elevenlabsPcm(TEST_PHRASE);
    rec("synthesize input PCM16k via ElevenLabs REST", pcm.byteLength > 16000, `${pcm.byteLength} bytes (~${Math.round(pcm.byteLength / 32)} ms audio)`, synthLat);
    const skipAgent = !!process.env.GC_SMOKE_SKIP_AGENT;
    if (skipAgent) console.log("note: GC_SMOKE_SKIP_AGENT set; the turn will still forward to grokbot because the bridge always does.");
    const sid = 101;
    const chunk = Math.min(hr.voice.uplink.max_chunk_bytes || 3200, 3200); // 100 ms
    dev.notify("event.speech_start", {});
    const tStart = now();
    dev.notify("audio.begin", { stream_id: sid, direction: "uplink", format: "pcm_s16le", sample_rate: 16000, channels: 1, lang: "en" });
    let seq = 0;
    for (let off = 0; off < pcm.byteLength; off += chunk, seq++) {
      dev.ws.send(frame(0x02, sid, seq, pcm.subarray(off, Math.min(off + chunk, pcm.byteLength)), false));
      await sleep(40); // ~2.5x real time; a real device streams at 1x
    }
    dev.notify("audio.end", { stream_id: sid, reason: "complete", total_chunks: seq });
    dev.notify("event.speech_end", {});
    const tEnd = now();
    const finalT = await waitFor(() => dev.notes("asr.transcript").find((x) => x.params.final), 15000).catch(() => null);
    const firstPartial = dev.notes("asr.transcript").find((x) => !x.params.final);
    rec("voice: first partial transcript", !!firstPartial, firstPartial ? `"${firstPartial.params.text}"` : "none", firstPartial ? Math.round(firstPartial._t - tStart) : undefined);
    rec("voice: final transcript after audio.end", !!finalT, finalT ? `"${finalT.params.text}"` : "none", finalT ? Math.round(finalT._t - tEnd) : undefined);
    const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "");
    rec("voice: transcript matches input", !!finalT && norm(finalT.params.text).includes("integration test"), "");
    // forward to grokbot: bridge goes transcribing -> thinking after POSTing the webhook; failures show as idle:<reason>
    const think = await waitFor(() => dev.states().includes("thinking") || dev.states().some((s) => s.startsWith("idle:")), 15000).catch(() => null);
    const st = dev.states();
    rec("voice: forwarded to grokbot webhook (2xx => thinking)", st.includes("thinking"), `turn.state=${JSON.stringify(st)}`, undefined);
    // wait for the (real) reply, if the main bot answers via reply.url -> TTS -> downlink
    const tReply0 = now();
    const done = await waitFor(() => dev.states().includes("speaking") || dev.states().some((s, i) => i > 0 && s.startsWith("idle:") && dev.states().includes("thinking")), 90000, 200).catch(() => null);
    if (done && dev.states().includes("speaking")) {
      await waitFor(() => dev.states().at(-1)?.startsWith("idle"), 60000, 200).catch(() => {});
      const bytes = dev.bin.filter((b) => b.type === 1 && b.stream !== sid).reduce((a, b) => a + b.bytes, 0);
      rec("voice: grokbot reply -> TTS -> downlink", true, `turn.state=${JSON.stringify(dev.states())} reply_audio_bytes=${bytes}`, ms(tReply0));
    } else {
      rec("voice: grokbot reply -> TTS -> downlink", null, `no reply within 90s (grokbot may not answer or reply asynchronously); turn.state=${JSON.stringify(dev.states())}`);
    }
  }

  dev.close();
  const fails = results.filter((x) => x.ok === false);
  console.log(`\n${results.length - fails.length}/${results.length} passed/skipped, ${fails.length} failed`);
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(2); });
