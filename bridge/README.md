# Bridge (Cloudflare Worker)

> Status: **scaffold docs**. Implementation can reuse the same pattern as a web chat Worker that talks to a Grok Bot webhook routine.

## Idea

The device (or a thin web debug UI) should not hold the Grok Bot webhook key. The Worker:

1. Accepts a chat turn from the device (`POST /api/chat`).
2. POSTs an event to the Grok Bot webhook routine, including a **one-shot** `reply.url`.
3. Accepts the routine’s reply on that URL (`POST /api/reply/<token>`).
4. Returns text (and later TTS) to the device via poll or stream.

Durable Objects (SQLite) are a good fit for per-session pending replies.

## Environment variables

**Non-secret vars** (e.g. `wrangler.toml` `[vars]`):

| Name | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Public `https://…` origin used to build `reply.url` (no trailing slash) |
| `GROK_WEBHOOK_HEADER` | Auth header name (often `Authorization`) |
| `GROK_WEBHOOK_SCHEME` | `Bearer` or `raw` |

**Secrets** (`wrangler secret put` only — never commit):

| Name | Purpose |
| --- | --- |
| `GROK_WEBHOOK_URL` | Routine webhook URL |
| `GROK_WEBHOOK_KEY` | Routine sender key |
| Optional device / site shared secret | Gate who may call `/api/chat` |

Copy `.dev.vars.example` → `.dev.vars` for local `wrangler dev`. Real values stay on your machine and in Cloudflare secrets.

## Grok Bot routine

Create a webhook-triggered routine (name it something like **device bridge**). The prompt should:

1. Read the inbound user text / transcript from the event body.
2. Produce the assistant reply.
3. `POST` the reply JSON to `reply.url` with the expected shape.
4. Optionally sync a short summary to your main chat (optional product choice).

## What is not in this repo yet

- Full Worker source (coming; keep this folder docs-first for now)
- Deployed URLs, passcodes, or webhook keys

When adding code, start from a minimal Worker + Durable Object and document every secret in this README — not in source.
