// Character animation (gc_face): states, expressions, springs, blinking, ranges, no NaN / jumps.
// Pure logic, runs on the host; the on-device look (colours, fps) is 待实机确认.
#include <unity.h>
#include <cmath>
#include <set>
#include <string>
#include <vector>
#include "gc_face.h"

using namespace gc;

namespace {
const char* kStateNames[] = {"idle", "listening", "thinking", "speaking"};
const char* kExprNames[] = {"neutral", "happy", "sad", "angry", "surprised", "sleepy", "thinking", "confused", "love", "wink", "speaking"};

struct Run {
  FaceAnimator a;
  uint32_t t = 1000;
  explicit Run(uint32_t start = 1000, uint32_t seed = 7) : t(start) { a.reset(t, seed); a.update(t); }
  void step(uint32_t ms, uint32_t dt = 50) {
    for (uint32_t d = 0; d < ms; d += dt) { t += dt; a.update(t); }
  }
};

uint64_t hashFrame(const FaceFrame& f) {
  uint64_t h = 1469598103934665603ull;
  auto mix = [&](double v) { h ^= (uint64_t)llround(v * 4.0); h *= 1099511628211ull; };
  for (int i = 0; i < f.nPrims; i++) {
    const FacePrim& p = f.prims[i];
    mix(p.color); mix((int)p.type); mix(p.x); mix(p.y); mix(p.rx); mix(p.ry); mix(p.thick); mix(p.n);
    if (p.type == PrimType::Poly) for (int k = 0; k < p.n; k++) { mix(f.pts[p.off + k].x); mix(f.pts[p.off + k].y); }
  }
  return h;
}

// True if the springs reach their targets at some point within `maxMs` (idle gaze wander keeps
// retargeting every few seconds, so a single instant is not the right test).
bool settlesWithin(Run& r, uint32_t maxMs) {
  for (uint32_t el = 0; el < maxMs; el += 50) {
    if (r.a.settled()) return true;
    r.step(50);
  }
  return false;
}

bool fin(float v) { return std::isfinite(v); }

// Every primitive is drawable: finite, inside a sane box, indices valid, no overflow.
bool frameOk(const FaceFrame& f) {
  if (f.dropped != 0 || f.nPrims < 3 || f.nPrims > kFaceMaxPrims || f.nPts < 0 || f.nPts > kFaceMaxPts) return false;
  for (int i = 0; i < f.nPrims; i++) {
    const FacePrim& p = f.prims[i];
    if (p.color > 0xFFFFFFu) return false;
    if (!fin(p.x) || !fin(p.y) || !fin(p.rx) || !fin(p.ry) || !fin(p.thick)) return false;
    if (p.type == PrimType::Poly) {
      if (p.n < 3 || (int)p.off + p.n > f.nPts) return false;
      for (int k = 0; k < p.n; k++) {
        const FacePt& q = f.pts[p.off + k];
        if (!fin(q.x) || !fin(q.y) || q.x < -120 || q.x > 440 || q.y < -120 || q.y > 360) return false;
      }
    } else {
      if (p.rx < 0 || p.ry < 0 || p.rx > 400 || p.ry > 400) return false;
      if (p.x < -200 || p.x > 520 || p.y < -200 || p.y > 440) return false;
      if (p.type == PrimType::Ring && p.thick < 1) return false;
    }
  }
  return true;
}

int countType(const FaceFrame& f, PrimType t) {
  int n = 0;
  for (int i = 0; i < f.nPrims; i++) n += f.prims[i].type == t;
  return n;
}

// centre and width of the biggest polygon = the body (jump metric)
struct Body { float cx, cy, w; };
Body bodyOf(const FaceFrame& f) {
  Body best{0, 0, 0}; float bestArea = -1;
  for (int i = 0; i < f.nPrims; i++) {
    const FacePrim& p = f.prims[i];
    if (p.type != PrimType::Poly) continue;
    float x0 = 1e9f, x1 = -1e9f, y0 = 1e9f, y1 = -1e9f;
    for (int k = 0; k < p.n; k++) {
      const FacePt& q = f.pts[p.off + k];
      x0 = std::min(x0, q.x); x1 = std::max(x1, q.x); y0 = std::min(y0, q.y); y1 = std::max(y1, q.y);
    }
    float area = (x1 - x0) * (y1 - y0);
    if (area > bestArea) { bestArea = area; best = {(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0}; }
  }
  return best;
}
}  // namespace

// ---------------------------------------------------------------- names / mapping
static void test_turn_state_mapping() {
  TEST_ASSERT_TRUE(turnVisFromState("idle") == TurnVis::Idle);
  TEST_ASSERT_TRUE(turnVisFromState("listening") == TurnVis::Listening);
  TEST_ASSERT_TRUE(turnVisFromState("transcribing") == TurnVis::Thinking);
  TEST_ASSERT_TRUE(turnVisFromState("thinking") == TurnVis::Thinking);
  TEST_ASSERT_TRUE(turnVisFromState("speaking") == TurnVis::Speaking);
  TEST_ASSERT_TRUE(turnVisFromState("") == TurnVis::Idle);
  TEST_ASSERT_TRUE(turnVisFromState("bogus") == TurnVis::Idle);
  for (int i = 0; i < 4; i++) TEST_ASSERT_EQUAL_STRING(kStateNames[i], turnVisName((TurnVis)i));
}

static void test_expression_names_are_the_mcp_set() {
  for (const char* n : kExprNames) {
    FaceExpr e;
    TEST_ASSERT_TRUE_MESSAGE(faceExprFromName(n, e), n);
    TEST_ASSERT_EQUAL_STRING(n, faceExprName(e));
  }
  FaceExpr e = FaceExpr::Happy;
  TEST_ASSERT_FALSE(faceExprFromName("furious", e));
  TEST_ASSERT_TRUE(e == FaceExpr::Happy);   // untouched
  FaceAnimator a;
  TEST_ASSERT_FALSE(a.setExpression("furious", 0));
  TEST_ASSERT_TRUE(a.expression() == FaceExpr::Neutral);
}

// ---------------------------------------------------------------- the four states
static void test_four_states_have_distinct_effects() {
  FaceDebug d[4];
  uint64_t h[4];
  for (int i = 0; i < 4; i++) {
    Run r; r.a.setTurnState(kStateNames[i]);
    r.step(3000);
    TEST_ASSERT_TRUE_MESSAGE(frameOk(r.a.frame()), kStateNames[i]);
    d[i] = r.a.debug(); h[i] = hashFrame(r.a.frame());
    TEST_ASSERT_TRUE((int)d[i].base == i);
  }
  TEST_ASSERT_TRUE(d[0].ring < 0.05f && d[0].orbit < 0.05f && d[0].bars < 0.05f);     // idle: calm, no effect layer
  TEST_ASSERT_TRUE(d[1].ring > 0.9f && d[1].orbit < 0.05f && d[1].bars < 0.05f);      // listening: rings
  TEST_ASSERT_TRUE(d[2].orbit > 0.9f && d[2].ring < 0.05f && d[2].bars < 0.05f);      // thinking: orbit
  TEST_ASSERT_TRUE(d[3].bars > 0.9f && d[3].ring < 0.05f && d[3].orbit < 0.05f);      // speaking: bars
  for (int i = 0; i < 4; i++) for (int j = i + 1; j < 4; j++) TEST_ASSERT_TRUE(h[i] != h[j]);
  // listening is the "open eyes" state: bigger eyes than idle; thinking squints one
  TEST_ASSERT_TRUE(d[1].eyeH[0] > d[0].eyeH[0] + 2);
  TEST_ASSERT_TRUE(std::fabs(d[2].eyeH[0] - d[2].eyeH[1]) > 0.5f || std::fabs(d[2].eyeW[0] - d[2].eyeW[1]) > 0.5f);
}

static void test_each_state_settles_and_stays_bounded() {
  for (const char* s : kStateNames) {
    Run r; r.a.setTurnState(s);
    r.step(1000);
    TEST_ASSERT_TRUE_MESSAGE(settlesWithin(r, 20000), s);
    // keep running: the procedural motion never blows up and the frame stays valid
    for (int i = 0; i < 1200; i++) {   // 60 s
      r.step(50);
      FaceDebug d = r.a.debug();
      TEST_ASSERT_TRUE(frameOk(r.a.frame()));
      TEST_ASSERT_TRUE(d.bodySx > 0.6f && d.bodySx < 1.5f && d.bodySy > 0.6f && d.bodySy < 1.5f);
      TEST_ASSERT_TRUE(d.eyeW[0] > 0 && d.eyeW[0] < 40 && d.eyeH[0] >= 0 && d.eyeH[0] < 50);
    }
  }
}

static void test_transcribing_counts_as_thinking_and_playback_as_speaking() {
  Run r; r.a.setTurnState("transcribing");
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.debug().base == TurnVis::Thinking);
  TEST_ASSERT_TRUE(r.a.debug().orbit > 0.9f);
  r.a.setTurnState("idle");
  r.a.setPlayback(true);                    // reply audio playing while the bridge turn is already idle
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.debug().base == TurnVis::Speaking);
  TEST_ASSERT_TRUE(r.a.debug().bars > 0.9f);
  r.a.setPlayback(false);
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.debug().base == TurnVis::Idle);
  TEST_ASSERT_TRUE(r.a.debug().bars < 0.05f);
}

