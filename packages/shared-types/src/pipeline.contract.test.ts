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

// 2) A no-op stage that owns MULTIPLE slices (Connect owns the graph plus the fileId-keyed
//    projections) — proves `owns` and the generic stay in lock-step across more than one key.
const connectFull: PipelineStage<"graph" | "entryPoints"> = {
  id: "connect",
  kind: "deterministic",
  label: "Connecting",
  owns: ["graph", "entryPoints"],
  async run(): Promise<StageResult<"graph" | "entryPoints">> {
    return {
      partial: {
        graph: {
          nodes: [
            {
              id: "apps/api/src/index.ts",
              path: "apps/api/src/index.ts",
              name: "index.ts",
              layer: "source",
              language: "TypeScript",
              lines: 12,
              symbolCount: 1,
            },
          ],
          edges: [],
          resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
        },
        entryPoints: [{ fileId: "apps/api/src/index.ts", reason: "index" }],
      },
      event: makeEvent("connect", 5, "deterministic"),
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
  const { aiSynthesis, aiRag, ...deterministic } = slices;
  const ai: AiAnalysis | undefined = aiSynthesis || aiRag ? { synthesis: aiSynthesis, rag: aiRag } : undefined;
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
    const det = await connectFull.run(
      { jobId: "job-1", repositoryRef: envelope.repository, mode: "public_hosted", analyzerVersion: "v1" },
      { repoPath: "/tmp/repo", commitSha: "abc1234", prior: {}, cache: { async get() { return null; }, async set() {} }, logger: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal },
    );
    const aiPart = await synthStub.run(
      { jobId: "job-1", repositoryRef: envelope.repository, mode: "public_hosted", analyzerVersion: "v1" },
      { repoPath: "/tmp/repo", commitSha: "abc1234", prior: det.partial, cache: { async get() { return null; }, async set() {} }, logger: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal },
    );

    // Per-key assignment — deterministic keys onto the result, ai* keys under `ai`.
    const assembled: AnalysisResult = assemble(envelope, { ...det.partial, ...aiPart.partial });

    // Both keys the multi-slice stage owns landed on the result...
    expect(connectFull.owns).toEqual(["graph", "entryPoints"]);
    expect(assembled.graph?.nodes[0].id).toBe("apps/api/src/index.ts");
    expect(assembled.entryPoints?.[0].fileId).toBe("apps/api/src/index.ts");
    // ...and the ai* key nested under `ai` instead.
    expect(assembled.ai?.synthesis?.summary).toContain("apps/api");
    expect(assembled.ai).not.toHaveProperty("projectSummary"); // removed in V3-P0
    // Untouched deterministic core stays intact and the shape is a full AnalysisResult.
    expect(assembled.summary.healthScore).toBeNull();
  });
});
