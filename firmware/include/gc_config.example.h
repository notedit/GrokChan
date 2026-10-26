// GrokChan firmware configuration.
//
//   cp include/gc_config.example.h include/gc_config.h     (gc_config.h is git-ignored)
//
// then edit gc_config.h. If gc_config.h is missing the build falls back to this file, which
// compiles but cannot connect (placeholder WiFi). Never put real secrets into this example.
//
// Items marked "待实机确认" were taken from the official M5Stack StackChan firmware source
// (MIT, read on the build box) or are conservative guesses; none has been verified on the
// user's hardware yet. See README.md "待实机确认清单".
#pragma once

// ---------------------------------------------------------------- network
#define GC_WIFI_SSID "your-wifi-ssid"
#define GC_WIFI_PASS "your-wifi-password"

// Bridge (Cloudflare Worker) address. Plain ws:// = TLS off, only for LAN / `wrangler dev`.
// For a deployed workers.dev bridge use GC_SERVER_TLS 1 and port 443.
#define GC_SERVER_HOST "grokchan-bridge.example.workers.dev"
#define GC_SERVER_PORT 443
#define GC_SERVER_TLS 1
// 1 = encrypted but the server certificate is NOT verified (works out of the box, vulnerable to
// MITM). 0 = reserved for CA verification, not implemented in M1. 待实机确认 (workers.dev reachability)
#define GC_TLS_INSECURE 1
#define GC_WS_PATH "/ws/device"  // the bridge appends nothing; ?device_id=<id> is added by the firmware

// Device id: [A-Za-z0-9_-]{1,64}; the bridge keys the Durable Object on it.
#define GC_DEVICE_ID "stackchan-01"
#define GC_FW_VERSION "0.1.0"
#define GC_HW_NAME "m5stack-cores3"

// ---------------------------------------------------------------- servos (SCS bus)  待实机确认
// All values below come from the official firmware (hal_servo.cpp); unverified with this firmware.
#define GC_SERVO_RX_PIN 7             // ESP32-S3 GPIO connected to the servo bus RX
#define GC_SERVO_TX_PIN 6             // ESP32-S3 GPIO connected to the servo bus TX
#define GC_SERVO_BAUD 1000000
#define GC_SERVO_ID_PAN 1             // yaw
#define GC_SERVO_ID_TILT 2            // pitch
#define GC_SERVO_ZERO_PAN 460         // raw position (0..1000) that is "pan = 0"
#define GC_SERVO_ZERO_TILT 620        // raw position that is "tilt = 0"
// Direction: +1 = raw increases with the protocol angle (pan: positive = robot's right,
// tilt: positive = up). Unknown on real hardware: flip the sign if the head moves the wrong way.
#define GC_SERVO_PAN_SIGN 1
#define GC_SERVO_TILT_SIGN 1
#define GC_SERVO_DEG_PER_STEP 0.3125f // raw step -> degrees
// Protocol speed (100..1000) -> degrees per second. 150 (default) * 0.3 = 45 deg/s.
#define GC_SERVO_DEG_PER_S_PER_SPEED 0.3f
// Hard raw-position safety window. Software limits of the bridge (pan +-90, tilt 0..60) apply first.
#define GC_SERVO_RAW_MIN 0
#define GC_SERVO_RAW_MAX 1000
#define GC_SERVO_RAMP_HZ 50           // official firmware streams targets at 50 Hz
#define GC_SERVO_RELEASE_TORQUE_IDLE 0 // 1 = release torque ~2 s after the last move (official does at rest)
#define GC_SERVO_POWER_PIN_EXPANDER 0 // PY32 pin that enables servo power (VM EN)

// ---------------------------------------------------------------- PY32 IO expander (LED ring + servo power)  待实机确认
#define GC_PY32_ADDR 0x6F
#define GC_PY32_I2C_FREQ 100000       // official driver uses 100 kHz
#define GC_PY32_LED_PIN 13
#define GC_LED_COUNT 12
// Which LED indexes are "left" / "right" (bit n = LED n). The real split is unknown.
#define GC_LED_LEFT_MASK 0x003F
#define GC_LED_RIGHT_MASK 0x0FC0
#define GC_LED_MAX_CHANNEL 168        // matches the bridge cap; lower it if the ring runs hot
#define GC_LED_BRIGHTNESS_DEFAULT 40  // percent, used by set_led when brightness is omitted (bridge also defaults)

// ---------------------------------------------------------------- limits / behaviour
#define GC_PAN_MIN (-90)
#define GC_PAN_MAX 90
#define GC_TILT_MIN 0
#define GC_TILT_MAX 60
#define GC_VOLUME_CAP 70              // percent; the bridge applies the same cap
#define GC_INITIAL_VOLUME 40
#define GC_LOW_BATTERY_PCT 10         // 待实机确认 (fuel gauge accuracy)
#define GC_LOW_BATTERY_VOLUME_CAP 40

// Audio ring buffer (PCM waiting for playback). 256 KB = 8 s of 16 kHz mono. Allocated from PSRAM
// when available, otherwise GC_AUDIO_RING_BYTES_NO_PSRAM.
#define GC_AUDIO_RING_BYTES 262144
#define GC_AUDIO_RING_BYTES_NO_PSRAM 49152
#define GC_AUDIO_PREBUFFER_MS 300     // 待实机确认 (WiFi jitter)
#define GC_SPEAKER_CHANNEL 0          // M5.Speaker virtual channel used for TTS

// Touching the screen = local emergency stop (halt head + stop audio + event.local_stop).
#define GC_TOUCH_EMERGENCY_STOP 1     // 待实机确认 (accidental triggers)

// ---------------------------------------------------------------- misc
#define GC_SERIAL_BAUD 115200
#define GC_LOG_PROTOCOL 0             // 1 = print every JSON-RPC frame to the serial log (noisy)
