import { describe, expect, it } from "vitest";
import type {
  AgentHarness,
  AgentOutput,
  ArenaRunResult,
  OracleQuestionKind,
  Reward,
  Sandbox,
  SandboxLoader,
  TaskSpec,
  VerificationResult,
  Verifier,
} from "../contracts.js";
import { createSandbox } from "../sandbox.js";
import { fixtureResult } from "./fixtures.js";

/**
 * CONTRACT TEST for @codeflow/arena — the repo's convention (typed interfaces + a contract
 * test), not zod. It exists to catch the failure a type alone cannot: an interface drifting
 * out of step with what implementations and consumers actually rely on.
 *
 * Every block below constructs a MINIMAL conforming implementation. If a required field is
 * added or a signature changes, this file stops compiling — which is the point.
 */

const result = fixtureResult();

describe("TaskSpec", () => {
  it("is satisfiable with only the required fields", () => {
    const minimal: TaskSpec = {
      id: "t1",
      question: "which files import src/repo.ts?",
      repo: result.repository,
      commitSha: "a".repeat(40),
    };
    expect(minimal.oracle).toBeUndefined();
    expect(minimal.expected).toBeUndefined();
  });

  it("carries an oracle spec + authored expectation when the task is machine-verifiable", () => {
    const verifiable: TaskSpec = {
      id: "t2",
      question: "who calls src/repo.ts?",
      repo: result.repository,
      commitSha: "a".repeat(40),
      oracle: { kind: "who-calls", fileId: "src/repo.ts" },
      expected: { fileIds: ["src/service.ts"], text: "the service layer" },
    };
    expect(verifiable.oracle?.kind).toBe("who-calls");
  });

  it("names exactly the five exactly-verifiable question kinds", () => {
    // Pinned deliberately: adding a kind means teaching `truthFor` to derive it, and a kind
    // the oracle cannot answer would silently score 0 forever.
    const kinds: OracleQuestionKind[] = [
      "who-calls",
      "imports-of",
      "blast-radius",
      "entry-points",
      "cycle-through",
    ];
    expect(kinds).toHaveLength(5);
  });
});

describe("Sandbox", () => {
  it("is read-only: it exposes lookups, never mutators", () => {
    const sandbox: Sandbox = createSandbox(result);
    expect(typeof sandbox.hasFile).toBe("function");
    expect(typeof sandbox.fileIds).toBe("function");
    // An agent must not be able to change the world it is graded in, or the next agent is
    // graded in a different one.
    expect(Object.keys(sandbox).some((key) => /^(set|add|remove|write|update)/.test(key))).toBe(false);
  });

  it("a SandboxLoader resolves a repo+sha to a frozen analysis or null", async () => {
    const loader: SandboxLoader = async (_repo, sha) => (sha === result.commitSha ? result : null);
    expect(await loader(result.repository, result.commitSha!)).not.toBeNull();
    expect(await loader(result.repository, "b".repeat(40))).toBeNull();
  });
});

describe("Verifier", () => {
  it("is satisfiable by a minimal implementation", async () => {
    const verifier: Verifier = {
      id: "minimal",
      supports: () => true,
      async verify(_task, _output, _sandbox): Promise<VerificationResult> {
        return {
          verifierId: "minimal",
          passed: true,
          reward: { score: 1, components: {}, notes: [] },
          exact: true,
        };
      },
    };
    const verdict = await verifier.verify(
      { id: "t", question: "q", repo: result.repository, commitSha: "a".repeat(40) },
      {},
      createSandbox(result),
    );
    expect(verdict).toMatchObject({ verifierId: "minimal", passed: true, exact: true });
  });

  it("reports `exact` so a caller can tell a free deterministic verdict from a paid one", () => {
    // This flag is what authorizes using a verifier as a gate.
    const exact: VerificationResult = {
      verifierId: "a",
      passed: true,
      reward: { score: 1, components: {}, notes: [] },
      exact: true,
    };
    const modelBacked: VerificationResult = { ...exact, verifierId: "b", exact: false };
    expect(exact.exact).toBe(true);
    expect(modelBacked.exact).toBe(false);
  });
});

describe("Reward", () => {
  it("carries a scalar AND the vector behind it", () => {
    // A reward you cannot decompose is a reward you cannot debug.
    const reward: Reward = { score: 0.5, components: { recall: 1, precision: 0 }, notes: ["missed nothing"] };
    expect(reward.score).toBe(0.5);
    expect(Object.keys(reward.components)).toEqual(["recall", "precision"]);
  });
});

describe("AgentHarness + ArenaRunResult", () => {
  it("an agent needs only an id and run()", async () => {
    const agent: AgentHarness = {
      id: "stub",
      async run(): Promise<AgentOutput> {
        return { text: "an answer", fileIds: ["src/index.ts"] };
      },
    };
    const output = await agent.run(
      { id: "t", question: "q", repo: result.repository, commitSha: "a".repeat(40) },
      createSandbox(result),
    );
    expect(output.fileIds).toEqual(["src/index.ts"]);
  });

  it("a run result keeps the task, the output and EVERY verdict", () => {
    // Keeping all verdicts (not just the aggregate) is what makes a score explainable later.
    const runResult: ArenaRunResult = {
      task: { id: "t", question: "q", repo: result.repository, commitSha: "a".repeat(40) },
      agentId: "stub",
      output: { fileIds: [] },
      verifications: [],
      score: 0,
      passed: false,
    };
    expect(runResult.verifications).toEqual([]);
    expect(runResult.passed).toBe(false);
  });
});
