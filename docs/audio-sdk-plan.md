# Audio + Signaling + MCP SDK Design (draft)

> Status: **design draft v0.3 (S0→S1 in bridge; stream.open deferred to S2) (2026-10-27)** — MCP integrated into the same stack. Confirm before coding.  
> Full Chinese: [audio-sdk-plan.zh-CN.md](audio-sdk-plan.zh-CN.md). Prior MCP-only plan: [mcp-plan.md](mcp-plan.md) (to be marked absorbed after confirm).

## One kernel, two faces

```text
Grok Bot  --MCP POST /mcp-->  Worker  --JSON-RPC+binary WS-->  Device / Client SDK
                 \               |
                  \         SessionHub DO (per device/session)
                   \         media streams + device.* + TTS hooks
                    \-> tools/call maps 1:1 to hub methods
```

- **Device face:** WebSocket, JSON-RPC signaling, binary PCM/Opus frames (8-byte header unchanged), reconnect.  
- **Agent face:** Streamable HTTP MCP; M1 tools (`list_devices`, `move_head`, `speak`, …) share schemas with `device.*` / `stream.*`.  
- **`speak`:** injectable TTS → downlink `audio.begin` / frames / `audio.end`.  
- Existing `/api/chat` ChatHub stays as-is.

## Packages

`mediasession-protocol` (types, frames, **single source for MCP schemas + RPC methods**) · `mediasession-server` (DO + WS + play) · `mediasession-mcp` (MCP adapter) · `mediasession-client`.

## Milestones

- **S0** protocol + schema table + frame interop with current GrokChan  
- **S1** server/client + `/mcp`, PCM speak/play, reconnect e2e  
- **S2** Opus bi-di + device controls on same hub  
- **S3** auth, durable resume, bridge switches to packages, mcp-plan marked absorbed  

## Open decisions

Confirmed: mediasession-rpc/1; stay in bridge (no packages yet); S1 = PCM + full M1 MCP + begin/end only (stream.open = S2); auth still off (STACKCHAN_ENABLED).
