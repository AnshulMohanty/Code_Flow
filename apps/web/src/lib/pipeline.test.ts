import type { ProgressEvent } from "@codeflow/shared-types";
import { describe, expect, it } from "vitest";
import { applyDoneEvent, applyProgressEvent, initialPipelineState, PIPELINE_STAGES, SKIPPED_NO_AI_DETAIL } from "./pipeline";

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

  it("settles never-configured stages as 'skipped' instead of leaving them pending", () => {
    const state = applyDoneEvent(initialPipelineState(), "completed", undefined, ["synthesize", "rag"]);

    const synthesize = state.stages.find((s) => s.stage === "synthesize")!;
    const rag = state.stages.find((s) => s.stage === "rag")!;
    expect(synthesize.status).toBe("skipped");
    expect(rag.status).toBe("skipped");
    expect(synthesize.detail).toBe(SKIPPED_NO_AI_DETAIL);
    expect(state.skippedStages).toEqual(["synthesize", "rag"]);
    // No stage is left pending behind a finished run.
    expect(state.stages.some((s) => s.status === "pending")).toBe(true); // stages 1-6 never reported here
    expect(state.stages.filter((s) => s.status === "pending").map((s) => s.stage)).not.toContain("rag");
  });

  it("never overwrites a stage that actually reported", () => {
    let state = initialPipelineState();
    state = applyProgressEvent(state, event(7, "completed", "wrote the guide"));
    state = applyDoneEvent(state, "completed", undefined, ["synthesize", "rag"]);

    const synthesize = state.stages.find((s) => s.stage === "synthesize")!;
    expect(synthesize.status).toBe("completed");
    expect(synthesize.detail).toBe("wrote the guide");
    expect(state.stages.find((s) => s.stage === "rag")!.status).toBe("skipped");
  });

  it("is a no-op when nothing was skipped", () => {
    const state = applyDoneEvent(initialPipelineState(), "completed");
    expect(state.stages.every((s) => s.status === "pending")).toBe(true);
    expect(state.skippedStages).toBeUndefined();
  });
});

// ── V3-P0: honest degradation signals ────────────────────────────────────────
describe("applyDoneEvent — runMode + degradations (V3-P0)", () => {
  it("carries runMode and the typed degradation list onto the state", () => {
    const state = applyDoneEvent(initialPipelineState(), "completed", undefined, ["synthesize", "rag"], {
      runMode: "deterministic-only",
      degradations: [
        { reason: "no-chat-provider", detail: "set ANTHROPIC_API_KEY or GEMINI_API_KEY" },
        { reason: "no-embedding-provider", detail: "set VOYAGE_API_KEY or GEMINI_API_KEY" },
      ],
    });
    expect(state.runMode).toBe("deterministic-only");
    expect(state.degradations?.map((notice) => notice.reason)).toEqual([
      "no-chat-provider",
      "no-embedding-provider",
    ]);
  });

  it("omits both fields entirely when the run was not degraded (absent, not empty)", () => {
    const state = applyDoneEvent(initialPipelineState(), "completed", undefined, undefined, {
      runMode: "full",
      degradations: [],
    });
    expect(state.runMode).toBe("full");
    expect(state.degradations).toBeUndefined();
  });

  it("stays backward compatible when the caller passes no degradation argument", () => {
    const state = applyDoneEvent(initialPipelineState(), "completed", undefined, ["rag"]);
    expect(state.runMode).toBeUndefined();
    expect(state.degradations).toBeUndefined();
    expect(state.skippedStages).toEqual(["rag"]);
  });
});
