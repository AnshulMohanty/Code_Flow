import {
  createBlastRadiusTool,
  createFindReferencesTool,
  createGetCallersTool,
  createSearchTool,
  createSymbolSearchTool,
  type AgentTool,
  type ToolContext,
} from "@codeflow/agents";
import { createGraphOracleVerifier, createSandbox, truthFor, type OracleQuestionKind } from "@codeflow/arena";
import { emptySession } from "@codeflow/memory";
import type { AnalysisResult } from "@codeflow/shared-types";
import type { ChunkTextStore, Reranker, VectorStore } from "@codeflow/retrieval";
import type { EmbeddingClient } from "@codeflow/analyzers";
import type { McpScope } from "./scope.js";

/**
 * THE MCP TOOL SURFACE (V3-P5 task 3).
 *
 * WHAT IS BEING EXPOSED, and why it is worth exposing. An external agent (Cursor, Claude Code,
 * Windsurf) already has file search and a grep. What it does NOT have is a code property graph — so
 * the tools that earn their place here are the ones that answer questions grep cannot: who CALLS
 * this, what BREAKS if I change it, is this claim actually TRUE. The retrieval tool is included
 * because semantic search over a pre-built index is genuinely different from a text search, and the
 * VERIFIER is included because it is the most unusual thing this engine has: an external agent can
 * ask "is my answer grounded?" and get an exact, free, non-arguable verdict.
 *
 * THE TOOLS ARE THE SAME OBJECTS THE INTERNAL AGENT USES. `createGetCallersTool()` and friends come
 * straight from `@codeflow/agents`; this file adapts them to MCP, it does not reimplement them. That
 * is the whole reason the internal agent and an external one cannot drift apart on what "who calls
 * this" means — there is one implementation, and P3's 91 tests already cover it.
 *
 * MCP SCHEMAS ARE HAND-WRITTEN JSON SCHEMA, deliberately. The SDK wants JSON Schema for its
 * `inputSchema`, and this repo has no zod (and is not getting a zod migration). Hand-writing a
 * five-line schema per tool is less code than a converter and it is the untrusted-input boundary
 * where the V3-P0 rule says validation belongs — so the schema is the contract the SDK enforces, and
 * each handler still checks what it actually needs.
 */

