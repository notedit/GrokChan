// Host fakes for the HAL interfaces + a Rig that wires up a DeviceClient.
#pragma once
#include <ArduinoJson.h>
#include <string>
#include <vector>
#include "gc_audio.h"
#include "gc_device.h"

namespace gctest {
using namespace gc;

struct FakeSys : ISystem {
  uint32_t t = 1000;
  int battery = 80;
  bool isCharging = false;
  int rssi = -55;
  int savedVolume = -1;
  uint32_t rnd = 200;  // -> jitter 1000 permille => exact backoff numbers
  std::vector<std::string> logs;
  uint32_t millis() override { return t; }
  int batteryPercent() override { return battery; }
  bool charging() override { return isCharging; }
  int wifiRssi() override { return rssi; }
  uint32_t random(uint32_t) override { return rnd; }
  void saveVolume(int p) override { savedVolume = p; }
  void log(const char* l) override { logs.push_back(l); }
};

struct FakeHead : IHead {
  Pose pose{0, 0}, target{0, 0};
  bool moving = false;
  bool failMove = false;
  int moveCalls = 0, haltCalls = 0, lastSpeed = 0;
  uint32_t travelMs = 300, doneAt = 0, nowMs = 0;
  std::string faultReason;
  bool moveTo(int pan, int tilt, int speed) override {
    moveCalls++;
    if (failMove) return false;
    target = {pan, tilt};
    lastSpeed = speed;
    moving = !(target.pan == pose.pan && target.tilt == pose.tilt);
    doneAt = nowMs + travelMs;
    return true;
  }
  bool getPose(Pose& o) override { o = pose; return true; }
  bool isMoving() override { return moving; }
  void halt() override { haltCalls++; moving = false; }
  bool takeFault(std::string& r) override {
    if (faultReason.empty()) return false;
    r = faultReason;
    faultReason.clear();
    return true;
  }
  void tick(uint32_t n) override {
    nowMs = n;
    if (moving && (int32_t)(n - doneAt) >= 0) { moving = false; pose = target; }
  }
};

struct FakeDisplay : IDisplay {
  std::string expr = "neutral", text;
  bool speaking = false;
  int clears = 0, lookPan = 0, lookTilt = 0;
  TextPosition pos = TextPosition::Bubble;
  TextSize size = TextSize::Medium;
  void setExpression(const std::string& n) override { expr = n; }
  void lookAt(int p, int t) override { lookPan = p; lookTilt = t; }
  void setSpeaking(bool s) override { speaking = s; }
  void showText(const std::string& t, TextPosition p, TextSize s) override { text = t; pos = p; size = s; }
  void clearText() override { text.clear(); clears++; }
  void tick(uint32_t) override {}
};

struct FakeLed : ILed {
  LedSide side = LedSide::Both;
  int r = 0, g = 0, b = 0, calls = 0;
  LedMode mode = LedMode::Off;
  void set(LedSide s, uint8_t R, uint8_t G, uint8_t B, LedMode m) override { side = s; r = R; g = G; b = B; mode = m; calls++; }
  void tick(uint32_t) override {}
};

struct FakeSink : IPcmSink {
  std::vector<std::vector<uint8_t>> queued;  // chunks accepted, not finished
  std::vector<uint8_t> played;               // everything that finished
  size_t maxQueued = 2;
  int volume = -1;
  bool muted = false, rejectNext = false;
  int stops = 0;
  uint32_t rate = 0, channels = 0;
  bool canSubmit() override { return queued.size() < maxQueued; }
  bool submit(const uint8_t* d, size_t n, uint32_t r, uint8_t c) override {
    if (rejectNext) { rejectNext = false; return false; }
    queued.emplace_back(d, d + n);
    rate = r; channels = c;
    return true;
  }
  size_t pending() override { return queued.size(); }
  void stop() override { queued.clear(); stops++; }
  void setVolume(int v) override { volume = v; }
  void setMuted(bool m) override { muted = m; }
  // finish playing the oldest chunk
  void finishOne() {
    if (queued.empty()) return;
    played.insert(played.end(), queued.front().begin(), queued.front().end());
    queued.erase(queued.begin());
  }
  void finishAll() { while (!queued.empty()) finishOne(); }
};

struct FakeTransport : ITransport {
  ITransportListener* l = nullptr;
  bool connected = false;
  int connectCalls = 0, disconnectCalls = 0;
  std::vector<std::string> texts;
  std::vector<std::vector<uint8_t>> bins;
  void setListener(ITransportListener* x) override { l = x; }
  void connect() override { connectCalls++; }
  void disconnect() override { disconnectCalls++; connected = false; }
  bool isConnected() override { return connected; }
  bool sendText(const std::string& s) override { texts.push_back(s); return true; }
  bool sendBinary(const uint8_t* d, size_t n) override { bins.emplace_back(d, d + n); return true; }
  void loop() override {}
  // test helpers
  void open() { connected = true; l->onTransportConnected(); }
  void recv(const std::string& s) { l->onTransportText(s.data(), s.size()); }
  void recvBin(const std::vector<uint8_t>& b) { l->onTransportBinary(b.data(), b.size()); }
  void close(int code) { connected = false; l->onTransportClosed(code); }
};

struct Rig {
  FakeSys sys;
  FakeHead head;
  FakeDisplay display;
  FakeLed led;
  FakeSink sink;
  FakeTransport tr;
  std::vector<uint8_t> ringStore;
  PcmQueue queue;
  AudioPlayer player;
  DeviceConfig cfg;
  DeviceClient* client = nullptr;

