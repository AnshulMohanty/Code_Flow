// CodeFlow is public-hosted only (see PLAN §2). The private/local mode was removed in the
// cleanup pass. The field is retained (single-valued) because it flows through job payloads,
// Mongo documents, and the AnalysisResult contract.
export type AnalysisMode = "public_hosted";

export type JobStatus =
  | "queued"
  | "cloning"
  | "parsing"
  | "analyzing"
  | "completed"
  | "failed";

export interface JobProgress {
  id?: string;
  jobId: string;
  status: JobStatus;
  progress?: number;
  message?: string;
  percent?: number;
  currentStep?: string;
  parsedFiles?: number;
  totalFiles?: number;
  analysisId?: string;
  cached?: boolean;
  error?: string;
  /** Pipeline run outcome (completed/partial/failed/aborted), surfaced by the worker. */
  runStatus?: PipelineRunStatus;
  /** Distinct, typed reason for a non-clean outcome (e.g. repo-too-large, budget-exhausted)
   *  so the UI can say "at capacity" / "too large" rather than a generic failure. */
  runStatusReason?: PipelineStatusReason;
  /**
   * Stages that were NOT part of this run and produced no output — today, the AI stages
   * that never registered because their provider key is absent. Without this the UI has no
   * way to tell "still working" from "never going to run" and leaves those rows spinning
   * forever. An empty/absent list means every configured stage reported.
   */
  skippedStages?: PipelineStageId[];
  createdAt?: string;
  updatedAt: string;
}

export interface RepositoryRef {
  provider: "github" | "local" | "zip";
  owner?: string;
  name: string;
  repo?: string;
  branch?: string;
  url?: string;
}

export interface AnalysisJobPayload {
  jobId: string;
  mode: AnalysisMode;
  repositoryRef: RepositoryRef;
  commitSha: string;
  analyzerVersion: string;
}

export interface AnalysisSummary {
  repository: RepositoryRef;
  mode: AnalysisMode;
  files: number;
  functions: number;
  connections: number;
  healthScore: number | null;
  healthGrade: string | null;
  languages?: string[];
  securityIssues?: number;
  architectureViolations?: number;
  circularDependencies?: number;
}

export interface FileNode {
  /** Connect sets this to the repo-relative POSIX path (fileId === path; no opaque ids). */
  id: string;
  path: string;
  name: string;
  /** File role carried from Map-structure (source/config/test/docs/…). */
  layer: string;
  language: string;
  /** Real LOC for source files (inventory.loc); 0 for non-source nodes (LOC is a
   *  source-code metric — Inventory measures source only). */
  lines: number;
  /** Count of symbols Inventory found in this file. A structural count, NOT a graph
   *  metric (degree/centrality live in Analyze). 0 for non-source files. */
  symbolCount?: number;
}

export interface SymbolNode {
  id: string;
  name: string;
  kind: "function" | "class" | "method" | "module" | "unknown";
  fileId: string;
  line: number;
  exported: boolean;
}

export interface DependencyEdge {
  id: string;
  source: string;
  target: string;
  kind: "import" | "call" | "markdown-link" | "unknown";
  weight: number;
  from?: string;
  to?: string;
  dependencyType?:
    | "import"
    | "dynamic-import"
    | "require"
    | "python-import"
    | "heuristic"
    // V3-P1 code-property-graph relationships.
    | "call"
    | "extends"
    | "implements";
  confidence?: ParserConfidence;
  evidence?: string;
  sourceLine?: number;
}

export interface Issue {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  category: "security" | "architecture" | "health" | "dependency" | "other";
  title: string;
  message: string;
  fileId?: string;
}

export interface AnalysisResult {
  // --- Envelope / identity (Ingest + assembly) ---
  id: string;
  repository: RepositoryRef;
  mode: AnalysisMode;
  createdAt: string;
  commitSha?: string;
  warnings: string[];
  /** Bumped when the assembled shape changes in a breaking way. */
  schemaVersion?: number;
  /**
   * Stage IDs that actually produced this result (sorted). The cache only serves a
   * record as a HIT when its `producedBy` covers the currently-configured pipeline's
   * stage set — so a result built by a smaller/older pipeline (e.g. an Ingest-only
   * envelope) misses and triggers a real re-analysis when the analyzer grows.
   */
  producedBy?: PipelineStageId[];

  // --- Deterministic slices (algorithmic FACTS) -------------------------------
  // Filled by the deterministic stages (map-structure / inventory / connect /
  // analyze). Each field below is owned by exactly one stage — see PipelineStageId
  // and AnalysisResultSlices for the ownership map.
  summary: AnalysisSummary; // analyze + assembly
  files: FileNode[]; // DERIVED view of graph.nodes at assembly (single FileNode[] home; not a stored slice)
  symbols: SymbolNode[]; // connect (fileId-keyed projection of inventory.symbols — deferred)
  dependencies: DependencyEdge[]; // connect (fileId-keyed; deferred — graph.edges is the edge home)
  issues: Issue[]; // analyze
  /** Deterministic graph metrics — centrality/key files, blast radius, cycles, coupling,
   *  complexity proxy (Analyze). Numbers only; no prose. */
  metrics: RepoMetrics; // analyze
  /** Deterministic dependency-graph STRUCTURE — nodes + edges + resolution stats, NO
   *  metrics (Connect). Plain serializable data; Analyze rebuilds a live graph from it. */
  graph?: RepoGraph; // connect
  /** Languages, frameworks, project type (Orient — deterministic detection). */
  orientation?: RepoOrientation; // orient
  /** File-role classification + layout convention (Map structure). */
  structure?: RepoStructure; // map-structure
  /** Symbols + entry points + real LOC, keyed by POSIX path (Inventory). */
  inventory?: Inventory; // inventory
  /** Detected entry points (Connect — fileId-keyed projection of inventory.entryPoints). */
  entryPoints?: EntryPoint[]; // connect

