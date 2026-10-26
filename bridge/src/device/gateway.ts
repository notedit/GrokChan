/**
 * Contract between the MCP layer and the device layer. The MCP handler only
 * knows this interface, so it can be unit-tested with an in-memory fake and
 * wired to the DeviceHub Durable Objects in the Worker.
 */

export interface DeviceSummary {
  device_id: string;
  online: boolean;
  last_seen: number | null; // epoch ms
  fw_version?: string;
  hw?: string;
  caps: string[];
}

export interface DeviceError {
  code: string; // MCP-side error code, see docs/mcp-plan.zh-CN.md 2.1 / 3.6
  message: string;
  retry_after_ms?: number;
  last_seen?: number;
  data?: unknown;
}

export type DeviceOutcome =
  | {
      ok: true;
      device_id: string;
      command_id: string;
      status: "accepted" | "done";
      result: Record<string, unknown>;
      latency_ms: number;
      deduplicated?: true;
    }
  | { ok: false; device_id: string; command_id?: string; error: DeviceError };

/** A generic device command: one JSON-RPC request to the device. */
export interface DeviceCall {
  tool: string; // MCP tool name, e.g. "move_head"
  method: string; // JSON-RPC method, e.g. "device.move_head"
  params: Record<string, unknown>; // without _meta; the hub adds ttl/seq/idempotency key
  request_id?: string; // client idempotency key (60 s)
  timeout_ms?: number; // how long to wait for the JSON-RPC response
  ttl_ms?: number; // _meta.ttl_ms
  wait?: "accepted" | "done";
}

export interface SpeakCall {
  text: string;
  voice?: string;
  lang?: string;
  interrupt: boolean;
  expression?: string;
  volume?: number;
  wait: "queued" | "started" | "done";
  timeout_ms: number;
  request_id?: string;
}

export interface DeviceGateway {
  listDevices(): Promise<DeviceSummary[]>;
  hasDevice(deviceId: string): Promise<boolean>;
  call(deviceId: string, call: DeviceCall): Promise<DeviceOutcome>;
  speak(deviceId: string, call: SpeakCall): Promise<DeviceOutcome>;
  status(deviceId: string, fresh: boolean): Promise<DeviceOutcome>;
}
