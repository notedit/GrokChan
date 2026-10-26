// Downlink audio: stream bookkeeping (speak queue), binary frame validation, a byte ring with
// per-stream segments, and the pump that feeds an IPcmSink and reports playback.state events.
// Pure logic, no hardware: testable on the host.
#pragma once
#include <cstdint>
#include <deque>
#include <string>
#include <vector>
#include "gc_hal.h"

namespace gc {

enum class PlaybackState { Started, Ended, Interrupted, Error };
const char* playbackStateName(PlaybackState s);

struct StreamMeta {
  uint16_t id = 0;
  std::string expression;  // from device.speak, may be empty
  int volume = -1;         // one-off volume (already capped), -1 = unchanged
};

class IAudioEvents {
 public:
  virtual ~IAudioEvents() = default;
  virtual void onPlayback(const StreamMeta& meta, PlaybackState st, const std::string& message) = 0;
};

// Byte ring with FIFO segments (one per stream). Storage is supplied by the caller (PSRAM on
// the device, a std::vector on the host).
class PcmQueue {
 public:
  PcmQueue(uint8_t* storage, size_t capacity) : buf_(storage), cap_(capacity) {}
  void reset();
  size_t capacity() const { return cap_; }
  size_t used() const { return used_; }
  size_t freeBytes() const { return cap_ - used_; }
  // Append bytes to the ring. Returns false (and writes nothing) when they do not fit.
  bool push(const uint8_t* data, size_t len);
  // Read up to max bytes (does not cross `limit`, the unread bytes of the head segment).
  size_t pop(uint8_t* dst, size_t max);
  // Discard n bytes from the head.
  void skip(size_t n);

 private:
  uint8_t* buf_;
  size_t cap_;
  size_t rd_ = 0, used_ = 0;
};

struct AudioPlayerConfig {
  uint32_t prebufferMs = 300;      // wait for this much audio before starting a stream (unless it already ended)
  size_t submitBytes = 4096;       // size of one chunk handed to the sink
  size_t maxPendingStreams = 4;    // active + queued
  uint32_t beginTimeoutMs = 15000; // speak accepted but audio.begin never came
  uint32_t frameTimeoutMs = 10000; // receiving stream stalled
  size_t maxChunkBytes = 4096;     // hello.audio.max_chunk_bytes
  uint32_t sampleRateMin = 8000, sampleRateMax = 48000;
};

class AudioPlayer {
 public:
  AudioPlayer(PcmQueue& queue, IPcmSink& sink, const AudioPlayerConfig& cfg = AudioPlayerConfig())
      : q_(queue), sink_(sink), cfg_(cfg) {}
  // DeviceClient registers itself here; tests register a recorder.
  void setEvents(IAudioEvents* e) { ev_ = e; }

  // device.speak accepted. Returns queue_position (0 = plays next/now), or -1 if the queue is full.
  // interrupt=true stops everything first (interrupted events are emitted for stopped streams).
  int accept(const StreamMeta& meta, bool interrupt, uint32_t now);

  // audio.begin. On failure returns false with err set (and emits playback.state error).
  bool begin(uint16_t id, const std::string& format, uint32_t rate, uint32_t channels, uint32_t chunkBytes, uint32_t now, std::string& err);
  // One binary frame payload for stream `id` (header already parsed). False on stream error.
  bool frame(uint16_t id, uint32_t seq, bool last, const uint8_t* payload, size_t len, uint32_t now, std::string& err);
  // audio.end.
  bool end(uint16_t id, uint32_t totalChunks, uint32_t totalBytes, bool complete, uint32_t now, std::string& err);

  // stop_audio. streamId==0 -> the current stream (front), plus the whole queue if clearQueue.
  // Returns stopped stream ids; `cleared` = number of queued (not current) streams dropped.
  std::vector<uint16_t> stop(uint16_t streamId, bool clearQueue, int& cleared);
  // emergency_stop: everything, returns true if something was playing or queued.
  bool stopAll();

  // Abort a stream with an `error` playback event (bad audio.begin params etc.).
  void failStream(uint16_t id, const std::string& msg);

  void tick(uint32_t now);

  bool has(uint16_t id) const;                 // live (not dropped) stream with this id
  size_t liveCount() const;                    // active + queued
  bool busy() const { return liveCount() > 0; }
  uint16_t currentStream() const;              // 0 if none
  bool playing() const { return !inflight_.empty(); }
  uint32_t underruns() const { return underruns_; }
  uint32_t droppedFrames() const { return droppedFrames_; }

 private:
  enum class Phase { Accepted, Receiving, Received };
  struct Stream {
    StreamMeta meta;
    Phase phase = Phase::Accepted;
    bool dropped = false;      // stopped/failed: swallow remaining frames, no output
    bool started = false;      // `started` event emitted
    bool submitted = false;    // first chunk handed to the sink
    bool underrun = false;     // currently starving (edge counter)
    uint32_t rate = 16000;
    uint8_t channels = 1;
    uint32_t nextSeq = 0, gotChunks = 0, gotBytes = 0;
    size_t buffered = 0;       // bytes in the ring not yet handed to the sink
    uint32_t lastActivity = 0;
    uint32_t acceptedAt = 0;
  };

  Stream* find(uint16_t id);
  void fail(Stream& s, const std::string& msg);  // emits error, drops stream data
  void kill(Stream& s, PlaybackState st, const std::string& msg);  // emit event, stop output, make ghost
  void reap();                                   // erase dropped streams that no longer own ring bytes
  Stream* front();
  void pump(uint32_t now);
  size_t inflightFor(uint16_t id) const;

  PcmQueue& q_;
  IPcmSink& sink_;
  IAudioEvents* ev_ = nullptr;
  void emit(const StreamMeta& m, PlaybackState st, const std::string& msg) { if (ev_) ev_->onPlayback(m, st, msg); }
  AudioPlayerConfig cfg_;
  std::vector<Stream> streams_;  // front = current
  std::deque<uint16_t> inflight_;  // stream id per chunk handed to the sink, oldest first
  std::vector<uint8_t> scratch_;
  uint32_t underruns_ = 0, droppedFrames_ = 0;
};

}  // namespace gc
