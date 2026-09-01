import { buildImportGraph, getTransitiveDependents } from "@codeflow/graph";
import type { AnalysisResult } from "@codeflow/shared-types";
import { mostRecentEntity } from "@codeflow/memory";
import type { AgentTool, ToolArgs, ToolContext, ToolResult } from "../contracts.js";

/**
 * GRAPH TOOLS (V3-P3 task 1) — the agent's exact, free lookups.
 *
 * These are the reason an agentic Q&A path is better than a single retrieval call rather than
 * just more expensive. "Who calls this?" and "what breaks if I change it?" are FACTS in the
 * analysis result; retrieval can only find text that talks about them. Every tool here is
 * deterministic, costs nothing, and cannot hallucinate — it reads the same graph the metrics and
 * the Arena oracle read, using the same traversals, so the agent and the product cannot disagree
 * about what "affected" means.
 *
 * TWO DESIGN RULES applied throughout:
 *
 *   1. **A tool never invents a fileId.** Results are graph nodes, so anything the agent later
 *      cites from a tool is grounded by construction. That is what makes file-level citations
 *      trustworthy without a second check.
 *   2. **A tool resolves a REFERENCE from memory when its argument is missing or a pronoun.**
 *      "What about its callers?" is the acceptance criterion for this phase, and it is handled
 *      here — in code, deterministically — rather than by hoping the model restates the file. The
 *      resolution is reported in the tool's own text so a reader can see what "it" became.
 */

/** Pronoun-ish arguments a model produces when it means "the thing we were just discussing". */
const REFERENTIAL = new Set(["it", "its", "this", "that", "the file", "the same file", "there"]);

/**
 * Resolve a `fileId` argument: use it when it is a real graph node, otherwise fall back to the
 * most recently resolved file entity in session memory.
 *
 * Returns the resolution AND whether memory was used, because a tool that silently substituted a
 * different file than the model named would be impossible to debug from a transcript.
 */
export function resolveFileArg(
  args: ToolArgs,
  context: ToolContext,
  key = "fileId",
): { fileId: string | null; fromMemory: boolean; requested?: string } {
  const raw = args[key];
  const requested = typeof raw === "string" ? raw.trim() : undefined;
  const nodeIds = new Set((context.result.graph?.nodes ?? []).map((node) => node.id));

  if (requested && nodeIds.has(requested)) return { fileId: requested, fromMemory: false, requested };

  // A non-empty argument that is not a node might still be a suffix the model shortened
  // ("tokenService.ts" for "src/auth/tokenService.ts"). Accept a UNIQUE suffix match only —
  // an ambiguous one is worse than no match, because it would silently answer about the wrong file.
  if (requested && !REFERENTIAL.has(requested.toLowerCase())) {
    const matches = [...nodeIds].filter((id) => id === requested || id.endsWith(`/${requested}`)).sort();
    if (matches.length === 1) return { fileId: matches[0], fromMemory: false, requested };
  }

  const remembered = mostRecentEntity(context.memory, "file");
  if (remembered) return { fileId: remembered.value, fromMemory: true, requested };
  return { fileId: null, fromMemory: false, requested };
}

function unresolved(requested: string | undefined, what: string): ToolResult {
  return {
    text:
      `Could not resolve which file "${requested ?? "(none given)"}" refers to. ` +
      `Pass an exact repo-relative path from the repository, or ask about a specific file first. (${what})`,
    empty: true,
  };
}

/** Bounded list rendering: states the total when it truncates, so a prefix is never mistaken for
 *  the whole answer — the same rule the diff renderer follows. */
function renderList(items: readonly string[], limit = 25): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, limit);
  const suffix = items.length > shown.length ? ` (+${items.length - shown.length} more of ${items.length})` : "";
  return `${shown.join(", ")}${suffix}`;
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * `get_callers` — files with a CALL or inheritance edge into the target (V3-P1 `cpgEdges`).
 *
 * The honest limit, stated to the model as well as here: a cpgEdge target is resolved through the
 * calling file's own imports, so this is "files that call into it via an import it declares", not
 * a compiler-exact reference set. Saying so in the tool's own output matters — otherwise the
 * model presents an approximate answer as exhaustive.
 */