  // --- AI slice (JUDGMENT grounded in the deterministic facts above) ----------
  // Deliberately the ONLY place AI-generated content lives, so it is always clear
  // what is algorithmic vs AI. Filled by Orient (summary) / Synthesize / Index-QA.
  ai?: AiAnalysis;

  // --- Pipeline run bookkeeping (assembly) ------------------------------------
  pipeline?: PipelineRunSummary;
}

export type LanguageId = "javascript" | "typescript" | "jsx" | "tsx" | "python" | "generic" | "unknown";

export type ParserConfidence = number;

export interface ParsedImport {
  source: string;
  specifiers: string[];
  importKind: "static" | "dynamic" | "commonjs" | "python" | "unknown";
  line: number;
  resolvedPath?: string;
  confidence: ParserConfidence;
}

export interface ParsedExport {
  name: string;
  kind: "function" | "class" | "variable" | "type" | "interface" | "unknown";
  line: number;
  confidence: ParserConfidence;
}

export interface ParsedSymbol {
  name: string;
  kind: "function" | "class" | "method" | "component" | "hook" | "variable" | "unknown";
  lineStart: number;
  lineEnd?: number;
  signature?: string;
  exported?: boolean;
  confidence: ParserConfidence;
}

export interface ParserWarning {
  message: string;
  line?: number;
  severity: "info" | "warning";
}

export interface ParsedFile {
  path: string;
  language: LanguageId;
  extension: string;
  loc: number;
  imports: ParsedImport[];
  exports: ParsedExport[];
  symbols: ParsedSymbol[];
  dependencies: DependencyEdge[];
  warnings: ParserWarning[];
  parserVersion: string;
}

export type GraphEdgeType =
  | "import"
  | "dynamic-import"
  | "require"
  | "python-import"
  | "symbol-reference"
  | "heuristic"
  // V3-P1 code-property-graph edge types (see RepoGraph.cpgEdges).
  | "call"
  | "extends"
  | "implements"
  | "unknown";

export interface GraphNode {
  id: string;
  path: string;
  label: string;
  language: string;
  loc: number;
  layer?: string;
  owner?: string;
  risk?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  confidence: ParserConfidence;
  evidence: string;
  sourceLine?: number;
  /**
   * Relationship STRENGTH (V3-P1). 1 for a dependency edge (a file either imports another
   * or it does not); the occurrence count for a CPG call edge, so "A calls 40 symbols in
   * B" outweighs "A imports a type from B". Weighted modularity in community detection
   * reads this; the degree/centrality metrics deliberately do not.
   */
  weight?: number;
  metadata?: Record<string, unknown>;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  circularDependencyCount: number;
  highCouplingCount: number;
  isolatedFileCount: number;
  averageDegree: number;
  topCentralFiles: Array<{
    id: string;
    path: string;
    totalDegree: number;
    inDegree: number;
    outDegree: number;
  }>;
}

export interface SerializedDependencyGraph {
  nodes: GraphNode[];
  links: GraphEdge[];
  summary: GraphSummary;
}

// ===========================================================================
// PIPELINE STAGE CONTRACT  (PLAN §4 / P1)
// ===========================================================================
//
// The analysis pipeline is an ordered sequence of stages. Each stage is a pure-ish
// unit:
//
//     run(input, ctx) => Promise<StageResult>
//
// and contributes two things:
//   1. `partial` — a typed, NAMED-SLICE contribution to the AnalysisResult.
//   2. `event`   — a serializable ProgressEvent streamed to the UI over SSE.
//
// ── ASSEMBLY MODEL: named slices, NOT deep-merge ──────────────────────────────
// Each stage OWNS one or more named slice keys (see AnalysisResultSlices). The
// orchestrator assembles the final result by *assignment per key* — never a deep
// merge. Two stages never own the same key, so assembly is order-independent and
// has no overwrite ambiguity.
//
//   - Deterministic slice keys (orientation, files, structure, symbols,
//     entryPoints, dependencies, graph, metrics, issues, summary) are assigned
//     directly onto the AnalysisResult field of the same name.
//   - AI slice keys (aiProjectSummary, aiSynthesis, aiRag) are placed UNDER
//     `result.ai.*` (the one clearly-separated AI slice). They are disjoint, so
//     even nesting them is conflict-free.
//
// Why not a deep-merge of Partial<AnalysisResult>? Deep-merge has ambiguous array
// semantics (concat vs replace), lets any stage silently clobber any field, and
// erases "which stage produced what" — which is exactly the deterministic-vs-AI
// separation PLAN §4/§6 require. Named slices make ownership and provenance
// explicit and keep assembly trivially correct. (Flagged for review.)
// ===========================================================================

