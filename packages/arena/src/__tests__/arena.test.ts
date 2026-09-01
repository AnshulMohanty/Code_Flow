import { describe, expect, it, vi } from "vitest";
import type { AgentHarness, AgentOutput, TaskSpec, Verifier } from "../contracts.js";
import { createSandbox, loadSandbox } from "../sandbox.js";
import { exactReward, meanScore } from "../reward.js";
import { runArena, runArenaTask } from "../runArena.js";
import { createGraphOracleAgent, createGraphOracleVerifier, truthFor } from "../verifiers/graphOracle.js";
import {
  createCitationVerifier,
  createFileGroundingVerifier,
  createLineRangeVerifier,
} from "../verifiers/grounding.js";
import { fixtureResult, LOC } from "./fixtures.js";

// V3-P0 §0.5 — the Arena skeleton. Fully hermetic: a fixture AnalysisResult, no clone, no
// cache, and — critically — NO LLM call anywhere in this file.

const result = fixtureResult();
const sandbox = createSandbox(result);

function task(kind: NonNullable<TaskSpec["oracle"]>["kind"], fileId?: string): TaskSpec {
  return {
    id: `t-${kind}-${fileId ?? "repo"}`,
    question: `${kind} ${fileId ?? ""}`.trim(),
    repo: result.repository,
    commitSha: result.commitSha!,
    oracle: { kind, ...(fileId ? { fileId } : {}) },
  };
}

describe("sandbox — a frozen world", () => {
  it("exposes the graph's fileIds as the grounding keyspace", () => {
    expect(sandbox.fileIds().size).toBe(8);
    expect(sandbox.hasFile("src/service.ts")).toBe(true);
    expect(sandbox.hasFile("src/does-not-exist.ts")).toBe(false);
  });

  it("carries the repo + pinned SHA it was built from", () => {
    expect(sandbox.commitSha).toBe("a".repeat(40));
    expect(sandbox.repo.name).toBe("fixture");
  });

  it("falls back to result.files when graph.nodes is absent", () => {
    const withoutGraph = createSandbox({ ...result, graph: undefined });
    expect(withoutGraph.hasFile("src/index.ts")).toBe(true);
  });

  it("loads through an injected loader — production reuses the SHA-keyed cache", async () => {
    const loader = vi.fn(async () => result);
    const loaded = await loadSandbox(loader, result.repository, result.commitSha!);
    expect(loaded?.hasFile("src/repo.ts")).toBe(true);
    expect(loader).toHaveBeenCalledWith(result.repository, result.commitSha);
  });

  it("returns null when nothing is cached rather than analyzing on demand", async () => {
    // Silently analyzing would make grading cost money and vary by cache state.
    expect(await loadSandbox(async () => null, result.repository, "b".repeat(40))).toBeNull();
  });

  it("REFUSES a result whose SHA differs from the one requested", async () => {
    // Grading against the wrong commit would compare agents on different code.
    await expect(loadSandbox(async () => result, result.repository, "c".repeat(40))).rejects.toThrow(
      /Sandbox mismatch/,
    );
  });
});

