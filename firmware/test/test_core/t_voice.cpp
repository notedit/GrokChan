// Voice uplink (gc_voice) wired into DeviceClient: VAD / PTT turn start+end, uplink frames,
// utterance limits, barge-in, interruption and reconnect. Host fakes only; the real mic is 待实机确认.
#include <unity.h>
#include "fakes.h"

using namespace gc;
using namespace gctest;

namespace {
struct FakeMic : IMic {
  std::vector<uint8_t> buf;
  bool on = false, refuse = false;
  int starts = 0, stops = 0;
  bool start() override { if (refuse) return false; on = true; starts++; return true; }
  void stop() override { on = false; stops++; }
  size_t read(uint8_t* dst, size_t max) override {
    size_t n = std::min(max, buf.size()) & ~(size_t)1;
    std::copy(buf.begin(), buf.begin() + n, dst);
    buf.erase(buf.begin(), buf.begin() + n);
    return n;
  }
  // `ms` of a square wave with the given amplitude (0 = silence)
  void feed(uint32_t ms, int16_t amp) {
    size_t samples = (size_t)ms * 16;
    for (size_t i = 0; i < samples; i++) {
      int16_t s = amp == 0 ? 0 : ((i / 8) % 2 ? amp : (int16_t)-amp);
      buf.push_back((uint8_t)(s & 0xff));
      buf.push_back((uint8_t)((s >> 8) & 0xff));
    }
  }
};

struct VRig : Rig {
  FakeMic mic;
  VoiceUplink* voice = nullptr;
  VoiceConfig vc;
  bool helloVoice = true;
  uint32_t maxBytes = 480000;
  VRig() { vc.maxBytes = 480000; }
  ~VRig() { delete voice; }
  void boot(bool withVoice = true, uint32_t maxB = 480000, const VoiceConfig* custom = nullptr) {
    if (custom) vc = *custom;
    voice = new VoiceUplink(mic, *client, vc);
    client->setVoice(voice);
    helloVoice = withVoice;
    maxBytes = maxB;
    client->begin(); client->tick(); tr.open();
    std::string h = "{\"jsonrpc\":\"2.0\",\"id\":\"d_1\",\"result\":{\"session_id\":\"s_1\",\"server_time\":1,\"heartbeat_s\":20,"
                    "\"audio\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096}";
    if (withVoice) h += ",\"voice\":{\"uplink\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"max_ms\":15000,\"max_bytes\":" + std::to_string(maxB) + ",\"idle_timeout_ms\":3000}}";
    h += "}}";
    tr.recv(h);
    tr.texts.clear(); tr.bins.clear(); pingScan = 0;
  }
  void say(uint32_t ms, int16_t amp = 6000) { mic.feed(ms, amp); advance(ms, 20); }
  std::vector<std::string> methods() {
    std::vector<std::string> m;
    for (auto& s : tr.texts) {
      JsonDocument d;
      if (!deserializeJson(d, s) && d["method"].is<const char*>()) m.push_back(d["method"].as<const char*>());
    }
    return m;
  }
  JsonDocument note(const char* method, size_t nth = 0) {
    auto v = notes(method);
    if (nth < v.size()) return std::move(v[nth]);
    return JsonDocument();
  }
};

bool has(const std::vector<std::string>& m, const char* x) { return std::find(m.begin(), m.end(), x) != m.end(); }
size_t count(const std::vector<std::string>& m, const char* x) { return (size_t)std::count(m.begin(), m.end(), x); }
}  // namespace

static void test_no_voice_in_hello_stays_off() {
  VRig r; r.boot(false);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Off);
  r.say(500);
  TEST_ASSERT_EQUAL(0, r.mic.starts);
  TEST_ASSERT_EQUAL(0, r.tr.bins.size());
}

static void test_silence_sends_nothing() {
  VRig r; r.boot();
  r.say(1500, 0);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Idle);
  TEST_ASSERT_TRUE(r.mic.on);
  TEST_ASSERT_EQUAL(0, r.tr.bins.size());
  TEST_ASSERT_FALSE(has(r.methods(), "event.speech_start"));
}

