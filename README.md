# GrokChan

**Open-source Grok Bot + M5Stack voice companion (Stack-chan style).**

Bridge a browser or ESP32 device to your own [Grok Bot](https://grok.com) via a Cloudflare Worker. Designed so more agents (e.g. Muse) can plug in later.

> **Docs language:** English is the default. 中文请看 [README.zh-CN.md](README.zh-CN.md).

## Status

- [x] Repo, MIT license, contributing guide
- [x] **Bridge Worker** (web chat ↔ Grok Bot webhook, multi-agent adapters)
- [ ] M5Stack firmware minimum viable chat
- [ ] TTS / face / wake word

## Architecture

```text
Browser / M5Stack  ←→  bridge/ (Cloudflare Worker + DO)  ←→  Agent (grokbot | muse…)
```

Details: [docs/architecture.md](docs/architecture.md) · 中文：[docs/architecture.zh-CN.md](docs/architecture.zh-CN.md)

| Path | Contents |
| --- | --- |
| [`bridge/`](bridge/) | Deployable Worker, chat UI, `agents/grokbot` + `agents/muse` stub |
| [`firmware/`](firmware/) | ESP32 / M5Stack placeholder |
| [`docs/`](docs/) | Architecture (EN + zh-CN) |

## Quick start (bridge)

```bash
cd bridge
npm install
cp .dev.vars.example .dev.vars   # placeholders only
npm run dev                      # http://localhost:8787
```

Production: set `PUBLIC_ORIGIN`, then `wrangler secret put` for `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, and `SITE_PASSCODE`. Full steps and the **secret-redaction caveat** are in [bridge/README.md](bridge/README.md).

Inbound schema for Grok Bot routines remains `grokbot-web.inbound.v1` for compatibility.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep secrets out of git.

## License

[MIT](LICENSE) © notedit
