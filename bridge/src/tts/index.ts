import { createMockTts } from "./mock";
import type { TtsProvider } from "./types";

export type { TtsProvider, TtsRequest, TtsResult } from "./types";
export { TtsError } from "./types";

type Factory = (env: Record<string, unknown>) => TtsProvider;
const registry = new Map<string, Factory>([["mock", () => createMockTts()]]);

/** Register a provider factory (real providers go here; none ship in M1). */
export function registerTtsProvider(id: string, factory: Factory): void {
  registry.set(id, factory);
}

/** Resolve the provider named by `TTS_PROVIDER`. Unset or unknown -> undefined (speak fails with tts_failed). */
export function getTtsProvider(env: { TTS_PROVIDER?: string }): TtsProvider | undefined {
  const id = env.TTS_PROVIDER;
  if (!id) return undefined;
  return registry.get(id)?.(env as Record<string, unknown>);
}