/** Ordered identifiers of the eight pipeline stages (PLAN §4). */
export type PipelineStageId =
  | "ingest" // 1. validate, clone, resolve SHA, cache check  (no result slice; bootstraps ctx)
  | "orient" // 2. README + manifests → langs/frameworks/type (det) + AI 3-line summary
  | "map-structure" // 3. discover + classify files; detect layout
  | "inventory" // 4. symbols + entry-point detection
  | "connect" // 5. build dependency graph from real imports
  | "analyze" // 6. graph metrics: key files, blast radius, cycles, coupling, complexity
  | "synthesize" // 7. AI: "where do I start" narrative + ranked reading order, cited
  | "rag"; // 8. AI/RAG: chunk + embed files/symbols into a grounded Q&A index

/** Whether a stage produces algorithmic facts or AI judgment. */
export type StageKind = "deterministic" | "ai";

/** Lifecycle of a single stage within one pipeline run. */
export type StageStatus = "pending" | "running" | "completed" | "skipped" | "failed";

// --- Result slices ----------------------------------------------------------

/** Best-effort project-type heuristic (Orient). Not a hard fact — see the Orient stage. */
export type ProjectType = "application" | "library" | "cli" | "monorepo" | "service" | "unknown";

/** Package ecosystems Orient recognises by their root manifest. */
export type PackageEcosystem = "npm" | "pip" | "go" | "cargo" | "maven" | "gradle" | "rubygems" | "composer";

export interface DetectedManifest {
  /** Repo-relative path, e.g. "package.json". */
  path: string;
  ecosystem: PackageEcosystem;
}

/**
 * The repository README captured as a raw FACT for later AI synthesis (P3). The text
 * is stored in full and never summarized at this (deterministic) stage.
 */
export interface ReadmeCapture {
  path: string;
  text: string;
}

/** Deterministic orientation produced by the Orient stage from MANIFESTS + README only. */
export interface RepoOrientation {
  /** Languages inferred from which manifests are present (+ light signals, e.g. a `typescript` dep). */
  languages: string[];
  /** Frameworks / notable dependencies detected from manifest contents. */
  frameworks: string[];
  /** Best-effort heuristic (monorepo > cli > library > application); a judgment, not a fact. */
  projectType: ProjectType;
  /** Dependency manifests found at the repo root. */
  manifests: DetectedManifest[];
  /** Full raw README text (a fact for P3), or null if none found. */
  readme: ReadmeCapture | null;
}

export type FileRole = "source" | "config" | "test" | "docs" | "build" | "asset" | "other";

/**
 * A discovered + classified file. The COMPLETE, uncapped list lives in
 * `RepoStructure.files`; it is keyed by `path` (repo-relative POSIX, unique) — the key
 * Inventory (symbols) and Connect (graph) join on next.
 */
export interface RepoFile {
  /** Repo-relative POSIX path; the unique key downstream stages join on. */
  path: string;
  /** Lowercased extension including the leading dot (e.g. ".ts"); "" if none / dotfile. */
  ext: string;
  role: FileRole;
  /** Language inferred from extension (a file-level fact); "Unknown" if unmapped. */
  language: string;
  sizeBytes: number;
}

export type RepoLayout = "monorepo" | "src-rooted" | "app-rooted" | "flat";

/** Deterministic file-tree map produced by Map-structure (stage 3). */
export interface RepoStructure {
  layout: RepoLayout;
  /** Complete discovered + classified file list. Never truncated (UI capping is separate). */
  files: RepoFile[];
  /** Convenience count (equals files.length). */
  fileCount: number;
}

export interface EntryPoint {
  /** References FileNode.id. */
  fileId: string;
  reason: "main" | "index" | "server" | "cli-bin" | "exported-root";
}

// ── Inventory slice (stage 4) ────────────────────────────────────────────────
// Inventory parses source into symbols + detects entry points. It runs BEFORE the
// FileNode[] projection exists (that is Connect's single join of structure.files +
// inventory.loc + graph), so everything here is keyed by repo-relative POSIX
// `filePath` — the SAME key as RepoStructure.files[].path — NOT by FileNode.id.
// Connect re-keys these onto fileId-keyed SymbolNode/EntryPoint/FileNode later.

/** Normalized symbol kind across languages. `export` is a re-export / barrel entry
 *  with no better-known declaration kind. */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "export";

/**
 * A source symbol located by Inventory. `line`/`endLine` are 1-based — P3 synthesis
 * and RAG cite to file+line, so a symbol without a location is dead weight downstream.
 * Joined to a file strictly by repo-relative POSIX `filePath`.
 */
export interface InventorySymbol {
  name: string;
  kind: SymbolKind;
  /** Repo-relative POSIX path; joins into RepoStructure.files[].path. */
  filePath: string;
  /** 1-based start line. */
  line: number;
  /** 1-based end line, when known. */
  endLine?: number;
  exported: boolean;
  /** Language label (matches RepoFile.language), e.g. "TypeScript". */
  language: string;
}

export type EntryPointKind = "main" | "index" | "server" | "app" | "cli-bin";

export type EntryPointEvidence =
  | "package-json-bin"
  | "package-json-main"
  | "package-json-exports"
  | "filename-convention"
  | "framework";

/** An entry point detected by Inventory, keyed by repo-relative POSIX `filePath`. */
export interface InventoryEntryPoint {
  filePath: string;
  kind: EntryPointKind;
  evidence: EntryPointEvidence;
}

