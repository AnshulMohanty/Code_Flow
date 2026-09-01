import { describe, expect, it } from "vitest";
import type { Rag, RagChunk } from "@codeflow/shared-types";
import { hybridSearch } from "../hybridSearch.js";
import { createCrossEncoderReranker, createIdentityReranker, createLexicalOverlapReranker } from "../reranker.js";
import { createMemoryChunkTextStore } from "../stores/memoryChunkTextStore.js";
import { createMemoryVectorStore } from "../stores/memoryVectorStore.js";
import type { ChunkTextStore, CrossEncoderSession, Reranker, VectorStore } from "../index.js";

// The assembled query pipeline. The properties tested here are the ones that would each cause a
// distinct, serious product failure if they broke: a refusal that stops firing (answering
// confidently on an unanswerable question), a lexical arm that cannot surface what the vector
// arm missed (hybrid retrieval that is not hybrid), a reranker failure that silently degrades,
// and MMR that returns five chunks of one file.

const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };
const NS = "acme/repo@sha1/mock-embed/3";

/**
 * A tiny hand-built world. Vectors are authored so retrieval is known by construction:
 * auth = [1,0,0], db = [0,1,0], util = [0,0,1].
 */
interface Doc {
  id: string;
  fileId: string;
  startLine: number;
  endLine: number;
  vector: number[];
  text: string;
}

const DOCS: Doc[] = [
  // Three chunks of ONE file, all near the auth axis — the redundancy MMR must break up.
  { id: "src/auth.ts#1-10", fileId: "src/auth.ts", startLine: 1, endLine: 10, vector: [1, 0, 0], text: "export class AuthService { login() {} }" },
  { id: "src/auth.ts#11-20", fileId: "src/auth.ts", startLine: 11, endLine: 20, vector: [0.99, 0.01, 0], text: "  logout() { this.session.clear(); }" },
  { id: "src/auth.ts#21-30", fileId: "src/auth.ts", startLine: 21, endLine: 30, vector: [0.98, 0.02, 0], text: "  whoami() { return this.session.user; }" },
  { id: "src/db.ts#1-10", fileId: "src/db.ts", startLine: 1, endLine: 10, vector: [0, 1, 0], text: "export function connectDb() { return pool(); }" },
  // Far from every query axis, but the ONLY chunk containing this identifier — the lexical
  // arm's reason to exist.
  { id: "src/util/hash.ts#1-6", fileId: "src/util/hash.ts", startLine: 1, endLine: 6, vector: [0, 0, 1], text: "export function parseJwtHeader(raw) { return decode(raw); }" },
];

function metadata(): RagChunk[] {
  return DOCS.map((doc) => ({
    id: doc.id,
    fileId: doc.fileId,
    startLine: doc.startLine,
    endLine: doc.endLine,
    tokenCount: 10,
  }));
}

async function world(options: { docs?: Doc[]; withText?: boolean } = {}): Promise<{
  ragIndex: Rag;
  vectorStore: VectorStore;
  textStore: ChunkTextStore;
}> {
  const docs = options.docs ?? DOCS;
  const vectorStore = createMemoryVectorStore(SPACE);
  const textStore = createMemoryChunkTextStore();
  await vectorStore.upsert(
    NS,
    docs.map((doc) => ({
      id: doc.id,
      vector: doc.vector,
      fileId: doc.fileId,
      startLine: doc.startLine,
      endLine: doc.endLine,
    })),
  );
  if (options.withText !== false) {
    await textStore.put(NS, docs.map((doc) => ({ id: doc.id, text: doc.text })));
  }
  const ragIndex: Rag = {
    ...SPACE,
    chunks: metadata(),
    chunkCount: DOCS.length,
    store: { namespace: NS, vectorStoreId: vectorStore.id, textStoreId: textStore.id },
  };
  return { ragIndex, vectorStore, textStore };
}

const FLOOR = 0.2;

