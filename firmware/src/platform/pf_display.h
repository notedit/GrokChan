// Face + text on the 320x240 CoreS3 display (M5GFX). Implements gc::IDisplay.
// Rendering is double-buffered through a PSRAM sprite when available. The look is a simple
// procedural avatar written for this project (not the official Stack-chan avatar).
// 待实机确认: frame rate, flicker, CJK glyph coverage of efontCN, layout of text positions.
#pragma once
#include <M5Unified.h>
#include <cmath>
#include <string>
#include <vector>
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
    dirty_ = true;
  }

  void setExpression(const std::string& n) override {
    static const char* names[] = {"neutral", "happy", "sad", "angry", "surprised", "sleepy", "thinking", "confused", "love", "wink", "speaking"};
    for (int i = 0; i < 11; i++) if (n == names[i]) { expr_ = i; dirty_ = true; return; }
    expr_ = 0; dirty_ = true;
  }
  void lookAt(int pan, int tilt) override {
    lookX_ = pan / 90.0f; lookY_ = -(tilt - 20) / 40.0f;  // tilt 20 deg ~ eyes centred
    lookX_ = std::fmax(-1.0f, std::fmin(1.0f, lookX_));
    lookY_ = std::fmax(-1.0f, std::fmin(1.0f, lookY_));
    dirty_ = true;
  }
  void setSpeaking(bool s) override { speaking_ = s; dirty_ = true; }
  void showText(const std::string& t, gc::TextPosition p, gc::TextSize s) override { text_ = t; tpos_ = p; tsize_ = s; dirty_ = true; }
  void clearText() override { text_.clear(); dirty_ = true; }

  void tick(uint32_t now) override {
    now_ = now;
    // blink scheduling
    if (now >= nextBlink_) { blinkUntil_ = now + 140; nextBlink_ = now + 2500 + (now * 2654435761u >> 20) % 3000; dirty_ = true; }
    bool blinking = now < blinkUntil_;
    if (blinking != wasBlinking_) { wasBlinking_ = blinking; dirty_ = true; }
    if (speaking_ || expr_ == 10) dirty_ = true;  // mouth animation
    if (!dirty_ || now - lastDraw_ < 66) return;  // <= 15 fps
    lastDraw_ = now;
    dirty_ = false;
    draw(blinking);
    if (useCanvas_) canvas_.pushSprite(&M5.Display, 0, 0);
  }

 private:
  void draw(bool blink) {
    auto& g = *g_;
    g.fillScreen(TFT_BLACK);
    const int ex1 = W_ / 2 - 62 + (int)(lookX_ * 10), ex2 = W_ / 2 + 62 + (int)(lookX_ * 10);
    const int ey = 112 + (int)(lookY_ * 8);
    const int R = 26;
    const uint16_t white = TFT_WHITE;
    int e = expr_;
    bool talking = speaking_ || e == 10;
    auto eye = [&](int x, int y, int r, bool closed) {
      if (closed) { g.fillRect(x - r, y - 2, 2 * r, 5, white); return; }
      g.fillCircle(x, y, r, white);
      g.fillCircle(x + (int)(lookX_ * 6), y + (int)(lookY_ * 6), r / 2, TFT_BLACK);
    };
    switch (e) {
      case 1:  // happy: ^ ^
        g.drawArc(ex1, ey + 14, R, R - 6, 215, 325, white);
        g.drawArc(ex2, ey + 14, R, R - 6, 215, 325, white);
        break;
      case 8:  // love: hearts
        for (int x : {ex1, ex2}) {
          g.fillCircle(x - 12, ey - 6, 14, TFT_RED); g.fillCircle(x + 12, ey - 6, 14, TFT_RED);
          g.fillTriangle(x - 25, ey, x + 25, ey, x, ey + 28, TFT_RED);
        }
        break;
      case 9:  // wink
        eye(ex1, ey, R, blink); eye(ex2, ey, R, true);
        break;
      case 4:  // surprised
        eye(ex1, ey, R + 8, false); eye(ex2, ey, R + 8, false);
        break;
      case 7:  // confused: different sizes
        eye(ex1, ey, R - 6, blink); eye(ex2, ey - 4, R + 6, blink);
        break;
      default:
        eye(ex1, ey, R, blink); eye(ex2, ey, R, blink);
        if (e == 2) {  // sad: lids slanting down-out
          g.fillTriangle(ex1 - R - 2, ey - R - 2, ex1 + R + 2, ey - R - 2, ex1 + R + 2, ey - 2, TFT_BLACK);
          g.fillTriangle(ex2 - R - 2, ey - R - 2, ex2 + R + 2, ey - R - 2, ex2 - R - 2, ey - 2, TFT_BLACK);
        } else if (e == 3) {  // angry: lids slanting down-in
          g.fillTriangle(ex1 - R - 2, ey - R - 2, ex1 + R + 2, ey - R - 2, ex1 - R - 2, ey - 2, TFT_BLACK);
          g.fillTriangle(ex2 - R - 2, ey - R - 2, ex2 + R + 2, ey - R - 2, ex2 + R + 2, ey - 2, TFT_BLACK);
        } else if (e == 5) {  // sleepy: upper half covered
          g.fillRect(ex1 - R - 2, ey - R - 2, 2 * R + 4, R + 2, TFT_BLACK);
          g.fillRect(ex2 - R - 2, ey - R - 2, 2 * R + 4, R + 2, TFT_BLACK);
        }
        break;
    }
    // mouth
    const int mx = W_ / 2 + (int)(lookX_ * 10), my = ey + 62;
    if (talking) {
      float o = 0.5f + 0.5f * sinf(now_ * 0.02f);
      int h = 4 + (int)(o * 22);
      g.fillEllipse(mx, my + h / 2, 22, h / 2 + 2, white);
    } else switch (e) {
      case 1: case 8: g.drawArc(mx, my - 10, 30, 25, 40, 140, white); break;                 // smile
      case 2: g.drawArc(mx, my + 24, 28, 23, 220, 320, white); break;                        // frown
      case 3: g.fillRect(mx - 22, my, 44, 5, white); break;                                  // flat
      case 4: g.fillEllipse(mx, my + 6, 12, 16, white); break;                               // "o"
      case 5: g.fillEllipse(mx, my + 4, 10, 6, white); break;
      case 7: g.drawLine(mx - 22, my + 6, mx + 22, my - 4, white); break;
      case 9: g.drawArc(mx, my - 10, 30, 25, 40, 140, white); break;
      default: g.fillRect(mx - 16, my, 32, 4, white); break;                                 // neutral
    }
    if (!text_.empty()) drawText();
  }

  void drawText() {
    auto& g = *g_;
    const lgfx::IFont* font = tsize_ == gc::TextSize::Small ? (const lgfx::IFont*)&lgfx::fonts::efontCN_12
                              : tsize_ == gc::TextSize::Large ? (const lgfx::IFont*)&lgfx::fonts::efontCN_24
                                                              : (const lgfx::IFont*)&lgfx::fonts::efontCN_16;
    g.setFont(font);
    g.setTextSize(1);
    g.setTextDatum(lgfx::top_left);
    const int pad = 8, maxW = W_ - 2 * pad - 8;
    std::vector<std::string> lines;
    std::string cur;
    size_t i = 0;
    while (i < text_.size()) {
      size_t l = 1;
      unsigned char c = text_[i];
      if (c >= 0xF0) l = 4; else if (c >= 0xE0) l = 3; else if (c >= 0xC0) l = 2;
      std::string ch = text_.substr(i, l);
      i += l;
      if (ch == "\n") { lines.push_back(cur); cur.clear(); continue; }
      if (g.textWidth((cur + ch).c_str()) > maxW && !cur.empty()) { lines.push_back(cur); cur.clear(); }
      cur += ch;
    }
    if (!cur.empty()) lines.push_back(cur);
    const int lh = g.fontHeight() + 2;
    const int maxLines = (tpos_ == gc::TextPosition::Center ? (H_ - 40) : 80) / lh;
    if ((int)lines.size() > maxLines && maxLines > 0) lines.resize(maxLines);
    const int bh = (int)lines.size() * lh + 12;
    int y0 = tpos_ == gc::TextPosition::Bottom ? H_ - bh - 4 : tpos_ == gc::TextPosition::Center ? (H_ - bh) / 2 : 4;
    g.fillRoundRect(pad - 4, y0, W_ - 2 * pad + 8, bh, 8, 0x2104);
    g.drawRoundRect(pad - 4, y0, W_ - 2 * pad + 8, bh, 8, TFT_DARKGREY);
    g.setTextColor(TFT_WHITE, 0x2104);
    int y = y0 + 6;
    for (auto& ln : lines) { g.setCursor(pad, y); g.print(ln.c_str()); y += lh; }
  }

  M5Canvas canvas_{&M5.Display};
  lgfx::LovyanGFX* g_ = &M5.Display;
  bool useCanvas_ = false, dirty_ = true, speaking_ = false, wasBlinking_ = false;
  int W_ = 320, H_ = 240, expr_ = 0;
  float lookX_ = 0, lookY_ = 0;
  std::string text_;
  gc::TextPosition tpos_ = gc::TextPosition::Bubble;
  gc::TextSize tsize_ = gc::TextSize::Medium;
  uint32_t now_ = 0, lastDraw_ = 0, nextBlink_ = 2000, blinkUntil_ = 0;
};

}  // namespace pf
