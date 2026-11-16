import { buildDependencyGraph } from "@codeflow/graph";
import { createParserRegistry, extractCpgFacts, type CpgFacts, type ParserRegistry } from "@codeflow/parsers";
import { createModuleResolver } from "./moduleResolver.js";
import type {
  CpgEdge,
  CpgProvenance,
  DependencyEdge,
  FileNode,
  GraphResolution,
  HttpRoute,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoDependencyEdge,
  RepoGraph,
  StageResult,
} from "@codeflow/shared-types";

/**
 * Reads repo-relative file CONTENTS (same `readFile` shape the other stages use).
 * Resolves `null` when a file cannot be read.
 */
export interface ConnectDependencies {
  readFile(repoPath: string, relativePath: string): Promise<string | null>;
  /** Injectable parser registry (defaults to the standard JS/TS/Py + generic set). */
  registry?: ParserRegistry;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

/**
 * Roles whose imports are parsed. Tests are included so the graph can answer "which tests reach
 * this module" (Impact tab); ranking metrics that must stay production-only filter them in Analyze.
 */
const PARSED_ROLES = new Set(["source", "test"]);

/** The engine label `extractCpgFacts` reports when tree-sitter produced the facts. */
const TREE_SITTER_ENGINE = "treesitter-v1";

/**
 * Stage 5 — Connect (deterministic). Builds the CODE PROPERTY GRAPH from real syntax: one
 * tree-sitter pass per source file (`extractCpgFacts`), resolving relative import
 * specifiers against the discovered file set, and producing
 *   - `graph.edges`    — the DEPENDENCY graph (import / require / dynamic / reexport),
 *   - `graph.cpgEdges` — CALL and INHERITANCE edges, aggregated with occurrence counts,
 *   - `graph.routes`   — declared HTTP routes (the "property" half of the CPG),
 * plus the single `FileNode[]` projection (structure.files + inventory.loc + symbol count).
 *
 * `edges` and `cpgEdges` are SEPARATE lists on purpose: `metrics.perFile.fanIn`/`fanOut`
 * are contractually "files that directly import this one", so folding call edges into
 * `edges` would silently redefine every existing metric and every UI that reads them.
 * Algorithms that want the richer graph opt in — community detection runs on the union.
 *
 * fileId === repo-relative POSIX path (no opaque ids). It computes NO metrics
 * (centrality/cycles/coupling/degree) — that is Analyze (stage 6). Node + edge lists
 * are COMPLETE and never truncated. Unresolved/external imports are recorded in
 * `resolution`, never crash the stage.
 */
export function createConnectStage(deps: ConnectDependencies): PipelineStage<"graph"> {
  const now = deps.now ?? Date.now;
  const registry = deps.registry ?? createParserRegistry();

  return {
    id: "connect",
    kind: "deterministic",
    label: "Connecting",
    owns: ["graph"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"graph">> {
      const startedAt = now();
      const repoPath = ctx.repoPath;
      if (!repoPath) {
        throw new Error("Connect requires a resolved repoPath; Ingest must run first.");
      }
      const structure = ctx.prior.structure;
      if (!structure) {
        throw new Error("Connect requires the structure slice; Map-structure must run first.");
      }
      const inventory = ctx.prior.inventory;
      const loc = inventory?.loc ?? {};

      // Per-file symbol count (inventory only parsed source; non-source → 0).
      const symbolCountByPath = new Map<string, number>();
      for (const symbol of inventory?.symbols ?? []) {
        symbolCountByPath.set(symbol.filePath, (symbolCountByPath.get(symbol.filePath) ?? 0) + 1);
      }

      // 1) One node per discovered file. fileId === POSIX path.
      const nodes: FileNode[] = structure.files.map((file) => ({
        id: file.path,
        path: file.path,
        name: basename(file.path),
        layer: file.role,
        language: file.language,
        lines: loc[file.path] ?? 0, // real LOC for source; 0 for non-source (documented)
        symbolCount: symbolCountByPath.get(file.path) ?? 0,
      }));
      const resolver = await createModuleResolver({
        files: structure.files.map((file) => file.path),
        read: (path) => deps.readFile(repoPath, path),
      });

      // 2) One tree-sitter pass per source file. Grammars are loaded once (the load is
      //    shared with Inventory); a file whose language has no grammar falls back to regex
      //    import extraction, so DEPENDENCY coverage never regresses — only the enrichment
      //    (calls / inheritance / routes) is lost, and `graph.cpg` records that honestly.
      const treeSitter = await registry.ready();
      if (!treeSitter.ready) {
        ctx.logger.warn("Connect: no tree-sitter grammar loaded; the CPG will hold imports only.", {
          failed: treeSitter.failed.map((entry) => entry.language),
        });
      }

      const edges: RepoDependencyEdge[] = [];
      const richDeps: DependencyEdge[] = []; // fed to @codeflow/graph
      const edgeKeys = new Set<string>();
      const externalModules = new Set<string>();
      const unresolvedImports: GraphResolution["unresolvedImports"] = [];
      const cpgAggregate = new Map<string, CpgEdge>();
      const routes: HttpRoute[] = [];
      let resolved = 0;
      let external = 0;
      let unresolved = 0;
      let treeSitterFiles = 0;
      let fallbackFiles = 0;

      for (const file of structure.files) {
        if (!PARSED_ROLES.has(file.role)) continue;
        const content = await deps.readFile(repoPath, file.path);
        if (content === null) continue; // unreadable: contributes a node, no edges

        const isPython = file.language === "Python" || file.ext === ".py";
        const facts = extractCpgFacts({ path: file.path, content });
        if (facts.engine === TREE_SITTER_ENGINE) treeSitterFiles += 1;
        else fallbackFiles += 1;

        // 2a) Dependency edges, plus the local-binding -> target-file map that the call and
        //     inheritance edges resolve through.
        const targetByBinding = new Map<string, string>();
        for (const spec of facts.imports) {
          const resolution = resolver.resolve(file.path, spec, isPython ? "python" : "js");
          if (resolution.status === "external") {
            external += 1;
            externalModules.add(spec.source);
            continue;
          }
          if (resolution.status === "unresolved") {
            unresolved += 1;
            unresolvedImports.push({ from: file.path, specifier: spec.source });
            continue;
          }
          resolved += 1;
          for (const { target, bindings } of resolution.targets) {
            // First import of a binding wins: resolving a later shadowing declaration would
            // need real scope analysis, and guessing would fabricate an edge.
            for (const binding of bindings) {
              if (!targetByBinding.has(binding)) targetByBinding.set(binding, target);
            }
            const key = `${file.path} ${target} ${spec.kind} ${spec.source}`;
            if (edgeKeys.has(key)) continue;
            edgeKeys.add(key);
            edges.push({
              from: file.path,
              to: target,
              kind: spec.kind,
              specifier: spec.source,
              ...(spec.typeOnly ? { typeOnly: true as const } : {}),
              ...(spec.lazy ? { lazy: true as const } : {}),
            });
            richDeps.push(toDependencyEdge(file.path, target, spec, richDeps.length));
          }
        }

        // 2b) Calls + inheritance, resolved through this file's own imports. A reference to
        //     a locally-declared name has no cross-file target and is skipped, never guessed.
        for (const call of facts.calls) {
          addCpgEdge(cpgAggregate, file.path, targetByBinding.get(call.binding), "call", call.symbol, call.line);
        }
        for (const relation of facts.inheritance) {
          addCpgEdge(
            cpgAggregate,
            file.path,
            targetByBinding.get(relation.binding),
            relation.kind,
            relation.symbol,
            relation.line,
          );
        }

        // 2c) Routes are a PROPERTY of the node, not an edge.
        for (const route of facts.routes) {
          routes.push({
            fileId: file.path,
            method: route.method,
            path: route.path,
            line: route.line,
            framework: route.framework,
          });
        }
      }

      // 3) Feed @codeflow/graph to construct the live graph (wire in the crown jewel +
      //    capture any residual warnings). The STORED slice is plain data only.
      const built = buildDependencyGraph({ files: nodes, dependencies: richDeps });
      if (built.warnings.length) {
        ctx.logger.warn("Connect: graph builder reported residual warnings.", { count: built.warnings.length });
      }

      const resolution: GraphResolution = {
        resolved,
        external,
        unresolved,
        externalModules: [...externalModules].sort(),
        unresolvedImports,
      };

      // Deterministic storage order for both new lists (same spirit as `edges`).
      const cpgEdges = [...cpgAggregate.values()].sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to) ||
          a.kind.localeCompare(b.kind) ||
          a.symbol.localeCompare(b.symbol),
      );
      routes.sort(
        (a, b) =>
          a.fileId.localeCompare(b.fileId) ||
          a.path.localeCompare(b.path) ||
          a.method.localeCompare(b.method) ||
          a.line - b.line,
      );
      const cpg: CpgProvenance = { treeSitterFiles, fallbackFiles, enriched: treeSitterFiles > 0 };
      const graph: RepoGraph = { nodes, edges, resolution, cpgEdges, routes, cpg };

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "connect",
        stageIndex: 5,
        stageCount: 5,
        kind: "deterministic",
        status: "completed",
        label: "Connecting",
        detail:
          `${nodes.length} files, ${edges.length} edges (${external} external, ${unresolved} unresolved); ` +
          `${cpgEdges.length} call/inheritance edges, ${routes.length} routes.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          nodes: nodes.length,
          edges: edges.length,
          external,
          unresolved,
          cpgEdges: cpgEdges.length,
          routes: routes.length,
        },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { graph }, event };
    },
  };
}

// --- CPG aggregation --------------------------------------------------------

/**
 * Fold one call/inheritance occurrence into the aggregate. Aggregating by
 * (from, to, kind, symbol) keeps the list COMPLETE while bounding it by distinct symbols
 * instead of by call sites — a 200-call file would otherwise put thousands of
 * near-identical edges in the cached document. `line` keeps the FIRST occurrence, so the
 * relationship stays citable.
 *
 * An unresolved binding (a locally-declared name, or an import that pointed outside the
 * repo) contributes nothing: no target, no edge. Nothing is invented.
 */
function addCpgEdge(
  aggregate: Map<string, CpgEdge>,
  from: string,
  to: string | undefined,
  kind: CpgEdge["kind"],
  symbol: string,
  line: number,
): void {
  if (!to) return;
  const key = `${from} ${to} ${kind} ${symbol}`;
  const existing = aggregate.get(key);
  if (existing) {
    existing.count += 1;
    existing.line = Math.min(existing.line, line);
    return;
  }
  aggregate.set(key, { from, to, kind, symbol, count: 1, line });
}

// --- Edges ------------------------------------------------------------------

/** Import specifiers come from `extractCpgFacts` (tree-sitter, or its regex fallback). */
type ImportSpec = CpgFacts["imports"][number];

function toDependencyEdge(from: string, to: string, spec: ImportSpec, index: number): DependencyEdge {
  const dependencyType =
    spec.kind === "dynamic" ? "dynamic-import" : spec.kind === "require" ? "require" : "import";
  return {
    id: `${from}:edge:${index + 1}`,
    source: from,
    target: to,
    from,
    to,
    kind: "import",
    weight: 1,
    dependencyType,
    confidence: 1,
    evidence: spec.source,
    sourceLine: spec.line,
  };
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
