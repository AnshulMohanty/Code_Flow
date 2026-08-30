import { describe, expect, it } from "vitest";
import type { RagChunk } from "@codeflow/shared-types";
import type { RagAnswer } from "@codeflow/analyzers";
import { aggregateAnswers, scoreAnswer } from "../answerScore.js";
import {
  calibrateJudge,
  cohensKappa,
  judgeIsGateable,
  parseJudgeVerdict,
  waldInterval,
  type Judge,
  type JudgeLabel,
} from "../judge.js";
import type { RagEvalQuestion } from "../dataset.js";

// V3-P0 §0.4 — the eval now scores the ANSWER, not just the index. Hermetic: fixture chunks
// and a deterministic fake judge; no provider, no key, no spend.

function chunk(fileId: string, startLine: number, endLine: number, text = "code"): RagChunk {
  return {
    id: `${fileId}#${startLine}-${endLine}`,
    fileId,
    startLine,
    endLine,
    text,
    embedding: [0, 0, 0],
    tokenCount: 1,
  };
}

function question(expectedFiles: string[]): RagEvalQuestion {
  return { id: "q1", question: "how does auth work?", expectedFiles };
}

function answer(overrides: Partial<RagAnswer> = {}): RagAnswer {
  return {
    answer: "Auth uses bearer tokens.",
    citations: [],
    retrievedChunkIds: [],
    answered: true,
    ...overrides,
  };
}

describe("scoreAnswer — citation validity is GROUNDING, checked by code", () => {
  const retrieved = [chunk("src/auth.ts", 1, 40), chunk("src/util.ts", 1, 20)];

  it("scores a citation inside a retrieved chunk as valid", () => {
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({ citations: [{ fileId: "src/auth.ts", startLine: 5, endLine: 12 }] }),
      retrieved,
    );
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationRelevance).toBe(1);
  });

  it("scores a citation OUTSIDE the retrieved chunk's line span as invalid", () => {
    // A real fileId with an invented line range is still a fabricated reference.
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({ citations: [{ fileId: "src/auth.ts", startLine: 900, endLine: 950 }] }),
      retrieved,
    );
    expect(scored.citationValidity).toBe(0);
  });

  it("scores a citation to a file that was never retrieved as invalid", () => {
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({ citations: [{ fileId: "src/ghost.ts", startLine: 1, endLine: 5 }] }),
      retrieved,
    );
    expect(scored.citationValidity).toBe(0);
  });

  it("separates 'cited real code' from 'cited the RIGHT code'", () => {
    // Both citations are valid (in retrieved chunks) but only one is the expected file —
    // the failure mode a validity-only metric cannot see.
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({
        citations: [
          { fileId: "src/auth.ts", startLine: 1, endLine: 10 },
          { fileId: "src/util.ts", startLine: 1, endLine: 10 },
        ],
      }),
      retrieved,
    );
    expect(scored.citationValidity).toBe(1);
    expect(scored.citationRelevance).toBe(0.5);
  });

  it("reads the production dropped-citation count rather than re-deriving it", () => {
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({ droppedCitations: { count: 3, ids: ["a", "b", "c"] } }),
      retrieved,
    );
    expect(scored.droppedCitations).toBe(3);
  });

  it("gives an ANSWER with no citations 0 validity, but a REFUSAL with none 1", () => {
    expect(scoreAnswer(question(["src/auth.ts"]), answer({ citations: [] }), retrieved).citationValidity).toBe(0);
    expect(
      scoreAnswer(question(["src/x.ts"]), answer({ answered: false, citations: [] }), retrieved).citationValidity,
    ).toBe(1);
  });
});

describe("scoreAnswer — refusals", () => {
  it("counts a refusal as JUSTIFIED when no expected file was retrievable", () => {
    // The honest "not in this repo" is the correct answer here, not a failure.
    const scored = scoreAnswer(
      question(["src/never-retrieved.ts"]),
      answer({ answered: false, answer: "Not found in this repository." }),
      [chunk("src/other.ts", 1, 10)],
    );
    expect(scored.refusalJustified).toBe(true);
    expect(scored.answered).toBe(0);
  });

  it("counts a refusal as UNJUSTIFIED when the expected file WAS right there", () => {
    const scored = scoreAnswer(
      question(["src/auth.ts"]),
      answer({ answered: false }),
      [chunk("src/auth.ts", 1, 40)],
    );
    expect(scored.refusalJustified).toBe(false);
  });

  it("treats a negative control (no expected files) as a justified refusal", () => {
    const scored = scoreAnswer(question([]), answer({ answered: false }), [chunk("src/a.ts", 1, 5)]);
    expect(scored.refusalJustified).toBe(true);
  });
});

describe("aggregateAnswers", () => {
  it("counts justified and unjustified refusals SEPARATELY, never averaged together", () => {
    const retrieved = [chunk("src/auth.ts", 1, 40)];
    const perAnswer = [
      scoreAnswer(question(["src/auth.ts"]), answer({ citations: [{ fileId: "src/auth.ts", startLine: 2, endLine: 3 }] }), retrieved),
      scoreAnswer(question(["src/auth.ts"]), answer({ answered: false }), retrieved), // unjustified
      scoreAnswer(question(["src/gone.ts"]), answer({ answered: false }), retrieved), // justified
    ];
    const agg = aggregateAnswers(perAnswer);
    expect(agg.questionCount).toBe(3);
    expect(agg.answerRate).toBeCloseTo(1 / 3);
    expect(agg.justifiedRefusals).toBe(1);
    expect(agg.unjustifiedRefusals).toBe(1);
  });

  it("returns zeroed scores for an empty set rather than NaN", () => {
    const agg = aggregateAnswers([]);
    expect(agg).toMatchObject({ questionCount: 0, answerRate: 0, meanCitationValidity: 0 });
    expect(Number.isNaN(agg.meanCitationRelevance)).toBe(false);
  });
});

