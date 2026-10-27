# MCP plan: let Grok control an M5Stack Stack-chan (short English version)

> Status: **planning draft v0.1 (2026-10-26)**. Nothing here is implemented yet. The full, authoritative plan is in Chinese: [mcp-plan.zh-CN.md](mcp-plan.zh-CN.md). Items marked **TBC** are unverified or contradictory in public sources and must be checked on real hardware / official docs.

## Architecture

```text
Grok Bot ──MCP (Streamable HTTP, POST /mcp)──▶ bridge Worker ──WebSocket (wss /ws/device)──▶ M5Stack CoreS3 + Stack-chan
(MCP client)                                   ├─ stateless MCP handler                       (servos, LEDs, display, speaker)
                                               └─ DeviceHub Durable Object (one per device):
                                                  hibernating WS, pending-request table, JSON-RPC responses, event ring, rate limits, audit, TTS adapter
```

- Use Cloudflare's stateless `createMcpHandler` (not the deprecated `McpAgent`). Device sockets live in a per-device `DeviceHub` DO, not in an MCP session. Trade-off: adds `agents` / `@modelcontextprotocol/server` / `zod` runtime deps vs. a hand-written minimal JSON-RPC handler (open question).
- The existing chat path (`/api/chat` → webhook → `reply.url`) is untouched. Grok only runs when triggered, so device → Grok goes through that path (or M3 event forwarding to the webhook).
- Auth: per-device token (stored hashed, sent as `Authorization: Bearer` on the WS handshake, provisioned into NVS, never in git) and a separate `MCP_API_KEY` secret for `/mcp` (not shared with `SITE_PASSCODE` / webhook key). Scopes: `read`, `control`, `media`, `sensitive`.
- Multi-device: optional `device_id` on every tool; omitted = default device if only one, else `device_required` error. Online state = `session.hello` + heartbeat (15–30 s) + close events; offline calls fail fast with `device_offline`.

## Tools

| Phase | Tools |
| --- | --- |
| **M1 (MVP)** | `list_devices`, `get_device_status`, `set_expression`, `show_text`, `move_head` (pan/tilt/speed/relative), `reset_pose`, `set_led`, `speak` (cloud TTS), `stop_audio`, `set_volume`, `emergency_stop` |
| **M2** | `play_audio` (URL, fetched by the bridge, never by the device), `get_playback_state`, `perform_sequence` (≤30 steps, ≤60 s, device-side timeline), `play_animation`, streaming TTS, `set_brightness` |
| **M3 (optional)** | `get_events` (long-poll), `take_photo`, `listen` (ASR transcript), `get_touch_state`, `set_wake_word`, `set_privacy` (can only reduce, never enable remotely) |

Every tool takes optional `device_id` and `request_id` (idempotency key, 60 s). Results are `{ok, device_id, command_id, status: accepted|done|queued, result}` or `{ok:false, error:{code,message,retry_after_ms}}`. Reference ranges from the official firmware's `self.robot.set_head_angles`: yaw −128…128, pitch 0…90, speed 100…1000; LED channels 0…168. Defaults are tighter (pan ±90, tilt 0…60; natural ±45); out-of-range values are clamped and reported with `clamped:true`.

## Device ↔ bridge protocol (JSON-RPC 2.0, `mediasession-rpc/1`)

> Decision (2026-10-26): the device WebSocket speaks **JSON-RPC 2.0**, replacing the earlier custom `hello/cmd/ack/state/event/audio_begin/audio_end` frames. Details: Chinese doc §3.