export interface McpToolDeps {
  /** Loads the frozen analysis an MCP call operates on. Injected — see `index.ts`. */
  loadResult(): Promise<AnalysisResult>;
  /** Retrieval stores, when the `retrieval` scope is enabled. */
  retrieval?: {
    vectorStore: VectorStore;
    textStore: ChunkTextStore;
    embeddingClient: EmbeddingClient;
    reranker?: Reranker;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  scope: McpScope;
  /** JSON Schema for the arguments — what the SDK validates against. */
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  /** Returns text for the model. NEVER throws: an MCP error is a protocol-level failure, whereas a
   *  tool that could not answer is an ANSWER, and the two must not look alike to a caller. */
  handler(args: Record<string, unknown>, deps: McpToolDeps): Promise<{ text: string; isError?: boolean }>;
}

/** A `ToolContext` for the shared agent tools. Session memory is EMPTY on purpose: an MCP call is
 *  stateless, so there is no "it" to resolve, and a tool that silently reused another caller's
 *  entity would answer about the wrong file. */
function statelessContext(result: AnalysisResult): ToolContext {
  return { result, memory: emptySession("mcp", result.id) };
}

/** Adapt one shared `AgentTool` into an MCP tool. */
function fromAgentTool(
  tool: AgentTool,
  options: { name: string; scope: McpScope; description: string; inputSchema: McpToolDefinition["inputSchema"] },
): McpToolDefinition {
  return {
    name: options.name,
    description: options.description,
    scope: options.scope,
    inputSchema: options.inputSchema,
    async handler(args, deps) {
      const result = await deps.loadResult();
      const outcome = await tool.run(args, statelessContext(result));
      if (outcome.error) return { text: `${options.name} failed: ${outcome.error}`, isError: true };
      // `empty` is NOT an error: "nothing calls this file" is a correct, useful answer, and marking
      // it as an error would push a calling model to retry a question that was already answered.
      return { text: outcome.text };
    },
  };
}

const FILE_ID_SCHEMA: McpToolDefinition["inputSchema"] = {
  type: "object",
  properties: {
    fileId: { type: "string", description: "Repo-relative POSIX path, e.g. src/auth/tokenService.ts" },
  },
  required: ["fileId"],
};

/**
 * Build the tool list for the enabled scopes.
 *
 * A tool whose scope is not enabled is simply ABSENT from the list rather than present-and-denied.
 * That matters for a model: an advertised tool that always refuses wastes a turn every time it is
 * tried, whereas a tool that was never advertised is never tried.
 */
export function buildMcpTools(deps: McpToolDeps, allows: (scope: McpScope) => boolean): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];

  if (allows("graph")) {
    tools.push(
      fromAgentTool(createFindReferencesTool(), {
        name: "find_references",
        scope: "graph",
        description:
          "Every file structurally connected to a file, LABELLED by direction (imports it / imported by it / " +
          "calls it / called by it). Exact, from the code graph — not a text search.",
        inputSchema: FILE_ID_SCHEMA,
      }),
      fromAgentTool(createGetCallersTool(), {
        name: "get_callers",
        scope: "graph",
        description:
          "Files that CALL INTO a file (call + inheritance edges from the code property graph). " +
          "Resolved through the caller's own imports, so a dynamic call with no import is not represented.",
        inputSchema: FILE_ID_SCHEMA,
      }),
      fromAgentTool(createBlastRadiusTool(), {
        name: "get_blast_radius",
        scope: "graph",
        description:
          "Every file transitively affected if a file changes (reverse reachability over the dependency graph). " +
          "Answers 'what breaks if I touch this'.",
        inputSchema: FILE_ID_SCHEMA,
      }),
      fromAgentTool(createSymbolSearchTool(), {
        name: "symbol_search",
        scope: "graph",
        description:
          "Locate declared symbols (functions, classes, methods, types) by name; returns file + line + signature. " +
          "Exact matches win; otherwise a bounded substring search.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", description: "Symbol name, exact or partial." } },
          required: ["name"],
        },
      }),
      graphFactsTool(),
    );
  }

  if (allows("retrieval") && deps.retrieval) {
    const searchTool = createSearchTool({
      vectorStore: deps.retrieval.vectorStore,
      textStore: deps.retrieval.textStore,
      embeddingClient: deps.retrieval.embeddingClient,
      ...(deps.retrieval.reranker ? { reranker: deps.retrieval.reranker } : {}),
    });
    tools.push(
      fromAgentTool(searchTool, {
        name: "search_code",
        scope: "retrieval",
        description:
          "Hybrid semantic + keyword search over the repository's indexed code. Returns chunks with file + line " +
          "ranges. Returns nothing when no indexed code is relevant — that is a real answer, not a reason to retry. " +
          "NOTE: embedding the query is a PAID provider call, so prefer the free graph tools when they can answer.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, in natural language or as an identifier." },
            k: { type: "number", description: "Max chunks to return (capped server-side)." },
          },
          required: ["query"],
        },
      }),
    );
  }

  if (allows("verify")) tools.push(verifyTool());

  return tools;
}

/**
 * `graph_facts` — the repository's shape in one call.
 *
 * Exists because an external agent's FIRST question is always "what am I looking at", and answering
 * it with four separate tool calls wastes three turns. Deterministic, free, and bounded.
 */
function graphFactsTool(): McpToolDefinition {
  return {
    name: "graph_facts",
    description:
      "Deterministic facts about the analysed repository: file count, entry points, most central files, " +
      "code communities, dependency cycles. Free and exact — a good first call.",
    scope: "graph",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, deps) {
      const result = await deps.loadResult();
      const clusters = result.metrics?.clusters;
      const lines = [
        `repository: ${result.repository.owner ? `${result.repository.owner}/` : ""}${result.repository.name}`,
        `commit: ${result.commitSha ?? "(unpinned)"}`,
        `files: ${result.graph?.nodes.length ?? result.files.length}`,
        `entry points: ${(result.entryPoints ?? []).map((entry) => entry.fileId).join(", ") || "none detected"}`,
        `most central files: ${(result.metrics?.keyFiles ?? []).slice(0, 10).join(", ") || "none"}`,
        clusters
          ? `code communities: ${clusters.count} (modularity ${clusters.modularity.toFixed(3)})`
          : "code communities: not computed",
        `dependency cycles: ${result.metrics?.cycles.length ?? 0}`,
        `call/inheritance edges: ${result.graph?.cpgEdges?.length ?? 0}`,
        `searchable chunks: ${result.ai?.rag?.chunkCount ?? 0}`,
      ];
      return { text: lines.join("\n") };
    },
  };
}

