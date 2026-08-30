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
