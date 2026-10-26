import pageHtml from "./page.html";
import type { ChatHub } from "./hub";
import { getAgentProvider } from "./agents";
import { createDoGateway, type GatewayEnv } from "./device/do-gateway";
import { DEVICE_ID_RE } from "./device/protocol";
import { handleMcp } from "./mcp/server";
import { DEFAULT_LIMITS, type Limits } from "./mcp/tools";

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
  // Optional tuning knobs (strings, as wrangler vars). Defaults in parentheses.
  RATE_LIMIT_PER_MIN?: string; // (20)
  TOKEN_TTL_SECONDS?: string; // (600)
  WEBHOOK_MAX_ATTEMPTS?: string; // (4)
  RETRY_BASE_MS?: string; // (500)
  /** Stack-chan device endpoints (/mcp, /ws/device). Off unless "true": M1 has NO auth on them yet. */
  STACKCHAN_ENABLED?: string;
  /** Soft limits for the MCP tools (defaults: pan -90..90, tilt 0..60, volume cap 70). */
  PAN_MIN?: string;
  PAN_MAX?: string;
  TILT_MIN?: string;
  TILT_MAX?: string;
  VOLUME_CAP?: string;
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
 * Stack-chan endpoints. TODO(auth): /mcp needs a bearer key (MCP_API_KEY) and
 * /ws/device a per-device token before this is exposed; until then both are
 * disabled unless STACKCHAN_ENABLED=true.
 */
async function handleStackchan(req: Request, env: Env, url: URL): Promise<Response> {
  const genv = gatewayEnv(env);
  if (env.STACKCHAN_ENABLED !== "true" || !genv) return new Response("Not Found", { status: 404 });
  if (url.pathname === "/mcp") {
    return handleMcp(req, { gateway: createDoGateway(genv), limits: limitsFromEnv(env) }, env.PUBLIC_ORIGIN?.replace(/\/+$/, ""));
  }
  // /ws/device
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
  const deviceId = req.headers.get("Device-Id") ?? url.searchParams.get("device_id") ?? "";
  if (!DEVICE_ID_RE.test(deviceId)) return json({ error: "bad_device_id" }, 400);
  const headers = new Headers(req.headers);
  headers.set("x-device-id", deviceId);
  return genv.DEVICE.getByName(deviceId).fetch(new Request(req, { headers }));
}

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_MESSAGE = 4000;
const MAX_REPLY = 20000;
const COOKIE = "gc_auth";
const AUTH_FAIL_LIMIT = 10; // wrong passcodes per minute

const enc = new TextEncoder();

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

async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings via equal-length HMAC digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hmacHex("cmp", a), hmacHex("cmp", b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
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
    return json({ ok: true, configured: !!(env.GROK_WEBHOOK_URL && env.GROK_WEBHOOK_KEY && env.SITE_PASSCODE && env.PUBLIC_ORIGIN) });
  }

  // The reply endpoint is authenticated only by the one-time token in the URL.
  const replyMatch = /^\/api\/reply\/([A-Za-z0-9_-]{16,128})$/.exec(path);
  if (replyMatch) {
    if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await readJson(req, 200_000);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "invalid_body", hint: 'expected JSON {"text":"..."}' }, 400);
    const result = await hub.consume(replyMatch[1]!, text.length > MAX_REPLY ? text.slice(0, MAX_REPLY) + "…" : text);
    if (result === "ok") return json({ ok: true });
    if (result === "expired") return json({ error: "token_expired" }, 410);
    return json({ error: "unknown_or_used_token" }, 404);
  }

  if (!path.startsWith("/api/")) return json({ error: "not_found" }, 404);

  // Everything below requires the shared passcode.
  if (method === "POST" && !sameOrigin(req, url)) return json({ error: "bad_origin" }, 403);

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
