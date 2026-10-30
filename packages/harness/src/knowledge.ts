import type { Client } from "@libsql/client";
import type { Memory } from "@wappy_ai/core";
import { bm25Scores, tokenize } from "./bm25.js";
import { chunkText, type ChunkOptions } from "./knowledge-chunk.js";
import { recallWithBudget } from "./recall-budget.js";
import { reciprocalRankFusion } from "./rank-fusion.js";

export interface CreateKnowledgeRagOptions {
  knowledge: Knowledge;
  topK?: number;
  scoreFloor?: number;
  /** Also recalls relevant PAST CONVERSATION turns via `Memory.recall()` (T6.4's `recallWithBudget`,
   * finally given a real caller here) and appends them after the Knowledge chunks — e.g. surfacing
   * "the user already gave us their order number earlier in this chat" alongside document knowledge.
   * Optional: omit for Knowledge-only RAG (the default — Knowledge is the module T8.3 actually asks
   * for; this is an additive complement, not a requirement). */
  memory?: Memory;
  memoryMaxSnippets?: number;
  memoryRelevanceFloor?: number;
}

/** Builds the real `AgentDeps.retrieveRag` hook (§9 Scenario B, finally wired for real in M8):
 * recalls chunks from `knowledge` and hands back their text verbatim — `agent.ts` already bounds/caps
 * everything downstream (M6), so this stays a thin adapter, not a second place that re-implements
 * bounding. An empty query or an empty/no-match store both naturally resolve to `[]` via `recall()`
 * itself (§9 "empty store -> falls back to 'I don't know', no hallucinated retrieval") — the compose
 * model, given no snippets, is the one that has to say so honestly, not this function's job. */
export function createKnowledgeRag(opts: CreateKnowledgeRagOptions): (input: { contactId: string; query: string }) => Promise<string[]> {
  return async ({ contactId, query }) => {
    if (!query) return [];
    const results = await opts.knowledge.recall(query, { topK: opts.topK, scoreFloor: opts.scoreFloor });
    const snippets = results.map((r) => r.text);
    if (!opts.memory) return snippets;
    const memorySnippets = await recallWithBudget({
      memory: opts.memory,
      contactId,
      query,
      maxSnippets: opts.memoryMaxSnippets ?? 3,
      relevanceFloor: opts.memoryRelevanceFloor,
    });
    return [...snippets, ...memorySnippets];
  };
}

export * from "./knowledge-chunk.js";

export interface RecalledChunk {
  id: string;
  sourceId: string;
  text: string;
  score: number;
}

export interface RecallOptions {
  /** Max chunks returned. Default 5. */
  topK?: number;
  /** A chunk must score STRICTLY above this to be recalled — the default (0) excludes a BM25 zero
   * score (no lexical overlap at all) or an orthogonal (0.0 cosine) embedding match either way, so
   * an unrelated query never drags in filler just to fill topK. */
  scoreFloor?: number;
}

export interface Knowledge {
  /** Chunks and (re)indexes `text` under `sourceId`, replacing that source's previous chunks
   * outright (a source is the unit of update — no incremental diffing in v0.1, so re-ingesting an
   * updated document never leaves stale chunks from the old version alongside the new ones).
   * Returns the number of chunks stored (0 for empty/whitespace-only text). */
  ingest(sourceId: string, text: string, chunkOptions?: ChunkOptions): Promise<number>;
  /** Removes every chunk for `sourceId`. */
  remove(sourceId: string): Promise<void>;
  /** Ranks stored chunks against `query` — by cosine similarity over stored embeddings when this
   * Knowledge was created with an `embed` function, otherwise BM25 (the default, §8 T8.3). An empty
   * store (or a query with no matches above `scoreFloor`) returns `[]`, never a hallucinated match. */
  recall(query: string, opts?: RecallOptions): Promise<RecalledChunk[]>;
}

