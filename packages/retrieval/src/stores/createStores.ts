import type { ChunkTextStore, EmbeddingSpace, VectorStore } from "../contracts.js";
import { createMemoryChunkTextStore } from "./memoryChunkTextStore.js";
import { createMemoryVectorStore } from "./memoryVectorStore.js";
import { createPgvectorStore } from "./pgvectorStore.js";
import { createPostgresChunkTextStore } from "./postgresChunkTextStore.js";
import { createPostgresSqlClient, type PostgresClient, type PostgresPoolOptions } from "./postgresClient.js";

/**
 * The ONE store factory both the worker (index build) and the API (query path) call (V3-P2).
 *
 * It exists so there is a single answer to "which store am I talking to", for the reason
 * V3-P0 consolidated the budget: two processes that resolve their own stores independently
 * are two processes that can disagree, and here disagreeing means the worker writes an index
 * the API cannot read. Both call this, both get the same decision from the same environment.
 *
 * DEGRADATION IS ANNOUNCED, NEVER SILENT. With no `postgresUrl`, or when the driver or the
 * connection cannot be constructed, this returns the in-memory pair and reports
 * `mode: "memory"` plus a `degradation` string. That is a genuinely different product — the
 * index lives in one process's heap, so the API cannot answer questions about an index the
 * worker built, and nothing survives a restart — so the caller is expected to surface it the
 * way V3-P0 surfaces a missing Redis, not to treat it as equivalent.
 */
export interface CreateRetrievalStoresOptions {
  /** The embedding space the index will live in. Baked into the store, and into the pgvector
   *  table name, so two spaces can never share one table. */
  space: EmbeddingSpace;
  /** Postgres connection string. Absent/empty ⇒ in-memory. */
  postgresUrl?: string;
  /** Run `CREATE EXTENSION / CREATE TABLE / CREATE INDEX` if absent. Default true: a migration
   *  step that has to be remembered is a migration step that gets forgotten. */
  ensureSchema?: boolean;
  /** Table prefix for the vector table (the dimension is appended). */
  vectorTablePrefix?: string;
  /** Table name for chunk text. */
  textTable?: string;
  /**
   * TEST SEAM: how a client is obtained from the URL. Defaults to the real `pg` pool.
   *
   * It exists because the degradation paths below are the whole point of this factory, and
   * exercising them against a real driver means attempting a real TCP connection — which the
   * hermetic suite must never do (and which took multiple seconds per test when it did). With
   * this, a test can return null (driver unavailable) or a fake that throws on DDL (reachable
   * but unusable) and assert the reported degradation, at zero I/O.
   */
  createClient?(options: PostgresPoolOptions): Promise<PostgresClient | null>;
}

export interface RetrievalStores {
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
  /** Which backend actually resolved. `"memory"` is a degradation when a URL was configured. */
  mode: "postgres" | "memory";
  /** Present when the intended backend was NOT reached; a human-readable reason to surface. */
  degradation?: string;
  /** The live pool, when one was created — so a caller can close it on shutdown. */
  sql: PostgresClient | null;
}

export async function createRetrievalStores(options: CreateRetrievalStoresOptions): Promise<RetrievalStores> {
  const url = options.postgresUrl?.trim();
  if (!url) {
    return {
      vectorStore: createMemoryVectorStore(options.space),
      textStore: createMemoryChunkTextStore(),
      mode: "memory",
      sql: null,
    };
  }

  const connect = options.createClient ?? createPostgresSqlClient;
  const sql = await connect({ connectionString: url });
  if (!sql) {
    return {
      vectorStore: createMemoryVectorStore(options.space),
      textStore: createMemoryChunkTextStore(),
      mode: "memory",
      degradation:
        "POSTGRES_URL is set but a Postgres client could not be constructed; the Q&A index is " +
        "per-process and will not survive a restart or be visible to other processes.",
      sql: null,
    };
  }

  const vectorStore = createPgvectorStore({
    sql,
    space: options.space,
    ...(options.vectorTablePrefix ? { tablePrefix: options.vectorTablePrefix } : {}),
  });
  const textStore = createPostgresChunkTextStore({ sql, ...(options.textTable ? { table: options.textTable } : {}) });

  if (options.ensureSchema !== false) {
    try {
      await vectorStore.ensureSchema();
      await textStore.ensureSchema();
    } catch (error) {
      // A reachable-but-unusable database (no `vector` extension available, no CREATE rights)
      // is the one case worth degrading rather than crashing the process at boot: the
      // deterministic pipeline still has value without a Q&A index.
      return {
        vectorStore: createMemoryVectorStore(options.space),
        textStore: createMemoryChunkTextStore(),
        mode: "memory",
        degradation:
          `Postgres is reachable but the retrieval schema could not be ensured (${
            error instanceof Error ? error.message : String(error)
          }); falling back to a per-process in-memory index.`,
        sql,
      };
    }
  }

  return { vectorStore, textStore, mode: "postgres", sql };
}
