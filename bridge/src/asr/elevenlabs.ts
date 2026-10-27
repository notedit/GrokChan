import { DEFAULT_ASR_MODEL, elevenConfig, type ElevenDeps, type ElevenLabsEnv } from "../elevenlabs/config";
import { b64encode, textOf, workersWsConnector, type WsLike } from "../net/ws";
import { AsrError, type AsrProvider, type AsrResult, type AsrSession, type AsrStartOptions } from "./types";

/**
 * ElevenLabs Scribe realtime speech-to-text over WebSocket
 * (wss://<host>/v1/speech-to-text/realtime, docs: api-reference/speech-to-text/v-1-speech-to-text-realtime).
 *
 *  - auth: `xi-api-key` header (never in the URL), via fetch() + Upgrade on Workers
 *  - audio_format=pcm_16000, commit_strategy=manual: the device decides when the utterance ends
 *    (audio.end / speech_end), so finish() commits explicitly
 *  - every pushed uplink frame is forwarded immediately as a base64 `input_audio_chunk`
 *    (the newest frame is held back one step so finish() can send it with commit=true)
 *  - `partial_transcript` -> onPartial, `committed_transcript` -> final result
 *  - abort() / signal abort closes the upstream socket at once
 */
const ERROR_TYPES = new Set(["error", "auth_error", "quota_exceeded", "commit_throttled", "unaccepted_terms", "rate_limited", "queue_overflow", "resource_exhausted", "session_time_limit_exceeded", "input_error", "invalid_request", "chunk_size_exceeded", "transcriber_error"]);
const READY_TIMEOUT_MS = 5000;
const MAX_QUEUED = 600;

export function createElevenLabsAsr(env: ElevenLabsEnv, deps: ElevenDeps = {}): AsrProvider {
  return {
    id: "elevenlabs",
    start(opts: AsrStartOptions): AsrSession {
      const cfg = elevenConfig(env); // throws without a key -> the engine reports asr_unavailable
      if (opts.format !== "pcm_s16le" || opts.sampleRate !== 16000 || opts.channels !== 1) throw new AsrError("elevenlabs adapter expects 16 kHz mono pcm_s16le", "unsupported");
      const q = new URLSearchParams({ model_id: cfg.asrModel || DEFAULT_ASR_MODEL, audio_format: "pcm_16000", commit_strategy: "manual" });
      const lang = opts.lang?.split(/[-_]/)[0]?.toLowerCase();
      if (lang && /^[a-z]{2,3}$/.test(lang)) q.set("language_code", lang);
      const url = `wss://${cfg.host}/v1/speech-to-text/realtime?${q}`;

      let ws: WsLike | undefined;
      let ready = false;
      let settled = false;
      let finishing = false;
      let sentAny = false;
      let held: Uint8Array | undefined;
      const outbox: string[] = [];
      const committed: string[] = [];
      let resolveFinal!: (r: AsrResult) => void;
      let rejectFinal!: (e: unknown) => void;
      const finalP = new Promise<AsrResult>((res, rej) => {
        resolveFinal = res;
        rejectFinal = rej;
      });
      finalP.catch(() => {}); // surfaced through finish()
      let readyTimer: ReturnType<typeof setTimeout> | undefined;

      const closeWs = () => {
        if (readyTimer) clearTimeout(readyTimer);
        try {
          ws?.close(1000, "done");
        } catch {}
      };
      const fail = (e: unknown) => {
        if (settled) return;
        settled = true;
        closeWs();
        rejectFinal(e);
      };
      const succeed = (text: string) => {
        if (settled) return;
        settled = true;
        closeWs();
        resolveFinal({ text, ...(lang ? { lang } : {}), provider: "elevenlabs" });
      };
      const send = (msg: string) => {
        if (settled) return;
        if (ready && ws) ws.send(msg);
        else if (outbox.length < MAX_QUEUED) outbox.push(msg);
        else fail(new AsrError("elevenlabs: upstream not ready, uplink backlog too large"));
      };
      const chunkMsg = (pcm: Uint8Array, commit: boolean) => {
        sentAny = true;
        return JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64encode(pcm), commit, sample_rate: 16000 });
      };

      const onMessage = (data: unknown) => {
        const raw = textOf(data);
        if (!raw) return;
        let m: { message_type?: string; text?: string; error?: string };
        try {
          m = JSON.parse(raw);
        } catch {
          return;
        }
        const t = m.message_type ?? "";
        if (t === "session_started") {
          ready = true;
          if (readyTimer) clearTimeout(readyTimer);
          for (const o of outbox.splice(0)) ws?.send(o);
        } else if (t === "partial_transcript") {
          if (typeof m.text === "string" && m.text.trim()) opts.onPartial?.(m.text.trim());
        } else if (t === "committed_transcript" || t === "committed_transcript_with_timestamps") {
          if (typeof m.text === "string" && m.text.trim()) committed.push(m.text.trim());
          if (finishing) succeed(committed.join(" "));
        } else if (t === "insufficient_audio_activity") {
          if (finishing) succeed(committed.join(" "));
        } else if (ERROR_TYPES.has(t)) {
          fail(new AsrError(`elevenlabs ${t}${typeof m.error === "string" ? ": " + m.error.slice(0, 200) : ""}`));
        }
      };

      if (opts.signal.aborted) {
        fail(new AsrError("aborted", "aborted"));
      } else {
        opts.signal.addEventListener("abort", () => fail(new AsrError("aborted", "aborted")), { once: true });
        readyTimer = setTimeout(() => fail(new AsrError("elevenlabs: session_started timeout")), READY_TIMEOUT_MS);
        (deps.connect ?? workersWsConnector)(url, { "xi-api-key": cfg.apiKey }).then(
          (sock) => {
            ws = sock;
            if (settled) return closeWs();
            sock.addEventListener("message", (ev) => onMessage(ev.data));
            sock.addEventListener("error", () => fail(new AsrError("elevenlabs: socket error")));
            sock.addEventListener("close", (ev) => fail(new AsrError(`elevenlabs: socket closed (${ev.code ?? 0})`)));
          },
          (e) => fail(new AsrError(e instanceof Error ? e.message : "elevenlabs connect failed")),
        );
      }

      return {
        push(chunk) {
          if (settled || finishing || chunk.byteLength === 0) return;
          if (held) send(chunkMsg(held, false));
          held = chunk.slice();
        },
        finish() {
          if (!finishing) {
            finishing = true;
            if (!held && !sentAny) fail(new AsrError("elevenlabs: no audio"));
            else if (held) {
              send(chunkMsg(held, true));
              held = undefined;
            }
          }
          return finalP;
        },
        abort() {
          fail(new AsrError("aborted", "aborted"));
        },
      };
    },
  };
}
