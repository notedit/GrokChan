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
| `MCP_API_KEY` | secret | Bearer key required on `POST /mcp` when Stack-chan is on (fail-closed if unset) | – |
| `TTS_PROVIDER` | var | `mock`, `mock-stream` (tests) or `elevenlabs`. Unset → `speak` fails with `tts_failed`. | unset |
| `DEVICE_CMD_TIMEOUT_MS` | var | Wait for a device response (speak: 5000) | `3000` |
| `HELLO_TIMEOUT_MS` | var | Close sockets that skip `session.hello` | `10000` |
| `DEVICE_RATE_LIMIT_PER_SEC` | var | Per-device command limit (`emergency_stop` exempt) | `20` |
| `AUDIO_CHUNK_DELAY_MS` | var | Extra delay between audio frames (tests/debug) | `0` |
| `PAN_MIN` `PAN_MAX` `TILT_MIN` `TILT_MAX` | var | Soft limits for `move_head` | `-90 90 0 60` |
| `VOLUME_CAP` | var | Max volume for `speak` / `set_volume` | `70` |

**Auth is split-track** (mcp-plan §1.6): `POST /mcp` requires `Authorization: Bearer <MCP_API_KEY>`; device WS requires `Authorization: Bearer <device_token>` + `Device-Id` (query `device_id` also accepted). Failures: MCP → 401 + IP rate limit; device → WebSocket close `4003` + IP rate limit. Registry stores only the SHA-256 of each device token. Issue / revoke under `SITE_PASSCODE`:

```bash
# issue (token shown once — paste into firmware include/gc_config.h as GC_DEVICE_TOKEN)
curl -s -X POST -H "X-Passcode: $SITE_PASSCODE" "$ORIGIN/api/devices/stackchan-01/token"
# list / revoke
curl -s -H "X-Passcode: $SITE_PASSCODE" "$ORIGIN/api/devices"
curl -s -X DELETE -H "X-Passcode: $SITE_PASSCODE" "$ORIGIN/api/devices/stackchan-01/token"
```

**Production checklist:** `STACKCHAN_ENABLED=true` + `MCP_API_KEY` (secret) + register each device token. Keep `STACKCHAN` off in plain local clones until those are set. Design: [`../docs/audio-sdk-plan.md`](../docs/audio-sdk-plan.md) ([中文](../docs/audio-sdk-plan.zh-CN.md)); MCP tool list: [`../docs/mcp-plan.md`](../docs/mcp-plan.md).

M1 tools: `list_devices`, `get_device_status`, `move_head`, `reset_pose`, `set_expression`, `show_text`, `set_led`, `speak`, `stop_audio`, `set_volume`, `emergency_stop`. MCP and the device socket share one Hub (`DeviceHub` / SessionHub): JSON-RPC 2.0 (`mediasession-rpc/1`) over `/ws/device`; S1 audio is PCM downlink (`audio.begin` / binary frames / `audio.end`; `stream.open` is S2). Tool ↔ method map: `DEVICE_METHODS` in `src/device/protocol.ts`.

### Voice conversation (streaming uplink → ASR → Grok Bot → streaming TTS, with barge-in)

Same gate as above (`STACKCHAN_ENABLED` + auth). Voice is **off** unless `ASR_PROVIDER` is set; with `ASR_PROVIDER` unset `session.hello` carries no `voice` block and the device must not stream. **Echo policy (fixed):** half-duplex + touch/PTT interrupt only — firmware keeps `GC_VOICE_BARGE_IN_BY_VAD=0` so energy VAD is deaf while speaking; `stop_audio` / `emergency_stop` / touch still interrupt. Overlong utterances: firmware truncates at the limit and sends a normal `audio.end`; the bridge accepts an exact-at-limit stream and only emits `stream.error` for oversize / timeout / seq gaps / count mismatches. Mid-stream TTS failure aborts immediately (`audio.end aborted` + `idle:tts_failed`).

Flow: device `event.speech_start` → `audio.begin {direction:"uplink", pcm_s16le, 16000, mono}` → `0x02` frames → `audio.end` → streaming ASR (`asr.transcript` partial/final) → the existing agent webhook with `device:{id,modality:"voice",turn_id,…}` (omitted for web chat) → reply posted to `reply.url` → streaming TTS (`stream-input`) → downlink `audio.begin` / frames (~1.2× pacing, `audio.credit`-aware) / `audio.end`. Turn state machine (`turn.state`): `idle → listening → transcribing → thinking → speaking → idle`. A new `speech_start`, `stop_audio`, `emergency_stop` or a reconnect interrupts: `audio.end reason=aborted`, upstream ASR/TTS sockets closed, a late agent reply is answered `200 {"ok":true,"dropped":"stale_turn"}`. Full protocol, diagrams and reason list: [`../docs/audio-sdk-plan.zh-CN.md`](../docs/audio-sdk-plan.zh-CN.md) §11.

