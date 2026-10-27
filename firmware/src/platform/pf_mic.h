// PCM source on M5Unified's Mic (CoreS3: ES7210 ADC via I2S). Implements gc::IMic (16 kHz mono s16le).
// 待实机确认 (never run on hardware):
//   - On CoreS3 the mic and the speaker amp share one I2S port, and M5Unified allows only one of
//     M5.Mic / M5.Speaker to be active at a time. This class releases the speaker in start() and the
//     playback side (pf::M5Sink) re-claims it on the next submit; whether the swap is fast and
//     click-free enough for barge-in is unknown. Until verified, GC_VOICE_ENABLED stays 0.
//   - Mic gain (GC_MIC_GAIN) and the VAD threshold (VoiceConfig::minRms) need tuning on the device.
#pragma once
#include <M5Unified.h>
#include <cstring>
#include "gc_voice.h"
#include "pf_config.h"

namespace pf {

class M5Mic : public gc::IMic {
 public:
  static constexpr size_t kSamples = 640;  // 40 ms per buffer
  bool begin() {
    for (auto& b : buf_) {
      b = (int16_t*)heap_caps_malloc(kSamples * 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
      if (!b) return false;
    }
    return true;
  }
  bool start() override {
    if (on_) return true;
    if (!buf_[0]) return false;
    M5.Speaker.end();  // shared I2S bus
    auto cfg = M5.Mic.config();
    cfg.sample_rate = 16000;
    cfg.stereo = false;
    cfg.magnification = GC_MIC_GAIN;
    cfg.noise_filter_level = 0;
    M5.Mic.config(cfg);
    if (!M5.Mic.begin()) return false;
    on_ = true;
    fill_ = 0; rd_ = 0; have_ = 0;
    queue(); queue();  // two buffers in flight; the oldest completes first
    return true;
  }
  void stop() override {
    if (!on_) return;
    M5.Mic.end();
    on_ = false;
  }
  size_t read(uint8_t* dst, size_t max) override {
    if (!on_) return 0;
    if (have_ == 0) {
      if (M5.Mic.isRecording() >= 2) return 0;  // oldest buffer still being filled
      // isRecording() < 2: the oldest queued buffer (`fill_`) is complete; re-queue it after copying out
      have_ = kSamples * 2; rd_ = 0;
      cur_ = buf_[fill_];
      fill_ = (fill_ + 1) % 2;
      queue();
    }
    size_t n = std::min(max, have_) & ~size_t(1);
    memcpy(dst, (uint8_t*)cur_ + rd_, n);  // ESP32 is little-endian
    rd_ += n; have_ -= n;
    return n;
  }

 private:
  void queue() { M5.Mic.record(buf_[qi_], kSamples, 16000); qi_ = (qi_ + 1) % 2; }
  int16_t* buf_[2] = {nullptr, nullptr};
  int16_t* cur_ = nullptr;
  size_t fill_ = 0, qi_ = 0, rd_ = 0, have_ = 0;
  bool on_ = false;
};

}  // namespace pf
