import pageHtml from "./page.html";
import type { ChatHub } from "./hub";
import { getAgentProvider } from "./agents";
import { createDoGateway, type GatewayEnv } from "./device/do-gateway";
import { DEVICE_ID_RE, WS_CLOSE } from "./device/protocol";
import { handleMcp } from "./mcp/server";
import { DEFAULT_LIMITS, type Limits } from "./mcp/tools";
import { hmacHex, parseBearer, rejectWebSocket, safeEqual } from "./auth";

export { ChatHub } from "./hub";
export { DeviceHub } from "./device/hub";
export { DeviceRegistry } from "./device/registry";

export interface Env extends Partial<GatewayEnv> {
  HUB: DurableObjectNamespace<ChatHub>;
  PUBLIC_ORIGIN: string;
  /** Active agent: "grokbot" (default) or "muse" (stub). */
  AGENT_PROVIDER?: string;
  GROK_WEBHOOK_URL: string;
  GROK_WEBHOOK_KEY: string;
  GROK_WEBHOOK_HEADER?: string;
  GROK_WEBHOOK_SCHEME?: string;
  SITE_PASSCODE: string;
  /** Bearer key required on POST /mcp when STACKCHAN_ENABLED=true. Fail-closed if unset. */
  MCP_API_KEY?: string;
  // Optional tuning knobs (strings, as wrangler vars). Defaults in parentheses.
  RATE_LIMIT_PER_MIN?: string; // (20)
  TOKEN_TTL_SECONDS?: string; // (600)
  WEBHOOK_MAX_ATTEMPTS?: string; // (4)
  RETRY_BASE_MS?: string; // (500)
  /**
   * Stack-chan endpoints (/mcp, /ws/device). Off unless "true".
   * Production checklist: STACKCHAN_ENABLED=true + MCP_API_KEY + registered device tokens.
   * Voice stays off until ASR_PROVIDER / TTS_PROVIDER are set; firmware GC_VOICE_ENABLED defaults to 0.
   */
  STACKCHAN_ENABLED?: string;
  /** Soft limits for the MCP tools (defaults: pan -90..90, tilt 0..60, volume cap 70). */
  PAN_MIN?: string;
  PAN_MAX?: string;
  TILT_MIN?: string;
  TILT_MAX?: string;
  VOLUME_CAP?: string;
  /** ElevenLabs (optional). Key is a secret; never log it. */
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ELEVENLABS_TTS_MODEL?: string;
  ELEVENLABS_ASR_MODEL?: string;
  ELEVENLABS_HOST?: string;
  ASR_PROVIDER?: string;
  TTS_PROVIDER?: string;
}

function limitsFromEnv(env: Env): Limits {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    ...DEFAULT_LIMITS,
    panMin: n(env.PAN_MIN, DEFAULT_LIMITS.panMin),
    panMax: n(env.PAN_MAX, DEFAULT_LIMITS.panMax),
    tiltMin: n(env.TILT_MIN, DEFAULT_LIMITS.tiltMin),
    tiltMax: n(env.TILT_MAX, DEFAULT_LIMITS.tiltMax),
    volumeCap: n(env.VOLUME_CAP, DEFAULT_LIMITS.volumeCap),
  };
}

function gatewayEnv(env: Env): GatewayEnv | null {
  return env.DEVICE && env.REGISTRY ? (env as GatewayEnv) : null;
}

/**
 * Stack-chan endpoints. Auth is split-track (mcp-plan §1.6 / audio-sdk-plan):
 *   - POST /mcp: Authorization: Bearer <MCP_API_KEY>
 *   - GET  /ws/device: Authorization: Bearer <device_token> + Device-Id (query device_id also accepted)
 * Failures: MCP → 401 + IP rate limit; device WS → close 4003 + IP rate limit.
 * Still gated by STACKCHAN_ENABLED=true.
 */
