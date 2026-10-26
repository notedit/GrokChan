#include "gc_device.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include "gc_util.h"

namespace gc {

namespace {
// ArduinoJson 7 deprecates containsKey(); a missing key and an explicit null both read as null,
// so walk the keys when the difference matters (JSON-RPC: "id": null != no id).
bool hasKey(JsonObjectConst o, const char* key) {
  for (JsonPairConst kv : o) if (strcmp(kv.key().c_str(), key) == 0) return true;
  return false;
}
}  // namespace


namespace {

constexpr size_t kMaxIncomingJson = 16384;

enum class Got { Missing, Ok, Bad };

Got getNum(JsonObjectConst o, const char* k, double& v) {
  JsonVariantConst x = o[k];
  if (x.isNull()) return Got::Missing;
  if (!x.is<double>()) return Got::Bad;
  v = x.as<double>();
  return std::isfinite(v) ? Got::Ok : Got::Bad;
}
Got getBool(JsonObjectConst o, const char* k, bool& v) {
  JsonVariantConst x = o[k];
  if (x.isNull()) return Got::Missing;
  if (!x.is<bool>()) return Got::Bad;
  v = x.as<bool>();
  return Got::Ok;
}
Got getStr(JsonObjectConst o, const char* k, std::string& v) {
  JsonVariantConst x = o[k];
  if (x.isNull()) return Got::Missing;
  if (!x.is<const char*>()) return Got::Bad;
  v = x.as<const char*>();
  return Got::Ok;
}
int clampi(long v, int lo, int hi) { return (int)(v < lo ? lo : (v > hi ? hi : v)); }
std::string ser(const JsonDocument& d) { std::string s; serializeJson(d, s); return s; }
std::string serVar(JsonVariantConst v) { std::string s; serializeJson(v, s); return s; }

bool isKnownMethod(const std::string& m) {
  static const char* const k[] = {"device.get_status", "device.move_head", "device.reset_pose", "device.set_expression", "device.show_text",
                                  "device.set_led", "device.speak", "device.stop_audio", "device.set_volume", "device.emergency_stop"};
  for (auto* x : k) if (m == x) return true;
  return false;
}

}  // namespace

DeviceClient::DeviceClient(const DeviceConfig& cfg, Hal hal, ITransport& transport, AudioPlayer& player)
    : cfg_(cfg), hal_(hal), transport_(transport), player_(player), backoff_(cfg.reconnectMinMs, cfg.reconnectMaxMs) {
  player_.setEvents(this);
  volume_ = std::min(std::max(cfg.initialVolume, 0), cfg.limits.volumeCap);
  muted_ = cfg.initialMuted;
}

void DeviceClient::begin() {
  transport_.setListener(this);
  bootMs_ = now();
  applyVolume();
  state_ = SessionState::WaitRetry;
  nextAttemptAt_ = now();
}

// ------------------------------------------------------------------ loop
void DeviceClient::tick() {
  transport_.loop();
  uint32_t t = now();
  hal_.head.tick(t);
  hal_.display.tick(t);
  hal_.led.tick(t);
  player_.tick(t);

  std::string reason;
  if (hal_.head.takeFault(reason)) {
    log("servo fault: " + reason);
    cancelPendingMotion(kDeviceFault, ("servo fault: " + reason).c_str());
    if (ready()) emitEvent("servo_fault", ser([&] { JsonDocument d; d["reason"] = reason; return d; }()));
    markDirty();
  }

  tickMotion();
  tickTimers();

  switch (state_) {
    case SessionState::Idle: break;
    case SessionState::WaitRetry:
      if ((int32_t)(t - nextAttemptAt_) >= 0) {
        state_ = SessionState::Connecting;
        stateSince_ = t;
        transport_.connect();
      }
      break;
    case SessionState::Connecting:
      if ((uint32_t)(t - stateSince_) > cfg_.connectTimeoutMs) {
        transport_.disconnect();
        scheduleReconnect("connect timeout");
      }
      break;
    case SessionState::HelloSent:
      if ((uint32_t)(t - helloSentAt_) > cfg_.helloTimeoutMs) {
        transport_.disconnect();
        scheduleReconnect("hello timeout");
      }
      break;
    case SessionState::Ready: {
      if (!backoffReset_ && (uint32_t)(t - stateSince_) >= 10000) { backoff_.reset(); backoffReset_ = true; }
      uint32_t pingEvery = std::max<uint32_t>(5000, heartbeatS_ * 500);
      if (pingOutstanding_) {
        if ((uint32_t)(t - lastPingAt_) > cfg_.pongTimeoutMs) {
          log("pong timeout");
          transport_.disconnect();
          resetSession();
          scheduleReconnect("pong timeout");
          break;
        }
      } else if ((uint32_t)(t - lastPingAt_) >= pingEvery) {
        sendPing();
      }
      checkBattery();
      bool moving = hal_.head.isMoving();
      if (headMovingPrev_ && !moving) markDirty();
      headMovingPrev_ = moving;
      if ((stateDirty_ && (uint32_t)(t - lastStateAt_) >= cfg_.stateMinGapMs) || (uint32_t)(t - lastStateAt_) >= cfg_.stateIntervalMs) sendStateUpdate();
      break;
    }
  }
}

void DeviceClient::scheduleReconnect(const char* why) {
  resetSession();
  lastDelay_ = backoff_.next(hal_.sys.random(401));
  nextAttemptAt_ = now() + lastDelay_;
  state_ = SessionState::WaitRetry;
  reconnects_++;
  log(std::string("reconnect in ") + std::to_string(lastDelay_) + " ms (" + why + ")");
}

void DeviceClient::resetSession() {
  state_ = state_ == SessionState::Idle ? state_ : SessionState::WaitRetry;
  motion_.active = false;  // the requester is gone, nobody to answer
  player_.stopAll();
  pingOutstanding_ = false;
  sessionId_.clear();
}

// ------------------------------------------------------------------ transport events
void DeviceClient::onTransportConnected() {
  if (state_ != SessionState::Connecting) return;
  sendHello();
}

void DeviceClient::onTransportClosed(int code) {
  if (state_ == SessionState::WaitRetry || state_ == SessionState::Idle) return;  // we already handled it
  log("socket closed, code " + std::to_string(code));
  scheduleReconnect(code == 4000 ? "replaced by another connection" : code == 4009 ? "protocol error" : "closed");
}

void DeviceClient::sendHello() {
  JsonDocument d;
  std::string idRaw = "\"d_" + std::to_string(nextOwnId_++) + "\"";
  helloIdRaw_ = idRaw;
  JsonObject p = d["params"].to<JsonObject>();
  p["protocol"] = kProtocol;
  p["device_id"] = cfg_.deviceId;
  p["fw"] = cfg_.fw;
  p["hw"] = cfg_.hw;
  JsonArray caps = p["caps"].to<JsonArray>();
  for (auto& c : cfg_.caps) caps.add(c);
  JsonObject lim = p["limits"].to<JsonObject>();
  JsonArray pan = lim["pan"].to<JsonArray>();
  pan.add(cfg_.limits.panMin); pan.add(cfg_.limits.panMax);
  JsonArray tilt = lim["tilt"].to<JsonArray>();
  tilt.add(cfg_.limits.tiltMin); tilt.add(cfg_.limits.tiltMax);
  JsonArray sp = lim["speed"].to<JsonArray>();
  sp.add(cfg_.limits.speedMin); sp.add(cfg_.limits.speedMax);
  lim["volume_cap"] = cfg_.limits.volumeCap;
  lim["text_max"] = cfg_.limits.textMaxChars;
  lim["led_max"] = cfg_.limits.ledMax;
  JsonArray ex = p["expressions"].to<JsonArray>();
  for (auto& e : cfg_.expressions) ex.add(e);
  JsonObject au = p["audio"].to<JsonObject>();
  JsonArray play = au["play"].to<JsonArray>();
  JsonObject f = play.add<JsonObject>();
  f["format"] = "pcm_s16le";
  f["sample_rate"] = cfg_.audioSampleRate;
  f["channels"] = cfg_.audioChannels;
  au["max_chunk_bytes"] = cfg_.maxChunkBytes;
  au["buffer_ms"] = cfg_.bufferMs;
  std::string msg = "{\"jsonrpc\":\"2.0\",\"id\":" + idRaw + ",\"method\":\"session.hello\",\"params\":" + serVar(d["params"]) + "}";
  state_ = SessionState::HelloSent;
  helloSentAt_ = now();
  sendText(msg);
}

bool DeviceClient::sendText(const std::string& s) { return transport_.sendText(s); }

void DeviceClient::sendPing() {
  lastPingAt_ = now();
  pingOutstanding_ = true;
  sendText(kPingText);
}

// ------------------------------------------------------------------ inbound
void DeviceClient::onTransportText(const char* data, size_t len) { handleMessage(data, len); }

void DeviceClient::onTransportBinary(const uint8_t* data, size_t len) {
  FrameHeader h;
  if (!decodeFrameHeader(data, len, h)) { log("short binary frame ignored"); return; }
  if (state_ != SessionState::Ready) return;
  if (h.type != kFrameDownlinkAudio) { log("unexpected binary frame type " + std::to_string(h.type)); return; }
  std::string e;
  player_.frame(h.stream, h.seq, h.last(), data + kFrameHeaderBytes, len - kFrameHeaderBytes, now(), e);
  if (!e.empty()) log("audio frame: " + e);
}

void DeviceClient::handleMessage(const char* data, size_t len) {
  if (len == strlen(kPongText) && memcmp(data, kPongText, len) == 0) {
    pingOutstanding_ = false;
    return;
  }
  if (len > kMaxIncomingJson) { sendError("null", kPayloadTooLarge, "message too large"); return; }
  JsonDocument doc;
  DeserializationError de = deserializeJson(doc, data, len);
  if (de) { sendError("null", kParseError, de.c_str()); return; }
  if (!doc.is<JsonObject>()) { sendError("null", kInvalidRequest, "batch requests are not supported"); return; }
  JsonObjectConst msg = doc.as<JsonObjectConst>();
  JsonVariantConst method = msg["method"];
  if (method.is<const char*>()) {
    std::string m = method.as<const char*>();
    JsonVariantConst id = msg["id"];
    bool versionOk = msg["jsonrpc"].is<const char*>() && std::string(msg["jsonrpc"].as<const char*>()) == "2.0";
    if (id.isNull()) {
      if (hasKey(msg, "id")) { sendError("null", kInvalidRequest, "id must be a string or number"); return; }
      if (!versionOk) return;
      handleNotification(m, msg["params"].as<JsonObjectConst>(), msg["params"].is<JsonObjectConst>());
      return;
    }
    if (!(id.is<const char*>() || id.is<long>())) { sendError("null", kInvalidRequest, "id must be a string or integer"); return; }
    std::string idRaw = serVar(id);
    if (!versionOk) { sendError(idRaw, kInvalidRequest, "jsonrpc must be \"2.0\""); return; }
    handleRequest(idRaw, m, msg);
    return;
  }
  if (hasKey(msg, "result") || hasKey(msg, "error")) { handleResponse(msg); return; }
  sendError("null", kInvalidRequest, "not a request");
}

void DeviceClient::handleResponse(JsonObjectConst msg) {
  std::string idRaw = serVar(msg["id"]);
  if (state_ == SessionState::HelloSent && idRaw == helloIdRaw_) {
    if (hasKey(msg, "error")) {
      std::string em = msg["error"]["message"].is<const char*>() ? msg["error"]["message"].as<const char*>() : "?";
      log("hello rejected: " + em);
      transport_.disconnect();
      scheduleReconnect("hello rejected");
      return;
    }
    JsonObjectConst r = msg["result"].as<JsonObjectConst>();
    JsonObjectConst a = r["audio"].as<JsonObjectConst>();
    if (a["format"].is<const char*>() && std::string(a["format"].as<const char*>()) != "pcm_s16le") {
      log("bridge selected unsupported audio format");
      transport_.disconnect();
      scheduleReconnect("audio format");
      return;
    }
    sessionId_ = r["session_id"].is<const char*>() ? r["session_id"].as<const char*>() : "";
    uint32_t hb = r["heartbeat_s"].is<uint32_t>() ? r["heartbeat_s"].as<uint32_t>() : 20;
    heartbeatS_ = std::min<uint32_t>(std::max<uint32_t>(hb, 2), 120);
    state_ = SessionState::Ready;
    stateSince_ = now();
    lastPingAt_ = stateSince_;
    pingOutstanding_ = false;
    backoffReset_ = false;
    log("session ready " + sessionId_);
    sendStateUpdate();
    return;
  }
  // Responses to anything else are not expected in M1.
}

void DeviceClient::handleNotification(const std::string& method, JsonObjectConst params, bool hasParams) {
  if (method == "pong") { pingOutstanding_ = false; return; }
  if (method == "ping") { sendText(kPongText); return; }
  if (state_ != SessionState::Ready) return;
  if (method == "audio.begin") {
    JsonVariantConst sid = hasParams ? params["stream_id"] : JsonVariantConst();
    if (!sid.is<uint32_t>() || sid.as<uint32_t>() == 0 || sid.as<uint32_t>() > 65535) { log("audio.begin without valid stream_id"); return; }
    uint16_t id = (uint16_t)sid.as<uint32_t>();
    std::string fmt = params["format"].is<const char*>() ? params["format"].as<const char*>() : "";
    uint32_t rate = params["sample_rate"].is<uint32_t>() ? params["sample_rate"].as<uint32_t>() : cfg_.audioSampleRate;
    uint32_t ch = params["channels"].is<uint32_t>() ? params["channels"].as<uint32_t>() : cfg_.audioChannels;
    uint32_t chunk = params["chunk_bytes"].is<uint32_t>() ? params["chunk_bytes"].as<uint32_t>() : 0;
    std::string e;
    if (!player_.begin(id, fmt, rate, ch, chunk, now(), e)) log("audio.begin: " + e);
    return;
  }
  if (method == "audio.end") {
    JsonVariantConst sid = hasParams ? params["stream_id"] : JsonVariantConst();
    if (!sid.is<uint32_t>()) return;
    uint16_t id = (uint16_t)sid.as<uint32_t>();
    bool complete = !(params["reason"].is<const char*>() && std::string(params["reason"].as<const char*>()) == "aborted");
    std::string e;
    if (!player_.end(id, params["total_chunks"] | 0u, params["total_bytes"] | 0u, complete, now(), e)) log("audio.end: " + e);
    return;
  }
  log("ignored notification " + method);
}

void DeviceClient::sendError(const std::string& idRaw, int code, const std::string& msg) {
  JsonDocument e;
  e["code"] = code;
  e["message"] = std::string(rpcCodeName(code)) + (msg.empty() ? "" : ": " + msg);
  sendText("{\"jsonrpc\":\"2.0\",\"id\":" + idRaw + ",\"error\":" + ser(e) + "}");
}

void DeviceClient::respondOkRaw(const std::string& idRaw, const std::string& resultJson) {
  std::string resp = "{\"jsonrpc\":\"2.0\",\"id\":" + idRaw + ",\"result\":" + resultJson + "}";
  dedup_.complete(idRaw, resp, resultJson, now());
  sendText(resp);
}

void DeviceClient::respondErrRaw(const std::string& idRaw, int code, const std::string& msg) {
  JsonDocument e;
  e["code"] = code;
  e["message"] = std::string(rpcCodeName(code)) + (msg.empty() ? "" : ": " + msg);
  std::string resp = "{\"jsonrpc\":\"2.0\",\"id\":" + idRaw + ",\"error\":" + ser(e) + "}";
  dedup_.complete(idRaw, resp, "", now());
  sendText(resp);
}

void DeviceClient::replay(const std::string& idRaw, const std::string& key, const std::string& payload, bool whole) {
  JsonDocument d;
  if (deserializeJson(d, payload)) { sendError(idRaw, kInternalError, "replay failed"); return; }
  if (whole) {
    if (d["result"].is<JsonObject>()) d["result"]["_meta"]["deduplicated"] = true;
    sendText(ser(d));
    return;
  }
  d["_meta"]["deduplicated"] = true;
  std::string resultJson = ser(d);
  std::string resp = "{\"jsonrpc\":\"2.0\",\"id\":" + idRaw + ",\"result\":" + resultJson + "}";
  dedup_.begin(idRaw, key, now());
  dedup_.complete(idRaw, resp, payload, now());
  sendText(resp);
}

void DeviceClient::handleRequest(const std::string& idRaw, const std::string& method, JsonObjectConst msg) {
  Req r;
  r.idRaw = idRaw;
  r.method = method;
  r.rxAt = now();
  JsonVariantConst p = msg["params"];
  if (!p.isNull()) {
    if (!p.is<JsonObjectConst>()) { sendError(idRaw, kInvalidParams, "params must be an object"); return; }
    r.params = p.as<JsonObjectConst>();
    r.hasParams = true;
  }
  JsonObjectConst meta = r.params["_meta"].as<JsonObjectConst>();
  if (meta["ttl_ms"].is<long>()) r.ttlMs = (int)meta["ttl_ms"].as<long>();
  if (meta["idempotency_key"].is<const char*>()) r.key = meta["idempotency_key"].as<const char*>();

  if (!isKnownMethod(method)) { sendError(idRaw, kMethodNotFound, method); return; }
  if (state_ != SessionState::Ready) { sendError(idRaw, kBusy, "session not ready"); return; }
  bool emergency = method == "device.emergency_stop";
  bool noDedup = emergency || method == "device.get_status";

  if (!noDedup) {
    DedupCache::Lookup l = dedup_.lookup(idRaw, r.key, r.rxAt);
    if (l.kind == DedupCache::Kind::InFlight) { log("duplicate in-flight request ignored " + idRaw); return; }
    if (l.kind == DedupCache::Kind::ReplayById) { replay(idRaw, r.key, l.payload, true); return; }
    if (l.kind == DedupCache::Kind::ReplayByKey) { replay(idRaw, r.key, l.payload, false); return; }
  }
  if (!emergency && r.ttlMs <= 0) {
    if (!noDedup) dedup_.begin(idRaw, r.key, r.rxAt);
    respondErrRaw(idRaw, kExpired, "ttl_ms elapsed before execution");
    return;
  }
  if (!noDedup) dedup_.begin(idRaw, r.key, r.rxAt);

  JsonDocument res;
  JsonObject out = res.to<JsonObject>();
  Rc rc;
  if (method == "device.get_status") rc = mGetStatus(r, out);
  else if (method == "device.move_head") rc = mMoveHead(r, out);
  else if (method == "device.reset_pose") rc = mResetPose(r, out);
  else if (method == "device.set_expression") rc = mSetExpression(r, out);
  else if (method == "device.show_text") rc = mShowText(r, out);
  else if (method == "device.set_led") rc = mSetLed(r, out);
  else if (method == "device.speak") rc = mSpeak(r, out);
  else if (method == "device.stop_audio") rc = mStopAudio(r, out);
  else if (method == "device.set_volume") rc = mSetVolume(r, out);
  else rc = mEmergencyStop(r, out);

  if (rc.code == 1) return;  // answered later (wait=done)
  if (rc.code != 0) { respondErrRaw(idRaw, rc.code, rc.msg); return; }
  respondOkRaw(idRaw, ser(res));
}

// ------------------------------------------------------------------ helpers
bool DeviceClient::lowBattery() {
  int p = hal_.sys.batteryPercent();
  return p >= 0 && p < cfg_.limits.lowBatteryPct && !hal_.sys.charging();
}

int DeviceClient::effectiveVolume(int v) const {
  int cap = cfg_.limits.volumeCap;
  int pct = hal_.sys.batteryPercent();
  if (pct >= 0 && pct < cfg_.limits.lowBatteryPct && !hal_.sys.charging()) cap = std::min(cap, cfg_.limits.lowBatteryVolumeCap);
  return std::min(std::max(v, 0), cap);
}

void DeviceClient::applyVolume() {
  hal_.audio.setVolume(effectiveVolume(volume_));
  hal_.audio.setMuted(muted_);
}

bool DeviceClient::knownExpression(const std::string& n) const {
  return std::find(cfg_.expressions.begin(), cfg_.expressions.end(), n) != cfg_.expressions.end();
}

void DeviceClient::setExpressionInternal(const std::string& name) {
  expression_ = name;
  hal_.display.setExpression(name);
  markDirty();
}

bool DeviceClient::moveNoReply(int pan, int tilt, int speed, std::string& why) {
  cancelPendingMotion(kBusy, "superseded by a newer motion command");
  if (!hal_.head.moveTo(pan, tilt, speed)) { why = "servo not responding"; return false; }
  cmdPose_.pan = pan;
  cmdPose_.tilt = tilt;
  markDirty();
  return true;
}

void DeviceClient::cancelPendingMotion(int code, const char* why) {
  if (!motion_.active) return;
  motion_.active = false;
  if (ready()) respondErrRaw(motion_.idRaw, code, why);
}

void DeviceClient::tickMotion() {
  if (!motion_.active) return;
  uint32_t t = now();
  if (!hal_.head.isMoving()) {
    Pose p = cmdPose_;
    hal_.head.getPose(p);
    JsonDocument d;
    d["pan"] = p.pan;
    d["tilt"] = p.tilt;
    if (motion_.clamped) d["clamped"] = true;
    motion_.active = false;
    markDirty();
    respondOkRaw(motion_.idRaw, ser(d));
  } else if ((int32_t)(t - motion_.deadline) >= 0) {
    motion_.active = false;
    respondErrRaw(motion_.idRaw, kTimeout, "motion did not finish in time");
  }
}

void DeviceClient::tickTimers() {
  uint32_t t = now();
  if (textActive_ && textClearAt_ && (int32_t)(t - textClearAt_) >= 0) {
    hal_.display.clearText();
    textActive_ = false;
    textClearAt_ = 0;
  }
  if (ledOffAt_ && (int32_t)(t - ledOffAt_) >= 0) {
    hal_.led.set(LedSide::Both, 0, 0, 0, LedMode::Off);
    led_.r = led_.g = led_.b = 0;
    led_.mode = "off";
    ledOffAt_ = 0;
    markDirty();
  }
  if (exprRevertAt_ && (int32_t)(t - exprRevertAt_) >= 0) {
    exprRevertAt_ = 0;
    setExpressionInternal(exprRevertTo_.empty() ? "neutral" : exprRevertTo_);
  }
}

void DeviceClient::checkBattery() {
  int pct = hal_.sys.batteryPercent();
  if (pct < 0) return;
  bool low = pct < cfg_.limits.lowBatteryPct && !hal_.sys.charging();
  uint32_t t = now();
  if (low) {
    if (!lowBatteryReported_ || (uint32_t)(t - lastLowBatteryEventAt_) > cfg_.lowBatteryEventGapMs) {
      lowBatteryReported_ = true;
      lastLowBatteryEventAt_ = t;
      JsonDocument d;
      d["percent"] = pct;
      emitEvent("battery_low", ser(d));
      markDirty();
    }
  } else if (pct >= cfg_.limits.lowBatteryPct + 3 || hal_.sys.charging()) {
    lowBatteryReported_ = false;
  }
}

void DeviceClient::sendPlaybackState(uint16_t id, const char* st, const std::string& msg) {
  if (!ready()) return;
  JsonDocument d;
  d["stream_id"] = id;
  d["state"] = st;
  if (!msg.empty()) d["message"] = msg.substr(0, 200);
  sendText("{\"jsonrpc\":\"2.0\",\"method\":\"playback.state\",\"params\":" + ser(d) + "}");
}

void DeviceClient::onPlayback(const StreamMeta& meta, PlaybackState st, const std::string& message) {
  playbackState_ = playbackStateName(st);
  playbackStream_ = meta.id;
  if (st == PlaybackState::Started) {
    hal_.display.setSpeaking(true);
    hal_.audio.setVolume(effectiveVolume(meta.volume >= 0 ? meta.volume : volume_));
    if (!meta.expression.empty() && knownExpression(meta.expression)) {
      preSpeakExpr_ = expression_;
      speakExpr_ = meta.expression;
      speakExprStream_ = meta.id;
      exprRevertAt_ = 0;
      setExpressionInternal(meta.expression);
    }
  } else {
    if (!player_.busy()) hal_.display.setSpeaking(false);
    if (speakExprStream_ == meta.id) {
      if (expression_ == speakExpr_) setExpressionInternal(preSpeakExpr_.empty() ? "neutral" : preSpeakExpr_);
      speakExprStream_ = 0;
    }
    if (!player_.busy()) hal_.audio.setVolume(effectiveVolume(volume_));
  }
  sendPlaybackState(meta.id, playbackStateName(st), message);
  markDirty();
}

// ------------------------------------------------------------------ state / events
void DeviceClient::buildState(JsonObject o, bool full) {
  (void)full;
  int pct = hal_.sys.batteryPercent();
  if (pct >= 0) {
    JsonObject b = o["battery"].to<JsonObject>();
    b["percent"] = pct;
    b["charging"] = hal_.sys.charging();
  }
  o["volume"] = volume_;
  o["muted"] = muted_;
  Pose p = cmdPose_;
  hal_.head.getPose(p);
  JsonObject po = o["pose"].to<JsonObject>();
  po["pan"] = p.pan;
  po["tilt"] = p.tilt;
  o["expression"] = expression_;
  JsonObject l = o["led"].to<JsonObject>();
  l["r"] = led_.r; l["g"] = led_.g; l["b"] = led_.b;
  l["mode"] = led_.mode;
  JsonObject pb = o["playback"].to<JsonObject>();
  pb["state"] = playbackState_;
  pb["stream_id"] = playbackStream_;
  o["uptime_s"] = (now() - bootMs_) / 1000;
  int rssi = hal_.sys.wifiRssi();
  if (rssi != 0) o["wifi_rssi"] = rssi;
  JsonObject pv = o["privacy"].to<JsonObject>();
  pv["camera"] = false;
  pv["mic"] = false;
}

void DeviceClient::sendStateUpdate() {
  JsonDocument d;
  buildState(d.to<JsonObject>(), true);
  lastStateAt_ = now();
  stateDirty_ = false;
  sendText("{\"jsonrpc\":\"2.0\",\"method\":\"state.update\",\"params\":" + ser(d) + "}");
}

void DeviceClient::emitEvent(const std::string& name, const std::string& paramsJson) {
  if (!ready()) return;
  std::string m = "{\"jsonrpc\":\"2.0\",\"method\":\"event." + name + "\"";
  if (!paramsJson.empty()) m += ",\"params\":" + paramsJson;
  m += "}";
  sendText(m);
}

void DeviceClient::localEmergencyStop(const char* reason) {
  hal_.head.halt();
  Pose p = cmdPose_;
  if (hal_.head.getPose(p)) cmdPose_ = p;
  cancelPendingMotion(kBusy, "local stop");
  player_.stopAll();
  JsonDocument d;
  d["reason"] = reason;
  emitEvent("local_stop", ser(d));
  markDirty();
}

// ------------------------------------------------------------------ methods
DeviceClient::Rc DeviceClient::mGetStatus(const Req&, JsonObject out) {
  int pct = hal_.sys.batteryPercent();
  if (pct >= 0) {
    JsonObject b = out["battery"].to<JsonObject>();
    b["percent"] = pct;
    b["charging"] = hal_.sys.charging();
  }
  out["volume"] = volume_;
  out["muted"] = muted_;
  Pose p = cmdPose_;
  hal_.head.getPose(p);
  JsonObject po = out["pose"].to<JsonObject>();
  po["pan"] = p.pan;
  po["tilt"] = p.tilt;
  out["expression"] = expression_;
  out["uptime_s"] = (now() - bootMs_) / 1000;
  int rssi = hal_.sys.wifiRssi();
  if (rssi != 0) out["wifi_rssi"] = rssi;
  JsonObject pb = out["playback"].to<JsonObject>();
  pb["state"] = playbackState_;
  pb["stream_id"] = playbackStream_;
  return ok();
}

DeviceClient::Rc DeviceClient::startMotion(const Req& r, int pan, int tilt, int speed, bool wait, bool clamped, JsonObject out) {
  std::string why;
  if (!moveNoReply(pan, tilt, speed, why)) return err(kDeviceFault, why);
  out["pan"] = pan;
  out["tilt"] = tilt;
  if (clamped) out["clamped"] = true;
  if (!wait) return ok();
  motion_.active = true;
  motion_.idRaw = r.idRaw;
  motion_.key = r.key;
  motion_.pan = pan;
  motion_.tilt = tilt;
  motion_.clamped = clamped;
  motion_.deadline = now() + cfg_.motionDoneTimeoutMs;
  return deferred();
}

DeviceClient::Rc DeviceClient::mMoveHead(const Req& r, JsonObject out) {
  const Limits& L = cfg_.limits;
  if (lowBattery()) return err(kLowBattery, "battery below " + std::to_string(L.lowBatteryPct) + "%, motion refused");
  double pan = 0, tilt = 0, speed = 0;
  Got gp = getNum(r.params, "pan", pan), gt = getNum(r.params, "tilt", tilt), gs = getNum(r.params, "speed", speed);
  if (gp == Got::Bad || gt == Got::Bad || gs == Got::Bad) return err(kInvalidParams, "pan/tilt/speed must be numbers");
  if (gp == Got::Missing && gt == Got::Missing) return err(kInvalidParams, "pan and/or tilt required");
  bool relative = false;
  if (getBool(r.params, "relative", relative) == Got::Bad) return err(kInvalidParams, "relative must be boolean");
  std::string wait = "accepted";
  if (getStr(r.params, "wait", wait) == Got::Bad || (wait != "accepted" && wait != "done")) return err(kInvalidParams, "wait must be accepted|done");

  bool clamped = false;
  int tp = cmdPose_.pan, tt = cmdPose_.tilt;
  if (gp == Got::Ok) {
    long v = std::lround(pan);
    tp = relative ? cmdPose_.pan + (int)v : (int)v;
    int c = clampi(tp, L.panMin, L.panMax);
    if (c != tp) clamped = true;
    tp = c;
  }
  if (gt == Got::Ok) {
    long v = std::lround(tilt);
    tt = relative ? cmdPose_.tilt + (int)v : (int)v;
    int c = clampi(tt, L.tiltMin, L.tiltMax);
    if (c != tt) clamped = true;
    tt = c;
  }
  int sp = L.speedDefault;
  if (gs == Got::Ok) {
    sp = clampi(std::lround(speed), L.speedMin, L.speedMax);
    if (sp != (int)std::lround(speed)) clamped = true;
  }
  return startMotion(r, tp, tt, sp, wait == "done", clamped, out);
}

DeviceClient::Rc DeviceClient::mResetPose(const Req& r, JsonObject out) {
  const Limits& L = cfg_.limits;
  if (lowBattery()) return err(kLowBattery, "battery below " + std::to_string(L.lowBatteryPct) + "%, motion refused");
  bool face = true;
  if (getBool(r.params, "reset_face", face) == Got::Bad) return err(kInvalidParams, "reset_face must be boolean");
  std::string wait = "accepted";
  if (getStr(r.params, "wait", wait) == Got::Bad || (wait != "accepted" && wait != "done")) return err(kInvalidParams, "wait must be accepted|done");
  double speed = 0;
  Got gs = getNum(r.params, "speed", speed);
  if (gs == Got::Bad) return err(kInvalidParams, "speed must be a number");
  int sp = gs == Got::Ok ? clampi(std::lround(speed), L.speedMin, L.speedMax) : L.speedDefault;
  if (face) {
    exprRevertAt_ = 0;
    setExpressionInternal("neutral");
    hal_.display.lookAt(0, 0);
  }
  return startMotion(r, clampi(0, L.panMin, L.panMax), clampi(0, L.tiltMin, L.tiltMax), sp, wait == "done", false, out);
}

DeviceClient::Rc DeviceClient::mSetExpression(const Req& r, JsonObject out) {
  const Limits& L = cfg_.limits;
  std::string name, revert;
  if (getStr(r.params, "expression", name) != Got::Ok || name.empty()) return err(kInvalidParams, "expression required");
  Got gr = getStr(r.params, "revert_to", revert);
  if (gr == Got::Bad) return err(kInvalidParams, "revert_to must be a string");
  double dur = 0;
  Got gd = getNum(r.params, "duration_ms", dur);
  if (gd == Got::Bad || (gd == Got::Ok && dur < 0)) return err(kInvalidParams, "duration_ms must be >= 0");
  JsonObjectConst look = r.params["look_at"].as<JsonObjectConst>();
  bool hasLook = r.params["look_at"].is<JsonObjectConst>();
  if (!r.params["look_at"].isNull() && !hasLook) return err(kInvalidParams, "look_at must be an object");
  double lp = 0, lt = 0;
  Got glp = Got::Missing, glt = Got::Missing;
  if (hasLook) {
    glp = getNum(look, "pan", lp);
    glt = getNum(look, "tilt", lt);
    if (glp == Got::Bad || glt == Got::Bad || (glp == Got::Missing && glt == Got::Missing)) return err(kInvalidParams, "look_at needs numeric pan and/or tilt");
    if (lowBattery()) return err(kLowBattery, "battery low, head motion refused");
  }
  std::string applied = name;
  bool fallback = false;
  if (!knownExpression(name)) { applied = "neutral"; fallback = true; }
  setExpressionInternal(applied);
  if (gd == Got::Ok && dur > 0) {
    exprRevertAt_ = now() + (uint32_t)dur;
    exprRevertTo_ = (gr == Got::Ok && knownExpression(revert)) ? revert : "neutral";
  } else {
    exprRevertAt_ = 0;
  }
  if (hasLook) {
    int pan = glp == Got::Ok ? clampi(std::lround(lp), L.panMin, L.panMax) : cmdPose_.pan;
    int tilt = glt == Got::Ok ? clampi(std::lround(lt), L.tiltMin, L.tiltMax) : cmdPose_.tilt;
    std::string why;
    hal_.display.lookAt(pan, tilt);
    if (!moveNoReply(pan, tilt, L.speedDefault, why)) return err(kDeviceFault, why);
  }
  out["expression"] = applied;
  if (fallback) out["fallback"] = "neutral";
  return ok();
}

DeviceClient::Rc DeviceClient::mShowText(const Req& r, JsonObject out) {
  bool clear = false;
  if (getBool(r.params, "clear", clear) == Got::Bad) return err(kInvalidParams, "clear must be boolean");
  std::string pos = "bubble", size = "m";
  if (getStr(r.params, "position", pos) == Got::Bad || (pos != "bubble" && pos != "center" && pos != "bottom")) return err(kInvalidParams, "position must be bubble|center|bottom");
  if (getStr(r.params, "size", size) == Got::Bad || (size != "s" && size != "m" && size != "l")) return err(kInvalidParams, "size must be s|m|l");
  double dur = cfg_.defaultTextDurationMs;
  Got gd = getNum(r.params, "duration_ms", dur);
  if (gd == Got::Bad || dur < 0) return err(kInvalidParams, "duration_ms must be >= 0");
  if (clear) {
    hal_.display.clearText();
    textActive_ = false;
    textClearAt_ = 0;
    out["shown"] = false;
    out["truncated"] = false;
    return ok();
  }
  std::string text;
  if (getStr(r.params, "text", text) != Got::Ok) return err(kInvalidParams, "text required unless clear=true");
  bool truncated = false;
  std::string clean = sanitizeText(text, cfg_.limits.textMaxChars, truncated);
  if (clean.empty()) return err(kInvalidParams, "text is empty");
  hal_.display.showText(clean, pos == "center" ? TextPosition::Center : pos == "bottom" ? TextPosition::Bottom : TextPosition::Bubble,
                        size == "s" ? TextSize::Small : size == "l" ? TextSize::Large : TextSize::Medium);
  textActive_ = true;
  textClearAt_ = dur > 0 ? now() + (uint32_t)dur : 0;
  out["shown"] = true;
  out["truncated"] = truncated;
  return ok();
}

DeviceClient::Rc DeviceClient::mSetLed(const Req& r, JsonObject out) {
  const Limits& L = cfg_.limits;
  std::string side = "both", mode = "solid";
  if (getStr(r.params, "side", side) == Got::Bad || (side != "left" && side != "right" && side != "both")) return err(kInvalidParams, "side must be left|right|both");
  if (getStr(r.params, "mode", mode) == Got::Bad || (mode != "solid" && mode != "breathe" && mode != "blink" && mode != "off")) return err(kInvalidParams, "mode must be solid|breathe|blink|off");
  double ch[3] = {0, 0, 0};
  const char* names[3] = {"r", "g", "b"};
  for (int i = 0; i < 3; i++) {
    Got g = getNum(r.params, names[i], ch[i]);
    if (g == Got::Bad || ch[i] < 0 || ch[i] > 255 || ch[i] != std::floor(ch[i])) return err(kInvalidParams, std::string(names[i]) + " must be an integer 0..255");
    if (g == Got::Missing && mode != "off") return err(kInvalidParams, "r,g,b required unless mode is off");
  }
  double brightness = 40;
  Got gb = getNum(r.params, "brightness", brightness);
  if (gb == Got::Bad || brightness < 0 || brightness > 100) return err(kInvalidParams, "brightness must be 0..100");
  double dur = 0;
  Got gd = getNum(r.params, "duration_ms", dur);
  if (gd == Got::Bad || dur < 0) return err(kInvalidParams, "duration_ms must be >= 0");

  bool clamped = false;
  int a[3];
  for (int i = 0; i < 3; i++) {
    int c = (int)ch[i];
    if (c > L.ledMax) { c = L.ledMax; clamped = true; }
    a[i] = mode == "off" ? 0 : (int)std::lround(c * brightness / 100.0);
  }
  LedSide s = side == "left" ? LedSide::Left : side == "right" ? LedSide::Right : LedSide::Both;
  LedMode m = mode == "off" ? LedMode::Off : mode == "breathe" ? LedMode::Breathe : mode == "blink" ? LedMode::Blink : LedMode::Solid;
  hal_.led.set(s, (uint8_t)a[0], (uint8_t)a[1], (uint8_t)a[2], m);
  led_.r = (uint8_t)a[0]; led_.g = (uint8_t)a[1]; led_.b = (uint8_t)a[2];
  led_.mode = mode;
  led_.side = side;
  ledOffAt_ = (dur > 0 && mode != "off") ? now() + (uint32_t)dur : 0;
  markDirty();
  JsonObject rgb = out["applied_rgb"].to<JsonObject>();
  rgb["r"] = a[0]; rgb["g"] = a[1]; rgb["b"] = a[2];
  if (clamped) out["clamped"] = true;
  return ok();
}

DeviceClient::Rc DeviceClient::mSpeak(const Req& r, JsonObject out) {
  double sid = 0;
  if (getNum(r.params, "stream_id", sid) != Got::Ok || sid < 1 || sid > 65535 || sid != std::floor(sid)) return err(kInvalidParams, "stream_id must be an integer 1..65535");
  bool interrupt = false;
  if (getBool(r.params, "interrupt", interrupt) == Got::Bad) return err(kInvalidParams, "interrupt must be boolean");
  StreamMeta meta;
  meta.id = (uint16_t)sid;
  std::string expr;
  Got ge = getStr(r.params, "expression", expr);
  if (ge == Got::Bad) return err(kInvalidParams, "expression must be a string");
  if (ge == Got::Ok) meta.expression = expr;
  double vol = 0;
  Got gv = getNum(r.params, "volume", vol);
  if (gv == Got::Bad || (gv == Got::Ok && (vol < 0 || vol > 100))) return err(kInvalidParams, "volume must be 0..100");
  if (gv == Got::Ok) meta.volume = effectiveVolume((int)std::lround(vol));
  if (!interrupt && player_.has(meta.id)) return err(kInvalidParams, "stream_id already in use");
  int pos = player_.accept(meta, interrupt, now());
  if (pos < 0) return err(kBusy, "speak queue is full");
  out["accepted"] = true;
  out["stream_id"] = meta.id;
  out["queue_position"] = pos;
  return ok();
}

DeviceClient::Rc DeviceClient::mStopAudio(const Req& r, JsonObject out) {
  bool clear = true;
  if (getBool(r.params, "clear_queue", clear) == Got::Bad) return err(kInvalidParams, "clear_queue must be boolean");
  double sid = 0;
  Got gs = getNum(r.params, "stream_id", sid);
  if (gs == Got::Bad || (gs == Got::Ok && (sid < 1 || sid > 65535))) return err(kInvalidParams, "stream_id must be 1..65535");
  int cleared = 0;
  std::vector<uint16_t> stopped = player_.stop(gs == Got::Ok ? (uint16_t)sid : 0, clear, cleared);
  JsonArray arr = out["stopped"].to<JsonArray>();
  for (uint16_t s : stopped) arr.add(s);
  out["cleared"] = cleared;
  return ok();
}

DeviceClient::Rc DeviceClient::mSetVolume(const Req& r, JsonObject out) {
  double vol = 0;
  Got gv = getNum(r.params, "volume", vol);
  bool mute = false;
  Got gm = getBool(r.params, "mute", mute);
  bool persist = false;
  if (getBool(r.params, "persist", persist) == Got::Bad) return err(kInvalidParams, "persist must be boolean");
  if (gv == Got::Bad || gm == Got::Bad || (gv == Got::Ok && (vol < 0 || vol > 100))) return err(kInvalidParams, "volume must be 0..100, mute boolean");
  if (gv == Got::Missing && gm == Got::Missing) return err(kInvalidParams, "volume and/or mute required");
  if (gv == Got::Ok) volume_ = std::min((int)std::lround(vol), cfg_.limits.volumeCap);
  if (gm == Got::Ok) muted_ = mute;
  applyVolume();
  if (persist) hal_.sys.saveVolume(volume_);
  markDirty();
  out["volume"] = volume_;
  out["muted"] = muted_;
  return ok();
}

DeviceClient::Rc DeviceClient::mEmergencyStop(const Req&, JsonObject out) {
  hal_.head.halt();
  Pose p = cmdPose_;
  if (hal_.head.getPose(p)) cmdPose_ = p;
  cancelPendingMotion(kBusy, "interrupted by emergency_stop");
  bool audio = player_.stopAll();
  hal_.audio.stop();
  markDirty();
  out["motion_halted"] = true;
  out["audio_stopped"] = audio;
  return ok();
}

}  // namespace gc