static void test_vad_full_utterance() {
  VRig r; r.boot();
  r.say(600, 0);                                  // quiet room
  r.say(1000, 6000);                              // speech
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  r.say(900, 0);                                  // > hangover
  auto m = r.methods();
  TEST_ASSERT_EQUAL(1, count(m, "event.speech_start"));
  TEST_ASSERT_EQUAL(1, count(m, "audio.begin"));
  TEST_ASSERT_EQUAL(1, count(m, "audio.end"));
  TEST_ASSERT_EQUAL(1, count(m, "event.speech_end"));
  // order: speech_start, audio.begin ... audio.end, speech_end
  size_t iStart = std::find(m.begin(), m.end(), "event.speech_start") - m.begin();
  size_t iBegin = std::find(m.begin(), m.end(), "audio.begin") - m.begin();
  size_t iEnd = std::find(m.begin(), m.end(), "audio.end") - m.begin();
  size_t iSe = std::find(m.begin(), m.end(), "event.speech_end") - m.begin();
  TEST_ASSERT_TRUE(iStart < iBegin && iBegin < iEnd && iEnd < iSe);
  auto ab = r.note("audio.begin");
  TEST_ASSERT_EQUAL_STRING("uplink", ab["params"]["direction"]);
  TEST_ASSERT_EQUAL_STRING("pcm_s16le", ab["params"]["format"]);
  TEST_ASSERT_EQUAL(16000, ab["params"]["sample_rate"].as<int>());
  TEST_ASSERT_EQUAL(1, ab["params"]["channels"].as<int>());
  uint16_t sid = ab["params"]["stream_id"].as<int>();
  // frames: type 0x02, this stream, contiguous seq, even payload, <= frameBytes
  size_t total = 0;
  for (size_t i = 0; i < r.tr.bins.size(); i++) {
    FrameHeader h;
    TEST_ASSERT_TRUE(decodeFrameHeader(r.tr.bins[i].data(), r.tr.bins[i].size(), h));
    TEST_ASSERT_EQUAL(kFrameUplinkAudio, h.type);
    TEST_ASSERT_EQUAL(sid, h.stream);
    TEST_ASSERT_EQUAL(i, h.seq);
    size_t pl = r.tr.bins[i].size() - kFrameHeaderBytes;
    TEST_ASSERT_TRUE(pl > 0 && pl % 2 == 0 && pl <= 1280);
    total += pl;
  }
  auto ae = r.note("audio.end");
  TEST_ASSERT_EQUAL(sid, ae["params"]["stream_id"].as<int>());
  TEST_ASSERT_EQUAL((int)r.tr.bins.size(), ae["params"]["total_chunks"].as<int>());
  TEST_ASSERT_EQUAL((int)total, ae["params"]["total_bytes"].as<int>());
  // includes the pre-roll: more than just the loud part after the 100 ms trigger delay
  TEST_ASSERT_TRUE(total >= (size_t)(1000 + 700 - 200) * 32);
  // bridge reports transcribing, then idle -> the device is re-armed after the cooldown
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"transcribing\"}}");
  TEST_ASSERT_EQUAL_STRING("transcribing", r.voice->turnState().c_str());
  r.say(800, 0);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Idle);
  // a second utterance gets a new stream id
  r.say(500, 6000);
  auto ab2 = r.note("audio.begin", 1);
  TEST_ASSERT_FALSE(ab2.isNull());
  TEST_ASSERT_TRUE(ab2["params"]["stream_id"].as<int>() != sid);
  TEST_ASSERT_EQUAL(2, r.voice->turns());
}

static void test_short_blip_does_not_trigger() {
  VRig r; r.boot();
  r.say(600, 0);
  r.say(60, 6000);   // < startFrames (100 ms): a click, not speech
  r.say(600, 0);
  TEST_ASSERT_EQUAL(0, r.tr.bins.size());
  TEST_ASSERT_FALSE(has(r.methods(), "event.speech_start"));
}