  Rig() : ringStore(256 * 1024), queue(ringStore.data(), ringStore.size()), player(queue, sink) {
    cfg.deviceId = "stackchan-test";
    cfg.fw = "0.1.0-test";
    client = new DeviceClient(cfg, Hal{head, display, led, sink, sys}, tr, player);
  }
  ~Rig() { delete client; }

  // Advance the fake clock. With autoPong the "bridge" answers every device ping, like the
  // real Durable Object does; switch it off to test the pong timeout.
  bool autoPong = true;
  size_t pingScan = 0;
  void advance(uint32_t ms, uint32_t step = 10) {
    for (uint32_t d = 0; d < ms; d += step) {
      sys.t += step;
      client->tick();
      if (autoPong) {
        for (; pingScan < tr.texts.size(); pingScan++)
          if (tr.texts[pingScan] == kPingText && client->ready()) tr.recv(kPongText);
      }
    }
  }
  // Boot -> connect -> hello -> hello response. Leaves the client Ready.
  void ready() {
    client->begin();
    client->tick();
    tr.open();
    tr.recv(helloResponse());
    tr.texts.clear();
    pingScan = 0;
  }
  std::string helloId() {
    JsonDocument d;
    deserializeJson(d, tr.texts.at(0));
    return d["id"].as<std::string>();
  }
  std::string helloResponse() {
    return "{\"jsonrpc\":\"2.0\",\"id\":\"d_1\",\"result\":{\"session_id\":\"s_1\",\"server_time\":1,\"heartbeat_s\":20,"
           "\"audio\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096}}}";
  }
  // Send a request from the bridge and return the parsed response (or null doc if none).
  JsonDocument call(const std::string& id, const std::string& method, const std::string& params, size_t* firstNew = nullptr) {
    size_t before = tr.texts.size();
    tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"" + id + "\",\"method\":\"" + method + "\",\"params\":" + params + "}");
    if (firstNew) *firstNew = before;
    return find(id, before);
  }
  JsonDocument find(const std::string& id, size_t from = 0) {
    for (size_t i = from; i < tr.texts.size(); i++) {
      JsonDocument d;
      if (!deserializeJson(d, tr.texts[i]) && d["id"].is<const char*>() && id == d["id"].as<const char*>()) return d;
    }
    return JsonDocument();
  }
  // All notifications of a given method sent so far.
  std::vector<JsonDocument> notes(const std::string& method) {
    std::vector<JsonDocument> out;
    for (auto& s : tr.texts) {
      JsonDocument d;
      if (!deserializeJson(d, s) && d["method"].is<const char*>() && method == d["method"].as<const char*>() && d["id"].isNull()) out.push_back(std::move(d));
    }
    return out;
  }
};

inline std::string meta(int ttl = 5000, const char* key = nullptr, int seq = 1) {
  std::string m = "\"_meta\":{\"ttl_ms\":" + std::to_string(ttl) + ",\"seq\":" + std::to_string(seq);
  if (key) m += std::string(",\"idempotency_key\":\"") + key + "\"";
  return m + "}";
}

inline std::vector<uint8_t> frame(uint16_t stream, uint32_t seq, bool last, const std::vector<uint8_t>& payload) {
  std::vector<uint8_t> b(kFrameHeaderBytes + payload.size());
  FrameHeader h;
  h.type = kFrameDownlinkAudio;
  h.flags = last ? kFlagLast : 0;
  h.stream = stream;
  h.seq = seq;
  encodeFrameHeader(h, b.data());
  std::copy(payload.begin(), payload.end(), b.begin() + kFrameHeaderBytes);
  return b;
}

}  // namespace gctest
