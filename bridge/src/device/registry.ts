import { DurableObject } from "cloudflare:workers";
import { generateToken, sha256Hex, safeEqual } from "../auth";

export interface RegistryEntry {
  device_id: string;
  first_seen: number;
  last_seen: number;
  fw_version?: string;
  hw?: string;
  caps: string[];
  /** True when a device token is currently registered (hash stored). Never exposes the token. */
  has_token?: boolean;
  /**
   * True after the first successful session.hello (registry.touch).
   * Token issue alone provisions the id for WS auth but does not surface it in MCP list_devices.
   */
  connected?: boolean;
}

/**
 * Directory of known device ids + per-device auth token digests.
 * Online state lives in each DeviceHub; this DO only enumerates devices,
 * rejects unknown ids for MCP tools, and verifies Bearer tokens on WS connect.
 * Only the SHA-256 of a token is stored — the plaintext is returned once from
 * `issueToken` and never persisted.
 */
export class DeviceRegistry extends DurableObject<Record<string, unknown>> {
  private entryKey(id: string): string {
    return `d:${id}`;
  }
  private tokenKey(id: string): string {
    return `t:${id}`;
  }

  async touch(info: { device_id: string; fw_version?: string; hw?: string; caps: string[] }): Promise<void> {
    const key = this.entryKey(info.device_id);
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    const now = Date.now();
    const hasTok = (await this.ctx.storage.get(this.tokenKey(info.device_id))) !== undefined;
    await this.ctx.storage.put(key, {
      ...info,
      first_seen: prev?.first_seen ?? now,
      last_seen: now,
      has_token: hasTok,
      connected: true,
    } satisfies RegistryEntry);
  }

  async seen(deviceId: string): Promise<void> {
    const key = this.entryKey(deviceId);
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    if (prev) await this.ctx.storage.put(key, { ...prev, last_seen: Date.now() });
  }

  async has(deviceId: string): Promise<boolean> {
    const e = await this.ctx.storage.get<RegistryEntry>(this.entryKey(deviceId));
    // MCP only resolves devices that have hello'd at least once.
    return !!e?.connected;
  }

  /** Admin listing: provisioned tokens + hello'd devices. */
  async list(): Promise<RegistryEntry[]> {
    const m = await this.ctx.storage.list<RegistryEntry>({ prefix: "d:", limit: 200 });
    const out: RegistryEntry[] = [];
    for (const e of m.values()) {
      const hasTok = (await this.ctx.storage.get(this.tokenKey(e.device_id))) !== undefined;
      out.push({ ...e, has_token: hasTok });
    }
    return out.sort((a, b) => a.device_id.localeCompare(b.device_id));
  }

  /** MCP list_devices: only devices that completed session.hello at least once. */
  async listConnected(): Promise<RegistryEntry[]> {
    return (await this.list()).filter((e) => e.connected);
  }

  /**
   * Mint a new device token. Returns the plaintext once; only the SHA-256 digest
   * is stored. Creates a provisioned registry stub (connected=false) so admin
   * APIs can list it; MCP list_devices stays empty until the first hello.
   */
  async issueToken(deviceId: string): Promise<{ token: string; device_id: string }> {
    const token = generateToken();
    const digest = await sha256Hex(token);
    await this.ctx.storage.put(this.tokenKey(deviceId), digest);
    const key = this.entryKey(deviceId);
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    const now = Date.now();
    await this.ctx.storage.put(key, {
      device_id: deviceId,
      first_seen: prev?.first_seen ?? now,
      last_seen: prev?.last_seen ?? now,
      fw_version: prev?.fw_version,
      hw: prev?.hw,
      caps: prev?.caps ?? [],
      has_token: true,
      connected: prev?.connected ?? false,
    } satisfies RegistryEntry);
    return { token, device_id: deviceId };
  }

  /** Drop the token digest. The device entry (hello history) is kept. */
  async revokeToken(deviceId: string): Promise<boolean> {
    const had = (await this.ctx.storage.get(this.tokenKey(deviceId))) !== undefined;
    await this.ctx.storage.delete(this.tokenKey(deviceId));
    const key = this.entryKey(deviceId);
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    if (prev) await this.ctx.storage.put(key, { ...prev, has_token: false });
    return had;
  }

  /**
   * Constant-time verify of a Bearer token against the stored SHA-256.
   * Returns false when no token is registered or the digest does not match.
   */
  async verifyToken(deviceId: string, token: string): Promise<boolean> {
    if (!token) return false;
    const stored = await this.ctx.storage.get<string>(this.tokenKey(deviceId));
    if (!stored) return false;
    const dig = await sha256Hex(token);
    return safeEqual(dig, stored);
  }
}
