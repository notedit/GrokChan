// 12-LED ring behind the PY32 expander. Implements gc::ILed with Solid / Breathe / Blink animation.
// 待实机确认: left/right split (GC_LED_LEFT_MASK/RIGHT_MASK), colour order, brightness.
#pragma once
#include <cmath>
#include "gc_hal.h"
#include "pf_py32.h"

namespace pf {

class PyLed : public gc::ILed {
 public:
  explicit PyLed(Py32& io) : io_(io) {}
  void set(gc::LedSide side, uint8_t r, uint8_t g, uint8_t b, gc::LedMode mode) override {
    Side s{r, g, b, mode};
    if (side == gc::LedSide::Left || side == gc::LedSide::Both) left_ = s;
    if (side == gc::LedSide::Right || side == gc::LedSide::Both) right_ = s;
    t0_ = lastNow_;
    dirty_ = true;
    render(lastNow_, true);
  }
  void tick(uint32_t now) override {
    lastNow_ = now;
    bool anim = left_.mode == gc::LedMode::Breathe || left_.mode == gc::LedMode::Blink ||
                right_.mode == gc::LedMode::Breathe || right_.mode == gc::LedMode::Blink;
    if (!anim && !dirty_) return;
    if (now - lastDraw_ < 66) return;  // <= 15 fps keeps I2C traffic low
    render(now, false);
  }

 private:
  struct Side { uint8_t r = 0, g = 0, b = 0; gc::LedMode mode = gc::LedMode::Off; };
  float factor(const Side& s, uint32_t now) const {
    uint32_t t = now - t0_;
    switch (s.mode) {
      case gc::LedMode::Solid: return 1.0f;
      case gc::LedMode::Breathe: return 0.15f + 0.85f * (0.5f - 0.5f * cosf(t * 2.0f * (float)M_PI / 2000.0f));  // 2 s period
      case gc::LedMode::Blink: return ((t / 500) & 1) ? 0.0f : 1.0f;
      default: return 0.0f;
    }
  }
  void render(uint32_t now, bool force) {
    uint16_t px[GC_LED_COUNT];
    float fl = factor(left_, now), fr = factor(right_, now);
    uint16_t cl = Py32::rgb565(left_.r * fl, left_.g * fl, left_.b * fl);
    uint16_t cr = Py32::rgb565(right_.r * fr, right_.g * fr, right_.b * fr);
    for (int i = 0; i < GC_LED_COUNT; i++) {
      bool l = (GC_LED_LEFT_MASK >> i) & 1, r = (GC_LED_RIGHT_MASK >> i) & 1;
      px[i] = l && r ? (cl | cr) : l ? cl : r ? cr : 0;
    }
    bool same = true;
    for (int i = 0; i < GC_LED_COUNT; i++) if (px[i] != last_[i]) { same = false; break; }
    if (!same || force) {
      io_.showLeds(px, GC_LED_COUNT);
      for (int i = 0; i < GC_LED_COUNT; i++) last_[i] = px[i];
    }
    lastDraw_ = now;
    dirty_ = false;
  }
  Py32& io_;
  Side left_, right_;
  uint16_t last_[GC_LED_COUNT] = {};
  uint32_t t0_ = 0, lastNow_ = 0, lastDraw_ = 0;
  bool dirty_ = false;
};

}  // namespace pf
