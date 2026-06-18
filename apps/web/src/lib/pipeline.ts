import type { PipelineRunStatus, PipelineStageId, PipelineStatusReason, ProgressEvent, StageStatus } from "@codeflow/shared-types";

/**
 * One stage's live view in the panel. `status` is the orchestrator's StageStatus once an
 * event has arrived, else "pending". `detail`/`preview` are rendered GENERICALLY (no
 * per-stage hardcoding) from the event payload.
 */
export interface StageView {
  stage: PipelineStageId;
  /** 1-based stageIndex (the authoritative dedupe key). */
  index: number;
  label: string;
  status: StageStatus | "pending";
  detail?: string;
  preview?: ProgressEvent["preview"];
  durationMs?: number;
}

export interface PipelineState {
  stages: StageView[];
  /** Null while running; set from the terminal `done` event. */
  runStatus: PipelineRunStatus | null;
  /** Distinct terminal reason (the #19/P14 field) — drives the honest banner copy. */
  runStatusReason?: PipelineStatusReason;
  stageCount: number;
}

/** The eight pipeline stages in order (PLAN §4). The panel always shows from Ingest. */
export const PIPELINE_STAGES: ReadonlyArray<{ stage: PipelineStageId; label: string }> = [
  { stage: "ingest", label: "Ingest" },
  { stage: "orient", label: "Orient" },
  { stage: "map-structure", label: "Map structure" },
  { stage: "inventory", label: "Inventory" },
  { stage: "connect", label: "Connect" },
  { stage: "analyze", label: "Analyze" },
  { stage: "synthesize", label: "Synthesize" },
  { stage: "rag", label: "Index for Q&A" },
];

/** Seed all stages as `pending` (up to `stageCount`) so the panel renders from Ingest
 *  before any event arrives — no silent blank state. */
export function initialPipelineState(stageCount: number = PIPELINE_STAGES.length): PipelineState {
  const count = Math.max(1, Math.min(stageCount, PIPELINE_STAGES.length));
  return {
    stages: PIPELINE_STAGES.slice(0, count).map((entry, i) => ({
      stage: entry.stage,
      index: i + 1,
      label: entry.label,
      status: "pending",
    })),
    runStatus: null,
    stageCount: count,
  };
}

/**
 * Fold one ProgressEvent into the state — upsert by the monotonic `stageIndex` (one
 * authoritative event per stage, so replayed + live events for the same stage collapse to
 * one). Pure: returns a new state.
 */
export function applyProgressEvent(state: PipelineState, event: ProgressEvent): PipelineState {
  const stages = state.stages.map((view) =>
    view.index === event.stageIndex
      ? {
          ...view,
          label: event.label || view.label,
          status: event.status,
          detail: event.detail,
          preview: event.preview,
          durationMs: event.durationMs,
        }
      : view,
  );
  return { ...state, stages };
}

/** Fold the terminal `done` event: record the honest run status + reason. */
export function applyDoneEvent(
  state: PipelineState,
  status: PipelineRunStatus,
  reason?: PipelineStatusReason,
): PipelineState {
  return { ...state, runStatus: status, runStatusReason: reason };
}
