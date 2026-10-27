// GrokChan device protocol constants (mediasession-rpc/1). Mirrors bridge/src/device/protocol.ts
// and docs/mcp-plan.zh-CN.md section 3. Keep both in sync.
#pragma once
#include <cstddef>
#include <cstdint>

namespace gc {

constexpr const char* kProtocol = "mediasession-rpc/1";

// JSON-RPC error codes (bridge: RPC in protocol.ts).
enum RpcCode : int {
  kParseError = -32700,
  kInvalidRequest = -32600,
  kMethodNotFound = -32601,
  kInvalidParams = -32602,
  kInternalError = -32603,
  kBusy = -32000,
  kLimitExceeded = -32001,
  kLowBattery = -32002,
  kTimeout = -32003,
  kUnauthorized = -32004,
  kPrivacyBlocked = -32005,
  kUnsupported = -32006,
  kRateLimited = -32007,
  kExpired = -32008,
  kDeviceFault = -32009,
  kPayloadTooLarge = -32010,
  kQuietHours = -32011,
  kStreamError = -32012,
  kInterrupted = -32013,
};

// WebSocket close codes (mirror bridge WS_CLOSE).
enum WsClose : int {
  kCloseReplaced = 4000,
  kCloseHelloTimeout = 4001,
  kCloseProtocolMismatch = 4002,
  kCloseAuthFailed = 4003,
};

// Short error.message names (doc 3.6).
const char* rpcCodeName(int code);

// Exact-match keepalive strings (bridge auto-responds without waking the Durable Object).
constexpr const char* kPingText = "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}";
constexpr const char* kPongText = "{\"jsonrpc\":\"2.0\",\"method\":\"pong\"}";

// Binary frame: [type u8][flags u8][stream u16 LE][seq u32 LE][payload...]
constexpr size_t kFrameHeaderBytes = 8;
constexpr uint8_t kFrameDownlinkAudio = 0x01;
constexpr uint8_t kFrameUplinkAudio = 0x02;
constexpr uint8_t kFramePhoto = 0x03;
constexpr uint8_t kFlagLast = 0x01;

struct FrameHeader {
  uint8_t type = 0;
  uint8_t flags = 0;
  uint16_t stream = 0;
  uint32_t seq = 0;
  bool last() const { return (flags & kFlagLast) != 0; }
};

// Returns false if len < 8.
bool decodeFrameHeader(const uint8_t* data, size_t len, FrameHeader& out);
// Writes 8 bytes into out.
void encodeFrameHeader(const FrameHeader& h, uint8_t* out);

}  // namespace gc
