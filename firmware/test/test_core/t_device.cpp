// DeviceClient against fakes: handshake, every command, errors, dedup, audio flow, reconnect.
#include <unity.h>
#include "fakes.h"

using namespace gc;
using namespace gctest;

#define ASSERT_RESULT(d) TEST_ASSERT_FALSE_MESSAGE((d)["result"].isNull(), "expected a result")
#define ASSERT_ERR(d, c) do { TEST_ASSERT_FALSE_MESSAGE((d)["error"].isNull(), "expected an error"); TEST_ASSERT_EQUAL((c), (d)["error"]["code"].as<int>()); } while (0)

// ------------------------------------------------------------------ handshake
static void test_hello_content() {
  Rig r;
  r.client->begin();
  TEST_ASSERT_EQUAL(0, r.tr.connectCalls);
  r.client->tick();
  TEST_ASSERT_EQUAL(1, r.tr.connectCalls);
  TEST_ASSERT_TRUE(r.client->state() == SessionState::Connecting);
  r.tr.open();
  TEST_ASSERT_TRUE(r.client->state() == SessionState::HelloSent);
  TEST_ASSERT_EQUAL(1, r.tr.texts.size());
  JsonDocument d;
  TEST_ASSERT_FALSE(deserializeJson(d, r.tr.texts[0]));
  TEST_ASSERT_EQUAL_STRING("2.0", d["jsonrpc"]);
  TEST_ASSERT_EQUAL_STRING("d_1", d["id"]);
  TEST_ASSERT_EQUAL_STRING("session.hello", d["method"]);
  JsonObject p = d["params"];
  TEST_ASSERT_EQUAL_STRING("grokchan-rpc/1", p["protocol"]);
  TEST_ASSERT_EQUAL_STRING("stackchan-test", p["device_id"]);
  TEST_ASSERT_EQUAL_STRING("0.1.0-test", p["fw"]);
  TEST_ASSERT_EQUAL_STRING("m5stack-cores3", p["hw"]);
  TEST_ASSERT_EQUAL(4, p["caps"].size());
  TEST_ASSERT_EQUAL(-90, p["limits"]["pan"][0].as<int>());
  TEST_ASSERT_EQUAL(90, p["limits"]["pan"][1].as<int>());
  TEST_ASSERT_EQUAL(0, p["limits"]["tilt"][0].as<int>());
  TEST_ASSERT_EQUAL(60, p["limits"]["tilt"][1].as<int>());
  TEST_ASSERT_EQUAL(70, p["limits"]["volume_cap"].as<int>());
  TEST_ASSERT_EQUAL(200, p["limits"]["text_max"].as<int>());
  TEST_ASSERT_EQUAL(168, p["limits"]["led_max"].as<int>());
  TEST_ASSERT_TRUE(p["expressions"].size() >= 8);
  TEST_ASSERT_EQUAL_STRING("pcm_s16le", p["audio"]["play"][0]["format"]);
  TEST_ASSERT_EQUAL(16000, p["audio"]["play"][0]["sample_rate"].as<int>());
  TEST_ASSERT_EQUAL(1, p["audio"]["play"][0]["channels"].as<int>());
  TEST_ASSERT_EQUAL(4096, p["audio"]["max_chunk_bytes"].as<int>());
  TEST_ASSERT_EQUAL(2000, p["audio"]["buffer_ms"].as<int>());
}

static void test_ready_sends_state_update() {
  Rig r;
  r.client->begin(); r.client->tick(); r.tr.open();
  r.tr.recv(r.helloResponse());
  TEST_ASSERT_TRUE(r.client->ready());
  TEST_ASSERT_EQUAL_STRING("s_1", r.client->sessionId().c_str());
  auto n = r.notes("state.update");
  TEST_ASSERT_EQUAL(1, n.size());
  TEST_ASSERT_EQUAL(80, n[0]["params"]["battery"]["percent"].as<int>());
  TEST_ASSERT_EQUAL(40, n[0]["params"]["volume"].as<int>());
  TEST_ASSERT_EQUAL(0, n[0]["params"]["pose"]["pan"].as<int>());
  TEST_ASSERT_EQUAL_STRING("neutral", n[0]["params"]["expression"]);
}

static void test_hello_error_reconnects() {
  Rig r;
  r.client->begin(); r.client->tick(); r.tr.open();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"d_1\",\"error\":{\"code\":-32004,\"message\":\"UNAUTHORIZED\"}}");
  TEST_ASSERT_FALSE(r.client->ready());
  TEST_ASSERT_TRUE(r.client->state() == SessionState::WaitRetry);
  TEST_ASSERT_EQUAL(1, r.tr.disconnectCalls);
}

static void test_hello_timeout() {
  Rig r;
  r.client->begin(); r.client->tick(); r.tr.open();
  r.advance(10100);
  TEST_ASSERT_TRUE(r.client->state() == SessionState::WaitRetry);
  TEST_ASSERT_EQUAL(1, r.tr.disconnectCalls);
}

