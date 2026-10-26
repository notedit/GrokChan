// AudioPlayer / PcmQueue
#include <unity.h>
#include "fakes.h"

using namespace gc;
using namespace gctest;

struct Rec : IAudioEvents {
  std::vector<std::pair<int, std::string>> ev;
  void onPlayback(const StreamMeta& m, PlaybackState s, const std::string&) override { ev.emplace_back(m.id, playbackStateName(s)); }
  std::string dump() const {
    std::string o;
    for (auto& e : ev) o += std::to_string(e.first) + ":" + e.second + " ";
    return o;
  }
  bool has(int id, const char* st) const {
    for (auto& e : ev) if (e.first == id && e.second == st) return true;
    return false;
  }
  int count(const char* st) const { int n = 0; for (auto& e : ev) if (e.second == st) n++; return n; }
};

struct AudioRig {
  std::vector<uint8_t> store;
  PcmQueue q;
  FakeSink sink;
  AudioPlayer p;
  Rec rec;
  uint32_t t = 0;
  AudioRig(size_t cap = 64 * 1024) : store(cap), q(store.data(), cap), p(q, sink) { p.setEvents(&rec); }
  void tick(uint32_t ms = 10) { t += ms; p.tick(t); }
  bool begin(int id, uint32_t chunk = 4096, uint32_t rate = 16000) { std::string e; return p.begin(id, "pcm_s16le", rate, 1, chunk, t, e); }
  bool frame(int id, uint32_t seq, size_t n, bool last = false, uint8_t fill = 0x11) {
    std::string e;
    std::vector<uint8_t> d(n, fill);
    return p.frame(id, seq, last, d.data(), n, t, e);
  }
  bool end(int id, uint32_t chunks, uint32_t bytes, bool complete = true) { std::string e; return p.end(id, chunks, bytes, complete, t, e); }
  void drain() { for (int i = 0; i < 200; i++) { sink.finishAll(); tick(); } }
};

static void test_queue_wrap() {
  std::vector<uint8_t> st(10);
  PcmQueue q(st.data(), st.size());
  uint8_t a[8] = {1, 2, 3, 4, 5, 6, 7, 8}, o[8];
  TEST_ASSERT_TRUE(q.push(a, 8));
  TEST_ASSERT_EQUAL(8, q.pop(o, 6) + 2);  // 6 read
  TEST_ASSERT_TRUE(q.push(a, 6));          // wraps
  TEST_ASSERT_FALSE(q.push(a, 8));         // does not fit, nothing written
  size_t n = q.pop(o, 8);
  uint8_t exp[] = {7, 8, 1, 2, 3, 4, 5, 6};
  size_t tot = n;
  uint8_t all[16];
  memcpy(all, o, n);
  while (q.used()) { size_t m = q.pop(all + tot, 8); tot += m; }
  TEST_ASSERT_EQUAL(8, tot);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(exp, all, 8);
}

static void test_full_stream_flow() {
  AudioRig r;
  TEST_ASSERT_EQUAL(0, r.p.accept(StreamMeta{1}, false, r.t));
  TEST_ASSERT_TRUE(r.begin(1));
  // 2 frames = 256 ms < 300 ms prebuffer: nothing plays yet
  r.frame(1, 0, 4096); r.frame(1, 1, 4096);
  r.tick();
  TEST_ASSERT_EQUAL(0, r.sink.queued.size());
  TEST_ASSERT_EQUAL_STRING("", r.rec.dump().c_str());
  r.frame(1, 2, 4096, false);  // 384 ms
  r.tick();
  TEST_ASSERT_TRUE(r.rec.has(1, "started"));
  TEST_ASSERT_TRUE(r.sink.queued.size() > 0);
  r.frame(1, 3, 1000, true, 0x22);
  TEST_ASSERT_TRUE(r.end(1, 4, 4096 * 3 + 1000));
  r.drain();
  TEST_ASSERT_EQUAL(4096 * 3 + 1000, r.sink.played.size());
  TEST_ASSERT_EQUAL_UINT8(0x11, r.sink.played[0]);
  TEST_ASSERT_EQUAL_UINT8(0x22, r.sink.played.back());
  TEST_ASSERT_TRUE(r.rec.has(1, "ended"));
  TEST_ASSERT_EQUAL(1, r.rec.count("started"));
  TEST_ASSERT_EQUAL(1, r.rec.count("ended"));
  TEST_ASSERT_FALSE(r.p.busy());
  TEST_ASSERT_EQUAL(16000, r.sink.rate);
}

static void test_short_stream_plays_without_prebuffer() {
  AudioRig r;
  r.p.accept(StreamMeta{5}, false, r.t);
  r.begin(5);
  r.frame(5, 0, 2000, true);
  r.end(5, 1, 2000);
  r.tick();
  r.drain();
  TEST_ASSERT_EQUAL(2000, r.sink.played.size());
  TEST_ASSERT_EQUAL(1, r.rec.count("ended"));
}

