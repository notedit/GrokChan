# GrokChan Bridge

Cloudflare Worker that bridges a browser (and later M5Stack firmware) to an upstream **agent**. Today the only production provider is **Grok Bot** (webhook routine + one-shot `reply.url`). A **Muse** stub exists so more agents can plug in behind the same HTTP surface.

English is the default language for docs in this repo. Chinese: [README.zh-CN.md](../README.zh-CN.md) (project overview) and [docs/architecture.zh-CN.md](../docs/architecture.zh-CN.md).

## Flow

```text
Browser ──POST /api/chat──▶ Worker ──agent.deliver(inbound, reply.url)──▶ Grok Bot routine
   ▲                         ▲                                              │
   └──GET /api/poll(1.5s)────┴────────POST /api/reply/<one-shot token>◀─────┘
```

- One Worker + one Durable Object (SQLite). No runtime npm deps.
- Webhook URL/key live only in Worker secrets — never in the page or firmware.
- Passcode (`SITE_PASSCODE`) gates the UI because the page can fire your bot.
- Reply URL token is single-use and expires (default 10 minutes).

## Agent providers

| Id | Status | Module |
| --- | --- | --- |
| `grokbot` (default) | Working | [`src/agents/grokbot.ts`](src/agents/grokbot.ts) |
| `muse` | Stub (returns 501) | [`src/agents/muse.ts`](src/agents/muse.ts) |

Select with `AGENT_PROVIDER` in `wrangler.toml` `[vars]` (default `grokbot`). Shared contracts live in [`src/agents/types.ts`](src/agents/types.ts); registry in [`src/agents/registry.ts`](src/agents/registry.ts).

### Grok Bot inbound payload

Kept as schema `grokbot-web.inbound.v1` so existing Grok Bot webhook routines stay compatible:

```json
{
  "schema": "grokbot-web.inbound.v1",
  "session_id": "s_…",
  "message": "user text",
  "history": [{"role": "user", "text": "…"}, {"role": "assistant", "text": "…"}],
  "reply": {"method": "POST", "url": "https://<PUBLIC_ORIGIN>/api/reply/<token>"}
}
```

The routine POSTs `{"text":"…"}` to `reply.url` (no other credentials).

## Prerequisites

- Node.js **22+**
- Cloudflare account
- A Grok Bot **webhook** routine (e.g. “Web chat bridge” / “device bridge”)

## Deploy

```bash
cd bridge
npm install
npx wrangler login          # or CLOUDFLARE_API_TOKEN
```

1. Copy webhook URL + sender key from the routine panel into secrets (never commit them).
2. Deploy once to learn your `*.workers.dev` origin.
3. Set `PUBLIC_ORIGIN` in `wrangler.toml` to that **https** origin (no trailing slash).
4. Put secrets with the CLI (important — see caveat below):

```bash
npx wrangler secret put GROK_WEBHOOK_URL
npx wrangler secret put GROK_WEBHOOK_KEY
npx wrangler secret put SITE_PASSCODE
```

Generate a passcode with `openssl rand -base64 18`.

5. Redeploy and check health:

```bash
npx wrangler deploy
curl https://<your-origin>/api/health
# expect: {"ok":true,"configured":true}
```

### Secret caveat (MCP / dashboards)

Some Cloudflare MCP / API helpers **redact** secret values into placeholders when writing secrets. Always set `GROK_WEBHOOK_*` and `SITE_PASSCODE` with interactive `wrangler secret put` (or paste carefully in the dashboard). If chat returns **401** from the webhook, re-put the key via wrangler.

## Environment

| Name | Kind | Purpose | Default |
| --- | --- | --- | --- |
| `PUBLIC_ORIGIN` | var | Public https origin for `reply.url` | required |
| `AGENT_PROVIDER` | var | `grokbot` or `muse` | `grokbot` |
| `GROK_WEBHOOK_URL` | secret | Routine webhook URL | required (grokbot) |
| `GROK_WEBHOOK_KEY` | secret | Routine sender key | required (grokbot) |
| `SITE_PASSCODE` | secret | Page access passcode | required |
| `GROK_WEBHOOK_HEADER` | var | Auth header name | `Authorization` |
| `GROK_WEBHOOK_SCHEME` | var | `Bearer` or `raw` | `Bearer` |
| `RATE_LIMIT_PER_MIN` | var | Chat rate limit | `20` |
| `TOKEN_TTL_SECONDS` | var | Reply token TTL | `600` |

