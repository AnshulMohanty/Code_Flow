import type { AnalysisResult, RepositoryRef } from "@codeflow/shared-types";

/**
 * `@codeflow/arena` — the VERIFIER / ENVIRONMENT layer (V3-P0 §0.5).
 *
 * What this package is for: giving an agent a frozen world it can be graded in, and grading
 * it with something that cannot be argued with. Two properties make that worth building
 * before any agent exists (Phase 4 depends on it):
 *
 *   1. A `Sandbox` is a FROZEN `AnalysisResult` at a pinned SHA. Two agents graded against
 *      the same sandbox are graded against literally the same world, so a score difference is
 *      the agents' and not the repository's.
 *   2. A `Verifier` returns an exact pass/fail with NO LLM call wherever the question is
 *      decidable from the graph. A grader that costs money and varies run to run is not a
 *      grader; the graph oracle (see `verifiers/graphOracle.ts`) is deterministic and free.
 *
 * Contracts are TYPED INTERFACES plus a contract test, matching this repo's convention —
 * there is no zod here and introducing it for one package would be worse than consistent.
 * Runtime validation belongs at untrusted external boundaries; a sandbox built in-process
 * from an already-validated `AnalysisResult` is not one.
 */

// ── TaskSpec ─────────────────────────────────────────────────────────────────────────

/**
 * Question kinds the graph oracle can answer EXACTLY, with no model involved. Each maps to a
 * fact already present in the analysis result:
 *
 *   who-calls      — which files call INTO a target file (V3-P1's `graph.cpgEdges` call edges
 *                    made this answerable; before the CPG there was no call data at all)
 *   imports-of     — which files import a target (dependency edges)
 *   blast-radius   — which files are transitively affected by a change (reverse reachability)
 *   entry-points   — where a newcomer starts (inventory/connect entry points)
 *   cycle-through  — which dependency cycles a file participates in
 */
export type OracleQuestionKind = "who-calls" | "imports-of" | "blast-radius" | "entry-points" | "cycle-through";

/** A task an agent (or the oracle) is asked to perform against a pinned repository state. */
export interface TaskSpec {
  id: string;
  /** The question in natural language — what an agent actually receives. */
  question: string;
  /** The repository + the EXACT commit the task is pinned to. */
  repo: RepositoryRef;
  commitSha: string;
  /**
   * Present when the task is machine-verifiable. Absent for open-ended tasks, which can only
   * be graded by a grounding verifier or (calibrated) judge — never by the oracle.
   */
  oracle?: {
    kind: OracleQuestionKind;
    /** The fileId the question is about. Omitted for `entry-points`, which is repo-wide. */
    fileId?: string;
  };
  /**
   * The expected answer, when a human authored one. The oracle DERIVES the truth instead, so
   * this is for authored tasks and for cross-checking the oracle itself.
   */
  expected?: {
    /** Expected fileIds, order-insensitive. */
    fileIds?: string[];
    /** Free-text expectation for tasks no exact grader covers. */
    text?: string;
  };
}

// ── Sandbox ──────────────────────────────────────────────────────────────────────────

/**
 * A frozen world: one `AnalysisResult` at one SHA, loaded once and never mutated.
 *
 * Loading is injectable (`SandboxLoader`) so production reuses the EXISTING SHA-keyed
 * analysis cache rather than re-analyzing, and tests hand over a fixture. The sandbox exposes
 * only reads — an agent must not be able to change the world it is being graded in, because
 * then the next agent is graded in a different one.
 */
export interface Sandbox {
  readonly repo: RepositoryRef;
  readonly commitSha: string;
  /** The frozen analysis. Treat as deeply read-only. */
  readonly result: AnalysisResult;
  /** Every fileId in the graph — the grounding keyspace every verifier checks against. */
  fileIds(): ReadonlySet<string>;
  /** True when `fileId` is a real node. The cheapest grounding question there is. */
  hasFile(fileId: string): boolean;
}

/** Resolves a `{repo, sha}` to a frozen analysis, or null when none is cached. */
export type SandboxLoader = (repo: RepositoryRef, commitSha: string) => Promise<AnalysisResult | null>;

// ── Reward ───────────────────────────────────────────────────────────────────────────

/**
 * A graded outcome. `score` is the scalar an optimizer would read; `components` is the vector
 * behind it, kept because a single number cannot say WHY something scored badly and a reward
 * you cannot decompose is a reward you cannot debug.
 *
 * (Reward here is a MEASUREMENT surface only. Nothing in this repo trains on it — see the
 * out-of-scope list in the design doc.)
 */
export interface Reward {
  /** 0..1. 1 = fully correct. */
  score: number;
  /** Named sub-scores, each 0..1. */
  components: Record<string, number>;
  /** Human-readable reasons, especially for a failure. */
  notes: string[];
}

// ── Verifier ─────────────────────────────────────────────────────────────────────────

/** What an agent (or a pipeline stage) produced, in the shape a verifier can grade. */
export interface AgentOutput {
  /** The answer text, when there is one. */
  text?: string;
  /** fileIds the output claims are relevant / cited. */
  fileIds?: string[];
  /** Citations with line ranges, for the grounding verifiers. */
  citations?: Array<{ fileId: string; startLine?: number; endLine?: number }>;
}

export interface VerificationResult {
  verifierId: string;
  passed: boolean;
  reward: Reward;
  /** True when NO model was consulted — i.e. this verdict is exact and free. */
  exact: boolean;
}

/**
 * Grades an output against a task inside a sandbox.
 *
 * `exact: true` verifiers must make no network call and must be deterministic: the same
 * (task, output, sandbox) always yields the same verdict. That is the property that lets a
 * verifier be used as a gate.
 */
export interface Verifier {
  readonly id: string;
  /** True when this verifier can grade this task at all (e.g. the oracle needs `task.oracle`). */
  supports(task: TaskSpec): boolean;
  verify(task: TaskSpec, output: AgentOutput, sandbox: Sandbox): Promise<VerificationResult>;
}

// ── AgentHarness ─────────────────────────────────────────────────────────────────────

/**
 * Runs an agent against a sandbox and returns its output. Deliberately minimal: the Arena's
 * job is to grade, not to define how an agent thinks. Phase 4's orchestrator implements this
 * interface; the graph oracle can also implement it, which is what makes the oracle
 * self-checkable (run it as the agent, grade it with itself, expect a perfect score).
 */
export interface AgentHarness {
  readonly id: string;
  run(task: TaskSpec, sandbox: Sandbox): Promise<AgentOutput>;
}

/** One task, run and graded. The unit an eval report or a training loop would consume. */
export interface ArenaRunResult {
  task: TaskSpec;
  agentId: string;
  output: AgentOutput;
  verifications: VerificationResult[];
  /** Mean score across the verifiers that ran. */
  score: number;
  /** True only when EVERY verifier that ran passed. */
  passed: boolean;
}