static void test_commands_before_ready_are_busy() {
  Rig r;
  r.client->begin(); r.client->tick(); r.tr.open();
  auto d = r.call("c_1", "device.get_status", "{}");
  ASSERT_ERR(d, -32000);
}

// ------------------------------------------------------------------ keepalive / reconnect
static void test_ping_and_pong() {
  Rig r;
  r.ready();
  r.autoPong = false;
  r.advance(10100);
  int pings = 0;
  for (auto& s : r.tr.texts) if (s == "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}") pings++;
  TEST_ASSERT_EQUAL(1, pings);
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"pong\"}");
  r.advance(5000);
  TEST_ASSERT_TRUE(r.client->ready());
}

static void test_pong_timeout_reconnects() {
  Rig r;
  r.ready();
  r.autoPong = false;
  r.advance(10100 + 10100);  // ping at 10 s, no pong for > 10 s
  TEST_ASSERT_FALSE(r.client->ready());
  TEST_ASSERT_EQUAL(1, r.tr.disconnectCalls);
  TEST_ASSERT_EQUAL(1, r.client->reconnects());
}

static void test_answers_incoming_ping() {
  Rig r;
  r.ready();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}");
  TEST_ASSERT_EQUAL_STRING("{\"jsonrpc\":\"2.0\",\"method\":\"pong\"}", r.tr.texts.back().c_str());
}

static void test_reconnect_backoff_progression() {
  Rig r;
  r.client->begin(); r.client->tick();
  uint32_t want[] = {1000, 2000, 4000, 8000, 16000, 30000, 30000};
  for (uint32_t w : want) {
    int before = r.tr.connectCalls;
    r.tr.close(1006);  // connect attempt failed
    TEST_ASSERT_EQUAL_UINT32(w, r.client->nextRetryDelayMs());
    r.advance(w - 10);
    TEST_ASSERT_EQUAL(before, r.tr.connectCalls);
    r.advance(20);
    TEST_ASSERT_EQUAL(before + 1, r.tr.connectCalls);
  }
}

static void test_backoff_resets_after_stable_session() {
  Rig r;
  r.client->begin(); r.client->tick();
  r.tr.close(1006); r.advance(1100);          // 1 s
  r.tr.close(1006); r.advance(2100);          // 2 s
  r.tr.open(); r.tr.recv(r.helloResponse());  // ready
  r.advance(11000);                           // stable > 10 s
  r.tr.close(1006);
  TEST_ASSERT_EQUAL_UINT32(1000, r.client->nextRetryDelayMs());
}

static void test_close_4000_reconnects_and_stops_audio() {
  Rig r;
  r.ready();
  r.call("c_1", "device.speak", "{\"stream_id\":1," + meta() + "}");
  TEST_ASSERT_TRUE(r.player.busy());
  r.tr.close(4000);
  TEST_ASSERT_FALSE(r.client->ready());
  TEST_ASSERT_FALSE(r.player.busy());
  TEST_ASSERT_EQUAL(1, r.client->reconnects());
}

static void test_connect_timeout() {
  Rig r;
  r.client->begin(); r.client->tick();
  r.advance(15100);
  TEST_ASSERT_TRUE(r.client->state() == SessionState::WaitRetry);
  TEST_ASSERT_EQUAL(1, r.tr.disconnectCalls);
}

// ------------------------------------------------------------------ JSON-RPC error handling
static void test_parse_error() {
  Rig r; r.ready();
  r.tr.recv("{not json");
  JsonDocument d;
  deserializeJson(d, r.tr.texts.back());
  ASSERT_ERR(d, -32700);
  TEST_ASSERT_TRUE(d["id"].isNull());
}

static void test_batch_rejected() {
  Rig r; r.ready();
  r.tr.recv("[{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.get_status\"}]");
  JsonDocument d;
  deserializeJson(d, r.tr.texts.back());
  ASSERT_ERR(d, -32600);
}

static void test_method_not_found() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.dance", "{}");
  ASSERT_ERR(d, -32601);
  TEST_ASSERT_EQUAL_STRING("c_1", d["id"]);
}

static void test_wrong_jsonrpc_version() {
  Rig r; r.ready();
  r.tr.recv("{\"jsonrpc\":\"1.0\",\"id\":\"c_9\",\"method\":\"device.get_status\"}");
  JsonDocument d;
  deserializeJson(d, r.tr.texts.back());
  ASSERT_ERR(d, -32600);
  TEST_ASSERT_EQUAL_STRING("c_9", d["id"]);
}

static void test_params_must_be_object() {
  Rig r; r.ready();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":[1,2]}");
  JsonDocument d;
  deserializeJson(d, r.tr.texts.back());
  ASSERT_ERR(d, -32602);
}

static void test_numeric_ids_echoed() {
  Rig r; r.ready();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"device.get_status\"}");
  JsonDocument d;
  deserializeJson(d, r.tr.texts.back());
  TEST_ASSERT_EQUAL(7, d["id"].as<int>());
  ASSERT_RESULT(d);
}