export interface KnowledgeOptions {
  client: Client;
  /** Optional embedding provider — "via the configured model provider" (§8 T8.3) means whatever
   * embedding call the caller's own model setup provides (e.g. the Vercel AI SDK's `embedMany`, or
   * `local-embedder.ts`'s `createLocalEmbedder()` for a fully local/offline option), wired in here
   * as a plain function so this module stays provider-agnostic (hub-and-spoke: no provider SDK
   * imported here). Embeddings are computed once at ingest time and stored, not recomputed on every
   * `recall()`. Unset (the default): BM25 only, no embedding computation at all. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** M14: the embedding model's fixed output width (e.g. `createLocalEmbedder()`'s own
   * `.dimensions`). Only meaningful alongside `embed` — when both are set, embeddings are stored in
   * a real LibSQL `F32_BLOB(N)` column with a `libsql_vector_idx` ANN index and `recall()` ranks via
   * `vector_distance_cos()` in SQL, instead of loading every row into JS and computing cosine
   * similarity by hand (what `embed` alone, without this, still does — kept exactly as-is for
   * backward compatibility with an embedder that doesn't have a single fixed width, or a caller
   * that hasn't set this yet). Set once, consistently, for a given database file — this module
   * doesn't migrate an existing table that was created without it. */
  embedDimensions?: number;
  /** M20: rank by keywords AND vectors, merged by position (reciprocal rank fusion). Keywords find
   * exact codes and names; vectors find paraphrases and other languages; each misses what the
   * other finds. Needs `embed`. Unset: `embed` alone means vectors only, exactly as before. */
  hybrid?: boolean;
}

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  sourceId TEXT NOT NULL,
  chunkIndex INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(sourceId);
`;

function schemaFor(embedDimensions: number | undefined): string {
  if (!embedDimensions) return BASE_SCHEMA;
  // A separate table (not an added column on knowledge_chunks) since F32_BLOB(N)'s width is fixed
  // at CREATE TABLE time and this module has no schema-migration story — a caller that starts
  // without embedDimensions and adds it later against the same database file gets a fresh, empty
  // vector table alongside their existing text-only one, not a silently-incompatible ALTER.
  return `${BASE_SCHEMA}
