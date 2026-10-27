// The mediasession-rpc/1 device client: session handshake, command dispatch, state/event
// notifications, audio stream handling and reconnect. Hardware-free (see gc_hal.h).
#pragma once
#include <ArduinoJson.h>
#include <cstdint>
#include <string>
#include <vector>
#include "gc_audio.h"
#include "gc_backoff.h"
#include "gc_dedup.h"
#include "gc_hal.h"
#include "gc_protocol.h"

namespace gc {

struct Limits {
  int panMin = -90, panMax = 90;      // 待实机确认 (doc defaults; official hardware range is wider)
  int tiltMin = 0, tiltMax = 60;
  int speedMin = 100, speedMax = 1000, speedDefault = 150;
  int volumeCap = 70;
  int textMaxChars = 200;
  int ledMax = 168;                   // per-channel safe cap (official firmware tool range 0..168)
  int lowBatteryPct = 10;
  int lowBatteryVolumeCap = 40;       // 待实机确认
};

struct DeviceConfig {
  std::string deviceId;
  std::string fw = "0.1.0";
  std::string hw = "m5stack-cores3";
  std::vector<std::string> caps = {"head", "led", "display", "speaker"};
  std::vector<std::string> expressions = {"neutral", "happy", "sad", "angry", "surprised", "sleepy", "thinking", "confused", "love", "wink", "speaking"};
  Limits limits;

  // Audio the device declares it can play (bridge picks play[0]).
  uint32_t audioSampleRate = 16000;
  uint32_t audioChannels = 1;
  uint32_t maxChunkBytes = 4096;
  uint32_t bufferMs = 2000;

  int initialVolume = 40;
  bool initialMuted = false;

  // Timing.
  uint32_t helloTimeoutMs = 10000;        // wait for the session.hello response
  uint32_t connectTimeoutMs = 15000;
  uint32_t reconnectMinMs = 1000, reconnectMaxMs = 30000;
  uint32_t pongTimeoutMs = 10000;
  uint32_t stateIntervalMs = 30000;       // periodic state.update
  uint32_t stateMinGapMs = 500;           // coalesce change-triggered updates
  uint32_t motionDoneTimeoutMs = 30000;   // wait=done safety net
  uint32_t lowBatteryEventGapMs = 300000;
  int defaultTextDurationMs = 5000;
};

enum class SessionState { Idle, WaitRetry, Connecting, HelloSent, Ready };

class DeviceClient : public ITransportListener, public IAudioEvents {
 public:
  DeviceClient(const DeviceConfig& cfg, Hal hal, ITransport& transport, AudioPlayer& player);

  void begin();            // register listeners, schedule the first connection
  void tick();             // call from loop() as often as possible
  SessionState state() const { return state_; }
  bool ready() const { return state_ == SessionState::Ready; }

  // Local trigger (touch / button): halt motion and stop audio, emit event.local_stop.
  void localEmergencyStop(const char* reason);
  // Send an `event.<name>` notification with a JSON object (or empty) as params.
  void emitEvent(const std::string& name, const std::string& paramsJson = "");

  // Introspection for tests / main.
  int volume() const { return volume_; }
  bool muted() const { return muted_; }
  const std::string& expression() const { return expression_; }
  const std::string& sessionId() const { return sessionId_; }
  uint32_t heartbeatS() const { return heartbeatS_; }
  uint32_t reconnects() const { return reconnects_; }
  uint32_t nextRetryDelayMs() const { return lastDelay_; }

  // ITransportListener
  void onTransportConnected() override;
  void onTransportClosed(int code) override;
  void onTransportText(const char* data, size_t len) override;
  void onTransportBinary(const uint8_t* data, size_t len) override;
  // IAudioEvents
  void onPlayback(const StreamMeta& meta, PlaybackState st, const std::string& message) override;

 private:
  struct Req {
    std::string idRaw;   // JSON text of the id (string or number)
    std::string method;
    std::string key;     // idempotency_key
    int ttlMs = 5000;
    uint32_t rxAt = 0;
    JsonObjectConst params;
    bool hasParams = false;
  };
  struct Rc {
    int code = 0;        // 0 ok, 1 deferred, else RpcCode
    std::string msg;
  };
  static Rc ok() { return Rc{}; }
  static Rc deferred() { Rc r; r.code = 1; return r; }
  static Rc err(int code, std::string msg) { Rc r; r.code = code; r.msg = std::move(msg); return r; }

