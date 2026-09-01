#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { AnalysisResult } from "@codeflow/shared-types";
import { createEmbeddingClientFromEnv } from "@codeflow/analyzers";
import { createLexicalOverlapReranker, createRetrievalStores } from "@codeflow/retrieval";
import { createMcpServerCore } from "./server.js";
import { parseScopes, type McpScope } from "./scope.js";

/**
 * `codeflow-mcp` — the MCP server binary (V3-P5 task 3).
 *
 * Exposes the engine over MCP stdio so Cursor / Claude Code / Windsurf can call the code property
 * graph, hybrid retrieval and the Arena verifier. The protocol handling is the SDK's; everything
 * interesting lives in `server.ts` and `tools.ts`, which are tested without a transport.
 *
 * WHAT IT OPERATES ON. An MCP call needs an ANALYSIS, and there are two honest ways to get one:
 * point at a saved `AnalysisResult` JSON file (`CODEFLOW_MCP_RESULT`), or fetch one from a running
 * API (`CODEFLOW_MCP_API` + a job id). It deliberately does NOT run an analysis itself: a clone,
 * parse, embed and synthesise triggered by a remote model would spend the owner's entire daily
 * budget in one tool call, and MCP has no rate limit of its own. Producing the analysis stays behind
 * the HTTP API with its queue and its per-IP limit.
 *
 * The result is loaded LAZILY and cached, so starting the server costs nothing and a missing file is
 * reported as a tool error the model can read rather than a crash at boot.
 */

const env = {
  scopes: process.env.CODEFLOW_MCP_SCOPES,
  resultPath: process.env.CODEFLOW_MCP_RESULT,
  apiBase: process.env.CODEFLOW_MCP_API,
  jobId: process.env.CODEFLOW_MCP_JOB,
  postgresUrl: process.env.POSTGRES_URL || "",
};

/** Load the analysis once, then reuse. Errors are thrown so a tool handler turns them into a
 *  readable tool error — never a boot failure. */
function createResultLoader(): () => Promise<AnalysisResult> {
  let cached: Promise<AnalysisResult> | null = null;
  return () => {
    cached ??= (async () => {
      if (env.resultPath) {
        const raw = await readFile(env.resultPath, "utf8");
        return JSON.parse(raw) as AnalysisResult;
      }
      if (env.apiBase && env.jobId) {
        const response = await fetch(`${env.apiBase.replace(/\/$/, "")}/api/result/${env.jobId}`);
        if (!response.ok) throw new Error(`API returned HTTP ${response.status} for job ${env.jobId}`);
        const body = (await response.json()) as { result?: AnalysisResult };
        if (!body.result) throw new Error(`API response for job ${env.jobId} carried no result`);
        return body.result;
      }
      throw new Error(
        "No analysis configured. Set CODEFLOW_MCP_RESULT to a saved AnalysisResult JSON path, or " +
          "CODEFLOW_MCP_API + CODEFLOW_MCP_JOB to fetch one from a running API. This server does not " +
          "run analyses itself — see the note in apps/mcp/src/index.ts.",
      );
    })();
    return cached;
  };
}

async function main(): Promise<void> {
  const { scopes, errors } = parseScopes(env.scopes);
  for (const error of errors) {
    // stderr, never stdout: stdout IS the MCP protocol channel, and one stray line there corrupts
    // the stream for the client.
    console.error(`[codeflow-mcp] scope config: ${error}`);
  }
  if (errors.length > 0) {
    // A typo in an allowlist that silently DENIES is a debugging session; one that silently PERMITS
    // is an incident. Neither is acceptable, so an unparseable allowlist refuses to start.
    console.error("[codeflow-mcp] refusing to start with an unparseable scope list.");
    process.exit(1);
  }

  const loadResult = createResultLoader();

  // Retrieval is wired only when its scope is enabled AND a provider is configured — a search tool
  // that always fails for want of a key is worse than an absent one.
  let retrieval: Parameters<typeof createMcpServerCore>[0]["deps"]["retrieval"];
  if (scopes.includes("retrieval" as McpScope)) {
    const embeddingClient = createEmbeddingClientFromEnv(process.env);
    if (!embeddingClient) {
      console.error("[codeflow-mcp] retrieval scope requested but no embedding provider is configured; disabling it.");
    } else {
      const stores = await createRetrievalStores({
        space: { embeddingModel: embeddingClient.model, embeddingDim: embeddingClient.dimension },
        postgresUrl: env.postgresUrl,
      });
      if (stores.degradation) console.error(`[codeflow-mcp] retrieval DEGRADED — ${stores.degradation}`);
      retrieval = {
        vectorStore: stores.vectorStore,
        textStore: stores.textStore,
        embeddingClient,
        reranker: createLexicalOverlapReranker(),
      };
    }
  }

  const core = createMcpServerCore({
    scopes,
    deps: { loadResult, ...(retrieval ? { retrieval } : {}) },
  });
  console.error(core.describe());

  // The SDK is imported DYNAMICALLY so this module stays importable (and testable) without it, and
  // so a scope-config failure above exits before any protocol machinery is constructed.
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: "codeflow", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: core.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const outcome = await core.callTool(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
    // Widened to the SDK's index-signature result type. The cast is confined to this one line, at
    // the SDK boundary, so `core` stays a plain typed function the suite can test without the SDK.
    return outcome as unknown as Record<string, unknown>;
  });

  await server.connect(new StdioServerTransport());
  console.error("[codeflow-mcp] listening on stdio.");
}

main().catch((error: unknown) => {
  console.error(`[codeflow-mcp] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
