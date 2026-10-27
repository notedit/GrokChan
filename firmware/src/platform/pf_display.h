// Character UI + subtitles on the 320x240 CoreS3 display (M5GFX). Implements gc::IDisplay.
// All animation maths live in the hardware-free gc::FaceAnimator (lib/grokchan_core/src/gc_face.*);
// this file only rasterises the FaceFrame it produces (filled polygons as triangle fans, ellipses,
// rings) into a PSRAM sprite and pushes it once per frame. The desktop preview draws the very same
// primitives (tools/preview), so the shapes are identical; only anti-aliasing differs.
// Turn state (idle / listening / thinking / speaking) is the base look; setExpression() overlays it.
// 待实机确认: frame rate / SPI push cost, colours on the panel, CJK glyph coverage of efontCN,
// subtitle vs character layout.
#pragma once
#include <M5Unified.h>
#include <cmath>
#include <string>
#include <vector>
#include "gc_face.h"
#include "gc_hal.h"
#include "pf_config.h"

namespace pf {

class M5Face : public gc::IDisplay {
 public:
  void begin() {
    // CoreS3 default rotation is already 320x240 landscape; 待实机确认
    W_ = M5.Display.width();
    H_ = M5.Display.height();
    canvas_.setColorDepth(16);
    canvas_.setPsram(true);
    useCanvas_ = canvas_.createSprite(W_, H_) != nullptr;
    g_ = useCanvas_ ? (lgfx::LovyanGFX*)&canvas_ : (lgfx::LovyanGFX*)&M5.Display;
    face_.reset(millis());
    dirty_ = true;
  }

  void setExpression(const std::string& n) override { face_.setExpression(n, now_); dirty_ = true; }
  void lookAt(int pan, int tilt) override {
    // tilt 20 deg ~ eyes centred
    face_.setLook(std::fmax(-1.0f, std::fmin(1.0f, pan / 90.0f)), std::fmax(-1.0f, std::fmin(1.0f, -(tilt - 20) / 40.0f)));
  }
  void setSpeaking(bool s) override { face_.setPlayback(s); }
  void setTurnState(const std::string& s) override { face_.setTurnState(s); }
  void setAudioLevel(float l) override { face_.setLevel(l); }
  void showText(const std::string& t, gc::TextPosition p, gc::TextSize s) override {
    text_ = t; tpos_ = p; tsize_ = s;
    layoutText();
    dirty_ = true;
  }
  void clearText() override {
    text_.clear(); lines_.clear();
    face_.setTextLayout(gc::FaceTextLayout::None);
    dirty_ = true;
  }

  void tick(uint32_t now) override {
    now_ = now;
    if (now - lastDraw_ < kFrameMs) return;  // 20 fps cap; the character always animates (breathing)
    lastDraw_ = now;
    face_.update(now);
    draw();
    if (useCanvas_) canvas_.pushSprite(&M5.Display, 0, 0);
  }

 private:
  static constexpr uint32_t kFrameMs = 50;  // 待实机确认: raise / lower after measuring the push time

