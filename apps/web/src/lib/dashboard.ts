import type { AnalysisResult, FileMetrics, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";

// The dashboard's read model. Derived ONCE from a normalized AnalysisResult per the P15 rules:
// imports from graph.edges, symbols + entry points from inventory, metrics from metrics.perFile.
// The views READ this — they never re-derive analysis. Render caps are a render-only concern; this
// model keeps the FULL lists (the views paginate/show-all over them, never truncating the data).

export interface DashboardSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface DashboardFileMetrics {
  centrality: number;
  fanIn: number;
  fanOut: number;
  blastRadius: number;
  /** STRUCTURAL PROXY (loc + symbolCount + fanIn + fanOut), NOT cyclomatic — shown as a rank. */
  complexity: number;
  /** 1-based rank by complexity across files that have metrics (1 = most complex). */
  complexityRank: number;
  /** complexity / maxComplexity, 0..1 — drives the relative bar. */
  complexityRelative: number;
}

export interface DashboardFile {
  id: string; // === repo-relative POSIX path
  path: string;
  name: string;
  role: string;
  language: string;
  loc: number;
  symbolCount: number;
  symbols: DashboardSymbol[];
  /** Out-neighbours (files this one imports), fileIds — all resolve to real nodes. */
  imports: string[];
  /** In-neighbours (files that import this one), fileIds — all resolve to real nodes. */
  importers: string[];
  metrics?: DashboardFileMetrics;
}

export interface ReadingStepView {
  fileId: string;
  order: number;
  reason: string;
}

export interface StartHere {
  /** True when AI synthesis is present; false ⇒ deterministic fallback (honest degradation). */
  available: boolean;
  summary?: string;
  /** Ranked reading path — synthesis steps, or keyFiles-as-steps on the fallback. */
  readingOrder: ReadingStepView[];
  keyConcepts?: string[];
  /** Set on a degraded run, e.g. "AI summary unavailable — demo at capacity." */
  fallbackNote?: string;
}

export interface RoleCount {
  role: string;
  count: number;
}

export interface DirectoryGroup {
  directory: string;
  files: string[]; // fileIds, sorted
}

export interface DashboardStructure {
  layout: string;
  roleCounts: RoleCount[];
  byDirectory: DirectoryGroup[];
}

export interface DashboardModel {
  repositoryName: string;
  fileCount: number;
  startHere: StartHere;
  structure: DashboardStructure;
  /** Keyed by fileId for drill-down lookup. */
  files: Record<string, DashboardFile>;
  /** Ordered by path — the full list (render caps never drop entries from this). */
  fileList: DashboardFile[];
}

export function buildDashboard(result: AnalysisResult): DashboardModel {
  const nodes: FileNode[] = result.graph?.nodes ?? result.files ?? [];
  const edges: RepoDependencyEdge[] = result.graph?.edges ?? [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  const roleByPath = new Map<string, string>((result.structure?.files ?? []).map((f) => [f.path, f.role]));
  const locByPath = result.inventory?.loc ?? {};
  const metricsById = new Map<string, FileMetrics>((result.metrics?.perFile ?? []).map((m) => [m.fileId, m]));

  const symbolsByFile = new Map<string, DashboardSymbol[]>();
  for (const symbol of result.inventory?.symbols ?? []) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    list.push({ name: symbol.name, kind: symbol.kind, line: symbol.line });
    symbolsByFile.set(symbol.filePath, list);
  }

  const importsByFile = new Map<string, Set<string>>();
  const importersByFile = new Map<string, Set<string>>();
  for (const edge of edges) {
    // Grounding: keep only edges between real nodes (no dangling links).
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    (importsByFile.get(edge.from) ?? setInMap(importsByFile, edge.from)).add(edge.to);
    (importersByFile.get(edge.to) ?? setInMap(importersByFile, edge.to)).add(edge.from);
  }

  // Complexity ranking across files that have metrics (1 = most complex).
  const ranked = [...metricsById.values()].sort((a, b) => b.complexity - a.complexity || a.fileId.localeCompare(b.fileId));
  const maxComplexity = ranked[0]?.complexity ?? 0;
  const rankById = new Map<string, number>(ranked.map((m, i) => [m.fileId, i + 1]));

  const files: Record<string, DashboardFile> = {};
  for (const node of nodes) {
    const m = metricsById.get(node.id);
    const symbols = (symbolsByFile.get(node.path) ?? []).slice().sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    files[node.id] = {
      id: node.id,
      path: node.path,
      name: node.name,
      role: roleByPath.get(node.path) ?? node.layer ?? "other",
      language: node.language,
      loc: locByPath[node.path] ?? node.lines ?? 0,
      symbolCount: node.symbolCount ?? symbols.length,
      symbols,
      imports: [...(importsByFile.get(node.id) ?? [])].sort(),
      importers: [...(importersByFile.get(node.id) ?? [])].sort(),
      metrics: m
        ? {
            centrality: m.centrality,
            fanIn: m.fanIn,
            fanOut: m.fanOut,
            blastRadius: m.blastRadius,
            complexity: m.complexity,
            complexityRank: rankById.get(node.id) ?? 0,
            complexityRelative: maxComplexity > 0 ? m.complexity / maxComplexity : 0,
          }
        : undefined,
    };
  }

  const fileList = Object.values(files).sort((a, b) => a.path.localeCompare(b.path));

  return {
    repositoryName: displayRepoName(result),
    fileCount: nodes.length,
    startHere: buildStartHere(result, nodeIds),
    structure: buildStructure(result, nodes, roleByPath),
    files,
    fileList,
  };
}

function buildStartHere(result: AnalysisResult, nodeIds: Set<string>): StartHere {
  const synthesis = result.ai?.synthesis;
  if (synthesis) {
    const readingOrder = synthesis.readingOrder
      .filter((step) => nodeIds.has(step.fileId)) // grounding: only real nodes
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => ({ fileId: step.fileId, order: step.order, reason: step.reason }));
    return {
      available: true,
      summary: synthesis.summary,
      readingOrder,
      ...(synthesis.keyConcepts ? { keyConcepts: synthesis.keyConcepts } : {}),
    };
  }

  // Degrade honestly: deterministic fallback (key files) + a clear note. Never a blank panel.
  const reason = result.pipeline?.statusReason;
  const fallbackNote =
    reason === "budget-exhausted"
      ? "AI summary unavailable — demo at capacity. Start with the most-connected files below."
      : "AI summary unavailable for this run. Start with the most-connected files below.";
  const keyFiles = (result.metrics?.keyFiles ?? []).filter((id) => nodeIds.has(id)).slice(0, 8);
  const readingOrder = keyFiles.map((fileId, i) => ({
    fileId,
    order: i + 1,
    reason: "High-centrality file — a good place to start.",
  }));
  return { available: false, readingOrder, fallbackNote };
}

function buildStructure(result: AnalysisResult, nodes: FileNode[], roleByPath: Map<string, string>): DashboardStructure {
  const layout = result.structure?.layout ?? "flat";

  const roleTally = new Map<string, number>();
  const byDir = new Map<string, string[]>();
  for (const node of nodes) {
    const role = roleByPath.get(node.path) ?? node.layer ?? "other";
    roleTally.set(role, (roleTally.get(role) ?? 0) + 1);
    const dir = dirname(node.path);
    (byDir.get(dir) ?? setListInMap(byDir, dir)).push(node.id);
  }

  const roleCounts = [...roleTally.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));

  const byDirectory = [...byDir.entries()]
    .map(([directory, files]) => ({ directory, files: files.slice().sort() }))
    .sort((a, b) => a.directory.localeCompare(b.directory));

  return { layout, roleCounts, byDirectory };
}

function displayRepoName(result: AnalysisResult): string {
  const repo = result.repository;
  return repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

function setInMap(map: Map<string, Set<string>>, key: string): Set<string> {
  const set = new Set<string>();
  map.set(key, set);
  return set;
}

function setListInMap(map: Map<string, string[]>, key: string): string[] {
  const list: string[] = [];
  map.set(key, list);
  return list;
}
