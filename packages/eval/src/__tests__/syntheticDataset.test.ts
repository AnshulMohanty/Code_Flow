import { describe, expect, it } from "vitest";
import { assertDatasetShape } from "../dataset.js";
import { buildSyntheticDataset, summarizeSyntheticDataset } from "../syntheticDataset.js";
import { hydrateEvalIndex } from "../evalIndex.js";
import { runEval } from "../runEval.js";
import { EMBED_DIM, EMBED_MODEL, INDEXED_CHUNKS, fixtureResult, mockEmbeddingClient } from "./fixtures.js";

// The flywheel's OUTPUT, checked where it matters: does a generated dataset actually pass the
// same runtime validation the authored golden set does, and can the same harness score it?
// A generator whose output the loader rejects is a generator that produces nothing usable.

const result = fixtureResult();

/**
 * The eval fixture's result has a 20-character `commitSha`, which is deliberate elsewhere but
 * fails `assertDatasetShape`'s 40-hex-character requirement — that check exists because ground
 * truth is only meaningful pinned to an exact commit. So this pins a real-shaped SHA, which is
 * also what a real analysis result carries.
 */
function pinned() {
  return fixtureResult({ commitSha: "a".repeat(40) });
}

describe("buildSyntheticDataset", () => {
  const built = buildSyntheticDataset({
    result: pinned(),
    embeddingModel: EMBED_MODEL,
    embeddingDim: EMBED_DIM,
  });

  it("produces a dataset that passes the loader's RUNTIME validation", () => {
    // The real test of the adapter. `assertDatasetShape` is the same function that guards the
    // authored golden set on disk, and it rejects unpinned SHAs, duplicate ids, absolute paths
    // and impossible line ranges — every one of which a generator could plausibly emit.
    expect(() => assertDatasetShape(built.dataset)).not.toThrow();
  });

  it("carries provenance saying it was GENERATED and what that does not cover", () => {
    // A dataset whose provenance is unrecorded cannot be trusted later, and this one has a
    // specific limitation worth stating: it measures only the mechanically-verifiable half.
    expect(built.dataset.provenance?.method).toMatch(/GENERATED|graph oracle/);
    expect(built.dataset.provenance?.method).toMatch(/never by a model/);
    expect(built.dataset.provenance?.measures).toMatch(/judgement/);
    expect(built.dataset.provenance?.thresholdStatus).toMatch(/Not comparable/);
  });

  it("maps every generated question, keeping the oracle's answer as expectedFiles", () => {
    expect(built.dataset.questions).toHaveLength(built.questions.length);
    for (const question of built.questions) {
      const mapped = built.dataset.questions.find((entry) => entry.id === question.id);
      expect(mapped?.expectedFiles).toEqual(question.expectedFileIds);
      expect(mapped?.question).toBe(question.question);
    }
  });

  it("keeps hard negatives OUT of the dataset and beside it", () => {
    // `expectedFiles` means "files that answer this". Putting a negative there would invert its
    // meaning; dropping it would lose the mining work. So it travels alongside, keyed by id.
    for (const [id, mined] of Object.entries(built.extras.hardNegatives)) {
      const question = built.dataset.questions.find((entry) => entry.id === id);
      expect(question).toBeDefined();
      for (const negative of mined.fileIds) expect(question?.expectedFiles).not.toContain(negative);
    }
    expect(built.extras.summary.totalHardNegatives).toBeGreaterThan(0);
  });

  it("fills synthesis.expectedEntryPoints from the oracle, so BOTH eval halves run", () => {
    expect(built.dataset.synthesis.expectedEntryPoints).toEqual(["src/index.ts"]);
  });

  it("pins the dataset to the result's repo and SHA", () => {
    expect(built.dataset.commitSha).toBe("a".repeat(40));
    expect(built.dataset.repoUrl).toBe("https://github.com/synthetic/fixture");
  });

  it("declares the embedding space it must be graded in", () => {
    expect(built.dataset.embeddingModel).toBe(EMBED_MODEL);
    expect(built.dataset.embeddingDim).toBe(EMBED_DIM);
  });

  it("is deterministic", () => {
    const again = buildSyntheticDataset({ result: pinned(), embeddingModel: EMBED_MODEL, embeddingDim: EMBED_DIM });
    expect(JSON.stringify(again)).toBe(JSON.stringify(built));
  });

  it("summarizes per-kind counts, negative controls and hard negatives in one line", () => {
    expect(summarizeSyntheticDataset(built)).toMatch(/synthetic set — \d+ question\(s\)/);
    expect(summarizeSyntheticDataset(built)).toMatch(/hard negative\(s\)/);
  });
});

