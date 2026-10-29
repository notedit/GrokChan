// Web virtual StackChan: the REAL firmware core (lib/grokchan_core: DeviceClient, AudioPlayer,
// VoiceUplink, FaceAnimator) compiled to WebAssembly, with the hardware HALs replaced by thin
// adapters that talk to the browser (tools/webdevice/web/*.js). Nothing of the protocol logic,
// validation, dedup, reconnect backoff, VAD or face animation is re-implemented in JS.
//
// Mirrors src/main.cpp (wiring) and src/platform/pf_*.h (HAL roles):
//   WebSys   ~ pf::ArduinoSystem        WebHead  ~ pf::ScsHead (servo model, like tools/sim)
//   WebFace  ~ pf::M5Face               WebLed   ~ pf::PyLed
//   WebSink  ~ pf::M5Sink               WebMic   ~ pf::M5Mic
//   WebTransport ~ pf::WsTransport (the WebSocket itself is owned by JS)
// What is NOT modelled (cannot be verified here): I2S, servo dynamics, real latency, echo,
// panel frame rate. See docs/webdevice.zh-CN.md.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "gc_audio.h"
#include "gc_device.h"
#include "gc_face.h"
#include "gc_voice.h"

#define JS_IMPORT(name) __attribute__((import_module("env"), import_name(#name)))
extern "C" {
JS_IMPORT(js_now) double js_now();
JS_IMPORT(js_log) void js_log(const char* p, int n);
JS_IMPORT(js_ws_connect) void js_ws_connect();
JS_IMPORT(js_ws_close) void js_ws_close();
JS_IMPORT(js_ws_send_text) int js_ws_send_text(const char* p, int n);
JS_IMPORT(js_ws_send_binary) int js_ws_send_binary(const uint8_t* p, int n);
JS_IMPORT(js_pcm_submit) void js_pcm_submit(const uint8_t* p, int n, int rate, int ch);
JS_IMPORT(js_pcm_stop) void js_pcm_stop();
JS_IMPORT(js_audio_volume) void js_audio_volume(int percent, int muted);
JS_IMPORT(js_mic_start) int js_mic_start();
JS_IMPORT(js_mic_stop) void js_mic_stop();
}

using namespace gc;

