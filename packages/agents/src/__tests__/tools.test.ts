import { describe, expect, it } from "vitest";
import { appendTurn, createMemoryRepoStore, emptySession, snapshotOf } from "@codeflow/memory";
import { createLexicalOverlapReranker } from "@codeflow/retrieval";
import {
  createBlastRadiusTool,
  createFindReferencesTool,
  createGetCallersTool,
  createGraphTools,
  createSymbolSearchTool,
  resolveFileArg,
} from "../tools/graphTools.js";
import { createSearchTool } from "../tools/searchTool.js";
import { createWhatChangedTool } from "../tools/whatChangedTool.js";
import type { ToolContext } from "../contracts.js";
import { fixtureResult, fixtureStores, mockEmbed } from "./fixtures.js";

// The tools are the agent's only source of truth, so their correctness is not negotiable: a tool
// that invents a fileId makes every downstream grounding check meaningless.

const result = fixtureResult();

function context(entities: Array<{ kind: "file" | "symbol"; value: string; fileId?: string }> = []): ToolContext {
  const memory = entities.length
    ? appendTurn(emptySession("s1", result.id), {
        question: "q",
        answer: "a",
        answered: true,
        citations: [],
        retrievedChunkIds: [],
        toolsUsed: [],
        entities,
      })
    : emptySession("s1", result.id);
  return { result, memory };
}

describe("resolveFileArg", () => {
  it("accepts an exact graph node", () => {
    expect(resolveFileArg({ fileId: "src/auth.ts" }, context())).toEqual({
      fileId: "src/auth.ts",
      fromMemory: false,
      requested: "src/auth.ts",
    });
  });

  it("accepts a UNIQUE path suffix, because models shorten paths", () => {
    expect(resolveFileArg({ fileId: "auth.ts" }, context()).fileId).toBe("src/auth.ts");
  });

  it("REFUSES an ambiguous suffix rather than picking one", () => {
    // Silently answering about the wrong file is worse than not answering.
    const twoFiles = fixtureResult({
      graph: {
        ...result.graph!,
        nodes: [
          ...result.graph!.nodes,
          { id: "lib/auth.ts", path: "lib/auth.ts", name: "auth.ts", layer: "source", language: "TypeScript", lines: 5, symbolCount: 0 },
        ],
      },
    });
    const resolved = resolveFileArg({ fileId: "auth.ts" }, { result: twoFiles, memory: emptySession("s", "a") });
    expect(resolved.fileId).toBeNull();
  });

  it("falls back to the most recent file entity in memory", () => {
    expect(resolveFileArg({}, context([{ kind: "file", value: "src/db.ts" }]))).toMatchObject({
      fileId: "src/db.ts",
      fromMemory: true,
    });
  });

  it("treats a pronoun as a request to use memory", () => {
    expect(resolveFileArg({ fileId: "it" }, context([{ kind: "file", value: "src/db.ts" }]))).toMatchObject({
      fileId: "src/db.ts",
      fromMemory: true,
    });
  });

  it("returns null when nothing resolves", () => {
    expect(resolveFileArg({ fileId: "nope.ts" }, context()).fileId).toBeNull();
  });
});

