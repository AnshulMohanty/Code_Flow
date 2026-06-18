import type { AnalysisResult, FileNode, RepoDependencyEdge, RepositoryRef } from "@codeflow/shared-types";
import type { WebAnalysis } from "../types/web";

/**
 * Normalize a pipeline AnalysisResult into the shape the dashboard renders.
 *
 * IMPORTANT (#19): `result.dependencies` / `symbols` / `entryPoints` are INTENTIONALLY
 * empty post-Connect (the fileId-keyed flat projections were deferred) — not a bug. The UI
 * derives what it needs from the canonical homes: `graph.nodes` / `graph.edges` for the
 * dependency structure and `inventory` for symbols + entry points. (`graph.nodes[].id ===
 * graph.edges[].from/to === repo-relative POSIX path`, so edges already reference paths.)
 */
export function normalizeAnalysisResult(result: AnalysisResult): WebAnalysis {
  const nodes: FileNode[] = result.graph?.nodes ?? result.files ?? [];
  const edges: RepoDependencyEdge[] = result.graph?.edges ?? [];
  const symbols = result.inventory?.symbols ?? [];
  const inventoryEntryPoints = result.inventory?.entryPoints ?? [];

  const importsByFile = new Map<string, string[]>();
  for (const edge of edges) {
    const list = importsByFile.get(edge.from) ?? [];
    list.push(edge.to);
    importsByFile.set(edge.from, list);
  }

  const symbolsByFile = new Map<string, typeof symbols>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.filePath, list);
  }

  const securityFindings = result.issues
    .filter((issue) => issue.category === "security")
    .map((issue) => ({
      severity: toWebSeverity(issue.severity),
      title: issue.title,
      file: findFilePath(nodes, issue.fileId),
    }));

  const architectureRules = result.issues
    .filter((issue) => issue.category === "architecture")
    .map((issue) => ({
      name: issue.title,
      status: "warning" as const,
      description: issue.message,
    }));

  // Entry points: prefer Inventory's detected entry points; else the most central files.
  const entryPoints = inventoryEntryPoints.length
    ? [...new Set(inventoryEntryPoints.map((entry) => entry.filePath))].slice(0, 5)
    : (result.metrics?.keyFiles ?? nodes.map((node) => node.path)).slice(0, 3);

  return {
    repository: toDisplayRepository(result.repository),
    mode: result.mode,
    health: {
      grade: result.summary.healthGrade ?? "N/A",
      score: result.summary.healthScore ?? 0,
      summary: "Structural health is unscored in this build (no fabricated grade).",
    },
    risk: {
      level: result.issues.some((issue) => issue.severity === "critical" || issue.severity === "high")
        ? "high"
        : result.issues.length
          ? "medium"
          : "low",
      summary: result.warnings[0] ?? "Analysis loaded through the public repository flow.",
    },
    metrics: {
      files: result.summary.files || nodes.length,
      languages: result.summary.languages ?? deriveLanguages(nodes),
      circularDependencies: result.summary.circularDependencies ?? result.metrics?.cycles.length ?? 0,
      securityIssues: result.summary.securityIssues ?? securityFindings.length,
      architectureViolations: result.summary.architectureViolations ?? architectureRules.length,
    },
    entryPoints,
    graph: {
      nodes: nodes.length,
      edges: edges.length,
    },
    files: nodes.map((node) => {
      const fileSymbols = symbolsByFile.get(node.path) ?? [];
      return {
        id: node.id,
        path: node.path,
        summary: `${node.name} — ${node.layer} (${node.language}, ${node.lines} LOC, ${fileSymbols.length} symbols).`,
        imports: importsByFile.get(node.id) ?? [],
        exports: fileSymbols.filter((symbol) => symbol.exported).map((symbol) => symbol.name),
        functions: fileSymbols.map((symbol) => symbol.name),
        risk: result.issues.find((issue) => issue.fileId === node.id)?.message ?? "No issues recorded for this file.",
        owners: ["CodeFlow analysis"],
      };
    }),
    securityFindings,
    architectureRules: architectureRules.length
      ? architectureRules
      : [
          {
            name: "Deterministic pipeline",
            status: "pass",
            description: "Frontend consumed the current graph + inventory slices.",
          },
        ],
  };
}

function deriveLanguages(nodes: FileNode[]): string[] {
  return [...new Set(nodes.map((node) => node.language).filter((lang) => lang && lang !== "Unknown"))];
}

function toDisplayRepository(repository: RepositoryRef): RepositoryRef {
  return {
    ...repository,
    name: repository.owner ? `${repository.owner}/${repository.name}` : repository.name,
  };
}

function findFilePath(nodes: FileNode[], fileId?: string) {
  return nodes.find((node) => node.id === fileId)?.path ?? "Repository-level finding";
}

function toWebSeverity(severity: "low" | "medium" | "high" | "critical"): "low" | "medium" | "high" {
  return severity === "critical" ? "high" : severity;
}
