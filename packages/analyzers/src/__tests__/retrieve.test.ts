import { describe, expect, it } from "vitest";
import type { RagChunk } from "@codeflow/shared-types";
import { cosineSimilarity, retrieve } from "../rag/retrieve.js";

function chunk(id: string, embedding: number[]): RagChunk {
  return { id, fileId: id.split("#")[0], startLine: 1, endLine: 1, text: id, embedding, tokenCount: 1 };
}

describe("cosineSimilarity", () => {
  it("is 1 for parallel, 0 for orthogonal, 0 for a zero vector (no NaN)", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("retrieve — cosine top-k (the one shared primitive)", () => {
  const chunks = [chunk("a.ts#1-1", [1, 0, 0]), chunk("b.ts#1-1", [0, 1, 0]), chunk("c.ts#1-1", [0, 0, 1])];

  it("returns the nearest chunk first", () => {
    expect(retrieve(chunks, [0.9, 0.1, 0], 1).map((c) => c.id)).toEqual(["a.ts#1-1"]);
  });

  it("orders by descending similarity", () => {
    expect(retrieve(chunks, [0.6, 0.5, 0], 3).map((c) => c.id)).toEqual(["a.ts#1-1", "b.ts#1-1", "c.ts#1-1"]);
  });

  it("breaks ties deterministically by chunk id (ascending)", () => {
    const tied = [chunk("z.ts#1-1", [1, 0, 0]), chunk("a.ts#1-1", [1, 0, 0]), chunk("m.ts#1-1", [1, 0, 0])];
    expect(retrieve(tied, [1, 0, 0], 2).map((c) => c.id)).toEqual(["a.ts#1-1", "m.ts#1-1"]);
  });

  it("is safe when k > chunkCount (returns all) and when k <= 0 (returns none)", () => {
    expect(retrieve(chunks, [1, 0, 0], 99)).toHaveLength(3);
    expect(retrieve(chunks, [1, 0, 0], 0)).toEqual([]);
    expect(retrieve([], [1, 0, 0], 5)).toEqual([]);
  });
});
