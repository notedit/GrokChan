#!/usr/bin/env bash
# One-shot (re)deploy of the GrokChan bridge to Cloudflare Workers.
# Reads secrets from ${GC_ENV_FILE:-/home/box/secrets/grokchan.env} (never committed).
# wrangler.toml is NOT modified: production vars are passed with --var, secrets with --secrets-file.
# Requires CLOUDFLARE_API_TOKEN (+ Node >= 22 for wrangler 4).
set -euo pipefail
ENV_FILE="${GC_ENV_FILE:-/home/box/secrets/grokchan.env}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/node-v22.23.4-linux-x64/bin:$PATH"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
# Only values from the env file are used: ambient shell variables (e.g. a stray GROK_WEBHOOK_KEY) are ignored.
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
GC_ORIGIN="$(get GC_ORIGIN)"
[ -n "$GC_ORIGIN" ] && [ -n "$(get MCP_API_KEY)" ] && [ -n "$(get SITE_PASSCODE)" ] && [ -n "$(get ELEVENLABS_API_KEY)" ] || { echo "env file lacks GC_ORIGIN/MCP_API_KEY/SITE_PASSCODE/ELEVENLABS_API_KEY" >&2; exit 1; }

SECRETS="$(mktemp)"; chmod 600 "$SECRETS"; trap 'rm -f "$SECRETS"' EXIT
node -e '
const k=["MCP_API_KEY","SITE_PASSCODE","ELEVENLABS_API_KEY","GROK_WEBHOOK_URL","GROK_WEBHOOK_KEY"];
const fs=require("fs");const lines=fs.readFileSync(process.argv[2],"utf8").split("\n");
const o={};for(const l of lines){const m=/^([A-Z_]+)=(.*)$/.exec(l);if(m&&k.includes(m[1])&&m[2])o[m[1]]=m[2];}
fs.writeFileSync(process.argv[1],JSON.stringify(o));' "$SECRETS" "$ENV_FILE"

cd "$HERE/../bridge"
exec npx wrangler deploy \
  --var "PUBLIC_ORIGIN:${GC_ORIGIN}" \
  --var "STACKCHAN_ENABLED:true" \
  --var "ASR_PROVIDER:elevenlabs" \
  --var "TTS_PROVIDER:elevenlabs" \
  --secrets-file "$SECRETS" "$@"