describe("hybridSearch — the refusal floor is unchanged", () => {
  it("refuses when the best VECTOR cosine is below the floor, and does no further work", async () => {
    const deps = { ...(await world()), reranker: createLexicalOverlapReranker() };
    // Orthogonal to every document ⇒ every cosine is 0.
    const found = await hybridSearch(deps, { text: "quantum tunnelling in beehives", vector: [0, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.chunks).toEqual([]);
    expect(found.trace.refused).toBe(true);
    expect(found.trace.topVectorScore).toBe(0);
    // The lexical arm never ran: a refusal costs exactly one vector search.
    expect(found.trace.lexicalHits).toBe(0);
    expect(found.trace.rerankedCandidates).toBe(0);
  });

  it("refuses on an empty index", async () => {
    const deps = await world({ docs: [] });
    const found = await hybridSearch(deps, { text: "anything", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.trace.refused).toBe(true);
    expect(found.chunks).toEqual([]);
  });

  it("compares the floor against a COSINE, never against the fused or reranked score", async () => {
    // The load-bearing invariant. RRF scores live around 1/61 ~ 0.016 — far below a 0.2 floor —
    // so if the gate ever read the fused score it would refuse EVERYTHING, and if it read a
    // reranker score it would be comparing a model-specific scale to a cosine threshold.
    const deps = { ...(await world()), reranker: createLexicalOverlapReranker() };
    const found = await hybridSearch(deps, { text: "auth service login", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.trace.refused).toBe(false);
    expect(found.trace.topVectorScore).toBeCloseTo(1);
    // Every fused score is well under the floor — proof the gate is not reading them.
    for (const chunk of found.chunks) expect(chunk.fusedScore).toBeLessThan(FLOOR);
  });

  it("a floor of 0 admits anything with a hit; a floor above 1 refuses everything", async () => {
    const deps = await world();
    expect((await hybridSearch(deps, { text: "x", vector: [0, 0, 1], k: 1, minSimilarity: 0 })).trace.refused).toBe(false);
    expect((await hybridSearch(deps, { text: "x", vector: [1, 0, 0], k: 1, minSimilarity: 1.1 })).trace.refused).toBe(true);
  });

  it("returns nothing for k <= 0 without querying", async () => {
    const deps = await world();
    const found = await hybridSearch(deps, { text: "x", vector: [1, 0, 0], k: 0, minSimilarity: FLOOR });
    expect(found.chunks).toEqual([]);
    expect(found.trace.vectorHits).toBe(0);
  });
});

describe("hybridSearch — the lexical arm earns its place", () => {
  it("returns a chunk the vector arm did NOT return at all", async () => {
    // The cleanest form of the argument. `parseJwtHeader` lives in a chunk whose vector is
    // ORTHOGONAL to the query, so with the vector arm narrowed to 2 candidates it is nowhere in
    // arm 1's output — and hybrid retrieval still returns it, because the lexical arm indexes
    // the NAMESPACE rather than re-ranking arm 1.
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, {
      text: "parseJwtHeader",
      vector: [1, 0, 0], // points at auth, not at the hash file
      // k must be <= armCandidates: an arm narrower than k cannot fill k, so `hybridSearch`
      // floors armCandidates at k. Narrowing BOTH is what makes the vector arm genuinely miss.
      k: 2,
      minSimilarity: FLOOR,
      armCandidates: 2,
    });
    expect(found.trace.vectorHits).toBe(2);
    expect(found.trace.lexicalOnly).toContain("src/util/hash.ts#1-6");
    const hit = found.chunks.find((chunk) => chunk.id === "src/util/hash.ts#1-6");
    expect(hit).toBeDefined();
    expect(hit?.sources).toEqual(["lexical"]);
    expect(hit?.vectorScore).toBeUndefined(); // arm 1 never saw it
    expect(hit?.lexicalScore).toBeGreaterThan(0);
  });

  it("promotes a chunk from LAST in the vector arm to first after fusion", async () => {
    // The same win in the other regime: when the arms both return everything (a small corpus
    // with a wide oversample), the lexical arm's contribution is visible as RANK rather than as
    // presence. `hash.ts` has the worst cosine of all five candidates and still comes out first.
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, { text: "parseJwtHeader", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR, mmrLambda: 1 });
    const scores = found.chunks.map((chunk) => chunk.vectorScore ?? 0);
    const hit = found.chunks[0];
    expect(hit.id).toBe("src/util/hash.ts#1-6");
    expect(hit.vectorScore).toBe(Math.min(...scores)); // the WORST vector match, ranked first
    expect(hit.sources.sort()).toEqual(["lexical", "vector"]);
  });

  it("records which arm found what — the diagnosis for a retrieval miss", async () => {
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, { text: "parseJwtHeader", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR });
    expect(found.trace.vectorHits).toBeGreaterThan(0);
    expect(found.trace.lexicalHits).toBeGreaterThan(0);
    expect(found.trace.lexicalOnly.length + found.trace.vectorOnly.length).toBeGreaterThan(0);
  });

  it("marks a chunk both arms found with BOTH sources", async () => {
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, { text: "AuthService login", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR });
    const both = found.chunks.find((chunk) => chunk.sources.length === 2);
    expect(both?.sources.sort()).toEqual(["lexical", "vector"]);
    expect(both?.vectorScore).toBeDefined();
    expect(both?.lexicalScore).toBeDefined();
  });

  it("honours a fileIds filter in BOTH arms", async () => {
    // A filter that only constrained the vector arm would let the lexical arm return a file the
    // caller explicitly scoped out — which for Phase 3's graph tools is a grounding violation.
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, {
      text: "parseJwtHeader connectDb",
      vector: [1, 0, 0],
      k: 5,
      minSimilarity: FLOOR,
      filter: { fileIds: ["src/auth.ts"] },
    });
    for (const chunk of found.chunks) expect(chunk.fileId).toBe("src/auth.ts");
  });
});