// ── The judge ────────────────────────────────────────────────────────────────

/** A deterministic fake judge: faithful iff the answer text contains a sentinel. */
const fakeJudge: Judge = async (request) => ({
  faithfulness: request.answer.includes("GOOD") ? 0.95 : 0.1,
  unsupportedClaim: !request.answer.includes("GOOD"),
  rationale: "fixture",
});

function labels(count: number, agreeing: boolean): JudgeLabel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `l${i}`,
    request: { question: "q", answer: i % 2 === 0 ? "GOOD answer" : "bad answer", chunks: [] },
    // When agreeing, the human label matches the sentinel; otherwise it is inverted.
    humanFaithful: agreeing ? i % 2 === 0 : i % 2 !== 0,
  }));
}

describe("calibrateJudge", () => {
  it("measures agreement, kappa and a confusion matrix against human labels", async () => {
    const concordance = await calibrateJudge(fakeJudge, labels(20, true));
    expect(concordance.sampleSize).toBe(20);
    expect(concordance.agreement).toBe(1);
    expect(concordance.kappa).toBeCloseTo(1);
    expect(concordance.falsePositives).toBe(0);
  });

  it("catches a judge that disagrees with humans", async () => {
    const concordance = await calibrateJudge(fakeJudge, labels(20, false));
    expect(concordance.agreement).toBe(0);
    expect(concordance.kappa).toBeLessThan(0);
  });
});

describe("cohensKappa — why raw agreement is not enough", () => {
  it("scores a rubber-stamp judge at ~0 despite high raw agreement", () => {
    // 19 of 20 labels are "faithful"; a judge that always says faithful gets 95% agreement
    // while carrying zero information. Kappa is what exposes that.
    const kappa = cohensKappa({ truePositives: 19, falsePositives: 1, trueNegatives: 0, falseNegatives: 0 });
    expect(kappa).toBeCloseTo(0, 5);
  });

  it("scores a perfect judge at 1 and a degenerate matrix at 0", () => {
    expect(cohensKappa({ truePositives: 10, falsePositives: 0, trueNegatives: 10, falseNegatives: 0 })).toBeCloseTo(1);
    expect(cohensKappa({ truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 })).toBe(0);
  });
});

describe("judgeIsGateable — an uncalibrated judge NEVER gates", () => {
  it("refuses to gate when the judge was never calibrated", () => {
    const verdict = judgeIsGateable(null);
    expect(verdict.gateable).toBe(false);
    expect(verdict.reasons[0]).toMatch(/never calibrated/);
  });

  it("refuses to gate on too small a sample, and says so", async () => {
    const concordance = await calibrateJudge(fakeJudge, labels(4, true));
    const verdict = judgeIsGateable(concordance);
    expect(verdict.gateable).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/sample size 4/);
  });

  it("refuses to gate on low chance-corrected agreement", () => {
    const verdict = judgeIsGateable({
      sampleSize: 100,
      agreement: 0.95,
      kappa: 0.1, // a rubber stamp
      truePositives: 95,
      falsePositives: 5,
      trueNegatives: 0,
      falseNegatives: 0,
      threshold: 0.7,
      confidenceInterval: { low: 0.9, high: 1 },
    });
    expect(verdict.gateable).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/kappa/);
  });

  it("gates only when sample size, kappa AND the CI lower bound all clear the bar", async () => {
    const concordance = await calibrateJudge(fakeJudge, labels(60, true));
    expect(judgeIsGateable(concordance)).toEqual({ gateable: true, reasons: [] });
  });
});

describe("waldInterval", () => {
  it("is wide on a small sample and narrow on a large one — the point of reporting it", () => {
    const small = waldInterval(0.9, 5);
    const large = waldInterval(0.9, 500);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(small.low).toBeGreaterThanOrEqual(0);
    expect(small.high).toBeLessThanOrEqual(1);
  });

  it("returns the full range for a zero sample rather than a fake certainty", () => {
    expect(waldInterval(1, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("parseJudgeVerdict", () => {
  it("parses a verdict, fences and all", () => {
    const verdict = parseJudgeVerdict('```json\n{"faithfulness":0.8,"unsupportedClaim":false,"rationale":"ok"}\n```');
    expect(verdict).toEqual({ faithfulness: 0.8, unsupportedClaim: false, rationale: "ok" });
  });

  it("clamps an out-of-range score", () => {
    expect(parseJudgeVerdict('{"faithfulness": 7}').faithfulness).toBe(1);
    expect(parseJudgeVerdict('{"faithfulness": -3}').faithfulness).toBe(0);
  });

  it("THROWS on a malformed verdict rather than scoring it 0", () => {
    // Scoring bad judge JSON as 0 faithfulness would silently penalise a good answer for
    // the judge's mistake.
    expect(() => parseJudgeVerdict("not json")).toThrow();
    expect(() => parseJudgeVerdict('{"rationale":"forgot the number"}')).toThrow(/faithfulness/);
  });
});
