import type { PipelineStatusReason } from "@codeflow/shared-types";

/**
 * A stage error carrying a typed, machine-readable `reason` (P4 guardrails). The
 * orchestrator reads `reason` off a thrown error and stamps it onto
 * `PipelineRunSummary.statusReason`, so a guarded outcome is distinguishable from a
 * generic crash (e.g. "demo at capacity" vs "synthesis failed").
 */
export class PipelineReasonError extends Error {
  constructor(
    message: string,
    public readonly reason: PipelineStatusReason,
  ) {
    super(message);
    this.name = "PipelineReasonError";
  }
}

/** Guard 1: a cloned repo exceeds the file-count / byte size cap (deterministic ⇒ "failed"). */
export class RepoTooLargeError extends PipelineReasonError {
  constructor(
    public readonly fileCount: number,
    public readonly totalBytes: number,
    message: string,
  ) {
    super(message, "repo-too-large");
    this.name = "RepoTooLargeError";
  }
}

/** Guard 5: the global daily LLM budget is exhausted (AI stage ⇒ graceful "partial"). */
export class BudgetExceededError extends PipelineReasonError {
  constructor(message: string) {
    super(message, "budget-exhausted");
    this.name = "BudgetExceededError";
  }
}

/** Read the typed reason off any thrown value, or undefined if it carries none. */
export function statusReasonOf(error: unknown): PipelineStatusReason | undefined {
  return error instanceof PipelineReasonError ? error.reason : undefined;
}
