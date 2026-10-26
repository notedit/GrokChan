// protocol helpers, text sanitizing, backoff, dedup
#include <unity.h>
#include "fakes.h"
#include "gc_backoff.h"
#include "gc_dedup.h"
#include "gc_util.h"

using namespace gc;

static bool validUtf8(const std::string& s) {
  size_t i = 0;
  while (i < s.size()) {
    unsigned char c = s[i];
    int n = c < 0x80 ? 0 : (c >> 5) == 6 ? 1 : (c >> 4) == 14 ? 2 : (c >> 3) == 30 ? 3 : -1;
    if (n < 0 || i + n >= s.size() + (n == 0 ? 1 : 0)) { if (n != 0) return false; }
    for (int k = 1; k <= n; k++) if (i + k >= s.size() || ((unsigned char)s[i + k] >> 6) != 2) return false;
    i += 1 + n;
  }
  return true;
}

static void test_frame_roundtrip() {
  uint8_t buf[8];
  FrameHeader h;
  h.type = kFrameDownlinkAudio; h.flags = kFlagLast; h.stream = 0x1234; h.seq = 0xA1B2C3D4;
  encodeFrameHeader(h, buf);
  // little endian: type, flags, stream u16, seq u32
  uint8_t expect[8] = {0x01, 0x01, 0x34, 0x12, 0xD4, 0xC3, 0xB2, 0xA1};
  TEST_ASSERT_EQUAL_UINT8_ARRAY(expect, buf, 8);
  FrameHeader o;
  TEST_ASSERT_TRUE(decodeFrameHeader(buf, 8, o));
  TEST_ASSERT_EQUAL_UINT16(0x1234, o.stream);
  TEST_ASSERT_EQUAL_UINT32(0xA1B2C3D4u, o.seq);
  TEST_ASSERT_TRUE(o.last());
  TEST_ASSERT_FALSE(decodeFrameHeader(buf, 7, o));
}

static void test_error_code_names() {
  TEST_ASSERT_EQUAL_STRING("parse_error", rpcCodeName(-32700));
  TEST_ASSERT_EQUAL_STRING("busy", rpcCodeName(-32000));
  TEST_ASSERT_EQUAL_STRING("low_battery", rpcCodeName(-32002));
  TEST_ASSERT_EQUAL_STRING("expired", rpcCodeName(-32008));
  TEST_ASSERT_EQUAL_STRING("stream_error", rpcCodeName(-32012));
}

static void test_sanitize_text() {
  bool tr = false;
  TEST_ASSERT_EQUAL_STRING("hello\nworld", sanitizeText(std::string("hel\x01lo\nwor\x1f" "ld"), 200, tr).c_str());
  TEST_ASSERT_FALSE(tr);
  // truncation counts code points, not bytes
  std::string cjk;
  for (int i = 0; i < 300; i++) cjk += "\xE4\xBD\xA0";  // 你
  std::string out = sanitizeText(cjk, 200, tr);
  TEST_ASSERT_TRUE(tr);
  TEST_ASSERT_EQUAL_UINT(600, out.size());
  // broken UTF-8 is repaired, never emitted raw
  std::string bad = sanitizeText(std::string("a\xE4\xBD") + "b", 200, tr);
  TEST_ASSERT_TRUE(validUtf8(bad));
  TEST_ASSERT_TRUE(bad.find('a') != std::string::npos && bad.find('b') != std::string::npos);
}

static void test_backoff_sequence() {
  Backoff b(1000, 30000);
  // sample 200 -> jitter factor exactly 1.0
  uint32_t want[] = {1000, 2000, 4000, 8000, 16000, 30000, 30000};
  for (uint32_t w : want) TEST_ASSERT_EQUAL_UINT32(w, b.next(200));
  b.reset();
  TEST_ASSERT_EQUAL_UINT32(1000, b.next(200));
}

static void test_backoff_jitter_bounds() {
  Backoff b(1000, 30000);
  uint32_t lo = b.next(0);
  Backoff c(1000, 30000);
  uint32_t hi = c.next(400);
  TEST_ASSERT_EQUAL_UINT32(800, lo);
  TEST_ASSERT_EQUAL_UINT32(1200, hi);
}

static void test_dedup_by_id() {
  DedupCache c;
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::None, (int)c.lookup("\"c_1\"", "", 0).kind);
  c.begin("\"c_1\"", "", 0);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::InFlight, (int)c.lookup("\"c_1\"", "", 10).kind);
  c.complete("\"c_1\"", "{resp}", "{res}", 20);
  auto l = c.lookup("\"c_1\"", "", 30);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::ReplayById, (int)l.kind);
  TEST_ASSERT_EQUAL_STRING("{resp}", l.payload.c_str());
}

static void test_dedup_by_key_and_errors() {
  DedupCache c;
  c.begin("\"a\"", "k1", 0);
  c.complete("\"a\"", "{ra}", "{res_a}", 1);
  auto l = c.lookup("\"b\"", "k1", 5);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::ReplayByKey, (int)l.kind);
  TEST_ASSERT_EQUAL_STRING("{res_a}", l.payload.c_str());
  // an error outcome is replayed by id but never by key
  c.begin("\"e\"", "k2", 10);
  c.complete("\"e\"", "{err}", "", 11);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::ReplayById, (int)c.lookup("\"e\"", "", 12).kind);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::None, (int)c.lookup("\"f\"", "k2", 12).kind);
}

static void test_dedup_expiry_and_capacity() {
  DedupCache c;
  c.begin("\"a\"", "", 0);
  c.complete("\"a\"", "{}", "{}", 0);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::ReplayById, (int)c.lookup("\"a\"", "", 59999).kind);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::None, (int)c.lookup("\"a\"", "", 60001).kind);
  DedupCache d;
  for (int i = 0; i < 40; i++) {
    std::string id = "\"x" + std::to_string(i) + "\"";
    d.begin(id, "", i);
    d.complete(id, "{}", "{}", i);
  }
  TEST_ASSERT_TRUE(d.size() <= 32);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::None, (int)d.lookup("\"x0\"", "", 50).kind);
  TEST_ASSERT_EQUAL((int)DedupCache::Kind::ReplayById, (int)d.lookup("\"x39\"", "", 50).kind);
}

void run_core_tests() {
  RUN_TEST(test_frame_roundtrip);
  RUN_TEST(test_error_code_names);
  RUN_TEST(test_sanitize_text);
  RUN_TEST(test_backoff_sequence);
  RUN_TEST(test_backoff_jitter_bounds);
  RUN_TEST(test_dedup_by_id);
  RUN_TEST(test_dedup_by_key_and_errors);
  RUN_TEST(test_dedup_expiry_and_capacity);
}
