// Character / state animation for the 320x240 face screen. Pure logic, no hardware, no allocation:
// the platform layer (pf_display.h) and the desktop preview (tools/preview) both draw the SAME
// FaceFrame, so what you see in the preview is what the formulas produce on the device.
//
// Style note: the look (rounded blob body + dark rounded eyes, spring animation, blinking, gaze) is
// inspired by the character study https://github.com/blessonism/grok-icon-study. All shapes here
// are ORIGINAL procedural drawings (superellipses, ellipses, lines, own parameters); no geometry
// data, SVG path or coordinates from that project are used (its assets belong to xAI, study only).
//
// Model:
//   base state  = turn state (idle / listening / thinking / speaking; "transcribing" counts as
//                 thinking; audio playback while the turn is idle counts as speaking)
//   expression  = optional overlay set by device.set_expression (happy sad angry surprised sleepy
//                 thinking confused love wink speaking). "neutral" clears the overlay. The overlay
//                 replaces eye / mouth / body posture, while the base state's effect layer
//                 (listening rings, thinking orbit, speaking bars) stays visible so the turn is still
//                 readable. An overlay may carry a TTL, after which the base state shows again.
//   Everything moves through damped springs, so every change is a smooth transition.
//
// Output coordinates are a virtual 320x240 screen; the renderer scales by (width / 320).
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>

namespace gc {

constexpr int kFaceW = 320;
constexpr int kFaceH = 240;

enum class TurnVis : uint8_t { Idle, Listening, Thinking, Speaking };
// "idle|listening|transcribing|thinking|speaking"; anything else -> Idle.
TurnVis turnVisFromState(const std::string& state);
const char* turnVisName(TurnVis v);

enum class FaceExpr : uint8_t { Neutral, Happy, Sad, Angry, Surprised, Sleepy, Thinking, Confused, Love, Wink, Speaking, Count };
bool faceExprFromName(const std::string& name, FaceExpr& out);  // false: unknown (out untouched)
const char* faceExprName(FaceExpr e);

// Where subtitle text sits; the character shrinks / moves away from it (smoothly).
enum class FaceTextLayout : uint8_t { None, Top, Center, Bottom };

enum class PrimType : uint8_t {
  Poly,     // filled polygon, points in FaceFrame::pts[off .. off+n); star-shaped around its centroid (fan fill)
  Ellipse,  // filled ellipse (x,y centre, rx,ry radii)
  Ring,     // ellipse outline, thick px wide (drawn inwards from rx,ry)
};

struct FacePrim {
  PrimType type = PrimType::Poly;
  uint8_t n = 0;
  uint16_t off = 0;
  uint32_t color = 0;  // 0xRRGGBB, already blended with the background (no alpha at draw time)
  float x = 0, y = 0, rx = 0, ry = 0, thick = 0;
};

struct FacePt { float x, y; };

constexpr int kFaceMaxPrims = 96;
constexpr int kFaceMaxPts = 800;
constexpr uint32_t kFaceBg = 0x0D0F14;

struct FaceFrame {
  uint32_t bg = kFaceBg;
  int nPrims = 0, nPts = 0, dropped = 0;  // dropped > 0: buffer overflow (must stay 0, tested)
  FacePrim prims[kFaceMaxPrims];          // painter's order, first = back
  FacePt pts[kFaceMaxPts];
  uint32_t accent = 0;                    // dominant accent colour of the frame (for LED / UI hints)
};

// Read-only view of the animator internals for tests / debugging.
struct FaceDebug {
  TurnVis base = TurnVis::Idle;
  FaceExpr expr = FaceExpr::Neutral;
  float ring = 0, orbit = 0, bars = 0;  // 0..1 effect intensities
  float eyeW[2] = {0, 0}, eyeH[2] = {0, 0};
  float bodySx = 1, bodySy = 1, layoutScale = 1;
  float blink = 0;
  uint32_t blinks = 0;
  uint32_t lastBlinkAt = 0;
};

class FaceAnimator {
 public:
  FaceAnimator();
  void reset(uint32_t nowMs, uint32_t seed = 0x9E3779B9u);

  // ---- inputs (cheap, may be called any time) ----
  void setTurn(TurnVis v);
  void setTurnState(const std::string& s) { setTurn(turnVisFromState(s)); }
  void setPlayback(bool active) { playback_ = active; }          // audio is playing (turn may still be idle)
  // Overlay. ttlMs = 0: until cleared. Returns false for an unknown name (treated as neutral).
  bool setExpression(const std::string& name, uint32_t nowMs, uint32_t ttlMs = 0);
  void setExpression(FaceExpr e, uint32_t nowMs, uint32_t ttlMs = 0);
  void clearExpression() { expr_ = FaceExpr::Neutral; exprUntil_ = 0; }
  void setLook(float x, float y);                                 // -1..1 each, eyes look there
  void setLevel(float level01);                                   // optional audio level for rings / bars / pulse
  void setTextLayout(FaceTextLayout l) { textLayout_ = l; }

