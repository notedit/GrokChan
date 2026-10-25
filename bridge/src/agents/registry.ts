import { createGrokBotProvider, type GrokBotEnv } from "./grokbot";
import { createMuseProvider } from "./muse";
import type { AgentProvider, AgentProviderId } from "./types";

export type AgentEnv = GrokBotEnv & {
  AGENT_PROVIDER?: string;
};

export function resolveAgentId(env: AgentEnv): AgentProviderId {
  const raw = (env.AGENT_PROVIDER || "grokbot").trim().toLowerCase();
  if (raw === "muse") return "muse";
  return "grokbot";
}

/** Pick the active upstream agent. Default: grokbot. */
export function getAgentProvider(env: AgentEnv): AgentProvider {
  switch (resolveAgentId(env)) {
    case "muse":
      return createMuseProvider(env);
    case "grokbot":
    default:
      return createGrokBotProvider(env);
  }
}

export { GROKBOT_INBOUND_SCHEMA } from "./grokbot";
export type { AgentProvider, InboundChat, ReplyTarget, AgentDeliveryResult } from "./types";
