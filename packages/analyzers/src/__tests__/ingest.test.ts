import { describe, expect, it, vi } from "vitest";
import type {
  AnalysisResult,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
} from "@codeflow/shared-types";
import { runPipeline, type CachedAnalysisLookup } from "../pipeline/orchestrator.js";
import { createIngestStage, type RepoCloner } from "../stages/ingest.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "facebook", name: "react", branch: "main" },
  mode: "public_hosted",
  analyzerVersion: "v1",
  requestedCommitSha: "deadbeef",
};

const RESOLVED_SHA = "abcdef1234567890abcdef1234567890abcdef12";

function fakeCloner(overrides: Partial<RepoCloner> = {}): RepoCloner {
  return {
    clone: vi.fn(async () => ({ repoPath: "/tmp/clone", commitSha: RESOLVED_SHA })),
    ...overrides,
  };
}

function cacheReturning(result: AnalysisResult | null): CachedAnalysisLookup {
  return { findCached: vi.fn(async () => result) };
}

function ctx(): PipelineContext {
  return {
    prior: {},
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

// A downstream stage that captures the ctx Ingest populated.
function captureStage(seen: { repoPath?: string; commitSha?: string }): PipelineStage {
  return {
    id: "map-structure",
    kind: "deterministic",
    label: "Map",
    owns: ["files"],
    async run(_input, c) {
      seen.repoPath = c.repoPath;
      seen.commitSha = c.commitSha;
      return {
        partial: { files: [] },
        event: {
          jobId: "job-1",
          stage: "map-structure",
          stageIndex: 0,
          stageCount: 0,
          kind: "deterministic",
          status: "completed",
          label: "Map",
          progress: 0,
          startedAt: "",
          emittedAt: "",
        } satisfies ProgressEvent,
      };
    },
  };
}

function makeClock() {
  let t = 0;
  return () => ++t;
}

describe("ingest stage (pure: clone + resolve SHA, no cache)", () => {
  it("clones, resolves the real commit SHA, and writes repoPath/commitSha into ctx", async () => {
    const cloner = fakeCloner();
    const stage = createIngestStage({ cloner, now: () => 1000 });
    const c = ctx();

    const out = await stage.run(input, c);

    expect(cloner.clone).toHaveBeenCalledWith({
      repositoryRef: input.repositoryRef,
      requestedCommitSha: "deadbeef",
    });
    expect(c.repoPath).toBe("/tmp/clone");
    expect(c.commitSha).toBe(RESOLVED_SHA);
    expect(stage.owns).toEqual([]); // owns no result slice
    expect(out.partial).toEqual({}); // bootstraps ctx only
    expect(out.event.preview).toMatchObject({ commitSha: RESOLVED_SHA });
  });
});

describe("ingest wired through the orchestrator", () => {
  it("cache miss: downstream stages see the resolved repoPath/commitSha", async () => {
    const seen: { repoPath?: string; commitSha?: string } = {};
    const ingest = createIngestStage({ cloner: fakeCloner(), now: makeClock() });

    const { result, cached } = await runPipeline([ingest, captureStage(seen)], input, {
      now: makeClock(),
      cacheLookup: cacheReturning(null),
    });

    expect(cached).toBe(false);
    expect(seen.repoPath).toBe("/tmp/clone");
    expect(seen.commitSha).toBe(RESOLVED_SHA);
    expect(result.commitSha).toBe(RESOLVED_SHA);
    expect(result.pipeline?.status).toBe("completed");
    expect(result.pipeline?.stages.map((s) => s.stage)).toEqual(["ingest", "map-structure"]);
  });

  it("cache full hit: orchestrator short-circuits PRE-ingest (no clone), keyed on requestedCommitSha", async () => {
    // producedBy covers the configured [ingest, map-structure] (both deterministic) → full hit.
    const cached = { id: "cached-1", commitSha: RESOLVED_SHA, producedBy: ["ingest", "map-structure"] } as AnalysisResult;
    const seen: { repoPath?: string; commitSha?: string } = {};
    const downstream = captureStage(seen);
    const runSpy = vi.spyOn(downstream, "run");
    const cacheLookup = cacheReturning(cached);
    const cloner = fakeCloner();
    const ingest = createIngestStage({ cloner, now: makeClock() });

    const { result, cached: wasCached } = await runPipeline([ingest, downstream], input, {
      now: makeClock(),
      cacheLookup,
    });

    expect(wasCached).toBe(true);
    expect(result).toBe(cached);
    expect(runSpy).not.toHaveBeenCalled();
    expect(cloner.clone).not.toHaveBeenCalled(); // wallet win: no clone on a full hit
    // decided BEFORE Ingest, keyed on the caller-known SHA (requestedCommitSha).
    expect(cacheLookup.findCached).toHaveBeenCalledWith({
      repositoryRef: input.repositoryRef,
      commitSha: "deadbeef",
      analyzerVersion: "v1",
    });
  });

  it("clone failure: deterministic ingest fails → run 'failed'", async () => {
    const cloner = fakeCloner({ clone: vi.fn(async () => { throw new Error("invalid repo url"); }) });
    const ingest = createIngestStage({ cloner, now: makeClock() });

    const { result } = await runPipeline([ingest], input, { now: makeClock(), cacheLookup: cacheReturning(null) });

    expect(result.pipeline?.status).toBe("failed");
    expect(result.pipeline?.stages[0]).toMatchObject({ stage: "ingest", status: "failed" });
    expect(result.warnings.some((w) => w.includes("ingest") && w.includes("invalid repo url"))).toBe(true);
  });
});