  struct PendingMotion {
    bool active = false;
    std::string idRaw, key;
    uint32_t deadline = 0;
    int pan = 0, tilt = 0;
    bool clamped = false;
    uint32_t settleAt = 0;
  };

  // --- plumbing
  uint32_t now() const { return hal_.sys.millis(); }
  void log(const std::string& s) { hal_.sys.log(s.c_str()); }
  bool sendText(const std::string& s);
  void sendHello();
  void scheduleReconnect(const char* why);
  void resetSession();
  void sendPing();
  void sendNotification(const char* method, const JsonDocument& params);
  void sendStateUpdate();
  void buildState(JsonObject o, bool full);
  void markDirty() { stateDirty_ = true; }
  void checkBattery();

  // --- inbound
  void handleMessage(const char* data, size_t len);
  void handleResponse(JsonObjectConst msg);
  void handleNotification(const std::string& method, JsonObjectConst params, bool hasParams);
  void handleRequest(const std::string& idRaw, const std::string& method, JsonObjectConst msg);
  void sendError(const std::string& idRaw, int code, const std::string& msg);
  void respondOkRaw(const std::string& idRaw, const std::string& resultJson);
  void respondErrRaw(const std::string& idRaw, int code, const std::string& msg);
  void replay(const std::string& idRaw, const std::string& key, const std::string& payload, bool wholeResponse);
  bool moveNoReply(int pan, int tilt, int speed, std::string& why);

  // --- methods
  Rc mGetStatus(const Req& r, JsonObject out);
  Rc mMoveHead(const Req& r, JsonObject out);
  Rc mResetPose(const Req& r, JsonObject out);
  Rc mSetExpression(const Req& r, JsonObject out);
  Rc mShowText(const Req& r, JsonObject out);
  Rc mSetLed(const Req& r, JsonObject out);
  Rc mSpeak(const Req& r, JsonObject out);
  Rc mStopAudio(const Req& r, JsonObject out);
  Rc mSetVolume(const Req& r, JsonObject out);
  Rc mEmergencyStop(const Req& r, JsonObject out);

  bool lowBattery();
  int effectiveVolume(int v) const;
  void applyVolume();
  Rc startMotion(const Req& r, int pan, int tilt, int speed, bool wait, bool clamped, JsonObject out);
  void cancelPendingMotion(int code, const char* why);
  void tickMotion();
  void tickTimers();
  void setExpressionInternal(const std::string& name);
  bool knownExpression(const std::string& n) const;
  void sendPlaybackState(uint16_t id, const char* state, const std::string& msg);

  DeviceConfig cfg_;
  Hal hal_;
  ITransport& transport_;
  AudioPlayer& player_;
  DedupCache dedup_;
  Backoff backoff_;

  SessionState state_ = SessionState::Idle;
  uint32_t stateSince_ = 0, nextAttemptAt_ = 0, helloSentAt_ = 0, lastPingAt_ = 0, lastPongAt_ = 0;
  bool pingOutstanding_ = false;
  std::string sessionId_;
  uint32_t heartbeatS_ = 20;
  uint32_t reconnects_ = 0, lastDelay_ = 0;
  uint32_t nextOwnId_ = 1;
  std::string helloIdRaw_;

  // device state
  int volume_;
  bool muted_;
  std::string expression_ = "neutral";
  Pose cmdPose_;
  std::string playbackState_ = "idle";
  uint16_t playbackStream_ = 0;
  struct { uint8_t r = 0, g = 0, b = 0; std::string mode = "off"; std::string side = "both"; } led_;
  bool stateDirty_ = false;
  bool headMovingPrev_ = false;
  bool backoffReset_ = true;
  uint32_t lastStateAt_ = 0;
  uint32_t bootMs_ = 0;
  bool lowBatteryReported_ = false;
  uint32_t lastLowBatteryEventAt_ = 0;

  // timers
  bool textActive_ = false;
  uint32_t textClearAt_ = 0;    // 0 = never
  uint32_t ledOffAt_ = 0;       // 0 = never
  uint32_t exprRevertAt_ = 0;
  std::string exprRevertTo_;
  std::string preSpeakExpr_;
  std::string speakExpr_;
  uint16_t speakExprStream_ = 0;
  int preSpeakVolume_ = -1;
  PendingMotion motion_;
  std::string scratchJson_;
};

}  // namespace gc
