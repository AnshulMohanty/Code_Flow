import type {
  EmbeddingSpace,
  VectorQuery,
  VectorRecord,
  VectorSearchHit,
  VectorStore,
} from "../contracts.js";
import { assertVectorDimension } from "../homogeneity.js";
import type { SqlClientLike } from "./sqlClient.js";

/**
 * The pgvector `VectorStore` — the PRODUCTION adapter (V3-P2).
 *
 * INTEGRATION-ONLY. Nothing in the hermetic suite talks to a real Postgres; the suite drives
 * this class against a recording fake `SqlClientLike` to assert the SQL it emits (parameters
 * bound, namespace scoped, cosine operator, deterministic ORDER BY), and the real round trip
 * against a live pgvector container is in the deferred manual bucket.
 *
 * THE DIMENSION IS IN THE TABLE NAME, on purpose. pgvector's `vector(n)` is a fixed-width
 * type, so one table cannot hold two embedding spaces. Rather than discovering that at insert
 * time with a type error — or worse, creating the table at whatever dimension happened to run
 * first and then silently rejecting every other model — each dimension gets its own table
 * (`codeflow_vectors_1024`). Postgres then enforces homogeneity itself, which is a stronger
 * guarantee than an application-level check, and re-indexing with a new model cannot corrupt
 * the old index.
 *
 * INDEX CHOICE: HNSW with `vector_cosine_ops`, because the whole codebase's notion of
 * similarity is cosine and an index built for L2 would rank differently from every other code
 * path. HNSW is approximate — recall is below 100% by construction — which is exactly why the
 * in-memory store (an exact scan) stays the eval default: an eval number must not move because
 * an ANN index made a different guess. Note pgvector caps HNSW at 2000 dimensions; above that
 * `ensureSchema` deliberately skips the index and leaves an exact scan rather than failing.
 */
export interface PgvectorStoreOptions {
  sql: SqlClientLike;
  space: EmbeddingSpace;
  /** Table prefix. Overridable so a test/staging index can share an instance. */
  tablePrefix?: string;
}

const DEFAULT_VECTOR_TABLE_PREFIX = "codeflow_vectors";
/** pgvector's documented HNSW dimension ceiling. Above it, we index nothing (exact scan). */
const HNSW_MAX_DIM = 2000;
/** Rows per INSERT. 6 bound params per row keeps us far under Postgres' 65535-param limit. */
const UPSERT_BATCH_ROWS = 500;

