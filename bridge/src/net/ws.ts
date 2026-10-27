/**
 * Outbound WebSocket client abstraction. Workers cannot call `new WebSocket(url, {headers})`;
 * the supported way is `fetch(httpsUrl, {headers: {Upgrade: "websocket", ...}})` and taking
 * `response.webSocket` (then `.accept()`). Credentials therefore travel in headers, never in the URL.
 * Tests and the Node smoke script inject their own connector.
 */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
}

/** Resolves once the socket is open (and accepted). Rejects with a message that never contains header values. */
export type WsConnector = (url: string, headers: Record<string, string>) => Promise<WsLike>;

export class WsConnectError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const workersWsConnector: WsConnector = async (url, headers) => {
  const httpUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  let res: Response;
  try {
    res = await fetch(httpUrl, { headers: { ...headers, Upgrade: "websocket" } });
  } catch (e) {
    throw new WsConnectError("websocket connect failed: " + (e instanceof Error ? e.message : "network error"));
  }
  const ws = (res as unknown as { webSocket?: WsLike & { accept(): void } }).webSocket;
  if (!ws) {
    await res.body?.cancel().catch(() => {});
    throw new WsConnectError(`websocket upgrade refused (HTTP ${res.status})`, res.status);
  }
  ws.accept();
  return ws;
};

export function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return undefined;
}

export function b64encode(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
