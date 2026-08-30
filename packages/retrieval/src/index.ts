// @codeflow/retrieval — the retrieval layer (V3-P2).
//
// Sits BELOW @codeflow/analyzers (see contracts.ts for why). Owns the ONE vector-store
// interface, the chunk-text store, the embedding-space homogeneity guard, and the cosine
// primitive. Depends on nothing but @codeflow/shared-types + @codeflow/config; no database
// driver is a dependency of this package (production injects one).

export type {
  ChunkTextRecord,
  ChunkTextStore,
  EmbeddingClientLike,
  EmbeddingSpace,
  IndexedChunk,
  NamespaceParts,
  RerankCandidate,
  RerankResult,
  Reranker,
  RetrievedChunk,
  VectorFilter,
  VectorQuery,
  VectorRecord,
  VectorSearchHit,
  VectorStore,
} from "./contracts.js";

export { assertEmbeddingSpace, assertVectorDimension } from "./homogeneity.js";
export { retrievalNamespace } from "./namespace.js";
export { cosineSimilarity, retrieve, type Embedded } from "./vectorMath.js";
// The shared code tokenizer — one definition for the lexical index and the eval harness.
export { tokenizeCode } from "./tokenize.js";
// V3-P2 AST enrichment: what a chunk's vector SEES (path + scope + signature + docstring),
// derived deterministically from the spine. Never changes what a citation resolves to.
export {
  deriveEnrichment,
  embedTextFor,
  isEnriched,
  type DeriveEnrichmentInput,
  type EnrichableChunk,
  type SymbolSpan,
} from "./enrichment.js";
// V3-P2 task 3: hybrid retrieval. BM25 + vector, fused by RRF, reranked, diversified by MMR —
// with the similarity-floor refusal evaluated on the VECTOR arm's real cosine, unchanged.
export { Bm25Index, type Bm25Document, type Bm25Hit } from "./bm25.js";
export { reciprocalRankFusion, type FusedResult, type RankedList } from "./rrf.js";
export { mmrSelect, normalizeScores, type MmrCandidate } from "./mmr.js";
export {
  createCrossEncoderReranker,
  createIdentityReranker,
  createLexicalOverlapReranker,
  LEXICAL_RERANKER_ID,
  type CrossEncoderRerankerOptions,
  type CrossEncoderSession,
} from "./reranker.js";
export {
  hybridSearch,
  type HybridSearchDeps,
  type HybridSearchQuery,
  type HybridSearchResult,
  type HybridSearchTrace,
} from "./hybridSearch.js";
export {
  assertIndexHasStore,
  indexById,
  vectorRetrieve,
  type VectorRetrieveDeps,
  type VectorRetrieveQuery,
  type VectorRetrieveResult,
} from "./retrieveChunks.js";

// Stores. The in-memory pair is the HERMETIC DEFAULT (suite + eval + no-Postgres demo); the
// Postgres pair is the production adapter, integration-only.
export { createMemoryVectorStore } from "./stores/memoryVectorStore.js";
export { createMemoryChunkTextStore } from "./stores/memoryChunkTextStore.js";
// V3-P5 task 4 — the LOCAL-FIRST pair: an embedded file-backed store and a keyless in-process
// embedder. LanceDB was probed and REJECTED (656 MB, native NAPI, drags onnxruntime-node back in);
// see fileVectorStore.ts and localEmbedding.ts for the evidence and the upgrade path.
export {
  createFileChunkTextStore,
  createFileVectorStore,
  type FileVectorStoreOptions,
} from "./stores/fileVectorStore.js";
export {
  createLocalEmbeddingClient,
  localEmbed,
  LOCAL_EMBEDDING_DIM,
  LOCAL_EMBEDDING_MODEL,
  type LocalEmbeddingClient,
  type LocalEmbeddingRequest,
  type LocalEmbeddingResult,
} from "./localEmbedding.js";
export { createPgvectorStore, toVectorLiteral, vectorTableName, type PgvectorStoreOptions } from "./stores/pgvectorStore.js";
export {
  createPostgresChunkTextStore,
  type PostgresChunkTextStoreOptions,
} from "./stores/postgresChunkTextStore.js";
export type { SqlClientLike, SqlQueryResult } from "./stores/sqlClient.js";
// The ONE store factory both the worker and the API call, so they cannot disagree about which
// backend they are talking to. Reports honest degradation instead of silently going in-memory.
export {
  createRetrievalStores,
  type CreateRetrievalStoresOptions,
  type RetrievalStores,
} from "./stores/createStores.js";
export { createPostgresSqlClient, type PostgresClient, type PostgresPoolOptions } from "./stores/postgresClient.js";