/**
 * Inventory's project-type verdict from HARD entry-point evidence (e.g. a package.json
 * `bin` ⇒ cli). It lives in Inventory's OWN slice; the orchestrator's explicit
 * reconciliation step folds it into the single canonical `orientation.projectType`
 * (Inventory wins on hard evidence, else Orient's heuristic stands). There is NO second
 * competing projectType field — same deferral pattern Map-structure uses for layout.
 */
export interface ProjectTypeSignal {
  projectType: ProjectType;
  evidence: EntryPointEvidence;
}

/**
 * Deterministic symbol/entry-point map produced by Inventory (stage 4). Owns symbols,
 * entry points, and the real per-file LOC (the ONE place LOC is produced — Connect joins
 * `loc` into FileNode[].lines). The symbol list is COMPLETE and never truncated (UI
 * capping is a separate render concern).
 */
export interface Inventory {
  symbols: InventorySymbol[];
  entryPoints: InventoryEntryPoint[];
  /** == symbols.length (convenience; never a cap). */
  symbolCount: number;
  /** Real lines-of-code per parsed file, keyed by repo-relative POSIX path. */
  loc: Record<string, number>;
  /** Hard-evidence project-type verdict for orchestrator reconciliation, if any. */
  projectTypeSignal?: ProjectTypeSignal;
  /** Files that could not be parsed (skipped — a single bad file is not a stage failure). */
  unparsedFiles?: string[];
}

// ── Connect slice (stage 5) ──────────────────────────────────────────────────
// Connect is the bridge between POSIX-path-keyed upstream facts and the fileId-keyed
// graph world: it sets fileId === repo-relative POSIX path (no opaque ids, no
// translation map). It builds the dependency-graph STRUCTURE from real imports and
// produces the single FileNode[] (the projection Map-structure left empty). It does
// NOT compute metrics (centrality/cycles/coupling/degree) — that is Analyze (stage 6).

/** A resolved dependency edge between two repo files. `from`/`to` are fileIds
 *  (=== repo-relative POSIX path). `specifier` is the raw import string. */
export interface RepoDependencyEdge {
  from: string;
  to: string;
  kind: "import" | "require" | "dynamic" | "reexport";
  /** The raw import/require/from string as written in source. */
  specifier: string;
}

/**
 * A CODE PROPERTY GRAPH edge: a semantic relationship between two repo files that goes
 * BEYOND the import statement — a call into an imported symbol, or a class inheriting from
 * one. `from`/`to` are fileIds (=== repo-relative POSIX path).
 *
 * Aggregated per (from, to, kind, symbol) with an occurrence `count` rather than stored
 * one-edge-per-call-site. That keeps the list COMPLETE (no truncation, no sampling) while
 * bounding it by distinct symbols instead of by call sites — a 200-call file would
 * otherwise put tens of thousands of near-identical edges in the cached document.
 *
 * HONEST LIMIT: targets are resolved through the file's OWN imports (the cheap tree-sitter
 * heuristic), so a cpgEdge always refines a relationship the import graph already has —
 * it never invents a dependency between two files with no import between them. What it
 * adds is *strength and kind*: "A imports B" vs "A calls 40 symbols in B" vs "A's class
 * extends B's class". That weighting is what community detection consumes. Compiler-exact
 * cross-file references need an indexer (SCIP), which is deliberately gated and optional.
 */
export interface CpgEdge {
  from: string;
  to: string;
  kind: "call" | "extends" | "implements";
  /** The symbol the relationship goes through, as written (e.g. `renderTemplate`, `utils.parse`). */
  symbol: string;
  /** Occurrences of this exact relationship in `from`. Always >= 1. */
  count: number;
  /** 1-based line of the FIRST occurrence — enough to cite the relationship. */
  line: number;
}

/** HTTP method label on a detected route. `USE` is an Express mount point; `ALL` matches
 *  any verb. Uppercase so the value is comparable across frameworks. */
export type HttpRouteMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "ALL"
  | "USE";

/**
 * An HTTP route declared in a repo file — the "property" half of the code property graph:
 * a fact about a node, not an edge. Detected from cheap, high-precision syntax only
 * (Express-style `app.get("/x", …)`, Flask `@app.route("/x")`, FastAPI `@router.get("/x")`)
 * and only when the path is a STRING LITERAL starting with `/`, so a `map.get(key)` is
 * never mistaken for a route.
 */
export interface HttpRoute {
  /** References FileNode.id (=== repo-relative POSIX path). */
  fileId: string;
  method: HttpRouteMethod;
  /** The route path exactly as written in source (never normalized or guessed). */
  path: string;
  line: number;
  framework: "express" | "flask" | "fastapi" | "unknown";
}

/**
 * Import-resolution stats — makes the "real vs simplified" approximation data-backed
 * rather than hidden. Regex extraction + heuristic relative resolution is approximate;
 * tsconfig/package path aliases are out of scope (counted as unresolved).
 */
export interface GraphResolution {
  /** Relative imports resolved to a repo file (one per stored edge). */
  resolved: number;
  /** Bare/package/`node:` specifiers — NOT repo nodes; tallied, never fabricated as nodes. */
  external: number;
  /** Relative imports that did not resolve to any discovered file. */
  unresolved: number;
  /** Distinct external module specifiers (the tally behind `external`). */
  externalModules: string[];
  /** Each unresolved relative import, recorded honestly (same spirit as inventory.unparsedFiles). */
  unresolvedImports: Array<{ from: string; specifier: string }>;
}

