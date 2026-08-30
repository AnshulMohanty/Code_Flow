import { describe, expect, it } from "vitest";
import type { AnalysisResult, CpgEdge, FileNode, RepoDependencyEdge } from "@codeflow/shared-types";
import {
  createMemoryChunkTextStore,
  createMemoryVectorStore,
  createLexicalOverlapReranker,
} from "@codeflow/retrieval";
import type { EmbeddingClient } from "@codeflow/analyzers";
import { createMcpServerCore } from "../server.js";
import { buildMcpTools } from "../tools.js";
import { createScopePolicy, MCP_SCOPES, parseScopes, SCOPE_DESCRIPTIONS } from "../scope.js";

// V3-P5 task 3. Two kinds of test here: a CONTRACT test per tool (name, scope, schema, and that the
// handler returns text rather than throwing), and the behaviours whose failure would be a security or
// usability problem — a scope that defaults open, an unknown-scope typo that silently permits, or a
// throwing handler that looks to a client like the server died.

const NAMESPACE = "acme/repo@" + "a".repeat(40) + "/mock-embed/3";
const SPACE = { embeddingModel: "mock-embed", embeddingDim: 3 };

function node(id: string): FileNode {
  return { id, path: id, name: id.split("/").pop()!, layer: "source", language: "TypeScript", lines: 20, symbolCount: 1 };
}

/**
 * index.ts → auth.ts (imports + calls), auth.ts → util.ts, orphan.ts isolated.
 * Small on purpose: every expected answer below is checkable by eye.
 */
function fixtureResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  const ids = ["src/index.ts", "src/auth.ts", "src/util.ts", "src/orphan.ts"];
  const nodes = ids.map(node);
  const edges: RepoDependencyEdge[] = [
    { from: "src/index.ts", to: "src/auth.ts", kind: "import", specifier: "./auth" },
    { from: "src/auth.ts", to: "src/util.ts", kind: "import", specifier: "./util" },
  ];
  const cpgEdges: CpgEdge[] = [
    { from: "src/index.ts", to: "src/auth.ts", kind: "call", symbol: "login", count: 2, line: 3 },
  ];
  return {
    id: "analysis-mcp",
    repository: { provider: "github", owner: "acme", name: "repo" },
    mode: "public_hosted",
    createdAt: "2026-08-31T00:00:00.000Z",
    commitSha: "a".repeat(40),
    warnings: [],
    summary: {
      repository: { provider: "github", owner: "acme", name: "repo" },
      mode: "public_hosted",
      files: nodes.length,
      functions: 2,
      connections: edges.length,
      healthScore: 80,
      healthGrade: "B",
    },
    files: nodes,
    symbols: [],
    dependencies: [],
    issues: [],
    graph: {
      nodes,
      edges,
      resolution: { resolved: 2, external: 0, unresolved: 0, externalModules: [], unresolvedImports: [] },
      cpgEdges,
      routes: [],
      cpg: { treeSitterFiles: nodes.length, fallbackFiles: 0, enriched: true },
    },
    inventory: {
      symbols: [
        {
          name: "AuthService",
          kind: "class",
          filePath: "src/auth.ts",
          line: 3,
          endLine: 18,
          exported: true,
          language: "TypeScript",
          signature: "export class AuthService {",
        },
      ],
      entryPoints: [{ filePath: "src/index.ts", kind: "index", evidence: "filename-convention" }],
      symbolCount: 1,
      loc: {},
    },
    entryPoints: [{ fileId: "src/index.ts", reason: "index" }],
    metrics: {
      perFile: [],
      keyFiles: ["src/index.ts", "src/auth.ts"],
      hotspots: [],
      cycles: [],
      summary: { fileCount: nodes.length, edgeCount: edges.length, cycleCount: 0, isolatedFileCount: 1, maxBlastRadius: 2 },
      clusters: {
        algorithm: "louvain",
        seed: 42,
        resolution: 1,
        modularity: 0.35,
        count: 2,
        assignments: ids.map((fileId) => ({ fileId, cluster: fileId === "src/orphan.ts" ? 1 : 0 })),
        clusters: [
          { id: 0, files: ["src/auth.ts", "src/index.ts", "src/util.ts"], size: 3, internalWeight: 4, externalWeight: 0 },
          { id: 1, files: ["src/orphan.ts"], size: 1, internalWeight: 0, externalWeight: 0 },
        ],
      },
    },
    ai: {
      rag: {
        chunks: [{ id: "src/auth.ts#3-18", fileId: "src/auth.ts", startLine: 3, endLine: 18, symbolName: "AuthService", tokenCount: 20 }],
        chunkCount: 1,
        embeddingModel: "mock-embed",
        embeddingDim: 3,
        store: { namespace: NAMESPACE, vectorStoreId: "memory-vector-store", textStoreId: "memory-chunk-text-store" },
      },
    },
    ...overrides,
  };
}

