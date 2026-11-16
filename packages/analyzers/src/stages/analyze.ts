import {
  buildCodePropertyGraph,
  buildDependencyGraph,
  computeCentrality,
  detectCommunities,
  detectIsolatedFiles,
  findCircularDependencies,
  type CommunityOptions,
} from "@codeflow/graph";
import type {
  DependencyEdge,
  FileMetrics,
  FileNode,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoDependencyEdge,
  RepoMetrics,
  StageResult,
} from "@codeflow/shared-types";

export interface AnalyzeDependencies {
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
  /** Community-detection settings (seed / resolution). Defaults are FIXED, never random —
   *  overriding the seed changes the partition, so it is a deliberate knob, not a nicety. */
  communities?: CommunityOptions;
}

/**
 * Stage 6 — Analyze (deterministic, LAST deterministic stage). Reconstructs the live
 * @codeflow/graph object from Connect's plain RepoGraph slice and runs the existing
 * graph algorithms (centrality, cycles, blast radius, coupling) to produce a numeric
 * `metrics` slice. It only READS the graph slice — metrics are never written back onto
 * graph.nodes (Connect owns `graph`).
 *
 * Determinism is load-bearing (SHA-keyed cache + P3 eval set): identical graph ⇒
 * identical numbers AND identical ordering (ties broken by fileId). All rankings are
 * COMPLETE/uncapped. NO AI, NO prose — numbers only (Synthesize, stage 7, is the AI step).
 */
