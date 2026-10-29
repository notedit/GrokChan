/**
 * Runs inside the Worker (workerd) to verify outbound `fetch` + `Upgrade: websocket`
 * to ElevenLabs ASR + TTS. Invoked by POST /api/dev/elevenlabs-smoke (SITE_PASSCODE).
 * Never logs or returns the API key.
 */
import { createElevenLabsAsr } from "../asr/elevenlabs";
import { createElevenLabsTts } from "../tts/elevenlabs";
import type { ElevenLabsEnv } from "../elevenlabs/config";

export interface WorkerSmokeResult {
  ok: boolean;
  runtime: "workerd";
  tts?: { ok: boolean; connect_ms?: number; first_audio_ms?: number; total_ms?: number; bytes?: number; error?: string };
  asr?: { ok: boolean; first_partial_ms?: number; partials?: number; transcript?: string; error?: string };
  note?: string;
}

const TEXT = "Hello from the Cloudflare Worker smoke test.";

export async function runElevenLabsWorkerSmoke(env: ElevenLabsEnv): Promise<WorkerSmokeResult> {
  // Default connector is workersWsConnector (fetch + Upgrade) — that is what we are validating.
  const tts = createElevenLabsTts(env);
  const asr = createElevenLabsAsr(env);
  const out: WorkerSmokeResult = { ok: false, runtime: "workerd" };
  const now = () => Date.now();

  const pcm: Uint8Array[] = [];
  let bytes = 0;
  try {
    const t0 = now();
    const s = await tts.openInputStream!({
      text: "",
      accept: [{ format: "pcm_s16le", sample_rate: 16000, channels: 1 }],
    });
    const tConn = now() - t0;
    for (const sentence of TEXT.split(/(?<=\.)\s+/)) s.sendText(sentence);
    s.end();
    let first = -1;
    for await (const c of s.chunks) {
      if (first < 0) first = now() - t0;
      pcm.push(c);
      bytes += c.byteLength;
    }
    out.tts = { ok: bytes > 0, connect_ms: tConn, first_audio_ms: first, total_ms: now() - t0, bytes };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "tts_error";
    out.tts = { ok: false, error: msg };
    out.note = msg.includes("upgrade") || msg.includes("websocket") || msg.includes("Upgrade")
      ? "workerd may not support outbound WebSocket Upgrade; use Node smoke (npm run smoke:elevenlabs) as fallback"
      : undefined;
    return out;
  }

  if (bytes === 0) {
    out.tts = { ...(out.tts ?? { ok: false }), ok: false, error: "no_audio" };
    return out;
  }

  try {
    const all = new Uint8Array(bytes);
    let at = 0;
    for (const p of pcm) {
      all.set(p, at);
      at += p.byteLength;
    }
    const t0 = now();
    let firstPartial = -1;
    let partials = 0;
    const ac = new AbortController();
    const sess = asr.start({
      format: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      lang: "en",
      signal: ac.signal,
      onPartial: () => {
        if (firstPartial < 0) firstPartial = now() - t0;
        partials++;
      },
    });
    for (let o = 0; o < all.length; o += 3200) {
      sess.push(all.subarray(o, Math.min(all.length, o + 3200)));
      await new Promise((r) => setTimeout(r, 10));
    }
    const r = await Promise.race([
      sess.finish(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("asr final timeout 20 s")), 20_000)),
    ]);
    out.asr = {
      ok: r.text.length > 0,
      first_partial_ms: firstPartial,
      partials,
      transcript: r.text.slice(0, 200),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "asr_error";
    out.asr = { ok: false, error: msg };
    out.note = msg.includes("upgrade") || msg.includes("websocket")
      ? "workerd may not support outbound WebSocket Upgrade; use Node smoke (npm run smoke:elevenlabs) as fallback"
      : undefined;
    return out;
  }

  out.ok = !!(out.tts?.ok && out.asr?.ok);
  return out;
}
