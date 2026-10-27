import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMATS,
  decodeFrame,
  DEVICE_METHODS,
  encodeFrame,
  FLAG_LAST,
  FRAME_DOWNLINK_AUDIO,
  FRAME_HEADER_BYTES,
  mapDeviceError,
  preferPlayFormat,
  PROTOCOL,
  RPC,
  WS_CLOSE,
} from "../src/device/protocol";
import { buildTools } from "../src/mcp/tools";

describe("mediasession-rpc/1 protocol kernel", () => {
  it("PROTOCOL is mediasession-rpc/1", () => {
    expect(PROTOCOL).toBe("mediasession-rpc/1");
  });

  it("round-trips binary audio frames (8-byte LE header)", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = encodeFrame(FRAME_DOWNLINK_AUDIO, 7, 42, payload, true);
    expect(buf.byteLength).toBe(FRAME_HEADER_BYTES + payload.length);
    const f = decodeFrame(buf);
    expect(f).not.toBeNull();
    expect(f!.type).toBe(FRAME_DOWNLINK_AUDIO);
    expect(f!.streamId).toBe(7);
    expect(f!.seq).toBe(42);
    expect(f!.last).toBe(true);
    expect([...f!.payload]).toEqual([1, 2, 3, 4, 5]);
    expect(FLAG_LAST).toBe(0x01);
    expect(decodeFrame(new ArrayBuffer(4))).toBeNull();
  });

  it("maps INTERRUPTED and prefers pcm_s16le", () => {
    expect(RPC.INTERRUPTED).toBe(-32013);
    expect(mapDeviceError(RPC.INTERRUPTED)).toBe("interrupted");
    expect(WS_CLOSE.PROTOCOL_MISMATCH).toBe(4002);
    const chosen = preferPlayFormat([
      { format: "opus", sample_rate: 16000, channels: 1 },
      { format: "pcm_s16le", sample_rate: 16000, channels: 1 },
    ]);
    expect(chosen.format).toBe("pcm_s16le");
    expect(AUDIO_FORMATS).toContain("opus");
  });

  it("DEVICE_METHODS covers every device-bound M1 MCP tool", () => {
    const tools = buildTools().map((t) => t.name);
    expect(tools).toContain("list_devices");
    for (const name of Object.keys(DEVICE_METHODS)) {
      expect(tools).toContain(name);
      expect(DEVICE_METHODS[name as keyof typeof DEVICE_METHODS]).toMatch(/^device\./);
    }
    // every non-list tool that calls the device should appear in the map
    const mapped = new Set(Object.keys(DEVICE_METHODS));
    for (const name of tools) {
      if (name === "list_devices") continue;
      expect(mapped.has(name)).toBe(true);
    }
  });
});