function mockEmbed(): EmbeddingClient {
  return {
    provider: "voyage",
    model: "mock-embed",
    dimension: 3,
    async embed(request) {
      return {
        vectors: request.texts.map((text) => (text.toLowerCase().includes("auth") ? [1, 0, 0] : [0, 0, 1])),
        usage: { inputTokens: 5, outputTokens: 0, measured: true },
      };
    },
  };
}

async function retrievalDeps() {
  const vectorStore = createMemoryVectorStore(SPACE);
  const textStore = createMemoryChunkTextStore();
  await textStore.put(NAMESPACE, [{ id: "src/auth.ts#3-18", text: "export class AuthService { login() {} }" }]);
  await vectorStore.upsert(NAMESPACE, [
    { id: "src/auth.ts#3-18", vector: [1, 0, 0], fileId: "src/auth.ts", startLine: 3, endLine: 18, symbolName: "AuthService" },
  ]);
  return { vectorStore, textStore, embeddingClient: mockEmbed(), reranker: createLexicalOverlapReranker() };
}

function core(scopes: readonly (typeof MCP_SCOPES)[number][], options: { retrieval?: Awaited<ReturnType<typeof retrievalDeps>>; result?: AnalysisResult; loadError?: string } = {}) {
  return createMcpServerCore({
    scopes,
    deps: {
      loadResult: async () => {
        if (options.loadError) throw new Error(options.loadError);
        return options.result ?? fixtureResult();
      },
      ...(options.retrieval ? { retrieval: options.retrieval } : {}),
    },
  });
}

async function text(server: ReturnType<typeof core>, name: string, args: Record<string, unknown> = {}) {
  const result = await server.callTool(name, args);
  return { body: result.content.map((entry) => entry.text).join("\n"), isError: result.isError === true };
}

describe("parseScopes — DEFAULT-DENY", () => {
  it("an absent or empty value enables NOTHING", () => {
    // A server that silently enabled everything because nobody set an env var is the most likely way
    // this gets misconfigured, and the failure would be invisible until a bill arrived.
    expect(parseScopes(undefined).scopes).toEqual([]);
    expect(parseScopes("").scopes).toEqual([]);
    expect(parseScopes("   ").scopes).toEqual([]);
  });

  it("parses a list, deduped and sorted", () => {
    expect(parseScopes("verify, graph graph").scopes).toEqual(["graph", "verify"]);
  });

  it("accepts `all` as an EXPLICIT opt-in — the point is that it has to be typed", () => {
    expect(parseScopes("all").scopes).toEqual([...MCP_SCOPES]);
  });

  it("REJECTS an unknown scope rather than ignoring it", () => {
    // A typo that silently denies is a debugging session; one that silently permits is an incident.
    const parsed = parseScopes("graph, gaph");
    expect(parsed.scopes).toEqual(["graph"]);
    expect(parsed.errors[0]).toMatch(/unknown scope "gaph"/);
  });

  it("every scope has a description an operator can act on", () => {
    for (const scope of MCP_SCOPES) expect(SCOPE_DESCRIPTIONS[scope].length).toBeGreaterThan(30);
    // The retrieval description must warn that it SPENDS — that is the decision an operator is making.
    expect(SCOPE_DESCRIPTIONS.retrieval).toMatch(/PAID/);
  });
});

describe("createScopePolicy", () => {
  it("allows only what was enabled", () => {
    const policy = createScopePolicy(["graph"]);
    expect(policy.allows("graph")).toBe(true);
    expect(policy.allows("retrieval")).toBe(false);
    expect(policy.enabled()).toEqual(["graph"]);
  });
});