static void test_utterance_limit_truncates_and_ends_cleanly() {
  VRig r; r.boot(true, 64000);      // 2 s limit
  r.say(300, 0);
  r.say(5000, 6000);                // way past the limit
  auto m = r.methods();
  TEST_ASSERT_EQUAL(1, count(m, "audio.end"));
  size_t total = 0;
  for (auto& b : r.tr.bins) total += b.size() - kFrameHeaderBytes;
  TEST_ASSERT_TRUE(total <= 64000);
  TEST_ASSERT_TRUE(total >= 64000 - 1280);
  auto ae = r.note("audio.end");
  TEST_ASSERT_EQUAL((int)total, ae["params"]["total_bytes"].as<int>());
  TEST_ASSERT_TRUE(ae["params"]["reason"].isNull());
  TEST_ASSERT_TRUE(r.voice->state() != UplinkState::Listening);
}

static void test_ptt_turn_and_vad_off() {
  VoiceConfig vc; vc.vad = false;
  VRig r; r.boot(true, 480000, &vc);
  r.say(500, 6000);                 // loud but VAD is off
  TEST_ASSERT_EQUAL(0, r.tr.bins.size());
  TEST_ASSERT_TRUE(r.voice->pttDown(r.sys.t, false));
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  r.say(2000, 0);                   // silence does not end a PTT turn
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  TEST_ASSERT_TRUE(r.tr.bins.size() > 20);
  r.voice->pttUp(r.sys.t);
  auto m = r.methods();
  TEST_ASSERT_EQUAL(1, count(m, "audio.end"));
  TEST_ASSERT_EQUAL(1, count(m, "event.speech_end"));
}

static void startPlayback(VRig& r) {
  r.call("c_1", "device.speak", "{\"stream_id\":7," + meta(10000) + "}");
  // streamed reply: no totals, no LAST flag, audio.end terminates
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.begin\",\"params\":{\"stream_id\":7,\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096}}");
  for (uint32_t i = 0; i < 4; i++) r.tr.recvBin(frame(7, i, false, std::vector<uint8_t>(4096, 0x10)));
  r.advance(40);
  r.tr.texts.clear(); r.tr.bins.clear(); r.pingScan = 0;
}

static void test_streamed_reply_without_totals_plays_to_end() {
  VRig r; r.boot();
  r.call("c_1", "device.speak", "{\"stream_id\":7," + meta(10000) + "}");
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.begin\",\"params\":{\"stream_id\":7,\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096}}");
  for (uint32_t i = 0; i < 3; i++) r.tr.recvBin(frame(7, i, false, std::vector<uint8_t>(4096, 0x10)));
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.end\",\"params\":{\"stream_id\":7,\"total_chunks\":3,\"total_bytes\":12288,\"reason\":\"complete\"}}");
  for (int i = 0; i < 60; i++) { r.sink.finishAll(); r.advance(10); }
  TEST_ASSERT_EQUAL(12288, r.sink.played.size());
  auto pb = r.notes("playback.state");
  TEST_ASSERT_EQUAL_STRING("ended", pb.back()["params"]["state"]);
}

static void test_vad_is_deaf_while_playing_but_ptt_barges_in() {
  VRig r; r.boot();
  r.say(400, 0);
  startPlayback(r);
  TEST_ASSERT_TRUE(r.player.busy());
  r.say(800, 6000);                 // loud (maybe our own echo): half duplex ignores it
  TEST_ASSERT_FALSE(has(r.methods(), "event.speech_start"));
  TEST_ASSERT_TRUE(r.player.busy());
  // push-to-talk cuts the speaker at once and starts the turn
  int stopsBefore = r.sink.stops;
  TEST_ASSERT_TRUE(r.voice->pttDown(r.sys.t, r.player.busy()));
  TEST_ASSERT_TRUE(r.sink.stops > stopsBefore);
  TEST_ASSERT_FALSE(r.player.busy());
  TEST_ASSERT_TRUE(has(r.methods(), "event.speech_start"));
  auto pb = r.notes("playback.state");
  TEST_ASSERT_EQUAL_STRING("interrupted", pb.back()["params"]["state"]);
}

