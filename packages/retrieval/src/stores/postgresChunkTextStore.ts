import type { ChunkTextRecord, ChunkTextStore } from "../contracts.js";
import type { SqlClientLike } from "./sqlClient.js";

/**
 * The Postgres `ChunkTextStore` — production adapter for chunk text (V3-P2).
 *
 * WHY POSTGRES AND NOT OBJECT STORAGE. The V3 plan said "store text in object storage", and
 * for a document-per-chunk blob store that would be defensible. But the access pattern here is
 * "give me the text for these 40 chunk ids, now, on the Q&A hot path" — 40 primary-key reads,
 * not 40 HTTP GETs against S3 with 40 round trips of latency. It also means chunk text and
 * chunk vectors live in the SAME instance and can be dropped in one transaction, so a
 * re-index cannot leave orphaned text behind. Object storage stays the right answer for the
 * things that are genuinely large and cold (raw file snapshots, P5).
 *
 * INTEGRATION-ONLY, like the pgvector store: driven in the suite against a recording fake
 * `SqlClientLike`; the live round trip is in the deferred manual bucket.
 */
export interface PostgresChunkTextStoreOptions {
  sql: SqlClientLike;
  /** Table name. Overridable so a test/staging index can share an instance. */
  table?: string;
}

const DEFAULT_TEXT_TABLE = "codeflow_chunk_text";
/** Rows per INSERT; 2 bound params per row, far under Postgres' 65535-param limit. */
const PUT_BATCH_ROWS = 500;

export function createPostgresChunkTextStore(
  options: PostgresChunkTextStoreOptions,
): ChunkTextStore & { ensureSchema(): Promise<void> } {
  const table = options.table ?? DEFAULT_TEXT_TABLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`chunk-text table must be a bare lowercase SQL identifier (got "${table}").`);
  }
  const sql = options.sql;

  return {
    id: `postgres:${table}`,

    async ensureSchema(): Promise<void> {
      // No dimension in the name here (unlike the vector table): text has no shape, so one
      // table serves every embedding space, and the namespace still separates them.
      await sql.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           namespace  text NOT NULL,
           chunk_id   text NOT NULL,
           chunk_text text NOT NULL,
           PRIMARY KEY (namespace, chunk_id)
         )`,
      );
    },

    async put(namespace: string, records: readonly ChunkTextRecord[]): Promise<void> {
      if (records.length === 0) return;
      for (let offset = 0; offset < records.length; offset += PUT_BATCH_ROWS) {
        const batch = records.slice(offset, offset + PUT_BATCH_ROWS);
        const params: unknown[] = [namespace];
        const tuples: string[] = [];
        for (const record of batch) {
          const base = params.length;
          params.push(record.id, record.text);
          tuples.push(`($1, $${base + 1}, $${base + 2})`);
        }
        await sql.query(
          `INSERT INTO ${table} (namespace, chunk_id, chunk_text)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (namespace, chunk_id) DO UPDATE SET chunk_text = EXCLUDED.chunk_text`,
          params,
        );
      }
    },

    async get(namespace: string, ids: readonly string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const { rows } = await sql.query<{ chunk_id: string; chunk_text: string }>(
        `SELECT chunk_id, chunk_text FROM ${table} WHERE namespace = $1 AND chunk_id = ANY($2)`,
        [namespace, [...ids]],
      );
      // Rows come back for the ids that EXIST. A missing id is simply absent from the map —
      // never defaulted to "", which would enter a prompt as a contentless chunk and let the
      // model cite a file whose text it never saw.
      for (const row of rows) out.set(row.chunk_id, row.chunk_text);
      return out;
    },

    async drop(namespace: string): Promise<void> {
      await sql.query(`DELETE FROM ${table} WHERE namespace = $1`, [namespace]);
    },
  };
}
