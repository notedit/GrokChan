#include "gc_audio.h"
#include <algorithm>

namespace gc {

const char* playbackStateName(PlaybackState s) {
  switch (s) {
    case PlaybackState::Started: return "started";
    case PlaybackState::Ended: return "ended";
    case PlaybackState::Interrupted: return "interrupted";
    case PlaybackState::Error: return "error";
  }
  return "error";
}

// ---------------------------------------------------------------- PcmQueue
void PcmQueue::reset() { rd_ = 0; used_ = 0; }

bool PcmQueue::push(const uint8_t* data, size_t len) {
  if (len > cap_ - used_) return false;
  size_t wr = (rd_ + used_) % cap_;
  size_t first = std::min(len, cap_ - wr);
  if (first) std::copy(data, data + first, buf_ + wr);
  if (len > first) std::copy(data + first, data + len, buf_);
  used_ += len;
  return true;
}

size_t PcmQueue::pop(uint8_t* dst, size_t max) {
  size_t n = std::min(max, used_);
  size_t first = std::min(n, cap_ - rd_);
  if (first) std::copy(buf_ + rd_, buf_ + rd_ + first, dst);
  if (n > first) std::copy(buf_, buf_ + (n - first), dst + first);
  rd_ = (rd_ + n) % cap_;
  used_ -= n;
  return n;
}

void PcmQueue::skip(size_t n) {
  n = std::min(n, used_);
  rd_ = (rd_ + n) % cap_;
  used_ -= n;
  if (used_ == 0) rd_ = 0;
}

// ---------------------------------------------------------------- AudioPlayer
AudioPlayer::Stream* AudioPlayer::find(uint16_t id) {
  for (auto& s : streams_) if (s.meta.id == id) return &s;
  return nullptr;
}

AudioPlayer::Stream* AudioPlayer::front() {
  for (auto& s : streams_) if (!s.dropped) return &s;
  return nullptr;
}

bool AudioPlayer::has(uint16_t id) const {
  for (const auto& s : streams_) if (!s.dropped && s.meta.id == id) return true;
  return false;
}

size_t AudioPlayer::liveCount() const {
  size_t n = 0;
  for (const auto& s : streams_) if (!s.dropped) n++;
  return n;
}

uint16_t AudioPlayer::currentStream() const {
  for (const auto& s : streams_) if (!s.dropped) return s.meta.id;
  return 0;
}

size_t AudioPlayer::inflightFor(uint16_t id) const {
  size_t n = 0;
  for (auto v : inflight_) if (v == id) n++;
  return n;
}

void AudioPlayer::reap() {
  // Ghosts at the head own ring bytes that must be skipped before anyone else can read.
  while (!streams_.empty() && streams_.front().dropped) {
    q_.skip(streams_.front().buffered);
    streams_.erase(streams_.begin());
  }
  // Ghosts further back with nothing in the ring can go right away.
  for (size_t i = 0; i < streams_.size();) {
    if (streams_[i].dropped && streams_[i].buffered == 0) streams_.erase(streams_.begin() + i);
    else i++;
  }
  if (streams_.empty()) q_.reset();
}

void AudioPlayer::kill(Stream& s, PlaybackState st, const std::string& msg) {
  if (s.dropped) return;
  StreamMeta meta = s.meta;
  bool wasCurrent = (front() == &s);
  s.dropped = true;
  if (wasCurrent && (!inflight_.empty())) {
    sink_.stop();
    inflight_.clear();
  }
  // Bytes already handed to the ring stay as a ghost until skipped.
  reap();  // may erase `s`
  emit(meta, st, msg);
}

int AudioPlayer::accept(const StreamMeta& meta, bool interrupt, uint32_t now) {
  if (interrupt) stopAll();
  if (liveCount() >= cfg_.maxPendingStreams) return -1;
  int pos = (int)liveCount();
  Stream s;
  s.meta = meta;
  s.acceptedAt = now;
  s.lastActivity = now;
  streams_.push_back(std::move(s));
  return pos;
}

bool AudioPlayer::begin(uint16_t id, const std::string& format, uint32_t rate, uint32_t channels, uint32_t chunkBytes, uint32_t now, std::string& err) {
  Stream* s = find(id);
  if (!s || s->dropped) {
    err = "audio.begin for unknown stream " + std::to_string(id);
    StreamMeta m; m.id = id;
    emit(m, PlaybackState::Error, err);
    return false;
  }
  if (s->phase != Phase::Accepted) {
    err = "duplicate audio.begin";
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  if (format != "pcm_s16le") err = "unsupported audio format: " + format;
  else if (rate < cfg_.sampleRateMin || rate > cfg_.sampleRateMax) err = "unsupported sample_rate " + std::to_string(rate);
  else if (channels < 1 || channels > 2) err = "unsupported channels " + std::to_string(channels);
  else if (chunkBytes == 0 || chunkBytes > cfg_.maxChunkBytes) err = "chunk_bytes out of range " + std::to_string(chunkBytes);
  if (!err.empty()) {
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  // Only one stream can be receiving at a time: a new begin supersedes a stalled one.
  std::vector<uint16_t> stale;
  for (auto& o : streams_) {
    if (o.meta.id != id && !o.dropped && o.phase == Phase::Receiving) stale.push_back(o.meta.id);
  }
  for (uint16_t sid : stale) {
    Stream* o = find(sid);
    if (o) kill(*o, PlaybackState::Error, "superseded by a new audio.begin");
  }
  s = find(id);  // kill() may have moved the vector
  if (!s) { err = "stream vanished"; return false; }
  s->phase = Phase::Receiving;
  s->rate = rate;
  s->channels = (uint8_t)channels;
  s->nextSeq = 0;
  s->lastActivity = now;
  return true;
}

bool AudioPlayer::frame(uint16_t id, uint32_t seq, bool last, const uint8_t* payload, size_t len, uint32_t now, std::string& err) {
  Stream* s = find(id);
  if (!s || s->dropped) { droppedFrames_++; return true; }  // stale frame after stop/abort: ignore silently
  if (s->phase != Phase::Receiving) {
    err = "frame outside audio.begin/end";
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  if (seq != s->nextSeq) {
    err = "frame seq " + std::to_string(seq) + " expected " + std::to_string(s->nextSeq);
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  size_t frameSize = 2u * s->channels;
  if (len > cfg_.maxChunkBytes || (len % frameSize) != 0) {
    err = "bad frame payload size " + std::to_string(len);
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  if (len && !q_.push(payload, len)) {
    err = "audio ring overflow";
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  s->buffered += len;
  s->nextSeq++;
  s->gotChunks++;
  s->gotBytes += (uint32_t)len;
  s->lastActivity = now;
  if (last) s->phase = Phase::Received;
  return true;
}

bool AudioPlayer::end(uint16_t id, uint32_t totalChunks, uint32_t totalBytes, bool complete, uint32_t now, std::string& err) {
  Stream* s = find(id);
  if (!s || s->dropped) return true;  // already stopped locally
  if (!complete) {
    kill(*s, PlaybackState::Interrupted, "aborted by bridge");
    return true;
  }
  if (s->phase == Phase::Accepted) {
    err = "audio.end without audio.begin";
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  if (s->gotChunks != totalChunks || s->gotBytes != totalBytes) {
    err = "audio.end mismatch: got " + std::to_string(s->gotChunks) + " chunks/" + std::to_string(s->gotBytes) + " bytes, expected " +
          std::to_string(totalChunks) + "/" + std::to_string(totalBytes);
    kill(*s, PlaybackState::Error, err);
    return false;
  }
  s->phase = Phase::Received;
  s->lastActivity = now;
  return true;
}

std::vector<uint16_t> AudioPlayer::stop(uint16_t streamId, bool clearQueue, int& cleared) {
  std::vector<uint16_t> stopped;
  cleared = 0;
  if (streamId) {
    Stream* s = find(streamId);
    if (s && !s->dropped) {
      stopped.push_back(streamId);
      kill(*s, PlaybackState::Interrupted, "stopped");
    }
    return stopped;
  }
  Stream* cur = front();
  if (cur) {
    uint16_t id = cur->meta.id;
    stopped.push_back(id);
    kill(*cur, PlaybackState::Interrupted, "stopped");
  }
  if (clearQueue) {
    for (;;) {
      Stream* n = front();
      if (!n) break;
      stopped.push_back(n->meta.id);
      cleared++;
      kill(*n, PlaybackState::Interrupted, "queue cleared");
    }
  }
  return stopped;
}

bool AudioPlayer::stopAll() {
  bool any = false;
  for (;;) {
    Stream* n = front();
    if (!n) break;
    any = true;
    kill(*n, PlaybackState::Interrupted, "stopped");
  }
  if (!inflight_.empty() || sink_.pending() > 0) { sink_.stop(); inflight_.clear(); any = true; }
  return any;
}

void AudioPlayer::failStream(uint16_t id, const std::string& msg) {
  Stream* s = find(id);
  if (s && !s->dropped) kill(*s, PlaybackState::Error, msg);
  else { StreamMeta m; m.id = id; emit(m, PlaybackState::Error, msg); }
}

void AudioPlayer::tick(uint32_t now) {
  // Time-outs for streams that were accepted but never delivered.
  for (size_t i = 0; i < streams_.size(); i++) {
    Stream& s = streams_[i];
    if (s.dropped) continue;
    if (s.phase == Phase::Accepted && (uint32_t)(now - s.acceptedAt) > cfg_.beginTimeoutMs) {
      kill(s, PlaybackState::Error, "audio.begin timeout");
      i = (size_t)-1;  // restart scan, vector changed
    } else if (s.phase == Phase::Receiving && (uint32_t)(now - s.lastActivity) > cfg_.frameTimeoutMs) {
      kill(s, PlaybackState::Error, "audio frame timeout");
      i = (size_t)-1;
    }
  }
  pump(now);
}

void AudioPlayer::pump(uint32_t now) {
  (void)now;
  reap();
  size_t pend = sink_.pending();
  while (inflight_.size() > pend) inflight_.pop_front();

  for (int guard = 0; guard < 8; guard++) {
    Stream* s = front();
    if (!s) return;
    size_t frameSize = 2u * s->channels;

    // Hand data to the sink.
    size_t prebuffer = (size_t)((uint64_t)s->rate * frameSize * cfg_.prebufferMs / 1000);
    while (s->buffered >= frameSize && sink_.canSubmit()) {
      if (!s->submitted && s->phase != Phase::Received && s->buffered < prebuffer) break;
      size_t n = std::min(cfg_.submitBytes, s->buffered);
      n -= n % frameSize;
      if (scratch_.size() < n) scratch_.resize(n);
      size_t got = q_.pop(scratch_.data(), n);
      s->buffered -= got;
      if (!sink_.submit(scratch_.data(), got, s->rate, s->channels)) {
        kill(*s, PlaybackState::Error, "audio sink rejected data");
        s = nullptr;
        break;
      }
      s->submitted = true;
      inflight_.push_back(s->meta.id);
    }
    if (!s) continue;  // killed, look at the next stream

    // Odd leftovers (should not happen) are dropped once the stream is complete.
    if (s->phase == Phase::Received && s->buffered > 0 && s->buffered < frameSize) {
      q_.skip(s->buffered);
      s->buffered = 0;
    }

    size_t mine = inflightFor(s->meta.id);
    if (!s->started && (mine > 0 || (s->phase == Phase::Received && s->buffered == 0))) {
      s->started = true;
      emit(s->meta, PlaybackState::Started, "");
      s = front();
      if (!s) return;
      mine = inflightFor(s->meta.id);
    }

    if (s->phase == Phase::Received && s->buffered == 0 && mine == 0) {
      StreamMeta meta = s->meta;
      streams_.erase(streams_.begin() + (s - streams_.data()));
      reap();
      emit(meta, PlaybackState::Ended, "");
      continue;  // next stream may start now
    }
    bool starving = s->started && mine == 0 && s->buffered == 0 && s->phase == Phase::Receiving;
    if (starving && !s->underrun) underruns_++;
    s->underrun = starving;
    return;
  }
}

}  // namespace gc