/**
 * Deterministic dependency-graph STRUCTURE produced by Connect (stage 5). Plain,
 * serializable data (no live @codeflow/graph object) so it round-trips through
 * Mongo/cache; Analyze rebuilds a live graph from it. The node + edge lists are
 * COMPLETE and never truncated (any cap is a P5 render concern only).
 */
export interface RepoGraph {
  /** One node per structure.files entry. The single home for FileNode[]. */
  nodes: FileNode[];
  /** Resolved repo-file→repo-file edges only (external/unresolved live in `resolution`). */
  edges: RepoDependencyEdge[];
  resolution: GraphResolution;
  /**
   * V3-P1 code-property-graph edges (calls / inheritance), sorted by
   * (from, to, kind, symbol). COMPLETE and never truncated.
   *
   * Deliberately a SEPARATE list from `edges`: `edges` is the DEPENDENCY graph, and
   * `metrics.perFile.fanIn`/`fanOut` are contractually "files that import this one". Folding
   * call edges into `edges` would silently redefine every existing metric. Algorithms that
   * want the richer graph opt in — community detection runs on the union, which is why
   * `metrics.clusters` reflects calls while `fanIn` still means imports.
   *
   * Absent (not empty) when the parser engine could not produce them — a regex fallback
   * yields imports only, and `cpg.engine` records that.
   */
  cpgEdges?: CpgEdge[];
  /** V3-P1 detected HTTP routes, sorted by (fileId, path, method, line). Uncapped. */
  routes?: HttpRoute[];
  /** How the code property graph was produced — makes a degraded run visible. */
  cpg?: CpgProvenance;
}

/**
 * Provenance for the code-property-graph enrichment. Without this, a repo whose grammars
 * failed to load would look like a repo with genuinely no calls or routes.
 */
export interface CpgProvenance {
  /** Files whose CPG facts came from tree-sitter (calls/inheritance/routes are real). */
  treeSitterFiles: number;
  /** Files that fell back to the regex engine (imports only — no calls/routes from these). */
  fallbackFiles: number;
  /** True when at least one file was parsed by tree-sitter. */
  enriched: boolean;
}

// ── Analyze slice (stage 6) ──────────────────────────────────────────────────
// Analyze is the LAST deterministic stage: it runs @codeflow/graph algorithms over
// Connect's RepoGraph and produces METRICS as numbers. It only READS the graph slice —
// metrics are NEVER written back onto graph.nodes (Connect owns `graph`; FileNode is
// kept metrics-free on purpose). Metrics reference nodes by fileId (=== POSIX path), so
// the join back to graph.nodes is trivial. NO prose / no AI (that is Synthesize, st.7).

/** Per-file graph metrics. `fileId === graph.nodes[].id === repo-relative POSIX path`. */
export interface FileMetrics {
  fileId: string;
  /** Degree centrality = fanIn + fanOut. */
  centrality: number;
  /** In-degree: number of files that directly import this one. */
  fanIn: number;
  /** Out-degree: number of files this one directly imports. */
  fanOut: number;
  /** Transitive dependents (reverse reachability) — files affected if this one changes. */
  blastRadius: number;
  /**
   * STRUCTURAL PROXY for complexity, NOT cyclomatic complexity. There is no AST/
   * control-flow analysis (the known later fork). Defined explicitly as:
   *   complexity = loc + symbolCount + fanIn + fanOut
   */
  complexity: number;
}

export interface RepoMetricsSummary {
  fileCount: number;
  edgeCount: number;
  cycleCount: number;
  isolatedFileCount: number;
  maxBlastRadius: number;
}

/**
 * One detected community (module) of files. `id` is canonical: communities are sorted by
 * size descending, then by their lowest member fileId, and numbered from 0 — so the id does
 * not depend on any internal iteration order.
 */
export interface RepoCluster {
  id: number;
  /** Member fileIds, sorted. COMPLETE — never truncated. */
  files: string[];
  /** == files.length. */
  size: number;
  /** Summed edge weight WITHIN the community (higher ⇒ more cohesive). */
  internalWeight: number;
  /** Summed edge weight leaving the community (lower ⇒ more independent). */
  externalWeight: number;
}

/**
 * Deterministic community partition of the code property graph (V3-P1). The ONE canonical
 * home for clusters/modules — there is no second competing field.
 *
 * Computed on the UNION of `graph.edges` and `graph.cpgEdges` (imports + weighted calls +
 * inheritance), projected undirected: coupling for the purpose of clustering genuinely
 * includes calls, and a call edge with `count: 40` should outweigh a single type import.
 * Note this differs from `perFile.fanIn`/`fanOut`, which stay contractually "files that
 * directly import this one" — that asymmetry is deliberate and documented, not an oversight.
 */
export interface RepoClusters {
  algorithm: "louvain";
  /** Seed of the deterministic node-visit permutation (no RNG is used). */
  seed: number;
  /** Resolution used to steer partition granularity. */
  resolution: number;
  /** STANDARD (unscaled) weighted modularity Q of this partition. Higher ⇒ better-separated
   *  modules; > ~0.3 indicates meaningful structure. 0 for an edgeless graph. */
  modularity: number;
  /** == clusters.length. */
  count: number;
  /** Every node's community, sorted by fileId. COMPLETE — one entry per graph node. */
  assignments: Array<{ fileId: string; cluster: number }>;
  /** The communities themselves, in canonical id order. */
  clusters: RepoCluster[];
}

