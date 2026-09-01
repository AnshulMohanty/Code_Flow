import type { RagChunk } from "@codeflow/shared-types";

/**
 * `@codeflow/retrieval` — the retrieval layer (V3-P2).
 *
 * WHY THIS PACKAGE EXISTS. Before P2 the "vector store" was an array inside the analysis
 * document: `result.ai.rag.chunks[].embedding`. That is fine at 200 chunks and impossible at
 * 20,000 — a 1024-dim float array per chunk is roughly 8KB of JSON, so a mid-sized repo blows
 * the 16MB BSON document limit, and every read of an analysis (the dashboard, the job poll)
 * dragged the whole index across the wire. Vectors belong in an index; text belongs in a
 * table; the analysis document keeps only the METADATA needed to render a citation.
 *
 * DEPENDENCY DIRECTION. This package sits BELOW `@codeflow/analyzers` and depends on nothing
 * but `@codeflow/shared-types` and `@codeflow/config`. That is deliberate: the pipeline stage
 * that builds an index and the query path that reads one must both talk to the same
 * interface, and putting the interface in analyzers would have made retrieval -> analyzers ->
 * retrieval a cycle. The homogeneity guard and the cosine primitive moved down here for the
 * same reason: they are retrieval concerns. `@codeflow/analyzers` re-exports both, so there
 * is still exactly ONE definition of each and existing import paths keep working.
 *
 * NO REAL DRIVER IS A DEPENDENCY. pgvector is reached through an injected `SqlClientLike`
 * (the pattern V3-P0 used for `BudgetRedisLike`), so this package installs no `pg`, the
 * hermetic suite runs against an in-memory store, and production hands over a real pool. A
 * library that imports a database driver forces every consumer to install one.
 */

// -- Embedding space (the homogeneity keyspace) --------------------------------------

/**
 * The vector space an index lives in. Cosine similarity between vectors from two different
 * models — or the same model at two output dimensions — is a meaningless number that looks
 * exactly like a meaningful one, which is why every store carries its space and every
 * boundary asserts on it rather than trusting the caller.
 */
export interface EmbeddingSpace {
  embeddingModel: string;
  embeddingDim: number;
}

/** The shape of an embedding client, as far as a homogeneity check cares. */
export interface EmbeddingClientLike {
  provider: string;
  model: string;
  dimension: number;
}

// -- Namespace ----------------------------------------------------------------------

/**
 * A namespace isolates one repository-at-one-commit's vectors from every other. It is part of
 * the primary key in both stores, so re-analysing the same SHA overwrites in place while a
 * new SHA lands beside the old one instead of polluting it.
 */
export interface NamespaceParts {
  repoFullName: string;
  commitSha: string;
  embeddingModel: string;
  embeddingDim: number;
}

// -- Vector store -------------------------------------------------------------------

/** One vector plus the coordinates a citation needs. Metadata is deliberately minimal: only
 *  what a filter or a grounded citation reads, never the chunk text (that is the text store). */
export interface VectorRecord {
  /** The chunk id, `fileId#startLine-endLine` — unchanged since P18. */
  id: string;
  vector: number[];
  fileId: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}

/** Server-side filter. Kept small on purpose: every field here must be expressible as a SQL
 *  predicate on an indexed column, or the pgvector adapter degrades into a table scan. */
export interface VectorFilter {
  /** Restrict the search to these fileIds (Phase 3's graph tools scope by file this way). */
  fileIds?: readonly string[];
}

export interface VectorQuery {
  vector: number[];
  k: number;
  filter?: VectorFilter;
}

/** A ranked hit. `score` is COSINE SIMILARITY in [-1, 1] — 1 is identical — in every
 *  implementation, so the similarity floor means the same thing regardless of backend. */
export interface VectorSearchHit {
  id: string;
  score: number;
  fileId: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}