export function createGetCallersTool(): AgentTool {
  return {
    id: "get_callers",
    description:
      "get_callers(fileId) — files that CALL INTO a file (call + inheritance edges). Exact, from the code graph. " +
      "Resolved through the caller's own imports, so a dynamic call with no import is not represented.",
    args: ["fileId"],
    triggers: ["call", "calls", "caller", "callers", "invoke", "uses", "used by", "who uses"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const { fileId, fromMemory, requested } = resolveFileArg(args, context);
      if (!fileId) return unresolved(requested, "get_callers needs a file");
      const edges = context.result.graph?.cpgEdges ?? [];
      const callers = sorted(edges.filter((edge) => edge.to === fileId).map((edge) => edge.from));
      return {
        text:
          `${callers.length} file(s) call into ${fileId}${fromMemory ? " (resolved from the previous turn)" : ""}: ` +
          `${renderList(callers)}.` +
          (callers.length === 0 ? " Note: only call/inheritance edges resolvable through imports are known." : ""),
        fileIds: callers,
        empty: callers.length === 0,
      };
    },
  };
}

/**
 * `find_references` — every file structurally connected to the target, in EITHER direction, with
 * the direction labelled.
 *
 * Direction is labelled rather than collapsed because "imports X" and "is imported by X" are the
 * single most common confusion in dependency questions — the same confusion V3-P2's synthetic
 * flywheel mines as a hard negative. A tool that returned an undirected blob would be handing the
 * model exactly the ambiguity it is worst at.
 */
export function createFindReferencesTool(): AgentTool {
  return {
    id: "find_references",
    description:
      "find_references(fileId) — every file structurally connected to a file, labelled by direction " +
      "(imports it / imported by it / calls it / called by it). Exact, from the code graph.",
    args: ["fileId"],
    triggers: ["reference", "references", "related", "connected", "depends", "dependency", "dependencies", "import", "imports"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const { fileId, fromMemory, requested } = resolveFileArg(args, context);
      if (!fileId) return unresolved(requested, "find_references needs a file");
      const graph = context.result.graph;
      const edges = graph?.edges ?? [];
      const cpgEdges = graph?.cpgEdges ?? [];

      const importedBy = sorted(edges.filter((edge) => edge.to === fileId).map((edge) => edge.from));
      const imports = sorted(edges.filter((edge) => edge.from === fileId).map((edge) => edge.to));
      const calledBy = sorted(cpgEdges.filter((edge) => edge.to === fileId).map((edge) => edge.from));
      const calls = sorted(cpgEdges.filter((edge) => edge.from === fileId).map((edge) => edge.to));
      const all = sorted([...importedBy, ...imports, ...calledBy, ...calls]);

      return {
        text:
          `References for ${fileId}${fromMemory ? " (resolved from the previous turn)" : ""}:\n` +
          `- imported by: ${renderList(importedBy)}\n` +
          `- imports: ${renderList(imports)}\n` +
          `- called by: ${renderList(calledBy)}\n` +
          `- calls: ${renderList(calls)}`,
        fileIds: all,
        empty: all.length === 0,
      };
    },
  };
}

/**
 * `get_blast_radius` — transitive dependents: everything affected if the target changes.
 *
 * Computed with `@codeflow/graph`'s own traversal, the same one the metrics and the Arena oracle
 * use, so the agent's answer to "what breaks" cannot drift from the product's.
 */
