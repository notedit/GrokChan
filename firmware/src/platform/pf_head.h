// Pan/tilt head: two Feetech SCS (SCSCL) bus servos on UART1. Implements gc::IHead.
// Packet layout / registers / zero positions / 50 Hz streaming follow the official M5Stack
// StackChan firmware (MIT, hal_servo.cpp + FTServo_Arduino). 待实机确认: all of it on this
// Arduino implementation (pins, half-duplex behaviour, direction signs, speed scale, stall).
#pragma once
#include <Arduino.h>
#include <HardwareSerial.h>
#include <cmath>
#include <string>
#include "gc_hal.h"
#include "pf_config.h"

namespace pf {

class ScsBus {
 public:
  void begin(HardwareSerial& s) {
    s_ = &s;
    s_->setRxBufferSize(256);
    s_->begin(GC_SERVO_BAUD, SERIAL_8N1, GC_SERVO_RX_PIN, GC_SERVO_TX_PIN);
    s_->setTimeout(4);
  }
  // WRITE instruction; words are big-endian (SCSCL End=1 in the official lib). Waits for the status reply.
  bool write(uint8_t id, uint8_t addr, const uint8_t* d, uint8_t n) {
    if (!s_) return false;
    uint8_t pkt[16];
    uint8_t len = n + 3;  // inst + addr + n + chk
    pkt[0] = pkt[1] = 0xFF; pkt[2] = id; pkt[3] = len; pkt[4] = kInstWrite; pkt[5] = addr;
    uint8_t sum = id + len + kInstWrite + addr;
    for (uint8_t i = 0; i < n; i++) { pkt[6 + i] = d[i]; sum += d[i]; }
    pkt[6 + n] = ~sum;
    flushRx();
    s_->write(pkt, 7 + n);
    s_->flush();
    return ack(id);
  }
  bool writePos(uint8_t id, uint16_t pos, uint16_t timeMs, uint16_t speed) {
    uint8_t b[6] = {uint8_t(pos >> 8), uint8_t(pos), uint8_t(timeMs >> 8), uint8_t(timeMs), uint8_t(speed >> 8), uint8_t(speed)};
    return write(id, kRegGoalPos, b, 6);
  }
  bool torque(uint8_t id, bool on) { uint8_t v = on ? 1 : 0; return write(id, kRegTorque, &v, 1); }
  // READ 2 bytes (big-endian). false on timeout / bad frame.
  bool readWord(uint8_t id, uint8_t addr, int& out) {
    if (!s_) return false;
    uint8_t pkt[8] = {0xFF, 0xFF, id, 4, kInstRead, addr, 2, 0};
    pkt[7] = ~(uint8_t)(id + 4 + kInstRead + addr + 2);
    flushRx();
    s_->write(pkt, 8);
    s_->flush();
    if (!head()) return false;
    uint8_t r[6];  // id, len, err, d0, d1, chk
    if (s_->readBytes(r, 6) != 6) return false;
    if (r[0] != id || r[1] != 4) return false;
    uint8_t sum = ~(uint8_t)(r[0] + r[1] + r[2] + r[3] + r[4]);
    if (sum != r[5]) return false;
    out = (r[3] << 8) | r[4];
    return true;
  }
  bool readPos(uint8_t id, int& out) { return readWord(id, kRegPresentPos, out); }

 private:
  static constexpr uint8_t kInstRead = 2, kInstWrite = 3, kRegTorque = 40, kRegGoalPos = 42, kRegPresentPos = 56;
  void flushRx() { while (s_->available()) s_->read(); }
  bool head() {
    uint8_t prev = 0, b = 0;
    for (int i = 0; i < 12; i++) {
      if (s_->readBytes(&b, 1) != 1) return false;
      if (prev == 0xFF && b == 0xFF) return true;
      prev = b;
    }
    return false;
  }
  bool ack(uint8_t id) {
    if (!head()) return false;
    uint8_t r[4];  // id, len(2), err, chk
    if (s_->readBytes(r, 4) != 4) return false;
    return r[0] == id && r[1] == 2 && (uint8_t)~(uint8_t)(r[0] + r[1] + r[2]) == r[3];
  }
  HardwareSerial* s_ = nullptr;
};

class ScsHead : public gc::IHead {
 public:
  // Call after the PY32 enabled servo power. Reads the current positions (no motion).
  bool begin() {
    bus_.begin(Serial1);
    delay(50);
    int rp = 0, rt = 0;
    bool okp = bus_.readPos(GC_SERVO_ID_PAN, rp);
    bool okt = bus_.readPos(GC_SERVO_ID_TILT, rt);
    ready_ = okp && okt;
    curPan_ = tgtPan_ = okp ? rawToDeg(rp, GC_SERVO_ZERO_PAN, GC_SERVO_PAN_SIGN) : 0;
    curTilt_ = tgtTilt_ = okt ? rawToDeg(rt, GC_SERVO_ZERO_TILT, GC_SERVO_TILT_SIGN) : 0;
    if (!ready_) {
      ready_ = false;
      fault_ = true;
      faultReason_ = std::string("servo not answering at boot (pan ") + (okp ? "ok" : "no reply") + ", tilt " + (okt ? "ok" : "no reply") + ")";
    }
    lastStep_ = lastIdleCheck_ = millis();
    return ready_;
  }
  bool ready() const { return ready_; }

