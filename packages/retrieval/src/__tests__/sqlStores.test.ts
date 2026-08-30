import { describe, expect, it } from "vitest";
import { createPgvectorStore, toVectorLiteral, vectorTableName } from "../stores/pgvectorStore.js";
import { createPostgresChunkTextStore } from "../stores/postgresChunkTextStore.js";
import { createRetrievalStores } from "../stores/createStores.js";
import type { SqlClientLike, SqlQueryResult } from "../stores/sqlClient.js";

// HERMETIC test of the PRODUCTION adapters. No container, no port, no cleanup: the adapters
// talk to `SqlClientLike`, so a recording fake is enough to assert everything that can be
// wrong in the layer we actually wrote — the SQL text, the parameter binding, the namespace
// scoping, the cosine operator, the deterministic ORDER BY, the batching. What it cannot
// assert is that Postgres accepts the SQL; that is the deferred integration run, and this test
// is what makes that run a confirmation rather than the first time anything was checked.

interface Recorded {
  sql: string;
  params: readonly unknown[];
}

interface FakeSql extends SqlClientLike {
  calls: Recorded[];
  rows: Array<Record<string, unknown>>;
}

function fakeSql(rows: Array<Record<string, unknown>> = []): FakeSql {
  const calls: Recorded[] = [];
  return {
    calls,
    rows,
    async query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
      calls.push({ sql, params: params ?? [] });
      return { rows: rows as unknown as Row[] };
    },
  };
}

const SPACE = { embeddingModel: "voyage-code-3", embeddingDim: 3 };
const NS = "acme/repo@sha1/voyage-code-3/3";

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("vectorTableName — the dimension is in the table name, and validated", () => {
  it("appends the dimension, so two embedding spaces cannot share a table", () => {
    // pgvector's `vector(n)` is fixed-width, so this is not a naming preference: it is what
    // makes Postgres itself enforce homogeneity.
    expect(vectorTableName("codeflow_vectors", 1024)).toBe("codeflow_vectors_1024");
    expect(vectorTableName("codeflow_vectors", 768)).toBe("codeflow_vectors_768");
  });

  it("rejects a non-integer / out-of-range dimension", () => {
    expect(() => vectorTableName("codeflow_vectors", 0)).toThrow(/1\.\.16000/);
    expect(() => vectorTableName("codeflow_vectors", 1.5)).toThrow(/1\.\.16000/);
    expect(() => vectorTableName("codeflow_vectors", 99999)).toThrow(/1\.\.16000/);
  });

  it("rejects a prefix that is not a bare SQL identifier (it is interpolated, not bound)", () => {
    expect(() => vectorTableName('v"; DROP TABLE x; --', 3)).toThrow(/bare lowercase SQL identifier/);
  });
});

describe("toVectorLiteral", () => {
  it("renders pgvector's bracketed literal", () => {
    expect(toVectorLiteral([1, -0.5, 0])).toBe("[1,-0.5,0]");
  });

  it("refuses a non-finite component", () => {
    // NaN reaches Postgres as the text "NaN", pgvector accepts it into a float, and from then
    // on every distance involving that row is NaN and the row sorts unpredictably.
    expect(() => toVectorLiteral([1, Number.NaN, 0])).toThrow(/non-finite/);
    expect(() => toVectorLiteral([1, Infinity, 0])).toThrow(/non-finite/);
  });
});

describe("createPgvectorStore — schema", () => {
  it("creates the extension, a dimension-typed table, the file index and an HNSW cosine index", async () => {
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: SPACE });
    await store.ensureSchema();

    const statements = sql.calls.map((call) => normalize(call.sql));
    expect(statements[0]).toBe("CREATE EXTENSION IF NOT EXISTS vector");
    expect(statements[1]).toContain("CREATE TABLE IF NOT EXISTS codeflow_vectors_3");
    expect(statements[1]).toContain("embedding vector(3) NOT NULL");
    expect(statements[1]).toContain("PRIMARY KEY (namespace, chunk_id)");
    expect(statements.some((s) => s.includes("(namespace, file_id)"))).toBe(true);
    // Cosine ops specifically: an L2 index would rank differently from every other code path
    // in this repo, which all define similarity as cosine.
    expect(statements.some((s) => s.includes("USING hnsw (embedding vector_cosine_ops)"))).toBe(true);
  });

  it("skips the HNSW index above pgvector's 2000-dimension ceiling (exact scan, not a crash)", async () => {
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: { embeddingModel: "big", embeddingDim: 3072 } });
    await store.ensureSchema();
    expect(sql.calls.some((call) => call.sql.includes("hnsw"))).toBe(false);
    expect(sql.calls.some((call) => call.sql.includes("vector(3072)"))).toBe(true);
  });

  it("reports its identity including the table, so an index/store mismatch is diagnosable", () => {
    expect(createPgvectorStore({ sql: fakeSql(), space: SPACE }).id).toBe("pgvector:codeflow_vectors_3");
  });
});

