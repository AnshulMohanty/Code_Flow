import type { AnalysisResult, ProgressEvent } from "@codeflow/shared-types";
import { normalizeAnalysisResult } from "./analysisNormalizer";
import { applyDoneEvent, applyProgressEvent, initialPipelineState, type PipelineState } from "./pipeline";
import type { WebAnalysis } from "../types/web";

// Faithful mock matching the CURRENT AnalysisResult + ProgressEvent shapes (P15). Lets the
// frontend + component tests run against a realistic payload — including a PARTIAL run whose
// RAG stage was skipped by the daily-budget guard (runStatusReason "budget-exhausted").

const REPO = { provider: "github" as const, owner: "octocat", name: "hello-world" };

function node(id: string, layer: string, language: string, lines: number, symbolCount: number) {
  return { id, path: id, name: id.split("/").pop()!, layer, language, lines, symbolCount };
}

/** A current-shape AnalysisResult (graph + inventory + metrics + ai.synthesis; partial run). */
export function mockAnalysisResult(repoInput = "octocat/hello-world"): AnalysisResult {
  const [owner, name] = normalizeRepoName(repoInput).split("/");
  const repository = { ...REPO, owner: owner || REPO.owner, name: name || REPO.name };
  const nodes = [
    node("src/index.ts", "source", "TypeScript", 40, 3),
    node("src/auth.ts", "source", "TypeScript", 64, 4),
    node("src/db.ts", "source", "TypeScript", 52, 2),
    node("README.md", "docs", "Markdown", 30, 0),
  ];

  return {
    id: "mock-analysis",
    repository,
    mode: "public_hosted",
    createdAt: "2026-06-10T00:00:00.000Z",
    commitSha: "mocksha0000000000000000000000000000abcd",
    warnings: ["Q&A indexing skipped: daily AI budget reached (demo at capacity)."],
    producedBy: ["ingest", "orient", "map-structure", "inventory", "connect", "analyze", "synthesize"],
    summary: {
      repository,
      mode: "public_hosted",
      files: nodes.length,
      functions: 9,
      connections: 2,
      healthScore: null,
      healthGrade: null,
      languages: ["TypeScript", "Markdown"],
      circularDependencies: 0,
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [
        { fileId: "src/index.ts", centrality: 2, fanIn: 0, fanOut: 2, blastRadius: 0, complexity: 45 },
        { fileId: "src/auth.ts", centrality: 1, fanIn: 1, fanOut: 0, blastRadius: 1, complexity: 69 },
        { fileId: "src/db.ts", centrality: 1, fanIn: 1, fanOut: 0, blastRadius: 1, complexity: 55 },
      ],
      keyFiles: ["src/index.ts", "src/auth.ts", "src/db.ts"],
      hotspots: ["src/auth.ts", "src/db.ts", "src/index.ts"],
      cycles: [],
      summary: { fileCount: 4, edgeCount: 2, cycleCount: 0, isolatedFileCount: 1, maxBlastRadius: 1 },
    },
    graph: {
      nodes,
      edges: [
        { from: "src/index.ts", to: "src/auth.ts", kind: "import", specifier: "./auth" },
        { from: "src/index.ts", to: "src/db.ts", kind: "import", specifier: "./db" },
      ],
      resolution: { resolved: 2, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
    },
    orientation: {
      languages: ["TypeScript"],
      frameworks: [],
      projectType: "application",
      manifests: [{ path: "package.json", ecosystem: "npm" }],
      readme: { path: "README.md", text: "# hello-world\n\nA tiny sample app." },
    },
    structure: {
      layout: "src-rooted",
      fileCount: 4,
      files: [
        { path: "src/index.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 600 },
        { path: "src/auth.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 900 },
        { path: "src/db.ts", ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 700 },
        { path: "README.md", ext: ".md", role: "docs", language: "Markdown", sizeBytes: 300 },
      ],
    },
    inventory: {
      symbols: [
        { name: "main", kind: "function", filePath: "src/index.ts", line: 5, endLine: 20, exported: true, language: "TypeScript" },
        { name: "boot", kind: "function", filePath: "src/index.ts", line: 22, endLine: 38, exported: false, language: "TypeScript" },
        { name: "AuthService", kind: "class", filePath: "src/auth.ts", line: 3, endLine: 60, exported: true, language: "TypeScript" },
        { name: "verifyToken", kind: "function", filePath: "src/auth.ts", line: 8, endLine: 24, exported: true, language: "TypeScript" },
        { name: "connectDb", kind: "function", filePath: "src/db.ts", line: 4, endLine: 30, exported: true, language: "TypeScript" },
      ],
      entryPoints: [{ filePath: "src/index.ts", kind: "index", evidence: "filename-convention" }],
      symbolCount: 5,
      loc: { "src/index.ts": 40, "src/auth.ts": 64, "src/db.ts": 52 },
    },
    ai: {
      synthesis: {
        summary: "A small TypeScript app. Start at src/index.ts (the entry point), then read src/auth.ts.",
        readingOrder: [
          { fileId: "src/index.ts", order: 1, reason: "Entry point — wires the app together." },
          { fileId: "src/auth.ts", order: 2, reason: "Most depended-on module; core auth logic." },
        ],
        keyConcepts: ["authentication", "data access"],
      },
    },
    pipeline: {
      status: "partial",
      statusReason: "budget-exhausted",
      startedAt: "2026-06-10T00:00:00.000Z",
      completedAt: "2026-06-10T00:00:03.200Z",
      stages: [],
    },
  };
}

function ev(
  partial: Pick<ProgressEvent, "stage" | "stageIndex" | "kind" | "status" | "label"> &
    Partial<Pick<ProgressEvent, "detail" | "preview" | "durationMs">>,
): ProgressEvent {
  return {
    jobId: "mock-job",
    stageCount: 8,
    progress: partial.stageIndex / 8,
    startedAt: "2026-06-10T00:00:00.000Z",
    emittedAt: "2026-06-10T00:00:00.000Z",
    ...partial,
  };
}

/** An 8-stage ProgressEvent sequence for a PARTIAL run (RAG skipped by the budget guard). */
export function mockProgressEvents(): ProgressEvent[] {
  return [
    ev({ stage: "ingest", stageIndex: 1, kind: "deterministic", status: "completed", label: "Ingest", detail: "Cloned & resolved commit mocksha00000.", preview: { commitSha: "mocksha00000" }, durationMs: 420 }),
    ev({ stage: "orient", stageIndex: 2, kind: "deterministic", status: "completed", label: "Orient", detail: "Detected TypeScript (npm); read README.", preview: { languages: "TypeScript", manifests: 1 }, durationMs: 110 }),
    ev({ stage: "map-structure", stageIndex: 3, kind: "deterministic", status: "completed", label: "Map structure", detail: "Classified 4 files (src-rooted).", preview: { fileCount: 4, layout: "src-rooted" }, durationMs: 90 }),
    ev({ stage: "inventory", stageIndex: 4, kind: "deterministic", status: "completed", label: "Inventory", detail: "Parsed 3 files → 5 symbols, 1 entry point.", preview: { filesParsed: 3, symbolCount: 5, entryPoints: 1 }, durationMs: 180 }),
    ev({ stage: "connect", stageIndex: 5, kind: "deterministic", status: "completed", label: "Connect", detail: "Built dependency graph: 4 nodes, 2 edges.", preview: { nodes: 4, edges: 2, external: 0 }, durationMs: 130 }),
    ev({ stage: "analyze", stageIndex: 6, kind: "deterministic", status: "completed", label: "Analyze", detail: "Computed metrics: 3 key files, 0 cycles.", preview: { keyFiles: 3, cycles: 0, maxBlastRadius: 1 }, durationMs: 75 }),
    ev({ stage: "synthesize", stageIndex: 7, kind: "ai", status: "completed", label: "Synthesize", detail: "Onboarding guide: 2 reading steps.", preview: { readingSteps: 2, cached: false }, durationMs: 1860 }),
    ev({ stage: "rag", stageIndex: 8, kind: "ai", status: "failed", label: "Index for Q&A", detail: "Skipped: daily AI budget reached.", durationMs: 5 }),
  ];
}

/** Derived PipelineState for the panel (partial run + budget-exhausted reason). */
export function mockPipelineState(): PipelineState {
  let state = initialPipelineState(8);
  for (const event of mockProgressEvents()) state = applyProgressEvent(state, event);
  return applyDoneEvent(state, "partial", "budget-exhausted");
}

/** Back-compat: the dashboard's "Use Mock Data Instead" path consumes a WebAnalysis. */
export function createMockAnalysis(repoInput = "octocat/hello-world"): WebAnalysis {
  return normalizeAnalysisResult(mockAnalysisResult(repoInput));
}

/** A synthetic result with `n` source files — for the render-cap (show-all) test. */
export function mockBigResult(n: number): AnalysisResult {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `src/f${i}.ts`,
    path: `src/f${i}.ts`,
    name: `f${i}.ts`,
    layer: "source",
    language: "TypeScript",
    lines: 10,
    symbolCount: 1,
  }));
  return {
    id: "big",
    repository: { provider: "github", owner: "octo", name: "big" },
    mode: "public_hosted",
    createdAt: "2026-06-10T00:00:00.000Z",
    warnings: [],
    summary: { repository: { provider: "github", owner: "octo", name: "big" }, mode: "public_hosted", files: n, functions: 0, connections: 0, healthScore: null, healthGrade: null },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: n, edgeCount: 0, cycleCount: 0, isolatedFileCount: n, maxBlastRadius: 0 } },
    graph: { nodes, edges: [], resolution: { resolved: 0, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] } },
    structure: { layout: "flat", fileCount: n, files: nodes.map((node) => ({ path: node.path, ext: ".ts", role: "source", language: "TypeScript", sizeBytes: 10 })) },
    inventory: { symbols: [], entryPoints: [], symbolCount: 0, loc: {} },
  };
}

function normalizeRepoName(value: string) {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return trimmed || "octocat/hello-world";
}
