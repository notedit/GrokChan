// PY32 IO expander (I2C 0x6F) on the CoreS3 internal I2C bus: servo power enable + LED ring.
// Register map and init sequence follow the official M5Stack StackChan firmware (MIT):
// firmware/main/hal/hal_io_expander.cpp + drivers/PY32IOExpander_Class. 待实机确认: not yet
// run through this Arduino/M5Unified implementation.
#pragma once
#include <M5Unified.h>
#include "pf_config.h"

namespace pf {

class Py32 {
 public:
  bool begin() {
    // PY32 may boot slowly: retry the version register for ~1.2 s like the official firmware.
    uint32_t t0 = millis();
    for (;;) {
      delay(200);
      uint8_t v = rd(kRegVersion);
      if (v != 0 && v != 0xFF) { version_ = v; ok_ = true; break; }
      if (millis() - t0 > 1200) return false;
    }
    // servo power (pin 0): output + pull-up, then drive high.
    setBit(kDirL, kDirH, GC_SERVO_POWER_PIN_EXPANDER, true);
    pullUp(GC_SERVO_POWER_PIN_EXPANDER);
    setBit(kOutL, kOutH, GC_SERVO_POWER_PIN_EXPANDER, true);
    delay(200);
    // LED line (pin 13): output, pull-up, push-pull; then LED count.
    setBit(kDirL, kDirH, GC_PY32_LED_PIN, true);
    pullUp(GC_PY32_LED_PIN);
    setBit(kDrvL, kDrvH, GC_PY32_LED_PIN, false);
    wr(kRegLedCfg, GC_LED_COUNT & 0x3F);
    delay(200);
    return true;
  }
  bool ok() const { return ok_; }
  uint8_t version() const { return version_; }

  void setServoPower(bool on) { if (ok_) setBit(kOutL, kOutH, GC_SERVO_POWER_PIN_EXPANDER, on); }

  // 12 x RGB565 (little endian on the wire), then refresh.
  void showLeds(const uint16_t* rgb565, int count) {
    if (!ok_) return;
    uint8_t buf[64];
    if (count > 32) count = 32;
    for (int i = 0; i < count; i++) { buf[i * 2] = rgb565[i] & 0xFF; buf[i * 2 + 1] = rgb565[i] >> 8; }
    M5.In_I2C.writeRegister(GC_PY32_ADDR, kRegLedRam, buf, count * 2, GC_PY32_I2C_FREQ);
    uint8_t cfg = rd(kRegLedCfg);
    wr(kRegLedCfg, cfg | (1 << 6));
  }

  static uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) { return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3); }

 private:
  static constexpr uint8_t kRegVersion = 0x02, kDirL = 0x03, kDirH = 0x04, kOutL = 0x05, kOutH = 0x06,
                           kPuL = 0x09, kPuH = 0x0A, kPdL = 0x0B, kPdH = 0x0C, kDrvL = 0x13, kDrvH = 0x14,
                           kRegLedCfg = 0x24, kRegLedRam = 0x30;
  uint8_t rd(uint8_t reg) { return M5.In_I2C.readRegister8(GC_PY32_ADDR, reg, GC_PY32_I2C_FREQ); }
  void wr(uint8_t reg, uint8_t v) { M5.In_I2C.writeRegister8(GC_PY32_ADDR, reg, v, GC_PY32_I2C_FREQ); }
  void setBit(uint8_t regL, uint8_t regH, uint8_t pin, bool v) {
    uint8_t reg = pin < 8 ? regL : regH;
    uint8_t mask = 1 << (pin & 7);
    uint8_t cur = rd(reg);
    wr(reg, v ? (cur | mask) : (cur & ~mask));
  }
  void pullUp(uint8_t pin) {
    setBit(kPdL, kPdH, pin, false);
    setBit(kPuL, kPuH, pin, true);
  }
  bool ok_ = false;
  uint8_t version_ = 0;
};

}  // namespace pf
