import type { VersionedBlackboardReport } from "@codeflow/observability";
import type { AnalysisResult, RepoCluster, Synthesis } from "@codeflow/shared-types";
import type { ContextBreakdown } from "../contracts.js";
import type { RepoKnowledgeBase } from "./consolidate.js";

/**
 * BOUNDED AGENT FAN-OUT (V3-P4) — the orchestrator/worker contracts.
 *
 * WHY PARALLELISM IS EARNED HERE AND NOT ASSUMED. Fanning out "5 specialists over the repo" would
 * be five agents reading the same files and reporting overlapping findings — parallel in wall-clock
 * and redundant in content. The fan-out is instead over V3-P1's **Louvain communities**, which are
 * low-coupling BY CONSTRUCTION (that is what modularity measures), so per-community work is
 * genuinely independent and the results genuinely compose.
 *
 * NEVER AN OPEN MESH. Workers do not see each other's output and cannot address each other. Each
 * writes a STRUCTURED SUMMARY to a shared blackboard; a single supervisor reads a bounded selection
 * of that blackboard plus deterministic graph facts, and produces the final synthesis. The
 * documented failure mode at 4+ workers is orchestrator context growing with worker count, and it is
 * avoided structurally: the supervisor reads at most `SUPERVISOR_MAX_FINDINGS` bounded findings, so
 * its prompt has the same ceiling whether there were 5 workers or 500.
 *
 * AGENTS ARE AI LEAVES. Nothing here writes a deterministic slice. The graph, the metrics and the
 * communities are computed before any agent runs and are read-only to all of them; the only thing
 * the fan-out produces is `aiSynthesis`, which was always an AI slice. Determinism of the spine is
 * therefore untouched — a property asserted, not assumed.
 */

/** The five specialist lenses. Fixed set: each maps to a question the graph can partly answer. */
export type SpecialistId = "architecture" | "data-flow" | "security" | "api-surface" | "dependency-risk";

export const SPECIALIST_IDS: readonly SpecialistId[] = [
  "architecture",
  "data-flow",
  "security",
  "api-surface",
  "dependency-risk",
];

/** How important a specialist judges its own finding. Used to select what the supervisor sees. */
export type FindingImportance = "low" | "medium" | "high";

/**
 * One structured finding. This is the ONLY thing that crosses from a worker to the blackboard —
 * never a transcript, never raw chunk text, never the worker's reasoning.
 *
 * Bounded on every field that reaches the supervisor's prompt. That is the whole mechanism: a
 * finding is a fixed-size unit of information, so the supervisor's input is a function of the
 * FINDING CAP and not of how many workers ran.
 */
export interface SpecialistFinding {
  specialist: SpecialistId;
  /** Which community produced it. */
  cluster: number;
  /** One line. Bounded. */
  headline: string;
  /** Bounded prose. */
  detail: string;
  importance: FindingImportance;
  /** fileIds — GROUNDED to the community's own files, which is stricter than "in the graph". */
  fileIds: string[];
}

/** What happened to one (specialist, community) pair. Every outcome is recorded, including refusals. */
export interface BlackboardEntry {
  specialist: SpecialistId;
  cluster: number;
  status: "ok" | "refused" | "failed" | "skipped-budget";
  /** Present for `refused`/`failed`/`skipped-budget` — a reason, never a bare failure. */
  reason?: string;
  findings: SpecialistFinding[];
  /** Ungrounded fileIds the specialist claimed, dropped and counted. */
  droppedFileIds: string[];
  /** How many trajectories were sampled (1 unless the community routed hard). */
  samples: number;
  /** The winning trajectory's verifier score, when best-of-N ran. */
  bestScore?: number;
  context?: ContextBreakdown;
}

/**
 * The shared blackboard. Append-only from the workers' perspective; the supervisor reads a
 * BOUNDED selection (see `selectForSupervisor`).
 */
export interface Blackboard {
  entries: BlackboardEntry[];
  /** Every finding, unbounded — for the report and the trace, NOT for the supervisor's prompt. */
  findings: SpecialistFinding[];
}

/** How a community was routed, and why. Reported so an N-times bill is explainable. */
export interface CommunityRoute {
  cluster: number;
  /** 0..1 deterministic complexity score. */
  complexity: number;
  difficulty: "easy" | "hard";
  /** Number of trajectories this community will get. */
  samples: number;
  /** Why it routed the way it did — the human-readable half of the score. */
  reason: string;
}

/** What a fan-out run produced. */
export interface FanOutResult {
  synthesis: Synthesis;
  blackboard: Blackboard;
  /**
   * The blackboard's APPEND-ONLY version log (V3-P5 task 2e, wired V3-FINAL).
   *
   * One version per posted entry plus the opening state, and a recorded READ for the supervisor —
   * which is the pairing that makes a synthesis explainable: `at(read.version)` returns exactly the
   * board the supervisor reasoned over, not the fuller board that existed by the end of the run.
   *
   * IN-PROCESS ONLY, and that is a decision rather than an oversight: this is a per-write history of
   * a run that can post 60 entries, and writing it into the analysis document is precisely the kind
   * of growth ledger #20 tracks and V3-P2 spent effort removing. A caller that wants it durable can
   * export it through the trace exporter, where a bounded observability artefact belongs.
   */
  blackboardHistory: VersionedBlackboardReport<Blackboard>;
  routes: CommunityRoute[];
  /** Communities NOT analysed because of `FANOUT_MAX_COMMUNITIES`. Reported, never silent. */
  skippedClusters: number[];
  /** Peak concurrent specialist calls observed — the evidence that fan-out is parallel. */
  peakConcurrency: number;
  /** Total specialist LLM calls, including extra best-of-N samples. */
  specialistCalls: number;
  /** Calls attributable to best-of-N alone (i.e. beyond one per specialist/community). */
  bestOfNExtraCalls: number;
  /** The supervisor's own context breakdown — the number that must not grow with worker count. */
  supervisorContext: ContextBreakdown;
  /** True when the supervisor produced the synthesis; false when a deterministic fallback did. */
  supervised: boolean;
  /**
   * The consolidated repository knowledge base (V3-P5 task 6), derived from the blackboard above.
   *
   * Produced here rather than left to a caller for a specific reason: the BLACKBOARD is not
   * persisted, so the findings exist only for the duration of the run. The supervisor reads a
   * bounded selection of 12 and the rest is paid for and then discarded. Consolidating inside the
   * run is the only point at which all of them are still in hand.
   *
   * Typed as `unknown`-free but declared here rather than in `shared-types` on purpose: it
   * references `SpecialistId`, which is an agent-layer concept, and hoisting the whole chain into
   * shared-types to persist a derived artefact would be a wide change for the sake of a field that
   * ledger #20 has just spent effort NOT adding to the analysis document.
   */
  knowledgeBase: RepoKnowledgeBase;
  warnings: string[];
}

/** What a specialist is given. Read-only, and scoped to ONE community. */
export interface SpecialistTask {
  specialist: SpecialistId;
  cluster: RepoCluster;
  /** The frozen analysis. Read-only. */
  result: AnalysisResult;
  /** The community's files, bounded and sorted — the grounding keyspace for this task. */
  fileIds: string[];
}
