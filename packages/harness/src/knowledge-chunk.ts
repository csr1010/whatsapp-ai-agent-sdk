export interface ChunkOptions {
  /** Target max size of a chunk, in characters. Default 800. */
  maxChunkChars?: number;
  /** Characters of the previous chunk's tail carried into the next when a paragraph itself has to
   * be split — so a fact split across a chunk boundary is still recoverable from at least one
   * chunk. Default 100 (clamped below `maxChunkChars`). */
  overlapChars?: number;
}

const DEFAULT_MAX_CHUNK_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 100;

/** Hard-slices a single "word" (no whitespace) longer than `maxChunkChars` on its own — e.g. a long
 * URL or hash with nowhere natural to break — so chunking always terminates and every piece stays
 * bounded, however pathological the input. */
function hardSlice(word: string, maxChunkChars: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < word.length; i += maxChunkChars) pieces.push(word.slice(i, i + maxChunkChars));
  return pieces;
}

function splitLong(text: string, maxChunkChars: number, overlapChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSlice(word, maxChunkChars));
      continue;
    }
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else {
      chunks.push(current);
      // The carried-over tail must leave room for a joining space plus the whole new word (already
      // known to fit alone, from the `word.length > maxChunkChars` check above) — capping it here,
      // not just using `overlapChars` as-is, is what keeps every chunk within `maxChunkChars`; using
      // the full requested overlap unconditionally could otherwise push `current` back OVER the
      // limit on this very reassignment, silently violating the function's documented "bounded by
      // maxChunkChars" contract for however many further words accumulate before the next split.
      const maxTailForWord = Math.max(0, maxChunkChars - word.length - 1);
      const overlapLen = Math.min(overlapChars, maxTailForWord);
      const tail = overlapLen > 0 ? current.slice(Math.max(0, current.length - overlapLen)) : "";
      current = tail.length > 0 ? `${tail} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits `text` into chunks bounded by `maxChunkChars` (§8 T8.3 "ingest... chunk"): paragraphs
 * (blank-line-separated) are greedily packed together up to the limit; a single paragraph that
 * alone exceeds it is further split at word boundaries with `overlapChars` of carry-over. Empty or
 * whitespace-only input yields no chunks — never a spurious empty-string chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  // hardSlice()'s `for (i = 0; i < word.length; i += maxChunkChars)` never advances (or goes
  // negative) once maxChunkChars is <= 0 — fail loud here, at the one entry point every chunking
  // path goes through, rather than silently hanging deep inside a helper on a caller's bad config.
  if (maxChunkChars <= 0) throw new Error(`chunkText: maxChunkChars must be a positive number, got ${maxChunkChars}.`);
  const overlapChars = Math.min(opts.overlapChars ?? DEFAULT_OVERLAP_CHARS, Math.max(maxChunkChars - 1, 0));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChunkChars) {
      flush();
      chunks.push(...splitLong(para, maxChunkChars, overlapChars));
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= maxChunkChars) {
      current = candidate;
    } else {
      flush();
      current = para;
    }
  }
  flush();
  return chunks;
}