/**
 * `verify_answer` — the Arena verifier as a tool. The most unusual thing on this surface.
 *
 * An external agent can hand over a claim ("these files call X") and get an EXACT verdict with
 * precision/recall, derived from the graph with no model involved. That is qualitatively different
 * from asking another model to check: it is free, deterministic, and not arguable.
 *
 * The honest limit, stated to the caller too: it only grades questions the graph can answer exactly.
 * A request to verify anything else is REFUSED rather than answered with a guess, because a verifier
 * that quietly falls back to an opinion is worse than one that says no.
 */
function verifyTool(): McpToolDefinition {
  const kinds: readonly OracleQuestionKind[] = [
    "who-calls",
    "imports-of",
    "blast-radius",
    "entry-points",
    "cycle-through",
  ];
  return {
    name: "verify_answer",
    description:
      "Grade a claim about the repository against the code graph. EXACT and free — no model is consulted. " +
      `Supported question kinds: ${kinds.join(", ")}. Returns pass/fail with precision and recall, and names ` +
      "any file you claimed that does not exist. Only these kinds can be graded; anything else is refused.",
    scope: "verify",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: `One of: ${kinds.join(", ")}` },
        fileId: { type: "string", description: "The file the question is about (omit for entry-points)." },
        claimedFileIds: { type: "string", description: "Comma-separated repo-relative paths you are claiming." },
      },
      required: ["kind", "claimedFileIds"],
    },
    async handler(args, deps) {
      const kind = typeof args.kind === "string" ? (args.kind as OracleQuestionKind) : undefined;
      if (!kind || !kinds.includes(kind)) {
        return {
          text: `verify_answer cannot grade "${String(args.kind)}". Gradeable kinds: ${kinds.join(", ")}. ` +
            "This tool only reports what the graph can establish exactly; it will not guess.",
          isError: true,
        };
      }
      const fileId = typeof args.fileId === "string" && args.fileId.trim() ? args.fileId.trim() : undefined;
      if (kind !== "entry-points" && !fileId) {
        return { text: `verify_answer: "${kind}" needs a \`fileId\`.`, isError: true };
      }

      // Accept a comma/space-separated string OR an array — both are shapes a model produces, and
      // the difference is stylistic rather than meaningful.
      const claimed = Array.isArray(args.claimedFileIds)
        ? args.claimedFileIds.filter((value): value is string => typeof value === "string")
        : String(args.claimedFileIds ?? "")
            .split(/[,\s]+/)
            .map((value) => value.trim())
            .filter(Boolean);

      const result = await deps.loadResult();
      const sandbox = createSandbox(result);
      const verifier = createGraphOracleVerifier();
      const task = {
        id: "mcp-verify",
        question: `${kind}${fileId ? ` ${fileId}` : ""}`,
        repo: result.repository,
        commitSha: result.commitSha ?? "",
        oracle: { kind, ...(fileId ? { fileId } : {}) },
      };
      const verdict = await verifier.verify(task, { fileIds: claimed }, sandbox);
      const truth = truthFor(kind, result, fileId);

      return {
        text: [
          `verdict: ${verdict.passed ? "PASS" : "FAIL"} (exact, no model consulted)`,
          `recall: ${(verdict.reward.components.recall ?? 0).toFixed(3)} · precision: ${(verdict.reward.components.precision ?? 0).toFixed(3)}`,
          `truth (${truth.length} file(s)): ${truth.join(", ") || "none"}`,
          `you claimed (${claimed.length}): ${claimed.join(", ") || "none"}`,
          ...verdict.reward.notes.map((note) => `note: ${note}`),
        ].join("\n"),
      };
    },
  };
}
