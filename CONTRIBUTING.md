# Contributing to GrokChan

Thanks for helping build an open Grok Bot + M5Stack voice companion.

English is the default for docs and review comments. Chinese is welcome in issues/PRs; keep user-facing repo docs mirrored (EN primary + `.zh-CN.md` where we already have a pair).

## How to contribute

1. Open an issue for large ideas before coding.
2. Fork and branch from `main`.
3. **Never commit secrets** — use `.dev.vars` locally and `wrangler secret put` in Cloudflare.
4. Prefer small PRs with a clear *what* / *why*.
5. New upstream brains belong under `bridge/src/agents/` behind `AgentProvider` (see `grokbot.ts` / `muse.ts`), not as one-off routes in `index.ts`.

## Areas that need help

- M5Stack / ESP32 firmware (I2S mic, speaker, wake word, face)
- Bridge: Muse (or other) agent adapters, TTS, device auth
- Docs, BOM, Stack-chan–style build notes

## Code of conduct

Be respectful. No harassment. Do not dump stolen credentials or reverse-engineered proprietary SDKs into the project.
