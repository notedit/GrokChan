import type { DeviceHub, DeviceEnv } from "./hub";
import type { DeviceCall, DeviceGateway, DeviceOutcome, DeviceSummary, SpeakCall } from "./gateway";

export interface GatewayEnv extends DeviceEnv {
  DEVICE: DurableObjectNamespace<DeviceHub>;
}

/** DeviceGateway backed by the DeviceRegistry + DeviceHub Durable Objects. */
export function createDoGateway(env: GatewayEnv): DeviceGateway {
  const hub = (id: string) => env.DEVICE.getByName(id);
  const registry = () => env.REGISTRY.getByName("registry");
  return {
    async listDevices(): Promise<DeviceSummary[]> {
      const entries = await registry().list();
      return Promise.all(
        entries.map(async (e) => {
          try {
            return await hub(e.device_id).summary();
          } catch {
            return { device_id: e.device_id, online: false, last_seen: e.last_seen, caps: e.caps };
          }
        }),
      );
    },
    hasDevice: (id) => registry().has(id),
    call: (id, call: DeviceCall): Promise<DeviceOutcome> => hub(id).call(call),
    speak: (id, call: SpeakCall): Promise<DeviceOutcome> => hub(id).speak(call),
    status: (id, fresh) => hub(id).status(fresh),
  };
}