describe("tool surface — a denied tool is ABSENT, not present-and-refusing", () => {
  it("hides every tool when no scope is enabled", () => {
    const server = core([]);
    expect(server.listTools()).toEqual([]);
    expect(server.describe()).toMatch(/NO SCOPES ENABLED/);
  });

  it("exposes only the graph tools under the graph scope", async () => {
    // An advertised tool that always refuses wastes a turn every time a model tries it; one that was
    // never advertised is never tried.
    const names = core(["graph"]).listTools().map((tool) => tool.name);
    expect(names.sort()).toEqual(["find_references", "get_blast_radius", "get_callers", "graph_facts", "symbol_search"]);
    expect(names).not.toContain("search_code");
    expect(names).not.toContain("verify_answer");
  });

  it("omits search_code when the retrieval scope is on but no provider is wired", () => {
    // A search tool that always fails for want of a key is worse than an absent one.
    expect(core(["retrieval"]).listTools()).toEqual([]);
  });

  it("exposes search_code once retrieval is wired", async () => {
    const server = core(["retrieval"], { retrieval: await retrievalDeps() });
    expect(server.listTools().map((tool) => tool.name)).toEqual(["search_code"]);
  });

  it("advertises the SCOPE in each description, so a model can see what spends money", async () => {
    const server = core(["retrieval"], { retrieval: await retrievalDeps() });
    const tool = server.listTools()[0];
    expect(tool.description).toMatch(/\[scope: retrieval\]/);
    expect(tool.description).toMatch(/PAID provider call/);
  });

  it("gives every tool a JSON Schema with declared required args", () => {
    for (const tool of core(["graph", "verify"]).listTools()) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
    }
    const callers = core(["graph"]).listTools().find((tool) => tool.name === "get_callers");
    expect(callers?.inputSchema.required).toEqual(["fileId"]);
  });

  it("describe() lists the exposed surface, so an operator can see what they enabled", () => {
    const described = core(["graph", "verify"]).describe();
    expect(described).toMatch(/\[graph\]/);
    expect(described).toMatch(/\[verify\]/);
    expect(described).toContain("get_callers");
    expect(described).toContain("verify_answer");
  });
});

describe("graph tools — the SAME objects the internal agent uses", () => {
  const server = core(["graph"]);

  it("get_callers answers from the CPG", async () => {
    const { body, isError } = await text(server, "get_callers", { fileId: "src/auth.ts" });
    expect(isError).toBe(false);
    expect(body).toContain("1 file(s) call into src/auth.ts");
    expect(body).toContain("src/index.ts");
  });

  it("an EMPTY answer is not an error", async () => {
    // "nothing calls this file" is a correct, useful answer; marking it an error would push a model
    // to retry a question that was already answered.
    const { body, isError } = await text(server, "get_callers", { fileId: "src/orphan.ts" });
    expect(isError).toBe(false);
    expect(body).toContain("0 file(s) call into");
  });

  it("find_references labels direction", async () => {
    const { body } = await text(server, "find_references", { fileId: "src/auth.ts" });
    expect(body).toContain("imported by: src/index.ts");
    expect(body).toContain("imports: src/util.ts");
  });

  it("get_blast_radius returns transitive dependents", async () => {
    const { body } = await text(server, "get_blast_radius", { fileId: "src/util.ts" });
    expect(body).toContain("src/auth.ts");
    expect(body).toContain("src/index.ts");
  });

  it("symbol_search returns file + line + signature", async () => {
    const { body } = await text(server, "symbol_search", { name: "AuthService" });
    expect(body).toContain("src/auth.ts:3");
    expect(body).toContain("export class AuthService {");
  });

  it("graph_facts answers 'what am I looking at' in ONE call", async () => {
    // An external agent's first question, answered without spending three turns on it.
    const { body } = await text(server, "graph_facts");
    expect(body).toContain("repository: acme/repo");
    expect(body).toContain("files: 4");
    expect(body).toContain("entry points: src/index.ts");
    expect(body).toContain("code communities: 2");
    expect(body).toContain("searchable chunks: 1");
  });

  it("an MCP call is STATELESS — no 'it' leaks in from another caller", async () => {
    // Session memory is empty by construction, so a missing fileId cannot resolve to some other
    // caller's entity and answer about the wrong file.
    const { body, isError } = await text(server, "get_callers", {});
    expect(isError).toBe(false);
    expect(body).toContain("Could not resolve which file");
  });
});

describe("search_code over MCP", () => {
  it("returns chunks with citable coordinates", async () => {
    const server = core(["retrieval"], { retrieval: await retrievalDeps() });
    const { body, isError } = await text(server, "search_code", { query: "auth service" });
    expect(isError).toBe(false);
    expect(body).toContain("src/auth.ts#3-18");
    expect(body).toContain("lines 3-18");
  });

  it("keeps the similarity-floor refusal — an MCP caller cannot argue past it either", async () => {
    const server = core(["retrieval"], { retrieval: await retrievalDeps() });
    const { body } = await text(server, "search_code", { query: "quantum beekeeping" });
    expect(body).toMatch(/No code in this repository is relevant/);
    expect(body).toMatch(/Do not guess an answer from outside the repository/);
  });
});

