import { describe, expect, it } from "vitest";
import { createMemoryChunkTextStore } from "../stores/memoryChunkTextStore.js";
import { createMemoryVectorStore } from "../stores/memoryVectorStore.js";
import { retrievalNamespace } from "../namespace.js";
import type { VectorRecord } from "../contracts.js";

// The in-memory pair is the HERMETIC DEFAULT — the store the whole suite and the eval harness
// actually run against — so it is tested as production code, not as a stub. The properties
// below are the ones `hybridSearch`, the eval and the pgvector adapter all rely on.

const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };
const NS = "acme/repo@sha1/mock-embed/3";

function record(id: string, vector: number[], fileId = id.split("#")[0]): VectorRecord {
  return { id, vector, fileId, startLine: 1, endLine: 10 };
}

describe("createMemoryVectorStore — ranking", () => {
  it("returns cosine similarity as the score, best first", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("a.ts#1-10", [1, 0, 0]), record("b.ts#1-10", [0, 1, 0])]);

    const hits = await store.search(NS, { vector: [0.9, 0.1, 0], k: 2 });
    expect(hits.map((hit) => hit.id)).toEqual(["a.ts#1-10", "b.ts#1-10"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("breaks ties by id ascending, so two runs return the same list", async () => {
    // Determinism here is load-bearing: RRF fuses RANKS, so a wobbling tie-break would make
    // the fused order — and therefore the eval's recall@k — non-reproducible.
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("z.ts#1-10", [1, 0, 0]), record("a.ts#1-10", [1, 0, 0]), record("m.ts#1-10", [1, 0, 0])]);
    const first = await store.search(NS, { vector: [1, 0, 0], k: 2 });
    const second = await store.search(NS, { vector: [1, 0, 0], k: 2 });
    expect(first.map((hit) => hit.id)).toEqual(["a.ts#1-10", "m.ts#1-10"]);
    expect(second).toEqual(first);
  });

  it("carries the citation coordinates through, including symbolName when present", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [
      { id: "src/a.ts#2-4", vector: [1, 0, 0], fileId: "src/a.ts", startLine: 2, endLine: 4, symbolName: "foo" },
    ]);
    const [hit] = await store.search(NS, { vector: [1, 0, 0], k: 1 });
    expect(hit).toMatchObject({ fileId: "src/a.ts", startLine: 2, endLine: 4, symbolName: "foo" });
  });
});

describe("createMemoryVectorStore — namespaces and upsert semantics", () => {
  it("isolates namespaces: a search in one never sees the other", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert("repo@sha-a/mock-embed/3", [record("a.ts#1-10", [1, 0, 0])]);
    await store.upsert("repo@sha-b/mock-embed/3", [record("b.ts#1-10", [1, 0, 0])]);
    const hits = await store.search("repo@sha-a/mock-embed/3", { vector: [1, 0, 0], k: 10 });
    expect(hits.map((hit) => hit.id)).toEqual(["a.ts#1-10"]);
  });

  it("upsert OVERWRITES the same id rather than duplicating it", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("a.ts#1-10", [1, 0, 0])]);
    await store.upsert(NS, [record("a.ts#1-10", [0, 1, 0])]);
    expect(await store.count(NS)).toBe(1);
    const [hit] = await store.search(NS, { vector: [0, 1, 0], k: 1 });
    expect(hit.score).toBeCloseTo(1); // the SECOND vector won
  });

  it("drop removes the namespace, leaving others intact", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("a.ts#1-10", [1, 0, 0])]);
    await store.upsert("other/ns", [record("b.ts#1-10", [1, 0, 0])]);
    await store.drop(NS);
    expect(await store.count(NS)).toBe(0);
    expect(await store.count("other/ns")).toBe(1);
  });

  it("does not let a caller mutate stored vectors through the array it passed in", async () => {
    const store = createMemoryVectorStore(SPACE);
    const vector = [1, 0, 0];
    await store.upsert(NS, [record("a.ts#1-10", vector)]);
    vector[0] = 0; // the caller reuses its buffer — a store must not care
    const [hit] = await store.search(NS, { vector: [1, 0, 0], k: 1 });
    expect(hit.score).toBeCloseTo(1);
  });
});

