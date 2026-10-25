import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PASSCODE = "test-passcode-123"; // fake, test only
export const WEBHOOK_KEY = "test-webhook-key-FAKE"; // fake, test only

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

export interface Recorded {
  headers: IncomingMessage["headers"];
  body: any;
  rawBody: string;
}

/** Mock Grok Bot webhook. `statuses` is a queue of forced response codes. */
export class MockWebhook {
  server!: Server;
  port = 0;
  requests: Recorded[] = [];
  statuses: number[] = [];
  get url(): string {
    return `http://127.0.0.1:${this.port}/hook`;
  }
  async start(): Promise<void> {
    this.port = await freePort();
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body: any = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        this.requests.push({ headers: req.headers, body, rawBody: raw });
        const status = this.statuses.shift() ?? 200;
        res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "0" } : {}) });
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });
    await new Promise<void>((r) => this.server.listen(this.port, "127.0.0.1", r));
  }
  reset(): void {
    this.requests = [];
    this.statuses = [];
  }
  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

export interface Worker {
  base: string;
  stop(): Promise<void>;
}

/** Start `wrangler dev` (real workerd + SQLite Durable Object) with fake secrets. */
export async function startWorker(vars: Record<string, string>): Promise<Worker> {
  const port = await freePort();
  const inspector = await freePort();
  const persist = mkdtempSync(join(tmpdir(), "grokchan-bridge-"));
  const args = ["dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persist, "--log-level", "info"];
  for (const [k, v] of Object.entries({ PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, ...vars })) args.push("--var", `${k}:${v}`);
  const bin = resolve("node_modules/.bin/wrangler");
  const child: ChildProcess = spawn(bin, args, {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("wrangler exited early:\n" + out);
    try {
      const r = await fetch(base + "/api/health");
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("wrangler dev did not become ready:\n" + out);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    base,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            r();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

export function client(base: string) {
  const auth = { "x-passcode": PASSCODE };
  const j = async (r: Response) => ({ status: r.status, data: (await r.json().catch(() => ({}))) as any, headers: r.headers });
  return {
    chat: (session_id: string, message: string, headers: Record<string, string> = auth) =>
      fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ session_id, message }) }).then(j),
    poll: (session_id: string, after = 0, headers: Record<string, string> = auth) =>
      fetch(`${base}/api/poll?session_id=${session_id}&after=${after}`, { headers }).then(j),
    history: (session_id: string) => fetch(`${base}/api/history?session_id=${session_id}`, { headers: auth }).then(j),
    reset: (session_id: string) =>
      fetch(base + "/api/reset", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ session_id }) }).then(j),
    /** What the Grok Bot routine does: POST {"text"} to reply.url, no credentials. */
    reply: (url: string, body: unknown = {}) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j),
  };
}
