#include "gc_voice.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include "gc_protocol.h"

namespace gc {

const char* uplinkStateName(UplinkState s) {
  switch (s) {
    case UplinkState::Off: return "off";
    case UplinkState::Idle: return "idle";
    case UplinkState::Listening: return "listening";
    case UplinkState::Cooldown: return "cooldown";
  }
  return "?";
}

namespace {
constexpr size_t kBytesPerMs = 32;  // 16 kHz * 2 B
}

void VoiceUplink::micOff() {
  if (micOn_) { mic_.stop(); micOn_ = false; }
}

void VoiceUplink::onBridgeHello(bool voiceAvailable, uint32_t maxMs, uint32_t maxBytes) {
  available_ = voiceAvailable;
  if (maxMs) cfg_.maxMs = maxMs;
  if (maxBytes) cfg_.maxBytes = maxBytes;
  acc_.clear(); pre_.clear(); out_.clear();
  loudRun_ = 0;
  turnState_ = "idle";
  if (!available_) { micOff(); st_ = UplinkState::Off; return; }
  st_ = UplinkState::Idle;  // the mic is opened lazily in tick()
}

void VoiceUplink::onLinkDown() {
  micOff();
  st_ = UplinkState::Off;
  available_ = false;
  ptt_ = false;
  acc_.clear(); pre_.clear(); out_.clear();
  loudRun_ = 0;
  turnState_ = "idle";
}

uint32_t VoiceUplink::rmsOf(const uint8_t* p, size_t n) const {
  size_t samples = n / 2;
  if (!samples) return 0;
  uint64_t acc = 0;
  for (size_t i = 0; i < samples; i++) {
    int16_t s = (int16_t)(uint16_t)(p[2 * i] | (p[2 * i + 1] << 8));
    acc += (uint64_t)((int32_t)s * (int32_t)s);
  }
  uint64_t mean = acc / samples;
  // integer sqrt
  uint64_t x = mean, r = 0, bit = 1ull << 62;
  while (bit > x) bit >>= 2;
  while (bit) {
    if (x >= r + bit) { x -= r + bit; r = (r >> 1) + bit; } else { r >>= 1; }
    bit >>= 2;
  }
  return (uint32_t)r;
}

void VoiceUplink::sendFrame(const uint8_t* p, size_t n, uint32_t now) {
  if (n == 0) return;
  scratch_.resize(kFrameHeaderBytes + n);
  FrameHeader h;
  h.type = kFrameUplinkAudio;
  h.flags = 0;
  h.stream = sid_;
  h.seq = seq_;
  encodeFrameHeader(h, scratch_.data());
  std::memcpy(scratch_.data() + kFrameHeaderBytes, p, n);
  if (!link_.linkSendBinary(scratch_.data(), scratch_.size())) {
    // The transport refused (socket gone / backed up): do not keep talking into a dead pipe.
    end(now, true, false, "send_failed");
    return;
  }
  seq_++;
  bytes_ += (uint32_t)n;
}

void VoiceUplink::flushPending(uint32_t now) {
  while (st_ == UplinkState::Listening && out_.size() >= cfg_.frameBytes) {
    size_t n = cfg_.frameBytes & ~(size_t)1;
    sendFrame(out_.data(), n, now);
    if (st_ != UplinkState::Listening) return;
    out_.erase(out_.begin(), out_.begin() + n);
  }
}

void VoiceUplink::pushAudio(const uint8_t* p, size_t n, uint32_t now) {
  // Enforce the bridge's utterance limit: stop (and announce a normal end) before exceeding it.
  size_t room = cfg_.maxBytes > bytes_ + out_.size() ? cfg_.maxBytes - bytes_ - out_.size() : 0;
  bool hitLimit = n > room;
  if (hitLimit) n = room & ~(size_t)1;
  out_.insert(out_.end(), p, p + n);
  flushPending(now);
  if (st_ == UplinkState::Listening && hitLimit) end(now, false, true, "max_ms");  // truncate, not discard
}

bool VoiceUplink::begin(uint32_t now, bool ptt) {
  if (!available_ || !link_.linkReady()) return false;
  if (!micOn_) return false;
  sid_ = nextSid_;
  nextSid_ = nextSid_ >= 65535 ? 1 : nextSid_ + 1;
  seq_ = 0; bytes_ = 0;
  out_.clear();
  ptt_ = ptt;
  std::string ev = "{\"jsonrpc\":\"2.0\",\"method\":\"event.speech_start\"";
  if (!cfg_.lang.empty()) ev += ",\"params\":{\"lang\":\"" + cfg_.lang + "\"}";
  ev += "}";
  std::string ab = "{\"jsonrpc\":\"2.0\",\"method\":\"audio.begin\",\"params\":{\"direction\":\"uplink\",\"stream_id\":" + std::to_string(sid_) +
                   ",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1";
  if (!cfg_.lang.empty()) ab += ",\"lang\":\"" + cfg_.lang + "\"";
  ab += "}}";
  if (!link_.linkSendText(ev) || !link_.linkSendText(ab)) return false;
  st_ = UplinkState::Listening;
  listenStart_ = now;
  quietMs_ = 0;
  loudRun_ = 0;
  turnState_ = "listening";
  turns_++;
  // The pre-roll first, so the onset of the first word is included.
  std::vector<uint8_t> pre;
  pre.swap(pre_);
  pushAudio(pre.data(), pre.size(), now);
  return true;
}

void VoiceUplink::enterCooldown(uint32_t now) {
  st_ = UplinkState::Cooldown;
  cooldownUntil_ = now + cfg_.cooldownMs;
  quietMs_ = 0;
  loudRun_ = 0;
  pre_.clear();
}

void VoiceUplink::end(uint32_t now, bool aborted, bool announce, const char*) {
  if (st_ != UplinkState::Listening) return;
  if (announce && link_.linkReady()) {
    if (!aborted) {
      // flush the partial frame (even length), then the totals
      if (!out_.empty()) {
        size_t n = out_.size() & ~(size_t)1;
        // sendFrame may re-enter end() on failure; guard by state
        if (n) { std::vector<uint8_t> tail(out_.begin(), out_.begin() + n); out_.clear(); sendFrame(tail.data(), tail.size(), now); }
        if (st_ != UplinkState::Listening) return;
      }
      link_.linkSendText("{\"jsonrpc\":\"2.0\",\"method\":\"audio.end\",\"params\":{\"direction\":\"uplink\",\"stream_id\":" + std::to_string(sid_) +
                         ",\"total_chunks\":" + std::to_string(seq_) + ",\"total_bytes\":" + std::to_string(bytes_) + "}}");
      link_.linkSendText("{\"jsonrpc\":\"2.0\",\"method\":\"event.speech_end\"}");
    } else {
      link_.linkSendText("{\"jsonrpc\":\"2.0\",\"method\":\"audio.end\",\"params\":{\"direction\":\"uplink\",\"stream_id\":" + std::to_string(sid_) +
                         ",\"reason\":\"aborted\"}}");
    }
  }
  out_.clear();
  ptt_ = false;
  turnState_ = aborted ? "idle" : "transcribing";
  enterCooldown(now);
}

void VoiceUplink::abort(const char* why) {
  if (st_ == UplinkState::Listening) end(hasNow_ ? lastNow_ : 0, true, true, why);
  ptt_ = false;
}

void VoiceUplink::onTurnState(const std::string& state, const std::string& reason) {
  turnState_ = state;
  // The bridge ended our turn while we were still talking (too_long, timeout, rate_limited, barge-in
  // by another trigger...): stop sending, no audio.end needed.
  if (st_ == UplinkState::Listening && state != "listening") {
    out_.clear();
    ptt_ = false;
    enterCooldown(hasNow_ ? lastNow_ : 0);
    (void)reason;
  }
}

void VoiceUplink::onStreamError(uint32_t streamId, const std::string&) {
  if (st_ == UplinkState::Listening && streamId == sid_) {
    out_.clear();
    ptt_ = false;
    enterCooldown(hasNow_ ? lastNow_ : 0);
    turnState_ = "idle";
  }
}

bool VoiceUplink::pttDown(uint32_t now, bool playbackBusy) {
  hasNow_ = true; lastNow_ = now;
  if (st_ == UplinkState::Listening) { ptt_ = true; return true; }
  if (!available_ || !link_.linkReady()) return false;
  if (!micOn_) micOn_ = mic_.start();
  if (!micOn_) return false;
  if (playbackBusy && ln_) ln_->onBargeIn();   // silence our own speaker first
  if (st_ == UplinkState::Cooldown) st_ = UplinkState::Idle;
  return begin(now, true);
}

void VoiceUplink::pttUp(uint32_t now) {
  hasNow_ = true; lastNow_ = now;
  if (st_ == UplinkState::Listening && ptt_) end(now, false, true, "ptt_up");
}

void VoiceUplink::tick(uint32_t now, bool playbackBusy) {
  hasNow_ = true; lastNow_ = now;
  if (!available_ || st_ == UplinkState::Off) { micOff(); return; }
  if (!link_.linkReady()) return;
  if (!micOn_) {
    micOn_ = mic_.start();
    if (!micOn_) return;
  }
  // Pull audio.
  uint8_t buf[1024];
  for (int guard = 0; guard < 16; guard++) {
    size_t n = mic_.read(buf, sizeof buf);
    if (n == 0) break;
    n &= ~(size_t)1;
    acc_.insert(acc_.end(), buf, buf + n);
    const size_t frameLen = (size_t)cfg_.analysisFrameMs * kBytesPerMs;
    while (acc_.size() >= frameLen) {
      const uint8_t* f = acc_.data();
      uint32_t rms = rmsOf(f, frameLen);
      uint32_t thr = std::max<uint32_t>(cfg_.minRms, floor_ * cfg_.triggerRatio);
      bool loud = rms >= thr;
      switch (st_) {
        case UplinkState::Idle:
        case UplinkState::Cooldown: {
          if (!loud) floor_ = (floor_ * 31 + rms) / 32;  // follow the room's noise
          // keep the pre-roll
          pre_.insert(pre_.end(), f, f + frameLen);
          size_t cap = (size_t)cfg_.prerollMs * kBytesPerMs + (size_t)cfg_.startFrames * frameLen;
          if (pre_.size() > cap) pre_.erase(pre_.begin(), pre_.begin() + (pre_.size() - cap));
          if (st_ == UplinkState::Cooldown) {
            if ((int32_t)(now - cooldownUntil_) >= 0 && !loud) st_ = UplinkState::Idle;  // quiet again
            loudRun_ = 0;
            break;
          }
          bool deaf = playbackBusy && !cfg_.bargeInByVad;
          if (!cfg_.vad || deaf) { loudRun_ = 0; break; }
          loudRun_ = loud ? loudRun_ + 1 : 0;
          if (loudRun_ >= cfg_.startFrames) {
            if (playbackBusy && ln_) ln_->onBargeIn();
            if (!begin(now, false)) loudRun_ = 0;
          }
          break;
        }
        case UplinkState::Listening: {
          pushAudio(f, frameLen, now);
          if (st_ != UplinkState::Listening) break;
          if (!loud) floor_ = (floor_ * 31 + rms) / 32;
          if (!ptt_ && cfg_.vad) {
            quietMs_ = loud ? 0 : quietMs_ + cfg_.analysisFrameMs;
            if (quietMs_ >= cfg_.hangoverMs) end(now, false, true, "vad");
          }
          break;
        }
        case UplinkState::Off: break;
      }
      acc_.erase(acc_.begin(), acc_.begin() + frameLen);
      if (st_ == UplinkState::Off) break;
    }
  }
}

}  // namespace gc