static void test_queue_order_and_limit() {
  AudioRig r;
  TEST_ASSERT_EQUAL(0, r.p.accept(StreamMeta{1}, false, r.t));
  TEST_ASSERT_EQUAL(1, r.p.accept(StreamMeta{2}, false, r.t));
  TEST_ASSERT_EQUAL(2, r.p.accept(StreamMeta{3}, false, r.t));
  TEST_ASSERT_EQUAL(3, r.p.accept(StreamMeta{4}, false, r.t));
  TEST_ASSERT_EQUAL(-1, r.p.accept(StreamMeta{5}, false, r.t));  // maxPendingStreams = 4
  TEST_ASSERT_EQUAL(4, r.p.liveCount());
  TEST_ASSERT_EQUAL(1, r.p.currentStream());
  // stream 2 arrives early; it must only play after stream 1
  // the bridge sends one stream at a time (it waits for audio.end before the next device.speak)
  r.begin(1); r.frame(1, 0, 1000, true, 0x33); r.end(1, 1, 1000);
  r.begin(2); r.frame(2, 0, 3000, true); r.end(2, 1, 3000);
  r.tick();
  r.drain();
  TEST_ASSERT_EQUAL(4000, r.sink.played.size());
  TEST_ASSERT_EQUAL_UINT8(0x33, r.sink.played[0]);
  TEST_ASSERT_EQUAL_UINT8(0x11, r.sink.played[1000]);
  TEST_ASSERT_TRUE(r.rec.dump().find("1:ended") < r.rec.dump().find("2:started"));
}

static void test_seq_gap_is_error() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  TEST_ASSERT_TRUE(r.frame(1, 0, 1024));
  TEST_ASSERT_FALSE(r.frame(1, 2, 1024));  // seq 1 missing
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
  TEST_ASSERT_EQUAL(1, r.rec.count("error"));
  r.drain();
  TEST_ASSERT_EQUAL(0, r.sink.played.size());
  TEST_ASSERT_FALSE(r.p.busy());
}

static void test_odd_frame_size_is_error() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  TEST_ASSERT_FALSE(r.frame(1, 0, 1023));  // not a whole number of s16 samples
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
}

static void test_oversize_frame_is_error() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  TEST_ASSERT_FALSE(r.frame(1, 0, 4098));  // > max_chunk_bytes
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
}

static void test_ring_overflow_is_error() {
  AudioRig r(8192);
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  bool ok = true;
  for (int i = 0; i < 4 && ok; i++) ok = r.frame(1, i, 4096);
  TEST_ASSERT_FALSE(ok);
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
}

static void test_bad_begin_params() {
  AudioRig r;
  std::string e;
  r.p.accept(StreamMeta{1}, false, r.t);
  TEST_ASSERT_FALSE(r.p.begin(1, "mp3", 16000, 1, 4096, r.t, e));
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
  r.rec.ev.clear();
  r.p.accept(StreamMeta{2}, false, r.t);
  TEST_ASSERT_FALSE(r.p.begin(2, "pcm_s16le", 16000, 2, 4096, r.t, e));  // stereo unsupported
  TEST_ASSERT_TRUE(r.rec.has(2, "error"));
  r.rec.ev.clear();
  r.p.accept(StreamMeta{3}, false, r.t);
  TEST_ASSERT_FALSE(r.p.begin(3, "pcm_s16le", 100, 1, 4096, r.t, e));    // rate out of range
  TEST_ASSERT_TRUE(r.rec.has(3, "error"));
}

static void test_begin_without_accept_is_ignored() {
  AudioRig r;
  TEST_ASSERT_FALSE(r.begin(9));
  TEST_ASSERT_TRUE(r.rec.has(9, "error"));  // reported, nothing queued
  TEST_ASSERT_EQUAL(0, r.p.liveCount());
}

static void test_aborted_end() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  r.frame(1, 0, 4096); r.frame(1, 1, 4096); r.frame(1, 2, 4096);
  r.tick();
  TEST_ASSERT_TRUE(r.rec.has(1, "started"));
  r.end(1, 3, 12288, false);
  r.tick();
  TEST_ASSERT_TRUE(r.rec.has(1, "interrupted"));
  TEST_ASSERT_FALSE(r.rec.has(1, "ended"));
  TEST_ASSERT_EQUAL(0, r.sink.queued.size());
}

static void test_end_mismatch_is_error() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  r.frame(1, 0, 2000, true);
  TEST_ASSERT_FALSE(r.end(1, 2, 2000));  // says 2 chunks, got 1
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
}

