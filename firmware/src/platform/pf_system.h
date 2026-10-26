// gc::ISystem on Arduino / M5Unified / NVS.
#pragma once
#include <M5Unified.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_system.h>
#include "gc_hal.h"
#include "pf_config.h"

namespace pf {

class ArduinoSystem : public gc::ISystem {
 public:
  void begin() { prefs_.begin("grokchan", false); }
  int loadVolume(int dflt) { return prefs_.getInt("vol", dflt); }
  uint32_t millis() override { return ::millis(); }
  int batteryPercent() override {
    int v = M5.Power.getBatteryLevel();
    return (v < 0 || v > 100) ? -1 : v;
  }
  bool charging() override { return M5.Power.isCharging() == m5::Power_Class::is_charging; }
  int wifiRssi() override { return WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0; }
  uint32_t random(uint32_t maxExclusive) override { return maxExclusive ? esp_random() % maxExclusive : 0; }
  void saveVolume(int percent) override { prefs_.putInt("vol", percent); }
  void log(const char* line) override { Serial.printf("[%lu] %s\n", (unsigned long)::millis(), line); }

 private:
  Preferences prefs_;
};

}  // namespace pf