namespace {

uint32_t nowMs() { return (uint32_t)(uint64_t)js_now(); }
void logline(const std::string& s) { js_log(s.data(), (int)s.size()); }

std::string jstr(const std::string& s) {  // JSON string literal
  std::string o = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  return o + "\"";
}

struct WebSys : ISystem {
  int battery = 77;
  bool chg = false;
  uint32_t rng = 0x1234567u;
  uint32_t millis() override { return nowMs(); }
  int batteryPercent() override { return battery; }
  bool charging() override { return chg; }
  int wifiRssi() override { return -50; }  // fixed: the browser has no radio
  uint32_t random(uint32_t m) override {
    rng = rng * 1664525u + 1013904223u;
    return m ? (rng >> 8) % m : 0;
  }
  void saveVolume(int p) override { logline("save_volume " + std::to_string(p)); }
  void log(const char* l) override { logline(std::string("core: ") + l); }
};

// Servo model (same shape as tools/sim): linear motion at speed/3 deg/s. Real servo dynamics are
// 待实机确认; this only makes wait=done observable. Fault injection: stall (one-shot) / overheat (latched).
struct WebHead : IHead {
  Pose pose{0, 0}, from{0, 0}, to{0, 0};
  uint32_t startAt = 0, durMs = 0;
  bool moving = false, overheated = false;
  std::string pendingFault;
  bool moveTo(int pan, int tilt, int speed) override {
    if (overheated) return false;
    getPose(pose);
    from = pose; to = {pan, tilt};
    int d = std::max(std::abs(pan - from.pan), std::abs(tilt - from.tilt));
    durMs = (uint32_t)(d * 1000 / std::max(speed / 3, 1)) + 50;
    startAt = nowMs(); moving = d > 0;
    return true;
  }
  bool getPose(Pose& o) override {
    if (moving) {
      uint32_t e = nowMs() - startAt;
      if (e >= durMs) { pose = to; moving = false; }
      else {
        pose.pan = from.pan + (to.pan - from.pan) * (int)e / (int)durMs;
        pose.tilt = from.tilt + (to.tilt - from.tilt) * (int)e / (int)durMs;
      }
    }
    o = pose;
    return true;
  }
  bool isMoving() override { Pose p; getPose(p); return moving; }
  void halt() override { Pose p; getPose(p); moving = false; }
  bool takeFault(std::string& r) override {
    if (pendingFault.empty()) return false;
    r = pendingFault; pendingFault.clear(); return true;
  }
  void tick(uint32_t) override { Pose p; getPose(p); }
};

struct WebLed : ILed {
  struct Side { uint8_t r = 0, g = 0, b = 0; int mode = 3; } side[2];
  void set(LedSide s, uint8_t r, uint8_t g, uint8_t b, LedMode m) override {
    for (int i = 0; i < 2; i++) {
      if (s == LedSide::Both || (s == LedSide::Left && i == 0) || (s == LedSide::Right && i == 1)) side[i] = {r, g, b, (int)m};
    }
  }
  void tick(uint32_t) override {}
};

// Display = what pf::M5Face does minus the rasteriser: it drives the same FaceAnimator and publishes the
// frame to JS, which draws it with the shared tools/preview/face_draw.js. Subtitle layout class is set
// exactly like M5Face::layoutText() does; JS only wraps the lines for the canvas font.
struct WebFace : IDisplay {
  FaceAnimator face;
  std::string text;
  TextPosition tpos = TextPosition::Bubble;
  TextSize tsize = TextSize::Medium;
  std::string expr = "neutral", turn = "idle";
  bool speaking = false;
  int lookPan = 0, lookTilt = 0;
  uint32_t lastDraw = 0, seq = 0;
  std::vector<float> buf;
  static constexpr uint32_t kFrameMs = 50;  // 20 fps like M5Face

