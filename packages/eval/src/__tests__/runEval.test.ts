import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "@codeflow/shared-types";
import { runEval } from "../runEval.js";
import { EVAL_THRESHOLDS, type EvalThresholds } from "../thresholds.js";
import {
  DATASET,
  RETRIEVED_CHUNKS,
  fixtureResult,
  fixtureRetrieval,
  mockEmbeddingClient,
} from "./fixtures.js";
import type { RagAnswer } from "@codeflow/analyzers";
import type { EvalDataset } from "../dataset.js";
import type { AnswerRunner, RunEvalOptions } from "../runEval.js";
import type { Judge, JudgeLabel } from "../judge.js";

// V3-P2: the vectors live in stores now, so every scored run needs them. Built ONCE at module
// scope with top-level await, because a `beforeAll` fires after collection and the describe
// bodies below construct their arguments eagerly.
const RETRIEVAL = await fixtureRetrieval();

/** `runEval` with the fixture's stores injected. Every call in this file goes through here so
 *  a missing `retrieval` can never be the reason a test fails for an unrelated change. */
function evaluate(
  dataset: EvalDataset,
  result: AnalysisResult,
  client: Parameters<typeof runEval>[2],
  options: RunEvalOptions = {},
) {
  return runEval(dataset, result, client, { retrieval: RETRIEVAL, ...options });
}