async function handleStackchan(req: Request, env: Env, url: URL): Promise<Response> {
  const genv = gatewayEnv(env);
  if (env.STACKCHAN_ENABLED !== "true" || !genv) return new Response("Not Found", { status: 404 });
  const hub = env.HUB.getByName("main");
  const ip = clientIp(req);

  if (url.pathname === "/mcp") {
    // Method probe before auth so clients discover POST-only without a key.
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST" },
      });
    }
    if (await hub.rateLimited("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000)) return json({ error: "too_many_attempts" }, 429);
    const key = parseBearer(req);
    if (!env.MCP_API_KEY || !key || !(await safeEqual(key, env.MCP_API_KEY))) {
      await hub.rateLimit("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000);
      return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="mcp"' });
    }
    return handleMcp(req, { gateway: createDoGateway(genv), limits: limitsFromEnv(env) }, env.PUBLIC_ORIGIN?.replace(/\/+$/, ""));
  }

  // /ws/device
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  const deviceId = (req.headers.get("Device-Id") ?? url.searchParams.get("device_id") ?? "").trim();
  if (!DEVICE_ID_RE.test(deviceId)) return json({ error: "bad_device_id" }, 400);
  if (await hub.rateLimited("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000)) {
    return rejectWebSocket(WS_CLOSE.AUTH_FAILED, "rate limited");
  }
  const token = parseBearer(req);
  const ok = !!token && (await genv.REGISTRY.getByName("registry").verifyToken(deviceId, token));
  if (!ok) {
    await hub.rateLimit("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000);
    return rejectWebSocket(WS_CLOSE.AUTH_FAILED, "unauthorized");
  }
  const headers = new Headers(req.headers);
  headers.set("x-device-id", deviceId);
  return genv.DEVICE.getByName(deviceId).fetch(new Request(req, { headers }));
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 4000;
const MAX_REPLY = 20000;
const COOKIE = "gc_auth";
const AUTH_FAIL_LIMIT = 10; // wrong passcodes / bearer keys per minute per IP

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function intVar(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function authCookieValue(env: Env): Promise<string> {
  return hmacHex(env.SITE_PASSCODE, "grokchan-bridge:auth:v1");
}

function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

type AuthState = "ok" | "none" | "bad";

/** Cookie (set by /api/login) or an `X-Passcode` header (for scripts/tests). */
async function checkAuth(req: Request, env: Env): Promise<AuthState> {
  if (!env.SITE_PASSCODE) return "bad"; // fail closed when unconfigured
  const header = req.headers.get("x-passcode");
  if (header !== null) return (await safeEqual(header, env.SITE_PASSCODE)) ? "ok" : "bad";
  const cookie = getCookie(req, COOKIE);
  if (cookie === null) return "none";
  return (await safeEqual(cookie, await authCookieValue(env))) ? "ok" : "bad";
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "local";
}

function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === url.origin;
}

async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    const v: unknown = JSON.parse(new TextDecoder().decode(buf));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pageResponse(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const html = pageHtml.replaceAll("__NONCE__", nonce);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const hub = env.HUB.getByName("main");

  if (path === "/api/health" && method === "GET") {
    return json({
      ok: true,
      configured: !!(env.GROK_WEBHOOK_URL && env.GROK_WEBHOOK_KEY && env.SITE_PASSCODE && env.PUBLIC_ORIGIN),
      stackchan: env.STACKCHAN_ENABLED === "true",
      mcp_auth: !!env.MCP_API_KEY,
    });
  }

  // The reply endpoint is authenticated only by the one-time token in the URL.
  const replyMatch = /^\/api\/reply\/([A-Za-z0-9_-]{16,128})$/.exec(path);
  if (replyMatch) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await readJson(req, 200_000);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "invalid_body", hint: 'expected JSON {"text":"..."}' }, 400);
    const token = replyMatch[1]!;
    const clipped = text.length > MAX_REPLY ? text.slice(0, MAX_REPLY) + "…" : text;
    const peek = await hub.peek(token);
    if (peek?.target && peek.expires_at >= Date.now()) {
      // Voice turn: the device's turn state machine decides whether this reply is still wanted.
      const m = /^device:([A-Za-z0-9_-]{1,64}):(t_[0-9a-f]{10})$/.exec(peek.target);
      if (!m || !env.DEVICE) return json({ error: "unknown_or_used_token" }, 404);
      const verdict = await env.DEVICE.getByName(m[1]!).agentReply(m[2]!, clipped);
      if (verdict === "stale") {
        await hub.discard(token);
        return json({ ok: true, dropped: "stale_turn" }); // 200: the agent must not retry
      }
    }
    const result = await hub.consume(token, clipped);
    if (result === "ok") return json({ ok: true });
    if (result === "expired") return json({ error: "token_expired" }, 410);
    return json({ error: "unknown_or_used_token" }, 404);
  }

  if (!path.startsWith("/api/")) return json({ error: "not_found" }, 404);

  // Everything below requires the shared passcode.
  if ((method === "POST" || method === "DELETE") && !sameOrigin(req, url)) return json({ error: "bad_origin" }, 403);
  // DELETE/POST for device tokens also need same-origin when browser-initiated; scripts use X-Passcode (no Origin).

  if (path === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    if (await hub.rateLimited("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000)) return json({ error: "too_many_attempts" }, 429);
    const body = await readJson(req, 4096);
    const given = typeof body?.passcode === "string" ? body.passcode : "";
    if (!env.SITE_PASSCODE || !given || !(await safeEqual(given, env.SITE_PASSCODE))) {
      await hub.rateLimit("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000);
      return json({ error: "wrong_passcode" }, 401);
    }
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return json({ ok: true }, 200, {
      "set-cookie": `${COOKIE}=${await authCookieValue(env)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`,
    });
  }
  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  const auth = await checkAuth(req, env);
  if (auth !== "ok") {
    if (auth === "bad") {
      const ip = clientIp(req);
      if (await hub.rateLimited("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000)) return json({ error: "too_many_attempts" }, 429);
      await hub.rateLimit("authfail:" + ip, AUTH_FAIL_LIMIT, 60_000);
    }
    return json({ error: "unauthorized" }, 401);
  }

  if (path === "/api/session" && method === "GET") return json({ ok: true });

  if (path === "/api/chat" && method === "POST") {
    if (!env.GROK_WEBHOOK_URL || !env.GROK_WEBHOOK_KEY || !env.PUBLIC_ORIGIN) return json({ error: "server_not_configured" }, 500);
    const body = await readJson(req, 64_000);
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!SESSION_RE.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
    if (!message) return json({ error: "empty_message" }, 400);
    if (message.length > MAX_MESSAGE) return json({ error: "message_too_long", max: MAX_MESSAGE }, 413);
    if (!(await hub.rateLimit("chat", intVar(env.RATE_LIMIT_PER_MIN, 20), 60_000))) {
      return json({ error: "rate_limited" }, 429, { "retry-after": "10" });
    }
    const ttlMs = intVar(env.TOKEN_TTL_SECONDS, 600) * 1000;
    const { token, turnId, history } = await hub.begin(sessionId, message, ttlMs);
    const origin = env.PUBLIC_ORIGIN.replace(/\/+$/, "");
    const agent = getAgentProvider(env);
    const result = await agent.deliver(
      { session_id: sessionId, message, history },
      { method: "POST", url: `${origin}/api/reply/${token}` },
    );
    if (!result.ok) {
      await hub.abort(token, turnId);
      console.log(`agent ${agent.id} delivery failed, last status ${result.status} ${result.detail ?? ""}`); // never log URL/key
      const err = result.status === 501 ? "agent_not_implemented" : "webhook_failed";
      return json({ error: err, agent: agent.id, status: result.status, detail: result.detail }, result.status === 501 ? 501 : 502);
    }
    return json({ ok: true, turn_id: turnId, expires_in: ttlMs / 1000 }, 202);
  }

  if (path === "/api/poll" && method === "GET") {
    const sessionId = url.searchParams.get("session_id") ?? "";
    const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0;
    if (!SESSION_RE.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
    return json(await hub.poll(sessionId, after));
  }

  if (path === "/api/history" && method === "GET") {
    const sessionId = url.searchParams.get("session_id") ?? "";
    if (!SESSION_RE.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
    return json(await hub.history(sessionId));
  }

  if (path === "/api/reset" && method === "POST") {
    const body = await readJson(req, 4096);
    const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
    if (!SESSION_RE.test(sessionId)) return json({ error: "invalid_session_id" }, 400);
    await hub.reset(sessionId);
    return json({ ok: true });
  }

  // ---- device token admin (SITE_PASSCODE). Token plaintext is returned once and never stored.
  const genv = gatewayEnv(env);
  if (path === "/api/devices" && method === "GET") {
    if (!genv) return json({ error: "stackchan_not_configured" }, 503);
    const list = await genv.REGISTRY.getByName("registry").list();
    return json({
      devices: list.map((d) => ({
        device_id: d.device_id,
        first_seen: d.first_seen,
        last_seen: d.last_seen,
        fw_version: d.fw_version,
        hw: d.hw,
        caps: d.caps,
        has_token: !!d.has_token,
      })),
    });
  }

  const tokenMatch = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})\/token$/.exec(path);
  if (tokenMatch) {
    if (!genv) return json({ error: "stackchan_not_configured" }, 503);
    const deviceId = tokenMatch[1]!;
    if (!DEVICE_ID_RE.test(deviceId)) return json({ error: "bad_device_id" }, 400);
    if (method === "POST") {
      // same-origin already checked for POST above when Origin is set
      const issued = await genv.REGISTRY.getByName("registry").issueToken(deviceId);
      // Plaintext token only in this response body. Operator must copy into firmware gc_config.h.
      return json({ ok: true, device_id: issued.device_id, token: issued.token, note: "copy the token now; it is not stored in plaintext and will not be shown again" });
    }
    if (method === "DELETE") {
      const had = await genv.REGISTRY.getByName("registry").revokeToken(deviceId);
      return json({ ok: true, revoked: had });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  // Dev-only: exercise Workers outbound fetch+Upgrade to ElevenLabs from workerd.
  // Protected by SITE_PASSCODE. Never logs the key. Not part of npm test.
  if (path === "/api/dev/elevenlabs-smoke" && method === "POST") {
    if (!env.ELEVENLABS_API_KEY) return json({ error: "elevenlabs_not_configured" }, 503);
    try {
      const { runElevenLabsWorkerSmoke } = await import("./dev/elevenlabs-worker-smoke");
      const result = await runElevenLabsWorkerSmoke(env);
      return json(result, result.ok ? 200 : 502);
    } catch (e) {
      console.log("elevenlabs worker smoke error:", e instanceof Error ? e.message : String(e));
      return json({ ok: false, error: e instanceof Error ? e.message : "smoke_failed" }, 502);
    }
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
      return pageResponse();
    }
    if (url.pathname === "/mcp" || url.pathname === "/ws/device") {
      try {
        return await handleStackchan(req, env, url);
      } catch (e) {
        console.log("unhandled stackchan error:", e instanceof Error ? e.message : String(e));
        return json({ error: "internal_error" }, 500);
      }
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        console.log("unhandled error:", e instanceof Error ? e.message : String(e));
        return json({ error: "internal_error" }, 500);
      }
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
