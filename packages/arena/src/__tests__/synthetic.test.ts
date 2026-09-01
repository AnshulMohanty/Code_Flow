import { describe, expect, it } from "vitest";
import {
  generateSyntheticQuestions,
  summarizeSynthetic,
  toTaskSpecs,
} from "../synthetic.js";
import { createGraphOracleAgent, createGraphOracleVerifier, truthFor } from "../verifiers/graphOracle.js";
import { createSandbox } from "../sandbox.js";
import { runArena } from "../runArena.js";
import { fixtureResult } from "./fixtures.js";

// V3-P2 task 4. The flywheel's value rests entirely on one claim — that its labels are EXACT —
// so the tests below are mostly about that claim and about the two things that would quietly
// destroy it: a label that came from anywhere but the oracle, and a "hard negative" that is
// secretly a correct answer.

const result = fixtureResult();

describe("generateSyntheticQuestions — labels come from the oracle, exactly", () => {
  const questions = generateSyntheticQuestions({ result });

  it("generates questions across the oracle's kinds", () => {
    const kinds = new Set(questions.map((question) => question.kind));
    expect(kinds.has("imports-of")).toBe(true);
    expect(kinds.has("who-calls")).toBe(true);
    expect(kinds.has("blast-radius")).toBe(true);
    expect(kinds.has("entry-points")).toBe(true);
    expect(questions.length).toBeGreaterThan(5);
  });

  it("every label EQUALS the oracle's own truth for that question", () => {
    // The claim the whole flywheel rests on. Not "close to" — identical, by construction.
    for (const question of questions) {
      expect(question.expectedFileIds).toEqual(truthFor(question.kind, result, question.fileId));
    }
  });

  it("phrases questions in a developer's words, not the schema's", () => {
    // A question worded in the graph's own vocabulary ("reverse transitive closure of X") would
    // be trivially easy for retrieval and would measure nothing.
    const blast = questions.find((question) => question.kind === "blast-radius");
    expect(blast?.question).toMatch(/^What breaks if I change /);
    const imports = questions.find((question) => question.kind === "imports-of");
    expect(imports?.question).toMatch(/^Which files import /);
  });

  it("gives every question a stable, readable id", () => {
    const ids = questions.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const question of questions) expect(question.id).toMatch(/^syn-[a-z-]+-\d+$/);
  });

  it("is DETERMINISTIC — two runs are byte-identical", () => {
    // No RNG anywhere: targets are ordered by degree descending then fileId. Without this two
    // eval runs would not be comparable, which would make the whole set useless as a baseline.
    expect(JSON.stringify(generateSyntheticQuestions({ result }))).toBe(JSON.stringify(questions));
  });

  it("targets well-connected files first, so questions have content", () => {
    // A file nothing touches yields an empty answer, and a set of those measures nothing.
    const importsOf = questions.filter((question) => question.kind === "imports-of" && !question.negativeControl);
    expect(importsOf.length).toBeGreaterThan(0);
    for (const question of importsOf) expect(question.expectedFileIds.length).toBeGreaterThan(0);
  });

  it("generates exactly one repo-wide entry-points question", () => {
    const entries = questions.filter((question) => question.kind === "entry-points");
    expect(entries).toHaveLength(1);
    expect(entries[0].fileId).toBeUndefined();
    expect(entries[0].expectedFileIds).toEqual(["src/index.ts"]);
  });

  it("honours perKind and the kinds filter", () => {
    const only = generateSyntheticQuestions({ result, kinds: ["imports-of"], perKind: 2, negativeControlsPerKind: 0 });
    expect(only.every((question) => question.kind === "imports-of")).toBe(true);
    expect(only).toHaveLength(2);
  });
});