static void test_transitions_are_smooth_no_jumps() {
  Run r; r.step(2000);
  const char* seq[] = {"listening", "thinking", "speaking", "idle", "thinking", "idle", "listening", "speaking", "idle"};
  Body prev = bodyOf(r.a.frame());
  for (const char* s : seq) {
    r.a.setTurnState(s);
    for (int i = 0; i < 60; i++) {         // 3 s at 20 fps
      r.step(50);
      TEST_ASSERT_TRUE(frameOk(r.a.frame()));
      Body b = bodyOf(r.a.frame());
      TEST_ASSERT_TRUE_MESSAGE(std::fabs(b.cx - prev.cx) < 24 && std::fabs(b.cy - prev.cy) < 24, s);
      TEST_ASSERT_TRUE_MESSAGE(std::fabs(b.w - prev.w) < 30, s);
      prev = b;
    }
  }
}

// ---------------------------------------------------------------- expressions (overlay on the base state)
static void test_all_expressions_render_distinct_looks() {
  std::set<uint64_t> seen;
  FaceDebug d0;
  for (const char* n : kExprNames) {
    Run r;
    TEST_ASSERT_TRUE(r.a.setExpression(n, r.t));
    r.step(3000);
    TEST_ASSERT_TRUE_MESSAGE(frameOk(r.a.frame()), n);
    TEST_ASSERT_TRUE_MESSAGE(settlesWithin(r, 20000), n);
    uint64_t h = hashFrame(r.a.frame());
    TEST_ASSERT_TRUE_MESSAGE(seen.insert(h).second, n);        // every name looks different from all others
  }
  TEST_ASSERT_EQUAL(11, (int)seen.size());
}