describe("graph oracle — exact truth, no model", () => {
  it("imports-of: files that DIRECTLY import the target", () => {
    expect(truthFor("imports-of", result, "src/repo.ts")).toEqual(["src/service.ts"]);
    expect(truthFor("imports-of", result, "src/service.ts")).toEqual(["src/index.ts"]);
    expect(truthFor("imports-of", result, "src/orphan.ts")).toEqual([]);
  });

  it("who-calls: reads V3-P1's CPG call edges — impossible before the code property graph", () => {
    expect(truthFor("who-calls", result, "src/repo.ts")).toEqual(["src/service.ts"]);
    expect(truthFor("who-calls", result, "src/service.ts")).toEqual(["src/index.ts"]);
    // base.ts is EXTENDED, not called — an inheritance edge is still "who depends on it
    // semantically", which is what the question means.
    expect(truthFor("who-calls", result, "src/base.ts")).toEqual(["src/service.ts"]);
    // util.ts is imported by repo.ts but never called through — the distinction the import
    // graph alone cannot make.
    expect(truthFor("imports-of", result, "src/util.ts")).toEqual(["src/repo.ts"]);
    expect(truthFor("who-calls", result, "src/util.ts")).toEqual([]);
  });

  it("blast-radius: transitive dependents, via the same traversal the metrics use", () => {
    // util.ts <- repo.ts <- service.ts <- index.ts
    expect(truthFor("blast-radius", result, "src/util.ts")).toEqual([
      "src/index.ts",
      "src/repo.ts",
      "src/service.ts",
    ]);
    expect(truthFor("blast-radius", result, "src/index.ts")).toEqual([]);
  });

  it("entry-points: prefers Connect's fileId projection, falls back to Inventory", () => {
    expect(truthFor("entry-points", result)).toEqual(["src/index.ts"]);
    const noProjection = { ...result, entryPoints: undefined };
    expect(truthFor("entry-points", noProjection)).toEqual(["src/index.ts"]);
  });

  it("cycle-through: the file's cycle partners, excluding itself", () => {
    expect(truthFor("cycle-through", result, "src/cycle-a.ts")).toEqual(["src/cycle-b.ts"]);
    expect(truthFor("cycle-through", result, "src/index.ts")).toEqual([]);
  });

  it("returns an empty truth rather than throwing when the graph slice is missing", () => {
    // `metrics` is required by the contract, so an "absent metrics" world is expressed as an
    // empty one — which is what a graph-less run actually assembles.
    const bare: typeof result = {
      ...result,
      graph: undefined,
      metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: result.metrics.summary },
    };
    expect(truthFor("blast-radius", bare, "src/util.ts")).toEqual([]);
    expect(truthFor("who-calls", bare, "src/repo.ts")).toEqual([]);
  });
});

describe("graph oracle verifier", () => {
  const verifier = createGraphOracleVerifier();

  it("only supports machine-verifiable tasks", () => {
    expect(verifier.supports(task("imports-of", "src/repo.ts"))).toBe(true);
    expect(verifier.supports(task("entry-points"))).toBe(true);
    // A file-scoped kind with no fileId cannot be answered.
    expect(verifier.supports({ ...task("imports-of"), oracle: { kind: "imports-of" } })).toBe(false);
    // No oracle spec at all ⇒ not machine-verifiable; it must not pretend otherwise.
    expect(verifier.supports({ id: "x", question: "why?", repo: result.repository, commitSha: "z" })).toBe(false);
  });

  it("passes an exact match and reports it as EXACT (no model consulted)", async () => {
    const verdict = await verifier.verify(
      task("imports-of", "src/repo.ts"),
      { fileIds: ["src/service.ts"] },
      sandbox,
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.exact).toBe(true);
    expect(verdict.reward.score).toBe(1);
    expect(verdict.reward.components).toMatchObject({ recall: 1, precision: 1, grounded: 1 });
  });

  it("is order-insensitive", async () => {
    const verdict = await verifier.verify(
      task("blast-radius", "src/util.ts"),
      { fileIds: ["src/service.ts", "src/index.ts", "src/repo.ts"] },
      sandbox,
    );
    expect(verdict.passed).toBe(true);
  });

  it("fails an incomplete answer and NAMES what was missed", async () => {
    const verdict = await verifier.verify(
      task("blast-radius", "src/util.ts"),
      { fileIds: ["src/repo.ts"] },
      sandbox,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reward.components.recall).toBeCloseTo(1 / 3);
    expect(verdict.reward.components.precision).toBe(1);
    expect(verdict.reward.notes.join(" ")).toContain("missed: src/index.ts, src/service.ts");
  });

  it("distinguishes a WRONG real file from a FABRICATED one", async () => {
    const wrongReal = await verifier.verify(
      task("imports-of", "src/repo.ts"),
      { fileIds: ["src/util.ts"] },
      sandbox,
    );
    expect(wrongReal.reward.components.grounded).toBe(1); // the file exists, it is just wrong
    expect(wrongReal.passed).toBe(false);

    const fabricated = await verifier.verify(
      task("imports-of", "src/repo.ts"),
      { fileIds: ["src/service.ts", "src/invented.ts"] },
      sandbox,
    );
    expect(fabricated.reward.components.grounded).toBe(0);
    expect(fabricated.passed).toBe(false);
    expect(fabricated.reward.notes.join(" ")).toContain("NOT IN THE REPOSITORY");
  });

  it("treats an empty truth set correctly: empty answer passes, any answer fails", async () => {
    const empty = await verifier.verify(task("imports-of", "src/orphan.ts"), { fileIds: [] }, sandbox);
    expect(empty.passed).toBe(true);
    const overclaim = await verifier.verify(
      task("imports-of", "src/orphan.ts"),
      { fileIds: ["src/index.ts"] },
      sandbox,
    );
    expect(overclaim.passed).toBe(false);
  });

  it("throws if verify is called on an unsupported task (fail loud, not silently pass)", async () => {
    const noOracle: TaskSpec = { id: "x", question: "why?", repo: result.repository, commitSha: "z" };
    await expect(verifier.verify(noOracle, {}, sandbox)).rejects.toThrow(/no oracle spec/);
  });
});