  uint16_t c565(uint32_t rgb) const { return g_->color565((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF); }

  void draw() {
    auto& g = *g_;
    const gc::FaceFrame& f = face_.frame();
    const float sc = W_ / (float)gc::kFaceW;
    g.fillScreen(c565(f.bg));
    for (int i = 0; i < f.nPrims; i++) {
      const gc::FacePrim& p = f.prims[i];
      const uint16_t col = c565(p.color);
      switch (p.type) {
        case gc::PrimType::Poly: {
          if (p.n < 3) break;
          const gc::FacePt* q = f.pts + p.off;
          float cx = 0, cy = 0;
          for (int k = 0; k < p.n; k++) { cx += q[k].x; cy += q[k].y; }
          cx = cx / p.n * sc; cy = cy / p.n * sc;
          for (int k = 0; k < p.n; k++) {
            const gc::FacePt& a = q[k];
            const gc::FacePt& b = q[(k + 1) % p.n];
            g.fillTriangle((int)lroundf(cx), (int)lroundf(cy), (int)lroundf(a.x * sc), (int)lroundf(a.y * sc),
                           (int)lroundf(b.x * sc), (int)lroundf(b.y * sc), col);
          }
          break;
        }
        case gc::PrimType::Ellipse:
          g.fillEllipse((int)lroundf(p.x * sc), (int)lroundf(p.y * sc), (int)lroundf(p.rx * sc), (int)lroundf(p.ry * sc), col);
          break;
        case gc::PrimType::Ring: {
          const int th = std::max(1, (int)lroundf(p.thick * sc));
          const int rx = (int)lroundf(p.rx * sc), ry = (int)lroundf(p.ry * sc);
          for (int k = 0; k < th && rx - k > 0 && ry - k > 0; k++)
            g.drawEllipse((int)lroundf(p.x * sc), (int)lroundf(p.y * sc), rx - k, ry - k, col);
          break;
        }
      }
    }
    if (!text_.empty()) drawText();
  }

  // Wrap the subtitle for the current font and tell the character where to go.
  void layoutText() {
    auto& g = *g_;
    const lgfx::IFont* font = tsize_ == gc::TextSize::Small ? (const lgfx::IFont*)&lgfx::fonts::efontCN_12
                              : tsize_ == gc::TextSize::Large ? (const lgfx::IFont*)&lgfx::fonts::efontCN_24
                                                              : (const lgfx::IFont*)&lgfx::fonts::efontCN_16;
    g.setFont(font);
    g.setTextSize(1);
    const int pad = 8, maxW = W_ - 2 * pad - 8;
    lines_.clear();
    std::string cur;
    size_t i = 0;
    while (i < text_.size()) {
      size_t l = 1;
      unsigned char c = text_[i];
      if (c >= 0xF0) l = 4; else if (c >= 0xE0) l = 3; else if (c >= 0xC0) l = 2;
      std::string ch = text_.substr(i, l);
      i += l;
      if (ch == "\n") { lines_.push_back(cur); cur.clear(); continue; }
      if (g.textWidth((cur + ch).c_str()) > maxW && !cur.empty()) { lines_.push_back(cur); cur.clear(); }
      cur += ch;
    }
    if (!cur.empty()) lines_.push_back(cur);
    lh_ = g.fontHeight() + 2;
    const int maxLines = (tpos_ == gc::TextPosition::Center ? (H_ - 40) : 80) / lh_;
    if ((int)lines_.size() > maxLines && maxLines > 0) lines_.resize(maxLines);
    // the character gives way: text on top -> it sits low; text at the bottom -> it sits high
    face_.setTextLayout(tpos_ == gc::TextPosition::Bottom   ? gc::FaceTextLayout::Bottom
                        : tpos_ == gc::TextPosition::Center ? gc::FaceTextLayout::Center
                                                            : gc::FaceTextLayout::Top);
  }

  void drawText() {
    auto& g = *g_;
    const lgfx::IFont* font = tsize_ == gc::TextSize::Small ? (const lgfx::IFont*)&lgfx::fonts::efontCN_12
                              : tsize_ == gc::TextSize::Large ? (const lgfx::IFont*)&lgfx::fonts::efontCN_24
                                                              : (const lgfx::IFont*)&lgfx::fonts::efontCN_16;
    g.setFont(font);
    g.setTextSize(1);
    g.setTextDatum(lgfx::top_left);
    const int pad = 8;
    const int bh = (int)lines_.size() * lh_ + 12;
    int y0 = tpos_ == gc::TextPosition::Bottom ? H_ - bh - 4 : tpos_ == gc::TextPosition::Center ? (H_ - bh) / 2 : 4;
    g.fillRoundRect(pad - 4, y0, W_ - 2 * pad + 8, bh, 8, 0x2104);
    g.drawRoundRect(pad - 4, y0, W_ - 2 * pad + 8, bh, 8, TFT_DARKGREY);
    g.setTextColor(TFT_WHITE, 0x2104);
    int y = y0 + 6;
    for (auto& ln : lines_) { g.setCursor(pad, y); g.print(ln.c_str()); y += lh_; }
  }

  M5Canvas canvas_{&M5.Display};
  lgfx::LovyanGFX* g_ = &M5.Display;
  gc::FaceAnimator face_;
  bool useCanvas_ = false, dirty_ = true;
  int W_ = 320, H_ = 240, lh_ = 18;
  std::string text_;
  std::vector<std::string> lines_;
  gc::TextPosition tpos_ = gc::TextPosition::Bubble;
  gc::TextSize tsize_ = gc::TextSize::Medium;
  uint32_t now_ = 0, lastDraw_ = 0;
};

}  // namespace pf