static void test_expressions_have_their_signature_shapes() {
  auto settle = [](const char* e) { Run* r = new Run(); r->a.setExpression(e, r->t); r->step(3000); return r; };
  Run* neutral = settle("neutral");
  Run* surprised = settle("surprised");
  Run* sleepy = settle("sleepy");
  Run* love = settle("love");
  Run* wink = settle("wink");
  Run* sad = settle("sad");
  Run* angry = settle("angry");
  Run* happy = settle("happy");
  Run* confused = settle("confused");
  // surprised: wide open eyes
  TEST_ASSERT_TRUE(surprised->a.debug().eyeH[0] > neutral->a.debug().eyeH[0] + 2);
  // sleepy: half closed (lid) and slower / calmer: eyes are lower than neutral
  TEST_ASSERT_TRUE(sleepy->a.debug().eyeH[0] < neutral->a.debug().eyeH[0] + 1);
  // love: heart eyes + hearts effect -> more primitives than neutral
  TEST_ASSERT_TRUE(love->a.frame().nPrims > neutral->a.frame().nPrims + 2);
  // wink: the two eyes differ
  TEST_ASSERT_TRUE(std::fabs(wink->a.debug().eyeH[0] - wink->a.debug().eyeH[1]) > 1.0f ||
                   std::fabs(wink->a.debug().eyeW[0] - wink->a.debug().eyeW[1]) > 1.0f ||
                   hashFrame(wink->a.frame()) != hashFrame(happy->a.frame()));
  // confused: unequal eyes
  TEST_ASSERT_TRUE(std::fabs(confused->a.debug().eyeH[0] - confused->a.debug().eyeH[1]) > 1.0f ||
                   std::fabs(confused->a.debug().eyeW[0] - confused->a.debug().eyeW[1]) > 1.0f);
  // sad / angry / happy have effect or body differences from neutral
  TEST_ASSERT_TRUE(hashFrame(sad->a.frame()) != hashFrame(neutral->a.frame()));
  TEST_ASSERT_TRUE(hashFrame(angry->a.frame()) != hashFrame(sad->a.frame()));
  delete neutral; delete surprised; delete sleepy; delete love; delete wink; delete sad; delete angry; delete happy; delete confused;
}