describe("runEval — synthesis + RAG over a synthetic fixture", () => {
  it("scores synthesis recall, citation resolution, and per-question RAG hits/misses", async () => {
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());

    // Synthesis: both expected entry points are surfaced; all citations resolve; none dropped.
    expect(report.synthesisScores.readingOrderRecallAtK).toBe(1);
    expect(report.synthesisScores.citationResolutionRate).toBe(1);
    expect(report.synthesisScores.droppedCitationsRate).toBe(0);

    // RAG: q1 + q2 hit at rank 1; q3 (payments — not indexed) misses.
    expect(report.ragScores?.meanRecallAtK).toBeCloseTo(2 / 3);
    expect(report.ragScores?.mrr).toBeCloseTo(2 / 3);
    const byId = Object.fromEntries(report.perQuestion.map((q) => [q.id, q]));
    expect(byId.q1.hit).toBe(true);
    expect(byId.q1.reciprocalRank).toBe(1);
    expect(byId.q2.hit).toBe(true);
    expect(byId.q3.hit).toBe(false);
    expect(byId.q3.missed).toEqual(["src/payments.ts"]);

    // Embedded on the QUERY side.
    const client = mockEmbeddingClient();
    await evaluate(DATASET, fixtureResult(), client);
    expect(client.calls[0].inputType).toBe("query");
  });

  it("computes threshold pass/fail (pass on the fixture; fail when the bar is raised)", async () => {
    const pass = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(pass.thresholds.passed).toBe(true);
    expect(pass.thresholds.failures).toEqual([]);

    const strict: EvalThresholds = { ...EVAL_THRESHOLDS, ragRecallAtK: { k: 5, min: 0.9 } };
    const fail = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), { thresholds: strict });
    expect(fail.thresholds.passed).toBe(false);
    expect(fail.thresholds.failures.some((f) => f.includes("ragRecall"))).toBe(true);
  });

  it("produces a plain-serializable report (JSON round-trips)", async () => {
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("is deterministic — run twice ⇒ byte-identical report", async () => {
    const a = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());
    const b = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("grades synthesis-only when the dataset has no questions (ragScores null, no embed call)", async () => {
    const client = mockEmbeddingClient();
    const report = await evaluate({ ...DATASET, questions: [] }, fixtureResult(), client);
    expect(report.ragScores).toBeNull();
    expect(report.perQuestion).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });
});

describe("runEval — homogeneity guard (fail loud, never score across spaces)", () => {
  it("throws when the embedding client's dim ≠ the dataset's", async () => {
    await expect(evaluate(DATASET, fixtureResult(), mockEmbeddingClient({ dimension: 99 }))).rejects.toThrow(/does not match/);
  });

  it("throws when the embedding client's model ≠ the dataset's", async () => {
    await expect(evaluate(DATASET, fixtureResult(), mockEmbeddingClient({ model: "other-model" }))).rejects.toThrow(/does not match/);
  });

  it("throws when the stored index's space ≠ the dataset's", async () => {
    const result = fixtureResult({
      ai: { synthesis: fixtureResult().ai!.synthesis, rag: { chunks: [], chunkCount: 0, embeddingModel: "voyage-code-3", embeddingDim: 1024 } },
    });
    await expect(evaluate(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/Index .* does not match/);
  });
});

describe("runEval — requires the retrieval stores (V3-P2)", () => {
  it("throws an actionable error when no stores are supplied but the dataset has questions", async () => {
    // Scoring retrieval without the index is not "recall 0", it is not scoring at all — and a
    // silent 0 would read as a catastrophic quality regression rather than a wiring mistake.
    await expect(runEval(DATASET, fixtureResult(), mockEmbeddingClient())).rejects.toThrow(
      /no `retrieval` stores|hydrateEvalIndex/,
    );
  });

  it("still grades synthesis-only with no stores when the dataset has no questions", async () => {
    const report = await runEval({ ...DATASET, questions: [] }, fixtureResult(), mockEmbeddingClient());
    expect(report.ragScores).toBeNull();
  });
});

describe("runEval — requires the graded slices", () => {
  it("throws if synthesis is missing", async () => {
    const result = fixtureResult({ ai: { rag: fixtureResult().ai!.rag } });
    await expect(evaluate(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/synthesis is missing/);
  });

  it("throws if questions exist but the rag index is missing", async () => {
    const result = fixtureResult({ ai: { synthesis: fixtureResult().ai!.synthesis } });
    await expect(evaluate(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/rag is missing/);
  });
});

// ── V3-P0 §0.4: the ANSWER path + the calibrated judge ───────────────────────
// The pre-V3-P0 eval graded the INDEX only. These cover the half a user actually reads.

/** A deterministic fake answer runner: cites the top chunk for the question's target file. */
function answerRunner(overrides: Partial<RagAnswer> = {}): AnswerRunner {
  return async (question: string) => {
    const target = DATASET.questions.find((entry) => entry.question === question)?.expectedFiles[0];
    const chunk = RETRIEVED_CHUNKS.find((entry) => entry.fileId === target);
    const answer: RagAnswer = {
      answer: `GOOD: ${question}`,
      // Cite the real chunk when the target is indexed; otherwise refuse honestly.
      citations: chunk ? [{ fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine }] : [],
      retrievedChunkIds: chunk ? [chunk.id] : [],
      answered: Boolean(chunk),
      ...overrides,
    };
    return { answer, retrieved: RETRIEVED_CHUNKS };
  };
}

const fakeJudge: Judge = async (request) => ({
  faithfulness: request.answer.startsWith("GOOD") ? 0.95 : 0.2,
  unsupportedClaim: !request.answer.startsWith("GOOD"),
  rationale: "fixture",
});

describe("runEval — answer-path scoring", () => {
  it("stays retrieval-only when no answer runner is supplied (back-compat)", async () => {
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(report.answerScores).toBeNull();
    expect(report.perAnswer).toEqual([]);
    expect(report.judgeFaithfulness).toBeNull();
  });

  it("scores citation validity, relevance and refusals when a runner IS supplied", async () => {
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), { answer: answerRunner() });
    expect(report.answerScores?.questionCount).toBe(3);
    // q1/q2 cite a real retrieved chunk in the expected file; q3's target is not indexed.
    expect(report.answerScores?.meanCitationValidity).toBeCloseTo(1);
    expect(report.answerScores?.answerRate).toBeCloseTo(2 / 3);
    // q3 refusing is CORRECT — its expected file is not in the index at all.
    expect(report.answerScores?.justifiedRefusals).toBe(1);
    expect(report.answerScores?.unjustifiedRefusals).toBe(0);
    expect(report.summary).toContain("citationValidity");
  });

  it("fails the citation-validity gate when the answer cites code it never retrieved", async () => {
    const fabricating = answerRunner({ citations: [{ fileId: "src/ghost.ts", startLine: 1, endLine: 5 }] });
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), { answer: fabricating });
    expect(report.answerScores?.meanCitationValidity).toBeLessThan(1);
    expect(report.thresholds.passed).toBe(false);
    expect(report.thresholds.failures.join(" ")).toMatch(/citationValidity/);
  });

  it("counts a refusal on an ANSWERABLE question as unjustified and gates on it", async () => {
    const alwaysRefusing: AnswerRunner = async () => ({
      answer: { answer: "not found", citations: [], retrievedChunkIds: [], answered: false },
      retrieved: RETRIEVED_CHUNKS,
    });
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), {
      answer: alwaysRefusing,
      thresholds: { ...EVAL_THRESHOLDS, maxUnjustifiedRefusals: 0 },
    });
    // q1 and q2 were answerable; refusing them is a real miss, not honest behaviour.
    expect(report.answerScores?.unjustifiedRefusals).toBe(2);
    expect(report.answerScores?.justifiedRefusals).toBe(1);
    expect(report.thresholds.failures.join(" ")).toMatch(/unjustifiedRefusals/);
  });

  it("stays deterministic with the answer path enabled", async () => {
    const first = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), { answer: answerRunner() });
    const second = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), { answer: answerRunner() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("runEval — the judge is reported but only GATES once calibrated", () => {
  it("reports faithfulness and marks the judge ADVISORY without labels", async () => {
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), {
      answer: answerRunner(),
      judge: fakeJudge,
    });
    expect(report.judgeFaithfulness).toBeGreaterThan(0);
    expect(report.judgeConcordance).toBeNull();
    expect(report.judgeGate.gateable).toBe(false);
    expect(report.summary).toContain("advisory");
  });

  it("does NOT fail a threshold on an uncalibrated judge, however bad the score", async () => {
    // The whole point: an uncalibrated judge is a confident second opinion, not a measurement.
    const harshJudge: Judge = async () => ({ faithfulness: 0, unsupportedClaim: true, rationale: "no" });
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), {
      answer: answerRunner(),
      judge: harshJudge,
    });
    expect(report.judgeFaithfulness).toBe(0);
    expect(report.thresholds.failures.join(" ")).not.toMatch(/judgeFaithfulness/);
  });

  it("gates on faithfulness once the judge passes calibration", async () => {
    const labels: JudgeLabel[] = Array.from({ length: 40 }, (_, i) => ({
      id: `l${i}`,
      request: { question: "q", answer: i % 2 === 0 ? "GOOD x" : "bad x", chunks: [] },
      humanFaithful: i % 2 === 0,
    }));
    const harshJudge: Judge = async (request) => ({
      // Agrees with humans on the labels (so it calibrates), but scores the real answers low.
      faithfulness: request.chunks.length === 0 ? (request.answer.startsWith("GOOD") ? 0.95 : 0.1) : 0.1,
      unsupportedClaim: false,
      rationale: "fixture",
    });
    const report = await evaluate(DATASET, fixtureResult(), mockEmbeddingClient(), {
      answer: answerRunner(),
      judge: harshJudge,
      judgeLabels: labels,
    });
    expect(report.judgeConcordance?.sampleSize).toBe(40);
    expect(report.judgeGate.gateable).toBe(true);
    expect(report.summary).toContain("GATING");
    expect(report.thresholds.failures.join(" ")).toMatch(/judgeFaithfulness/);
  });
});

