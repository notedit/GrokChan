#include "gc_protocol.h"

namespace gc {

const char* rpcCodeName(int code) {
  switch (code) {
    case kParseError: return "parse_error";
    case kInvalidRequest: return "invalid_request";
    case kMethodNotFound: return "method_not_found";
    case kInvalidParams: return "invalid_params";
    case kInternalError: return "internal_error";
    case kBusy: return "busy";
    case kLimitExceeded: return "limit_exceeded";
    case kLowBattery: return "low_battery";
    case kTimeout: return "timeout";
    case kUnauthorized: return "unauthorized";
    case kPrivacyBlocked: return "privacy_blocked";
    case kUnsupported: return "unsupported";
    case kRateLimited: return "rate_limited";
    case kExpired: return "expired";
    case kDeviceFault: return "device_fault";
    case kPayloadTooLarge: return "payload_too_large";
    case kQuietHours: return "quiet_hours";
    case kStreamError: return "stream_error";
    case kInterrupted: return "interrupted";
    default: return "error";
  }
}

bool decodeFrameHeader(const uint8_t* d, size_t len, FrameHeader& out) {
  if (!d || len < kFrameHeaderBytes) return false;
  out.type = d[0];
  out.flags = d[1];
  out.stream = (uint16_t)(d[2] | (d[3] << 8));
  out.seq = (uint32_t)d[4] | ((uint32_t)d[5] << 8) | ((uint32_t)d[6] << 16) | ((uint32_t)d[7] << 24);
  return true;
}

void encodeFrameHeader(const FrameHeader& h, uint8_t* o) {
  o[0] = h.type;
  o[1] = h.flags;
  o[2] = (uint8_t)(h.stream & 0xff);
  o[3] = (uint8_t)(h.stream >> 8);
  o[4] = (uint8_t)(h.seq & 0xff);
  o[5] = (uint8_t)((h.seq >> 8) & 0xff);
  o[6] = (uint8_t)((h.seq >> 16) & 0xff);
  o[7] = (uint8_t)((h.seq >> 24) & 0xff);
}

}  // namespace gc
