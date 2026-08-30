// @codeflow/arena — the VERIFIER / ENVIRONMENT layer (V3-P0 §0.5).
//
// A frozen `Sandbox` (one AnalysisResult at one pinned SHA) plus `Verifier`s that grade an
// output against it. The graph oracle grades EXACTLY with no model call; the three grounding
// passes are wrapped here so the eval and production share one implementation instead of
// four copies that drift. Phase 4's bounded agent fan-out depends on this package.

export type {
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
} from "./contracts.js";

export { createSandbox, loadSandbox } from "./sandbox.js";
export { exactReward, meanScore } from "./reward.js";
export { runArena, runArenaTask } from "./runArena.js";

export {
  createGraphOracleAgent,
  createGraphOracleVerifier,
  truthFor,
  GRAPH_ORACLE_ID,
} from "./verifiers/graphOracle.js";

export {
  createCitationVerifier,
  createFileGroundingVerifier,
  createLineRangeVerifier,
  CITATION_VERIFIER_ID,
  FILE_GROUNDING_VERIFIER_ID,
  LINE_RANGE_VERIFIER_ID,
} from "./verifiers/grounding.js";