  void begin() { face.reset(nowMs()); buf.reserve(8 + kFaceMaxPrims * 8 + kFaceMaxPts * 2); }
  void setExpression(const std::string& n) override { expr = n; face.setExpression(n, nowMs()); }
  void lookAt(int pan, int tilt) override {
    lookPan = pan; lookTilt = tilt;
    face.setLook(std::fmax(-1.0f, std::fmin(1.0f, pan / 90.0f)), std::fmax(-1.0f, std::fmin(1.0f, -(tilt - 20) / 40.0f)));
  }
  void setSpeaking(bool s) override { speaking = s; face.setPlayback(s); }
  void setTurnState(const std::string& s) override { turn = s; face.setTurnState(s); }
  void setAudioLevel(float l) override { face.setLevel(l); }
  void showText(const std::string& t, TextPosition p, TextSize s) override {
    text = t; tpos = p; tsize = s;
    face.setTextLayout(p == TextPosition::Bottom ? FaceTextLayout::Bottom : p == TextPosition::Center ? FaceTextLayout::Center : FaceTextLayout::Top);
  }
  void clearText() override { text.clear(); face.setTextLayout(FaceTextLayout::None); }
  void tick(uint32_t now) override {
    if ((uint32_t)(now - lastDraw) < kFrameMs) return;
    lastDraw = now;
    face.update(now);
    publish();
  }
  // float32 layout: [seq, bg, accent, nPrims, nPts, dropped, then per prim: type,color,x,y,rx,ry,thick,n,(n*2 pts if Poly)]
  void publish() {
    const FaceFrame& f = face.frame();
    buf.clear();
    seq++;
    buf.push_back((float)(seq & 0xFFFFFF)); buf.push_back((float)f.bg); buf.push_back((float)f.accent);
    buf.push_back((float)f.nPrims); buf.push_back((float)f.nPts); buf.push_back((float)f.dropped);
    for (int i = 0; i < f.nPrims; i++) {
      const FacePrim& p = f.prims[i];
      buf.push_back((float)(int)p.type); buf.push_back((float)p.color);
      buf.push_back(p.x); buf.push_back(p.y); buf.push_back(p.rx); buf.push_back(p.ry); buf.push_back(p.thick);
      int n = p.type == PrimType::Poly ? p.n : 0;
      buf.push_back((float)n);
      for (int k = 0; k < n; k++) { buf.push_back(f.pts[p.off + k].x); buf.push_back(f.pts[p.off + k].y); }
    }
  }
};

// Plays in (browser) real time: a submitted chunk "finishes" after len/(rate*2*ch) s, same model as
// tools/sim. JS schedules the actual WebAudio buffers back to back, so both timelines agree as long as
// the AudioContext is running.
struct WebSink : IPcmSink {
  struct C { uint32_t doneAt; size_t len; };
  std::vector<C> q;
  size_t total = 0;
  int volume = 40; bool muted = false;
  void reap() { uint32_t n = nowMs(); while (!q.empty() && (int32_t)(n - q.front().doneAt) >= 0) q.erase(q.begin()); }
  bool canSubmit() override { reap(); return q.size() < 3; }  // like M5.Speaker: <2..3 queued waves
  bool submit(const uint8_t* d, size_t len, uint32_t rate, uint8_t ch) override {
    reap();
    if (len < 2 || len > 8192) return false;
    uint32_t start = q.empty() ? nowMs() : q.back().doneAt;
    q.push_back({start + (uint32_t)(len * 1000ull / (rate * 2ull * ch)), len});
    total += len;
    js_pcm_submit(d, (int)len, (int)rate, ch);
    return true;
  }
  size_t pending() override { reap(); return q.size(); }
  void stop() override { q.clear(); js_pcm_stop(); }
  void setVolume(int p) override { volume = p; js_audio_volume(volume, muted); }
  void setMuted(bool m) override { muted = m; js_audio_volume(volume, muted); }
};

// Mic: JS pushes 16 kHz mono s16le (already downsampled in the AudioWorklet); start()/stop() mirror
// M5Mic power gating. read() never blocks.
struct WebMic : IMic {
  std::vector<uint8_t> fifo;
  bool on = false;
  size_t cap = 16000 * 2 * 4;  // 4 s
  bool start() override { if (on) return true; on = js_mic_start() != 0; return on; }
  void stop() override { if (on) { js_mic_stop(); on = false; } fifo.clear(); }
  size_t read(uint8_t* dst, size_t max) override {
    size_t n = std::min(max, fifo.size()) & ~size_t(1);
    if (!n) return 0;
    std::memcpy(dst, fifo.data(), n);
    fifo.erase(fifo.begin(), fifo.begin() + n);
    return n;
  }
  void push(const uint8_t* p, size_t n) {
    if (!on) return;
    fifo.insert(fifo.end(), p, p + (n & ~size_t(1)));
    if (fifo.size() > cap) fifo.erase(fifo.begin(), fifo.begin() + (fifo.size() - cap));
  }
};

struct WebTransport : ITransport {
  ITransportListener* l = nullptr;
  bool connected = false;
  void setListener(ITransportListener* x) override { l = x; }
  void connect() override { connected = false; js_ws_connect(); }
  void disconnect() override { connected = false; js_ws_close(); }  // core-initiated: no onTransportClosed
  bool isConnected() override { return connected; }
  bool sendText(const std::string& s) override { return connected && js_ws_send_text(s.data(), (int)s.size()); }
  bool sendBinary(const uint8_t* d, size_t n) override { return connected && js_ws_send_binary(d, (int)n); }
  void loop() override {}
};

struct App {
  WebSys sys; WebHead head; WebFace face; WebLed led; WebSink sink; WebMic mic; WebTransport tr;
  std::vector<uint8_t> ring;
  PcmQueue* queue = nullptr;
  AudioPlayer* player = nullptr;
  DeviceClient* client = nullptr;
  VoiceUplink* voice = nullptr;
  bool touchEmergency = true;  // GC_TOUCH_EMERGENCY_STOP default
  std::string json;
};
App* g = nullptr;

}  // namespace

