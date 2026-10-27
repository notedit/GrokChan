import { TtsError, type TtsProvider, type TtsRequest, type TtsStreamResult } from "./types";
import { splitSentences, type SplitOptions } from "./sentences";
import type { AudioFormat } from "../device/protocol";

export interface SpeechChunk {
  /** index into SpeechStream.sentences */
  sentence: number;
  audio: Uint8Array;
}

/** Audio for a whole reply: one format, chunks in sentence order. */
export interface SpeechStream {
  format: AudioFormat;
  sampleRate: number;
  channels: number;
  provider: string;
  voice: string;
  sentences: string[];
  chunks: AsyncGenerator<SpeechChunk, void, void>;
}

interface OpenSentence {
  info: Omit<TtsStreamResult, "chunks">;
  iter: AsyncIterator<Uint8Array>;
}

/**
 * Synthesize `text` sentence by sentence. Sentence 0 is opened before this
 * returns (so the format is known and a failure surfaces immediately); sentence
 * n+1 is opened while sentence n is still draining, so the next sentence's
 * latency hides behind playback. Only PCM is supported for streaming (S1).
 */
export async function openSpeechStream(
  provider: TtsProvider,
  req: TtsRequest,
  opts: { signal?: AbortSignal } & SplitOptions = {},
): Promise<SpeechStream> {
  const sentences = splitSentences(req.text, opts);
  if (sentences.length === 0) throw new TtsError("empty text", "tts_failed");
  const signal = opts.signal;

  if (provider.openInputStream) {
    // one upstream session for the whole reply: push every sentence, audio flows out as it is produced
    const sess = await provider.openInputStream({ ...req, ...(signal ? { signal } : {}) });
    if (sess.format !== "pcm_s16le") {
      sess.abort();
      throw new TtsError(`streaming playback needs pcm_s16le, provider returned ${sess.format}`, "unsupported");
    }
    for (const s of sentences) sess.sendText(s);
    sess.end();
    async function* viaSession(): AsyncGenerator<SpeechChunk, void, void> {
      try {
        for await (const audio of sess.chunks) {
          if (signal?.aborted) return;
          if (audio.byteLength > 0) yield { sentence: 0, audio };
        }
      } finally {
        sess.abort();
      }
    }
    return { format: "pcm_s16le", sampleRate: sess.sampleRate ?? 16000, channels: sess.channels, provider: sess.provider, voice: sess.voice, sentences, chunks: viaSession() };
  }

  const open = async (i: number): Promise<OpenSentence> => {
    const r = { ...req, text: sentences[i]! };
    let s: TtsStreamResult;
    if (provider.synthesizeStream) {
      s = await provider.synthesizeStream({ ...r, ...(signal ? { signal } : {}) });
    } else {
      const whole = await provider.synthesize(r);
      s = {
        format: whole.format,
        ...(whole.sampleRate !== undefined ? { sampleRate: whole.sampleRate } : {}),
        channels: whole.channels,
        provider: whole.provider,
        voice: whole.voice,
        chunks: (async function* () {
          yield whole.audio;
        })(),
      };
    }
    if (s.format !== "pcm_s16le") throw new TtsError(`streaming playback needs pcm_s16le, provider returned ${s.format}`, "unsupported");
    return { info: s, iter: s.chunks[Symbol.asyncIterator]() };
  };

  const opened = new Map<number, Promise<OpenSentence>>();
  const kick = (i: number) => {
    if (i >= sentences.length || opened.has(i)) return;
    const p = open(i);
    p.catch(() => {}); // surfaced when awaited; never an unhandled rejection
    opened.set(i, p);
  };
  kick(0);
  const first = await opened.get(0)!;
  const cleanup = () => {
    for (const p of opened.values()) p.then((o) => o.iter.return?.(), () => {});
  };

  async function* gen(): AsyncGenerator<SpeechChunk, void, void> {
    try {
      for (let i = 0; i < sentences.length; i++) {
        if (signal?.aborted) return;
        kick(i + 1);
        const cur = await opened.get(i)!;
        if (cur.info.sampleRate !== undefined && first.info.sampleRate !== undefined && cur.info.sampleRate !== first.info.sampleRate) {
          throw new TtsError("sample rate changed between sentences", "unsupported");
        }
        while (true) {
          if (signal?.aborted) return;
          const n = await cur.iter.next();
          if (n.done) break;
          if (n.value.byteLength > 0) yield { sentence: i, audio: n.value };
        }
        opened.delete(i - 1);
      }
    } finally {
      cleanup();
    }
  }

  return {
    format: "pcm_s16le",
    sampleRate: first.info.sampleRate ?? 16000,
    channels: first.info.channels,
    provider: first.info.provider,
    voice: first.info.voice,
    sentences,
    chunks: gen(),
  };
}
