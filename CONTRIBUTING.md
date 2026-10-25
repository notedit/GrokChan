# Contributing to GrokChan

Thanks for helping build an open Grok Bot + M5Stack voice companion.

## Status

This repo is an early **scaffold**. Firmware and bridge code are placeholders; docs and architecture come first. Small, focused PRs are welcome.

## How to contribute

1. Open an issue describing the idea or bug before large changes.
2. Fork the repo and create a branch from `main`.
3. Keep secrets out of git — use env vars / `wrangler secret put` only.
4. Prefer clear Chinese or English in docs; match the style of existing READMEs.
5. Open a pull request with a short summary of *what* and *why*.

## Areas that need help

- M5Stack / ESP32 firmware (I2S mic, speaker, wake word, display face)
- Cloudflare Worker bridge (device session ↔ Grok Bot webhook routine)
- Docs, examples, and hardware BOM for Stack-chan–style builds

## Code of conduct

Be respectful. No harassment, no dumping stolen credentials or reverse‑engineered proprietary SDKs into the project.