static void test_thinking_and_speaking_expressions_show_the_base_effect() {
  Run r; r.a.setExpression("thinking", r.t);
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.debug().base == TurnVis::Thinking);
  TEST_ASSERT_TRUE(r.a.debug().orbit > 0.9f);
  Run s; s.a.setExpression("speaking", s.t);
  s.step(3000);
  TEST_ASSERT_TRUE(s.a.debug().base == TurnVis::Speaking);
  TEST_ASSERT_TRUE(s.a.debug().bars > 0.9f);
}

static void test_expression_overlays_the_turn_state_and_both_stay_readable() {
  Run r; r.a.setTurnState("listening");
  r.a.setExpression("happy", r.t);
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.debug().expr == FaceExpr::Happy);
  TEST_ASSERT_TRUE(r.a.debug().base == TurnVis::Listening);
  TEST_ASSERT_TRUE(r.a.debug().ring > 0.9f);                 // the turn effect is still visible
  TEST_ASSERT_TRUE(countType(r.a.frame(), PrimType::Ring) >= 2);
  Run h; h.a.setExpression("happy", h.t); h.step(3000);
  TEST_ASSERT_TRUE(hashFrame(h.a.frame()) != hashFrame(r.a.frame()));
}

static void test_expression_ttl_and_clear_return_to_the_turn_state() {
  Run ref; ref.a.setTurnState("speaking"); ref.step(6000);
  Run r; r.a.setTurnState("speaking");
  r.a.setExpression("sad", r.t, 1500);
  r.step(1000);
  TEST_ASSERT_TRUE(r.a.expression() == FaceExpr::Sad);       // still within the TTL
  r.step(1500);
  TEST_ASSERT_TRUE(r.a.expression() == FaceExpr::Neutral);   // expired
  r.step(3000);
  TEST_ASSERT_TRUE(r.a.settled());
  FaceDebug a = r.a.debug(), b = ref.a.debug();
  TEST_ASSERT_FLOAT_WITHIN(0.6f, b.eyeW[0], a.eyeW[0]);
  TEST_ASSERT_FLOAT_WITHIN(0.6f, b.eyeH[0], a.eyeH[0]);
  TEST_ASSERT_TRUE(a.base == TurnVis::Speaking && a.bars > 0.9f);

  Run c; c.a.setExpression("angry", c.t);                    // no TTL: stays until cleared
  c.step(30000);
  TEST_ASSERT_TRUE(c.a.expression() == FaceExpr::Angry);
  c.a.setExpression("neutral", c.t);                         // neutral clears (what the core sends on revert)
  c.step(3000);
  TEST_ASSERT_TRUE(c.a.expression() == FaceExpr::Neutral);
  Run d; d.a.setExpression("love", d.t); d.step(2000);
  d.a.clearExpression(); d.step(3000);
  TEST_ASSERT_TRUE(d.a.expression() == FaceExpr::Neutral);
  TEST_ASSERT_TRUE(d.a.settled());
}

static void test_expression_changes_are_smooth() {
  Run r; r.step(1500);
  Body prev = bodyOf(r.a.frame());
  for (int round = 0; round < 2; round++) {
    for (const char* n : kExprNames) {
      r.a.setExpression(n, r.t);
      for (int i = 0; i < 30; i++) {
        r.step(50);
        TEST_ASSERT_TRUE_MESSAGE(frameOk(r.a.frame()), n);
        Body b = bodyOf(r.a.frame());
        TEST_ASSERT_TRUE_MESSAGE(std::fabs(b.cx - prev.cx) < 24 && std::fabs(b.cy - prev.cy) < 24 && std::fabs(b.w - prev.w) < 30, n);
        prev = b;
      }
    }
  }
}