static void test_stop_current_vs_queue() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.p.accept(StreamMeta{2}, false, r.t);
  r.p.accept(StreamMeta{3}, false, r.t);
  r.begin(1); r.frame(1, 0, 4096); r.frame(1, 1, 4096); r.frame(1, 2, 4096);
  r.tick();
  int cleared = 0;
  auto st = r.p.stop(0, false, cleared);  // current only
  TEST_ASSERT_EQUAL(1, st.size());
  TEST_ASSERT_EQUAL(1, st[0]);
  TEST_ASSERT_EQUAL(0, cleared);
  TEST_ASSERT_TRUE(r.rec.has(1, "interrupted"));
  TEST_ASSERT_EQUAL(2, r.p.currentStream());
  cleared = 0;
  st = r.p.stop(0, true, cleared);  // current + queue
  TEST_ASSERT_EQUAL(1, cleared);
  TEST_ASSERT_FALSE(r.p.busy());
}

static void test_stop_specific_stream() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.p.accept(StreamMeta{2}, false, r.t);
  int cleared = 0;
  auto st = r.p.stop(2, true, cleared);
  TEST_ASSERT_EQUAL(1, st.size());
  TEST_ASSERT_EQUAL(2, st[0]);
  TEST_ASSERT_TRUE(r.p.has(1));
  TEST_ASSERT_FALSE(r.p.has(2));
}

static void test_late_frames_after_stop_are_swallowed() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  r.frame(1, 0, 4096);
  int c = 0;
  r.p.stop(1, true, c);
  TEST_ASSERT_TRUE(r.frame(1, 1, 4096));  // no error for frames of a stopped stream
  TEST_ASSERT_TRUE(r.end(1, 2, 8192, false));
  r.drain();
  TEST_ASSERT_EQUAL(0, r.sink.played.size());
  TEST_ASSERT_EQUAL(0, r.rec.count("error"));
  TEST_ASSERT_EQUAL(0, r.q.used());
}

static void test_interrupt_replaces() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1); r.frame(1, 0, 4096); r.frame(1, 1, 4096); r.frame(1, 2, 4096);
  r.tick();
  TEST_ASSERT_EQUAL(0, r.p.accept(StreamMeta{2}, true, r.t));
  TEST_ASSERT_TRUE(r.rec.has(1, "interrupted"));
  TEST_ASSERT_EQUAL(2, r.p.currentStream());
  r.begin(2); r.frame(2, 0, 2000, true, 0x44); r.end(2, 1, 2000);
  r.tick(); r.drain();
  TEST_ASSERT_TRUE(r.rec.has(2, "ended"));
  TEST_ASSERT_EQUAL_UINT8(0x44, r.sink.played.back());
}

static void test_begin_timeout() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.tick(16000);
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
  TEST_ASSERT_FALSE(r.p.busy());
}

static void test_frame_stall_timeout() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  r.frame(1, 0, 4096);
  r.tick(11000);
  TEST_ASSERT_TRUE(r.rec.has(1, "error"));
}

static void test_stop_all_reports() {
  AudioRig r;
  TEST_ASSERT_FALSE(r.p.stopAll());
  r.p.accept(StreamMeta{1}, false, r.t);
  TEST_ASSERT_TRUE(r.p.stopAll());
  TEST_ASSERT_FALSE(r.p.busy());
}

static void test_underrun_counted_once() {
  AudioRig r;
  r.p.accept(StreamMeta{1}, false, r.t);
  r.begin(1);
  r.frame(1, 0, 4096); r.frame(1, 1, 4096); r.frame(1, 2, 4096);
  r.tick();
  r.sink.finishAll(); r.tick();
  r.sink.finishAll();
  for (int i = 0; i < 50; i++) r.tick();  // starving, stream not finished
  TEST_ASSERT_EQUAL(1, r.p.underruns());
}

void run_audio_tests() {
  RUN_TEST(test_queue_wrap);
  RUN_TEST(test_full_stream_flow);
  RUN_TEST(test_short_stream_plays_without_prebuffer);
  RUN_TEST(test_queue_order_and_limit);
  RUN_TEST(test_seq_gap_is_error);
  RUN_TEST(test_odd_frame_size_is_error);
  RUN_TEST(test_oversize_frame_is_error);
  RUN_TEST(test_ring_overflow_is_error);
  RUN_TEST(test_bad_begin_params);
  RUN_TEST(test_begin_without_accept_is_ignored);
  RUN_TEST(test_aborted_end);
  RUN_TEST(test_end_mismatch_is_error);
  RUN_TEST(test_stop_current_vs_queue);
  RUN_TEST(test_stop_specific_stream);
  RUN_TEST(test_late_frames_after_stop_are_swallowed);
  RUN_TEST(test_interrupt_replaces);
  RUN_TEST(test_begin_timeout);
  RUN_TEST(test_frame_stall_timeout);
  RUN_TEST(test_stop_all_reports);
  RUN_TEST(test_underrun_counted_once);
}