describe("the oracle grades ITSELF perfectly — the honesty round trip", () => {
  // If this ever fails, the truth derivation and the comparison have drifted apart and every
  // score the Arena has produced is suspect.
  const agent = createGraphOracleAgent();
  const verifier = createGraphOracleVerifier();
  const tasks: TaskSpec[] = [
    task("imports-of", "src/repo.ts"),
    task("who-calls", "src/service.ts"),
    task("blast-radius", "src/util.ts"),
    task("entry-points"),
    task("cycle-through", "src/cycle-a.ts"),
  ];

  it("scores 1.0 on every oracle question kind", async () => {
    const results = await runArena(tasks, agent, sandbox, [verifier]);
    expect(results).toHaveLength(5);
    for (const entry of results) {
      expect(entry.passed, entry.task.id).toBe(true);
      expect(entry.score, entry.task.id).toBe(1);
    }
  });

  it("is deterministic — the same run twice is byte-identical", async () => {
    const first = await runArena(tasks, agent, sandbox, [verifier]);
    const second = await runArena(tasks, agent, sandbox, [verifier]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("grounding verifiers (the three production passes, reusable)", () => {
  it("PASS 1: rejects a fileId that is not in the repository", async () => {
    const verifier = createFileGroundingVerifier();
    const ok = await verifier.verify(task("entry-points"), { fileIds: ["src/index.ts"] }, sandbox);
    expect(ok.passed).toBe(true);

    const invented = await verifier.verify(
      task("entry-points"),
      { fileIds: ["src/index.ts", "src/services/authService.ts"] },
      sandbox,
    );
    expect(invented.passed).toBe(false);
    expect(invented.reward.score).toBeCloseTo(0.5);
    expect(invented.reward.notes.join(" ")).toContain("src/services/authService.ts");
  });

  it("PASS 1: an output that claims nothing has invented nothing", async () => {
    const verifier = createFileGroundingVerifier();
    expect((await verifier.verify(task("entry-points"), {}, sandbox)).passed).toBe(true);
  });

  it("PASS 2: rejects a line range past the end of a real file", async () => {
    const verifier = createLineRangeVerifier();
    // service.ts is 60 lines; the fileId check would pass, the citation is still fabricated.
    const bad = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/service.ts", startLine: 900, endLine: 950 }] },
      sandbox,
    );
    expect(bad.passed).toBe(false);
    expect(bad.reward.notes.join(" ")).toContain(`file has ${LOC["src/service.ts"]} lines`);

    const good = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/service.ts", startLine: 10, endLine: 20 }] },
      sandbox,
    );
    expect(good.passed).toBe(true);
  });

  it("PASS 2: rejects an inverted or zero-based range", async () => {
    const verifier = createLineRangeVerifier();
    const inverted = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/service.ts", startLine: 30, endLine: 10 }] },
      sandbox,
    );
    expect(inverted.passed).toBe(false);
    expect(inverted.reward.notes.join(" ")).toContain("impossible range");
  });

  it("PASS 2: reports an unverifiable citation instead of passing or failing it silently", async () => {
    const verifier = createLineRangeVerifier();
    const noLoc = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/no-loc-recorded.ts", startLine: 1, endLine: 5 }] },
      sandbox,
    );
    expect(noLoc.passed).toBe(true); // nothing provably wrong...
    expect(noLoc.reward.notes.join(" ")).toContain("could not be range-checked"); // ...but said so
  });

  it("PASS 3: rejects a citation that was never retrieved", async () => {
    // The strongest pass: catches an answer drawn from parametric memory rather than the repo.
    const retrieved = [{ fileId: "src/service.ts", startLine: 1, endLine: 30 }];
    const verifier = createCitationVerifier(retrieved);

    const fromEvidence = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/service.ts", startLine: 5, endLine: 12 }] },
      sandbox,
    );
    expect(fromEvidence.passed).toBe(true);

    // A REAL file at REAL lines that the model never received.
    const fromMemory = await verifier.verify(
      task("entry-points"),
      { citations: [{ fileId: "src/repo.ts", startLine: 1, endLine: 10 }] },
      sandbox,
    );
    expect(fromMemory.passed).toBe(false);
    expect(fromMemory.reward.notes.join(" ")).toContain("answered from outside the evidence");
  });

  it("every grounding verifier is EXACT (no model, no network)", async () => {
    const verifiers = [createFileGroundingVerifier(), createLineRangeVerifier(), createCitationVerifier([])];
    for (const verifier of verifiers) {
      const verdict = await verifier.verify(task("entry-points"), {}, sandbox);
      expect(verdict.exact, verifier.id).toBe(true);
    }
  });
});