Local: copy `.dev.vars.example` → `.dev.vars` (git-ignored).

### Stack-chan device endpoints (M1, experimental)

| Name | Kind | Purpose | Default |
| --- | --- | --- | --- |
| `STACKCHAN_ENABLED` | var | `"true"` enables `POST /mcp` and `GET /ws/device` (WebSocket). Otherwise both return 404. | off |
| `TTS_PROVIDER` | var | `mock` (only provider in M1). Unset → `speak` fails with `tts_failed`. | unset |
| `DEVICE_CMD_TIMEOUT_MS` | var | Wait for a device response (speak: 5000) | `3000` |
| `HELLO_TIMEOUT_MS` | var | Close sockets that skip `session.hello` | `10000` |
| `DEVICE_RATE_LIMIT_PER_SEC` | var | Per-device command limit (`emergency_stop` exempt) | `20` |
| `AUDIO_CHUNK_DELAY_MS` | var | Extra delay between audio frames (tests/debug) | `0` |
| `PAN_MIN` `PAN_MAX` `TILT_MIN` `TILT_MAX` | var | Soft limits for `move_head` | `-90 90 0 60` |
| `VOLUME_CAP` | var | Max volume for `speak` / `set_volume` | `70` |

**There is no auth on `/mcp` and `/ws/device` yet** (see `TODO(auth)` in `src/index.ts`), so they are off by default. Only turn `STACKCHAN_ENABLED` on locally or behind your own access control. Design: [`../docs/mcp-plan.md`](../docs/mcp-plan.md) ([中文](../docs/mcp-plan.zh-CN.md)).

M1 tools: `list_devices`, `get_device_status`, `move_head`, `reset_pose`, `set_expression`, `show_text`, `set_led`, `speak`, `stop_audio`, `set_volume`, `emergency_stop`. The device speaks JSON-RPC 2.0 (`grokchan-rpc/1`) over `/ws/device?device_id=<id>`; audio goes down as binary frames.

## Grok Bot routine tips

1. Trigger type: **Webhook**.
2. Read `message` / `history` from the event body.
3. Generate the assistant reply.
4. `POST` JSON `{"text":"…"}` to `reply.url`.
5. Optional: post a short “【网页聊天同步】” / sync note to your main chat.

## Develop & test

```bash
cp .dev.vars.example .dev.vars
npm run dev          # http://localhost:8787
npm test             # mock webhook + mock Stack-chan device + real wrangler dev (fake secrets)
npm run typecheck
```

Requires **Node ≥ 22** (wrangler 4). Tests: `test/e2e.test.ts` (chat), `test/mcp.unit.test.ts` (MCP layer against an in-memory gateway), `test/device.e2e.test.ts` (MCP ⇄ DeviceHub ⇄ `test/mock-device.ts` over real WebSockets; configurable delay / error / ignore / disconnect).

Local `PUBLIC_ORIGIN` is localhost — a real Grok Bot cloud routine cannot reach it. Use a tunnel (`cloudflared`) for live routine debugging.

## Layout

```text
bridge/
  src/
    index.ts          HTTP Worker
    hub.ts            ChatHub Durable Object
    device/           DeviceHub (1 DO per device, JSON-RPC WS), DeviceRegistry, protocol, gateway
    mcp/              Streamable HTTP MCP server + the 11 tool definitions
    tts/              TtsProvider interface + mock
    page.html         Passcode-gated chat UI
    agents/
      types.ts        Provider interface
      registry.ts     AGENT_PROVIDER switch
      grokbot.ts      Webhook + reply.url (production)
      muse.ts         Stub for later
  test/               Vitest e2e
  wrangler.toml
```