describe("verify_answer — an EXACT verdict, no model", () => {
  const server = core(["verify"]);

  it("PASSES a correct claim and reports precision/recall", async () => {
    const { body, isError } = await text(server, "verify_answer", {
      kind: "who-calls",
      fileId: "src/auth.ts",
      claimedFileIds: "src/index.ts",
    });
    expect(isError).toBe(false);
    expect(body).toContain("verdict: PASS");
    expect(body).toContain("no model consulted");
    expect(body).toContain("recall: 1.000");
  });

  it("FAILS a wrong claim and names what it missed", async () => {
    const { body } = await text(server, "verify_answer", {
      kind: "who-calls",
      fileId: "src/auth.ts",
      claimedFileIds: "src/util.ts",
    });
    expect(body).toContain("verdict: FAIL");
    expect(body).toMatch(/missed: src\/index\.ts/);
  });

  it("names a FABRICATED file specifically — worse than naming the wrong real one", async () => {
    const { body } = await text(server, "verify_answer", {
      kind: "who-calls",
      fileId: "src/auth.ts",
      claimedFileIds: "src/index.ts, src/imaginary.ts",
    });
    expect(body).toMatch(/NOT IN THE REPOSITORY \(fabricated\)/);
  });

  it("REFUSES a question it cannot grade exactly, rather than guessing", async () => {
    // A verifier that quietly falls back to an opinion is worse than one that says no.
    const { body, isError } = await text(server, "verify_answer", {
      kind: "is-this-good-code",
      claimedFileIds: "src/auth.ts",
    });
    expect(isError).toBe(true);
    expect(body).toMatch(/cannot grade/);
    expect(body).toMatch(/will not guess/);
  });

  it("needs a fileId for a file-scoped kind, but not for entry-points", async () => {
    expect((await text(server, "verify_answer", { kind: "who-calls", claimedFileIds: "x" })).isError).toBe(true);
    const entry = await text(server, "verify_answer", { kind: "entry-points", claimedFileIds: "src/index.ts" });
    expect(entry.isError).toBe(false);
    expect(entry.body).toContain("verdict: PASS");
  });

  it("accepts a comma-separated string OR an array — both are shapes models produce", async () => {
    const asArray = await text(server, "verify_answer", {
      kind: "imports-of",
      fileId: "src/auth.ts",
      claimedFileIds: ["src/index.ts"],
    });
    expect(asArray.body).toContain("verdict: PASS");
  });
});

describe("error handling — a broken server must not look like a dead one", () => {
  it("an unknown tool NAMES the available ones, so a model recovers in one turn", async () => {
    const { body, isError } = await text(core(["graph"]), "nope");
    expect(isError).toBe(true);
    expect(body).toMatch(/Unknown tool "nope"/);
    expect(body).toContain("get_callers");
  });

  it("says so when no scopes are enabled at all", async () => {
    const { body } = await text(core([]), "get_callers", { fileId: "x" });
    expect(body).toMatch(/no scopes enabled/);
  });

  it("a failure to LOAD the analysis is a readable tool error, not a crash", async () => {
    // The result is loaded lazily, so a missing file cannot take the server down at boot.
    const { body, isError } = await text(core(["graph"], { loadError: "ENOENT: result.json" }), "graph_facts");
    expect(isError).toBe(true);
    expect(body).toMatch(/graph_facts.*failed/);
    expect(body).toMatch(/ENOENT/);
  });

  it("DENIES a tool whose scope is off even if it were somehow listed (defence in depth)", async () => {
    // Cannot normally fire — a tool outside the scopes is never built. It stays because "the list is
    // the only gate" is one refactor away from being false.
    const tools = buildMcpTools({ loadResult: async () => fixtureResult() }, () => true);
    const denying = createScopePolicy(["graph"]);
    const verify = tools.find((tool) => tool.name === "verify_answer");
    expect(verify).toBeDefined();
    expect(denying.allows(verify!.scope)).toBe(false);
  });

  it("returns text content for every tool, on every path", async () => {
    // The MCP contract: content is always a non-empty text array, success or failure.
    const server = core(["graph", "verify"]);
    for (const tool of server.listTools()) {
      const result = await server.callTool(tool.name, {});
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    }
  });
});