/**
 * Deterministic graph metrics produced by Analyze (stage 6). All rankings are COMPLETE
 * and never truncated (top-N is a P5 render concern only) and deterministically ordered
 * (ties broken by fileId) so the SHA-keyed cache + P3 eval set stay stable.
 */
export interface RepoMetrics {
  /** Every node's metrics, sorted by fileId. */
  perFile: FileMetrics[];
  /** FULL ranking by centrality (desc; tie → fileId asc). */
  keyFiles: string[];
  /** FULL ranking by the complexity proxy (desc; tie → fileId asc). */
  hotspots: string[];
  /** Every dependency cycle, as fileId lists; deterministic order. */
  cycles: Array<{ files: string[] }>;
  /**
   * Community/module partition (V3-P1 — closes the long-standing "no clustering algorithm
   * yet" gap). Absent only when the graph slice carries no nodes to partition.
   */
  clusters?: RepoClusters;
  summary: RepoMetricsSummary;
}

/** A grounding reference back to real code — every AI claim must carry these. */
export interface Citation {
  /** References FileNode.id. */
  fileId: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

/** AI 3-line "what is this project" (Orient). */
export interface ProjectSummary {
  text: string;
  citations: Citation[];
}

/**
 * One step in the onboarding reading order. `fileId === graph.nodes[].id === repo-relative
 * POSIX path` and MUST exist in graph.nodes — enforced by a DETERMINISTIC grounding check
 * after the LLM returns (ungrounded steps are dropped, not trusted).
 */
export interface ReadingStep {
  fileId: string;
  /** 1-based position in the suggested reading order. */
  order: number;
  reason: string;
}

/**
 * "Where do I start" onboarding synthesis (Synthesize, stage 7 — the FIRST AI stage).
 * Schema-validated and grounding-checked. `readingOrder` is UNCAPPED in storage (the UI
 * caps what it renders). Lives under `result.ai.synthesis` — judgment over the
 * deterministic facts, never a deterministic fact itself.
 */
export interface Synthesis {
  /** Short "what this is + where to start" narrative (a few lines). */
  summary: string;
  /** Ranked reading order; every fileId references a real graph node. */
  readingOrder: ReadingStep[];
  /** Optional cross-cutting concepts a newcomer should know. */
  keyConcepts?: string[];
  /** Count of LLM-cited steps dropped by grounding (cited a file not in graph.nodes). */
  droppedCitations?: number;
}

/**
 * One embedded chunk of repository content (RAG / stage 8). Derived from an inventory
 * symbol (symbol-aware) or a fixed window (docs / uncovered source regions), so every
 * chunk inherits a REAL `fileId` + line range and its citations are grounded by
 * construction. `embedding` is a plain number[] (serializable — no live vector object),
 * needed by the future ask-the-repo query path together with `text`.
 */
export interface RagChunk {
  /** Deterministic: `${fileId}#${startLine}-${endLine}`. */
  id: string;
  /** Repo-relative POSIX path; MUST exist in graph.nodes (grounding). */
  fileId: string;
  /** 1-based, inclusive; MUST be within the file. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Set when the chunk aligns to an inventory symbol. */
  symbolName?: string;
  /** Chunk content (needed by the future query path; uncapped). */
  text: string;
  /** The embedding vector (plain serializable; no live vector object). */
  embedding: number[];
  tokenCount: number;
}

/**
 * The RAG index produced by stage 8 (the SECOND AI stage). The chunk plan is
 * DETERMINISTIC (symbol/window aligned) and grounding is enforced by code; embeddings
 * come from an injectable client (cached, content-addressed). Lives under
 * `result.ai.rag`. Index-build only — the retrieve/answer/cite query path is a separate
 * runtime path.
 */
export interface Rag {
  /** Sorted by (fileId, startLine) — deterministic. */
  chunks: RagChunk[];
  chunkCount: number;
  /** e.g. "voyage-code-3". */
  embeddingModel: string;
  /** The model's vector length. */
  embeddingDim: number;
  /** Chunks dropped by grounding (fileId not a node, or line range out of file).
   *  Omitted entirely when none (absent ≠ empty) — a non-zero count is a quality signal. */
  droppedChunks?: { count: number; fileIds: string[] };
}

/** The single AI slice. Each field is owned by exactly one AI stage. */
export interface AiAnalysis {
  projectSummary?: ProjectSummary; // orient
  synthesis?: Synthesis; // synthesize
  rag?: Rag; // rag (stage 8 — RAG index)
}

/**
 * The writable slices of an AnalysisResult, keyed by slice name. Each key is
 * owned by exactly one stage. Deterministic keys map 1:1 onto AnalysisResult
 * fields of the same name; the `ai*` keys are placed under `result.ai.*`.
 */
export interface AnalysisResultSlices {
  // deterministic
  orientation: RepoOrientation; // orient
  structure: RepoStructure; // map-structure
  inventory: Inventory; // inventory (symbols + entry points + LOC, keyed by POSIX path)
  // Connect owns `graph` (the dependency-graph STRUCTURE). It sets fileId === POSIX path,
  // so `graph.nodes` IS the FileNode[] home — `result.files` is DERIVED from it at
  // assembly, not a second stored slice. The fileId-keyed flat projections (symbols /
  // entryPoints / dependencies) are trivially derivable later (fileId===path) and are
  // deferred — not produced this session.
  graph: RepoGraph; // connect
  files: FileNode[]; // derived from graph.nodes (assembly) — kept for back-compat readers
  symbols: SymbolNode[]; // connect (deferred)
  entryPoints: EntryPoint[]; // connect (deferred)
  dependencies: DependencyEdge[]; // connect (deferred)
  metrics: AnalysisResult["metrics"]; // analyze
  issues: Issue[]; // analyze
  summary: AnalysisSummary; // analyze
  // AI (assembled under result.ai.*)
  aiProjectSummary: ProjectSummary;
  aiSynthesis: Synthesis;
  aiRag: Rag;
}

export type AnalysisSliceKey = keyof AnalysisResultSlices;

// --- Progress event (SSE payload) -------------------------------------------

/**
 * One serializable progress event for a single stage, streamed over SSE.
 * MUST stay JSON-safe — no class instances, functions, Maps, etc.
 */
export interface ProgressEvent {
  jobId: string;
  stage: PipelineStageId;
  /** 1-based position of this stage and the total count, for UI progress. */
  stageIndex: number;
  stageCount: number;
  kind: StageKind;
  status: StageStatus;
  /** Human-readable label, e.g. "Mapping structure". */
  label: string;
  /** Optional one-line human detail, e.g. "classified 1,204 files". */
  detail?: string;
  /** Overall pipeline progress at emit time, 0..1. */
  progress: number;
  startedAt: string; // ISO-8601
  /** Set once the stage reaches a terminal status. */
  durationMs?: number;
  /** Small, flat, JSON-safe teaser for the UI — NEVER the full slice. */
  preview?: Record<string, string | number | boolean | null>;
  error?: { message: string; retriable?: boolean };
  emittedAt: string; // ISO-8601
}

// --- Stage execution contract ------------------------------------------------

/** Minimal structured logger handed to each stage. */
export interface PipelineLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Cache handle (keyed on commit SHA + prompt/content hash; PLAN §6). */
export interface AnalysisCacheHandle {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
}

/**
 * Global daily LLM-spend ceiling (the wallet guard; PLAN §8). Tracks cumulative tokens
 * for the CURRENT UTC day against a configured budget and resets per day. Mirrors
 * AnalysisCacheHandle (injectable; Mongo/Redis-backed in prod, in-memory in tests).
 *
 * Ordering at the call site is load-bearing: the content/prompt CACHE is checked FIRST —
 * a cache hit spends nothing and must NOT touch the budget. Only on a cache MISS do you
 * `check(estimate)` → call the provider → `record(actual)`. When `check` returns false the
 * AI stage degrades gracefully ("partial" + budget-exhausted), it does NOT call the provider.
 */
export interface BudgetHandle {
  /** True if spending `estimatedTokens` more this UTC day stays within budget. */
  check(estimatedTokens: number): Promise<boolean>;
  /** Add actually-spent tokens to the current UTC day's running total. */
  record(actualTokens: number): Promise<void>;
}

/** Immutable trigger for a pipeline run — the same for every stage. */
export interface PipelineInput {
  jobId: string;
  repositoryRef: RepositoryRef;
  mode: AnalysisMode;
  analyzerVersion: string;
  /** Caller-supplied SHA, if any. The resolved SHA lives on PipelineContext. */
  requestedCommitSha?: string;
}

/**
 * Evolving ambient state that flows stage-to-stage. The orchestrator owns this
 * and updates it between stages (e.g. Ingest resolves `repoPath`/`commitSha`;
 * each stage's result is folded into `prior` before the next stage runs).
 */
export interface PipelineContext {
  /**
   * Local clone path. Undefined until Ingest resolves it; the orchestrator populates
   * it before running stages 2+, which may assert it is present.
   */
  repoPath?: string;
  /**
   * Resolved commit SHA. Undefined until Ingest resolves it; the orchestrator populates
   * it before running stages 2+, which may assert it is present.
   */
  commitSha?: string;
  /** Read-only view of slices produced by EARLIER stages. */
  prior: Readonly<Partial<AnalysisResultSlices>>;
  cache: AnalysisCacheHandle;
  /** Optional global daily LLM-spend ceiling, checked at each AI provider-call boundary
   *  AFTER the content cache (a cache hit spends nothing). Undefined ⇒ no budget guard. */
  budget?: BudgetHandle;
  logger: PipelineLogger;
  /** Cooperative cancellation (timeouts, budget exhaustion, client disconnect). */
  signal: AbortSignal;
  /** Optional interim progress (e.g. "parsed 200/5000"). The canonical, terminal
   *  event for a stage is the one returned in StageResult. */
  emit?(event: ProgressEvent): void;
}

/** What a stage returns: the slice(s) it owns + its terminal progress event. */
export interface StageResult<K extends AnalysisSliceKey = AnalysisSliceKey> {
  /** The owned slice(s). May be partial/absent if the stage was skipped. */
  partial: Partial<Pick<AnalysisResultSlices, K>>;
  event: ProgressEvent;
}

/**
 * The interface every stage implements. `K` binds a stage to the slice key(s) it
 * may write, so `owns` and `run`'s return type stay in lock-step.
 */
export interface PipelineStage<K extends AnalysisSliceKey = AnalysisSliceKey> {
  readonly id: PipelineStageId;
  readonly kind: StageKind;
  readonly label: string;
  /** The slice key(s) this stage is allowed to produce. */
  readonly owns: readonly K[];
  run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<K>>;
}

/**
 * Optional metadata a stage may expose so the orchestrator can decide whether a cached
 * slice it produced is REUSABLE under the current configuration — beyond mere presence in
 * `producedBy`. RAG uses it for embedding-space homogeneity: a cached `result.ai.rag`
 * built with a different `embeddingModel`/`embeddingDim` is NOT reusable (would mix vector
 * spaces), so RAG is treated as uncovered ⇒ re-embed. Derived from the injected client —
 * no new persisted `cacheReusable` flag (one-canonical-field rule).
 */
export interface StageEmbeddingTarget {
  embeddingTarget?: { model: string; dim: number };
}

// --- Run summary + error contract -------------------------------------------

export interface StageRunRecord {
  stage: PipelineStageId;
  kind: StageKind;
  status: StageStatus;
  startedAt?: string;
  durationMs?: number;
  error?: string;
}

export type PipelineRunStatus = "completed" | "partial" | "failed" | "aborted";

/**
 * Typed, machine-readable reason for a non-clean run outcome (P4 guardrails). Distinct
 * from the human `warnings[]` so the API/UI can branch: a `"budget-exhausted"` partial is
 * "demo at capacity", NOT "synthesis failed"; a `"repo-too-large"` failure is "this repo
 * exceeds the demo size cap", NOT a crash. Extend as new guarded conditions appear.
 */
export type PipelineStatusReason = "repo-too-large" | "budget-exhausted";

export interface PipelineRunSummary {
  stages: StageRunRecord[];
  /** Set when a guardrail produced the outcome (see PipelineStatusReason); omitted otherwise. */
  statusReason?: PipelineStatusReason;
  /**
   * Overall outcome (see error contract below):
   *   - "completed": every stage completed.
   *   - "partial":   all DETERMINISTIC stages completed, but ≥1 AI stage failed
   *                  or was skipped — a usable, grounded result is still returned.
   *   - "failed":    a DETERMINISTIC (required) stage failed — the result is
   *                  incomplete; whatever slices succeeded are returned with a
   *                  warning, and downstream dependent stages are skipped.
   *   - "aborted":   the run was cancelled via AbortSignal with no deterministic
   *                  failure; remaining stages were skipped.
   */
  status: PipelineRunStatus;
  startedAt: string;
  completedAt?: string;
}

// ── ERROR CONTRACT ───────────────────────────────────────────────────────────
// Deterministic stages are REQUIRED. If one throws (or returns status "failed"),
// the orchestrator records it, marks dependent downstream stages "skipped", sets
// PipelineRunSummary.status = "failed", appends a warning, and returns the
// partial AnalysisResult assembled from the slices that did complete.
//
// AI stages are BEST-EFFORT. If one fails, the deterministic result is unaffected:
// its `ai.*` sub-slice is left unset, a warning is added, and status is "partial".
//
// On AbortSignal (no deterministic failure), remaining stages are marked "skipped"
// and the run status is "aborted".
// ─────────────────────────────────────────────────────────────────────────────

// --- Cross-process progress channel ----------------------------------------
//
// Progress events are emitted in the WORKER process but consumed by SSE clients via
// the API process. These contracts decouple the two: the worker holds a
// ProgressPublisher, the API holds a ProgressSubscriber. The production transport is
// BullMQ (worker `job.updateProgress` → API `QueueEvents`); tests use an in-memory
// implementation of the same interfaces.

/** A message carried over the progress channel for one job. */
export type ProgressMessage =
  | { kind: "progress"; jobId: string; event: ProgressEvent }
  | { kind: "done"; jobId: string; status: PipelineRunStatus };

/** Worker-side: publishes per-stage progress and a terminal status for a job. */
export interface ProgressPublisher {
  publishProgress(jobId: string, event: ProgressEvent): Promise<void> | void;
  publishDone(jobId: string, status: PipelineRunStatus): Promise<void> | void;
}

/** API-side: subscribes to a job's progress stream. Returns an unsubscribe fn. */
export interface ProgressSubscriber {
  subscribe(jobId: string, handler: (message: ProgressMessage) => void): () => void;
}

/**
 * Append-only per-job log of ProgressMessages — the SSE REPLAY buffer (the #20 fix). The
 * worker appends every message it emits (each per-stage ProgressEvent + the terminal done);
 * on `GET /api/job/:id/events` the API replays the buffered log IN ORDER, then attaches the
 * live channel and tails it. The replay/live boundary is deduped on the monotonic
 * `stageIndex` (one authoritative event per stage, per the P1 contract) plus the terminal
 * event, so a late-connecting client sees every stage exactly once, from Ingest. Redis/Mongo-
 * backed in prod (shared across processes); in-memory in tests.
 */
export interface EventLogStore {
  append(jobId: string, message: ProgressMessage): Promise<void>;
  read(jobId: string): Promise<ProgressMessage[]>;
}
