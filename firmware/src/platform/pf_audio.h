// PCM sink on M5Unified's Speaker (CoreS3: AW88298 amp via I2S). Implements gc::IPcmSink.
// M5.Speaker resamples (16 kHz -> device rate) itself. Chunks are copied into 3 rotating buffers
// because M5.Speaker keeps a pointer until the wave has played (up to 2 queued per channel).
// 待实机确认: 16 kHz quality, loudness mapping of percent -> 0..255, pops on start/stop.
#pragma once
#include <M5Unified.h>
#include <cstring>
#include "gc_hal.h"
#include "pf_config.h"

namespace pf {

class M5Sink : public gc::IPcmSink {
 public:
  static constexpr size_t kBufBytes = 8192;
  bool begin() {
    for (auto& b : buf_) {
      b = (int16_t*)heap_caps_malloc(kBufBytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
      if (!b) return false;
    }
    return true;
  }
  bool canSubmit() override { return M5.Speaker.isPlaying(GC_SPEAKER_CHANNEL) < 2; }
  bool submit(const uint8_t* data, size_t len, uint32_t rate, uint8_t channels) override {
    if (len > kBufBytes || len < 2 || !buf_[0]) return false;
    if (M5.Speaker.isPlaying(GC_SPEAKER_CHANNEL) >= 2) return false;
    int16_t* dst = buf_[next_];
    memcpy(dst, data, len & ~size_t(1));  // little-endian s16 == native on ESP32
    if (!M5.Speaker.playRaw(dst, len / 2, rate, channels == 2, 1, GC_SPEAKER_CHANNEL, false)) return false;
    next_ = (next_ + 1) % 3;
    return true;
  }
  size_t pending() override { return M5.Speaker.isPlaying(GC_SPEAKER_CHANNEL); }
  void stop() override { M5.Speaker.stop(GC_SPEAKER_CHANNEL); }
  void setVolume(int percent) override { percent_ = percent; apply(); }
  void setMuted(bool m) override { muted_ = m; apply(); }

 private:
  void apply() {
    int p = muted_ ? 0 : percent_;
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    M5.Speaker.setVolume((uint8_t)(p * 255 / 100));
  }
  int16_t* buf_[3] = {nullptr, nullptr, nullptr};
  int next_ = 0, percent_ = GC_INITIAL_VOLUME;
  bool muted_ = false;
};

}  // namespace pf
