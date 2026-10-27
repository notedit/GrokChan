/** Shared agent-provider contracts for GrokChan bridge. */

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
  role: ChatRole;
  text: string;
}

/** Present when the message came from a physical device (voice turn); omitted for web chat. */
export interface DeviceContext {
  id: string;
  /** "voice": `message` is an ASR transcript, the reply will be spoken: keep it short and speakable. */
  modality: "voice";
  turn_id: string;
  hw?: string;
  fw?: string;
  caps?: string[];
  lang?: string;
}

export interface InboundChat {
  session_id: string;
  message: string;
  history: ChatTurn[];
  /** Backward compatible: absent for web chat. */
  device?: DeviceContext;
}

export interface ReplyTarget {
  method: "POST";
  url: string;
}

export interface AgentDeliveryResult {
  ok: boolean;
  status: number;
  detail?: string;
}

/**
 * One upstream "brain". Grok Bot is the first; Muse and others plug in later
 * behind the same deliver() surface so HTTP routes stay provider-agnostic.
 */
export interface AgentProvider {
  /** Stable id used in config / logs (e.g. "grokbot", "muse"). */
  readonly id: string;
  deliver(inbound: InboundChat, reply: ReplyTarget): Promise<AgentDeliveryResult>;
}

export type AgentProviderId = "grokbot" | "muse";