describe("hybridSearch — MMR diversity", () => {
  it("does not return three chunks of one file when another file is relevant", async () => {
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, {
      text: "session",
      vector: [0.9, 0.3, 0],
      k: 3,
      minSimilarity: FLOOR,
      mmrLambda: 0.4, // diversity-leaning, to make the effect unambiguous
    });
    const files = new Set(found.chunks.map((chunk) => chunk.fileId));
    expect(files.size).toBeGreaterThan(1);
  });

  it("lambda = 1 keeps the pure relevance order (MMR off)", async () => {
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR, mmrLambda: 1 });
    // All three auth chunks, since they are the three most relevant.
    expect(found.chunks.every((chunk) => chunk.fileId === "src/auth.ts")).toBe(true);
    expect(found.trace.mmrLambda).toBe(1);
  });

  it("never returns more than k", async () => {
    const deps = { ...(await world()), reranker: createIdentityReranker() };
    for (const k of [1, 2, 3, 99]) {
      const found = await hybridSearch(deps, { text: "auth db hash", vector: [1, 0, 0], k, minSimilarity: FLOOR });
      expect(found.chunks.length).toBeLessThanOrEqual(k);
    }
  });
});

describe("hybridSearch — the reranker", () => {
  it("applies the reranker's order and records its score", async () => {
    const deps = { ...(await world()), reranker: createLexicalOverlapReranker() };
    const found = await hybridSearch(deps, { text: "parseJwtHeader raw decode", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR, mmrLambda: 1 });
    expect(found.trace.rerankerId).toBe("lexical-overlap");
    expect(found.chunks[0].id).toBe("src/util/hash.ts#1-6"); // the literal identifier match wins
    expect(found.chunks[0].rerankScore).toBeGreaterThan(0);
  });

  it("DEGRADES to the fused order when the reranker throws, and says so in the trace", async () => {
    // Silently returning the fused order would make "the reranker is broken" indistinguishable
    // from "the reranker had no opinion". The reranker itself rejects; this is where the
    // fallback decision lives, and it is recorded.
    const failing: Reranker = {
      id: "explodes",
      kind: "cross-encoder",
      async rerank() {
        throw new Error("model session closed");
      },
    };
    const deps = { ...(await world()), reranker: failing };
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.chunks.length).toBeGreaterThan(0); // still answered
    expect(found.trace.rerankerError).toMatch(/model session closed/);
    expect(found.trace.rerankerId).toBe("explodes");
    for (const chunk of found.chunks) expect(chunk.rerankScore).toBeUndefined();
  });

  it("keeps a candidate the reranker omitted, ranked last rather than dropped", async () => {
    // Losing a real result to a reranker's omission is worse than ranking it last.
    const partial: Reranker = {
      id: "partial",
      kind: "deterministic",
      async rerank(_query, candidates) {
        return candidates.slice(0, 1).map((candidate) => ({ id: candidate.id, score: 1 }));
      },
    };
    const deps = { ...(await world()), reranker: partial };
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR, mmrLambda: 1 });
    expect(found.chunks.length).toBe(found.trace.rerankedCandidates);
  });

  it("works with no reranker at all (fused order straight into MMR)", async () => {
    const deps = await world();
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.trace.rerankerId).toBeNull();
    expect(found.chunks.length).toBeGreaterThan(0);
    for (const chunk of found.chunks) expect(chunk.rerankScore).toBeUndefined();
  });

  it("drives an injected cross-encoder session (the integration-ready path)", async () => {
    const session: CrossEncoderSession = {
      model: "fake-xenc",
      async score(pairs) {
        // Prefer whatever mentions the database, regardless of the vector order.
        return pairs.map((pair) => (pair.document.includes("connectDb") ? 10 : 0));
      },
    };
    const deps = { ...(await world()), reranker: createCrossEncoderReranker({ session }) };
    const found = await hybridSearch(deps, { text: "how do I connect", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR, mmrLambda: 1 });
    expect(found.trace.rerankerId).toBe("cross-encoder:fake-xenc");
    expect(found.chunks[0].id).toBe("src/db.ts#1-10");
  });
});

