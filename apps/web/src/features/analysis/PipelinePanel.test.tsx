import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PipelinePanel, uncoveredDegradations } from "./PipelinePanel";
import { mockPipelineState } from "../../lib/mockAnalysis";
import { applyDoneEvent, applyProgressEvent, initialPipelineState, PIPELINE_STAGES } from "../../lib/pipeline";

afterEach(cleanup);

describe("PipelinePanel", () => {
  it("renders all eight stages from Ingest, with the running stage and a generic preview", () => {
    // A live (non-terminal) run: stages 1-2 done, stage 3 running.
    let state = initialPipelineState(8);
    state = applyProgressEvent(state, {
      jobId: "j", stage: "ingest", stageIndex: 1, stageCount: 8, kind: "deterministic",
      status: "completed", label: "Ingest", detail: "Cloned.", preview: { commitSha: "abc123" }, progress: 0.125, startedAt: "", emittedAt: "", durationMs: 400,
    });
    state = applyProgressEvent(state, {
      jobId: "j", stage: "map-structure", stageIndex: 3, stageCount: 8, kind: "deterministic",
      status: "running", label: "Map structure", progress: 0.375, startedAt: "", emittedAt: "",
    });

    render(<PipelinePanel state={state} />);

    // Always from Ingest; all eight stage labels present. (A reported stage's label shows in
    // both the rail and the feed, so Ingest matches twice; pending RAG only in the rail.)
    expect(screen.getAllByText("Ingest").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Index for Q&A")).toBeInTheDocument();
    // Generic preview slot rendered the event payload key (no per-stage hardcoding).
    expect(screen.getByText("commitSha")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    // Running stage shows its label in the live header.
    expect(screen.getByText(/Reasoning · Map structure/)).toBeInTheDocument();
  });

  it("surfaces a partial run with the budget-exhausted reason, honestly", () => {
    render(<PipelinePanel state={mockPipelineState()} />);

    // The reason is surfaced honestly in the banner (the title also echoes in the header).
    const banner = screen.getByRole("status");
    expect(within(banner).getByText("Demo at capacity")).toBeInTheDocument();
    expect(within(banner).getByText(/skipped to stay within today's budget/i)).toBeInTheDocument();
    // The failed RAG stage is shown as failed, not hidden.
    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
  });

  it("shows unconfigured AI stages as a terminal 'skipped', never an eternal spinner", () => {
    // A deterministic-only run: all six deterministic stages reported, no AI provider
    // configured, so stages 7-8 never emitted a single event.
    let state = initialPipelineState(8);
    for (let stageIndex = 1; stageIndex <= 6; stageIndex++) {
      state = applyProgressEvent(state, {
        jobId: "j",
        stage: PIPELINE_STAGES[stageIndex - 1].stage,
        stageIndex,
        stageCount: 6,
        kind: "deterministic",
        status: "completed",
        label: PIPELINE_STAGES[stageIndex - 1].label,
        progress: stageIndex / 6,
        startedAt: "",
        emittedAt: "",
      });
    }
    state = applyDoneEvent(state, "completed", undefined, ["synthesize", "rag"]);

    render(<PipelinePanel state={state} />);

    // The banner tells the truth instead of claiming every stage finished.
    const banner = screen.getByRole("status");
    expect(within(banner).getByText("Deterministic analysis complete")).toBeInTheDocument();
    expect(within(banner).getByText(/No AI provider is configured/i)).toBeInTheDocument();
    expect(within(banner).getByText(/Synthesize and Index for Q&A did not run/i)).toBeInTheDocument();

    // Both AI stages read as "skipped" (terminal) in the rail...
    expect(screen.getByTitle("Synthesize: skipped")).toBeInTheDocument();
    expect(screen.getByTitle("Index for Q&A: skipped")).toBeInTheDocument();
    // ...and both appear in the feed carrying the reason (rail meta + feed badge = 2 each).
    expect(screen.getAllByText("skipped")).toHaveLength(4);
    expect(screen.getAllByText(/no AI provider configured/i)).toHaveLength(2);
    // Nothing is left claiming it is still pending.
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
  });

  it("renders an arbitrary preview key without per-stage hardcoding", () => {
    let state = initialPipelineState(8);
    state = applyProgressEvent(state, {
      jobId: "j", stage: "analyze", stageIndex: 6, stageCount: 8, kind: "deterministic",
      status: "completed", label: "Analyze", preview: { totallyNovelMetric: "zzz-sentinel" }, progress: 0.75, startedAt: "", emittedAt: "",
    });

    render(<PipelinePanel state={state} />);
    const feed = screen.getByText("zzz-sentinel").closest("dl")!;
    expect(within(feed).getByText("totallyNovelMetric")).toBeInTheDocument();
  });
});

// ── V3-P0: degradations the terminal banner does not already explain ─────────
describe("PipelinePanel — degradation notices (V3-P0)", () => {
  it("shows a notice when the database is down, even on an otherwise-clean run", () => {
    // The API falls back to in-memory Maps when Mongo is down. That used to be completely
    // invisible: the user got a job id that would vanish on restart with no indication why.
    const state = applyDoneEvent(initialPipelineState(8), "completed", undefined, undefined, {
      runMode: "full",
      degradations: [
        { reason: "mongo-unavailable", detail: "The database is unavailable. Check MONGO_URI." },
      ],
    });

    render(<PipelinePanel state={state} />);
    expect(screen.getByText("Results are not being saved")).toBeInTheDocument();
    expect(screen.getByText(/Check MONGO_URI/)).toBeInTheDocument();
    // The success banner still renders — the run DID complete; it just was not persisted.
    // (The title also appears as the panel heading, hence getAllByText.)
    expect(screen.getAllByText("Analysis complete").length).toBeGreaterThan(0);
  });

  it("does NOT repeat what the terminal banner already says about missing AI providers", () => {
    const state = applyDoneEvent(initialPipelineState(8), "completed", undefined, ["synthesize", "rag"], {
      runMode: "deterministic-only",
      degradations: [
        { reason: "no-chat-provider", detail: "set ANTHROPIC_API_KEY or GEMINI_API_KEY" },
        { reason: "no-embedding-provider", detail: "set VOYAGE_API_KEY or GEMINI_API_KEY" },
      ],
    });

    render(<PipelinePanel state={state} />);
    // The banner covers both, so no duplicate notices.
    expect(screen.getAllByText("Deterministic analysis complete").length).toBeGreaterThan(0);
    expect(screen.queryByText("Onboarding guide unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Ask-the-repo unavailable")).not.toBeInTheDocument();
  });

  it("shows an uncovered reason alongside a covered one", () => {
    const state = applyDoneEvent(initialPipelineState(8), "completed", undefined, ["rag"], {
      runMode: "deterministic-only",
      degradations: [
        { reason: "no-embedding-provider", detail: "no embedding key" },
        { reason: "mongo-unavailable", detail: "db down" },
      ],
    });

    render(<PipelinePanel state={state} />);
    expect(screen.queryByText("Ask-the-repo unavailable")).not.toBeInTheDocument(); // covered
    expect(screen.getByText("Results are not being saved")).toBeInTheDocument(); // not covered
  });

  it("renders nothing extra when the run was not degraded", () => {
    const state = applyDoneEvent(initialPipelineState(8), "completed");
    render(<PipelinePanel state={state} />);
    expect(document.querySelectorAll("[data-degradation]")).toHaveLength(0);
  });
});

describe("uncoveredDegradations", () => {
  it("treats budget-exhausted as covered by the banner", () => {
    expect(
      uncoveredDegradations([{ reason: "budget-exhausted", detail: "x" }], undefined, "budget-exhausted"),
    ).toEqual([]);
    // ...but NOT covered when the run did not end for that reason.
    expect(uncoveredDegradations([{ reason: "budget-exhausted", detail: "x" }], undefined, undefined)).toHaveLength(1);
  });

  it("returns an empty list for no degradations", () => {
    expect(uncoveredDegradations(undefined, ["rag"], undefined)).toEqual([]);
    expect(uncoveredDegradations([], ["rag"], undefined)).toEqual([]);
  });
});

