import type { McpToolDefinition, McpToolDeps } from "./tools.js";
import { buildMcpTools } from "./tools.js";
import { createScopePolicy, SCOPE_DESCRIPTIONS, type McpScope } from "./scope.js";

/**
 * The MCP server, assembled but transport-agnostic (V3-P5 task 3).
 *
 * WHY THE HANDLERS ARE SEPARATED FROM THE SDK. `listTools` and `callTool` below are plain functions
 * over plain data, so the hermetic suite tests the ACTUAL request/response behaviour — including
 * scope denial and every error path — with no stdio, no subprocess and no protocol handshake.
 * `index.ts` then binds them to the SDK's stdio transport in about fifteen lines. Testing through
 * the SDK instead would mean spawning a process to assert on a string, and the thing being tested
 * would mostly be the SDK.
 */

export interface McpServerOptions {
  scopes: readonly McpScope[];
  deps: McpToolDeps;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: McpToolDefinition["inputSchema"];
}

/** The MCP `content` shape. */
export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpServerCore {
  listTools(): ListedTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** For the startup banner — an operator should be able to see the surface they just exposed. */
  describe(): string;
}

export function createMcpServerCore(options: McpServerOptions): McpServerCore {
  const policy = createScopePolicy(options.scopes);
  const tools = buildMcpTools(options.deps, policy.allows);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    listTools() {
      // The SCOPE is appended to each description, so a calling model can see that `search_code`
      // spends money without an operator having to document it separately.
      return tools.map((tool) => ({
        name: tool.name,
        description: `${tool.description} [scope: ${tool.scope}]`,
        inputSchema: tool.inputSchema,
      }));
    },

    async callTool(name, args) {
      const tool = byName.get(name);
      if (!tool) {
        // Names the tools that DO exist. A bare "unknown tool" makes a model guess again, which
        // costs a turn; listing the surface lets it recover in one.
        return errorResult(
          `Unknown tool "${name}". Available: ${[...byName.keys()].join(", ") || "(none — no scopes enabled)"}.`,
        );
      }
      // Defence in depth: a tool outside the enabled scopes is never built, so this cannot normally
      // fire. It stays because "the list is the only gate" is one refactor away from being false.
      if (!policy.allows(tool.scope)) {
        return errorResult(`Tool "${name}" requires the "${tool.scope}" scope, which is not enabled.`);
      }

      try {
        const outcome = await tool.handler(args, options.deps);
        return {
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        };
      } catch (error) {
        // A THROWING handler is a bug in this server, not a protocol failure — so it comes back as a
        // tool error the model can read, rather than as a transport-level exception that would look
        // to the client like the server died.
        return errorResult(
          `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    describe() {
      const enabled = policy.enabled();
      if (enabled.length === 0) {
        return (
          "CodeFlow MCP: NO SCOPES ENABLED — every tool is hidden.\n" +
          "  Set CODEFLOW_MCP_SCOPES (e.g. `graph,verify`, or `all`). Default-deny is deliberate."
        );
      }
      const lines = [`CodeFlow MCP: ${tools.length} tool(s) across ${enabled.length} scope(s).`];
      for (const scope of enabled) {
        lines.push(`  [${scope}] ${SCOPE_DESCRIPTIONS[scope]}`);
        for (const tool of tools.filter((entry) => entry.scope === scope)) lines.push(`      - ${tool.name}`);
      }
      return lines.join("\n");
    },
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