describe("createPgvectorStore — upsert", () => {
  it("binds every value as a parameter and upserts on the primary key", async () => {
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: SPACE });
    await store.upsert(NS, [
      { id: "src/a.ts#1-3", vector: [1, 0, 0], fileId: "src/a.ts", startLine: 1, endLine: 3, symbolName: "foo" },
    ]);

    expect(sql.calls).toHaveLength(1);
    const call = sql.calls[0];
    expect(normalize(call.sql)).toContain("ON CONFLICT (namespace, chunk_id) DO UPDATE SET");
    expect(call.params).toEqual([NS, "src/a.ts#1-3", "src/a.ts", 1, 3, "foo", "[1,0,0]"]);
    // No value is interpolated into the SQL text.
    expect(call.sql).not.toContain("src/a.ts");
  });

  it("passes symbolName as NULL rather than the string 'undefined'", async () => {
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: SPACE });
    await store.upsert(NS, [{ id: "a#1-1", vector: [1, 0, 0], fileId: "a", startLine: 1, endLine: 1 }]);
    expect(sql.calls[0].params[5]).toBeNull();
  });

  it("batches into multi-row INSERTs instead of one round trip per chunk", async () => {
    // A real repo is tens of thousands of chunks; a per-row INSERT would be tens of thousands
    // of round trips. The batch size is also bounded by Postgres' 65535-parameter limit.
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: SPACE });
    const records = Array.from({ length: 1200 }, (_, i) => ({
      id: `f${i}.ts#1-1`,
      vector: [1, 0, 0],
      fileId: `f${i}.ts`,
      startLine: 1,
      endLine: 1,
    }));
    await store.upsert(NS, records);

    expect(sql.calls).toHaveLength(3); // 500 + 500 + 200
    // 1 namespace param + 6 per row.
    expect(sql.calls[0].params).toHaveLength(1 + 500 * 6);
    expect(sql.calls[2].params).toHaveLength(1 + 200 * 6);
  });

  it("does nothing at all for an empty batch", async () => {
    const sql = fakeSql();
    await createPgvectorStore({ sql, space: SPACE }).upsert(NS, []);
    expect(sql.calls).toEqual([]);
  });

  it("refuses a wrong-length vector before touching the database", async () => {
    const sql = fakeSql();
    const store = createPgvectorStore({ sql, space: SPACE });
    await expect(store.upsert(NS, [{ id: "a#1-1", vector: [1, 0], fileId: "a", startLine: 1, endLine: 1 }])).rejects.toThrow(
      /2 dimensions/,
    );
    expect(sql.calls).toEqual([]);
  });
});

