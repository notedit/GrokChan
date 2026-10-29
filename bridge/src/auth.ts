/**
 * Shared auth helpers for the chat passcode, MCP API key, and per-device tokens.
 * Digests and comparisons never log secrets; use safeEqual for any secret check.
 */

const enc = new TextEncoder();

export async function hmacHex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare via equal-length HMAC digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hmacHex("cmp", a), hmacHex("cmp", b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(data: string): Promise<string> {
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
  return [...dig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url (no padding). Shown once to the operator; only the SHA-256 is stored. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse `Authorization: Bearer <token>`. Returns null when the header is missing or malformed. */
export function parseBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

/**
 * Browser device clients cannot set `Authorization` on a WebSocket, so they carry the device token in
 * `Sec-WebSocket-Protocol` (never in the URL, which lands in logs/history):
 *   new WebSocket(url, ["mediasession-rpc.v1", "gc-auth.<device token>"])
 * The server verifies the token exactly like a Bearer token, and echoes ONLY the non-secret
 * `mediasession-rpc.v1` entry (browsers require the server to pick one offered protocol); the
 * secret entry is never echoed, logged, or forwarded to the Durable Object.
 * `Authorization: Bearer` keeps working unchanged and takes precedence when present.
 */
export const WS_SUBPROTOCOL = "mediasession-rpc.v1";
export const WS_AUTH_PREFIX = "gc-auth.";
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface WsAuthOffer {
  /** Bearer header token, else the token from a `gc-auth.` subprotocol (null when neither / malformed). */
  token: string | null;
  /** Non-secret subprotocol to echo in the 101 response (null when the client did not offer it). */
  echo: string | null;
}

export function parseWsAuth(req: Request): WsAuthOffer {
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const echo = offered.includes(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : null;
  const bearer = parseBearer(req);
  if (bearer !== null) return { token: bearer, echo };
  const entry = offered.find((x) => x.startsWith(WS_AUTH_PREFIX));
  const candidate = entry ? entry.slice(WS_AUTH_PREFIX.length) : "";
  return { token: TOKEN_RE.test(candidate) ? candidate : null, echo };
}

/** Request headers for the Durable Object: the secret subprotocol is dropped, only the echo remains. */
export function scrubWsAuthHeaders(headers: Headers, echo: string | null): void {
  if (echo) headers.set("sec-websocket-protocol", echo);
  else headers.delete("sec-websocket-protocol");
}

/**
 * Reject a WebSocket upgrade by accepting a pair and immediately closing with a protocol code
 * (e.g. WS_CLOSE.AUTH_FAILED = 4003). Prefer this over a plain HTTP 401 so clients see the
 * mediasession-rpc close code. `echo` must be passed for browser clients: a browser that offered
 * subprotocols fails the handshake (close 1006, code lost) unless the response selects one.
 */
export function rejectWebSocket(code: number, reason: string, echo: string | null = null): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  try {
    pair[1].close(code, reason.slice(0, 123));
  } catch {}
  return new Response(null, { status: 101, webSocket: pair[0], ...(echo ? { headers: { "sec-websocket-protocol": echo } } : {}) });
}
