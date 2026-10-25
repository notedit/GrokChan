import type { AgentDeliveryResult, AgentProvider, InboundChat, ReplyTarget } from "./types";

/**
 * Stub for a future Meta Muse (or useapi.net Muse) adapter.
 * Not wired for production yet — selecting AGENT_PROVIDER=muse returns 501.
 */
export function createMuseProvider(_env?: unknown): AgentProvider {
  return {
    id: "muse",
    async deliver(_inbound: InboundChat, _reply: ReplyTarget): Promise<AgentDeliveryResult> {
      return {
        ok: false,
        status: 501,
        detail: "Muse agent adapter is a stub. Use AGENT_PROVIDER=grokbot for now.",
      };
    },
  };
}
