// Host simulator of the firmware core, used by tools/e2e (bridge <-> real firmware core).
// The WebSocket itself is owned by the Node test; this process only has stdin/stdout:
//   stdout:  "CONNECT"            core wants a connection attempt
//            "CLOSE"              core closed the connection
//            "T <json>"           text frame sent by the device
//            "B <hex>"            binary frame sent by the device
//            "LOG <text>"         HAL activity (HEAD/LED/EXPR/TEXT/PCM/VOL/...) for assertions
//   stdin:   "O"                  connection opened
//            "T <json>"           text frame from the bridge
//            "B <hex>"            binary frame from the bridge
//            "C <code>"           connection closed
// Usage: sim_stdio <device_id>
#include <poll.h>
#include <unistd.h>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>
#include "gc_audio.h"
#include "gc_device.h"

using namespace gc;
static uint32_t nowMs() {
  using namespace std::chrono;
  static auto t0 = steady_clock::now();
  return (uint32_t)duration_cast<milliseconds>(steady_clock::now() - t0).count() + 1000;
}
static void out(const std::string& s) { std::fwrite(s.data(), 1, s.size(), stdout); std::fputc('\n', stdout); std::fflush(stdout); }
static void logf(const std::string& s) { out("LOG " + s); }

struct Sys : ISystem {
  uint32_t millis() override { return nowMs(); }
  int batteryPercent() override { return 77; }
  bool charging() override { return false; }
  int wifiRssi() override { return -50; }
  uint32_t random(uint32_t m) override { return m ? 200 % m : 0; }
  void saveVolume(int p) override { logf("SAVE_VOLUME " + std::to_string(p)); }
  void log(const char* l) override { logf(std::string("core: ") + l); }
};

// Servo model: linear move at (speed * 0.3 deg/s ... arbitrary) so wait=done is observable.
struct Head : IHead {
  Pose pose{0, 0}, from{0, 0}, to{0, 0};
  uint32_t startAt = 0, durMs = 0;
  bool moving = false;
  bool moveTo(int pan, int tilt, int speed) override {
    getPose(pose);
    from = pose; to = {pan, tilt};
    int d = std::max(std::abs(pan - from.pan), std::abs(tilt - from.tilt));
    durMs = (uint32_t)(d * 1000 / std::max(speed / 3, 1)) + 50;  // sim only
    startAt = nowMs(); moving = d > 0;
    logf("HEAD moveTo pan=" + std::to_string(pan) + " tilt=" + std::to_string(tilt) + " speed=" + std::to_string(speed));
    return true;
  }
  bool getPose(Pose& o) override {
    if (moving) {
      uint32_t e = nowMs() - startAt;
      if (e >= durMs) { pose = to; moving = false; }
      else { pose.pan = from.pan + (to.pan - from.pan) * (int)e / (int)durMs; pose.tilt = from.tilt + (to.tilt - from.tilt) * (int)e / (int)durMs; }
    }
    o = pose; return true;
  }
  bool isMoving() override { Pose p; getPose(p); return moving; }
  void halt() override { Pose p; getPose(p); moving = false; logf("HEAD halt"); }
  bool takeFault(std::string&) override { return false; }
  void tick(uint32_t) override { Pose p; getPose(p); }
};
struct Disp : IDisplay {
  void setExpression(const std::string& n) override { logf("EXPR " + n); }
  void lookAt(int p, int t) override { logf("LOOK " + std::to_string(p) + "," + std::to_string(t)); }
  void setSpeaking(bool s) override { logf(std::string("SPEAKING ") + (s ? "1" : "0")); }
  void showText(const std::string& t, TextPosition, TextSize) override { logf("TEXT " + t); }
  void clearText() override { logf("TEXT_CLEAR"); }
  void tick(uint32_t) override {}
};
struct Led : ILed {
  void set(LedSide s, uint8_t r, uint8_t g, uint8_t b, LedMode m) override {
    logf("LED side=" + std::to_string((int)s) + " rgb=" + std::to_string(r) + "," + std::to_string(g) + "," + std::to_string(b) + " mode=" + std::to_string((int)m));
  }
  void tick(uint32_t) override {}
};
// Plays in real time: a submitted chunk "finishes" after len/(rate*2*ch) seconds.
struct Sink : IPcmSink {
  struct C { uint32_t doneAt; size_t len; };
  std::vector<C> q;
  size_t total = 0;
  void reap() { uint32_t n = nowMs(); while (!q.empty() && (int32_t)(n - q.front().doneAt) >= 0) q.erase(q.begin()); }
  bool canSubmit() override { reap(); return q.size() < 3; }
  bool submit(const uint8_t*, size_t len, uint32_t rate, uint8_t ch) override {
    reap();
    uint32_t start = q.empty() ? nowMs() : q.back().doneAt;
    q.push_back({start + (uint32_t)(len * 1000ull / (rate * 2ull * ch)), len});
    total += len; return true;
  }
  size_t pending() override { reap(); return q.size(); }
  void stop() override { q.clear(); logf("PCM stop"); }
  void setVolume(int p) override { logf("VOL " + std::to_string(p)); }
  void setMuted(bool m) override { logf(std::string("MUTE ") + (m ? "1" : "0")); }
};

struct StdioTransport : ITransport {
  ITransportListener* l = nullptr;
  bool connected = false;
  void setListener(ITransportListener* x) override { l = x; }
  void connect() override { out("CONNECT"); }
  void disconnect() override { connected = false; out("CLOSE"); }
  bool isConnected() override { return connected; }
  bool sendText(const std::string& s) override { out("T " + s); return true; }
  bool sendBinary(const uint8_t* d, size_t n) override {
    static const char* hx = "0123456789abcdef"; std::string s = "B ";
    for (size_t i = 0; i < n; i++) { s += hx[d[i] >> 4]; s += hx[d[i] & 15]; }
    out(s); return true;
  }
  void loop() override {}
};

int main(int argc, char** argv) {
  std::vector<uint8_t> ring(256 * 1024);
  Sys sys; Head head; Disp disp; Led led; Sink sink; StdioTransport tr;
  PcmQueue queue(ring.data(), ring.size());
  AudioPlayer player(queue, sink);
  DeviceConfig cfg;
  cfg.deviceId = argc > 1 ? argv[1] : "sim";
  cfg.fw = "0.1.0-sim";
  DeviceClient client(cfg, Hal{head, disp, led, sink, sys}, tr, player);
  client.begin();
  std::string buf;
  for (;;) {
    struct pollfd p{0, POLLIN, 0};
    int r = poll(&p, 1, 5);
    if (r > 0) {
      char tmp[65536];
      ssize_t n = read(0, tmp, sizeof tmp);
      if (n <= 0) return 0;
      buf.append(tmp, (size_t)n);
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl); buf.erase(0, nl + 1);
        if (line == "O") { tr.connected = true; client.onTransportConnected(); }
        else if (line.rfind("C ", 0) == 0) { tr.connected = false; client.onTransportClosed(atoi(line.c_str() + 2)); }
        else if (line.rfind("T ", 0) == 0) client.onTransportText(line.data() + 2, line.size() - 2);
        else if (line.rfind("B ", 0) == 0) {
          std::vector<uint8_t> b;
          for (size_t i = 2; i + 1 < line.size(); i += 2) b.push_back((uint8_t)std::stoi(line.substr(i, 2), nullptr, 16));
          client.onTransportBinary(b.data(), b.size());
        }
      }
    } else if (r < 0) return 1;
    client.tick();
  }
}