static void test_vad_barge_in_when_enabled() {
  VoiceConfig vc; vc.bargeInByVad = true;
  VRig r; r.boot(true, 480000, &vc);
  r.say(400, 0);
  startPlayback(r);
  r.say(600, 6000);
  TEST_ASSERT_TRUE(has(r.methods(), "event.speech_start"));
  TEST_ASSERT_FALSE(r.player.busy());
}

static void test_emergency_stop_aborts_uplink() {
  VRig r; r.boot();
  r.say(300, 0);
  r.say(800, 6000);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  uint16_t sid = r.voice->streamId();
  auto d = r.call("c_9", "device.emergency_stop", "{" + meta() + "}");
  TEST_ASSERT_FALSE(d["result"].isNull());
  auto ae = r.note("audio.end");
  TEST_ASSERT_FALSE(ae.isNull());
  TEST_ASSERT_EQUAL_STRING("aborted", ae["params"]["reason"]);
  TEST_ASSERT_EQUAL(sid, ae["params"]["stream_id"].as<int>());
  TEST_ASSERT_FALSE(has(r.methods(), "event.speech_end"));
  size_t bins = r.tr.bins.size();
  r.say(200, 6000);                  // cooldown: nothing more is sent for the aborted utterance
  TEST_ASSERT_EQUAL(bins, r.tr.bins.size());
}

static void test_local_stop_aborts_uplink() {
  VRig r; r.boot();
  r.say(300, 0); r.say(600, 6000);
  r.client->localEmergencyStop("touch");
  TEST_ASSERT_EQUAL_STRING("aborted", r.note("audio.end")["params"]["reason"]);
  TEST_ASSERT_TRUE(has(r.methods(), "event.local_stop"));
}

static void test_bridge_ends_turn_while_talking() {
  VRig r; r.boot();
  r.say(300, 0); r.say(600, 6000);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"idle\",\"reason\":\"too_long\"}}");
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Cooldown);
  size_t bins = r.tr.bins.size();
  r.say(500, 6000);
  TEST_ASSERT_EQUAL(bins, r.tr.bins.size());                   // stopped sending
  TEST_ASSERT_FALSE(has(r.methods(), "audio.end"));            // the bridge already gave up: nothing to announce
}

static void test_stream_error_stops_uplink() {
  VRig r; r.boot();
  r.say(300, 0); r.say(600, 6000);
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"stream.error\",\"params\":{\"stream_id\":" + std::to_string(r.voice->streamId()) + ",\"reason\":\"seq_gap\"}}");
  TEST_ASSERT_TRUE(r.voice->state() != UplinkState::Listening);
}

static void test_reconnect_drops_the_turn_and_rearms() {
  VRig r; r.boot();
  r.say(300, 0); r.say(600, 6000);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  r.tr.close(1006);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Off);
  TEST_ASSERT_FALSE(r.mic.on);
  size_t bins = r.tr.bins.size();
  r.mic.feed(500, 6000);
  r.advance(500, 20);
  TEST_ASSERT_EQUAL(bins, r.tr.bins.size());
  // reconnect + hello again -> Idle, fresh turn works
  r.advance(40000, 100);
  r.tr.open();
  std::string h = "{\"jsonrpc\":\"2.0\",\"id\":\"d_2\",\"result\":{\"session_id\":\"s_2\",\"server_time\":1,\"heartbeat_s\":20,\"audio\":{\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1},\"voice\":{\"uplink\":{\"max_ms\":15000,\"max_bytes\":480000}}}}";
  r.tr.recv(h);
  TEST_ASSERT_TRUE(r.client->ready());
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Idle);
  r.mic.buf.clear();
  r.tr.texts.clear();
  r.say(600, 0); r.say(600, 6000);
  TEST_ASSERT_TRUE(has(r.methods(), "event.speech_start"));
}

