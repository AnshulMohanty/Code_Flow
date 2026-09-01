import { describe, expect, it } from "vitest";
import type { Synthesis } from "@codeflow/shared-types";
import type { RagEvalQuestion } from "../dataset.js";
import { aggregateRag, scoreQuestion, scoreSynthesis, type ScoredCoords } from "../score.js";

const synthesis: Synthesis = {
  summary: "x",
  readingOrder: [
    { fileId: "src/index.ts", order: 1, reason: "a" },
    { fileId: "src/auth.ts", order: 2, reason: "b" },
    { fileId: "src/db.ts", order: 3, reason: "c" },
  ],
};
const nodeIds = new Set(["src/index.ts", "src/auth.ts", "src/db.ts", "src/util.ts"]);
const keyFiles = ["src/index.ts", "src/auth.ts", "src/db.ts", "src/util.ts"];

describe("scoreSynthesis", () => {
  it("recall@k = fraction of expected entry points surfaced in top-k reading order ∪ keyFiles", () => {
    const full = scoreSynthesis(synthesis, keyFiles, nodeIds, ["src/index.ts", "src/auth.ts"], 5);
    expect(full.readingOrderRecallAtK).toBe(1);

    const half = scoreSynthesis(synthesis, keyFiles, nodeIds, ["src/index.ts", "src/missing.ts"], 5);
    expect(half.readingOrderRecallAtK).toBe(0.5);
  });

  it("citationResolutionRate reflects steps resolving to graph nodes; droppedCitations surfaced", () => {
    const withGhost: Synthesis = {
      summary: "x",
      readingOrder: [
        { fileId: "src/index.ts", order: 1, reason: "a" },
        { fileId: "ghost.ts", order: 2, reason: "ungrounded" }, // not a node
      ],
      droppedCitations: 1,
    };
    const scores = scoreSynthesis(withGhost, keyFiles, nodeIds, ["src/index.ts"], 5);
    expect(scores.citationResolutionRate).toBe(0.5); // 1 of 2 steps resolves
    expect(scores.droppedCitationsRate).toBeCloseTo(1 / 3); // 1 dropped of (2 kept + 1 dropped)
  });

  it("respects k when selecting the surfaced set", () => {
    // expected file only appears at reading-order position 3 / keyFiles index 2 → missed at k=1
    const scores = scoreSynthesis(synthesis, keyFiles, nodeIds, ["src/db.ts"], 1);
    expect(scores.readingOrderRecallAtK).toBe(0);
  });
});

// V3-P2: `scoreQuestion` takes the RANKING production actually returned, not an index plus a
// query vector — retrieval moved out of the scorer (see score.ts). The ordering below is
// therefore stated explicitly instead of being a consequence of cosine over fixture vectors,
// which also makes each expectation's "rank 1 vs rank 2" readable at the call site.
const AUTH: ScoredCoords = { id: "src/auth.ts#1-10", fileId: "src/auth.ts", startLine: 1, endLine: 10 };
const DB: ScoredCoords = { id: "src/db.ts#1-10", fileId: "src/db.ts", startLine: 1, endLine: 10 };
/** auth at rank 1, db at rank 2. */
const ranking: ScoredCoords[] = [AUTH, DB];

describe("scoreQuestion", () => {
  it("file-level hit at rank 1 → recall 1, reciprocalRank 1", () => {
    const q: RagEvalQuestion = { id: "q", question: "auth?", expectedFiles: ["src/auth.ts"] };
    const r = scoreQuestion(q, ranking, 5);
    expect(r.recallAtK).toBe(1);
    expect(r.reciprocalRank).toBe(1);
    expect(r.hit).toBe(true);
    expect(r.missed).toEqual([]);
  });

  it("hit at rank 2 → reciprocalRank 1/2", () => {
    const q: RagEvalQuestion = { id: "q", question: "db?", expectedFiles: ["src/db.ts"] };
    const r = scoreQuestion(q, ranking, 5); // auth ranks first, db second
    expect(r.retrieved[0].fileId).toBe("src/auth.ts");
    expect(r.reciprocalRank).toBe(0.5);
  });

  it("miss → recall 0, reciprocalRank 0, target listed in missed", () => {
    const q: RagEvalQuestion = { id: "q", question: "x?", expectedFiles: ["src/notindexed.ts"] };
    const r = scoreQuestion(q, ranking, 5);
    expect(r.recallAtK).toBe(0);
    expect(r.reciprocalRank).toBe(0);
    expect(r.missed).toEqual(["src/notindexed.ts"]);
  });

  it("expectedLines: overlap is a hit, disjoint range is a miss", () => {
    const hitQ: RagEvalQuestion = { id: "q", question: "auth?", expectedFiles: [], expectedLines: [{ fileId: "src/auth.ts", startLine: 3, endLine: 6 }] };
    expect(scoreQuestion(hitQ, ranking, 5).recallAtK).toBe(1); // [3,6] overlaps chunk [1,10]

    const missQ: RagEvalQuestion = { id: "q", question: "auth?", expectedFiles: [], expectedLines: [{ fileId: "src/auth.ts", startLine: 100, endLine: 110 }] };
    const r = scoreQuestion(missQ, ranking, 5);
    expect(r.recallAtK).toBe(0); // disjoint from the only auth chunk
    expect(r.missed).toEqual(["src/auth.ts#100-110"]);
  });
});

describe("aggregateRag", () => {
  it("means recall and reciprocal rank across questions", () => {
    const agg = aggregateRag(
      [
        { id: "a", question: "", retrieved: [], recallAtK: 1, reciprocalRank: 1, hit: true, missed: [], negativeControl: false },
        { id: "b", question: "", retrieved: [], recallAtK: 1, reciprocalRank: 0.5, hit: true, missed: [], negativeControl: false },
        { id: "c", question: "", retrieved: [], recallAtK: 0, reciprocalRank: 0, hit: false, missed: ["x"], negativeControl: false },
      ],
      5,
    );
    expect(agg.meanRecallAtK).toBeCloseTo(2 / 3);
    expect(agg.mrr).toBeCloseTo(0.5);
    expect(agg.questionCount).toBe(3);
  });
});
