// GrokChan firmware entry point: wires the platform HALs to the hardware-independent core
// (lib/grokchan_core) and runs the JSON-RPC 2.0 WebSocket client against the bridge.
#include <M5Unified.h>
#include <WiFi.h>
#include <esp_heap_caps.h>

#include "gc_audio.h"
#include "gc_device.h"
#include "platform/pf_audio.h"
#include "platform/pf_config.h"
#include "platform/pf_display.h"
#include "platform/pf_head.h"
#include "platform/pf_led.h"
#include "platform/pf_py32.h"
#include "platform/pf_system.h"
#include "platform/pf_transport.h"

namespace {
pf::ArduinoSystem g_sys;
pf::Py32 g_py32;
pf::M5Face g_face;
pf::ScsHead g_head;
pf::M5Sink g_sink;
pf::WsTransport g_ws;
pf::PyLed* g_led = nullptr;
gc::PcmQueue* g_queue = nullptr;
gc::AudioPlayer* g_player = nullptr;
gc::DeviceClient* g_client = nullptr;

uint32_t g_wifiSince = 0;
bool g_wifiShown = false;

void startWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // keeps audio streaming smooth; costs power. 待实机确认
  WiFi.begin(GC_WIFI_SSID, GC_WIFI_PASS);
  g_wifiSince = millis();
}

void wifiTick() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!g_wifiShown) {
      g_wifiShown = true;
      g_sys.log(("wifi connected, ip " + std::string(WiFi.localIP().toString().c_str())).c_str());
      g_face.clearText();
    }
    g_wifiSince = millis();
    return;
  }
  if (g_wifiShown) { g_wifiShown = false; g_sys.log("wifi lost"); }
  if (millis() - g_wifiSince > 20000) {  // stuck: kick it
    g_sys.log("wifi retry");
    WiFi.disconnect();
    WiFi.begin(GC_WIFI_SSID, GC_WIFI_PASS);
    g_wifiSince = millis();
  }
}
}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.internal_mic = false;  // mic and speaker share the I2S bus on CoreS3; M1 only plays
  cfg.internal_spk = true;
  M5.begin(cfg);
  Serial.begin(GC_SERIAL_BAUD);
  g_sys.begin();
  g_sys.log("GrokChan firmware " GC_FW_VERSION " booting, device_id " GC_DEVICE_ID);

  g_face.begin();
  g_face.showText("GrokChan 启动中…", gc::TextPosition::Center, gc::TextSize::Medium);
  g_face.tick(millis());

  // PY32: servo power + LED ring. Servos must be powered before the bus is probed.
  bool py = g_py32.begin();
  g_sys.log(py ? "PY32 expander ok" : "PY32 expander NOT found (no servo power / LEDs)");
  g_led = new pf::PyLed(g_py32);
  if (py) g_led->set(gc::LedSide::Both, 0, 0, 0, gc::LedMode::Off);
  bool servos = py && g_head.begin();
  g_sys.log(servos ? "servos ok" : "servos NOT answering (head commands will return device_fault)");

  // Audio ring: PSRAM when present.
  size_t ringBytes = GC_AUDIO_RING_BYTES;
  uint8_t* ring = (uint8_t*)heap_caps_malloc(ringBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!ring) {
    ringBytes = GC_AUDIO_RING_BYTES_NO_PSRAM;
    ring = (uint8_t*)heap_caps_malloc(ringBytes, MALLOC_CAP_8BIT);
    g_sys.log("no PSRAM ring, using internal RAM");
  }
  if (!ring || !g_sink.begin()) {
    g_sys.log("FATAL: out of memory for audio buffers");
    g_face.showText("内存不足", gc::TextPosition::Center, gc::TextSize::Large);
    for (;;) { g_face.tick(millis()); delay(100); }
  }
  g_queue = new gc::PcmQueue(ring, ringBytes);

  gc::DeviceConfig dc;
  dc.deviceId = GC_DEVICE_ID;
  dc.fw = GC_FW_VERSION;
  dc.hw = GC_HW_NAME;
  dc.limits.panMin = GC_PAN_MIN;
  dc.limits.panMax = GC_PAN_MAX;
  dc.limits.tiltMin = GC_TILT_MIN;
  dc.limits.tiltMax = GC_TILT_MAX;
  dc.limits.volumeCap = GC_VOLUME_CAP;
  dc.limits.ledMax = GC_LED_MAX_CHANNEL;
  dc.limits.lowBatteryPct = GC_LOW_BATTERY_PCT;
  dc.limits.lowBatteryVolumeCap = GC_LOW_BATTERY_VOLUME_CAP;
  dc.initialVolume = g_sys.loadVolume(GC_INITIAL_VOLUME);
  dc.bufferMs = (uint32_t)((ringBytes / 2) * 1000ull / dc.audioSampleRate);

  gc::AudioPlayerConfig ac;
  ac.prebufferMs = GC_AUDIO_PREBUFFER_MS;
  ac.submitBytes = 4096;
  g_player = new gc::AudioPlayer(*g_queue, g_sink, ac);

  gc::Hal hal{g_head, g_face, *g_led, g_sink, g_sys};
  g_client = new gc::DeviceClient(dc, hal, g_ws, *g_player);

  g_face.showText("连接 WiFi…", gc::TextPosition::Center, gc::TextSize::Medium);
  startWifi();
  g_client->begin();  // the transport waits for WiFi before opening the socket
}

void loop() {
  M5.update();
  wifiTick();
  g_client->tick();  // transport loop, head/led/display/audio ticks, protocol timers

#if GC_TOUCH_EMERGENCY_STOP
  if (M5.Touch.getCount() > 0 && M5.Touch.getDetail(0).wasPressed()) g_client->localEmergencyStop("touch");
#endif
  delay(1);  // yield to WiFi/IDLE; the audio path is driven by M5.Speaker's own task
}
