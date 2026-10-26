import { DurableObject } from "cloudflare:workers";

export interface RegistryEntry {
  device_id: string;
  first_seen: number;
  last_seen: number;
  fw_version?: string;
  hw?: string;
  caps: string[];
}

/**
 * Tiny directory of device ids that have said hello at least once. Online
 * state is NOT stored here (each DeviceHub is the source of truth); this only
 * lets `list_devices` enumerate devices and lets tools reject unknown ids
 * without instantiating arbitrary DeviceHub objects.
 */
export class DeviceRegistry extends DurableObject<Record<string, unknown>> {
  async touch(info: { device_id: string; fw_version?: string; hw?: string; caps: string[] }): Promise<void> {
    const key = `d:${info.device_id}`;
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    const now = Date.now();
    await this.ctx.storage.put(key, { ...info, first_seen: prev?.first_seen ?? now, last_seen: now } satisfies RegistryEntry);
  }
  async seen(deviceId: string): Promise<void> {
    const key = `d:${deviceId}`;
    const prev = await this.ctx.storage.get<RegistryEntry>(key);
    if (prev) await this.ctx.storage.put(key, { ...prev, last_seen: Date.now() });
  }
  async has(deviceId: string): Promise<boolean> {
    return (await this.ctx.storage.get(`d:${deviceId}`)) !== undefined;
  }
  async list(): Promise<RegistryEntry[]> {
    const m = await this.ctx.storage.list<RegistryEntry>({ prefix: "d:", limit: 200 });
    return [...m.values()].sort((a, b) => a.device_id.localeCompare(b.device_id));
  }
}
