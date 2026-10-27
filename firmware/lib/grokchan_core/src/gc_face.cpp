// See gc_face.h. Style inspired by blessonism/grok-icon-study; all shapes are original procedural drawings.
#include "gc_face.h"
#include <algorithm>
#include <cmath>

namespace gc {
namespace {

constexpr float kPi = 3.14159265358979f;
constexpr float kTwoPi = 6.28318530717959f;

// Palette (RGB888). Dark screen, light blob, dark eyes.   待实机确认: colours on the real panel
constexpr uint32_t kBodyDefault = 0xF1EFE8;
constexpr uint32_t kEyeCol = 0x14161C;
constexpr uint32_t kShadow = 0x1B1E27;
constexpr uint32_t kAccIdle = 0x8A93A8;
constexpr uint32_t kAccListen = 0x38D6FF;
constexpr uint32_t kAccThink = 0xFFB938;
constexpr uint32_t kAccSpeak = 0x4DEB9A;
constexpr uint32_t kPink = 0xFF5C8A;
constexpr uint32_t kRed = 0xFF4D4D;
constexpr uint32_t kBlue = 0x62A8FF;
constexpr uint32_t kYellow = 0xFFE066;
constexpr uint32_t kZ = 0xB8C4FF;

constexpr float kBodyA = 74.0f, kBodyB = 62.0f;  // blob half width / height at rest (virtual px)

struct Rgb { float r, g, b; };
Rgb toRgb(uint32_t c) { return {float((c >> 16) & 255), float((c >> 8) & 255), float(c & 255)}; }
uint32_t packRgb(float r, float g, float b) {
  auto q = [](float v) { return uint32_t(std::min(255.0f, std::max(0.0f, v + 0.5f))); };
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
uint32_t mix(uint32_t a, uint32_t b, float f) {
  f = std::min(1.0f, std::max(0.0f, f));
  Rgb x = toRgb(a), y = toRgb(b);
  return packRgb(x.r + (y.r - x.r) * f, x.g + (y.g - x.g) * f, x.b + (y.b - x.b) * f);
}
float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
float sgnpow(float v, float e) { return v < 0 ? -std::pow(-v, e) : std::pow(v, e); }
float frac(float v) { return v - std::floor(v); }
bool finite(float v) { return std::isfinite(v); }

}  // namespace

// ------------------------------------------------------------------ names
TurnVis turnVisFromState(const std::string& s) {
  if (s == "listening") return TurnVis::Listening;
  if (s == "transcribing" || s == "thinking") return TurnVis::Thinking;
  if (s == "speaking") return TurnVis::Speaking;
  return TurnVis::Idle;
}
const char* turnVisName(TurnVis v) {
  switch (v) {
    case TurnVis::Idle: return "idle";
    case TurnVis::Listening: return "listening";
    case TurnVis::Thinking: return "thinking";
    case TurnVis::Speaking: return "speaking";
  }
  return "idle";
}

static const char* kExprNames[] = {"neutral", "happy", "sad", "angry", "surprised", "sleepy", "thinking", "confused", "love", "wink", "speaking"};
bool faceExprFromName(const std::string& n, FaceExpr& out) {
  for (int i = 0; i < (int)FaceExpr::Count; i++)
    if (n == kExprNames[i]) { out = (FaceExpr)i; return true; }
  return false;
}
const char* faceExprName(FaceExpr e) { return (int)e < (int)FaceExpr::Count ? kExprNames[(int)e] : "neutral"; }

// ------------------------------------------------------------------ spring
void FaceAnimator::Spring::step(float dt) {
  if (dt <= 0) return;
  int n = (int)std::ceil(dt / 0.008f);
  if (n < 1) n = 1;
  if (n > 40) n = 40;
  const float h = dt / n, c = 2.0f * z * std::sqrt(k);
  for (int i = 0; i < n; i++) {
    v += (k * (t - x) - c * v) * h;
    x += v * h;
  }
  if (!finite(x) || !finite(v)) { x = t; v = 0; }
}

// ------------------------------------------------------------------ setup
FaceAnimator::FaceAnimator() {
  for (int i = 0; i < 36; i++) {
    const float a = kTwoPi * i / 36.0f, c = std::cos(a), s = std::sin(a);
    bodyU_[i] = {sgnpow(c, 2.0f / 2.35f), sgnpow(s, 2.0f / 2.35f)};
    s3_[i] = std::sin(3 * a); c3_[i] = std::cos(3 * a);
    s5_[i] = std::sin(5 * a); c5_[i] = std::cos(5 * a);
  }
  for (int i = 0; i < 20; i++) {
    const float a = kTwoPi * i / 20.0f, c = std::cos(a), s = std::sin(a);
    eyeU_[i] = {sgnpow(c, 2.0f / 2.6f), sgnpow(s, 2.0f / 2.6f)};
  }
  reset(0);
}

void FaceAnimator::reset(uint32_t now, uint32_t seed) {
  Spring* sp[64];
  turn_ = prevBase_ = TurnVis::Idle;
  expr_ = prevExpr_ = FaceExpr::Neutral;
  exprUntil_ = 0; playback_ = false; lookX_ = lookY_ = level_ = 0;
  textLayout_ = FaceTextLayout::None;
  started_ = false; last_ = now; startMs_ = now; tAcc_ = 0;
  rng_ = seed ? seed : 1;
  nextBlinkAt_ = blinkEndAt_ = lastBlinkAt_ = 0; blinks_ = 0;
  nextWanderAt_ = 0; wanderX_ = wanderY_ = 0;
  frame_ = FaceFrame();
  for (auto& e : eye_) e = Eye();
  bSx_ = bSy_ = bOy_ = bTilt_ = gazeX_ = gazeY_ = mW_ = mH_ = mCurve_ = speakEnv_ = Spring();
  lScale_ = lCx_ = lGround_ = blink_ = Spring();
  for (auto& f : fx_) f = Spring();
  bSx_.x = bSx_.t = 1; bSy_.x = bSy_.t = 1;
  lScale_.x = lScale_.t = 1; lCx_.x = lCx_.t = 160; lGround_.x = lGround_.t = 196;
  int n = collect(sp);
  for (int i = 0; i < n; i++) { sp[i]->k = 200; sp[i]->z = 0.75f; }
  for (Spring* s : {&bSx_, &bSy_, &bOy_, &bTilt_}) { s->k = 260; s->z = 0.5f; }
  for (Spring* s : {&gazeX_, &gazeY_}) { s->k = 70; s->z = 0.85f; }
  for (Spring* s : {&lScale_, &lCx_, &lGround_}) { s->k = 70; s->z = 0.9f; }
  for (auto& f : fx_) { f.k = 50; f.z = 1.0f; }
  fx_[kFxAlert].k = 160; fx_[kFxAlert].z = 0.45f;  // pops
  speakEnv_.k = 40; speakEnv_.z = 1.0f;
  blink_.k = 900; blink_.z = 1.0f;
  for (auto& e : eye_) e.w.x = e.w.t = 11, e.h.x = e.h.t = 18;
  mW_.k = 120; mH_.k = 300; mCurve_.k = 200;
  bodyR_ = 0xF1; bodyG_ = 0xEF; bodyB_ = 0xE8;
  accR_ = accG_ = accB_ = 0; accent_ = kAccIdle;
  aSx_ = aSy_ = aOx_ = aOy_ = aTilt_ = pulse_ = 0;
}

int FaceAnimator::collect(Spring** o) {
  int n = 0;
  for (auto& e : eye_) for (Spring* s : {&e.w, &e.h, &e.lt, &e.slant, &e.lb, &e.arch, &e.dx, &e.dy, &e.heart}) o[n++] = s;
  for (Spring* s : {&bSx_, &bSy_, &bOy_, &bTilt_, &gazeX_, &gazeY_, &mW_, &mH_, &mCurve_, &speakEnv_, &lScale_, &lCx_, &lGround_, &blink_}) o[n++] = s;
  for (auto& f : fx_) o[n++] = &f;
  return n;
}

uint32_t FaceAnimator::rnd() {
  uint32_t x = rng_;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  rng_ = x ? x : 1;
  return rng_;
}

// ------------------------------------------------------------------ inputs
void FaceAnimator::setTurn(TurnVis v) { turn_ = v; }

bool FaceAnimator::setExpression(const std::string& name, uint32_t now, uint32_t ttl) {
  FaceExpr e = FaceExpr::Neutral;
  bool ok = faceExprFromName(name, e);
  setExpression(ok ? e : FaceExpr::Neutral, now, ttl);
  return ok;
}
void FaceAnimator::setExpression(FaceExpr e, uint32_t now, uint32_t ttl) {
  expr_ = e;
  exprUntil_ = (e != FaceExpr::Neutral && ttl) ? (now + ttl) : 0;
  if (exprUntil_ == 0 && e != FaceExpr::Neutral && ttl) exprUntil_ = 1;  // never collide with "no deadline"
}
void FaceAnimator::setLook(float x, float y) {
  lookX_ = finite(x) ? clampf(x, -1, 1) : 0;
  lookY_ = finite(y) ? clampf(y, -1, 1) : 0;
}
void FaceAnimator::setLevel(float l) { level_ = finite(l) ? clampf(l, 0, 1) : 0; }

TurnVis FaceAnimator::effectiveBase() const {
  if (expr_ == FaceExpr::Thinking) return TurnVis::Thinking;
  if (expr_ == FaceExpr::Speaking) return TurnVis::Speaking;
  if (turn_ == TurnVis::Idle && playback_) return TurnVis::Speaking;
  return turn_;
}

FaceDebug FaceAnimator::debug() const {
  FaceDebug d;
  d.base = effectiveBase(); d.expr = expr_;
  d.ring = fx_[kFxRing].x; d.orbit = fx_[kFxOrbit].x; d.bars = fx_[kFxBars].x;
  for (int i = 0; i < 2; i++) { d.eyeW[i] = eye_[i].w.x; d.eyeH[i] = eye_[i].h.x; }
  d.bodySx = bSx_.x; d.bodySy = bSy_.x; d.layoutScale = lScale_.x;
  d.blink = blink_.x; d.blinks = blinks_; d.lastBlinkAt = lastBlinkAt_;
  return d;
}

bool FaceAnimator::settled() const {
  Spring* sp[64];
  int n = const_cast<FaceAnimator*>(this)->collect(sp);
  for (int i = 0; i < n; i++) {
    if (sp[i] == &mH_ || sp[i] == &mCurve_ || sp[i] == &blink_) continue;
    if (std::fabs(sp[i]->x - sp[i]->t) > 0.02f || std::fabs(sp[i]->v) > 0.1f) return false;
  }
  return true;
}

void FaceAnimator::blinkRange(uint32_t& lo, uint32_t& hi) const {
  lo = hi = 0;  // 0 = no blinking
  switch (expr_) {
    case FaceExpr::Sleepy: case FaceExpr::Happy: case FaceExpr::Love: case FaceExpr::Wink: return;
    default: break;
  }
  switch (effectiveBase()) {
    case TurnVis::Idle: lo = 3000; hi = 6500; break;
    case TurnVis::Listening: lo = 4000; hi = 8000; break;
    case TurnVis::Thinking: lo = 3500; hi = 7000; break;
    case TurnVis::Speaking: lo = 2500; hi = 5500; break;
  }
}

void FaceAnimator::scheduleBlink(uint32_t now) {
  uint32_t lo, hi;
  blinkRange(lo, hi);
  if (hi == 0) { nextBlinkAt_ = 0; blink_.t = 0; return; }
  if (nextBlinkAt_ == 0 || (int32_t)(nextBlinkAt_ - now) > (int32_t)hi)
    nextBlinkAt_ = now + lo + rnd() % (hi - lo + 1);
  if (blinkEndAt_ && (int32_t)(now - blinkEndAt_) >= 0) { blinkEndAt_ = 0; blink_.t = 0; }
  if ((int32_t)(now - nextBlinkAt_) >= 0) {
    blink_.t = 1;
    blinkEndAt_ = now + 110;
    blinks_++;
    lastBlinkAt_ = now;
    // 15 %: a quick double blink
    nextBlinkAt_ = (rnd() % 100 < 15) ? now + 260 : now + lo + rnd() % (hi - lo + 1);
  }
}

// ------------------------------------------------------------------ targets
void FaceAnimator::applyTargets(float t) {
  const TurnVis base = effectiveBase();
  FaceExpr ex = expr_;
  if (ex == FaceExpr::Thinking || ex == FaceExpr::Speaking) ex = FaceExpr::Neutral;  // same look as the base state
  if (base != prevBase_ || ex != prevExpr_) {                                       // transition kick: squash & pop
    bSy_.v += 1.0f; bSx_.v -= 0.5f;
    prevBase_ = base; prevExpr_ = ex;
  }

  struct ET { float w = 11, h = 18, lt = 0, sl = 0, lb = 0, ar = 0, dx = 0, dy = 0, hr = 0; } e[2];
  float bsx = 1, bsy = 1, boy = 0, btilt = 0;
  float gx = 0, gy = 0;
  float mw = 0, mh = 0, mc = 0;
  float fx[kFxCount] = {0};
  uint32_t bodyTint = kBodyDefault, acc = kAccIdle;
  float breathA = 0.022f, breathT = 4.2f;
  aSx_ = aSy_ = aOx_ = aOy_ = aTilt_ = 0;

  // ---- base state
  switch (base) {
    case TurnVis::Idle:
      breathA = 0.022f; breathT = 4.2f;
      gx = wanderX_; gy = wanderY_;
      break;
    case TurnVis::Listening:
      for (auto& q : e) { q.w = 14; q.h = 23; q.dy = -2; }
      bsx = 1.06f; bsy = 1.08f; boy = 2; btilt = 0.05f;
      fx[kFxRing] = 1; acc = kAccListen; breathA = 0.02f; breathT = 2.2f;
      aTilt_ = 0.03f * std::sin(t * 0.9f);
      break;
    case TurnVis::Thinking:
      e[0].w = 10; e[0].h = 15; e[0].lt = 0.22f; e[0].sl = 0.4f;
      e[1].w = 10; e[1].h = 16;
      gx = 0.75f; gy = -0.85f;
      bsx = 0.96f; bsy = 0.97f; btilt = -0.10f;
      fx[kFxOrbit] = 1; acc = kAccThink; breathA = 0.015f; breathT = 3.0f;
      aOy_ = -2.0f * std::sin(kTwoPi * t / 2.6f);
      break;
    case TurnVis::Speaking:
      for (auto& q : e) { q.w = 12; q.h = 15; q.ar = 0.75f; }
      mw = 14; mh = 3; mc = 0;
      fx[kFxBars] = 1; fx[kFxBlush] = 0.3f; acc = kAccSpeak; breathA = 0.0f;
      break;
  }

  // ---- expression overlay
  switch (ex) {
    case FaceExpr::Happy:
      for (auto& q : e) { q.w = 12; q.h = 13; q.ar = 1; q.dy = -2; }
      bsx = 1.03f; mw = 15; mh = 8; mc = 1; fx[kFxBlush] = 1; bodyTint = 0xFFF3D0;
      aOy_ += -8.0f * std::fabs(std::sin(kPi * 1.6f * t));
      breathA = 0.01f; gx = lookX_; gy = 0;
      break;
    case FaceExpr::Sad:
      for (auto& q : e) { q.w = 11; q.h = 17; q.lt = 0.3f; q.dy = 4; }
      e[0].sl = -1.0f; e[1].sl = -1.0f;
      bsx = 1.04f; bsy = 0.9f; mw = 12; mh = 6; mc = -1; fx[kFxTear] = 1; bodyTint = 0xD8E3F4;
      gx = 0; gy = 0.5f; breathA = 0.012f; breathT = 5.0f; acc = kBlue;
      break;
    case FaceExpr::Angry:
      for (auto& q : e) { q.w = 12; q.h = 16; q.lt = 0.38f; }
      e[0].sl = 1.0f; e[1].sl = 1.0f;
      bsx = 1.05f; bsy = 0.94f; mw = 14; mh = 3; mc = 0; fx[kFxAnger] = 1; bodyTint = 0xF7C6BC;
      gx = 0; gy = 0.1f; breathA = 0.01f; acc = kRed;
      aOx_ = 1.6f * std::sin(kTwoPi * 17.0f * t);
      break;
    case FaceExpr::Surprised:
      for (auto& q : e) { q.w = 17; q.h = 21; q.dy = -3; }
      bsx = 0.94f; bsy = 1.14f; mw = 8; mh = 11; mc = 0; fx[kFxAlert] = 1; acc = kYellow;
      gx = lookX_; gy = 0; breathA = 0.01f;
      break;
    case FaceExpr::Sleepy: {
      const float c = std::max(0.0f, std::sin(kTwoPi * t / 7.0f));
      for (auto& q : e) { q.w = 13; q.h = 14; q.lt = 0.5f + 0.48f * c * c * c; q.dy = 4; }
      bsx = 1.04f; bsy = 0.95f; mw = 5; mh = 4; mc = 0; fx[kFxZzz] = 1; bodyTint = 0xE2E0EE; acc = kZ;
      gx = 0; gy = 0.3f; breathA = 0.05f; breathT = 5.5f;
      aTilt_ = 0.07f * std::sin(kTwoPi * t / 5.5f);
      break;
    }
    case FaceExpr::Confused:
      e[0].w = 9; e[0].h = 13;
      e[1].w = 14; e[1].h = 21; e[1].lt = 0.1f; e[1].sl = -0.3f;
      mw = 11; mh = 3; mc = 0.7f * std::sin(t * 2.0f); fx[kFxQuestion] = 1; acc = kYellow;
      gx = -0.3f; gy = -0.4f; breathA = 0.012f;
      aTilt_ = 0.14f * std::sin(t * 1.1f);
      break;
    case FaceExpr::Love: {
      for (auto& q : e) { q.hr = 1; q.w = 11; q.h = 17; }
      mw = 12; mh = 7; mc = 1; fx[kFxHearts] = 1; fx[kFxBlush] = 1; bodyTint = 0xFFDDE6; acc = kPink;
      breathA = 0.0f;
      const float s = std::max(0.0f, std::sin(kTwoPi * 1.7f * t));
      const float beat = s * s * s * s * s * s;
      aSy_ += 0.05f * beat; aSx_ += 0.05f * beat;
      break;
    }
    case FaceExpr::Wink:
      e[0].w = 12; e[0].h = 17;
      e[1].w = 12; e[1].h = 12; e[1].ar = 1;
      mw = 14; mh = 7; mc = 1; fx[kFxBlush] = 0.5f; btilt = 0.06f; breathA = 0.012f;
      gx = lookX_; gy = 0;
      break;
    default: break;
  }

  // ---- gaze (state gaze + explicit look)
  if (ex == FaceExpr::Neutral || ex == FaceExpr::Wink) {
    gx = clampf(gx + lookX_, -1, 1);
    gy = clampf(gy + lookY_, -1, 1);
  }
  gazeX_.t = gx; gazeY_.t = gy;

  // ---- speaking rhythm (procedural, additive; also on top of an expression overlay while audio plays)
  speakEnv_.t = base == TurnVis::Speaking ? 1.0f : 0.0f;
  if (speakEnv_.x > 0.01f) {
    const float amp = level_ > 0.02f ? level_ : 0.6f + 0.25f * std::sin(1.7f * t);
    const float w = 0.6f * (0.5f + 0.5f * std::sin(kTwoPi * 3.2f * t)) + 0.4f * (0.5f + 0.5f * std::sin(kTwoPi * 5.1f * t + 1.0f));
    pulse_ = clampf(w * amp, 0, 1) * speakEnv_.x;
    aSy_ += 0.075f * pulse_; aSx_ -= 0.03f * pulse_; aOy_ -= 3.0f * pulse_;
    if (base == TurnVis::Speaking && ex == FaceExpr::Neutral) mh = 3.0f + 10.0f * pulse_;
  } else {
    pulse_ = 0;
  }

  // ---- breathing
  const float br = breathA * std::sin(kTwoPi * t / breathT);
  aSy_ += br; aSx_ -= 0.5f * br;

  // ---- push targets
  for (int i = 0; i < 2; i++) {
    Eye& E = eye_[i];
    E.w.t = e[i].w; E.h.t = e[i].h; E.lt.t = e[i].lt; E.slant.t = e[i].sl; E.lb.t = e[i].lb;
    E.arch.t = e[i].ar; E.dx.t = e[i].dx; E.dy.t = e[i].dy; E.heart.t = e[i].hr;
  }
  bSx_.t = bsx; bSy_.t = bsy; bOy_.t = boy; bTilt_.t = btilt;
  mW_.t = mw; mH_.t = mh; mCurve_.t = mc;
  for (int i = 0; i < kFxCount; i++) fx_[i].t = fx[i];
  // layout
  switch (textLayout_) {
    case FaceTextLayout::None: lScale_.t = 1.0f; lCx_.t = 160; lGround_.t = 196; break;
    case FaceTextLayout::Bottom: lScale_.t = 0.7f; lCx_.t = 160; lGround_.t = 132; break;
    case FaceTextLayout::Top: lScale_.t = 0.7f; lCx_.t = 160; lGround_.t = 232; break;
    case FaceTextLayout::Center: lScale_.t = 0.42f; lCx_.t = 52; lGround_.t = 70; break;
  }
  // colours follow the target smoothly in integrate()
  const Rgb bt = toRgb(bodyTint), at = toRgb(acc);
  tintT_[0] = bt.r; tintT_[1] = bt.g; tintT_[2] = bt.b;
  accT_[0] = at.r; accT_[1] = at.g; accT_[2] = at.b;
}

void FaceAnimator::integrate(float dt) {
  Spring* sp[64];
  int n = collect(sp);
  for (int i = 0; i < n; i++) sp[i]->step(dt);
  const float f = 1.0f - std::exp(-7.0f * dt);
  bodyR_ += (tintT_[0] - bodyR_) * f; bodyG_ += (tintT_[1] - bodyG_) * f; bodyB_ += (tintT_[2] - bodyB_) * f;
  accR_ += (accT_[0] - accR_) * f; accG_ += (accT_[1] - accG_) * f; accB_ += (accT_[2] - accB_) * f;
  // gaze wander (idle only) is re-targeted in update()
}

// ------------------------------------------------------------------ update
void FaceAnimator::update(uint32_t now) {
  if (!started_) {
    started_ = true; last_ = now; startMs_ = now;
    nextWanderAt_ = now + 1500;
    applyTargets(0);
    Spring* sp[64];
    int n = collect(sp);
    for (int i = 0; i < n; i++) sp[i]->snap(sp[i]->t);
    bodyR_ = tintT_[0]; bodyG_ = tintT_[1]; bodyB_ = tintT_[2];
    accR_ = accT_[0]; accG_ = accT_[1]; accB_ = accT_[2];
    scheduleBlink(now);
  }
  int32_t diff = (int32_t)(now - last_);
  if (diff < 0) diff = 0;
  if (diff > 250) diff = 250;
  last_ = now;
  const float dt = diff / 1000.0f;
  tAcc_ += dt;
  if (exprUntil_ && (int32_t)(now - exprUntil_) >= 0) { expr_ = FaceExpr::Neutral; exprUntil_ = 0; }
  scheduleBlink(now);
  if (effectiveBase() == TurnVis::Idle && expr_ == FaceExpr::Neutral) {
    if ((int32_t)(now - nextWanderAt_) >= 0) {
      nextWanderAt_ = now + 1800 + rnd() % 2400;
      if (rnd() % 100 < 30) { wanderX_ = wanderY_ = 0; }
      else { wanderX_ = (rndf() - 0.5f); wanderY_ = (rndf() - 0.5f) * 0.5f; }
    }
  }
  applyTargets(tAcc_);
  integrate(dt);
  build(tAcc_);
}

// ------------------------------------------------------------------ emit helpers
int FaceAnimator::addPts(const FacePt* p, int n) {
  if (frame_.nPts + n > kFaceMaxPts) return -1;
  int off = frame_.nPts;
  for (int i = 0; i < n; i++) frame_.pts[off + i] = p[i];
  frame_.nPts += n;
  return off;
}

void FaceAnimator::emitPoly(const FacePt* ch, int n, float, float, uint32_t color) {
  if (frame_.nPrims >= kFaceMaxPrims || frame_.nPts + n > kFaceMaxPts) { frame_.dropped++; return; }
  FacePrim& pr = frame_.prims[frame_.nPrims++];
  pr.type = PrimType::Poly; pr.n = (uint8_t)n; pr.off = (uint16_t)frame_.nPts; pr.color = color;
  for (int i = 0; i < n; i++) frame_.pts[frame_.nPts + i] = {sx(ch[i].x), sy(ch[i].y)};
  frame_.nPts += n;
}

void FaceAnimator::emitEllipse(float x, float y, float rx, float ry, uint32_t color) {
  if (frame_.nPrims >= kFaceMaxPrims) { frame_.dropped++; return; }
  FacePrim& pr = frame_.prims[frame_.nPrims++];
  pr.type = PrimType::Ellipse; pr.color = color; pr.n = 0;
  pr.x = sx(x); pr.y = sy(y); pr.rx = rx * lScale_.x; pr.ry = ry * lScale_.x; pr.thick = 0;
}

void FaceAnimator::emitRing(float x, float y, float rx, float ry, float thick, uint32_t color) {
  if (frame_.nPrims >= kFaceMaxPrims) { frame_.dropped++; return; }
  FacePrim& pr = frame_.prims[frame_.nPrims++];
  pr.type = PrimType::Ring; pr.color = color; pr.n = 0;
  pr.x = sx(x); pr.y = sy(y); pr.rx = rx * lScale_.x; pr.ry = ry * lScale_.x;
  pr.thick = std::max(1.0f, thick * lScale_.x);
}

void FaceAnimator::emitLine(float x0, float y0, float x1, float y1, float th, uint32_t color) {
  float dx = x1 - x0, dy = y1 - y0, l = std::sqrt(dx * dx + dy * dy);
  if (l < 1e-3f) return;
  const float nx = -dy / l * th * 0.5f, ny = dx / l * th * 0.5f;
  FacePt q[4] = {{x0 + nx, y0 + ny}, {x1 + nx, y1 + ny}, {x1 - nx, y1 - ny}, {x0 - nx, y0 - ny}};
  emitPoly(q, 4, 0, 0, color);
}

void FaceAnimator::emitSuper(float x, float y, float rx, float ry, float n, uint32_t color, float rot) {
  FacePt q[20];
  const float cr = std::cos(rot), sr = std::sin(rot), ex = 2.0f / n;
  for (int i = 0; i < 20; i++) {
    const float a = kTwoPi * i / 20.0f;
    const float px = sgnpow(std::cos(a), ex) * rx, py = sgnpow(std::sin(a), ex) * ry;
    q[i] = {x + px * cr - py * sr, y + px * sr + py * cr};
  }
  emitPoly(q, 20, 0, 0, color);
}

void FaceAnimator::emitHeart(float x, float y, float size, uint32_t color) {
  FacePt q[24];
  const float k = size / 17.0f;
  for (int i = 0; i < 24; i++) {
    const float a = kTwoPi * i / 24.0f;
    const float hx = 16.0f * std::pow(std::sin(a), 3.0f);
    const float hy = 13.0f * std::cos(a) - 5.0f * std::cos(2 * a) - 2.0f * std::cos(3 * a) - std::cos(4 * a);
    q[i] = {x + hx * k, y - (hy + 2.5f) * k};  // flip to y-down, centre roughly on the visual centre
  }
  emitPoly(q, 24, 0, 0, color);
}

void FaceAnimator::emitZ(float x, float y, float s, uint32_t color) {
  const float th = std::max(1.5f, s * 0.38f);
  emitLine(x - s, y - s, x + s, y - s, th, color);
  emitLine(x + s, y - s, x - s, y + s, th, color);
  emitLine(x - s, y + s, x + s, y + s, th, color);
}

// ------------------------------------------------------------------ build
void FaceAnimator::build(float t) {
  FaceFrame& F = frame_;
  F.nPrims = 0; F.nPts = 0; F.dropped = 0; F.bg = kFaceBg;

  const float sxF = clampf(bSx_.x + aSx_, 0.6f, 1.5f), syF = clampf(bSy_.x + aSy_, 0.6f, 1.5f);
  const float tilt = clampf(bTilt_.x + aTilt_, -0.5f, 0.5f);
  const float A = kBodyA * sxF, B = kBodyB * syF;
  const float oy = bOy_.x + aOy_;                              // + = down, - = hop up
  const float ox = aOx_ + gazeX_.x * 3.0f;
  const float cy = -B + oy;                                    // body centre (char space, ground at y=0)
  const float hop = std::max(0.0f, -(oy));
  const uint32_t body = packRgb(bodyR_, bodyG_, bodyB_);
  const uint32_t acc = packRgb(accR_, accG_, accB_);
  F.accent = acc;
  const float ct = std::cos(tilt), st = std::sin(tilt);
  // body-relative feature coords -> character space (rotate with the blob)
  auto M = [&](float fx, float fy, float& ox2, float& oy2) {
    fx *= 0.5f + 0.5f * sxF; fy *= 0.5f + 0.5f * syF;
    ox2 = ox + fx * ct - fy * st;
    oy2 = cy + fx * st + fy * ct;
  };

  // --- layer 0: listening rings (behind everything)
  const float ring = clampf(fx_[kFxRing].x, 0, 1);
  if (ring > 0.02f) {
    const float thick = 2.0f + 3.0f * level_;
    for (int i = 0; i < 3; i++) {
      const float ph = frac(t / 1.6f + i / 3.0f);
      const float al = (1.0f - ph) * 0.85f * ring;
      if (al < 0.05f) continue;
      const float g = 1.06f + 0.55f * ph;
      emitRing(ox, cy, A * g, B * g, thick, mix(kFaceBg, acc, al));
    }
  }
  // --- layer 1: speaking bars (sides)
  const float bars = clampf(fx_[kFxBars].x, 0, 1);
  if (bars > 0.02f) {
    const float amp = level_ > 0.02f ? level_ : 0.55f + 0.3f * std::sin(1.3f * t);
    for (int sd = -1; sd <= 1; sd += 2) {
      for (int i = 0; i < 3; i++) {
        const float h = (8.0f + 34.0f * amp * (0.5f + 0.5f * std::sin(kTwoPi * 2.4f * t + i * 1.3f + sd * 0.8f))) * bars;
        const float x = ox + sd * (A + 16.0f + 13.0f * i);
        const uint32_t col = mix(kFaceBg, acc, 1.0f - 0.22f * i);
        emitSuper(x, cy, 3.2f, std::max(2.0f, h * 0.5f), 4.0f, col);
      }
    }
  }
  // --- layer 2: shadow
  {
    const float k = 1.0f / (1.0f + hop / 40.0f);
    emitEllipse(ox, 5, A * 0.82f * k, 7.0f * k, kShadow);
  }
  // --- layer 3: body blob
  {
    FacePt q[36];
    const float wob = 0.012f + 0.012f * speakEnv_.x + 0.01f * fx_[kFxOrbit].x;
    const float p1 = 1.3f * t, p2 = -1.9f * t;
    const float cp1 = std::cos(p1), sp1 = std::sin(p1), cp2 = std::cos(p2), sp2 = std::sin(p2);
    for (int i = 0; i < 36; i++) {
      const float w = 1.0f + wob * ((s3_[i] * cp1 + c3_[i] * sp1) + 0.6f * (s5_[i] * cp2 + c5_[i] * sp2));
      const float px = bodyU_[i].x * A * w, py = bodyU_[i].y * B * w;
      q[i] = {ox + px * ct - py * st, cy + px * st + py * ct};
    }
    emitPoly(q, 36, 0, 0, body);
  }
  // --- layer 4: mouth
  if (mW_.x > 0.8f && mH_.x > 0.3f) {
    float mx, my;
    M(gazeX_.x * 3.0f, 29.0f, mx, my);
    const float mw = mW_.x, mh = std::max(0.6f, mH_.x);
    emitSuper(mx, my, mw, mh, 2.0f, kEyeCol, tilt);
    const float c = clampf(mCurve_.x, -1.2f, 1.2f), ac = std::fabs(c);
    if (ac > 0.03f) {
      float mx2, my2;
      const float off = (c > 0 ? -1.0f : 1.0f) * (2.1f - 1.35f * std::min(1.0f, ac)) * mh;
      M(gazeX_.x * 3.0f, 29.0f + off, mx2, my2);
      emitSuper(mx2, my2, mw * 1.1f, mh * 1.05f, 2.0f, body, tilt);
    }
  }
  // --- layer 5: cheeks
  const float blush = clampf(fx_[kFxBlush].x, 0, 1);
  if (blush > 0.03f) {
    for (int sd = -1; sd <= 1; sd += 2) {
      float cx2, cy2;
      M(sd * 49.0f + gazeX_.x * 3.0f, 15.0f, cx2, cy2);
      emitSuper(cx2, cy2, 11.0f, 7.0f, 2.0f, mix(body, kPink, 0.55f * blush), tilt);
    }
  }
  // --- layer 6: eyes
  const float blinkV = clampf(blink_.x, 0, 1);
  for (int i = 0; i < 2; i++) {
    const Eye& E = eye_[i];
    const float hs = i == 0 ? -1.0f : 1.0f;
    const float heart = clampf(E.heart.x, 0, 1);
    const float ar = clampf(E.arch.x, 0, 1.2f);
    float ecx, ecy;
    M(hs * 32.0f + E.dx.x + gazeX_.x * 7.0f, -6.0f + E.dy.x + gazeY_.x * 5.0f, ecx, ecy);
    const float w = std::max(0.3f, E.w.x * (1.0f - heart));
    float h = E.h.x * (1.0f - heart) * (1.0f - 0.93f * blinkV * (1.0f - std::min(1.0f, ar)));
    h = std::max(0.3f, h);
    if (heart < 0.98f) {
      FacePt q[20];
      const float top0 = -h + clampf(E.lt.x, 0, 1) * 2.0f * h, sl = E.slant.x * 0.9f * h;
      const float bot = std::max(top0, h - clampf(E.lb.x, 0, 1) * 2.0f * h);
      for (int k = 0; k < 20; k++) {
        const float lx = eyeU_[k].x * w;
        float ly = eyeU_[k].y * h;
        const float top = top0 + sl * (-hs * lx / w);
        if (ly < top) ly = top;
        if (ly > std::max(top, bot)) ly = std::max(top, bot);
        // eye-local -> character space (rotated with the body)
        float px, py;
        M(hs * 32.0f + E.dx.x + gazeX_.x * 7.0f + lx, -6.0f + E.dy.x + gazeY_.x * 5.0f + ly, px, py);
        q[k] = {px, py};
      }
      emitPoly(q, 20, 0, 0, kEyeCol);
      if (ar > 0.03f) {  // smile-eye: cut a body-coloured ellipse from the lower part -> crescent
        float mx, my;
        M(hs * 32.0f + E.dx.x + gazeX_.x * 7.0f, -6.0f + E.dy.x + gazeY_.x * 5.0f + (2.1f - 1.35f * std::min(1.0f, ar)) * h, mx, my);
        emitSuper(mx, my, w * 1.25f, h * 1.05f, 2.0f, body, tilt);
      } else if (h > 6.0f && w > 6.0f) {  // small highlight
        float hx, hy;
        M(hs * 32.0f + E.dx.x + gazeX_.x * 7.0f - 0.32f * w, -6.0f + E.dy.x + gazeY_.x * 5.0f - 0.38f * h, hx, hy);
        emitEllipse(hx, hy, 2.3f, 2.3f, body);
      }
    }
    if (heart > 0.02f) {
      const float beat = 1.0f + 0.08f * std::sin(kTwoPi * 1.7f * t);
      emitHeart(ecx, ecy, 21.0f * heart * beat, kPink);
    }
  }
  // --- layer 7: front effects
  const float top = cy - B;  // body top
  const float hearts = clampf(fx_[kFxHearts].x, 0, 1);
  if (hearts > 0.05f) {
    for (int i = 0; i < 3; i++) {
      const float ph = frac(t / 2.6f + i / 3.0f);
      const float al = std::sin(ph * kPi) * hearts;
      emitHeart(ox + (i - 1) * 46.0f + 8.0f * std::sin(t * 2.0f + i * 2.0f), top - 4.0f - ph * 54.0f, 7.0f + 2.0f * i, mix(kFaceBg, kPink, al));
    }
  }
  const float zzz = clampf(fx_[kFxZzz].x, 0, 1);
  if (zzz > 0.05f) {
    for (int i = 0; i < 2; i++) {
      const float ph = frac(t / 3.6f + i * 0.5f);
      const float al = std::sin(ph * kPi) * zzz;
      emitZ(ox + A * 0.55f + i * 16.0f + ph * 10.0f, top + 4.0f - ph * 42.0f, 5.0f + 3.0f * i, mix(kFaceBg, kZ, al));
    }
  }
  const float q = clampf(fx_[kFxQuestion].x, 0, 1);
  if (q > 0.05f) {
    const float s = 13.0f * q, qx = ox + A * 0.55f, qy = top - 18.0f + 2.0f * std::sin(t * 2.4f);
    const uint32_t col = mix(kFaceBg, kYellow, q);
    FacePt prev = {0, 0};
    for (int i = 0; i <= 8; i++) {
      const float a = (170.0f - 250.0f * i / 8.0f) * kPi / 180.0f;
      FacePt p = {qx + 0.5f * s * std::cos(a), qy - 0.5f * s - 0.5f * s * std::sin(a)};
      if (i) emitLine(prev.x, prev.y, p.x, p.y, 0.26f * s, col);
      prev = p;
    }
    emitLine(prev.x, prev.y, qx, qy + 0.5f * s, 0.26f * s, col);
    emitSuper(qx, qy + 1.05f * s, 0.16f * s, 0.16f * s, 2.0f, col);
  }
  const float al = clampf(fx_[kFxAlert].x, 0, 1.4f);
  if (al > 0.05f) {
    for (int i = -1; i <= 1; i++) {
      const float dx = i * 0.6f, dy = i == 0 ? -1.0f : -0.8f;
      const float bx = ox + i * 30.0f, by = top + (i == 0 ? -4.0f : 8.0f);
      emitLine(bx + dx * 6.0f, by + dy * 6.0f, bx + dx * (6.0f + 15.0f * al), by + dy * (6.0f + 15.0f * al), 3.5f, kYellow);
    }
  }
  const float tear = clampf(fx_[kFxTear].x, 0, 1);
  if (tear > 0.05f) {
    const float ph = frac(t / 2.4f);
    float ex2, ey2;
    M(-32.0f - 5.0f, -6.0f + eye_[0].dy.x + eye_[0].h.x * 0.5f, ex2, ey2);
    const float y = ey2 + ph * 36.0f, r = 4.6f * (1.0f - ph * ph * ph) * tear;
    if (r > 0.6f) {
      emitSuper(ex2, y, r, r, 2.0f, kBlue);
      FacePt tri[3] = {{ex2, y - r * 2.2f}, {ex2 - r * 0.9f, y - r * 0.35f}, {ex2 + r * 0.9f, y - r * 0.35f}};
      emitPoly(tri, 3, 0, 0, kBlue);
    }
  }
  const float an = clampf(fx_[kFxAnger].x, 0, 1);
  if (an > 0.05f) {
    const float s = (4.0f + 2.0f * (0.5f + 0.5f * std::sin(8.0f * t))) * an;
    const float ax = ox + A * 0.6f, ay = cy - B * 0.55f;
    for (int a = -1; a <= 1; a += 2)
      for (int b = -1; b <= 1; b += 2) {
        emitLine(ax + a * s * 0.8f, ay + b * s * 0.8f, ax + a * s * 2.6f, ay + b * s * 0.8f, 2.4f, kRed);
        emitLine(ax + a * s * 0.8f, ay + b * s * 0.8f, ax + a * s * 0.8f, ay + b * s * 2.6f, 2.4f, kRed);
      }
  }
  const float orb = clampf(fx_[kFxOrbit].x, 0, 1);
  if (orb > 0.02f) {
    const float rx = A * 1.17f + 4.0f, ry = B * 1.17f + 4.0f;
    for (int k = 0; k < 6; k++) {
      const float a = 2.6f * t - k * 0.26f;
      const float r = (7.0f - k * 0.9f) * orb;
      emitSuper(ox + rx * std::cos(a), cy + ry * std::sin(a), r, r, 2.0f, mix(kFaceBg, acc, 1.0f - k * 0.13f));
    }
  }

  // sanitise (never hand NaN to a renderer)
  for (int i = 0; i < F.nPts; i++) {
    if (!finite(F.pts[i].x)) F.pts[i].x = 0;
    if (!finite(F.pts[i].y)) F.pts[i].y = 0;
  }
  for (int i = 0; i < F.nPrims; i++) {
    FacePrim& p = F.prims[i];
    if (!finite(p.x)) p.x = 0;
    if (!finite(p.y)) p.y = 0;
    if (!finite(p.rx)) p.rx = 0;
    if (!finite(p.ry)) p.ry = 0;
  }
}

}  // namespace gc
