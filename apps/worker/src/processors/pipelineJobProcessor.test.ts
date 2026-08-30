import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisJobPayload,
  AnalysisResult,
  PipelineRunStatus,
  ProgressEvent,
  ProgressMessage,
} from "@codeflow/shared-types";
import type { RepoCloner } from "@codeflow/analyzers";
import type { TraceReport } from "@codeflow/observability";
import { runAnalysisJob } from "./pipelineJobProcessor.js";
import type { SavedWorkerAnalysis, WorkerAnalysisService, WorkerJobPatch } from "../services/workerAnalysisService.js";

const RESOLVED_SHA = "abcdef1234567890abcdef1234567890abcdef12";

const payload: AnalysisJobPayload = {
  jobId: "job-1",
  mode: "public_hosted",
  repositoryRef: { provider: "github", owner: "facebook", name: "react", branch: "main" },
  commitSha: "requested",
  analyzerVersion: "v1",
};

function fakeCloner(overrides: Partial<RepoCloner> = {}): RepoCloner {
  return { clone: vi.fn(async () => ({ repoPath: "/tmp/clone", commitSha: RESOLVED_SHA })), ...overrides };
}

function fakeService(cached: SavedWorkerAnalysis | null) {
  const updates: WorkerJobPatch[] = [];
  const service: WorkerAnalysisService = {
    updateJob: vi.fn(async (_id: string, patch: WorkerJobPatch) => {
      updates.push(patch);
    }),
    findCachedAnalysis: vi.fn(async () => cached),
    saveAnalysis: vi.fn(async ({ result }) => ({ analysisId: "saved-1", result: { ...result, id: "saved-1" } })),
  };
  return { service, updates };
}

// In-memory progress channel (publisher + subscriber) — stands in for the BullMQ
// transport. Subscribe-before-run, so live delivery is enough.
function createChannel() {
  const handlers = new Map<string, Array<(m: ProgressMessage) => void>>();
  const emit = (m: ProgressMessage) => (handlers.get(m.jobId) ?? []).forEach((h) => h(m));
  return {
    publishProgress(jobId: string, event: ProgressEvent) {
      emit({ kind: "progress", jobId, event });
    },
    publishDone(jobId: string, status: PipelineRunStatus) {
      emit({ kind: "done", jobId, status });
    },
    subscribe(jobId: string, handler: (m: ProgressMessage) => void) {
      const list = handlers.get(jobId) ?? [];
      list.push(handler);
      handlers.set(jobId, list);
      return () => {};
    },
  };
}

