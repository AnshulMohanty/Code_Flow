import type { SqlClientLike } from "./sqlClient.js";

/**
 * The real Postgres wiring — the ONE place in this package that touches a driver (V3-P2).
 *
 * Everything else here talks to `SqlClientLike`. That seam is what lets the hermetic suite
 * drive the pgvector and chunk-text adapters against a recording fake and assert the exact SQL
 * they emit, with no container, no port and no cleanup. This module is the other half: it
 * turns a connection string into something satisfying that seam.
 *
 * `pg` is imported DYNAMICALLY, for the same two reasons `apps/api` imports `ioredis`
 * dynamically: the test suite must never load a database driver, and a deployment with no
 * `POSTGRES_URL` must start fine rather than crash on an import it will never use. `pg` is a
 * declared dependency (pure JavaScript — no `node-gyp`, no native toolchain, so it installs in
 * the pruned `node:20-slim` image), so the import is explicit rather than transitively hoped for.
 *
 * Returns `null` when the driver or the connection cannot be constructed. Null is a SIGNAL,
 * not a swallowed error: the caller degrades to the in-memory stores and must say so out loud
 * (V3-P0's honest-degradation rule), because an index that silently lives in one worker's heap
 * behaves completely differently from a shared one.
 */
export interface PostgresPoolOptions {
  connectionString: string;
  /** Max pooled connections. Small by default: the index write path is batched, and the query
   *  path is a handful of keyed reads, so a large pool buys nothing and costs server slots. */
  max?: number;
  /** Fail fast rather than hanging a Q&A request behind a dead database. */
  connectionTimeoutMillis?: number;
}

/** What `pg.Pool` exposes that we use. Declared so this module needs no `pg` types at build. */
interface PoolLike extends SqlClientLike {
  end(): Promise<void>;
  on?(event: "error", listener: (error: unknown) => void): unknown;
}

export type PostgresClient = PoolLike;

export async function createPostgresSqlClient(options: PostgresPoolOptions): Promise<PostgresClient | null> {
  try {
    const pg = await import("pg");
    // `pg` is CommonJS; under NodeNext the named export may live on `default`.
    const Pool =
      (pg as unknown as { Pool?: unknown }).Pool ?? (pg as unknown as { default?: { Pool?: unknown } }).default?.Pool;
    if (typeof Pool !== "function") return null;
    const pool = new (Pool as new (config: unknown) => PoolLike)({
      connectionString: options.connectionString,
      max: options.max ?? 5,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    });
    // REQUIRED, same trap as ioredis: `pg.Pool` emits 'error' for a failure on an IDLE client,
    // and with no listener Node treats it as an unhandled exception and can take the process
    // down — a database blip would kill the worker. Per-call failures still reject normally.
    pool.on?.("error", () => {
      /* handled per-call by the store adapters, which reject and let the stage degrade */
    });
    return pool;
  } catch {
    return null;
  }
}
