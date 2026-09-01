/**
 * THE SCOPE ALLOWLIST (V3-P5 task 3).
 *
 * An MCP server hands the engine to an agent running on someone else's machine. The brief asked for
 * a deliberate allowlist, and the reason is worth stating plainly: MCP tools are invoked by a MODEL,
 * so the threat model is not a malicious operator but a confused or manipulated one. Anything a tool
 * can do, a prompt-injected model can be talked into doing.
 *
 * So the design is: DEFAULT-DENY, three coarse scopes, and every tool declares exactly one.
 *
 *   graph     — exact, free, read-only lookups over the code property graph.
 *   retrieval — hybrid search. Read-only, but it SPENDS: a query embedding is a paid call.
 *   verify    — the Arena verifier. Exact, free, and the one tool that grades rather than reports.
 *
 * Three, not one per tool: a per-tool scope list looks safer and is actually worse, because nobody
 * reads a 12-item allowlist and the first person to hit a denial turns them all on. Three scopes
 * that map to "read facts" / "spend money" / "grade an answer" are decisions an operator can
 * genuinely make.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no scope for running an analysis, writing to a store, or
 * asking the Q&A agent. An MCP tool that could kick off a clone-and-analyse would let a remote model
 * spend the owner's entire daily budget in one call; a tool that could write would let it corrupt an
 * index. Those belong behind the HTTP API with its rate limit and its job queue, and their absence
 * here is a decision rather than an omission.
 */

export const MCP_SCOPES = ["graph", "retrieval", "verify"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Human-readable, for the server's startup log and for GO_LIVE.md. */
export const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  graph: "Exact, free, read-only lookups over the code graph (references, callers, blast radius, symbols).",
  retrieval: "Hybrid semantic + keyword code search. Read-only, but a query embedding is a PAID provider call.",
  verify: "Grade an answer against the graph with the Arena verifier. Exact, free, no model.",
};

export interface ScopePolicy {
  /** True when this scope may be used. */
  allows(scope: McpScope): boolean;
  /** The enabled scopes, sorted — for the startup log. */
  enabled(): McpScope[];
}

/**
 * Parse a scope list.
 *
 * DEFAULT-DENY when the value is absent or empty: a server that silently enabled everything because
 * nobody set an env var is the single most likely way this gets misconfigured, and the failure would
 * be invisible until a bill arrived. An unknown scope name is REJECTED rather than ignored, because
 * a typo in an allowlist that silently denies is a debugging session, and one that silently permits
 * is an incident.
 *
 * `"all"` is accepted as an explicit opt-in — the point is that it has to be typed.
 */
export function parseScopes(raw: string | undefined): { scopes: McpScope[]; errors: string[] } {
  const errors: string[] = [];
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { scopes: [], errors: [] };
  if (trimmed.toLowerCase() === "all") return { scopes: [...MCP_SCOPES], errors: [] };

  const scopes: McpScope[] = [];
  for (const part of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const candidate = part.toLowerCase();
    if ((MCP_SCOPES as readonly string[]).includes(candidate)) {
      if (!scopes.includes(candidate as McpScope)) scopes.push(candidate as McpScope);
    } else {
      errors.push(`unknown scope "${part}" (known: ${MCP_SCOPES.join(", ")})`);
    }
  }
  return { scopes: scopes.sort(), errors };
}

export function createScopePolicy(scopes: readonly McpScope[]): ScopePolicy {
  const allowed = new Set(scopes);
  return {
    allows: (scope) => allowed.has(scope),
    enabled: () => [...allowed].sort(),
  };
}