static void test_send_failure_aborts() {
  VRig r; r.boot();
  r.say(300, 0);
  r.say(500, 6000);
  TEST_ASSERT_TRUE(r.voice->state() == UplinkState::Listening);
  r.tr.failBinary = true;            // transport can no longer take frames
  r.say(200, 6000);
  TEST_ASSERT_TRUE(r.voice->state() != UplinkState::Listening);
  TEST_ASSERT_FALSE(has(r.methods(), "event.speech_end"));
}

static void test_thinking_expression_follows_turn_state() {
  VRig r; r.boot();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"thinking\"}}");
  TEST_ASSERT_EQUAL_STRING("thinking", r.client->expression().c_str());
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"idle\"}}");
  TEST_ASSERT_EQUAL_STRING("neutral", r.client->expression().c_str());
}

static void test_privacy_mic_flag_follows_mic() {
  VRig r; r.boot();
  r.say(100, 0);
  r.advance(31000, 100);
  auto n = r.notes("state.update");
  TEST_ASSERT_TRUE(n.size() > 0);
  TEST_ASSERT_TRUE(n.back()["params"]["privacy"]["mic"].as<bool>());
}

static void test_display_turn_state_follows_local_and_bridge() {
  VRig r; r.boot();
  r.advance(40);
  TEST_ASSERT_EQUAL_STRING("idle", r.display.turn.c_str());
  r.voice->pttDown(r.sys.t, false);                 // local listening shows without a bridge round trip
  r.advance(60);
  TEST_ASSERT_EQUAL_STRING("listening", r.display.turn.c_str());
  r.voice->pttUp(r.sys.t);
  r.advance(60);
  TEST_ASSERT_TRUE(r.display.turn == "transcribing" || r.display.turn == "thinking");
  const char* seq[] = {"transcribing", "thinking", "speaking", "idle"};
  for (const char* st : seq) {
    r.tr.recv(std::string("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"") + st + "\"}}");
    r.advance(40);
    TEST_ASSERT_EQUAL_STRING(st, r.display.turn.c_str());
  }
}

static void test_display_turn_state_idle_after_link_loss() {
  VRig r; r.boot();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"turn.state\",\"params\":{\"state\":\"thinking\"}}");
  r.advance(40);
  TEST_ASSERT_EQUAL_STRING("thinking", r.display.turn.c_str());
  r.tr.close(1006);
  r.advance(60);
  TEST_ASSERT_EQUAL_STRING("idle", r.display.turn.c_str());
}

static void test_display_turn_state_speaking_from_playback_only() {
  VRig r; r.boot(false);                    // no voice uplink at all
  r.advance(40);
  TEST_ASSERT_EQUAL_STRING("idle", r.display.turn.c_str());
  startPlayback(r);
  r.advance(40);
  TEST_ASSERT_EQUAL_STRING("speaking", r.display.turn.c_str());
}

void run_voice_tests() {
  RUN_TEST(test_no_voice_in_hello_stays_off);
  RUN_TEST(test_silence_sends_nothing);
  RUN_TEST(test_vad_full_utterance);
  RUN_TEST(test_short_blip_does_not_trigger);
  RUN_TEST(test_utterance_limit_truncates_and_ends_cleanly);
  RUN_TEST(test_ptt_turn_and_vad_off);
  RUN_TEST(test_streamed_reply_without_totals_plays_to_end);
  RUN_TEST(test_vad_is_deaf_while_playing_but_ptt_barges_in);
  RUN_TEST(test_vad_barge_in_when_enabled);
  RUN_TEST(test_emergency_stop_aborts_uplink);
  RUN_TEST(test_local_stop_aborts_uplink);
  RUN_TEST(test_bridge_ends_turn_while_talking);
  RUN_TEST(test_stream_error_stops_uplink);
  RUN_TEST(test_reconnect_drops_the_turn_and_rearms);
  RUN_TEST(test_display_turn_state_follows_local_and_bridge);
  RUN_TEST(test_display_turn_state_idle_after_link_loss);
  RUN_TEST(test_display_turn_state_speaking_from_playback_only);
  RUN_TEST(test_send_failure_aborts);
  RUN_TEST(test_thinking_expression_follows_turn_state);
  RUN_TEST(test_privacy_mic_flag_follows_mic);
}
