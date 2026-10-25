# Phone-use

Remote control of a phone by the agent — tap, swipe, type, screenshot — the same idea as Grok Bot **Phone Use**, Mobilerun-style cloud phones, or Android wireless debugging + screen mirror.

English is the default. Chinese: [phone-use.zh-CN.md](phone-use.zh-CN.md).

> **Not** the Grok Bot mobile chat app. Phone-use means the agent **drives** a device UI.

## Goal

Let **GrokChan** (via **Grok Bot** as the agent) drive a real or cloud **Android / iOS** phone so chat clients (Browser, later M5Stack) can ask the bot to operate apps on a handset.

Status in this repo: **roadmap / scaffold only**. No working automation ships here yet. See [`phone-use/`](../phone-use/).

## How it relates to `bridge/`

| Layer | Role |
| --- | --- |
| `bridge/` | **Chat ↔ agent** only (Browser / M5Stack / optional phone-as-client) |
| Phone-use | **Agent capability** — tools on Grok Bot (MCP, device session), **not** a new `AGENT_PROVIDER` |

Do **not** add a `phone` provider next to `grokbot` / `muse` for remote control. Those adapters select which upstream brain receives chat. Phone-use is what that brain *does* with device tools.

**Optional later:** treat a phone as a **client** of the bridge for voice/chat (same path as M5Stack firmware) — orthogonal to controlling the phone’s UI.

```text
Browser / M5Stack  ←→  bridge/  ←→  Agent (grokbot)
                                      │
                                      ├── chat reply.url (today)
                                      └── phone tools (roadmap)
                                            ├── Option A: cloud phone MCP
                                            └── Option B: own Android (ADB / mirror)
```

## Option A — Hosted cloud phone (MCP)

Use a hosted Android/iOS environment that exposes an **MCP** (or similar tool API) the agent can connect to.

Examples of the *shape* (names may change; evaluate current vendors yourself):

- **Mobilerun** (or similar) cloud phone + MCP connector
- Agent session attaches MCP → tools for tap / swipe / type / screenshot / app launch

**Pros:** No local ADB, works from the agent’s cloud context, multi-user friendly.  
**Cons:** Vendor lock-in, cost, privacy of what’s on the cloud device.

Contributor sketch:

1. Document the chosen MCP tool names and auth model (env / vault — never git).
2. Wire the connector into the Grok Bot that already powers the bridge routine.
3. Add a short “phone-use enabled” note to the routine so web/M5Stack users know the bot can accept device tasks.

## Option B — Own Android (wireless debugging + mirror)

Drive a physical phone you own, Phone Use Bot style:

- Enable **wireless debugging** (Android)
- Reach the device over a private network (**Tailscale** or similar) when the agent/host is not on LAN
- Screen mirror / accessibility / ADB input for tap, swipe, type, screenshot

**Pros:** Your hardware, full control, no per-minute cloud phone bill.  
**Cons:** Network setup, device online requirements, iOS is much harder without vendor APIs.

Contributor sketch:

1. Document a minimal “agent host ↔ phone” path (ADB over Tailscale is a common pattern).
2. Keep ADB keys and Tailscale auth **out of the repo**; use local secrets / vault.
3. Prefer a thin wrapper script under `phone-use/` later — still no credentials in git.

## Out of scope (this scaffold)

- Shipping ADB private keys, wireless-debug pairing codes, or cloud API keys in git
- Pasting live secrets into docs, issues, or example `.env` files committed to the tree
- Reverse-engineering closed SDKs or proprietary Phone Use binaries
- Claiming a production phone-use implementation exists in this repo today

## Next concrete steps for contributors

1. Pick **Option A**, **Option B**, or both for your deployment; open an issue with the choice.
2. For A: prototype connecting one cloud-phone MCP to the same Grok Bot used by `bridge/`; list tool names and a sample “open Settings and screenshot” prompt.
3. For B: write a bring-up checklist (wireless debugging, Tailscale, adb devices, one tap test) in a PR under `phone-use/` — still no secrets.
4. Keep `bridge/` chat routes and `agents/grokbot` / `agents/muse` unchanged unless a tiny comment clarifies the chat-vs-device split.
5. When something works end-to-end, flip the Status checkbox in the root README and add a short demo note (GIF/link welcome; no keys).

## See also

- [architecture.md](architecture.md) — clients + agent providers
- [`bridge/`](../bridge/) — chat Worker (unchanged by this scaffold)
- [`phone-use/README.md`](../phone-use/README.md) — folder placeholder