- **Framing**: each WS text frame is one JSON-RPC 2.0 object (no batches); `params` are always named objects; `id` is a string (`c_…` from the bridge, `d_…` from the device). Reserved `params._meta`: `ttl_ms` (relative; expired → `-32008`), `idempotency_key`, `seq` (monotonic, latest-wins for motion).
- **Bridge → device requests** (device replies with `result` / `error`): `device.get_status`, `device.move_head`, `device.reset_pose`, `device.set_expression`, `device.show_text`, `device.set_led`, `device.speak`, `device.stop_audio`, `device.set_volume`, `device.emergency_stop` — 1:1 with the MCP tools (M2+: `device.play_audio`, `device.perform_sequence`, …). Motion tools accept `wait: "accepted"` (default) or `"done"`; `device.speak` only acks acceptance and playback progress comes as `playback.state` notifications.
- **Device → bridge**: `session.hello` is a **request** (device must send it within 10 s; the response carries `session_id`, `heartbeat_s`, the chosen downlink audio format); notifications (no `id`): `state.update` (heartbeat snapshot), `event.<name>` (`touch`, `wake_word`, `speech_transcript`, `battery_low`, `servo_fault`, `sequence_done`), `playback.state`, `audio.credit`, `ping` (answered by a DO auto-response `pong`). Bridge → device notifications: `audio.begin`, `audio.end`, `pong`.
- **Audio** stays as binary WS frames `[type u8][flags u8][stream u16][seq u32 LE][payload]` (0x01 downlink audio, 0x02 uplink mic, 0x03 photo; flags bit0 = last frame), delimited by `audio.begin {stream_id, format, sample_rate, channels, chunk_bytes, total_bytes?}` and `audio.end {stream_id, total_chunks, total_bytes, reason: complete|aborted}` notifications. `speak` order: TTS synth → `device.speak` request → response → `audio.begin` → binary chunks → `audio.end` → `playback.state` notifications.
- **Errors**: standard `-32700 … -32603`, plus custom `-32000 … -32099`: `-32000 busy`, `-32001 limit_exceeded`, `-32002 low_battery`, `-32003 timeout`, `-32004 unauthorized`, `-32005 privacy_blocked`, `-32006 unsupported`, `-32007 rate_limited`, `-32008 expired`, `-32009 device_fault`, `-32010 payload_too_large`, `-32011 quiet_hours`, `-32012 stream_error`; each maps to an MCP tool error code (`busy`, `rejected_limit`, `low_battery`, `timeout`, …). Bridge-originated errors: `device_offline`, `device_not_found`, `device_required`, `timeout`, `tts_failed`, `invalid_args`, `interrupted` (a `speak` cut off by `stop_audio` / `emergency_stop` / `interrupt`).
- **Dedup / retry**: device remembers the last 32 `id`s and idempotency keys for 60 s (same id → replay the cached response; same key → cached result); the bridge also dedups by MCP `request_id` for 60 s. Physical commands are never auto-retried (bridge timeout → `timeout`, no resend; only `device.get_status` retries once); reconnect fails all pending requests with `device_offline`.
- **Audio delivery** (TTS synthesized in the cloud): **M1** whole-utterance synthesis then chunked push over the WS (PCM16 16 kHz for bring-up, MP3 for practical Chinese TTS); **M2** streaming with Opus (also the codec for mic uplink); device-pulls-signed-URL is optional later; on-device TTS is not planned. The device advertises decoders in `session.hello`; the bridge asks the TTS provider for a format the device can decode (no transcoding in the Worker). M1 ships only an injectable TTS interface + mock. TTS candidates: Workers AI MeloTTS (multilingual, output format TBC), Deepgram Aura (en/es), or an external provider.
- Alternative considered: xiaozhi-style MCP dialect (official firmware already has an `McpServer` with `self.robot.*` tools). Kept as an optional bridge-side adapter (`device.*` → `tools/call self.robot.*`), not planned.

## MCP resources / prompts (optional)

Resources: `stackchan://devices`, `…/{id}/status`, `…/capabilities`, `…/events`, `…/audit`. Prompts: `stackchan_persona` (ranges, etiquette, privacy), `greet_user`, `react_to_event`, `bedtime`.

## Safety and limits

Servo hard limits in firmware + soft limits in bridge (device is authoritative); latest-wins coalescing for motion; stall/overheat protection with cool-down; LED cap and ≤3 Hz blink; hard volume cap and quiet hours; low-battery lockout of motion; `emergency_stop` bypasses rate limits. Rate limits per key and per device/tool class (e.g. motion 5/s, speak 6/min with queue ≤3, photo 6/min), daily TTS character budget. Camera/mic off by default and only enabled on the device itself; visible indicators; audit log of metadata only. Environment text (transcripts, fetched audio) is untrusted. `play_audio` guards: https only, SSRF blocklist, size/duration/type limits, optional allowlist.

## Milestones and firmware

- **M0** bridge skeleton + mock device + `/mcp` `tools/list` (no hardware). **M1** connect (`session.hello` / `state.update` / JSON-RPC responses) + expression + head + LED + `speak`. **M2** sequences + animations + `play_audio` + streaming audio. **M3** wake word / touch / events / camera / `listen`. **M4+** signed OTA, groups, OAuth, per-LED control.
- Target hardware (verified from the official README/docs): M5Stack **StackChan** — CoreS3 (ESP32-S3, 16 MB flash, 8 MB PSRAM, 2.0″ touch LCD, 0.3 MP camera, dual mics, 1 W speaker, IMU), body with 550 mAh battery, two feedback servos (yaw 360° continuous, pitch 90°), 12 RGB LEDs, IR, 3-zone touch, NFC. The original `stack-chan/stack-chan` (Moddable, SCServo/Dynamixel) is a different hardware/firmware line — which one the user owns is TBC.
- Recommended firmware: **ESP-IDF** (official firmware uses ESP-IDF v5.5.4) as a `grokchan` component on top of `m5stack/StackChan` (license of the whole repo TBC; the inspected file has an MIT header), alternative PlatformIO/Arduino with M5Unified for a quick prototype. Servo bus pins conflict between sources (`x:7 y:6` vs TX=GPIO6/RX=GPIO7) — **TBC from official source/schematic**.

## Open questions (details in the Chinese doc §7)

1. Can Grok Bot mount a custom remote MCP server, and with which auth (Bearer header / OAuth)? 2. Which hardware does the user own (official StackChan vs original)? 3. Extend official ESP-IDF firmware or rewrite on Arduino? 4. (Decided: JSON-RPC 2.0 own protocol) add an optional xiaozhi-dialect adapter later? 5. `createMcpHandler` deps vs hand-written minimal MCP handler (M1 uses the latter, zero runtime deps)? 6. Which Chinese TTS provider/voice? 7. Chinese font strategy on the display? 8. Camera/mic/wake word scope and privacy defaults? 9. Single vs multiple devices in MVP? 10. Event-driven / proactive triggering of Grok? New: `session.hello` as request vs notification, firmware JSON library and stable WS frame size, string JSON-RPC ids. Plus hardware facts to verify: servo pins/IDs/limits/speed unit, LED pin and current limits, avatar expression set, battery API, available Opus/MP3 decoders, WS frame size, TTS formats/latency, repo licenses, `workers.dev` reachability from the user's network.