describe("hybridSearch — what it refuses to paper over", () => {
  it("throws on a pre-V3-P2 index with no store reference", async () => {
    const deps = await world();
    await expect(
      hybridSearch({ ...deps, ragIndex: { ...deps.ragIndex, store: undefined } }, { text: "x", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR }),
    ).rejects.toThrow(/pre-V3-P2|Re-analyse/i);
  });

  it("drops and reports a store hit the index metadata does not know", async () => {
    const deps = await world();
    await deps.vectorStore.upsert(NS, [{ id: "src/ghost.ts#1-1", vector: [1, 0, 0], fileId: "src/ghost.ts", startLine: 1, endLine: 1 }]);
    await deps.textStore.put(NS, [{ id: "src/ghost.ts#1-1", text: "ghost" }]);
    const found = await hybridSearch({ ...deps, reranker: createIdentityReranker() }, { text: "auth", vector: [1, 0, 0], k: 5, minSimilarity: FLOOR });
    expect(found.chunks.map((chunk) => chunk.id)).not.toContain("src/ghost.ts#1-1");
    expect(found.trace.droppedUnknownIds).toContain("src/ghost.ts#1-1");
  });

  it("drops and reports a hit with no text rather than passing an empty chunk to a prompt", async () => {
    const deps = await world({ withText: false });
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 3, minSimilarity: FLOOR });
    expect(found.chunks).toEqual([]);
    expect(found.trace.droppedMissingText.length).toBeGreaterThan(0);
    // NOT a refusal: the index had a good match, the text store did not have its text. Two
    // different problems, and conflating them would hide a broken store behind "no answer".
    expect(found.trace.refused).toBe(false);
  });
});

describe("hybridSearch — determinism and bounds", () => {
  it("two identical searches return byte-identical results", async () => {
    const deps = { ...(await world()), reranker: createLexicalOverlapReranker() };
    const query = { text: "auth session token", vector: [0.8, 0.2, 0], k: 3, minSimilarity: FLOOR };
    const a = await hybridSearch(deps, query);
    const b = await hybridSearch(deps, query);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("oversamples each arm beyond k, bounded by the candidate cap", async () => {
    const deps = await world();
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 2, minSimilarity: FLOOR });
    expect(found.trace.armCandidates).toBeGreaterThan(2); // wider than k, so an arm can contribute
    expect(found.trace.armCandidates).toBeLessThanOrEqual(40); // RETRIEVAL_MAX_CANDIDATES
  });

  it("never lets armCandidates fall below k, however small the override", async () => {
    const deps = await world();
    const found = await hybridSearch(deps, { text: "auth", vector: [1, 0, 0], k: 4, minSimilarity: FLOOR, armCandidates: 1 });
    expect(found.trace.armCandidates).toBeGreaterThanOrEqual(4);
  });
});