describe("runArenaTask — composition", () => {
  const oracleAgent = createGraphOracleAgent();

  it("runs only the verifiers that SUPPORT the task", async () => {
    const unsupported: Verifier = {
      id: "never",
      supports: () => false,
      verify: async () => {
        throw new Error("must not run");
      },
    };
    const outcome = await runArenaTask(task("entry-points"), oracleAgent, sandbox, [
      createGraphOracleVerifier(),
      unsupported,
    ]);
    expect(outcome.verifications.map((entry) => entry.verifierId)).toEqual(["graph-oracle"]);
    expect(outcome.passed).toBe(true);
  });

  it("requires EVERY verifier to pass — accuracy cannot pay for a grounding failure", async () => {
    // The agent answers correctly but also cites a file that does not exist. That is not 80%
    // correct; it is ungrounded.
    const sloppy: AgentHarness = {
      id: "sloppy",
      async run(): Promise<AgentOutput> {
        return { fileIds: ["src/service.ts"], citations: [{ fileId: "src/ghost.ts", startLine: 1, endLine: 2 }] };
      },
    };
    const outcome = await runArenaTask(task("imports-of", "src/repo.ts"), sloppy, sandbox, [
      createGraphOracleVerifier(),
      createFileGroundingVerifier(),
    ]);
    // The oracle is satisfied...
    expect(outcome.verifications.find((entry) => entry.verifierId === "graph-oracle")?.passed).toBe(true);
    // ...but grounding is not, so the task fails.
    expect(outcome.passed).toBe(false);
    expect(outcome.score).toBeLessThan(1);
  });

  it("does NOT pass when no verifier ran — silence is not success", async () => {
    const outcome = await runArenaTask(
      { id: "open", question: "explain the architecture", repo: result.repository, commitSha: "z" },
      oracleAgent,
      sandbox,
      [createGraphOracleVerifier()],
    );
    expect(outcome.verifications).toEqual([]);
    expect(outcome.passed).toBe(false);
    expect(outcome.score).toBe(0);
  });
});

describe("reward", () => {
  it("clamps out-of-range values so a mean can never exceed the maximum", () => {
    const reward = exactReward(7, { recall: 1.5, precision: -2 });
    expect(reward.score).toBe(1);
    expect(reward.components).toEqual({ recall: 1, precision: 0 });
  });

  it("means an empty reward set to 0 — grading nothing is not a pass", () => {
    expect(meanScore([])).toBe(0);
    expect(meanScore([exactReward(1, {}), exactReward(0, {})])).toBe(0.5);
  });
});
