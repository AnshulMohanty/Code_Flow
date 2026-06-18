import { describe, expect, it } from "vitest";
import type {
  AiAnalysis,
  AnalysisResult,
  AnalysisResultSlices,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  StageResult,
} from "./index.js";

// This is a CONTRACT conformance test: its job is to typecheck (PLAN P1 = "contract
// first"). The runtime assertions are incidental — there is no real stage logic here.

const STAGE_COUNT = 8;

function makeEvent(stage: ProgressEvent["stage"], stageIndex: number, kind: ProgressEvent["kind"]): ProgressEvent {
  return {
    jobId: "job-1",
    stage,
    stageIndex,
    stageCount: STAGE_COUNT,
    kind,
    status: "completed",
    label: stage,
    progress: stageIndex / STAGE_COUNT,
    startedAt: "2026-05-31T00:00:00.000Z",
    durationMs: 1,
    emittedAt: "2026-05-31T00:00:00.001Z",
  };
}

// 1) A no-op DETERMINISTIC stage that owns ONE slice and satisfies PipelineStage.
const orientStub: PipelineStage<"orientation"> = {
  id: "orient",
  kind: "deterministic",
  label: "Orienting",
  owns: ["orientation"],
  async run(_input: PipelineInput, _ctx: PipelineContext): Promise<StageResult<"orientation">> {
    return {
      partial: {
        orientation: { languages: [], frameworks: [], projectType: "unknown", manifests: [], readme: null },
      },
      event: makeEvent("orient", 2, "deterministic"),
    };
  },
};

// 2) A no-op stage that owns MULTIPLE slices (Orient also emits the AI 3-liner) —
//    proves `owns` and the generic stay in lock-step across more than one key.
const orientFull: PipelineStage<"orientation" | "aiProjectSummary"> = {
  id: "orient",
  kind: "deterministic",
  label: "Orienting",
  owns: ["orientation", "aiProjectSummary"],
  async run(): Promise<StageResult<"orientation" | "aiProjectSummary">> {
    return {
      partial: {
        orientation: { languages: ["TypeScript"], frameworks: [], projectType: "monorepo", manifests: [], readme: null },
        aiProjectSummary: { text: "A TypeScript monorepo.", citations: [] },
      },
      event: makeEvent("orient", 2, "ai"),
    };
  },
};

// 3) A no-op AI stage owning the synthesis slice.
const synthStub: PipelineStage<"aiSynthesis"> = {
  id: "synthesize",
  kind: "ai",
  label: "Synthesizing",
  owns: ["aiSynthesis"],
  async run(): Promise<StageResult<"aiSynthesis">> {
    return {
      partial: { aiSynthesis: { summary: "Start in apps/api.", readingOrder: [] } },
      event: makeEvent("synthesize", 7, "ai"),
    };
  },
};

// The assembly CONTRACT, expressed minimally: deterministic slice keys are assigned
// directly onto the result; the `ai*` keys are nested under `result.ai`. This is the
// per-key assignment model described in the contract — NOT a deep merge.
type Envelope = Pick<
  AnalysisResult,
  | "id"
  | "repository"
  | "mode"
  | "createdAt"
  | "warnings"
  | "summary"
  | "files"
  | "symbols"
  | "dependencies"
  | "issues"
  | "metrics"
>;

function assemble(envelope: Envelope, slices: Partial<AnalysisResultSlices>): AnalysisResult {
  const { aiProjectSummary, aiSynthesis, aiRag, ...deterministic } = slices;
  const ai: AiAnalysis | undefined =
    aiProjectSummary || aiSynthesis || aiRag
      ? { projectSummary: aiProjectSummary, synthesis: aiSynthesis, rag: aiRag }
      : undefined;
  return { ...envelope, ...deterministic, ai };
}

const envelope: Envelope = {
  id: "analysis-1",
  repository: { provider: "github", owner: "facebook", name: "react" },
  mode: "public_hosted",
  createdAt: "2026-05-31T00:00:00.000Z",
  warnings: [],
  summary: {
    repository: { provider: "github", owner: "facebook", name: "react" },
    mode: "public_hosted",
    files: 0,
    functions: 0,
    connections: 0,
    healthScore: null,
    healthGrade: null,
  },
  files: [],
  symbols: [],
  dependencies: [],
  issues: [],
  metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 0, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
};

describe("pipeline stage contract", () => {
  it("a pre-Ingest context is valid without repoPath / commitSha (they are optional)", () => {
    // Ingest resolves these; the type must not claim they exist before Ingest runs.
    const preIngest: PipelineContext = {
      prior: {},
      cache: { async get() { return null; }, async set() {} },
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    };

    expect(preIngest.repoPath).toBeUndefined();
    expect(preIngest.commitSha).toBeUndefined();
  });

  it("a no-op stage satisfies PipelineStage and returns its owned slice", async () => {
    const result = await orientStub.run(
      { jobId: "job-1", repositoryRef: envelope.repository, mode: "public_hosted", analyzerVersion: "v1" },
      {
        repoPath: "/tmp/repo",
        commitSha: "abc1234",
        prior: {},
        cache: { async get() { return null; }, async set() {} },
        logger: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
      },
    );

    expect(orientStub.owns).toEqual(["orientation"]);
    expect(result.partial.orientation?.projectType).toBe("unknown");
    expect(result.event.kind).toBe("deterministic");
  });

  it("a couple of partials assemble into a valid AnalysisResult (det slice + AI slice)", async () => {
    const det = await orientFull.run(
      { jobId: "job-1", repositoryRef: envelope.repository, mode: "public_hosted", analyzerVersion: "v1" },
      { repoPath: "/tmp/repo", commitSha: "abc1234", prior: {}, cache: { async get() { return null; }, async set() {} }, logger: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal },
    );
    const aiPart = await synthStub.run(
      { jobId: "job-1", repositoryRef: envelope.repository, mode: "public_hosted", analyzerVersion: "v1" },
      { repoPath: "/tmp/repo", commitSha: "abc1234", prior: det.partial, cache: { async get() { return null; }, async set() {} }, logger: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal },
    );

    // Per-key assignment — deterministic keys onto the result, ai* keys under `ai`.
    const assembled: AnalysisResult = assemble(envelope, { ...det.partial, ...aiPart.partial });

    expect(assembled.orientation?.projectType).toBe("monorepo");
    expect(assembled.ai?.projectSummary?.text).toContain("TypeScript");
    expect(assembled.ai?.synthesis?.summary).toContain("apps/api");
    // Untouched deterministic core stays intact and the shape is a full AnalysisResult.
    expect(assembled.summary.healthScore).toBeNull();
  });
});