CREATE TABLE IF NOT EXISTS knowledge_vectors (
  id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id),
  sourceId TEXT NOT NULL,
  embedding F32_BLOB(${embedDimensions})
);
CREATE INDEX IF NOT EXISTS idx_knowledge_vec ON knowledge_vectors (libsql_vector_idx(embedding));
`;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_FLOOR = 0;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    normA += a[i]! * a[i]!;
  }
  for (let i = 0; i < b.length; i++) normB += b[i]! * b[i]!;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface KnowledgeRow {
  id: string;
  sourceId: string;
  text: string;
  embedding: string | null;
}

/** LibSQL-backed Knowledge store (§8 T8.3, "local store (LibSQL)"). Lexical (BM25) by default,
 * matching M6/T6.5's own tool-selector so the codebase has one relevance-ranking approach, not two;
 * an optional `embed` function switches `recall()` to cosine similarity over stored embeddings.
 */
export function createKnowledge(opts: KnowledgeOptions): Knowledge {
  const client = opts.client;
  if (opts.hybrid && !opts.embed) throw new Error("hybrid recall needs an `embed` function: without one it would quietly be keywords only");
  const useNativeVectors = Boolean(opts.embed && opts.embedDimensions);
  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (!ready) {
      ready = client.executeMultiple(schemaFor(opts.embedDimensions)).catch((e: unknown) => {
        ready = undefined; // let the next call retry instead of permanently caching a transient failure
        throw e;
      });
    }
    return ready;
  };

  return {
    async ingest(sourceId, text, chunkOptions) {
      await ensureSchema();
      // knowledge_vectors.id REFERENCES knowledge_chunks(id) — the child table's rows for this
      // source must be deleted BEFORE the parent's, or the FK constraint rejects the parent delete.
      if (useNativeVectors) await client.execute({ sql: "DELETE FROM knowledge_vectors WHERE sourceId = ?", args: [sourceId] });
      await client.execute({ sql: "DELETE FROM knowledge_chunks WHERE sourceId = ?", args: [sourceId] });
      const pieces = chunkText(text, chunkOptions);
      if (pieces.length === 0) return 0;

      const embeddings = opts.embed ? await opts.embed(pieces) : undefined;
      const ids = pieces.map((_, i) => `${sourceId}:${i}`);
      await client.batch(
        pieces.map((piece, i) => ({
          sql: "INSERT INTO knowledge_chunks (id, sourceId, chunkIndex, text, embedding) VALUES (?, ?, ?, ?, ?)",
          // Native-vector mode stores the real embedding in `knowledge_vectors` (below), not here —
          // this TEXT column stays null in that mode rather than duplicating the same data twice.
          args: [ids[i]!, sourceId, i, piece, embeddings && !useNativeVectors ? JSON.stringify(embeddings[i]) : null],
        })),
        "write",
      );
      if (useNativeVectors && embeddings) {
        await client.batch(
          embeddings
            .map((vec, i) => ({ vec, id: ids[i]! }))
            .filter((e) => e.vec !== undefined)
            .map(({ vec, id }) => ({
              sql: "INSERT INTO knowledge_vectors (id, sourceId, embedding) VALUES (?, ?, vector32(?))",
              args: [id, sourceId, JSON.stringify(vec)],
            })),
          "write",
        );
      }
      return pieces.length;
    },

    async remove(sourceId) {
      await ensureSchema();
      if (useNativeVectors) await client.execute({ sql: "DELETE FROM knowledge_vectors WHERE sourceId = ?", args: [sourceId] });
      await client.execute({ sql: "DELETE FROM knowledge_chunks WHERE sourceId = ?", args: [sourceId] });
    },

    async recall(query, recallOpts) {
      await ensureSchema();
      const topK = recallOpts?.topK ?? DEFAULT_TOP_K;
      const scoreFloor = recallOpts?.scoreFloor ?? DEFAULT_SCORE_FLOOR;

      if (opts.hybrid) {
        const rows = (await client.execute("SELECT id, sourceId, text, embedding FROM knowledge_chunks")).rows as unknown as KnowledgeRow[];
        if (rows.length === 0) return [];
        const [queryEmbedding] = await opts.embed!([query]);
        // Each ranker offers more than topK: a chunk one ranks 8th and the other 2nd should still compete.
        const pool = Math.max(topK * 4, 20);
        const docs = rows.map((r) => tokenize(r.text));
        const bm25 = bm25Scores(tokenize(query), docs);
        const lexical = rows.map((row, i) => ({ id: row.id, score: bm25[i]! })).filter((x) => x.score > scoreFloor).sort((a, b) => b.score - a.score).slice(0, pool).map((x) => x.id);
        let semantic: string[] = [];
        if (queryEmbedding && useNativeVectors) {
          const r = await client.execute({ sql: "SELECT id, vector_distance_cos(embedding, vector32(?)) as dist FROM knowledge_vectors ORDER BY dist ASC LIMIT ?", args: [JSON.stringify(queryEmbedding), pool] });
          semantic = (r.rows as unknown as { id: string; dist: number }[]).filter((x) => 1 - x.dist > scoreFloor).map((x) => x.id);
        } else if (queryEmbedding) {
          semantic = rows
            .filter((r): r is KnowledgeRow & { embedding: string } => r.embedding !== null)
            .map((r) => ({ id: r.id, score: cosineSimilarity(queryEmbedding, JSON.parse(r.embedding) as number[]) }))
            .filter((x) => x.score > scoreFloor).sort((a, b) => b.score - a.score).slice(0, pool).map((x) => x.id);
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        return reciprocalRankFusion([lexical, semantic]).slice(0, topK).map(({ id, score }) => ({ id, sourceId: byId.get(id)!.sourceId, text: byId.get(id)!.text, score }));
      }

      if (useNativeVectors) {
        const [queryEmbedding] = await opts.embed!([query]);
        // No vector for the query (e.g. an embedder returning fewer results than asked) has nothing
        // honest to rank against — returns no results, same "don't fabricate a match" posture as an
        // empty store, rather than scoring everything arbitrarily.
        if (!queryEmbedding) return [];
        const result = await client.execute({
          sql: "SELECT kv.id as id, kv.sourceId as sourceId, kc.text as text, vector_distance_cos(kv.embedding, vector32(?)) as dist FROM knowledge_vectors kv JOIN knowledge_chunks kc ON kc.id = kv.id ORDER BY dist ASC LIMIT ?",
          args: [JSON.stringify(queryEmbedding), topK],
        });
        const rows = result.rows as unknown as { id: string; sourceId: string; text: string; dist: number }[];
        return rows
          .map((r) => ({ id: r.id, sourceId: r.sourceId, text: r.text, score: 1 - r.dist }))
          .filter((r) => r.score > scoreFloor);
      }

      const result = await client.execute("SELECT id, sourceId, text, embedding FROM knowledge_chunks");
      const rows = result.rows as unknown as KnowledgeRow[];
      if (rows.length === 0) return [];

      if (opts.embed) {
        const [queryEmbedding] = await opts.embed([query]);
        const embedded = rows.filter((r): r is KnowledgeRow & { embedding: string } => r.embedding !== null);
        const scored = embedded
          .map((row) => ({ row, score: queryEmbedding ? cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]) : 0 }))
          .filter((s) => s.score > scoreFloor)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        return scored.map((s) => ({ id: s.row.id, sourceId: s.row.sourceId, text: s.row.text, score: s.score }));
      }

      const queryTerms = tokenize(query);
      const docs = rows.map((r) => tokenize(r.text));
      const scores = bm25Scores(queryTerms, docs);
      return rows
        .map((row, i) => ({ row, score: scores[i]! }))
        .filter((s) => s.score > scoreFloor)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((s) => ({ id: s.row.id, sourceId: s.row.sourceId, text: s.row.text, score: s.score }));
    },
  };
}
