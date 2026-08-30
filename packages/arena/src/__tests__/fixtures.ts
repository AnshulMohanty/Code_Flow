import type { AnalysisResult, CpgEdge, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";

/**
 * A frozen fixture repository for the Arena tests. Hermetic: plain data, no clone, no cache.
 *
 * Shape (imports as `->`, calls as `~>`):
 *   index.ts  -> service.ts  ~> service.ts (3 calls)
 *   service.ts -> repo.ts    ~> repo.ts (5 calls), extends Base in base.ts
 *   repo.ts   -> util.ts
 *   cycle-a.ts <-> cycle-b.ts   (a dependency cycle)
 *   orphan.ts (isolated)
 */
export const FILE_IDS = [
  "src/index.ts",
  "src/service.ts",
  "src/repo.ts",
  "src/util.ts",
  "src/base.ts",
  "src/cycle-a.ts",
  "src/cycle-b.ts",
  "src/orphan.ts",
] as const;

function node(id: string, lines: number): FileNode {
  return {
    id,
    path: id,
    name: id.split("/").pop()!,
    layer: "source",
    language: "TypeScript",
    lines,
    symbolCount: 2,
  };
}

function edge(from: string, to: string): RepoDependencyEdge {
  return { from, to, kind: "import", specifier: `./${to.split("/").pop()!.replace(/\.ts$/, "")}` };
}

function call(from: string, to: string, count: number, symbol: string): CpgEdge {
  return { from, to, kind: "call", symbol, count, line: 3 };
}

/** Real per-file LOC, so the line-range verifier has something honest to check against. */
export const LOC: Record<string, number> = {
  "src/index.ts": 20,
  "src/service.ts": 60,
  "src/repo.ts": 40,
  "src/util.ts": 15,
  "src/base.ts": 25,
  "src/cycle-a.ts": 10,
  "src/cycle-b.ts": 10,
  "src/orphan.ts": 5,
};

export function fixtureResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const nodes = FILE_IDS.map((id) => node(id, LOC[id]));
  const edges: RepoDependencyEdge[] = [
    edge("src/index.ts", "src/service.ts"),
    edge("src/service.ts", "src/repo.ts"),
    edge("src/service.ts", "src/base.ts"),
    edge("src/repo.ts", "src/util.ts"),
    edge("src/cycle-a.ts", "src/cycle-b.ts"),
    edge("src/cycle-b.ts", "src/cycle-a.ts"),
  ];
  const cpgEdges: CpgEdge[] = [
    call("src/index.ts", "src/service.ts", 3, "runService"),
    call("src/service.ts", "src/repo.ts", 5, "findAll"),
    { from: "src/service.ts", to: "src/base.ts", kind: "extends", symbol: "Base", count: 1, line: 4 },
  ];

  return {
    id: "analysis-fixture",
    repository: { provider: "github", owner: "acme", name: "fixture" },
    mode: "public_hosted",
    createdAt: "2026-08-30T00:00:00.000Z",
    commitSha: "a".repeat(40),
    warnings: [],
    summary: {
      repository: { provider: "github", owner: "acme", name: "fixture" },
      mode: "public_hosted",
      files: nodes.length,
      functions: 8,
      connections: edges.length,
      healthScore: 80,
      healthGrade: "B",
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    metrics: {
      perFile: [],
      keyFiles: [],
      hotspots: [],
      cycles: [{ files: ["src/cycle-a.ts", "src/cycle-b.ts"] }],
      summary: { fileCount: nodes.length, edgeCount: edges.length, cycleCount: 1, isolatedFileCount: 1, maxBlastRadius: 3 },
    },
    graph: {
      nodes,
      edges,
      resolution: { resolved: edges.length, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      cpgEdges,
      routes: [],
      cpg: { treeSitterFiles: nodes.length, fallbackFiles: 0, enriched: true },
    },
    inventory: {
      symbols: [],
      entryPoints: [{ filePath: "src/index.ts", kind: "index", evidence: "filename-convention" }],
      symbolCount: 0,
      loc: LOC,
    },
    entryPoints: [{ fileId: "src/index.ts", reason: "index" }],
    ...overrides,
  };
}
