import type { AgentDeliveryResult, AgentProvider, InboundChat, ReplyTarget } from "./types";

/** Env slice required by the Grok Bot webhook adapter. */
export interface GrokBotEnv {
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_KEY: string;
  GROK_WEBHOOK_HEADER?: string;
  GROK_WEBHOOK_SCHEME?: string;
  WEBHOOK_MAX_ATTEMPTS?: string;
  RETRY_BASE_MS?: string;
}

/**
 * Wire format kept as `grokbot-web.inbound.v1` so existing Grok Bot webhook
 * routines (built for the web-chat bridge) keep working without changes.
 */
export const GROKBOT_INBOUND_SCHEMA = "grokbot-web.inbound.v1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function intVar(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function createGrokBotProvider(env: GrokBotEnv): AgentProvider {
  return {
    id: "grokbot",
    async deliver(inbound: InboundChat, reply: ReplyTarget): Promise<AgentDeliveryResult> {
      const headerName = (env.GROK_WEBHOOK_HEADER || "Authorization").trim();
      const scheme = (env.GROK_WEBHOOK_SCHEME ?? "Bearer").trim() || "Bearer";
      const headerValue =
        scheme.toLowerCase() === "raw" ? env.GROK_WEBHOOK_KEY : `${scheme} ${env.GROK_WEBHOOK_KEY}`;
      const maxAttempts = intVar(env.WEBHOOK_MAX_ATTEMPTS, 4);
      const base = intVar(env.RETRY_BASE_MS, 500);
      const payload = {
        schema: GROKBOT_INBOUND_SCHEMA,
        session_id: inbound.session_id,
        message: inbound.message,
        history: inbound.history,
        reply,
      };
      const body = JSON.stringify(payload);
      let status = 0;
      let detail = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let retryAfterMs = 0;
        try {
          const res = await fetch(env.GROK_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json", [headerName]: headerValue },
            body,
            signal: AbortSignal.timeout(20_000),
          });
          status = res.status;
          if (res.ok) {
            await res.body?.cancel();
            return { ok: true, status };
          }
          detail = (await res.text().catch(() => "")).slice(0, 300);
          if (status !== 429 && status < 500) return { ok: false, status, detail };
          const ra = Number(res.headers.get("retry-after"));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 5000);
        } catch {
          status = 0;
        }
        if (attempt < maxAttempts) await sleep(Math.max(retryAfterMs, base * 2 ** (attempt - 1)));
      }
      return { ok: false, status, detail };
    },
  };
}
