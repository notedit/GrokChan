/**
 * Split reply text into speakable sentences so TTS can start on the first one
 * while the rest is still being synthesized. Pure function.
 *
 * - hard stops: 。！？!? … ； ; and newlines; "." only when followed by
 *   whitespace/end/CJK (so "3.14" and "a.b" stay whole)
 * - closing quotes/brackets stay with the sentence they close
 * - fragments with no letters/digits ("...", "!") merge into the previous sentence
 * - the first sentence is cut early at a soft break (，, 、 : …) once it exceeds
 *   `firstMaxChars` so audio starts sooner; later ones are capped at `maxChars`
 */
export interface SplitOptions {
  firstMaxChars?: number;
  maxChars?: number;
}

const HARD = new Set(["。", "！", "？", "!", "?", "…", "；", ";", "\n"]);
const CLOSERS = new Set(["”", "’", '"', "'", ")", "）", "」", "』", "】", "》", "]"]);
const SOFT = new Set(["，", ",", "、", "：", ":", " "]);
const WORDISH = /[\p{L}\p{N}]/u;

export function splitSentences(text: string, opts: SplitOptions = {}): string[] {
  const firstMax = Math.max(8, opts.firstMaxChars ?? 40);
  const max = Math.max(firstMax, opts.maxChars ?? 120);
  const chars = Array.from(text.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim());
  const raw: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    const t = cur.join("").trim();
    if (t) raw.push(t);
    cur = [];
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    cur.push(c);
    let stop = HARD.has(c);
    if (!stop && c === ".") {
      const next = chars[i + 1];
      stop = next === undefined || next === " " || next === "\n" || /[\u3000-\u9fff]/.test(next);
    }
    if (!stop) continue;
    // swallow runs of terminators and closing marks: "?!" / '。」'
    while (i + 1 < chars.length && (HARD.has(chars[i + 1]!) || CLOSERS.has(chars[i + 1]!) || chars[i + 1] === ".")) {
      if (chars[i + 1] === "\n") break;
      cur.push(chars[++i]!);
    }
    flush();
  }
  flush();

  const merged: string[] = [];
  for (const seg of raw) {
    if (!WORDISH.test(seg) && merged.length > 0) merged[merged.length - 1] += seg;
    else merged.push(seg);
  }

  const out: string[] = [];
  for (const seg of merged) for (const part of softSplit(seg, out.length === 0 ? firstMax : max, max)) out.push(part);
  return out;
}

function softSplit(seg: string, firstLimit: number, limit: number): string[] {
  const chars = Array.from(seg);
  const parts: string[] = [];
  let lim = firstLimit;
  let start = 0;
  while (chars.length - start > lim) {
    let cut = -1;
    for (let i = start + lim - 1; i >= start + 4; i--) {
      if (SOFT.has(chars[i]!)) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = start + lim;
    parts.push(chars.slice(start, cut).join("").trim());
    start = cut;
    lim = limit;
  }
  const rest = chars.slice(start).join("").trim();
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}