| Name | Kind | Purpose | Default |
| --- | --- | --- | --- |
| `ASR_PROVIDER` | var | `mock`, `workers-ai`, `elevenlabs`; unset = voice off | unset |
| `TTS_PROVIDER` | var | `mock`, `mock-stream`, `elevenlabs`; unset = no TTS | unset |
| `ELEVENLABS_API_KEY` | secret | ElevenLabs key (header only, never in a URL or log) | – |
| `ELEVENLABS_VOICE_ID` `ELEVENLABS_TTS_MODEL` `ELEVENLABS_ASR_MODEL` `ELEVENLABS_HOST` | var | voice / models / API host | `JBFqnCBsd6RMkjVDRZzb` / `eleven_flash_v2_5` / `scribe_v2_realtime` / `api.elevenlabs.io` |
| `UPLINK_MAX_MS` `UPLINK_GRACE_MS` `UPLINK_IDLE_TIMEOUT_MS` `UPLINK_BEGIN_TIMEOUT_MS` | var | utterance limit and uplink timeouts | `15000 2000 3000 3000` |
| `ASR_TIMEOUT_MS` `AGENT_REPLY_TIMEOUT_MS` `VOICE_REPLY_MAX_CHARS` `VOICE_TURNS_PER_MIN` | var | turn timeouts / reply clip / rate limit | `10000 60000 1000 20` |
| `PLAYBACK_SLACK_MS` | var | wait for `playback.state` after the last frame | `3000` |

ElevenLabs setup (never put the key in a file you commit):

```bash
npx wrangler secret put ELEVENLABS_API_KEY      # deployed Worker
# local dev: set ELEVENLABS_API_KEY= in .dev.vars (git-ignored); .dev.vars.example has an empty placeholder
# then set TTS_PROVIDER=elevenlabs / ASR_PROVIDER=elevenlabs (vars)
npm run smoke:elevenlabs                         # Node path: reads ELEVENLABS_API_KEY from env, prints ok/fail + timings (never the key)
npm run smoke:elevenlabs:worker                  # workerd path: wrangler dev + POST /api/dev/elevenlabs-smoke (SITE_PASSCODE)
```

Automated tests use only mock providers (no network, no key). The ElevenLabs adapters use Worker outbound WebSockets (`fetch` + `Upgrade: websocket`). Prefer the worker smoke to validate workerd; the Node smoke is the fallback if Upgrade outbound is blocked.

Real-hardware end-to-end test checklist (Chinese, checkable): [`../docs/e2e-hardware-checklist.zh-CN.md`](../docs/e2e-hardware-checklist.zh-CN.md).

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

Requires **Node ≥ 22** (wrangler 4). Tests: `test/e2e.test.ts` (chat), `test/mcp.unit.test.ts` (MCP layer against an in-memory gateway), `test/device.e2e.test.ts` (MCP ⇄ DeviceHub ⇄ `test/mock-device.ts` over real WebSockets; configurable delay / error / ignore / disconnect), `test/voice.e2e.test.ts` (mock device + mock ASR / grokbot / TTS: full voice turn, barge-in, stop, limits, stale replies, failures), `test/voice.unit.test.ts` and `test/elevenlabs.unit.test.ts` (uplink validation, pacer, sentence splitting, provider registry, ElevenLabs protocol against a fake WebSocket).

Local `PUBLIC_ORIGIN` is localhost — a real Grok Bot cloud routine cannot reach it. Use a tunnel (`cloudflared`) for live routine debugging.

## Layout

```text
bridge/
  src/
    index.ts          HTTP Worker (MCP + device WS auth, device token admin)
    auth.ts           HMAC / SHA-256 / Bearer helpers, WS 4003 reject
    hub.ts            ChatHub Durable Object
    device/           DeviceHub (1 DO per device, JSON-RPC WS), DeviceRegistry, protocol, gateway
    mcp/              Streamable HTTP MCP server + the 11 tool definitions
    tts/              TtsProvider interface (streaming input), mock, sentence splitter, ElevenLabs
    asr/              AsrProvider interface (streaming), mock, workers-ai, ElevenLabs
    voice/            VoiceEngine turn state machine, uplink validation, downlink pacer
    net/              Workers outbound WebSocket helper, async queue
    elevenlabs/       shared ElevenLabs config (env → host/voice/models)
    page.html         Passcode-gated chat UI
    agents/
      types.ts        Provider interface
      registry.ts     AGENT_PROVIDER switch
      grokbot.ts      Webhook + reply.url (production)
      muse.ts         Stub for later
  scripts/            elevenlabs-smoke (manual, needs ELEVENLABS_API_KEY in env)
  test/               Vitest e2e
  wrangler.toml
```