describe("createPgvectorStore — search", () => {
  it("scopes by namespace, orders by cosine distance, and converts distance back to similarity", async () => {
    const sql = fakeSql([
      { chunk_id: "src/a.ts#1-3", file_id: "src/a.ts", start_line: 1, end_line: 3, symbol_name: "foo", distance: 0.25 },
    ]);
    const store = createPgvectorStore({ sql, space: SPACE });
    const hits = await store.search(NS, { vector: [1, 0, 0], k: 5 });

    const text = normalize(sql.calls[0].sql);
    expect(text).toContain("(embedding <=> $2) AS distance");
    expect(text).toContain("WHERE namespace = $1");
    expect(text).toContain("ORDER BY distance ASC, chunk_id ASC"); // total order, matches memory
    expect(sql.calls[0].params).toEqual([NS, "[1,0,0]", 5]);
    // `<=>` is DISTANCE; the contract says `score` is similarity.
    expect(hits[0].score).toBeCloseTo(0.75);
    expect(hits[0]).toMatchObject({ id: "src/a.ts#1-3", fileId: "src/a.ts", startLine: 1, endLine: 3, symbolName: "foo" });
  });

  it("coerces the driver's numeric strings (pg returns some numerics as text)", async () => {
    const sql = fakeSql([
      { chunk_id: "a#1-1", file_id: "a", start_line: "1", end_line: "1", symbol_name: null, distance: "0.5" },
    ]);
    const [hit] = await createPgvectorStore({ sql, space: SPACE }).search(NS, { vector: [1, 0, 0], k: 1 });
    expect(hit.score).toBeCloseTo(0.5);
    expect(hit.startLine).toBe(1);
    expect(hit.symbolName).toBeUndefined();
  });

  it("adds a bound ANY() predicate for a fileIds filter", async () => {
    const sql = fakeSql();
    await createPgvectorStore({ sql, space: SPACE }).search(NS, {
      vector: [1, 0, 0],
      k: 5,
      filter: { fileIds: ["a.ts", "b.ts"] },
    });
    expect(normalize(sql.calls[0].sql)).toContain("AND file_id = ANY($4)");
    expect(sql.calls[0].params[3]).toEqual(["a.ts", "b.ts"]);
  });

  it("returns nothing — WITHOUT a query — for an empty fileIds filter", async () => {
    const sql = fakeSql();
    expect(
      await createPgvectorStore({ sql, space: SPACE }).search(NS, { vector: [1, 0, 0], k: 5, filter: { fileIds: [] } }),
    ).toEqual([]);
    expect(sql.calls).toEqual([]);
  });

  it("returns nothing for k <= 0 without querying", async () => {
    const sql = fakeSql();
    expect(await createPgvectorStore({ sql, space: SPACE }).search(NS, { vector: [1, 0, 0], k: 0 })).toEqual([]);
    expect(sql.calls).toEqual([]);
  });
});

describe("createPgvectorStore — count and drop", () => {
  it("counts within the namespace only", async () => {
    const sql = fakeSql([{ count: 42 }]);
    expect(await createPgvectorStore({ sql, space: SPACE }).count(NS)).toBe(42);
    expect(sql.calls[0].params).toEqual([NS]);
  });

  it("drop DELETEs the namespace rather than the table", async () => {
    // Dropping the table would take every other repository's index with it.
    const sql = fakeSql();
    await createPgvectorStore({ sql, space: SPACE }).drop(NS);
    expect(normalize(sql.calls[0].sql)).toBe("DELETE FROM codeflow_vectors_3 WHERE namespace = $1");
    expect(sql.calls[0].params).toEqual([NS]);
  });
});

describe("createPostgresChunkTextStore", () => {
  it("creates one keyed table (no dimension — text has no shape)", async () => {
    const sql = fakeSql();
    const store = createPostgresChunkTextStore({ sql });
    await store.ensureSchema();
    const text = normalize(sql.calls[0].sql);
    expect(text).toContain("CREATE TABLE IF NOT EXISTS codeflow_chunk_text");
    expect(text).toContain("PRIMARY KEY (namespace, chunk_id)");
  });

  it("rejects a table name that is not a bare SQL identifier", () => {
    expect(() => createPostgresChunkTextStore({ sql: fakeSql(), table: "x; DROP TABLE y" })).toThrow(
      /bare lowercase SQL identifier/,
    );
  });

  it("binds text as a parameter and upserts on conflict", async () => {
    const sql = fakeSql();
    await createPostgresChunkTextStore({ sql }).put(NS, [{ id: "a#1-2", text: "SELECT 'not sql injection'" }]);
    expect(normalize(sql.calls[0].sql)).toContain("ON CONFLICT (namespace, chunk_id) DO UPDATE SET chunk_text");
    expect(sql.calls[0].params).toEqual([NS, "a#1-2", "SELECT 'not sql injection'"]);
  });

  it("batches puts", async () => {
    const sql = fakeSql();
    const records = Array.from({ length: 700 }, (_, i) => ({ id: `c${i}`, text: "x" }));
    await createPostgresChunkTextStore({ sql }).put(NS, records);
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].params).toHaveLength(1 + 500 * 2);
  });

  it("gets by ANY(ids) and omits ids the table did not return", async () => {
    const sql = fakeSql([{ chunk_id: "a#1-2", chunk_text: "hello" }]);
    const got = await createPostgresChunkTextStore({ sql }).get(NS, ["a#1-2", "gone#1-1"]);
    expect(normalize(sql.calls[0].sql)).toContain("chunk_id = ANY($2)");
    expect(got.get("a#1-2")).toBe("hello");
    expect(got.has("gone#1-1")).toBe(false);
  });

  it("does not query for an empty id list", async () => {
    const sql = fakeSql();
    expect((await createPostgresChunkTextStore({ sql }).get(NS, [])).size).toBe(0);
    expect(sql.calls).toEqual([]);
  });
});

