import { createMockAsr } from "./mock";
import { createWorkersAiAsr, type WorkersAiAsrEnv } from "./workers-ai";
import { createElevenLabsAsr } from "./elevenlabs";
import type { ElevenLabsEnv } from "../elevenlabs/config";
import type { AsrProvider } from "./types";

export type { AsrProvider, AsrResult, AsrSession, AsrStartOptions } from "./types";
export { AsrError } from "./types";

type Factory = (env: Record<string, unknown>) => AsrProvider;
const registry = new Map<string, Factory>([
  ["mock", () => createMockAsr()],
  ["workers-ai", (env) => createWorkersAiAsr(env as WorkersAiAsrEnv)],
  ["elevenlabs", (env) => createElevenLabsAsr(env as ElevenLabsEnv)],
]);

/** Register a provider factory (e.g. Deepgram nova); none ship with keys. */
export function registerAsrProvider(id: string, factory: Factory): void {
  registry.set(id, factory);
}

/** Resolve `ASR_PROVIDER`. Unset or unknown -> undefined (voice turns are refused with asr_unavailable). */
export function getAsrProvider(env: { ASR_PROVIDER?: string }): AsrProvider | undefined {
  const id = env.ASR_PROVIDER;
  if (!id) return undefined;
  return registry.get(id)?.(env as Record<string, unknown>);
}
