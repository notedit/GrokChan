/**
 * Manual smoke test against the real ElevenLabs API (NOT part of `npm test`).
 *   ELEVENLABS_API_KEY=... node scripts/elevenlabs-smoke.mjs
 * Streams TTS (WebSocket stream-input), feeds the audio back into streaming ASR (Scribe realtime),
 * then checks that aborting a TTS stream closes it. Prints only OK/FAIL, latencies and the
 * transcript of the synthetic sentence; the key is read from process.env and never printed.
 */
import { createElevenLabsAsr } from "../src/asr/elevenlabs";
import { createElevenLabsTts } from "../src/tts/elevenlabs";
import type { WsConnector, WsLike } from "../src/net/ws";

const env = { ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID, ELEVENLABS_TTS_MODEL: process.env.ELEVENLABS_TTS_MODEL, ELEVENLABS_ASR_MODEL: process.env.ELEVENLABS_ASR_MODEL, ELEVENLABS_HOST: process.env.ELEVENLABS_HOST };

// Node 22's global WebSocket (undici) accepts `{ headers }`; Workers use fetch() + Upgrade instead.
const connect: WsConnector = (url, headers) =>
  new Promise<WsLike>((resolve, reject) => {
    const WS = WebSocket as unknown as new (u: string, o: { headers: Record<string, string> }) => WsLike & { addEventListener(t: "open", f: () => void, o?: { once: boolean }): void };
    const ws = new WS(url, { headers });
    ws.addEventListener("open", () => resolve(ws), { once: true });
    (ws as unknown as EventTarget).addEventListener("error", () => reject(new Error("websocket connect failed (auth refused or network)")), { once: true });
  });

const TEXT = "Hello, this is a streaming speech test. The robot can hear you now.";
const ms = () => Math.round(performance.now());
let failed = 0;
const report = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${detail}`);
};

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.log("FAIL ELEVENLABS_API_KEY is not set");
    process.exit(2);
  }
  const tts = createElevenLabsTts(env, { connect });
  const asr = createElevenLabsAsr(env, { connect });

  // 1) streaming TTS
  const pcm: Uint8Array[] = [];
  let bytes = 0;
  try {
    const t0 = ms();
    const s = await tts.openInputStream!({ text: "", accept: [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }] });
    const tConn = ms() - t0;
    for (const sentence of TEXT.split(/(?<=\.)\s+/)) s.sendText(sentence);
    s.end();
    let first = -1;
    let n = 0;
    for await (const c of s.chunks) {
      if (first < 0) first = ms() - t0;
      pcm.push(c);
      bytes += c.byteLength;
      n++;
    }
    report("tts stream", bytes > 0, `connect ${tConn} ms, first audio ${first} ms, total ${ms() - t0} ms, ${n} chunks, ${bytes} B = ${Math.round(bytes / 32)} ms @16k, voice ${s.voice}`);
  } catch (e) {
    report("tts stream", false, e instanceof Error ? e.message : "error");
  }

  // 2) streaming ASR fed with the TTS audio (100 ms frames, no pacing)
  if (bytes > 0) {
    try {
      const all = new Uint8Array(bytes);
      let at = 0;
      for (const p of pcm) {
        all.set(p, at);
        at += p.byteLength;
      }
      const t0 = ms();
      const ac = new AbortController();
      let firstPartial = -1;
      let partials = 0;
      const sess = asr.start({ format: "pcm_s16le", sampleRate: 16000, channels: 1, lang: "en", signal: ac.signal, onPartial: () => (firstPartial < 0 ? (firstPartial = ms() - t0) : 0, partials++) });
      for (let o = 0; o < all.length; o += 3200) {
        sess.push(all.subarray(o, Math.min(all.length, o + 3200)));
        await new Promise((r) => setTimeout(r, 20));
      }
      const tEnd = ms();
      const r = await Promise.race([sess.finish(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("asr final timeout 15 s")), 15000))]);
      report("asr stream", r.text.length > 0, `first partial ${firstPartial} ms (${partials} partials), final ${ms() - tEnd} ms after last frame, transcript: ${JSON.stringify(r.text)}`);
    } catch (e) {
      report("asr stream", false, e instanceof Error ? e.message : "error");
    }
  }

  // 3) barge-in: abort a TTS stream after the first chunk; the iterator must end quickly
  try {
    const ac = new AbortController();
    const s = await tts.openInputStream!({ text: "", accept: [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }], signal: ac.signal });
    s.sendText("This is a long sentence that will be interrupted before it finishes playing back to the user.");
    s.sendText("And a second sentence that must never be synthesized.");
    s.end();
    let got = 0;
    let tAbort = 0;
    for await (const c of s.chunks) {
      got += c.byteLength;
      if (!tAbort) {
        tAbort = ms();
        ac.abort();
      }
    }
    report("tts abort", tAbort > 0, `iterator ended ${ms() - tAbort} ms after abort, ${got} B received before it`);
  } catch (e) {
    report("tts abort", false, e instanceof Error ? e.message : "error");
  }
  process.exit(failed ? 1 : 0);
}
void main();