describe("createRetrievalStores — the one factory both processes call", () => {
  it("with no POSTGRES_URL: in-memory, mode 'memory', and NO degradation (a supported mode)", async () => {
    const stores = await createRetrievalStores({ space: SPACE });
    expect(stores.mode).toBe("memory");
    expect(stores.vectorStore.id).toBe("memory-vector-store");
    expect(stores.textStore.id).toBe("memory-chunk-text-store");
    // Not configured is a CHOICE (the single-container demo), so it is not reported as a
    // degradation. Configured-but-unreachable is, and that is the distinction below.
    expect(stores.degradation).toBeUndefined();
    expect(stores.sql).toBeNull();
  });

  it("treats an empty/whitespace URL as unset", async () => {
    expect((await createRetrievalStores({ space: SPACE, postgresUrl: "   " })).mode).toBe("memory");
  });

  it("with a URL but no usable driver: memory + a degradation string", async () => {
    // Reported, not swallowed: this is what lets the worker and the API log it at startup
    // instead of quietly serving an index one process can see and the other cannot.
    const stores = await createRetrievalStores({
      space: SPACE,
      postgresUrl: "postgres://user@host:5432/db",
      createClient: async () => null,
    });
    expect(stores.mode).toBe("memory");
    expect(stores.degradation).toMatch(/per-process|will not survive/i);
  });

  it("with a reachable-but-unusable database: memory + the underlying reason", async () => {
    // The realistic version of this is no `vector` extension available, or no CREATE rights.
    // Crashing the worker at boot would take the deterministic pipeline down with it, so this
    // degrades — but the reason travels with the degradation so it is actionable.
    const stores = await createRetrievalStores({
      space: SPACE,
      postgresUrl: "postgres://user@host:5432/db",
      createClient: async () => ({
        async query() {
          throw new Error("permission denied to create extension \"vector\"");
        },
        async end() {},
      }),
    });
    expect(stores.mode).toBe("memory");
    expect(stores.degradation).toMatch(/permission denied/);
  });

  it("with a working database: the pgvector + postgres pair, and the schema is ensured", async () => {
    const sql = fakeSql();
    const stores = await createRetrievalStores({
      space: SPACE,
      postgresUrl: "postgres://user@host:5432/db",
      createClient: async () => ({ query: sql.query, async end() {} }),
    });
    expect(stores.mode).toBe("postgres");
    expect(stores.degradation).toBeUndefined();
    expect(stores.vectorStore.id).toBe("pgvector:codeflow_vectors_3");
    expect(stores.textStore.id).toBe("postgres:codeflow_chunk_text");
    // ensureSchema defaults ON: a migration step that must be remembered gets forgotten.
    expect(sql.calls.some((call) => call.sql.includes("CREATE EXTENSION"))).toBe(true);
    expect(sql.calls.some((call) => call.sql.includes("codeflow_chunk_text"))).toBe(true);
  });

  it("ensureSchema:false skips the DDL entirely", async () => {
    const sql = fakeSql();
    await createRetrievalStores({
      space: SPACE,
      postgresUrl: "postgres://user@host:5432/db",
      ensureSchema: false,
      createClient: async () => ({ query: sql.query, async end() {} }),
    });
    expect(sql.calls).toEqual([]);
  });

  it("makes NO connection attempt of its own — the suite stays hermetic", async () => {
    // Guard on the guard: if the default `createClient` ever ran here, this test would take
    // seconds and touch the network. Asserting the seam is used keeps that from creeping back.
    let asked = 0;
    await createRetrievalStores({
      space: SPACE,
      postgresUrl: "postgres://user@host:5432/db",
      createClient: async () => {
        asked += 1;
        return null;
      },
    });
    expect(asked).toBe(1);
  });
});
