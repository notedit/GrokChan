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
 * Reject a WebSocket upgrade by accepting a pair and immediately closing with a protocol code
 * (e.g. WS_CLOSE.AUTH_FAILED = 4003). Prefer this over a plain HTTP 401 so clients see the
 * mediasession-rpc close code.
 */
export function rejectWebSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  try {
    pair[1].close(code, reason.slice(0, 123));
  } catch {}
  return new Response(null, { status: 101, webSocket: pair[0] });
}
