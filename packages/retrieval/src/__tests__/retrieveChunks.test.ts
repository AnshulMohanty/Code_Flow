import { describe, expect, it } from "vitest";
import type { Rag, RagChunk } from "@codeflow/shared-types";
import { assertIndexHasStore, vectorRetrieve } from "../retrieveChunks.js";
import { createMemoryChunkTextStore } from "../stores/memoryChunkTextStore.js";
import { createMemoryVectorStore } from "../stores/memoryVectorStore.js";

// `vectorRetrieve` is the join that replaced the brute-force cosine scan over
// `rag.chunks[].embedding`. Its interesting behaviour is entirely in what it REFUSES to paper
// over — three ways a store and an analysis document can disagree, each of which would
// otherwise surface as a confidently wrong answer rather than an error.

const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };
const NS = "acme/repo@sha1/mock-embed/3";

const META: RagChunk[] = [
  { id: "src/auth.ts#1-10", fileId: "src/auth.ts", startLine: 1, endLine: 10, tokenCount: 5, symbolName: "AuthService" },
  { id: "src/db.ts#1-8", fileId: "src/db.ts", startLine: 1, endLine: 8, tokenCount: 5 },
];
const VECTORS: Record<string, number[]> = { "src/auth.ts#1-10": [1, 0, 0], "src/db.ts#1-8": [0, 1, 0] };
const TEXTS: Record<string, string> = { "src/auth.ts#1-10": "class AuthService {}", "src/db.ts#1-8": "function connectDb() {}" };

function ragIndex(overrides: Partial<Rag> = {}): Rag {
  return {
    ...SPACE,
    chunks: META,
    chunkCount: META.length,
    store: { namespace: NS, vectorStoreId: "memory-vector-store", textStoreId: "memory-chunk-text-store" },
    ...overrides,
  };
}

async function stores(options: { ids?: string[]; withText?: boolean } = {}) {
  const ids = options.ids ?? META.map((chunk) => chunk.id);
  const vectorStore = createMemoryVectorStore(SPACE);
  const textStore = createMemoryChunkTextStore();
  await vectorStore.upsert(
    NS,
    ids.map((id) => {
      const meta = META.find((chunk) => chunk.id === id);
      return {
        id,
        vector: VECTORS[id] ?? [0, 0, 1],
        fileId: meta?.fileId ?? id.split("#")[0],
        startLine: meta?.startLine ?? 1,
        endLine: meta?.endLine ?? 1,
      };
    }),
  );
  if (options.withText !== false) {
    await textStore.put(
      NS,
      ids.filter((id) => TEXTS[id] !== undefined).map((id) => ({ id, text: TEXTS[id] })),
    );
  }
  return { vectorStore, textStore };
}

describe("vectorRetrieve — the happy path", () => {
  it("returns the ranked chunks with metadata, text and the vector score", async () => {
    const deps = { ragIndex: ragIndex(), ...(await stores()) };
    const found = await vectorRetrieve(deps, { queryVector: [0.9, 0.1, 0], k: 2 });

    expect(found.chunks.map((chunk) => chunk.id)).toEqual(["src/auth.ts#1-10", "src/db.ts#1-8"]);
    expect(found.chunks[0].text).toBe("class AuthService {}");
    expect(found.chunks[0].symbolName).toBe("AuthService"); // metadata survived the join
    expect(found.chunks[0].vectorScore).toBeGreaterThan(0.9);
    expect(found.chunks[0].sources).toEqual(["vector"]);
    // Vector-only retrieval: the fused score IS the vector score, so the shape matches the
    // hybrid path's output rather than leaving a field conspicuously absent.
    expect(found.chunks[0].fusedScore).toBe(found.chunks[0].vectorScore);
  });

  it("reports topScore as a real cosine — the number the similarity floor compares against", async () => {
    const deps = { ragIndex: ragIndex(), ...(await stores()) };
    const found = await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 1 });
    expect(found.topScore).toBeCloseTo(1);
  });

  it("returns nothing for an empty namespace or k <= 0", async () => {
    const deps = { ragIndex: ragIndex(), ...(await stores({ ids: [] })) };
    expect((await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 5 })).chunks).toEqual([]);
    expect((await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 5 })).topScore).toBe(0);
    expect((await vectorRetrieve({ ragIndex: ragIndex(), ...(await stores()) }, { queryVector: [1, 0, 0], k: 0 })).chunks).toEqual([]);
  });

  it("passes a fileIds filter through to the store", async () => {
    const deps = { ragIndex: ragIndex(), ...(await stores()) };
    const found = await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 5, filter: { fileIds: ["src/db.ts"] } });
    expect(found.chunks.map((chunk) => chunk.fileId)).toEqual(["src/db.ts"]);
  });
});

describe("vectorRetrieve — what it refuses to paper over", () => {
  it("a pre-V3-P2 index (no `store`) throws with a rebuild instruction", async () => {
    // Not "empty": UNREADABLE. Returning zero chunks would look like an honest refusal.
    const deps = { ragIndex: ragIndex({ store: undefined }), ...(await stores()) };
    await expect(vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 2 })).rejects.toThrow(/pre-V3-P2|Re-analyse/i);
  });

  it("drops (and reports) a store hit whose id the index metadata does not know", async () => {
    // A stale row from an older chunk plan. The METADATA is the grounding authority: trusting
    // the store's own coordinates instead would let it cite a range the current plan never
    // produced.
    const deps = { ragIndex: ragIndex(), ...(await stores({ ids: [...META.map((c) => c.id), "src/ghost.ts#1-1"] })) };
    const found = await vectorRetrieve(deps, { queryVector: [0, 0, 1], k: 5 });
    expect(found.chunks.map((chunk) => chunk.id)).not.toContain("src/ghost.ts#1-1");
    expect(found.droppedUnknownIds).toEqual(["src/ghost.ts#1-1"]);
  });

  it("drops (and reports) a hit with no text in the text store", async () => {
    // An empty string would enter the prompt as a chunk with no content, and the model would
    // cite a file whose code it never read.
    const deps = { ragIndex: ragIndex(), ...(await stores({ withText: false })) };
    const found = await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 2 });
    expect(found.chunks).toEqual([]);
    expect(found.droppedMissingText).toEqual(["src/auth.ts#1-10", "src/db.ts#1-8"]);
  });

  it("still reports topScore from the store's ranking even when every hit was dropped", async () => {
    // The best available match is a property of the INDEX, not of whether text resolved — so
    // the refusal floor is not accidentally tripped by a text-store problem.
    const deps = { ragIndex: ragIndex(), ...(await stores({ withText: false })) };
    const found = await vectorRetrieve(deps, { queryVector: [1, 0, 0], k: 2 });
    expect(found.topScore).toBeCloseTo(1);
  });
});

describe("assertIndexHasStore", () => {
  it("returns the store reference when present", () => {
    expect(assertIndexHasStore(ragIndex()).namespace).toBe(NS);
  });

  it("throws otherwise", () => {
    expect(() => assertIndexHasStore(ragIndex({ store: undefined }))).toThrow(/Re-analyse/);
  });
});