describe("get_callers", () => {
  const tool = createGetCallersTool();

  it("returns files with a call edge into the target", async () => {
    const outcome = await tool.run({ fileId: "src/auth.ts" }, context());
    expect(outcome.fileIds).toEqual(["src/index.ts"]);
    expect(outcome.empty).toBe(false);
    expect(outcome.text).toContain("1 file(s) call into src/auth.ts");
  });

  it("reports an exact EMPTY answer, and states the honest limit", async () => {
    // The limit matters: without saying it, the model presents an approximate answer as exhaustive.
    const outcome = await tool.run({ fileId: "src/orphan.ts" }, context());
    expect(outcome.fileIds).toEqual([]);
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("only call/inheritance edges resolvable through imports");
  });

  it("says when it resolved the file from the previous turn", async () => {
    const outcome = await tool.run({}, context([{ kind: "file", value: "src/auth.ts" }]));
    expect(outcome.text).toContain("(resolved from the previous turn)");
  });

  it("asks for a path rather than guessing when nothing resolves", async () => {
    const outcome = await tool.run({}, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("Could not resolve which file");
  });
});

describe("find_references", () => {
  it("LABELS the direction of every relationship", async () => {
    // "imports X" vs "is imported by X" is the most common confusion in dependency questions —
    // the same one V3-P2's flywheel mines as a hard negative. An undirected blob would hand the
    // model exactly the ambiguity it is worst at.
    const outcome = await createFindReferencesTool().run({ fileId: "src/auth.ts" }, context());
    expect(outcome.text).toContain("imported by: src/index.ts");
    expect(outcome.text).toContain("imports: src/util.ts");
    expect(outcome.text).toContain("called by: src/index.ts");
    expect(outcome.text).toContain("calls: src/util.ts");
    expect(outcome.fileIds).toEqual(["src/index.ts", "src/util.ts"]);
  });

  it("reports 'none' per direction rather than omitting the line", async () => {
    const outcome = await createFindReferencesTool().run({ fileId: "src/orphan.ts" }, context());
    expect(outcome.text).toContain("imported by: none");
    expect(outcome.empty).toBe(true);
  });
});

describe("get_blast_radius", () => {
  it("returns transitive dependents", async () => {
    // util.ts <- auth.ts <- index.ts
    const outcome = await createBlastRadiusTool().run({ fileId: "src/util.ts" }, context());
    expect(outcome.fileIds).toEqual(["src/auth.ts", "src/index.ts"]);
  });

  it("is empty for a file nothing depends on", async () => {
    const outcome = await createBlastRadiusTool().run({ fileId: "src/index.ts" }, context());
    expect(outcome.fileIds).toEqual([]);
    expect(outcome.empty).toBe(true);
  });

  it("says so when the analysis has no graph", async () => {
    const noGraph = fixtureResult({ graph: undefined });
    const outcome = await createBlastRadiusTool().run(
      { fileId: "src/util.ts" },
      { result: noGraph, memory: emptySession("s", "a") },
    );
    expect(outcome.empty).toBe(true);
  });
});

describe("symbol_search", () => {
  const tool = createSymbolSearchTool();

  it("returns file + line + signature for an exact match", async () => {
    const outcome = await tool.run({ name: "AuthService" }, context());
    expect(outcome.text).toContain("src/auth.ts:3");
    expect(outcome.text).toContain("export class AuthService {");
    expect(outcome.fileIds).toEqual(["src/auth.ts"]);
  });

  it("returns EXACT matches alone when there are any", async () => {
    // A substring search that also surfaced 40 near-misses would bury the symbol the developer
    // named, and the model has no way to tell which of the 41 was meant.
    const outcome = await tool.run({ name: "login" }, context());
    expect(outcome.text).toContain("Exact matches");
    expect(outcome.text).not.toContain("AuthService");
  });

  it("falls back to a substring search", async () => {
    const outcome = await tool.run({ name: "auth" }, context());
    expect(outcome.text).toContain("Substring matches");
    expect(outcome.text).toContain("AuthService");
  });

  it("resolves a missing name from the last remembered SYMBOL", async () => {
    const outcome = await tool.run({}, context([{ kind: "symbol", value: "connectDb", fileId: "src/db.ts" }]));
    expect(outcome.text).toContain("connectDb");
    expect(outcome.text).toContain("(resolved from the previous turn)");
  });

  it("reports no match honestly", async () => {
    const outcome = await tool.run({ name: "definitelyNotHere" }, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("No declared symbol");
  });
});

describe("createGraphTools", () => {
  it("returns all four in a stable order", () => {
    expect(createGraphTools().map((tool) => tool.id)).toEqual([
      "find_references",
      "get_callers",
      "get_blast_radius",
      "symbol_search",
    ]);
  });

  it("every tool has a description and args (both are prompt text)", () => {
    for (const tool of createGraphTools()) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.args.length).toBeGreaterThan(0);
    }
  });
});

describe("search_code", () => {
  it("returns chunks with citable coordinates", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed(), reranker: createLexicalOverlapReranker() });
    const outcome = await tool.run({ query: "auth service" }, context());
    expect(outcome.chunks?.map((chunk) => chunk.id)).toContain("src/auth.ts#3-18");
    expect(outcome.text).toContain("lines 3-18");
    expect(outcome.empty).toBe(false);
  });

  it("REFUSES below the similarity floor, and says not to guess", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed() });
    const outcome = await tool.run({ query: "xyzzy" }, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.chunks).toBeUndefined();
    expect(outcome.text).toContain("Do not guess an answer from outside the repository");
  });

  it("has NO model-settable similarity floor — the gate is not a tunable", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed() });
    expect(tool.args).not.toContain("minSimilarity");
    // Passing one anyway changes nothing.
    const outcome = await tool.run({ query: "xyzzy", minSimilarity: 0 }, context());
    expect(outcome.empty).toBe(true);
  });

  it("CAPS a model-requested k rather than trusting it", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed(), maxK: 1 });
    const outcome = await tool.run({ query: "auth service", k: 500 }, context());
    expect(outcome.chunks).toHaveLength(1);
  });

  it("reports an embedding failure as an ERROR, not as 'found nothing'", async () => {
    // The agent must not read a provider outage as evidence that the repository has nothing.
    const stores = await fixtureStores();
    const broken = { ...mockEmbed(), async embed(): Promise<never> { throw new Error("provider down"); } };
    const tool = createSearchTool({ ...stores, embeddingClient: broken });
    const outcome = await tool.run({ query: "auth" }, context());
    expect(outcome.error).toMatch(/provider down/);
    expect(outcome.empty).toBeUndefined();
  });

  it("says so when the analysis has no index", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed() });
    const noIndex = fixtureResult({ ai: {} });
    const outcome = await tool.run({ query: "auth" }, { result: noIndex, memory: emptySession("s", "a") });
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("no searchable code index");
  });

  it("fails LOUD on an embedding-space mismatch", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed(8) });
    await expect(tool.run({ query: "auth" }, context())).rejects.toThrow(/does not match/);
  });

  it("needs a query", async () => {
    const stores = await fixtureStores();
    const tool = createSearchTool({ ...stores, embeddingClient: mockEmbed() });
    expect((await tool.run({}, context())).empty).toBe(true);
  });
});