static void test_unknown_notification_ignored() {
  Rig r; r.ready();
  size_t n = r.tr.texts.size();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"whatever\",\"params\":{}}");
  TEST_ASSERT_EQUAL(n, r.tr.texts.size());
}

// ------------------------------------------------------------------ get_status
static void test_get_status() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.get_status", "{" + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(80, d["result"]["battery"]["percent"].as<int>());
  TEST_ASSERT_FALSE(d["result"]["battery"]["charging"].as<bool>());
  TEST_ASSERT_EQUAL(40, d["result"]["volume"].as<int>());
  TEST_ASSERT_EQUAL(0, d["result"]["pose"]["pan"].as<int>());
  TEST_ASSERT_EQUAL_STRING("neutral", d["result"]["expression"]);
  TEST_ASSERT_EQUAL_STRING("idle", d["result"]["playback"]["state"]);
}

// ------------------------------------------------------------------ move_head
static void test_move_head_accepted() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.move_head", "{\"pan\":30,\"tilt\":20,\"speed\":300," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(30, d["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(20, d["result"]["tilt"].as<int>());
  TEST_ASSERT_TRUE(d["result"]["clamped"].isNull());
  TEST_ASSERT_EQUAL(30, r.head.target.pan);
  TEST_ASSERT_EQUAL(300, r.head.lastSpeed);
}

static void test_move_head_clamps() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.move_head", "{\"pan\":400,\"tilt\":-50,\"speed\":99999," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(90, d["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(0, d["result"]["tilt"].as<int>());
  TEST_ASSERT_TRUE(d["result"]["clamped"].as<bool>());
  TEST_ASSERT_EQUAL(1000, r.head.lastSpeed);
}

static void test_move_head_default_speed() {
  Rig r; r.ready();
  r.call("c_1", "device.move_head", "{\"pan\":10," + meta() + "}");
  TEST_ASSERT_EQUAL(150, r.head.lastSpeed);
}

static void test_move_head_relative() {
  Rig r; r.ready();
  r.call("c_1", "device.move_head", "{\"pan\":20,\"tilt\":10," + meta() + "}");
  auto d = r.call("c_2", "device.move_head", "{\"pan\":15,\"tilt\":-5,\"relative\":true," + meta(5000, nullptr, 2) + "}");
  TEST_ASSERT_EQUAL(35, d["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(5, d["result"]["tilt"].as<int>());
}

static void test_move_head_partial_axis_keeps_other() {
  Rig r; r.ready();
  r.call("c_1", "device.move_head", "{\"pan\":20,\"tilt\":10," + meta() + "}");
  auto d = r.call("c_2", "device.move_head", "{\"tilt\":30," + meta() + "}");
  TEST_ASSERT_EQUAL(20, d["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(30, d["result"]["tilt"].as<int>());
}

static void test_move_head_invalid_params() {
  Rig r; r.ready();
  ASSERT_ERR(r.call("c_1", "device.move_head", "{" + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_2", "device.move_head", "{\"pan\":\"left\"," + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_3", "device.move_head", "{\"pan\":1,\"wait\":\"never\"," + meta() + "}"), -32602);
  TEST_ASSERT_EQUAL(0, r.head.moveCalls);
}

static void test_move_head_wait_done() {
  Rig r; r.ready();
  size_t from = r.tr.texts.size();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":{\"pan\":40,\"tilt\":10,\"wait\":\"done\"," + meta() + "}}");
  TEST_ASSERT_TRUE(r.find("c_1", from).isNull());  // nothing yet
  r.advance(500);
  auto d = r.find("c_1", from);
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(40, d["result"]["pan"].as<int>());
}

static void test_move_head_wait_done_timeout() {
  Rig r; r.ready();
  r.head.travelMs = 100000;
  size_t from = r.tr.texts.size();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":{\"pan\":40,\"wait\":\"done\"," + meta() + "}}");
  r.advance(30100, 50);
  auto d = r.find("c_1", from);
  ASSERT_ERR(d, -32003);
}

static void test_wait_done_superseded_is_busy() {
  Rig r; r.ready();
  size_t from = r.tr.texts.size();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":{\"pan\":40,\"wait\":\"done\"," + meta() + "}}");
  r.call("c_2", "device.move_head", "{\"pan\":-40," + meta(5000, nullptr, 2) + "}");
  ASSERT_ERR(r.find("c_1", from), -32000);
}

static void test_servo_not_responding() {
  Rig r; r.ready();
  r.head.failMove = true;
  ASSERT_ERR(r.call("c_1", "device.move_head", "{\"pan\":10," + meta() + "}"), -32009);
}

static void test_servo_fault_event_and_pending_error() {
  Rig r; r.ready();
  size_t from = r.tr.texts.size();
  r.head.travelMs = 100000;
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":{\"pan\":40,\"wait\":\"done\"," + meta() + "}}");
  r.head.faultReason = "stalled";
  r.advance(20);
  ASSERT_ERR(r.find("c_1", from), -32009);
  TEST_ASSERT_EQUAL(1, r.notes("event.servo_fault").size());
}

static void test_low_battery_refuses_motion() {
  Rig r; r.ready();
  r.sys.battery = 7;
  ASSERT_ERR(r.call("c_1", "device.move_head", "{\"pan\":10," + meta() + "}"), -32002);
  ASSERT_ERR(r.call("c_2", "device.reset_pose", "{" + meta() + "}"), -32002);
  TEST_ASSERT_EQUAL(0, r.head.moveCalls);
  // charging lifts the restriction
  r.sys.isCharging = true;
  ASSERT_RESULT(r.call("c_3", "device.move_head", "{\"pan\":10," + meta() + "}"));
}

static void test_low_battery_event_once() {
  Rig r; r.ready();
  r.sys.battery = 8;
  r.advance(1000);
  r.advance(1000);
  TEST_ASSERT_EQUAL(1, r.notes("event.battery_low").size());
}

static void test_low_battery_caps_volume() {
  Rig r; r.ready();
  r.call("c_1", "device.set_volume", "{\"volume\":70," + meta() + "}");
  TEST_ASSERT_EQUAL(70, r.sink.volume);
  r.sys.battery = 5;
  r.call("c_2", "device.set_volume", "{\"volume\":70," + meta(5000, nullptr, 2) + "}");
  TEST_ASSERT_EQUAL(40, r.sink.volume);
}

// ------------------------------------------------------------------ reset_pose
static void test_reset_pose() {
  Rig r; r.ready();
  r.call("c_1", "device.move_head", "{\"pan\":50,\"tilt\":30," + meta() + "}");
  r.call("c_2", "device.set_expression", "{\"expression\":\"happy\"," + meta() + "}");
  auto d = r.call("c_3", "device.reset_pose", "{" + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(0, d["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(0, d["result"]["tilt"].as<int>());
  TEST_ASSERT_EQUAL(0, r.head.target.pan);
  TEST_ASSERT_EQUAL_STRING("neutral", r.display.expr.c_str());
}

static void test_reset_pose_keep_face() {
  Rig r; r.ready();
  r.call("c_1", "device.set_expression", "{\"expression\":\"happy\"," + meta() + "}");
  r.call("c_2", "device.reset_pose", "{\"reset_face\":false," + meta() + "}");
  TEST_ASSERT_EQUAL_STRING("happy", r.display.expr.c_str());
}

// ------------------------------------------------------------------ expression
static void test_set_expression() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.set_expression", "{\"expression\":\"happy\"," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL_STRING("happy", d["result"]["expression"]);
  TEST_ASSERT_EQUAL_STRING("happy", r.display.expr.c_str());
}

static void test_set_expression_unknown_falls_back() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.set_expression", "{\"expression\":\"zorp\"," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL_STRING("neutral", d["result"]["expression"]);
  TEST_ASSERT_EQUAL_STRING("neutral", d["result"]["fallback"]);
}

static void test_set_expression_duration_reverts() {
  Rig r; r.ready();
  r.call("c_1", "device.set_expression", "{\"expression\":\"sad\"," + meta() + "}");
  r.call("c_2", "device.set_expression", "{\"expression\":\"happy\",\"duration_ms\":1000,\"revert_to\":\"sad\"," + meta(5000, nullptr, 2) + "}");
  TEST_ASSERT_EQUAL_STRING("happy", r.display.expr.c_str());
  r.advance(1100);
  TEST_ASSERT_EQUAL_STRING("sad", r.display.expr.c_str());
}

static void test_set_expression_look_at() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.set_expression", "{\"expression\":\"thinking\",\"look_at\":{\"pan\":200,\"tilt\":10}," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(90, r.head.target.pan);
  TEST_ASSERT_EQUAL(10, r.head.target.tilt);
}

static void test_set_expression_requires_name() {
  Rig r; r.ready();
  ASSERT_ERR(r.call("c_1", "device.set_expression", "{" + meta() + "}"), -32602);
}

// ------------------------------------------------------------------ show_text
static void test_show_text() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.show_text", "{\"text\":\"hi\",\"position\":\"center\",\"size\":\"l\",\"duration_ms\":2000," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_TRUE(d["result"]["shown"].as<bool>());
  TEST_ASSERT_FALSE(d["result"]["truncated"].as<bool>());
  TEST_ASSERT_EQUAL_STRING("hi", r.display.text.c_str());
  TEST_ASSERT_TRUE(r.display.pos == TextPosition::Center);
  TEST_ASSERT_TRUE(r.display.size == TextSize::Large);
  r.advance(2100);
  TEST_ASSERT_EQUAL_STRING("", r.display.text.c_str());
}

static void test_show_text_truncates() {
  Rig r; r.ready();
  std::string t(300, 'a');
  auto d = r.call("c_1", "device.show_text", "{\"text\":\"" + t + "\"," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_TRUE(d["result"]["truncated"].as<bool>());
  TEST_ASSERT_EQUAL(200, r.display.text.size());
}

static void test_show_text_clear_and_errors() {
  Rig r; r.ready();
  r.call("c_1", "device.show_text", "{\"text\":\"hi\"," + meta() + "}");
  auto d = r.call("c_2", "device.show_text", "{\"clear\":true," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL_STRING("", r.display.text.c_str());
  ASSERT_ERR(r.call("c_3", "device.show_text", "{" + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_4", "device.show_text", "{\"text\":\"x\",\"position\":\"top\"," + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_5", "device.show_text", "{\"text\":\"\\u0001\\u0002\"," + meta() + "}"), -32602);
}

// ------------------------------------------------------------------ set_led
static void test_set_led_scaling_and_cap() {
  Rig r; r.ready();
  // 255 -> cap 168 -> brightness 40% -> 67
  auto d = r.call("c_1", "device.set_led", "{\"r\":255,\"g\":100,\"b\":0," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(67, d["result"]["applied_rgb"]["r"].as<int>());
  TEST_ASSERT_EQUAL(40, d["result"]["applied_rgb"]["g"].as<int>());
  TEST_ASSERT_EQUAL(0, d["result"]["applied_rgb"]["b"].as<int>());
  TEST_ASSERT_TRUE(d["result"]["clamped"].as<bool>());
  TEST_ASSERT_EQUAL(67, r.led.r);
  TEST_ASSERT_TRUE(r.led.mode == LedMode::Solid);
  TEST_ASSERT_TRUE(r.led.side == LedSide::Both);
}

static void test_set_led_brightness_side_mode() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.set_led", "{\"r\":100,\"g\":100,\"b\":100,\"brightness\":100,\"side\":\"left\",\"mode\":\"breathe\"," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(100, r.led.r);
  TEST_ASSERT_TRUE(r.led.side == LedSide::Left);
  TEST_ASSERT_TRUE(r.led.mode == LedMode::Breathe);
}

static void test_set_led_duration_turns_off() {
  Rig r; r.ready();
  r.call("c_1", "device.set_led", "{\"r\":100,\"g\":0,\"b\":0,\"duration_ms\":1000," + meta() + "}");
  r.advance(900);
  TEST_ASSERT_TRUE(r.led.mode == LedMode::Solid);
  r.advance(200);
  TEST_ASSERT_TRUE(r.led.mode == LedMode::Off);
  TEST_ASSERT_EQUAL(0, r.led.r);
}

static void test_set_led_off_and_errors() {
  Rig r; r.ready();
  ASSERT_RESULT(r.call("c_1", "device.set_led", "{\"mode\":\"off\"," + meta() + "}"));
  TEST_ASSERT_TRUE(r.led.mode == LedMode::Off);
  ASSERT_ERR(r.call("c_2", "device.set_led", "{\"r\":1,\"g\":2," + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_3", "device.set_led", "{\"r\":300,\"g\":0,\"b\":0," + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_4", "device.set_led", "{\"r\":1,\"g\":2,\"b\":3,\"side\":\"up\"," + meta() + "}"), -32602);
}

// ------------------------------------------------------------------ volume
static void test_set_volume() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.set_volume", "{\"volume\":90,\"persist\":true," + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(70, d["result"]["volume"].as<int>());  // cap
  TEST_ASSERT_EQUAL(70, r.sink.volume);
  TEST_ASSERT_EQUAL(70, r.sys.savedVolume);
  d = r.call("c_2", "device.set_volume", "{\"mute\":true," + meta() + "}");
  TEST_ASSERT_TRUE(d["result"]["muted"].as<bool>());
  TEST_ASSERT_TRUE(r.sink.muted);
  TEST_ASSERT_EQUAL(70, d["result"]["volume"].as<int>());
}

static void test_set_volume_errors() {
  Rig r; r.ready();
  ASSERT_ERR(r.call("c_1", "device.set_volume", "{" + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_2", "device.set_volume", "{\"volume\":101," + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_3", "device.set_volume", "{\"volume\":-1," + meta() + "}"), -32602);
}

// ------------------------------------------------------------------ speak / audio
static std::vector<uint8_t> pcm(size_t n, uint8_t v = 0x10) { return std::vector<uint8_t>(n, v); }

static void test_speak_flow() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.speak", "{\"stream_id\":7,\"expression\":\"happy\"," + meta(10000) + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_TRUE(d["result"]["accepted"].as<bool>());
  TEST_ASSERT_EQUAL(7, d["result"]["stream_id"].as<int>());
  TEST_ASSERT_EQUAL(0, d["result"]["queue_position"].as<int>());
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.begin\",\"params\":{\"stream_id\":7,\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096,\"total_bytes\":14000,\"total_chunks\":4}}");
  for (uint32_t i = 0; i < 3; i++) r.tr.recvBin(frame(7, i, false, pcm(4096)));
  r.tr.recvBin(frame(7, 3, true, pcm(1712, 0x20)));
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.end\",\"params\":{\"stream_id\":7,\"total_chunks\":4,\"total_bytes\":14000,\"reason\":\"complete\"}}");
  r.advance(20);
  TEST_ASSERT_TRUE(r.display.speaking);
  TEST_ASSERT_EQUAL_STRING("happy", r.display.expr.c_str());
  auto pb = r.notes("playback.state");
  TEST_ASSERT_EQUAL(1, pb.size());
  TEST_ASSERT_EQUAL_STRING("started", pb[0]["params"]["state"]);
  TEST_ASSERT_EQUAL(7, pb[0]["params"]["stream_id"].as<int>());
  for (int i = 0; i < 100; i++) { r.sink.finishAll(); r.advance(10); }
  TEST_ASSERT_EQUAL(14000, r.sink.played.size());
  pb = r.notes("playback.state");
  TEST_ASSERT_EQUAL(2, pb.size());
  TEST_ASSERT_EQUAL_STRING("ended", pb[1]["params"]["state"]);
  TEST_ASSERT_FALSE(r.display.speaking);
  TEST_ASSERT_EQUAL_STRING("neutral", r.display.expr.c_str());  // restored
}

static void test_speak_invalid_and_duplicate() {
  Rig r; r.ready();
  ASSERT_ERR(r.call("c_1", "device.speak", "{" + meta() + "}"), -32602);
  ASSERT_ERR(r.call("c_2", "device.speak", "{\"stream_id\":0," + meta() + "}"), -32602);
  ASSERT_RESULT(r.call("c_3", "device.speak", "{\"stream_id\":5," + meta() + "}"));
  ASSERT_ERR(r.call("c_4", "device.speak", "{\"stream_id\":5," + meta() + "}"), -32602);
}

static void test_speak_queue_full_is_busy() {
  Rig r; r.ready();
  for (int i = 1; i <= 4; i++) ASSERT_RESULT(r.call("c_" + std::to_string(i), "device.speak", "{\"stream_id\":" + std::to_string(i) + "," + meta() + "}"));
  ASSERT_ERR(r.call("c_5", "device.speak", "{\"stream_id\":5," + meta() + "}"), -32000);
}

static void test_binary_frames_ignored_before_ready_or_unknown() {
  Rig r;
  r.client->begin(); r.client->tick(); r.tr.open();
  r.tr.recvBin(frame(1, 0, false, pcm(100)));   // not ready: ignored
  r.tr.recv(r.helloResponse());
  r.tr.recvBin(frame(9, 0, false, pcm(100)));   // unknown stream: ignored, no crash
  r.tr.recvBin({0x01, 0x00});                    // truncated header
  TEST_ASSERT_TRUE(r.client->ready());
  TEST_ASSERT_EQUAL(0, r.queue.used());
}

static void test_bad_audio_begin_reports_error() {
  Rig r; r.ready();
  r.call("c_1", "device.speak", "{\"stream_id\":3," + meta() + "}");
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"method\":\"audio.begin\",\"params\":{\"stream_id\":3,\"format\":\"mp3\",\"sample_rate\":16000,\"channels\":1,\"chunk_bytes\":4096}}");
  auto pb = r.notes("playback.state");
  TEST_ASSERT_EQUAL(1, pb.size());
  TEST_ASSERT_EQUAL_STRING("error", pb[0]["params"]["state"]);
}

static void test_stop_audio() {
  Rig r; r.ready();
  r.call("c_1", "device.speak", "{\"stream_id\":1," + meta() + "}");
  r.call("c_2", "device.speak", "{\"stream_id\":2," + meta(5000, nullptr, 2) + "}");
  auto d = r.call("c_3", "device.stop_audio", "{\"clear_queue\":true," + meta(5000, nullptr, 3) + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(2, d["result"]["stopped"].size());  // current + queued
  TEST_ASSERT_EQUAL(1, d["result"]["stopped"][0].as<int>());
  TEST_ASSERT_EQUAL(1, d["result"]["cleared"].as<int>());
  TEST_ASSERT_FALSE(r.player.busy());
  auto pb = r.notes("playback.state");
  TEST_ASSERT_TRUE(pb.size() >= 1);
}

static void test_stop_audio_nothing_playing() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.stop_audio", "{" + meta() + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_EQUAL(0, d["result"]["stopped"].size());
}

// ------------------------------------------------------------------ emergency stop
static void test_emergency_stop() {
  Rig r; r.ready();
  r.head.travelMs = 100000;
  size_t from = r.tr.texts.size();
  r.tr.recv("{\"jsonrpc\":\"2.0\",\"id\":\"c_1\",\"method\":\"device.move_head\",\"params\":{\"pan\":40,\"wait\":\"done\"," + meta() + "}}");
  r.call("c_2", "device.speak", "{\"stream_id\":1," + meta() + "}");
  auto d = r.call("c_3", "device.emergency_stop", "{" + meta(2000, nullptr, 3) + "}");
  ASSERT_RESULT(d);
  TEST_ASSERT_TRUE(d["result"]["motion_halted"].as<bool>());
  TEST_ASSERT_TRUE(d["result"]["audio_stopped"].as<bool>());
  TEST_ASSERT_EQUAL(1, r.head.haltCalls);
  TEST_ASSERT_FALSE(r.player.busy());
  ASSERT_ERR(r.find("c_1", from), -32000);  // the interrupted wait=done request is answered
}

static void test_emergency_stop_not_deduped_and_ignores_ttl() {
  Rig r; r.ready();
  r.call("c_1", "device.emergency_stop", "{" + meta(0) + "}");
  r.call("c_1", "device.emergency_stop", "{" + meta(0) + "}");
  TEST_ASSERT_EQUAL(2, r.head.haltCalls);
}

static void test_local_emergency_stop() {
  Rig r; r.ready();
  r.call("c_1", "device.speak", "{\"stream_id\":1," + meta() + "}");
  r.client->localEmergencyStop("touch");
  TEST_ASSERT_EQUAL(1, r.head.haltCalls);
  TEST_ASSERT_FALSE(r.player.busy());
  auto n = r.notes("event.local_stop");
  TEST_ASSERT_EQUAL(1, n.size());
  TEST_ASSERT_EQUAL_STRING("touch", n[0]["params"]["reason"]);
}

// ------------------------------------------------------------------ dedup / ttl
static void test_dedup_by_id_replays_without_side_effects() {
  Rig r; r.ready();
  std::string p = "{\"pan\":30," + meta() + "}";
  auto a = r.call("c_1", "device.move_head", p);
  ASSERT_RESULT(a);
  TEST_ASSERT_EQUAL(1, r.head.moveCalls);
  auto b = r.call("c_1", "device.move_head", p);
  ASSERT_RESULT(b);
  TEST_ASSERT_TRUE(b["result"]["_meta"]["deduplicated"].as<bool>());
  TEST_ASSERT_EQUAL(30, b["result"]["pan"].as<int>());
  TEST_ASSERT_EQUAL(1, r.head.moveCalls);
}

static void test_dedup_by_idempotency_key() {
  Rig r; r.ready();
  auto a = r.call("c_1", "device.show_text", "{\"text\":\"x\"," + meta(5000, "k-1") + "}");
  ASSERT_RESULT(a);
  r.display.text.clear();
  auto b = r.call("c_2", "device.show_text", "{\"text\":\"x\"," + meta(5000, "k-1", 2) + "}");
  ASSERT_RESULT(b);
  TEST_ASSERT_EQUAL_STRING("c_2", b["id"]);
  TEST_ASSERT_TRUE(b["result"]["_meta"]["deduplicated"].as<bool>());
  TEST_ASSERT_EQUAL_STRING("", r.display.text.c_str());  // not shown again
}

static void test_dedup_error_replayed_by_id() {
  Rig r; r.ready();
  r.sys.battery = 5;
  ASSERT_ERR(r.call("c_1", "device.move_head", "{\"pan\":1," + meta() + "}"), -32002);
  r.sys.battery = 80;
  ASSERT_ERR(r.call("c_1", "device.move_head", "{\"pan\":1," + meta() + "}"), -32002);  // same id => same answer
  ASSERT_RESULT(r.call("c_2", "device.move_head", "{\"pan\":1," + meta(5000, nullptr, 2) + "}"));
}

static void test_dedup_window_expires() {
  Rig r; r.ready();
  r.call("c_1", "device.show_text", "{\"text\":\"x\"," + meta() + "}");
  r.advance(61000, 100);
  r.display.text.clear();
  auto b = r.call("c_1", "device.show_text", "{\"text\":\"x\"," + meta() + "}");
  TEST_ASSERT_TRUE(b["result"]["_meta"]["deduplicated"].isNull());
  TEST_ASSERT_EQUAL_STRING("x", r.display.text.c_str());
}

static void test_get_status_not_deduped() {
  Rig r; r.ready();
  r.call("c_1", "device.get_status", "{}");
  r.sys.battery = 55;
  auto b = r.call("c_1", "device.get_status", "{}");
  TEST_ASSERT_EQUAL(55, b["result"]["battery"]["percent"].as<int>());
}

static void test_expired_ttl() {
  Rig r; r.ready();
  auto d = r.call("c_1", "device.move_head", "{\"pan\":10," + meta(0) + "}");
  ASSERT_ERR(d, -32008);
  TEST_ASSERT_EQUAL(0, r.head.moveCalls);
}

// ------------------------------------------------------------------ state updates
static void test_state_update_after_change_is_coalesced() {
  Rig r; r.ready();
  r.advance(600);  // let the post-hello gap pass
  size_t before = r.notes("state.update").size();
  r.call("c_1", "device.set_expression", "{\"expression\":\"happy\"," + meta() + "}");
  r.call("c_2", "device.set_volume", "{\"volume\":20," + meta(5000, nullptr, 2) + "}");
  r.advance(600);
  auto n = r.notes("state.update");
  TEST_ASSERT_EQUAL(before + 1, n.size());
  TEST_ASSERT_EQUAL_STRING("happy", n.back()["params"]["expression"]);
  TEST_ASSERT_EQUAL(20, n.back()["params"]["volume"].as<int>());
}

static void test_periodic_state_update() {
  Rig r; r.ready();
  r.advance(30500, 50);
  TEST_ASSERT_EQUAL(1, r.notes("state.update").size());  // the post-hello one was cleared by ready()
}

static void test_state_update_fits_bridge_limit() {
  Rig r; r.ready();
  TEST_ASSERT_TRUE(r.tr.texts.size() == 0);  // ready() clears; re-trigger one
  r.call("c_1", "device.set_expression", "{\"expression\":\"happy\"," + meta() + "}");
  r.advance(1000);
  for (auto& s : r.tr.texts) TEST_ASSERT_TRUE(s.size() < 8192);
}

void run_device_tests() {
  RUN_TEST(test_hello_content);
  RUN_TEST(test_ready_sends_state_update);
  RUN_TEST(test_hello_error_reconnects);
  RUN_TEST(test_hello_timeout);
  RUN_TEST(test_commands_before_ready_are_busy);
  RUN_TEST(test_ping_and_pong);
  RUN_TEST(test_pong_timeout_reconnects);
  RUN_TEST(test_answers_incoming_ping);
  RUN_TEST(test_reconnect_backoff_progression);
  RUN_TEST(test_backoff_resets_after_stable_session);
  RUN_TEST(test_close_4000_reconnects_and_stops_audio);
  RUN_TEST(test_connect_timeout);
  RUN_TEST(test_parse_error);
  RUN_TEST(test_batch_rejected);
  RUN_TEST(test_method_not_found);
  RUN_TEST(test_wrong_jsonrpc_version);
  RUN_TEST(test_params_must_be_object);
  RUN_TEST(test_numeric_ids_echoed);
  RUN_TEST(test_unknown_notification_ignored);
  RUN_TEST(test_get_status);
  RUN_TEST(test_move_head_accepted);
  RUN_TEST(test_move_head_clamps);
  RUN_TEST(test_move_head_default_speed);
  RUN_TEST(test_move_head_relative);
  RUN_TEST(test_move_head_partial_axis_keeps_other);
  RUN_TEST(test_move_head_invalid_params);
  RUN_TEST(test_move_head_wait_done);
  RUN_TEST(test_move_head_wait_done_timeout);
  RUN_TEST(test_wait_done_superseded_is_busy);
  RUN_TEST(test_servo_not_responding);
  RUN_TEST(test_servo_fault_event_and_pending_error);
  RUN_TEST(test_low_battery_refuses_motion);
  RUN_TEST(test_low_battery_event_once);
  RUN_TEST(test_low_battery_caps_volume);
  RUN_TEST(test_reset_pose);
  RUN_TEST(test_reset_pose_keep_face);
  RUN_TEST(test_set_expression);
  RUN_TEST(test_set_expression_unknown_falls_back);
  RUN_TEST(test_set_expression_duration_reverts);
  RUN_TEST(test_set_expression_look_at);
  RUN_TEST(test_set_expression_requires_name);
  RUN_TEST(test_show_text);
  RUN_TEST(test_show_text_truncates);
  RUN_TEST(test_show_text_clear_and_errors);
  RUN_TEST(test_set_led_scaling_and_cap);
  RUN_TEST(test_set_led_brightness_side_mode);
  RUN_TEST(test_set_led_duration_turns_off);
  RUN_TEST(test_set_led_off_and_errors);
  RUN_TEST(test_set_volume);
  RUN_TEST(test_set_volume_errors);
  RUN_TEST(test_speak_flow);
  RUN_TEST(test_speak_invalid_and_duplicate);
  RUN_TEST(test_speak_queue_full_is_busy);
  RUN_TEST(test_binary_frames_ignored_before_ready_or_unknown);
  RUN_TEST(test_bad_audio_begin_reports_error);
  RUN_TEST(test_stop_audio);
  RUN_TEST(test_stop_audio_nothing_playing);
  RUN_TEST(test_emergency_stop);
  RUN_TEST(test_emergency_stop_not_deduped_and_ignores_ttl);
  RUN_TEST(test_local_emergency_stop);
  RUN_TEST(test_dedup_by_id_replays_without_side_effects);
  RUN_TEST(test_dedup_by_idempotency_key);
  RUN_TEST(test_dedup_error_replayed_by_id);
  RUN_TEST(test_dedup_window_expires);
  RUN_TEST(test_get_status_not_deduped);
  RUN_TEST(test_expired_ttl);
  RUN_TEST(test_state_update_after_change_is_coalesced);
  RUN_TEST(test_periodic_state_update);
  RUN_TEST(test_state_update_fits_bridge_limit);
}