/**
 * THE one vector-store interface. `search` is the only method the query path needs; the rest
 * exist for index lifecycle.
 *
 * Every implementation must guarantee:
 *   - `space` matches the vectors it holds, and `upsert`/`search` REJECT a wrong-length
 *     vector rather than storing or scoring it (an index that silently mixes spaces returns
 *     confident nonsense forever);
 *   - `search` is a total, deterministic order: ties broken by `id` ascending, so two runs
 *     over the same data return the same list. Non-determinism here would leak straight into
 *     the RRF fusion above it.
 */
export interface VectorStore {
  readonly id: string;
  readonly space: EmbeddingSpace;
  upsert(namespace: string, records: readonly VectorRecord[]): Promise<void>;
  search(namespace: string, query: VectorQuery): Promise<VectorSearchHit[]>;
  count(namespace: string): Promise<number>;
  /** Remove a whole namespace (re-index, or garbage-collecting an old SHA). */
  drop(namespace: string): Promise<void>;
}

// -- Chunk text store ---------------------------------------------------------------

export interface ChunkTextRecord {
  id: string;
  /** The EXACT file bytes for the chunk's line range. Never enriched — see `embedTextFor`. */
  text: string;
}

/**
 * Where chunk text lives once it is out of the analysis document. Postgres (the same instance
 * as pgvector) rather than object storage: the query path fetches text for roughly 20 ids at
 * a time by primary key, which is a keyed lookup, not a blob download. LanceDB (P5) can
 * implement both this and `VectorStore` behind the same two interfaces.
 */
export interface ChunkTextStore {
  readonly id: string;
  put(namespace: string, records: readonly ChunkTextRecord[]): Promise<void>;
  /** Resolves id -> text for the ids that exist. A MISSING id is omitted, never faked. */
  get(namespace: string, ids: readonly string[]): Promise<Map<string, string>>;
  drop(namespace: string): Promise<void>;
}

// -- Reranker -----------------------------------------------------------------------

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  /** Higher is more relevant. Scales differ per implementation, so this is ORDINAL only —
   *  never compared against a cosine similarity or a threshold. */
  score: number;
}

/**
 * A reranker re-scores a small candidate set against the query text with a model that sees
 * query and document TOGETHER (a cross-encoder), which is strictly more informative than
 * comparing two independently-computed embeddings — and far too slow to run over a whole
 * index, which is why it runs after fusion on a few dozen candidates.
 *
 * `kind` is the honesty field: "deterministic" says no model was involved, so a caller (and a
 * report) can tell a real rerank from the deterministic stand-in the hermetic suite uses.
 */
export interface Reranker {
  readonly id: string;
  readonly kind: "deterministic" | "cross-encoder";
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult[]>;
}

// -- Retrieved chunk (what the query path returns) ----------------------------------

/**
 * A chunk that came back from retrieval: the persisted metadata, plus the text fetched from
 * the text store, plus the scores that put it here. Distinct from `RagChunk` (metadata only,
 * persisted) and from `IndexedChunk` (metadata + text + vector, in flight during indexing) —
 * three names because they have three different lifetimes, and collapsing them is what put
 * embeddings in the Mongo document in the first place.
 */
export interface RetrievedChunk extends RagChunk {
  text: string;
  /** Cosine similarity from the vector store, when the vector arm found it. */
  vectorScore?: number;
  /** BM25 score, when the lexical arm found it. */
  lexicalScore?: number;
  /** Fused RRF score — ordinal, not a similarity. */
  fusedScore: number;
  /** Reranker score, when a reranker ran. */
  rerankScore?: number;
  /** Which arms surfaced it: "vector", "lexical", or both. Reported, because "the lexical
   *  arm found what the vector arm missed" is the whole argument for hybrid retrieval. */
  sources: Array<"vector" | "lexical">;
}

/** A full chunk in flight during indexing: metadata + text + its vector. NEVER persisted to
 *  the analysis document — that is the entire point of P2. */
export interface IndexedChunk extends RagChunk {
  text: string;
  embedding: number[];
}
