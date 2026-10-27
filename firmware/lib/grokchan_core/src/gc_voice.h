// Voice uplink: turns a microphone (IMic) into the mediasession-rpc/1 uplink stream
//   event.speech_start -> audio.begin(direction=uplink) -> binary frames (type 0x02) -> audio.end -> event.speech_end
// with an energy VAD (or push-to-talk) deciding when a turn starts and ends, a pre-roll so the first
// syllable is not cut, the bridge-announced utterance limits, and the interruption rules.
// Pure logic, no hardware: the platform layer only supplies IMic. Spec: docs/audio-sdk-plan.zh-CN.md
// chapter "语音对话全链路".
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace gc {

// Mic source: 16 kHz mono pcm_s16le. read() never blocks.
class IMic {
 public:
  virtual ~IMic() = default;
  virtual bool start() = 0;            // power the mic / claim the I2S bus; false = unavailable
  virtual void stop() = 0;
  // Copy up to `max` bytes (even count) of captured audio. Returns the number of bytes (0 = nothing yet).
  virtual size_t read(uint8_t* dst, size_t max) = 0;
};

// What VoiceUplink needs from the session (implemented by DeviceClient).
class IVoiceLink {
 public:
  virtual ~IVoiceLink() = default;
  virtual bool linkReady() = 0;
  virtual bool linkSendText(const std::string& json) = 0;
  virtual bool linkSendBinary(const uint8_t* data, size_t len) = 0;
};

enum class UplinkState { Off, Idle, Listening, Cooldown };
const char* uplinkStateName(UplinkState s);

struct VoiceConfig {
  bool vad = true;                 // energy VAD triggers turns (false: push-to-talk only)
  // Mic and speaker share one I2S bus on CoreS3 and there is no echo canceller: by default the VAD is
  // deaf while audio plays (half duplex). Push-to-talk still barges in.   待实机确认
  bool bargeInByVad = false;
  uint32_t analysisFrameMs = 20;
  uint32_t frameBytes = 1280;      // uplink binary frame payload (40 ms)
  uint32_t prerollMs = 300;
  uint32_t startFrames = 5;        // consecutive loud analysis frames to start (100 ms)
  uint32_t hangoverMs = 700;       // silence that ends the utterance
  uint32_t minRms = 500;           // absolute floor of the trigger threshold (s16 units)   待实机确认
  uint32_t triggerRatio = 3;       // trigger = max(minRms, noiseFloor * ratio)
  uint32_t cooldownMs = 400;       // after a turn: quiet needed before re-arming
  uint32_t maxMs = 15000;          // overwritten by session.hello result.voice.uplink
  uint32_t maxBytes = 480000;
  std::string lang;                // optional hint for ASR
};

class VoiceUplink {
 public:
  VoiceUplink(IMic& mic, IVoiceLink& link, const VoiceConfig& cfg = VoiceConfig()) : mic_(mic), link_(link), cfg_(cfg) {}

  // session.hello result.voice.uplink (absent => bridge has no ASR => stays Off).
  void onBridgeHello(bool voiceAvailable, uint32_t maxMs, uint32_t maxBytes);
  // Session lost / replaced: nothing can be sent, forget everything (the bridge discards the turn too).
  void onLinkDown();

  // Main loop. `playbackBusy` = the speaker has audio queued / playing.
  void tick(uint32_t now, bool playbackBusy);

  // Push-to-talk (button / touch): down starts a turn immediately (also barges in), up ends it.
  // Returns true if the press started a turn (or one was already running).
  bool pttDown(uint32_t now, bool playbackBusy);
  void pttUp(uint32_t now);

  // Local interruption (emergency stop): end the open uplink with audio.end reason=aborted.
  void abort(const char* why);

  // Bridge notifications.
  void onTurnState(const std::string& state, const std::string& reason);
  void onStreamError(uint32_t streamId, const std::string& reason);

  // The platform layer calls this when barge-in must silence the speaker at once (set by DeviceClient).
  struct Listener {
    virtual ~Listener() = default;
    virtual void onBargeIn() = 0;  // user spoke over playback: stop local audio now
  };
  void setListener(Listener* l) { ln_ = l; }

  UplinkState state() const { return st_; }
  bool micActive() const { return micOn_; }
  const std::string& turnState() const { return turnState_; }   // last bridge turn.state
  uint16_t streamId() const { return sid_; }
  uint32_t sentBytes() const { return bytes_; }
  uint32_t sentFrames() const { return seq_; }
  uint32_t turns() const { return turns_; }
  uint32_t noiseFloor() const { return floor_; }

 private:
  bool begin(uint32_t now, bool ptt);
  void end(uint32_t now, bool aborted, bool announce, const char* why);
  void sendFrame(const uint8_t* p, size_t n, uint32_t now);
  void flushPending(uint32_t now);
  void pushAudio(const uint8_t* p, size_t n, uint32_t now);
  uint32_t rmsOf(const uint8_t* p, size_t n) const;
  void micOff();
  void enterCooldown(uint32_t now);

  IMic& mic_;
  IVoiceLink& link_;
  VoiceConfig cfg_;
  Listener* ln_ = nullptr;

  UplinkState st_ = UplinkState::Off;
  bool available_ = false, micOn_ = false, ptt_ = false;
  std::string turnState_ = "idle";
  uint16_t sid_ = 0, nextSid_ = 1;
  uint32_t seq_ = 0, bytes_ = 0, turns_ = 0;
  uint32_t floor_ = 200;              // adaptive noise floor (rms)
  uint32_t loudRun_ = 0;              // consecutive loud analysis frames while Idle
  uint32_t quietMs_ = 0;              // silence run while Listening / Cooldown
  uint32_t cooldownUntil_ = 0;
  uint32_t listenStart_ = 0;
  bool hasNow_ = false;
  uint32_t lastNow_ = 0;

  std::vector<uint8_t> acc_;          // partial analysis frame
  std::vector<uint8_t> pre_;          // pre-roll ring (oldest first), at most prerollMs of audio
  std::vector<uint8_t> out_;          // bytes waiting to fill one uplink frame
  std::vector<uint8_t> scratch_;
};

}  // namespace gc