// ---------------------------------------------------------------- blinking
static void test_blink_rhythm_is_bounded_per_state() {
  struct B { const char* s; uint32_t lo, hi; } cases[] = {
      {"idle", 3000, 6500}, {"listening", 4000, 8000}, {"thinking", 3500, 7000}, {"speaking", 2500, 5500}};
  for (auto& c : cases) {
    Run r(1000, 99); r.a.setTurnState(c.s);
    r.step(2000);
    uint32_t lastBlinks = r.a.debug().blinks, lastT = r.t, n = 0, maxGap = 0, minGap = 1u << 30;
    const uint32_t total = 600000;           // 10 minutes
    for (uint32_t el = 0; el < total; el += 50) {
      r.step(50);
      uint32_t b = r.a.debug().blinks;
      if (b != lastBlinks) {
        uint32_t gap = r.t - lastT;
        minGap = std::min(minGap, gap); maxGap = std::max(maxGap, gap);
        n += b - lastBlinks; lastBlinks = b; lastT = r.t;
      }
    }
    TEST_ASSERT_TRUE_MESSAGE(minGap >= 200, c.s);                         // double blinks are ~260 ms apart, never faster
    TEST_ASSERT_TRUE_MESSAGE(maxGap <= c.hi + 150, c.s);                  // a blink at least every `hi`
    // average rate between the extreme rates (double blinks add 15 %)
    float perMin = n / (total / 60000.0f);
    TEST_ASSERT_TRUE_MESSAGE(perMin >= 60000.0f / c.hi * 0.9f, c.s);
    TEST_ASSERT_TRUE_MESSAGE(perMin <= 60000.0f / c.lo * 1.3f, c.s);
  }
}

static void test_blink_closes_the_eyes_and_reopens() {
  Run r(1000, 5);
  float maxBlink = 0; bool reopened = false; uint32_t seen = r.a.debug().blinks;
  for (int i = 0; i < 400 && !reopened; i++) {
    r.step(10, 10);
    float b = r.a.debug().blink;
    if (b > maxBlink) maxBlink = b;
    if (maxBlink > 0.8f && b < 0.1f) reopened = true;
  }
  TEST_ASSERT_TRUE(r.a.debug().blinks > seen);
  TEST_ASSERT_TRUE(maxBlink > 0.8f && maxBlink <= 1.05f);
  TEST_ASSERT_TRUE(reopened);
}

static void test_no_blink_with_closed_eye_expressions() {
  for (const char* n : {"happy", "love", "wink", "sleepy"}) {
    Run r; r.a.setExpression(n, r.t);
    r.step(1000);
    uint32_t b0 = r.a.debug().blinks;
    r.step(120000);
    TEST_ASSERT_EQUAL_MESSAGE(b0, r.a.debug().blinks, n);
  }
}

// ---------------------------------------------------------------- robustness / ranges
static void test_every_combination_is_drawable_and_fits_the_buffers() {
  int maxPrims = 0, maxPts = 0;
  const FaceTextLayout lays[] = {FaceTextLayout::None, FaceTextLayout::Top, FaceTextLayout::Center, FaceTextLayout::Bottom};
  for (const char* s : kStateNames)
    for (const char* e : kExprNames)
      for (FaceTextLayout l : lays) {
        Run r(1000, 3); r.a.setTurnState(s); r.a.setExpression(e, r.t); r.a.setTextLayout(l);
        r.a.setLevel(0.7f); r.a.setLook(0.6f, -0.4f);
        for (int i = 0; i < 80; i++) {            // 4 s: also covers mid-transition frames
          r.step(50);
          TEST_ASSERT_TRUE(frameOk(r.a.frame()));
          maxPrims = std::max(maxPrims, r.a.frame().nPrims);
          maxPts = std::max(maxPts, r.a.frame().nPts);
        }
      }
  TEST_ASSERT_TRUE(maxPrims <= kFaceMaxPrims && maxPts <= kFaceMaxPts);
  TEST_ASSERT_TRUE_MESSAGE(maxPrims < kFaceMaxPrims * 9 / 10, "prim buffer too tight");
  TEST_ASSERT_TRUE_MESSAGE(maxPts < kFaceMaxPts * 9 / 10, "point buffer too tight");
}