describe("a generated dataset is scoreable by the SAME harness as the authored one", () => {
  it("runs end to end through runEval against the in-memory index", async () => {
    // The point of the adapter: no second scorer. If a generated set needed its own harness, the
    // two numbers would stop being comparable and one of them would rot.
    const pinnedResult = pinned();
    const built = buildSyntheticDataset({
      result: pinnedResult,
      embeddingModel: EMBED_MODEL,
      embeddingDim: EMBED_DIM,
      // The eval fixture's graph is tiny, so keep the set small and deterministic.
      kinds: ["imports-of"],
      perKind: 2,
      negativeControlsPerKind: 1,
    });
    const index = await hydrateEvalIndex(pinnedResult.ai!.rag!, INDEXED_CHUNKS);

    const report = await runEval(built.dataset, pinnedResult, mockEmbeddingClient(), {
      retrieval: { vectorStore: index.vectorStore, textStore: index.textStore },
    });

    expect(report.perQuestion).toHaveLength(built.dataset.questions.length);
    // Scores are not asserted: the fixture's chunk vectors were authored for the AUTHORED
    // questions, so a generated question's recall here is an artefact of the fixture, not a
    // measurement. What is asserted is that the harness accepted and scored the set.
    expect(report.ragScores).not.toBeNull();
    expect(report.summary).toContain("RAG recall@");
  });

  it("counts generated negative controls as negative controls, not as recall-0 failures", async () => {
    // The behaviour V3-P0 fixed for the authored set must hold for the generated one: a question
    // whose correct answer is a refusal must not be averaged in as a retrieval miss.
    const pinnedResult = pinned();
    const built = buildSyntheticDataset({
      result: pinnedResult,
      embeddingModel: EMBED_MODEL,
      embeddingDim: EMBED_DIM,
      kinds: ["imports-of"],
      perKind: 1,
      negativeControlsPerKind: 1,
    });
    const negatives = built.dataset.questions.filter((question) => question.expectedFiles.length === 0);
    expect(negatives.length).toBeGreaterThan(0);

    const index = await hydrateEvalIndex(pinnedResult.ai!.rag!, INDEXED_CHUNKS);
    const report = await runEval(built.dataset, pinnedResult, mockEmbeddingClient(), {
      retrieval: { vectorStore: index.vectorStore, textStore: index.textStore },
    });
    expect(report.ragScores?.negativeControlCount).toBe(negatives.length);
    expect(report.ragScores?.questionCount).toBe(built.dataset.questions.length - negatives.length);
  });
});

describe("buildSyntheticDataset — degenerate inputs", () => {
  it("produces an empty question set from a result with no graph, and says so honestly", () => {
    const built = buildSyntheticDataset({
      result: fixtureResult({ commitSha: "a".repeat(40), graph: undefined, metrics: undefined, entryPoints: [] }),
      embeddingModel: EMBED_MODEL,
      embeddingDim: EMBED_DIM,
    });
    expect(built.dataset.questions).toEqual([]);
    expect(built.dataset.synthesis.expectedEntryPoints).toEqual([]);
    expect(built.extras.summary.total).toBe(0);
  });

  it("emits an empty commitSha for an unpinned result, which the loader then REJECTS", () => {
    // Not papered over with a placeholder: an unpinned dataset grades against a moving target,
    // and failing the shape check loudly is the correct outcome.
    const built = buildSyntheticDataset({
      result: fixtureResult({ commitSha: undefined }),
      embeddingModel: EMBED_MODEL,
      embeddingDim: EMBED_DIM,
    });
    expect(built.dataset.commitSha).toBe("");
    expect(() => assertDatasetShape(built.dataset)).toThrow(/40-character hex/);
  });
});

describe("the fixture used above", () => {
  it("has a graph the generator can actually work from", () => {
    // Guard on the test's own premise: if the eval fixture ever loses its graph, the tests above
    // would pass trivially by generating nothing.
    expect(result.graph?.nodes.length ?? 0).toBeGreaterThan(0);
  });
});