describe("generateSyntheticQuestions — negative controls are GENERATED, not guessed", () => {
  it("produces empty-answer questions and flags them", () => {
    // The most valuable output: a question whose correct answer is a refusal, known with
    // certainty rather than authored on a hunch. `src/orphan.ts` is imported by nobody.
    const questions = generateSyntheticQuestions({ result, negativeControlsPerKind: 2 });
    const negatives = questions.filter((question) => question.negativeControl);
    expect(negatives.length).toBeGreaterThan(0);
    for (const negative of negatives) expect(negative.expectedFileIds).toEqual([]);
  });

  it("BOUNDS them, because a set dominated by refusals measures nothing", () => {
    // In most repositories most files are imported by nobody, so an unbounded generator would
    // emit an almost entirely negative set and the recall number would stop meaning anything.
    const questions = generateSyntheticQuestions({ result, negativeControlsPerKind: 1, perKind: 5 });
    const byKind = new Map<string, number>();
    for (const question of questions.filter((entry) => entry.negativeControl)) {
      byKind.set(question.kind, (byKind.get(question.kind) ?? 0) + 1);
    }
    for (const count of byKind.values()) expect(count).toBeLessThanOrEqual(1);
  });

  it("can be turned off entirely", () => {
    const questions = generateSyntheticQuestions({ result, negativeControlsPerKind: 0 });
    expect(questions.every((question) => !question.negativeControl)).toBe(true);
  });
});

describe("mineHardNegatives — plausible, adjacent, and provably wrong", () => {
  const questions = generateSyntheticQuestions({ result, perKind: 5, negativeControlsPerKind: 0 });

  it("NEVER includes a correct answer or the target itself", () => {
    // The one way a hard negative can be actively harmful: if it is secretly correct, the
    // negative teaches the exact opposite of the truth.
    for (const question of questions) {
      const truth = new Set(question.expectedFileIds);
      for (const negative of question.hardNegativeFileIds) {
        expect(truth.has(negative)).toBe(false);
        expect(negative).not.toBe(question.fileId);
      }
    }
  });

  it("mines the REVERSE direction for imports-of", () => {
    // `src/service.ts` imports repo.ts and base.ts, and is imported by index.ts. The reverse
    // direction is the single most common confusion in "who depends on what".
    const question = questions.find((entry) => entry.kind === "imports-of" && entry.fileId === "src/service.ts");
    expect(question?.expectedFileIds).toEqual(["src/index.ts"]);
    expect(question?.hardNegativeFileIds.sort()).toEqual(["src/base.ts", "src/repo.ts"]);
    expect(question?.hardNegativeStrategy).toMatch(/reverse direction/);
  });

  it("mines UPSTREAM dependencies for blast-radius", () => {
    // Same subgraph, opposite arrow — exactly what a reader confuses with dependents.
    const question = questions.find((entry) => entry.kind === "blast-radius" && entry.fileId === "src/repo.ts");
    expect(question?.expectedFileIds).toEqual(["src/index.ts", "src/service.ts"]);
    expect(question?.hardNegativeFileIds).toEqual(["src/util.ts"]); // repo.ts -> util.ts
    expect(question?.hardNegativeStrategy).toMatch(/upstream/i);
  });

  it("mines SAME-COMMUNITY non-callers for who-calls", () => {
    // Louvain communities are low-coupling by construction, so a same-community file is
    // genuinely nearby in the code's own structure — and a similarity-based retriever will
    // happily return it.
    const question = questions.find((entry) => entry.kind === "who-calls" && entry.fileId === "src/service.ts");
    expect(question?.expectedFileIds).toEqual(["src/index.ts"]);
    expect(question?.hardNegativeFileIds.length).toBeGreaterThan(0);
    expect(question?.hardNegativeFileIds).not.toContain("src/index.ts"); // the real caller
    expect(question?.hardNegativeStrategy).toMatch(/community/);
  });

  it("mines connected non-entry-points for entry-points", () => {
    const question = questions.find((entry) => entry.kind === "entry-points");
    expect(question?.hardNegativeFileIds).not.toContain("src/index.ts");
    expect(question?.hardNegativeFileIds.length).toBeGreaterThan(0);
    expect(question?.hardNegativeStrategy).toMatch(/hubs look like entry points/);
  });

  it("honours the per-question cap", () => {
    const capped = generateSyntheticQuestions({ result, hardNegativesPerQuestion: 1, negativeControlsPerKind: 0 });
    for (const question of capped) expect(question.hardNegativeFileIds.length).toBeLessThanOrEqual(1);
  });

  it("returns an empty list rather than inventing negatives when the graph offers none", () => {
    // No clusters ⇒ no community to mine. Absent, not fabricated.
    const noClusters = fixtureResult({ metrics: { ...result.metrics!, clusters: undefined } });
    const questions2 = generateSyntheticQuestions({ result: noClusters, kinds: ["who-calls"], negativeControlsPerKind: 0 });
    for (const question of questions2) expect(question.hardNegativeFileIds).toEqual([]);
  });
});

