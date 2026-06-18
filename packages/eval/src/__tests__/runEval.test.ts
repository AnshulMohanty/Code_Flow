import { describe, expect, it } from "vitest";
import { runEval } from "../runEval.js";
import { EVAL_THRESHOLDS, type EvalThresholds } from "../thresholds.js";
import { DATASET, fixtureResult, mockEmbeddingClient } from "./fixtures.js";

describe("runEval — synthesis + RAG over a synthetic fixture", () => {
  it("scores synthesis recall, citation resolution, and per-question RAG hits/misses", async () => {
    const report = await runEval(DATASET, fixtureResult(), mockEmbeddingClient());

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
    await runEval(DATASET, fixtureResult(), client);
    expect(client.calls[0].inputType).toBe("query");
  });

  it("computes threshold pass/fail (pass on the fixture; fail when the bar is raised)", async () => {
    const pass = await runEval(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(pass.thresholds.passed).toBe(true);
    expect(pass.thresholds.failures).toEqual([]);

    const strict: EvalThresholds = { ...EVAL_THRESHOLDS, ragRecallAtK: { k: 5, min: 0.9 } };
    const fail = await runEval(DATASET, fixtureResult(), mockEmbeddingClient(), { thresholds: strict });
    expect(fail.thresholds.passed).toBe(false);
    expect(fail.thresholds.failures.some((f) => f.includes("ragRecall"))).toBe(true);
  });

  it("produces a plain-serializable report (JSON round-trips)", async () => {
    const report = await runEval(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("is deterministic — run twice ⇒ byte-identical report", async () => {
    const a = await runEval(DATASET, fixtureResult(), mockEmbeddingClient());
    const b = await runEval(DATASET, fixtureResult(), mockEmbeddingClient());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("grades synthesis-only when the dataset has no questions (ragScores null, no embed call)", async () => {
    const client = mockEmbeddingClient();
    const report = await runEval({ ...DATASET, questions: [] }, fixtureResult(), client);
    expect(report.ragScores).toBeNull();
    expect(report.perQuestion).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });
});

describe("runEval — homogeneity guard (fail loud, never score across spaces)", () => {
  it("throws when the embedding client's dim ≠ the dataset's", async () => {
    await expect(runEval(DATASET, fixtureResult(), mockEmbeddingClient({ dimension: 99 }))).rejects.toThrow(/does not match/);
  });

  it("throws when the embedding client's model ≠ the dataset's", async () => {
    await expect(runEval(DATASET, fixtureResult(), mockEmbeddingClient({ model: "other-model" }))).rejects.toThrow(/does not match/);
  });

  it("throws when the stored index's space ≠ the dataset's", async () => {
    const result = fixtureResult({
      ai: { synthesis: fixtureResult().ai!.synthesis, rag: { chunks: [], chunkCount: 0, embeddingModel: "voyage-code-3", embeddingDim: 1024 } },
    });
    await expect(runEval(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/Index .* does not match/);
  });
});

describe("runEval — requires the graded slices", () => {
  it("throws if synthesis is missing", async () => {
    const result = fixtureResult({ ai: { rag: fixtureResult().ai!.rag } });
    await expect(runEval(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/synthesis is missing/);
  });

  it("throws if questions exist but the rag index is missing", async () => {
    const result = fixtureResult({ ai: { synthesis: fixtureResult().ai!.synthesis } });
    await expect(runEval(DATASET, result, mockEmbeddingClient())).rejects.toThrow(/rag is missing/);
  });
});