  // ---- step + build the frame ----
  void update(uint32_t nowMs);
  const FaceFrame& frame() const { return frame_; }

  TurnVis turn() const { return turn_; }
  TurnVis effectiveBase() const;
  FaceExpr expression() const { return expr_; }
  FaceDebug debug() const;
  // True when every spring is within eps of its target (procedural idle motion is not counted).
  bool settled() const;

 private:
  struct Spring {
    float x = 0, v = 0, t = 0, k = 120, z = 0.8f;
    void step(float dt);
    void snap(float val) { x = t = val; v = 0; }
  };
  struct Eye {
    Spring w, h, lt, slant, lb, arch, dx, dy, heart;
  };
  enum { kFxRing, kFxOrbit, kFxBars, kFxBlush, kFxHearts, kFxZzz, kFxQuestion, kFxAlert, kFxTear, kFxAnger, kFxCount };

  int collect(Spring** out);
  void applyTargets(float t);
  void integrate(float dt);
  void build(float t);
  void scheduleBlink(uint32_t now);
  uint32_t rnd();
  float rndf() { return (rnd() & 0xFFFFFF) / 16777216.0f; }
  void blinkRange(uint32_t& lo, uint32_t& hi) const;

  // frame builders
  int addPts(const FacePt* p, int n);
  void emitPoly(const FacePt* local, int n, float ox, float oy, uint32_t color);
  void emitEllipse(float x, float y, float rx, float ry, uint32_t color);
  void emitRing(float x, float y, float rx, float ry, float thick, uint32_t color);
  void emitLine(float x0, float y0, float x1, float y1, float th, uint32_t color);
  void emitSuper(float x, float y, float rx, float ry, float n, uint32_t color, float rot = 0);
  void emitHeart(float x, float y, float size, uint32_t color);
  void emitZ(float x, float y, float size, uint32_t color);
  // character space (origin = ground contact, y up is negative) -> screen
  float sx(float x) const { return lCx_.x + x * lScale_.x; }
  float sy(float y) const { return lGround_.x + y * lScale_.x; }

  FaceFrame frame_;
  // inputs
  TurnVis turn_ = TurnVis::Idle, prevBase_ = TurnVis::Idle;
  FaceExpr expr_ = FaceExpr::Neutral, prevExpr_ = FaceExpr::Neutral;
  uint32_t exprUntil_ = 0;
  bool playback_ = false;
  float lookX_ = 0, lookY_ = 0, level_ = 0;
  FaceTextLayout textLayout_ = FaceTextLayout::None;
  // time
  bool started_ = false;
  uint32_t last_ = 0, startMs_ = 0;
  float tAcc_ = 0;
  uint32_t rng_ = 1;
  // blink
  uint32_t nextBlinkAt_ = 0, blinkEndAt_ = 0, blinks_ = 0, lastBlinkAt_ = 0;
  Spring blink_;
  // gaze wander
  uint32_t nextWanderAt_ = 0;
  float wanderX_ = 0, wanderY_ = 0;
  // springs
  Eye eye_[2];
  Spring bSx_, bSy_, bOy_, bTilt_, gazeX_, gazeY_, mW_, mH_, mCurve_, speakEnv_;
  Spring lScale_, lCx_, lGround_;
  Spring fx_[kFxCount];
  float bodyR_ = 0xF1, bodyG_ = 0xEF, bodyB_ = 0xE8;  // animated body tint
  float accR_ = 0, accG_ = 0, accB_ = 0;              // animated accent colour
  float tintT_[3] = {0xF1, 0xEF, 0xE8}, accT_[3] = {0, 0, 0};  // colour targets
  uint32_t accent_ = 0xFFFFFF;
  float pulse_ = 0;                                    // speaking rhythm 0..1 (procedural)
  // procedural additive motion (not sprung: faster than the body springs) set by applyTargets()
  float aSx_ = 0, aSy_ = 0, aOx_ = 0, aOy_ = 0, aTilt_ = 0;
  // precomputed unit shapes
  FacePt bodyU_[36], eyeU_[20];
  float s3_[36], c3_[36], s5_[36], c5_[36];
};

}  // namespace gc
