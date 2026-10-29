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

Status v0.4 (2026-10-28): mediasession-rpc/1; stay in bridge; S1 = PCM + full M1 MCP + begin/end (stream.open = S2). Auth landed (device Bearer token + MCP_API_KEY). Echo = half-duplex + touch/PTT. Truncate-at-limit accepted. TTS mid-fail aborts. Voice providers unset by default; production checklist in bridge README.


## Voice conversation (S1 addendum; implemented in bridge + firmware core)

Full chain: device mic → uplink stream → streaming ASR → existing agent webhook (`inbound.device = {id, modality:"voice", turn_id, …}`, reply via `reply.url`, stale turns dropped) → streaming TTS (`stream-input`, text fed by sentence) → paced downlink (~1.2× real time, `audio.credit` aware) → playback; with barge-in.

```text
idle ──speech_start / uplink audio.begin──▶ listening ──speech_end / audio.end──▶ transcribing ──final──▶ thinking ──reply──▶ speaking ──playback ended──▶ idle
any state ──new speech_start | stop_audio | emergency_stop | disconnect──▶ (audio.end aborted, cancel ASR/agent/TTS, drop stale replies) ──▶ idle / listening
```

Uplink: `event.speech_start`, `audio.begin {direction:"uplink", pcm_s16le, 16000, mono}`, type `0x02` frames, `audio.end`, `event.speech_end`; ≤15 s per utterance (announced in `session.hello` result `voice.uplink`; over-limit/timeouts/gaps discard the utterance with `stream.error`). Bridge → device: `turn.state`, `asr.transcript`, `turn.reply`, `stream.error`. Providers: `ASR_PROVIDER` / `TTS_PROVIDER` = `mock` (default for tests), `elevenlabs` (Scribe realtime WS + TTS `stream-input` WS; key only via `wrangler secret put ELEVENLABS_API_KEY`). Details, sequence diagram, reasons and config table: [zh-CN §11](audio-sdk-plan.zh-CN.md). Firmware mic platform layer: unverified on hardware (待实机确认), off by default (`GC_VOICE_ENABLED 0`).
