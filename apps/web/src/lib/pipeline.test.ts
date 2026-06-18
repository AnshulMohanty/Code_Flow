import type { ProgressEvent } from "@codeflow/shared-types";
import { describe, expect, it } from "vitest";
import { applyDoneEvent, applyProgressEvent, initialPipelineState, PIPELINE_STAGES } from "./pipeline";

function event(stageIndex: number, status: ProgressEvent["status"], detail?: string): ProgressEvent {
  return {
    jobId: "j",
    stage: PIPELINE_STAGES[stageIndex - 1].stage,
    stageIndex,
    stageCount: 8,
    kind: "deterministic",
    status,
    label: PIPELINE_STAGES[stageIndex - 1].label,
    detail,
    progress: stageIndex / 8,
    startedAt: "",
    emittedAt: "",
  };
}

describe("pipeline reducer", () => {
  it("seeds all eight stages as pending from Ingest", () => {
    const state = initialPipelineState();
    expect(state.stages).toHaveLength(8);
    expect(state.stages[0].label).toBe("Ingest");
    expect(state.stages.every((s) => s.status === "pending")).toBe(true);
    expect(state.runStatus).toBeNull();
  });

  it("upserts a stage by stageIndex (replayed + live duplicate collapse to one)", () => {
    let state = initialPipelineState();
    state = applyProgressEvent(state, event(1, "completed", "first"));
    state = applyProgressEvent(state, event(1, "completed", "second")); // same stageIndex
    const ingest = state.stages.filter((s) => s.index === 1);
    expect(ingest).toHaveLength(1);
    expect(ingest[0].status).toBe("completed");
    expect(ingest[0].detail).toBe("second");
    expect(state.stages[1].status).toBe("pending"); // untouched
  });

  it("records the terminal run status + reason", () => {
    const state = applyDoneEvent(initialPipelineState(), "partial", "budget-exhausted");
    expect(state.runStatus).toBe("partial");
    expect(state.runStatusReason).toBe("budget-exhausted");
  });
});
