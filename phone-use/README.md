# Phone-use (placeholder)

> Status: **scaffold only**. No automation, ADB helpers, or cloud-phone clients ship here yet.

**Phone-use** = the agent remotely controls a phone (tap / swipe / type / screenshot). It is **not** the Grok Bot mobile chat app.

## Read first

- English: [docs/phone-use.md](../docs/phone-use.md)
- 中文: [docs/phone-use.zh-CN.md](../docs/phone-use.zh-CN.md)
- Architecture: [docs/architecture.md](../docs/architecture.md)

## Relationship to the rest of the repo

- [`bridge/`](../bridge/) stays **chat ↔ agent**. Phone-use is an **agent capability** (tools on Grok Bot), not a new `AGENT_PROVIDER`.
- Optional later: phone as a **bridge client** for voice/chat (like [`firmware/`](../firmware/)).

## What belongs here later

- Bring-up checklists and contributor notes
- Thin wrappers / examples that load credentials from the environment or a vault
- Links to chosen MCP vendors or open ADB mirror flows

## What must never land here

- ADB private keys, wireless-debug pairing codes, Tailscale auth keys
- Cloud phone API tokens or pasted secrets in sample files
- Reverse-engineered closed SDKs

PRs that only add docs or secret-free scaffolding are welcome.
