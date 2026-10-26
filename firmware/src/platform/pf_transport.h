// gc::ITransport on links2004/WebSockets. The core owns the reconnect backoff, so the library's own
// auto-reconnect is only allowed while an attempt is "active" (between connect() and the first
// disconnect). Caveats (documented in README): WebSocketsClient::loop() blocks inside a TCP connect
// for up to ~5 s, and the library reports no close code (we report 1006).
#pragma once
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <string>
#include "gc_hal.h"
#include "pf_config.h"

namespace pf {

class WsTransport : public gc::ITransport {
 public:
  WsTransport() {
    ws_.onEvent([this](WStype_t t, uint8_t* p, size_t n) { onEvent(t, p, n); });
    ws_.setReconnectInterval(3000);
  }
  void setListener(gc::ITransportListener* l) override { l_ = l; }

  void connect() override {
    if (active_) ws_.disconnect();
    wantConnect_ = true;
    active_ = false;
    connected_ = false;
    maybeBegin();
  }
  void disconnect() override {
    wantConnect_ = false;
    bool was = connected_;
    if (active_) ws_.disconnect();
    active_ = false;
    connected_ = false;
    (void)was;  // the core initiated it; no onTransportClosed callback
  }
  bool isConnected() override { return connected_; }
  bool sendText(const std::string& s) override {
    if (!connected_) return false;
#if GC_LOG_PROTOCOL
    Serial.printf("TX> %s\n", s.c_str());
#endif
    return ws_.sendTXT((const uint8_t*)s.data(), s.size());
  }
  bool sendBinary(const uint8_t* d, size_t n) override { return connected_ && ws_.sendBIN(d, n); }
  void loop() override {
    if (wantConnect_ && !active_) maybeBegin();  // WiFi may have come up since connect()
    if (active_) ws_.loop();
  }

 private:
  void maybeBegin() {
    if (!wantConnect_ || active_ || WiFi.status() != WL_CONNECTED) return;
    static const char* kPath = GC_WS_PATH "?device_id=" GC_DEVICE_ID;
#if GC_SERVER_TLS
    ws_.beginSSL(GC_SERVER_HOST, GC_SERVER_PORT, kPath);  // no CA configured => library uses setInsecure()
#else
    ws_.begin(GC_SERVER_HOST, GC_SERVER_PORT, kPath);
#endif
    active_ = true;
  }
  void onEvent(WStype_t type, uint8_t* p, size_t n) {
    switch (type) {
      case WStype_CONNECTED:
        connected_ = true;
        if (l_) l_->onTransportConnected();
        break;
      case WStype_DISCONNECTED: {
        bool was = connected_;
        connected_ = false;
        active_ = false;  // stop pumping the lib; the core decides when to reconnect
        wantConnect_ = false;
        (void)was;
        if (l_) l_->onTransportClosed(1006);  // library gives no close code
        break;
      }
      case WStype_TEXT:
#if GC_LOG_PROTOCOL
        Serial.printf("RX< %.*s\n", (int)n, (const char*)p);
#endif
        if (l_) l_->onTransportText((const char*)p, n);
        break;
      case WStype_BIN:
        if (l_) l_->onTransportBinary(p, n);
        break;
      default: break;  // PING/PONG (handled by lib), ERROR, FRAGMENT_* (lib reassembles)
    }
  }
  WebSocketsClient ws_;
  gc::ITransportListener* l_ = nullptr;
  bool wantConnect_ = false, active_ = false, connected_ = false;
};

}  // namespace pf
