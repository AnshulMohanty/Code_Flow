import type { AnalysisResult, DependencyEdge, FileNode, ParsedFile } from "@codeflow/shared-types";

export const files: FileNode[] = [
  { id: "a", path: "src/a.ts", name: "a.ts", layer: "source", language: "TypeScript", lines: 10 },
  { id: "b", path: "src/b.ts", name: "b.ts", layer: "source", language: "TypeScript", lines: 8 },
  { id: "c", path: "src/c.ts", name: "c.ts", layer: "source", language: "TypeScript", lines: 6 },
  { id: "d", path: "src/d.ts", name: "d.ts", layer: "source", language: "TypeScript", lines: 4 },
  { id: "isolated", path: "src/isolated.ts", name: "isolated.ts", layer: "source", language: "TypeScript", lines: 2 },
];

export const dependencies: DependencyEdge[] = [
  edge("e-a-b", "a", "b", 1),
  edge("e-b-c", "b", "c", 1),
  edge("e-d-b", "d", "b", 0.8),
];

export const dagAnalysis: AnalysisResult = {
  id: "analysis-1",
  repository: { provider: "github", owner: "acme", name: "demo", branch: "main" },
  mode: "public_hosted",
  summary: {
    repository: { provider: "github", owner: "acme", name: "demo", branch: "main" },
    mode: "public_hosted",
    files: files.length,
    functions: 0,
    connections: dependencies.length,
    healthScore: 80,
    healthGrade: "B",
  },
  files,
  symbols: [],
  dependencies,
  issues: [],
  metrics: { perFile: [], keyFiles: [], hotspots: [], cycles: [], summary: { fileCount: 0, edgeCount: 0, cycleCount: 0, isolatedFileCount: 0, maxBlastRadius: 0 } },
  warnings: [],
  createdAt: "2026-05-08T00:00:00.000Z",
};

export const parsedFiles: ParsedFile[] = [
  parsed("src/a.ts", [
    {
      id: "p-a-b",
      source: "src/a.ts",
      target: "src/b.ts",
      kind: "import",
      weight: 1,
      from: "src/a.ts",
      to: "src/b.ts",
      dependencyType: "import",
      confidence: 1,
      evidence: "./b",
      sourceLine: 1,
    },
  ]),
  parsed("src/b.ts", []),
];

export function cycleAnalysis() {
  return {
    ...dagAnalysis,
    files: files.slice(0, 3),
    dependencies: [edge("e-a-b", "a", "b", 1), edge("e-b-c", "b", "c", 1), edge("e-c-a", "c", "a", 1)],
  };
}

export function longerCycleAnalysis() {
  return {
    ...dagAnalysis,
    files: files.slice(0, 4),
    dependencies: [
      edge("e-a-b", "a", "b", 1),
      edge("e-b-c", "b", "c", 1),
      edge("e-c-d", "c", "d", 1),
      edge("e-d-a", "d", "a", 1),
    ],
  };
}

export function edge(id: string, source: string, target: string, confidence: number): DependencyEdge {
  return {
    id,
    source,
    target,
    kind: "import",
    weight: 1,
    dependencyType: "import",
    confidence,
    evidence: `${source}->${target}`,
    sourceLine: 1,
  };
}

function parsed(path: string, parsedDependencies: DependencyEdge[]): ParsedFile {
  return {
    path,
    language: "typescript",
    extension: ".ts",
    loc: 10,
    imports: [],
    exports: [],
    symbols: [],
    dependencies: parsedDependencies,
    warnings: [],
    parserVersion: "parser-v1",
  };
}