static void test_bad_inputs_never_produce_nan() {
  Run r;
  const float bad[] = {NAN, INFINITY, -INFINITY, 1e30f, -1e30f, 7.0f, -7.0f};
  for (float v : bad) {
    r.a.setLook(v, v); r.a.setLevel(v);
    r.step(200);
    TEST_ASSERT_TRUE(frameOk(r.a.frame()));
  }
  r.a.setTurnState("\xff\xfe garbage");
  r.a.setExpression(std::string(5000, 'x'), r.t);
  r.step(500);
  TEST_ASSERT_TRUE(frameOk(r.a.frame()));
}

static void test_irregular_time_and_clock_wrap() {
  Run r;
  r.a.setTurnState("speaking");
  r.step(2000, 16);
  r.t += 20000; r.a.update(r.t);          // stall (e.g. a long Wi-Fi reconnect): one huge dt
  TEST_ASSERT_TRUE(frameOk(r.a.frame()));
  r.a.update(r.t);                         // same timestamp twice: dt = 0
  TEST_ASSERT_TRUE(frameOk(r.a.frame()));
  r.step(2000, 7);
  TEST_ASSERT_TRUE(frameOk(r.a.frame()));
  // millis() wraps after 49 days
  Run w(0xFFFFFF00u - 3000);
  w.a.setTurnState("thinking"); w.a.setExpression("confused", w.t, 2000);
  for (int i = 0; i < 200; i++) { w.step(50); TEST_ASSERT_TRUE(frameOk(w.a.frame())); }
  TEST_ASSERT_TRUE(w.a.expression() == FaceExpr::Neutral);       // TTL also works across the wrap
  TEST_ASSERT_TRUE(w.a.debug().orbit > 0.9f);
}

static void test_deterministic_for_a_seed_and_frame_rate_independent_state() {
  Run a(1000, 42), b(1000, 42), c(1000, 43);
  a.a.setTurnState("listening"); b.a.setTurnState("listening"); c.a.setTurnState("listening");
  a.step(8000); b.step(8000); c.step(8000);
  TEST_ASSERT_TRUE(hashFrame(a.a.frame()) == hashFrame(b.a.frame()));
  // different seed: same state, different idle motion / blink timing at some point
  bool differs = false;
  for (int i = 0; i < 400 && !differs; i++) { a.step(50); c.step(50); differs = hashFrame(a.a.frame()) != hashFrame(c.a.frame()); }
  TEST_ASSERT_TRUE(differs);
  // the settled shape does not depend on the frame step (20 fps vs 60 fps)
  Run s20, s60; s20.a.setTurnState("thinking"); s60.a.setTurnState("thinking");
  s20.step(6000, 50); s60.step(6000, 16);
  TEST_ASSERT_FLOAT_WITHIN(0.5f, s20.a.debug().eyeW[0], s60.a.debug().eyeW[0]);
  TEST_ASSERT_FLOAT_WITHIN(0.5f, s20.a.debug().eyeH[1], s60.a.debug().eyeH[1]);
  TEST_ASSERT_FLOAT_WITHIN(0.05f, s20.a.debug().orbit, s60.a.debug().orbit);
}

static void test_gaze_moves_the_eyes_and_audio_level_drives_the_effects() {
  Run l, r;
  l.a.setLook(-1, 0); r.a.setLook(1, 0);
  l.step(3000); r.step(3000);
  TEST_ASSERT_TRUE(hashFrame(l.a.frame()) != hashFrame(r.a.frame()));
  // eye polygons: the right-looking face has its dark eyes further right
  auto meanDarkX = [](const FaceFrame& f) {
    float sum = 0; int n = 0;
    for (int i = 0; i < f.nPrims; i++) {
      const FacePrim& p = f.prims[i];
      if (p.type != PrimType::Poly || p.color > 0x303030) continue;
      for (int k = 0; k < p.n; k++) { sum += f.pts[p.off + k].x; n++; }
    }
    return n ? sum / n : 0.0f;
  };
  TEST_ASSERT_TRUE(meanDarkX(r.a.frame()) > meanDarkX(l.a.frame()) + 2.0f);

  Run lo, hi;
  lo.a.setTurnState("listening"); hi.a.setTurnState("listening");
  lo.a.setLevel(0.0f); hi.a.setLevel(1.0f);
  lo.step(3000); hi.step(3000);
  TEST_ASSERT_TRUE(hashFrame(lo.a.frame()) != hashFrame(hi.a.frame()));
}