describe("runAnalysisJob", () => {
  it("cache miss: runs the orchestrator, persists the result, streams events + done", async () => {
    const { service, updates } = fakeService(null);
    const channel = createChannel();
    const received: ProgressMessage[] = [];
    channel.subscribe(payload.jobId, (m) => received.push(m));

    const outcome = await runAnalysisJob(payload, {
      service,
      cloner: fakeCloner(),
      publisher: channel,
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
    });

    // orchestrator ran Ingest and resolved the real SHA
    expect(outcome.status).toBe("completed");
    expect(outcome.cached).toBe(false);
    expect(outcome.analysisId).toBe("saved-1");

    // persisted on miss, keyed on the resolved SHA
    expect(service.saveAnalysis).toHaveBeenCalledTimes(1);
    expect(service.saveAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: RESOLVED_SHA, result: expect.objectContaining({ commitSha: RESOLVED_SHA }) }),
    );

    // run status surfaced onto the job
    const terminal = updates.at(-1);
    expect(terminal).toMatchObject({ status: "completed", runStatus: "completed", analysisId: "saved-1", cached: false });

    // events streamed: at least one ingest progress event + a terminal done(completed)
    expect(received.some((m) => m.kind === "progress" && m.event.stage === "ingest")).toBe(true);
    expect(received.at(-1)).toEqual({ kind: "done", jobId: "job-1", status: "completed" });
  });

  it("cache hit: skips save and returns the cached analysis", async () => {
    // producedBy must cover the worker's configured pipeline [ingest, orient, map-structure, inventory, connect, analyze].
    const cachedResult = { id: "cached-1", commitSha: RESOLVED_SHA, producedBy: ["ingest", "orient", "map-structure", "inventory", "connect", "analyze"] } as AnalysisResult;
    const { service, updates } = fakeService({ analysisId: "cached-1", result: cachedResult, cached: true });
    const channel = createChannel();
    const received: ProgressMessage[] = [];
    channel.subscribe(payload.jobId, (m) => received.push(m));

    const outcome = await runAnalysisJob(payload, { service, cloner: fakeCloner(), publisher: channel, readFile: noFiles, readDir: emptyDir, now: makeClock() });

    expect(outcome.cached).toBe(true);
    expect(outcome.analysisId).toBe("cached-1");
    expect(service.saveAnalysis).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ cached: true, runStatus: "completed" });
    expect(received.at(-1)).toEqual({ kind: "done", jobId: "job-1", status: "completed" });
  });

  it("no AI providers: reports the skipped stages on the job + result warnings", async () => {
    const { service, updates } = fakeService(null);
    const channel = createChannel();

    // No synthesisClient / embeddingClient — exactly the deterministic-only deployment.
    const outcome = await runAnalysisJob(payload, {
      service,
      cloner: fakeCloner(),
      publisher: channel,
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
    });

    // The run is genuinely fine — it just did not include the AI stages.
    expect(outcome.status).toBe("completed");
    expect(outcome.skippedStages).toEqual(["synthesize", "rag"]);

    // Surfaced on the job record, so REST (and therefore the UI) can settle those rows.
    expect(updates.at(-1)).toMatchObject({ runStatus: "completed", skippedStages: ["synthesize", "rag"] });

    // ...and persisted onto the result itself, so the omission survives a reload.
    const saved = vi.mocked(service.saveAnalysis).mock.calls[0][0];
    expect(saved.result.warnings).toEqual([
      expect.stringContaining('AI stage "synthesize" was skipped'),
      expect.stringContaining('AI stage "rag" was skipped'),
    ]);
    expect(saved.result.warnings.join(" ")).toContain("GEMINI_API_KEY");

    // V3-P0: the delivered SCOPE, as a machine-readable field. `runStatus: "completed"` is
    // true and useless here on its own — every stage that existed did run. `runMode` is what
    // says this was not a full analysis, and `degradations` says why, in typed form.
    expect(outcome.runMode).toBe("deterministic-only");
    expect(outcome.degradations.map((notice) => notice.reason)).toEqual([
      "no-chat-provider",
      "no-embedding-provider",
    ]);
    expect(updates.at(-1)).toMatchObject({ runMode: "deterministic-only" });
    // Persisted on the RESULT too, so it survives a reload and a later cache hit.
    expect(saved.result.runMode).toBe("deterministic-only");
    expect(saved.result.degradations?.map((notice) => notice.reason)).toEqual([
      "no-chat-provider",
      "no-embedding-provider",
    ]);
  });

  it("configured AI providers: nothing is reported as skipped", async () => {
    const { service, updates } = fakeService(null);
    const channel = createChannel();

    const outcome = await runAnalysisJob(payload, {
      service,
      cloner: fakeCloner(),
      publisher: channel,
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
      // Stage factories only need these to register; the stages themselves are unit-tested
      // elsewhere and fail softly (AI failure => "partial"), which is not what we assert here.
      synthesisClient: { provider: "anthropic", model: "test", complete: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 1, outputTokens: 1, measured: true } })) },
      embeddingClient: { provider: "voyage", model: "test", dimension: 3, embed: vi.fn(async () => ({ vectors: [[0, 0, 0]], usage: { inputTokens: 1, outputTokens: 0, measured: true } })) },
    });

    expect(outcome.skippedStages).toEqual([]);
    expect(updates.at(-1)).not.toHaveProperty("skippedStages");

    // A fully-configured run is "full" and carries no degradations (absent, not empty).
    expect(outcome.runMode).toBe("full");
    expect(outcome.degradations).toEqual([]);
    expect(updates.at(-1)).toMatchObject({ runMode: "full" });
    expect(updates.at(-1)).not.toHaveProperty("degradations");
  });

  it("fanOutSynthesis is OPT-IN: default off, and enabling it keeps stage 7 registered as `synthesize`", async () => {
    // V3-P4. Opt-in because of cost SHAPE, not doubt: a fan-out is 5N+1 provider calls where the
    // single-shot stage is 1 — right for a real onboarding guide, wrong for a demo on a free tier.
    // What must NOT change is the stage's identity: the orchestrator's coverage partition, its cache
    // lookup and its "AI failure => partial" handling all key off the id, so a different one would
    // silently take stage 7 out of that machinery.
    const chat = {
      provider: "anthropic" as const,
      model: "test",
      complete: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 1, outputTokens: 1, measured: true } })),
    };

    for (const fanOutSynthesis of [false, true]) {
      const { service } = fakeService(null);
      const outcome = await runAnalysisJob(payload, {
        service,
        cloner: fakeCloner(),
        publisher: createChannel(),
        readFile: noFiles,
        readDir: emptyDir,
        now: makeClock(),
        synthesisClient: chat,
        fanOutSynthesis,
      });
      // Either way Synthesize is REGISTERED (so it is never reported as skipped), and either way an
      // AI failure on this empty fixture degrades to "partial" rather than failing the run.
      expect(outcome.skippedStages).not.toContain("synthesize");
      expect(outcome.status).not.toBe("failed");
    }
  });

  it("produces a COMPLETE trace with per-span tokens and cost for a run (V3-P5 acceptance)", async () => {
    // The task-2 acceptance criterion, asserted on a real run rather than on a unit fixture. Spans
    // are derived from the EXISTING progress events, so a stage that forgot to instrument itself
    // cannot go missing from the trace.
    const traces: TraceReport[] = [];
    const { service } = fakeService(null);
    await runAnalysisJob(payload, {
      service,
      cloner: fakeCloner(),
      publisher: createChannel(),
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
      pricing: { "mock-model": { inputPerMillion: 1, outputPerMillion: 2 } },
      onTrace: (report) => traces.push(report),
    });

    expect(traces).toHaveLength(1);
    const trace = traces[0];
    // COMPLETE: every span was ended, including on the paths that skip stages — so its durations
    // are facts rather than lower bounds.
    expect(trace.complete).toBe(true);
    expect(trace.traceId).toBe(payload.jobId);
    // The root run span plus one span per deterministic stage.
    expect(trace.spans[0].kind).toBe("run");
    expect(trace.spans.map((span) => span.name)).toContain("stage:ingest");
    expect(trace.spans.map((span) => span.name)).toContain("stage:connect");
    // Cost is reported from real usage; with no paid calls in this fixture there is no spend, and
    // the token counts are still present rather than absent.
    expect(trace.cost.inputTokens).toBe(0);
    expect(trace.cost.measured).toBe(true);
    // And the interaction graph shows the run → stage shape.
    expect(trace.interactions.edges.every((edge) => edge.from === "run")).toBe(true);
  });

  it("finishes the trace on the FAILURE path too", async () => {
    // A tracer that only reported successful runs would be blind to exactly the runs anyone wants
    // to look at.
    const traces: TraceReport[] = [];
    const { service } = fakeService(null);
    const cloner = fakeCloner({ clone: vi.fn(async () => { throw new Error("invalid repo url"); }) });
    await runAnalysisJob(payload, {
      service,
      cloner,
      publisher: createChannel(),
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
      onTrace: (report) => traces.push(report),
    });
    expect(traces).toHaveLength(1);
    expect(traces[0].complete).toBe(true);
    expect(traces[0].spans[0].status).toBe("error");
  });

  it("an EXPORTER that throws cannot fail the run it observes", async () => {
    // An observability layer that can fail the thing it observes is worse than none, and it fails in
    // exactly the situation you most need the trace.
    const { service } = fakeService(null);
    const outcome = await runAnalysisJob(payload, {
      service,
      cloner: fakeCloner(),
      publisher: createChannel(),
      readFile: noFiles,
      readDir: emptyDir,
      now: makeClock(),
      traceExporter: {
        id: "explodes",
        async export() {
          throw new Error("collector unreachable");
        },
      },
    });
    expect(outcome.status).not.toBe("failed");
  });

  it("clone failure: run 'failed', nothing persisted, done(failed) streamed", async () => {
    const { service, updates } = fakeService(null);
    const channel = createChannel();
    const received: ProgressMessage[] = [];
    channel.subscribe(payload.jobId, (m) => received.push(m));

    const cloner = fakeCloner({ clone: vi.fn(async () => { throw new Error("invalid repo url"); }) });
    const outcome = await runAnalysisJob(payload, { service, cloner, publisher: channel, readFile: noFiles, readDir: emptyDir, now: makeClock() });

    expect(outcome.status).toBe("failed");
    expect(service.saveAnalysis).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: "failed", runStatus: "failed" });
    expect(received.at(-1)).toEqual({ kind: "done", jobId: "job-1", status: "failed" });
  });
});

// Orient reader / Map-structure walker that find nothing → empty-but-valid slices
// (those stages have their own dedicated tests; these focus on job orchestration).
const noFiles = async () => null;
const emptyDir = async () => [];

function makeClock() {
  let t = 0;
  return () => ++t;
}
