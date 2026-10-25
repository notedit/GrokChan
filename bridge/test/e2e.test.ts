import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { client, MockWebhook, PASSCODE, startWorker, WEBHOOK_KEY, waitFor, sleep, type Worker } from "./harness";

const mock = new MockWebhook();
let w: Worker;
let c: ReturnType<typeof client>;
let n = 0;
const sid = () => `test_session_${++n}_${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await mock.start();
  w = await startWorker({
    GROK_WEBHOOK_URL: mock.url,
    GROK_WEBHOOK_KEY: WEBHOOK_KEY,
    SITE_PASSCODE: PASSCODE,
    TOKEN_TTL_SECONDS: "3",
    RETRY_BASE_MS: "50",
    RATE_LIMIT_PER_MIN: "1000",
  });
  c = client(w.base);
});
afterAll(async () => {
  await w?.stop();
  await mock.stop();
});
beforeEach(() => mock.reset());

describe("page + health", () => {
  it("serves the GrokChan chat UI with a strict CSP and no secrets", async () => {
    const r = await fetch(w.base + "/");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("New chat");
    expect(html).toContain("Thinking");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).not.toContain(WEBHOOK_KEY);
    expect(html).not.toContain(mock.url);
    expect(html).not.toContain(PASSCODE);
    expect(html).not.toContain("__NONCE__");
  });
  it("health is public and does not leak config values", async () => {
    const r = await fetch(w.base + "/api/health");
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ ok: true, configured: true });
    expect(text).not.toContain(WEBHOOK_KEY);
  });
});

describe("passcode protection", () => {
  it("rejects chat/poll/history/reset without or with a wrong passcode; webhook never called", async () => {
    const s = sid();
    expect((await c.chat(s, "hi", {})).status).toBe(401);
    expect((await c.chat(s, "hi", { "x-passcode": "nope" })).status).toBe(401);
    expect((await c.poll(s, 0, {})).status).toBe(401);
    expect((await c.poll(s, 0, { "x-passcode": "nope" })).status).toBe(401);
    expect((await fetch(`${w.base}/api/history?session_id=${s}`)).status).toBe(401);
    expect((await fetch(w.base + "/api/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: s }) })).status).toBe(401);
    expect(mock.requests).toHaveLength(0);
  });
  it("login: wrong passcode -> 401 and no cookie; right passcode -> HttpOnly cookie that authorizes", async () => {
    const bad = await fetch(w.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "wrong" }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const ok = await fetch(w.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: PASSCODE }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(PASSCODE);
    const pair = cookie.split(";")[0]!;
    expect((await fetch(w.base + "/api/session", { headers: { cookie: pair } })).status).toBe(200);
    expect((await fetch(w.base + "/api/session", { headers: { cookie: "gc_auth=forged" } })).status).toBe(401);
    // chat works with the cookie alone
    const r = await c.chat(sid(), "via cookie", { cookie: pair });
    expect(r.status).toBe(202);
  });
  it("rejects cross-origin POSTs", async () => {
    const r = await c.chat(sid(), "x", { "x-passcode": PASSCODE, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(mock.requests).toHaveLength(0);
  });
});

describe("full round trip", () => {
  it("chat -> webhook event (schema, auth header) -> mock replies to reply.url -> poll returns reply", async () => {
    const s = sid();
    const r = await c.chat(s, "你好，Grok");
    expect(r.status).toBe(202);

    await waitFor(() => mock.requests.length === 1);
    const req = mock.requests[0]!;
    expect(req.headers["authorization"]).toBe(`Bearer ${WEBHOOK_KEY}`);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.body.schema).toBe("grokbot-web.inbound.v1");
    expect(req.body.session_id).toBe(s);
    expect(req.body.message).toBe("你好，Grok");
    expect(req.body.history).toEqual([]);
    expect(req.body.reply.method).toBe("POST");
    expect(req.body.reply.url).toMatch(new RegExp(`^${w.base}/api/reply/[A-Za-z0-9_-]{32,}$`));
    expect(Object.keys(req.body).sort()).toEqual(["history", "message", "reply", "schema", "session_id"]);
    // the browser-facing response must not contain the key or the token
    expect(JSON.stringify(r.data)).not.toContain(WEBHOOK_KEY);
    expect(JSON.stringify(r.data)).not.toContain(req.body.reply.url.split("/").pop());

    // while waiting: nothing yet, pending = true
    const p0 = await c.poll(s, 0);
    expect(p0.data).toMatchObject({ turns: [], pending: true });

    // the routine replies, with no credentials
    const rr = await c.reply(req.body.reply.url, { text: "你好！\n第二行 https://example.com/a?b=1, 完" });
    expect(rr.status).toBe(200);

    const p1 = await c.poll(s, 0);
    expect(p1.data.pending).toBe(false);
    expect(p1.data.turns).toHaveLength(1);
    expect(p1.data.turns[0]).toMatchObject({ role: "assistant", text: "你好！\n第二行 https://example.com/a?b=1, 完" });
    // `after` cursor: nothing new after the last id
    const p2 = await c.poll(s, p1.data.turns[0].id);
    expect(p2.data.turns).toEqual([]);
    // poll is per-session
    expect((await c.poll(sid(), 0)).data.turns).toEqual([]);

    // second turn carries history of the first exchange
    mock.reset();
    expect((await c.chat(s, "第二个问题")).status).toBe(202);
    await waitFor(() => mock.requests.length === 1);
    expect(mock.requests[0]!.body.history).toEqual([
      { role: "user", text: "你好，Grok" },
      { role: "assistant", text: "你好！\n第二行 https://example.com/a?b=1, 完" },
    ]);
    const full = await c.history(s);
    expect(full.data.turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(full.data.pending).toBe(true);
  });

  it("validates chat input", async () => {
    expect((await c.chat("bad id!", "x")).status).toBe(400);
    expect((await c.chat(sid(), "   ")).status).toBe(400);
    expect((await c.chat(sid(), "x".repeat(4001))).status).toBe(413);
    expect(mock.requests).toHaveLength(0);
  });

  it("history sent to the webhook is capped at 30 turns", async () => {
    const s = sid();
    for (let i = 1; i <= 18; i++) {
      mock.reset();
      expect((await c.chat(s, `q${i}`)).status).toBe(202);
      const req = await waitFor(() => mock.requests[0]);
      expect(req.body.history.length).toBeLessThanOrEqual(30);
      expect((await c.reply(req.body.reply.url, { text: `a${i}` })).status).toBe(200);
    }
    const full = await c.history(s);
    expect(full.data.turns).toHaveLength(30);
    expect(full.data.turns.at(-1).text).toBe("a18");
    expect(full.data.turns[0].text).toBe("q4"); // oldest 6 turns dropped
    mock.reset();
    await c.chat(s, "last");
    const req = await waitFor(() => mock.requests[0]);
    expect(req.body.history).toHaveLength(30);
  });

  it("reset clears the session and invalidates its outstanding token", async () => {
    const s = sid();
    await c.chat(s, "hello");
    const req = await waitFor(() => mock.requests[0]);
    expect((await c.reset(s)).status).toBe(200);
    expect((await c.history(s)).data).toEqual({ turns: [], pending: false });
    expect((await c.reply(req.body.reply.url, { text: "late" })).status).toBe(404);
    expect((await c.poll(s, 0)).data.turns).toEqual([]);
  });
});

describe("reply tokens", () => {
  it("are single-use", async () => {
    const s = sid();
    await c.chat(s, "once");
    const url = (await waitFor(() => mock.requests[0])).body.reply.url as string;
    expect((await c.reply(url, { text: "first" })).status).toBe(200);
    const again = await c.reply(url, { text: "second" });
    expect(again.status).toBe(404);
    const p = await c.poll(s, 0);
    expect(p.data.turns.map((t: any) => t.text)).toEqual(["first"]);
  });

  it("are rejected after they expire (10 min in prod, 3 s in this test)", async () => {
    const s = sid();
    await c.chat(s, "slow");
    const url = (await waitFor(() => mock.requests[0])).body.reply.url as string;
    await sleep(3500);
    const late = await c.reply(url, { text: "too late" });
    expect(late.status).toBe(410);
    const p = await c.poll(s, 0);
    expect(p.data).toEqual({ turns: [], pending: false }); // UI shows a timeout
    // and it is consumed: still unusable
    expect((await c.reply(url, { text: "again" })).status).toBe(404);
  });

  it("unknown tokens get 404; bad bodies get 400 and do not burn the token", async () => {
    expect((await c.reply(`${w.base}/api/reply/${"A".repeat(43)}`, { text: "x" })).status).toBe(404);
    const s = sid();
    await c.chat(s, "bad body");
    const url = (await waitFor(() => mock.requests[0])).body.reply.url as string;
    expect((await c.reply(url, {})).status).toBe(400);
    expect((await c.reply(url, { text: "   " })).status).toBe(400);
    expect((await fetch(url, { method: "POST", body: "not json" })).status).toBe(400);
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await c.reply(url, { text: "ok now" })).status).toBe(200);
  });

  it("reply endpoint needs no passcode and is not usable to read data", async () => {
    // (covered above: replies succeed with no credentials) — GET is not allowed
    const r = await fetch(`${w.base}/api/reply/${"B".repeat(43)}`);
    expect(r.status).toBe(405);
  });
});

describe("webhook delivery retries", () => {
  it("retries 429/5xx then succeeds", async () => {
    mock.statuses = [503, 429, 200];
    const s = sid();
    const r = await c.chat(s, "retry me");
    expect(r.status).toBe(202);
    expect(mock.requests).toHaveLength(3);
    // each retry carries the same token/payload and auth header
    const urls = new Set(mock.requests.map((q) => q.body.reply.url));
    expect(urls.size).toBe(1);
    for (const q of mock.requests) expect(q.headers["authorization"]).toBe(`Bearer ${WEBHOOK_KEY}`);
  });

  it("gives up after 4 attempts on persistent 5xx: 502, no pending state, user turn rolled back", async () => {
    mock.statuses = [500, 502, 503, 504, 200];
    const s = sid();
    const r = await c.chat(s, "doomed");
    expect(r.status).toBe(502);
    expect(r.data.error).toBe("webhook_failed");
    expect(JSON.stringify(r.data)).not.toContain(WEBHOOK_KEY);
    expect(mock.requests).toHaveLength(4);
    expect((await c.history(s)).data).toEqual({ turns: [], pending: false });
    // the token from the failed attempt is dead
    const url = mock.requests[0]!.body.reply.url as string;
    expect((await c.reply(url, { text: "x" })).status).toBe(404);
  });

  it("does not retry a 4xx (e.g. 401 from a wrong key)", async () => {
    mock.statuses = [401];
    const r = await c.chat(sid(), "bad key");
    expect(r.status).toBe(502);
    expect(r.data.status).toBe(401);
    expect(mock.requests).toHaveLength(1);
  });
});

describe("custom webhook header (GROK_WEBHOOK_HEADER + raw scheme)", () => {
  let w2: Worker;
  beforeAll(async () => {
    w2 = await startWorker({
      GROK_WEBHOOK_URL: mock.url,
      GROK_WEBHOOK_KEY: WEBHOOK_KEY,
      SITE_PASSCODE: PASSCODE,
      GROK_WEBHOOK_HEADER: "X-Api-Key",
      GROK_WEBHOOK_SCHEME: "raw",
    });
  });
  afterAll(async () => w2?.stop());
  it("sends the bare key in the configured header", async () => {
    const c2 = client(w2.base);
    expect((await c2.chat(sid(), "hdr")).status).toBe(202);
    const req = await waitFor(() => mock.requests[0]);
    expect(req.headers["x-api-key"]).toBe(WEBHOOK_KEY);
    expect(req.headers["authorization"]).toBeUndefined();
  });
});

describe("rate limit (default 20/min)", () => {
  let w3: Worker;
  beforeAll(async () => {
    w3 = await startWorker({ GROK_WEBHOOK_URL: mock.url, GROK_WEBHOOK_KEY: WEBHOOK_KEY, SITE_PASSCODE: PASSCODE });
  });
  afterAll(async () => w3?.stop());
  it("allows 20 chats per minute then answers 429", async () => {
    const c3 = client(w3.base);
    const s = sid();
    for (let i = 0; i < 20; i++) expect((await c3.chat(s, `m${i}`)).status).toBe(202);
    const r = await c3.chat(s, "one too many");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
    expect(mock.requests).toHaveLength(20);
  });
});

describe("failed-login throttling", () => {
  let w4: Worker;
  beforeAll(async () => {
    w4 = await startWorker({ GROK_WEBHOOK_URL: mock.url, GROK_WEBHOOK_KEY: WEBHOOK_KEY, SITE_PASSCODE: PASSCODE });
  });
  afterAll(async () => w4?.stop());
  it("answers 429 after 10 wrong passcodes in a minute, even for the right one", async () => {
    const login = (passcode: string) =>
      fetch(w4.base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login("x" + i)).status);
    expect(codes.slice(0, 10).every((x) => x === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    expect((await login(PASSCODE)).status).toBe(429);
  });
});