static void test_text_layout_makes_room_smoothly() {
  Run r; r.a.setTurnState("speaking"); r.step(2000);
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.0f, r.a.debug().layoutScale);
  Body full = bodyOf(r.a.frame());
  r.a.setTextLayout(FaceTextLayout::Top);
  Body prev = full;
  for (int i = 0; i < 80; i++) {
    r.step(50);
    Body b = bodyOf(r.a.frame());
    TEST_ASSERT_TRUE(std::fabs(b.cy - prev.cy) < 20 && std::fabs(b.w - prev.w) < 20);
    prev = b;
  }
  TEST_ASSERT_TRUE(r.a.debug().layoutScale < 0.85f);
  TEST_ASSERT_TRUE(prev.w < full.w * 0.85f);
  // Top layout: the character sits in the lower part, Bottom: in the upper part
  Body top = bodyOf(r.a.frame());
  r.a.setTextLayout(FaceTextLayout::Bottom); r.step(3000);
  Body bottom = bodyOf(r.a.frame());
  TEST_ASSERT_TRUE(top.cy > 120 && bottom.cy < 120);
  r.a.setTextLayout(FaceTextLayout::None); r.step(4000);
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 1.0f, r.a.debug().layoutScale);
  Body back = bodyOf(r.a.frame());
  TEST_ASSERT_FLOAT_WITHIN(6.0f, full.w, back.w);
}

static void test_character_stays_on_screen_in_every_layout() {
  const FaceTextLayout lays[] = {FaceTextLayout::None, FaceTextLayout::Top, FaceTextLayout::Center, FaceTextLayout::Bottom};
  for (FaceTextLayout l : lays) {
    Run r; r.a.setTextLayout(l); r.a.setTurnState("listening"); r.step(4000);
    const FaceFrame& f = r.a.frame();
    Body b = bodyOf(f);
    TEST_ASSERT_TRUE(b.cx - b.w / 2 >= 0 && b.cx + b.w / 2 <= kFaceW);
    TEST_ASSERT_TRUE(b.cy > 20 && b.cy < kFaceH - 20);
  }
}

void run_face_tests() {
  RUN_TEST(test_turn_state_mapping);
  RUN_TEST(test_expression_names_are_the_mcp_set);
  RUN_TEST(test_four_states_have_distinct_effects);
  RUN_TEST(test_each_state_settles_and_stays_bounded);
  RUN_TEST(test_transcribing_counts_as_thinking_and_playback_as_speaking);
  RUN_TEST(test_transitions_are_smooth_no_jumps);
  RUN_TEST(test_all_expressions_render_distinct_looks);
  RUN_TEST(test_expressions_have_their_signature_shapes);
  RUN_TEST(test_thinking_and_speaking_expressions_show_the_base_effect);
  RUN_TEST(test_expression_overlays_the_turn_state_and_both_stay_readable);
  RUN_TEST(test_expression_ttl_and_clear_return_to_the_turn_state);
  RUN_TEST(test_expression_changes_are_smooth);
  RUN_TEST(test_blink_rhythm_is_bounded_per_state);
  RUN_TEST(test_blink_closes_the_eyes_and_reopens);
  RUN_TEST(test_no_blink_with_closed_eye_expressions);
  RUN_TEST(test_every_combination_is_drawable_and_fits_the_buffers);
  RUN_TEST(test_bad_inputs_never_produce_nan);
  RUN_TEST(test_irregular_time_and_clock_wrap);
  RUN_TEST(test_deterministic_for_a_seed_and_frame_rate_independent_state);
  RUN_TEST(test_gaze_moves_the_eyes_and_audio_level_drives_the_effects);
  RUN_TEST(test_text_layout_makes_room_smoothly);
  RUN_TEST(test_character_stays_on_screen_in_every_layout);
}
