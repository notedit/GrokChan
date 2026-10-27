import type { WsConnector } from "../net/ws";

/** ElevenLabs settings read from Worker env. The key is a secret: `wrangler secret put ELEVENLABS_API_KEY`. */
export interface ElevenLabsEnv {
  ELEVENLABS_API_KEY?: string;
  /** default JBFqnCBsd6RMkjVDRZzb (premade "George", the voice used in the official examples) */
  ELEVENLABS_VOICE_ID?: string;
  /** default eleven_flash_v2_5 (low latency, multilingual incl. zh) */
  ELEVENLABS_TTS_MODEL?: string;
  /** default scribe_v2_realtime */
  ELEVENLABS_ASR_MODEL?: string;
  /** default api.elevenlabs.io; e.g. api.us.elevenlabs.io / api.eu.residency.elevenlabs.io */
  ELEVENLABS_HOST?: string;
}

export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_ASR_MODEL = "scribe_v2_realtime";

export interface ElevenConfig {
  apiKey: string;
  voiceId: string;
  ttsModel: string;
  asrModel: string;
  host: string;
}

/** Throws when the key is missing (the message names the variable, never a value). */
export function elevenConfig(env: ElevenLabsEnv): ElevenConfig {
  const apiKey = (env.ELEVENLABS_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const host = (env.ELEVENLABS_HOST ?? "").trim() || "api.elevenlabs.io";
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error("ELEVENLABS_HOST must be a bare host name");
  return {
    apiKey,
    voiceId: (env.ELEVENLABS_VOICE_ID ?? "").trim() || DEFAULT_VOICE_ID,
    ttsModel: (env.ELEVENLABS_TTS_MODEL ?? "").trim() || DEFAULT_TTS_MODEL,
    asrModel: (env.ELEVENLABS_ASR_MODEL ?? "").trim() || DEFAULT_ASR_MODEL,
    host,
  };
}

export interface ElevenDeps {
  /** injectable for tests / Node smoke; default is the Workers fetch-upgrade connector */
  connect?: WsConnector;
}

export const ELEVEN_PCM_RATES = [16000, 22050, 24000, 44100] as const;
