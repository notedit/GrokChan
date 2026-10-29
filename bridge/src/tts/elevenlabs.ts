import { elevenConfig, ELEVEN_PCM_RATES, type ElevenDeps, type ElevenLabsEnv } from "../elevenlabs/config";
import { AsyncQueue } from "../net/queue";
import { b64decode, textOf, workersWsConnector, type WsLike } from "../net/ws";
import { TtsError, type TtsInputSession, type TtsProvider, type TtsRequest, type TtsResult, type TtsStreamRequest } from "./types";

/**
 * ElevenLabs streaming TTS over the WebSocket `stream-input` API
 * (wss://<host>/v1/text-to-speech/{voice_id}/stream-input, docs: api-reference/text-to-speech/
 * v-1-text-to-speech-voice-id-stream-input).
 *
 *  - auth: `xi-api-key` header on the upgrade request (never in the URL / logs)
 *  - output_format=pcm_16000 (or another PCM rate the device accepts), auto_mode=true (stable default: flush each sentence without waiting for more text; pairs with stream.ts sentence push) so a sentence
 *    is synthesized as soon as it arrives instead of waiting for the chunk_length_schedule buffer
 *  - openInputStream(): text is pushed with sendText(), audio comes out of `chunks` as base64 JSON
 *    messages arrive; end() sends the empty-string close message (flushes the buffer)
 *  - abort(): the socket is closed immediately and all later audio is discarded
 * Only the streaming path exists: there is no whole-file synthesize() on this provider beyond a
 * convenience wrapper that drains the stream.
 */
export function createElevenLabsTts(env: ElevenLabsEnv, deps: ElevenDeps = {}): TtsProvider {
  const provider: TtsProvider = {
    id: "elevenlabs",

    async openInputStream(req: TtsStreamRequest): Promise<TtsInputSession> {
      let cfg;
      try {
        cfg = elevenConfig(env);
      } catch (e) {
        throw new TtsError(e instanceof Error ? e.message : "elevenlabs not configured");
      }
      const rate = pickRate(req);
      if (!rate) throw new TtsError("device accepts no PCM rate elevenlabs can produce", "unsupported");
      const voice = req.voice ?? cfg.voiceId;
      if (!/^[A-Za-z0-9]{8,64}$/.test(voice)) throw new TtsError("invalid elevenlabs voice id");
      const q = new URLSearchParams({ model_id: cfg.ttsModel, output_format: `pcm_${rate}`, auto_mode: "true", inactivity_timeout: "60" });
      const url = `wss://${cfg.host}/v1/text-to-speech/${voice}/stream-input?${q}`;

      if (req.signal?.aborted) throw new TtsError("aborted");
      let ws: WsLike;
      try {
        ws = await (deps.connect ?? workersWsConnector)(url, { "xi-api-key": cfg.apiKey });
      } catch (e) {
        throw new TtsError(e instanceof Error ? e.message : "elevenlabs connect failed");
      }

      const out = new AsyncQueue<Uint8Array>();
      let closed = false;
      let sawFinal = false;
      let gotAudio = false;
      let carry: Uint8Array | null = null; // keep 16-bit samples aligned across messages
      const shut = (how: "end" | "abort" | { error: Error }) => {
        if (closed) return;
        closed = true;
        try {
          ws.close(1000, how === "abort" ? "aborted" : "done");
        } catch {}
        if (how === "abort") out.discard();
        else if (how === "end") out.close();
        else out.fail(how.error);
      };
      ws.addEventListener("message", (ev) => {
        if (closed) return;
        const raw = textOf(ev.data);
        if (!raw) return;
        let m: { audio?: string | null; isFinal?: boolean; error?: unknown; message?: unknown; detail?: unknown };
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        if (m.error !== undefined || (m.detail !== undefined && !m.audio)) {
          const msg = String(typeof m.message === "string" ? m.message : typeof m.error === "string" ? m.error : "error").slice(0, 200);
          return shut({ error: new TtsError("elevenlabs: " + msg) });
        }
        if (typeof m.audio === "string" && m.audio.length > 0) {
          let a = b64decode(m.audio);
          if (carry) {
            const merged = new Uint8Array(carry.byteLength + a.byteLength);
            merged.set(carry);
            merged.set(a, carry.byteLength);
            a = merged;
            carry = null;
          }
          if (a.byteLength % 2) {
            carry = a.slice(a.byteLength - 1);
            a = a.subarray(0, a.byteLength - 1);
          }
          if (a.byteLength) {
            gotAudio = true;
            out.push(a);
          }
        }
        if (m.isFinal === true) {
          sawFinal = true;
          shut("end");
        }
      });
      ws.addEventListener("error", () => shut({ error: new TtsError("elevenlabs: socket error") }));
      ws.addEventListener("close", (ev) => {
        if (closed) return;
        if (sawFinal || gotAudio) shut("end");
        else shut({ error: new TtsError(`elevenlabs: socket closed before audio (${ev.code ?? 0})`) });
      });
      const send = (obj: unknown) => {
        if (!closed) ws.send(JSON.stringify(obj));
      };
      send({ text: " ", voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 } });
      req.signal?.addEventListener("abort", () => shut("abort"), { once: true });

      return {
        format: "pcm_s16le",
        sampleRate: rate,
        channels: 1,
        provider: "elevenlabs",
        voice,
        chunks: out,
        sendText(text) {
          const t = text.replace(/\s+/g, " ").trim();
          if (t) send({ text: t + " " });
        },
        end() {
          send({ text: "" });
        },
        abort() {
          shut("abort");
        },
      };
    },

    /** Convenience: drain the stream (not used by the voice pipeline). */
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      const s = await provider.openInputStream!(req);
      s.sendText(req.text);
      s.end();
      const parts: Uint8Array[] = [];
      let n = 0;
      for await (const c of s.chunks) {
        parts.push(c);
        n += c.byteLength;
      }
      const audio = new Uint8Array(n);
      let at = 0;
      for (const p of parts) {
        audio.set(p, at);
        at += p.byteLength;
      }
      return { audio, format: "pcm_s16le", sampleRate: s.sampleRate ?? 16000, channels: 1, provider: "elevenlabs", voice: s.voice, cached: false };
    },
  };
  return provider;
}

function pickRate(req: TtsRequest): number | undefined {
  for (const a of req.accept) {
    if (a.format !== "pcm_s16le" || (a.channels ?? 1) !== 1) continue;
    const r = a.sample_rate ?? 16000;
    if ((ELEVEN_PCM_RATES as readonly number[]).includes(r)) return r;
  }
  return undefined;
}