describe("the flywheel checks ITSELF: the oracle scores its own generated set perfectly", () => {
  it("running the oracle as the agent over the generated tasks yields 1.0 on every task", async () => {
    // The correctness check that matters. If this ever fails, the generator and the verifier
    // have drifted apart and every synthetic label is suspect — so it is asserted rather than
    // assumed, and it is free (no model, no network).
    const questions = generateSyntheticQuestions({ result, negativeControlsPerKind: 1 });
    const tasks = toTaskSpecs(questions, result);
    const runs = await runArena(tasks, createGraphOracleAgent(), createSandbox(result), [createGraphOracleVerifier()]);

    expect(runs).toHaveLength(tasks.length);
    for (const run of runs) {
      expect(run.passed).toBe(true);
      expect(run.score).toBe(1);
      // And it cost nothing: an exact verdict means no model was consulted.
      expect(run.verifications.every((verification) => verification.exact)).toBe(true);
    }
  });

  it("a WRONG answer on a generated task is scored as wrong", () => {
    // The other half of trusting the check above: confirm the verifier is not simply passing
    // everything. A perfect score from a grader that cannot fail is not a measurement.
    const questions = generateSyntheticQuestions({ result, kinds: ["imports-of"], perKind: 1, negativeControlsPerKind: 0 });
    const [task] = toTaskSpecs(questions, result);
    const verifier = createGraphOracleVerifier();
    return verifier
      .verify(task, { fileIds: ["src/util.ts"] }, createSandbox(result))
      .then((verdict) => {
        expect(verdict.passed).toBe(false);
        expect(verdict.reward.score).toBe(0);
      });
  });

  it("toTaskSpecs pins every task to the result's repo and SHA", () => {
    const questions = generateSyntheticQuestions({ result, perKind: 1 });
    for (const task of toTaskSpecs(questions, result)) {
      expect(task.commitSha).toBe(result.commitSha);
      expect(task.repo).toEqual(result.repository);
      expect(task.oracle).toBeDefined();
    }
  });
});

describe("summarizeSynthetic", () => {
  it("reports totals, per-kind counts, negative controls and hard-negative coverage", () => {
    const questions = generateSyntheticQuestions({ result });
    const summary = summarizeSynthetic(questions);
    expect(summary.total).toBe(questions.length);
    expect(Object.values(summary.byKind).reduce((sum, count) => sum + count, 0)).toBe(questions.length);
    expect(summary.negativeControls).toBeGreaterThanOrEqual(0);
    expect(summary.totalHardNegatives).toBeGreaterThan(0);
    expect(summary.withHardNegatives).toBeLessThanOrEqual(summary.total);
  });

  it("handles an empty set", () => {
    expect(summarizeSynthetic([])).toEqual({
      total: 0,
      byKind: {},
      negativeControls: 0,
      withHardNegatives: 0,
      totalHardNegatives: 0,
    });
  });
});

describe("generateSyntheticQuestions — degenerate inputs", () => {
  it("produces nothing from a result with no graph", () => {
    const empty = fixtureResult({ graph: undefined, entryPoints: [], inventory: undefined, metrics: undefined });
    expect(generateSyntheticQuestions({ result: empty })).toEqual([]);
  });

  it("skips entry-points when the repository has none", () => {
    const noEntries = fixtureResult({ entryPoints: [], inventory: { ...result.inventory!, entryPoints: [] } });
    const questions = generateSyntheticQuestions({ result: noEntries, kinds: ["entry-points"] });
    expect(questions).toEqual([]);
  });
});
