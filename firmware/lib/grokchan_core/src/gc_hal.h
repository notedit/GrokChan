// Hardware abstraction interfaces. The core only talks to these; src/platform/ holds the
// M5Unified / Arduino implementations and test/test_core/fakes.h holds host fakes.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace gc {

struct Pose {
  int pan = 0;   // degrees, protocol convention: negative = robot's left
  int tilt = 0;  // degrees, 0 = level, positive = up
};

class IHead {
 public:
  virtual ~IHead() = default;
  // Non-blocking. Start moving towards pan/tilt (already inside the soft limits). speed is the
  // protocol 100..1000 value. Returns false on a hardware fault (servo not answering).
  virtual bool moveTo(int pan, int tilt, int speed) = 0;
  // Current (measured or estimated) pose. Returns false if unknown / servo fault.
  virtual bool getPose(Pose& out) = 0;
  virtual bool isMoving() = 0;
  // Stop where we are, immediately.
  virtual void halt() = 0;
  // True when a fault (stall, no reply) was detected since the last call (edge, auto-cleared).
  virtual bool takeFault(std::string& reason) = 0;
  // Call often from the main loop (motion ramp, torque release).
  virtual void tick(uint32_t nowMs) = 0;
};

enum class TextPosition { Bubble, Center, Bottom };
enum class TextSize { Small, Medium, Large };

class IDisplay {
 public:
  virtual ~IDisplay() = default;
  // name is one of the hello expressions; the core guarantees it is known.
  virtual void setExpression(const std::string& name) = 0;
  // Eyes look towards (pan,tilt) degrees; purely cosmetic (may be ignored).
  virtual void lookAt(int pan, int tilt) = 0;
  virtual void setSpeaking(bool speaking) = 0;
  // text is valid UTF-8, already truncated by the core.
  virtual void showText(const std::string& text, TextPosition pos, TextSize size) = 0;
  virtual void clearText() = 0;
  virtual void tick(uint32_t nowMs) = 0;
};

enum class LedSide { Left, Right, Both };
enum class LedMode { Solid, Breathe, Blink, Off };

class ILed {
 public:
  virtual ~ILed() = default;
  // r,g,b are already scaled to the device's safe range (<= ledMax).
  virtual void set(LedSide side, uint8_t r, uint8_t g, uint8_t b, LedMode mode) = 0;
  virtual void tick(uint32_t nowMs) = 0;
};

// Sink for PCM s16le chunks. The core hands over at most one chunk per submit() and never
// more than the sink says it can accept. pending() = number of submitted chunks that have not
// finished playing yet (the core compares it with its own in-flight list).
class IPcmSink {
 public:
  virtual ~IPcmSink() = default;
  virtual bool canSubmit() = 0;
  // data is 16-bit little endian samples (len in bytes, even). The sink must copy it.
  virtual bool submit(const uint8_t* data, size_t len, uint32_t sampleRate, uint8_t channels) = 0;
  virtual size_t pending() = 0;
  virtual void stop() = 0;  // drop everything, silence now
  virtual void setVolume(int percent) = 0;  // 0..100 (already capped by the core)
  virtual void setMuted(bool muted) = 0;
};

class ISystem {
 public:
  virtual ~ISystem() = default;
  virtual uint32_t millis() = 0;
  virtual int batteryPercent() = 0;  // 0..100, -1 unknown
  virtual bool charging() = 0;
  virtual int wifiRssi() = 0;  // dBm, 0 unknown
  virtual uint32_t random(uint32_t maxExclusive) = 0;
  // Persistence for set_volume persist=true (NVS on device).
  virtual void saveVolume(int percent) = 0;
  virtual void log(const char* line) = 0;
};

struct Hal {
  IHead& head;
  IDisplay& display;
  ILed& led;
  IPcmSink& audio;
  ISystem& sys;
};

// WebSocket client abstraction. Implementations must call the listener from tick()/loop context
// (never from another task).
class ITransportListener {
 public:
  virtual ~ITransportListener() = default;
  virtual void onTransportConnected() = 0;
  virtual void onTransportClosed(int code) = 0;
  virtual void onTransportText(const char* data, size_t len) = 0;
  virtual void onTransportBinary(const uint8_t* data, size_t len) = 0;
};

class ITransport {
 public:
  virtual ~ITransport() = default;
  virtual void setListener(ITransportListener* l) = 0;
  // Start one connection attempt. Must NOT auto-reconnect by itself (core owns the backoff).
  virtual void connect() = 0;
  virtual void disconnect() = 0;
  virtual bool isConnected() = 0;
  virtual bool sendText(const std::string& s) = 0;
  virtual bool sendBinary(const uint8_t* data, size_t len) = 0;
  virtual void loop() = 0;
};

}  // namespace gc
