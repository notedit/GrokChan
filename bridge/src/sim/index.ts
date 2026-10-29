import { SIM_ASSETS } from "./assets.gen";

let wasmCache: Uint8Array | null = null;

/** Strict CSP for the web device: only same-origin files (no inline script/style), wasm allowed, ws only to this origin. */
export function simCsp(url: URL): string {
  const ws = (url.protocol === "https:" ? "wss://" : "ws://") + url.host;
  return (
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
    `connect-src 'self' ${ws}; worker-src 'self'; media-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
}

function headers(url: URL, type: string): Record<string, string> {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "content-security-policy": simCsp(url),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    // microphone only for this origin; everything else off
    "permissions-policy": "microphone=(self), camera=(), geolocation=()",
  };
}

/** Serve /sim/*. The caller has already checked SIM_UI_ENABLED + STACKCHAN_ENABLED + SITE_PASSCODE auth. */
export function serveSim(req: Request, url: URL): Response {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
  if (url.pathname === "/sim") return new Response(null, { status: 308, headers: { location: "/sim/", "cache-control": "no-store" } });
  let path = url.pathname.slice("/sim".length);
  if (path === "/") path = "/index.html";
  const a = Object.hasOwn(SIM_ASSETS, path) ? SIM_ASSETS[path] : undefined;
  if (!a) return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
  if (a.binary) {
    wasmCache ??= Uint8Array.from(atob(a.body), (c) => c.charCodeAt(0));
    return new Response(req.method === "HEAD" ? null : wasmCache, { headers: headers(url, a.type) });
  }
  return new Response(req.method === "HEAD" ? null : a.body, { headers: headers(url, a.type) });
}

export function simLoginRequired(url: URL): Response {
  const html = '<!doctype html><meta charset="utf-8"><title>GrokChan sim</title>需要先在 <a href="/">首页</a> 用 SITE_PASSCODE 登录,然后刷新本页。';
  return new Response(html, { status: 401, headers: headers(url, "text/html; charset=utf-8") });
}