describe("what_changed", () => {
  const AT = "2026-08-31T00:00:00.000Z";

  it("says so when only one commit has been analysed", async () => {
    const store = createMemoryRepoStore();
    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({}, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("Only one commit");
  });

  it("diffs against the most recent OTHER commit by default", async () => {
    const store = createMemoryRepoStore();
    // `snapshotOf` derives fileIds from `graph.nodes`, so a genuinely different tree means
    // overriding the GRAPH — overriding `files` alone leaves the snapshot identical and the diff
    // (correctly) reports no change.
    const older = fixtureResult({
      commitSha: "b".repeat(40),
      graph: { ...result.graph!, nodes: result.graph!.nodes.slice(0, 3) },
    });
    await store.put(snapshotOf(older, AT));

    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({}, context());
    expect(outcome.empty).toBe(false);
    expect(outcome.text).toContain("Changes from bbbbbbbbbbbb to aaaaaaaaaaaa");
    expect(outcome.text).toContain("added files");
  });

  it("SNAPSHOTS the current commit, so the next question has a baseline", async () => {
    // What makes the memory accumulate rather than needing a separate ingestion step.
    const store = createMemoryRepoStore();
    const tool = createWhatChangedTool({ store, now: () => AT });
    await tool.run({}, context());
    expect(await store.get("acme/repo", "a".repeat(40))).not.toBeNull();
  });

  it("accepts a short SHA prefix", async () => {
    // The trees here are IDENTICAL on purpose, so the only thing under test is which baseline the
    // prefix selected — the message names both SHAs either way.
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(fixtureResult({ commitSha: "b".repeat(40) }), AT));
    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({ sinceSha: "bbbb" }, context());
    expect(outcome.text).toContain("bbbbbbbbbbbb");
    expect(outcome.text).toContain("aaaaaaaaaaaa");
  });

  it("REFUSES an ambiguous prefix instead of picking a commit", async () => {
    // An arbitrary baseline would produce a perfectly plausible wrong answer.
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(fixtureResult({ commitSha: `b${"1".repeat(39)}` }), AT));
    await store.put(snapshotOf(fixtureResult({ commitSha: `b${"2".repeat(39)}` }), AT));
    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({ sinceSha: "b" }, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("Use a longer prefix");
  });

  it("lists the commits it DOES know when the requested one is unknown", async () => {
    const store = createMemoryRepoStore();
    await store.put(snapshotOf(fixtureResult({ commitSha: "b".repeat(40) }), AT));
    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({ sinceSha: "cafe" }, context());
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("Analysed commits");
    expect(outcome.text).toContain("bbbbbbbbbbbb");
  });

  it("offers only files that EXIST in the current analysis as citable", async () => {
    // A removed file is part of the answer's prose but is not a node in this graph, so citing it
    // would be a grounding violation.
    const store = createMemoryRepoStore();
    const older = fixtureResult({
      commitSha: "b".repeat(40),
      graph: {
        ...result.graph!,
        nodes: [
          ...result.graph!.nodes,
          { id: "src/deleted.ts", path: "src/deleted.ts", name: "deleted.ts", layer: "source", language: "TypeScript", lines: 4, symbolCount: 0 },
        ],
      },
    });
    await store.put(snapshotOf(older, AT));
    const tool = createWhatChangedTool({ store, now: () => AT });
    const outcome = await tool.run({}, context());
    expect(outcome.text).toContain("src/deleted.ts"); // in the prose
    expect(outcome.fileIds ?? []).not.toContain("src/deleted.ts"); // not citable
  });

  it("says so when the analysis is not pinned to a commit", async () => {
    const store = createMemoryRepoStore();
    const tool = createWhatChangedTool({ store, now: () => AT });
    const unpinned = fixtureResult({ commitSha: undefined });
    const outcome = await tool.run({}, { result: unpinned, memory: emptySession("s", "a") });
    expect(outcome.empty).toBe(true);
    expect(outcome.text).toContain("not pinned to a commit");
  });
});