export function createPgvectorStore(options: PgvectorStoreOptions): VectorStore & { ensureSchema(): Promise<void> } {
  const { sql, space } = options;
  const table = vectorTableName(options.tablePrefix ?? DEFAULT_VECTOR_TABLE_PREFIX, space.embeddingDim);

  return {
    id: `pgvector:${table}`,
    space,

    /**
     * Create the extension, the table and the indexes if they are absent. Idempotent, so it is
     * safe to call on every worker boot — which is how it is wired, because a migration step
     * that has to be remembered is a migration step that gets forgotten.
     */
    async ensureSchema(): Promise<void> {
      await sql.query("CREATE EXTENSION IF NOT EXISTS vector");
      await sql.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           namespace   text    NOT NULL,
           chunk_id    text    NOT NULL,
           file_id     text    NOT NULL,
           start_line  integer NOT NULL,
           end_line    integer NOT NULL,
           symbol_name text,
           embedding   vector(${space.embeddingDim}) NOT NULL,
           PRIMARY KEY (namespace, chunk_id)
         )`,
      );
      // Supports the fileIds filter without a table scan (Phase 3's graph tools scope by file).
      await sql.query(`CREATE INDEX IF NOT EXISTS ${table}_ns_file_idx ON ${table} (namespace, file_id)`);
      if (space.embeddingDim <= HNSW_MAX_DIM) {
        await sql.query(
          `CREATE INDEX IF NOT EXISTS ${table}_hnsw_idx ON ${table} USING hnsw (embedding vector_cosine_ops)`,
        );
      }
    },

    async upsert(namespace: string, records: readonly VectorRecord[]): Promise<void> {
      if (records.length === 0) return;
      for (const record of records) {
        assertVectorDimension(record.vector, space, `pgvector upsert of chunk ${record.id}`);
      }
      // Batched multi-row INSERTs. A per-record round trip would be tens of thousands of them
      // on a real repo; the batch is capped because Postgres binds at most 65535 parameters
      // per statement and 6 params per row means the ceiling is real, not theoretical.
      for (let offset = 0; offset < records.length; offset += UPSERT_BATCH_ROWS) {
        const batch = records.slice(offset, offset + UPSERT_BATCH_ROWS);
        const params: unknown[] = [namespace];
        const tuples: string[] = [];
        for (const record of batch) {
          const base = params.length;
          params.push(
            record.id,
            record.fileId,
            record.startLine,
            record.endLine,
            record.symbolName ?? null,
            toVectorLiteral(record.vector),
          );
          tuples.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
        }
        // ON CONFLICT makes a re-analysis of the same SHA an overwrite rather than a duplicate
        // key error or a second copy of the index.
        await sql.query(
          `INSERT INTO ${table} (namespace, chunk_id, file_id, start_line, end_line, symbol_name, embedding)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (namespace, chunk_id) DO UPDATE SET
             file_id = EXCLUDED.file_id,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             symbol_name = EXCLUDED.symbol_name,
             embedding = EXCLUDED.embedding`,
          params,
        );
      }
    },

    async search(namespace: string, query: VectorQuery): Promise<VectorSearchHit[]> {
      assertVectorDimension(query.vector, space, "pgvector search");
      if (query.k <= 0) return [];

      const params: unknown[] = [namespace, toVectorLiteral(query.vector), query.k];
      let fileFilter = "";
      if (query.filter?.fileIds) {
        // An explicitly EMPTY filter means "no files are allowed", which is an empty result —
        // not "no filter". Collapsing the two would silently widen the search.
        if (query.filter.fileIds.length === 0) return [];
        params.push([...query.filter.fileIds]);
        fileFilter = ` AND file_id = ANY($${params.length})`;
      }

      // `<=>` is pgvector's cosine DISTANCE, so similarity is 1 - distance. Ordering by the
      // distance ascending is what lets the HNSW index serve the query; the secondary
      // chunk_id sort makes the order total, matching the in-memory store's tie-break.
      const { rows } = await sql.query<{
        chunk_id: string;
        file_id: string;
        start_line: number;
        end_line: number;
        symbol_name: string | null;
        distance: number | string;
      }>(
        `SELECT chunk_id, file_id, start_line, end_line, symbol_name, (embedding <=> $2) AS distance
           FROM ${table}
          WHERE namespace = $1${fileFilter}
          ORDER BY distance ASC, chunk_id ASC
          LIMIT $3`,
        params,
      );

      return rows.map((row) => ({
        id: row.chunk_id,
        score: 1 - Number(row.distance),
        fileId: row.file_id,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        ...(row.symbol_name ? { symbolName: row.symbol_name } : {}),
      }));
    },

    async count(namespace: string): Promise<number> {
      const { rows } = await sql.query<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE namespace = $1`,
        [namespace],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async drop(namespace: string): Promise<void> {
      await sql.query(`DELETE FROM ${table} WHERE namespace = $1`, [namespace]);
    },
  };
}

/**
 * Build the dimension-suffixed table name, validating the dimension first.
 *
 * The dimension is interpolated into SQL (a table name cannot be a bound parameter), so it is
 * checked to be a plain positive integer within pgvector's `vector(n)` limit. That check is
 * the injection guard: nothing else about this string comes from outside.
 */
export function vectorTableName(prefix: string, dim: number): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`pgvector table prefix must be a bare lowercase SQL identifier (got "${prefix}").`);
  }
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) {
    throw new Error(`pgvector dimension must be an integer in 1..16000 (got ${String(dim)}).`);
  }
  return `${prefix}_${dim}`;
}

/**
 * Render a vector as pgvector's text literal, `[1,2,3]`.
 *
 * Non-finite values are rejected rather than serialised: `NaN` reaches Postgres as the literal
 * text "NaN", which pgvector accepts into a float, and from then on every distance involving
 * that row is NaN and the row sorts unpredictably. A bad vector is a provider bug worth seeing.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  const parts: string[] = [];
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("pgvector: refusing to store a non-finite vector component (NaN/Infinity).");
    }
    parts.push(String(value));
  }
  return `[${parts.join(",")}]`;
}