export function createBlastRadiusTool(): AgentTool {
  return {
    id: "get_blast_radius",
    description:
      "get_blast_radius(fileId) — every file transitively affected if a file changes (reverse reachability). " +
      "Exact, from the code graph.",
    args: ["fileId"],
    triggers: ["break", "breaks", "affect", "affected", "impact", "blast", "radius", "change", "safe to"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const { fileId, fromMemory, requested } = resolveFileArg(args, context);
      if (!fileId) return unresolved(requested, "get_blast_radius needs a file");
      const graph = context.result.graph;
      if (!graph) return { text: "This analysis has no dependency graph.", empty: true };

      const live = buildImportGraph({ nodes: graph.nodes, edges: graph.edges });
      const affected = sorted(getTransitiveDependents(live, fileId).map((entry) => entry.node.id));
      return {
        text:
          `Changing ${fileId}${fromMemory ? " (resolved from the previous turn)" : ""} transitively affects ` +
          `${affected.length} file(s): ${renderList(affected)}.`,
        fileIds: affected,
        empty: affected.length === 0,
      };
    },
  };
}

/**
 * `symbol_search` — find declared symbols by name, exactly or by substring.
 *
 * Exact matches are returned ALONE when there are any. A substring search that also surfaced the
 * 40 symbols merely containing the query would bury the one the developer named, and the model
 * has no way to tell which of the 41 was meant.
 */
export function createSymbolSearchTool(): AgentTool {
  return {
    id: "symbol_search",
    description:
      "symbol_search(name) — locate declared symbols (functions, classes, methods, types) by name. " +
      "Returns file + line for each. Exact matches win; otherwise a bounded substring search.",
    args: ["name"],
    triggers: ["symbol", "function", "class", "method", "defined", "declared", "where is", "definition"],
    async run(args: ToolArgs, context: ToolContext): Promise<ToolResult> {
      const raw = args.name ?? args.symbol ?? args.query;
      const name = typeof raw === "string" ? raw.trim() : "";
      if (!name) {
        // Fall back to the last remembered SYMBOL, which is how "where is it declared?" works.
        const remembered = mostRecentEntity(context.memory, "symbol");
        if (!remembered) return { text: "symbol_search needs a `name` argument.", empty: true };
        return runSymbolSearch(remembered.value, context.result, true);
      }
      return runSymbolSearch(name, context.result, false);
    },
  };
}

function runSymbolSearch(name: string, result: AnalysisResult, fromMemory: boolean): ToolResult {
  const symbols = result.inventory?.symbols ?? [];
  const lower = name.toLowerCase();
  const exact = symbols.filter((symbol) => symbol.name === name);
  const matches = exact.length > 0 ? exact : symbols.filter((symbol) => symbol.name.toLowerCase().includes(lower));

  if (matches.length === 0) {
    return { text: `No declared symbol matching "${name}".`, empty: true };
  }
  // Sorted for determinism, then bounded: a substring query can legitimately match many symbols.
  const ordered = [...matches].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line || a.name.localeCompare(b.name),
  );
  const shown = ordered.slice(0, 25);
  const lines = shown.map(
    (symbol) =>
      `- ${symbol.name} (${symbol.kind}${symbol.exported ? ", exported" : ""}) at ${symbol.filePath}:${symbol.line}` +
      (symbol.signature ? ` — ${symbol.signature}` : ""),
  );
  const suffix = ordered.length > shown.length ? `\n(+${ordered.length - shown.length} more of ${ordered.length})` : "";

  return {
    text:
      `${exact.length > 0 ? "Exact" : "Substring"} matches for "${name}"` +
      `${fromMemory ? " (resolved from the previous turn)" : ""}:\n${lines.join("\n")}${suffix}`,
    fileIds: sorted(shown.map((symbol) => symbol.filePath)),
    empty: false,
  };
}

/** All four graph tools, in a stable order. */
export function createGraphTools(): AgentTool[] {
  return [
    createFindReferencesTool(),
    createGetCallersTool(),
    createBlastRadiusTool(),
    createSymbolSearchTool(),
  ];
}