extern "C" {

__attribute__((export_name("wd_alloc"))) void* wd_alloc(int n) { return std::malloc((size_t)std::max(n, 1)); }
__attribute__((export_name("wd_free"))) void wd_free(void* p) { std::free(p); }

// Hello-relevant limits come from gc_config.example.h defaults (same as the firmware).
__attribute__((export_name("wd_init"))) int wd_init(const char* deviceId, int vad, int bargeInByVad, int minRms, int touchEmergency) {
  if (g) return 0;
  g = new App();
  g->ring.resize(262144);  // GC_AUDIO_RING_BYTES
  g->face.begin();
  g->queue = new PcmQueue(g->ring.data(), g->ring.size());
  AudioPlayerConfig ac;
  ac.prebufferMs = 300;    // GC_AUDIO_PREBUFFER_MS
  ac.submitBytes = 4096;
  g->player = new AudioPlayer(*g->queue, g->sink, ac);
  DeviceConfig dc;
  dc.deviceId = deviceId;
  dc.fw = "0.1.0-web";
  dc.hw = "web-sim";
  dc.limits.panMin = -90; dc.limits.panMax = 90; dc.limits.tiltMin = 0; dc.limits.tiltMax = 60;
  dc.limits.volumeCap = 70; dc.limits.ledMax = 168; dc.limits.lowBatteryPct = 10; dc.limits.lowBatteryVolumeCap = 40;
  dc.initialVolume = 40;
  dc.bufferMs = (uint32_t)((g->ring.size() / 2) * 1000ull / dc.audioSampleRate);
  Hal hal{g->head, g->face, g->led, g->sink, g->sys};
  g->client = new DeviceClient(dc, hal, g->tr, *g->player);
  VoiceConfig vc;
  vc.vad = vad != 0;
  vc.bargeInByVad = bargeInByVad != 0;
  if (minRms > 0) vc.minRms = (uint32_t)minRms;
  g->voice = new VoiceUplink(g->mic, *g->client, vc);
  g->client->setVoice(g->voice);
  g->touchEmergency = touchEmergency != 0;
  g->client->begin();
  return 1;
}

__attribute__((export_name("wd_tick"))) void wd_tick() { if (g) g->client->tick(); }
__attribute__((export_name("wd_on_open"))) void wd_on_open() { if (g) { g->tr.connected = true; g->client->onTransportConnected(); } }
__attribute__((export_name("wd_on_close"))) void wd_on_close(int code) { if (g) { g->tr.connected = false; g->client->onTransportClosed(code); } }
__attribute__((export_name("wd_on_text"))) void wd_on_text(const char* p, int n) { if (g) g->client->onTransportText(p, (size_t)n); }
__attribute__((export_name("wd_on_binary"))) void wd_on_binary(const uint8_t* p, int n) { if (g) g->client->onTransportBinary(p, (size_t)n); }

// Touch screen: emergency stop (default, like firmware) or push-to-talk, as selected at init.
__attribute__((export_name("wd_touch_down"))) void wd_touch_down() {
  if (!g) return;
  if (g->touchEmergency) g->client->localEmergencyStop("touch");
  else g->voice->pttDown(nowMs(), g->player->busy());
}
__attribute__((export_name("wd_touch_up"))) void wd_touch_up() { if (g && !g->touchEmergency) g->voice->pttUp(nowMs()); }
// Explicit PTT (the web UI has a dedicated button, independent of the touch mode).
__attribute__((export_name("wd_ptt_down"))) int wd_ptt_down() { return g ? g->voice->pttDown(nowMs(), g->player->busy()) : 0; }
__attribute__((export_name("wd_ptt_up"))) void wd_ptt_up() { if (g) g->voice->pttUp(nowMs()); }
__attribute__((export_name("wd_local_stop"))) void wd_local_stop(const char* why) { if (g) g->client->localEmergencyStop(why); }

__attribute__((export_name("wd_mic_push"))) void wd_mic_push(const uint8_t* p, int n) { if (g) g->mic.push(p, (size_t)n); }
__attribute__((export_name("wd_set_battery"))) void wd_set_battery(int pct, int charging) { if (g) { g->sys.battery = pct; g->sys.chg = charging != 0; } }
// 0 clear overheat, 1 one-shot servo stall, 2 latch overheat (moveTo fails until cleared)
__attribute__((export_name("wd_head_fault"))) void wd_head_fault(int mode) {
  if (!g) return;
  if (mode == 0) g->head.overheated = false;
  else if (mode == 1) g->head.pendingFault = "servo stall (injected)";
  else { g->head.overheated = true; g->head.pendingFault = "overheat protection (injected)"; }
}

__attribute__((export_name("wd_frame_ptr"))) const float* wd_frame_ptr() { return g ? g->face.buf.data() : nullptr; }
__attribute__((export_name("wd_frame_len"))) int wd_frame_len() { return g ? (int)g->face.buf.size() : 0; }

__attribute__((export_name("wd_state_json"))) const char* wd_state_json() {
  if (!g) return "{}";
  Pose p; g->head.getPose(p);
  auto& c = *g->client;
  static const char* ss[] = {"idle", "wait_retry", "connecting", "hello_sent", "ready"};
  std::string& o = g->json;
  o = "{";
  o += "\"session\":" + jstr(ss[(int)c.state()]);
  o += ",\"session_id\":" + jstr(c.sessionId());
  o += ",\"heartbeat_s\":" + std::to_string(c.heartbeatS());
  o += ",\"reconnects\":" + std::to_string(c.reconnects());
  o += ",\"next_retry_ms\":" + std::to_string(c.nextRetryDelayMs());
  o += ",\"volume\":" + std::to_string(c.volume());
  o += ",\"muted\":" + std::string(c.muted() ? "true" : "false");
  o += ",\"expression\":" + jstr(c.expression());
  o += ",\"turn\":" + jstr(g->face.turn);
  o += ",\"speaking\":" + std::string(g->face.speaking ? "true" : "false");
  o += ",\"pose\":{\"pan\":" + std::to_string(p.pan) + ",\"tilt\":" + std::to_string(p.tilt) + ",\"moving\":" + (g->head.moving ? "true" : "false") + "}";
  o += ",\"overheated\":" + std::string(g->head.overheated ? "true" : "false");
  const char* lm[] = {"solid", "breathe", "blink", "off"};
  o += ",\"led\":[";
  for (int i = 0; i < 2; i++) {
    auto& s = g->led.side[i];
    o += std::string(i ? "," : "") + "{\"r\":" + std::to_string(s.r) + ",\"g\":" + std::to_string(s.g) + ",\"b\":" + std::to_string(s.b) + ",\"mode\":\"" + lm[s.mode] + "\"}";
  }
  o += "]";
  const char* tp[] = {"bubble", "center", "bottom"};
  const char* tz[] = {"small", "medium", "large"};
  o += ",\"text\":" + jstr(g->face.text) + ",\"text_pos\":\"" + tp[(int)g->face.tpos] + "\",\"text_size\":\"" + tz[(int)g->face.tsize] + "\"";
  o += ",\"battery\":" + std::to_string(g->sys.battery) + ",\"charging\":" + (g->sys.chg ? "true" : "false");
  o += ",\"player\":{\"busy\":" + std::string(g->player->busy() ? "true" : "false") + ",\"playing\":" + (g->player->playing() ? "true" : "false") +
       ",\"stream\":" + std::to_string(g->player->currentStream()) + ",\"underruns\":" + std::to_string(g->player->underruns()) +
       ",\"dropped_frames\":" + std::to_string(g->player->droppedFrames()) + ",\"queued_bytes\":" + std::to_string(g->queue->used()) + "}";
  auto* v = g->voice;
  o += ",\"voice\":{\"uplink\":" + jstr(uplinkStateName(v->state())) + ",\"mic\":" + (v->micActive() ? "true" : "false") +
       ",\"turn_state\":" + jstr(v->turnState()) + ",\"stream\":" + std::to_string(v->streamId()) + ",\"sent_bytes\":" + std::to_string(v->sentBytes()) +
       ",\"sent_frames\":" + std::to_string(v->sentFrames()) + ",\"turns\":" + std::to_string(v->turns()) + ",\"noise_floor\":" + std::to_string(v->noiseFloor()) + "}";
  o += "}";
  return o.c_str();
}

}  // extern "C"
