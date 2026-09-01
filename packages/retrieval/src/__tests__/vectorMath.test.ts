import { describe, expect, it } from "vitest";
import { cosineSimilarity, retrieve } from "../vectorMath.js";

// The ONE retrieval primitive. This test moved here from `@codeflow/analyzers` in V3-P2 along
// with the code: cosine + top-k are retrieval concerns, and the stores and MMR both build on
// them. `retrieve` is now generic over `{ id, embedding }` rather than fixed to `RagChunk`,
// because a persisted `RagChunk` no longer carries a vector.

interface Item {
  id: string;
  embedding: number[];
}

function item(id: string, embedding: number[]): Item {
  return { id, embedding };
}

describe("cosineSimilarity", () => {
  it("is 1 for parallel, 0 for orthogonal, 0 for a zero vector (no NaN)", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("is negative for opposed vectors (the sign is information, not an error)", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
});

describe("retrieve — cosine top-k (the one shared primitive)", () => {
  const items = [item("a.ts#1-1", [1, 0, 0]), item("b.ts#1-1", [0, 1, 0]), item("c.ts#1-1", [0, 0, 1])];

  it("returns the nearest item first", () => {
    expect(retrieve(items, [0.9, 0.1, 0], 1).map((c) => c.id)).toEqual(["a.ts#1-1"]);
  });

  it("orders by descending similarity", () => {
    expect(retrieve(items, [0.6, 0.5, 0], 3).map((c) => c.id)).toEqual(["a.ts#1-1", "b.ts#1-1", "c.ts#1-1"]);
  });

  it("breaks ties deterministically by id (ascending)", () => {
    const tied = [item("z.ts#1-1", [1, 0, 0]), item("a.ts#1-1", [1, 0, 0]), item("m.ts#1-1", [1, 0, 0])];
    expect(retrieve(tied, [1, 0, 0], 2).map((c) => c.id)).toEqual(["a.ts#1-1", "m.ts#1-1"]);
  });

  it("is safe when k > itemCount (returns all) and when k <= 0 (returns none)", () => {
    expect(retrieve(items, [1, 0, 0], 99)).toHaveLength(3);
    expect(retrieve(items, [1, 0, 0], 0)).toEqual([]);
    expect(retrieve([], [1, 0, 0], 5)).toEqual([]);
  });
});
