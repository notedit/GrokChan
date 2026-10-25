# Firmware (M5Stack / ESP32)

> Status: **placeholder**. Arduino / PlatformIO project files will land here later.

## Goal

Stack-chan–style desktop companion firmware:

- Capture voice from the onboard / I2S microphone
- Send audio or ASR text to the bridge Worker
- Play TTS / reply audio on the speaker
- Show a simple face / status on the LCD

## Planned stack

- Board: M5Stack Core / Core2 / Atom / compatible ESP32 variants
- Framework: Arduino or PlatformIO (TBD)
- Transport: HTTPS to the bridge (`POST /api/chat`, poll or stream for replies)

## Layout (forthcoming)

```text
firmware/
  README.md          ← you are here
  platformio.ini     (later)
  src/main.cpp       (later)
```

## Contributing

Hardware bring-up PRs welcome: mic gain, wake-word options, face animations, power management. Keep board-specific secrets (Wi‑Fi passwords, device tokens) out of the repo — use compile-time env or NVS provisioning.