export function createAnalyzeStage(deps: AnalyzeDependencies = {}): PipelineStage<"metrics"> {
  const now = deps.now ?? Date.now;

  return {
    id: "analyze",
    kind: "deterministic",
    label: "Analyzing",
    owns: ["metrics"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"metrics">> {
      const startedAt = now();
      const repoGraph = ctx.prior.graph;
      if (!repoGraph) {
        throw new Error("Analyze requires the graph slice; Connect must run first.");
      }

      // Rebuild the live graph from plain data (Connect stored nodes + edges only).
      const liveGraph = buildDependencyGraph({
        files: repoGraph.nodes,
        dependencies: repoGraph.edges.map(toDependencyEdge),
      });

      // Symbol count + LOC come from the FileNode (Connect already joined inventory.loc).
      const nodeByPath = new Map<string, FileNode>(repoGraph.nodes.map((node) => [node.id, node]));

      // computeCentrality gives in/out-degree + transitive dependent/dependency counts.
      const centrality = computeCentrality(liveGraph);

      const perFile: FileMetrics[] = centrality.map((score) => {
        const node = nodeByPath.get(score.id);
        const fanIn = score.inDegree;
        const fanOut = score.outDegree;
        const loc = node?.lines ?? 0;
        const symbolCount = node?.symbolCount ?? 0;
        return {
          fileId: score.id,
          centrality: score.totalDegree, // degree centrality
          fanIn,
          fanOut,
          blastRadius: score.dependentCount, // transitive dependents (reverse reachability)
          complexity: loc + symbolCount + fanIn + fanOut, // STRUCTURAL proxy (declared)
        };
      });
      perFile.sort((a, b) => a.fileId.localeCompare(b.fileId)); // deterministic storage order

      // Rankings answer "what is load-bearing in the PRODUCT": source files first, ordered by
      // degree over production edges only (a heavily-tested module is not thereby central),
      // then every other file. perFile keeps the full, unfiltered numbers.
      const roleOf = (id: string) => nodeByPath.get(id)?.layer;
      const productionDegree = new Map<string, number>();
      for (const edge of repoGraph.edges) {
        if (roleOf(edge.from) === "test" || roleOf(edge.to) === "test") continue;
        productionDegree.set(edge.from, (productionDegree.get(edge.from) ?? 0) + 1);
        productionDegree.set(edge.to, (productionDegree.get(edge.to) ?? 0) + 1);
      }
      const sourceFirst = (a: FileMetrics, b: FileMetrics) =>
        Number(roleOf(b.fileId) === "source") - Number(roleOf(a.fileId) === "source");
      const keyFiles = [...perFile]
        .sort(
          (a, b) =>
            sourceFirst(a, b) ||
            (productionDegree.get(b.fileId) ?? 0) - (productionDegree.get(a.fileId) ?? 0) ||
            b.centrality - a.centrality ||
            a.fileId.localeCompare(b.fileId),
        )
        .map((file) => file.fileId);
      const hotspots = [...perFile]
        .sort((a, b) => sourceFirst(a, b) || b.complexity - a.complexity || a.fileId.localeCompare(b.fileId))
        .map((file) => file.fileId);

      // findCircularDependencies returns each cycle as an array of node paths (=== fileId),
      // each rotation-normalized. Sort the cycle list deterministically.
      // Cycles are LOAD-TIME cycles: an edge that is erased (`import type`, TYPE_CHECKING), deferred
      // into a function body, or a dynamic import() cannot participate in an import-order failure.
      // Counting them is the classic false positive (requests: 18 reported, most type-only).
      const runtimeEdges = repoGraph.edges.filter((edge) => !edge.typeOnly && !edge.lazy && edge.kind !== "dynamic");
      const runtimeGraph =
        runtimeEdges.length === repoGraph.edges.length
          ? liveGraph
          : buildDependencyGraph({ files: repoGraph.nodes, dependencies: runtimeEdges.map(toDependencyEdge) });
      const cycles = findCircularDependencies(runtimeGraph)
        .map((files) => ({ files }))
        .sort((a, b) => a.files.join("\u0000").localeCompare(b.files.join("\u0000")));

      const isolatedFileCount = detectIsolatedFiles(liveGraph).length;
      const maxBlastRadius = perFile.reduce((max, file) => Math.max(max, file.blastRadius), 0);

      // Community detection runs on the RICHER graph — dependency edges PLUS the weighted
      // call/inheritance edges — because coupling for the purpose of clustering genuinely
      // includes calls, and "A calls 40 symbols in B" is stronger than "A imports a type
      // from B". The degree metrics above deliberately stay import-only (their contract).
      // Deterministic by construction: fixed seed, no RNG, canonical community ids.
      const clusters = repoGraph.nodes.length
        ? detectCommunities(
            buildCodePropertyGraph({
              nodes: repoGraph.nodes,
              edges: repoGraph.edges,
              cpgEdges: repoGraph.cpgEdges,
            }),
            deps.communities,
          )
        : undefined;

      const metrics: RepoMetrics = {
        perFile,
        keyFiles,
        hotspots,
        cycles,
        ...(clusters ? { clusters } : {}),
        summary: {
          fileCount: repoGraph.nodes.length,
          edgeCount: repoGraph.edges.length,
          cycleCount: cycles.length,
          isolatedFileCount,
          maxBlastRadius,
        },
      };

      const clusterDetail = clusters
        ? `, ${clusters.count} modules (modularity ${clusters.modularity.toFixed(3)})`
        : "";
      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "analyze",
        stageIndex: 6,
        stageCount: 6,
        kind: "deterministic",
        status: "completed",
        label: "Analyzing",
        detail: `Ranked ${keyFiles.length} key files, ${cycles.length} cycles, ${isolatedFileCount} isolated${clusterDetail}.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          keyFiles: keyFiles.length,
          cycles: cycles.length,
          maxBlastRadius,
          isolatedFiles: isolatedFileCount,
          clusters: clusters?.count ?? 0,
          modularity: clusters?.modularity ?? 0,
        },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { metrics }, event };
    },
  };
}

/** RepoDependencyEdge (plain) → rich DependencyEdge for @codeflow/graph reconstruction.
 *  Edge *type* doesn't affect centrality/cycles/blast (they use adjacency only). */
function toDependencyEdge(edge: RepoDependencyEdge, index: number): DependencyEdge {
  const dependencyType =
    edge.kind === "dynamic" ? "dynamic-import" : edge.kind === "require" ? "require" : "import";
  return {
    id: `${edge.from}->${edge.to}:${index + 1}`,
    source: edge.from,
    target: edge.to,
    from: edge.from,
    to: edge.to,
    kind: "import",
    weight: 1,
    dependencyType,
    confidence: 1,
    evidence: edge.specifier,
  };
}