describe("createMemoryVectorStore — filter", () => {
  it("restricts to the named fileIds", async () => {
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("a.ts#1-10", [1, 0, 0]), record("b.ts#1-10", [0.9, 0.1, 0])]);
    const hits = await store.search(NS, { vector: [1, 0, 0], k: 10, filter: { fileIds: ["b.ts"] } });
    expect(hits.map((hit) => hit.id)).toEqual(["b.ts#1-10"]);
  });

  it("an EMPTY fileIds filter means nothing is allowed, not 'no filter'", async () => {
    // Collapsing the two would silently widen a scoped search to the whole index — the sort
    // of bug that only shows up as an agent citing a file it was told not to look at.
    const store = createMemoryVectorStore(SPACE);
    await store.upsert(NS, [record("a.ts#1-10", [1, 0, 0])]);
    expect(await store.search(NS, { vector: [1, 0, 0], k: 10, filter: { fileIds: [] } })).toEqual([]);
  });
});

describe("createMemoryVectorStore — dimension guard", () => {
  it("refuses to STORE a vector of the wrong length", async () => {
    const store = createMemoryVectorStore(SPACE);
    await expect(store.upsert(NS, [record("a.ts#1-10", [1, 0])])).rejects.toThrow(/2 dimensions.*3-dimensional/s);
  });

  it("refuses to SEARCH with a vector of the wrong length", async () => {
    // Cosine would not throw — it truncates to the shorter length and returns a plausible
    // number — so nothing downstream would ever discover the mismatch.
    const store = createMemoryVectorStore(SPACE);
    await expect(store.search(NS, { vector: [1, 0, 0, 0], k: 1 })).rejects.toThrow(/4 dimensions/);
  });
});

describe("createMemoryChunkTextStore", () => {
  it("round-trips text by id, and omits ids it does not hold", async () => {
    const store = createMemoryChunkTextStore();
    await store.put(NS, [{ id: "a#1-2", text: "hello" }]);
    const got = await store.get(NS, ["a#1-2", "missing#1-1"]);
    expect(got.get("a#1-2")).toBe("hello");
    // Absent, NOT an empty string: an empty chunk would reach a prompt as contentless context
    // and let a model cite a file whose code it never saw.
    expect(got.has("missing#1-1")).toBe(false);
  });

  it("isolates namespaces and supports drop", async () => {
    const store = createMemoryChunkTextStore();
    await store.put("ns-a", [{ id: "x", text: "A" }]);
    await store.put("ns-b", [{ id: "x", text: "B" }]);
    expect((await store.get("ns-a", ["x"])).get("x")).toBe("A");
    await store.drop("ns-a");
    expect((await store.get("ns-a", ["x"])).size).toBe(0);
    expect((await store.get("ns-b", ["x"])).get("x")).toBe("B");
  });

  it("put overwrites the same id", async () => {
    const store = createMemoryChunkTextStore();
    await store.put(NS, [{ id: "x", text: "old" }]);
    await store.put(NS, [{ id: "x", text: "new" }]);
    expect((await store.get(NS, ["x"])).get("x")).toBe("new");
  });
});

describe("retrievalNamespace", () => {
  it("includes repo, sha AND the embedding space", async () => {
    const ns = retrievalNamespace({
      repoFullName: "Acme/Repo",
      commitSha: "ABCDEF",
      embeddingModel: "voyage-code-3",
      embeddingDim: 1024,
    });
    expect(ns).toBe("acme/repo@abcdef/voyage-code-3/1024");
  });

  it("separates two embedding spaces on the same repo+sha", async () => {
    const base = { repoFullName: "acme/repo", commitSha: "sha" };
    const a = retrievalNamespace({ ...base, embeddingModel: "voyage-code-3", embeddingDim: 1024 });
    const b = retrievalNamespace({ ...base, embeddingModel: "gemini-embedding-001", embeddingDim: 768 });
    expect(a).not.toBe(b);
  });

  it("is deterministic and safe as a plain key (no whitespace or odd characters)", async () => {
    const ns = retrievalNamespace({
      repoFullName: "some org/weird repo!",
      commitSha: "sha",
      embeddingModel: "model X",
      embeddingDim: 8,
    });
    expect(ns).toBe(
      retrievalNamespace({ repoFullName: "some org/weird repo!", commitSha: "sha", embeddingModel: "model X", embeddingDim: 8 }),
    );
    expect(ns).toMatch(/^[a-z0-9._@/-]+$/);
  });
});
