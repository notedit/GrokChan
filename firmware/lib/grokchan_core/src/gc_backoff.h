// Exponential reconnect backoff 1 s -> 30 s (docs: 6.2), with +-20 % jitter.
#pragma once
#include <cstdint>

namespace gc {

class Backoff {
 public:
  Backoff(uint32_t minMs = 1000, uint32_t maxMs = 30000) : min_(minMs), max_(maxMs), cur_(0) {}
  // Delay before the next attempt. jitter in [0,1000) permille offset source (pass random()).
  uint32_t next(uint32_t jitterSample = 500) {
    cur_ = cur_ == 0 ? min_ : (cur_ * 2 > max_ ? max_ : cur_ * 2);
    // jitter: 80%..120% of cur_, never above max_
    uint32_t j = 800 + (jitterSample % 401);
    uint64_t d = (uint64_t)cur_ * j / 1000;
    return d > max_ ? max_ : (uint32_t)d;
  }
  void reset() { cur_ = 0; }
  uint32_t current() const { return cur_; }

 private:
  uint32_t min_, max_, cur_;
};

}  // namespace gc