  bool moveTo(int pan, int tilt, int speed) override {
    if (!ready_ && !probe()) return false;
    if (torqueOff_) { bus_.torque(GC_SERVO_ID_PAN, true); bus_.torque(GC_SERVO_ID_TILT, true); torqueOff_ = false; }
    tgtPan_ = pan;
    tgtTilt_ = tilt;
    degPerS_ = std::max(5.0f, speed * GC_SERVO_DEG_PER_S_PER_SPEED);
    moving_ = true;
    lastStep_ = millis();
    lastMotion_ = lastStep_;
    return true;
  }
  bool getPose(gc::Pose& out) override {
    if (!ready_) return false;
    out.pan = (int)lroundf(curPan_);
    out.tilt = (int)lroundf(curTilt_);
    return true;
  }
  bool isMoving() override { return moving_; }
  void halt() override {
    if (!moving_) return;
    moving_ = false;
    tgtPan_ = curPan_;
    tgtTilt_ = curTilt_;
    writeBoth();  // hold where we are
  }
  bool takeFault(std::string& reason) override {
    if (!fault_) return false;
    fault_ = false;
    reason = faultReason_;
    return true;
  }
  void tick(uint32_t now) override {
    uint32_t period = 1000 / GC_SERVO_RAMP_HZ;
    if (moving_ && now - lastStep_ >= period) {
      float dt = (now - lastStep_) / 1000.0f;
      lastStep_ = now;
      float step = degPerS_ * dt;
      curPan_ = approach(curPan_, tgtPan_, step);
      curTilt_ = approach(curTilt_, tgtTilt_, step);
      writeBoth();
      if (curPan_ == tgtPan_ && curTilt_ == tgtTilt_) { moving_ = false; lastMotion_ = now; }
      else lastMotion_ = now;
    }
    if (!moving_) {
      // Idle watchdog: 1 read per second tells us whether the bus / servos are still alive.
      if (now - lastIdleCheck_ >= 1000) {
        lastIdleCheck_ = now;
        int r;
        bool ok = bus_.readPos(GC_SERVO_ID_PAN, r);
        noteResult(ok, "pan servo no reply");
      }
#if GC_SERVO_RELEASE_TORQUE_IDLE
      if (!torqueOff_ && ready_ && now - lastMotion_ > 2000) {
        bus_.torque(GC_SERVO_ID_PAN, false);
        bus_.torque(GC_SERVO_ID_TILT, false);
        torqueOff_ = true;
      }
#endif
    }
  }

 private:
  static float rawToDeg(int raw, int zero, int sign) { return sign * (raw - zero) * GC_SERVO_DEG_PER_STEP; }
  static int degToRaw(float deg, int zero, int sign) {
    int raw = zero + (int)lroundf(sign * deg / GC_SERVO_DEG_PER_STEP);
    if (raw < GC_SERVO_RAW_MIN) raw = GC_SERVO_RAW_MIN;
    if (raw > GC_SERVO_RAW_MAX) raw = GC_SERVO_RAW_MAX;
    return raw;
  }
  static float approach(float cur, float tgt, float step) {
    if (std::fabs(tgt - cur) <= step) return tgt;
    return cur + (tgt > cur ? step : -step);
  }
  bool probe() {  // a previous boot-time failure: try once more on demand
    int r;
    ready_ = bus_.readPos(GC_SERVO_ID_PAN, r) && bus_.readPos(GC_SERVO_ID_TILT, r);
    return ready_;
  }
  void writeBoth() {
    // Time=20 ms, speed=0, exactly like the official 50 Hz streaming (WritePos(id, raw, 20, 0)).
    bool a = bus_.writePos(GC_SERVO_ID_PAN, degToRaw(curPan_, GC_SERVO_ZERO_PAN, GC_SERVO_PAN_SIGN), 20, 0);
    bool b = bus_.writePos(GC_SERVO_ID_TILT, degToRaw(curTilt_, GC_SERVO_ZERO_TILT, GC_SERVO_TILT_SIGN), 20, 0);
    noteResult(a && b, a ? "tilt servo no reply" : "pan servo no reply");
  }
  void noteResult(bool ok, const char* why) {
    if (ok) { failStreak_ = 0; latched_ = false; return; }
    if (++failStreak_ >= 3 && !latched_) {
      latched_ = true;
      fault_ = true;
      faultReason_ = why;
      moving_ = false;  // stop streaming into a dead bus; the core cancels the pending motion
    }
  }

  ScsBus bus_;
  bool ready_ = false, moving_ = false, fault_ = false, latched_ = false, torqueOff_ = false;
  std::string faultReason_;
  float curPan_ = 0, curTilt_ = 0, tgtPan_ = 0, tgtTilt_ = 0, degPerS_ = 45;
  int failStreak_ = 0;
  uint32_t lastStep_ = 0, lastIdleCheck_ = 0, lastMotion_ = 0;
};

}  // namespace pf
