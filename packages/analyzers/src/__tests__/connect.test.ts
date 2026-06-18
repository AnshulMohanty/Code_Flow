import { describe, expect, it } from "vitest";
import type {
  FileRole,
  Inventory,
  InventorySymbol,
  PipelineContext,
  PipelineInput,
  RepoFile,
  RepoGraph,
  RepoStructure,
} from "@codeflow/shared-types";
import { createConnectStage } from "../stages/connect.js";

const input: PipelineInput = {
  jobId: "job-1",
  repositoryRef: { provider: "github", owner: "acme", name: "repo" },
  mode: "public_hosted",
  analyzerVersion: "v1",
};

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".py": "Python",
  ".json": "JSON",
  ".md": "Markdown",
};

interface FileSpec {
  path: string;
  content: string;
  role?: FileRole;
}

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash && dot !== -1 ? path.slice(dot).toLowerCase() : "";
}

function toRepoFiles(specs: FileSpec[]): RepoFile[] {
  return specs.map((spec) => {
    const ext = extOf(spec.path);
    return {
      path: spec.path,
      ext,
      role: spec.role ?? "source",
      language: LANG_BY_EXT[ext] ?? "Unknown",
      sizeBytes: spec.content.length,
    };
  });
}

function readerFor(specs: FileSpec[]) {
  const map = new Map(specs.map((spec) => [spec.path, spec.content] as const));
  return async (_repoPath: string, relativePath: string) =>
    map.has(relativePath) ? map.get(relativePath)! : null;
}

function ctxFor(specs: FileSpec[], opts: { loc?: Record<string, number>; symbols?: InventorySymbol[] } = {}): PipelineContext {
  const files = toRepoFiles(specs);
  const structure: RepoStructure = { layout: "flat", files, fileCount: files.length };
  const inventory: Inventory = {
    symbols: opts.symbols ?? [],
    entryPoints: [],
    symbolCount: opts.symbols?.length ?? 0,
    loc: opts.loc ?? {},
  };
  return {
    repoPath: "/repo",
    commitSha: "sha",
    prior: { structure, inventory },
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

async function connect(
  specs: FileSpec[],
  opts: { loc?: Record<string, number>; symbols?: InventorySymbol[] } = {},
): Promise<RepoGraph> {
  const stage = createConnectStage({ readFile: readerFor(specs), now: () => 1000 });
  const { partial } = await stage.run(input, ctxFor(specs, opts));
  return partial.graph!;
}

describe("connect — module resolution", () => {
  it("resolves a relative import by extension", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: "import { b } from './b';" },
      { path: "src/b.ts", content: "export const b = 1;" },
    ]);
    expect(graph.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import", specifier: "./b" }]);
    expect(graph.resolution).toMatchObject({ resolved: 1, external: 0, unresolved: 0 });
  });

  it("resolves a directory import via index.*", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: "import { helpers } from './utils';" },
      { path: "src/utils/index.ts", content: "export const helpers = {};" },
    ]);
    expect(graph.edges).toEqual([
      { from: "src/a.ts", to: "src/utils/index.ts", kind: "import", specifier: "./utils" },
    ]);
  });

  it("resolves a parent (../) import", async () => {
    const graph = await connect([
      { path: "src/feature/a.ts", content: "import { core } from '../core';" },
      { path: "src/core.ts", content: "export const core = 1;" },
    ]);
    expect(graph.edges[0]).toMatchObject({ from: "src/feature/a.ts", to: "src/core.ts" });
  });

  it("classifies require / dynamic / reexport edge kinds", async () => {
    const graph = await connect([
      {
        path: "src/a.js",
        content: ["const b = require('./b');", "import('./c');", "export { d } from './d';"].join("\n"),
      },
      { path: "src/b.js", content: "module.exports = {};" },
      { path: "src/c.js", content: "export const c = 1;" },
      { path: "src/d.js", content: "export const d = 1;" },
    ]);
    const kinds = Object.fromEntries(graph.edges.map((e) => [e.to, e.kind]));
    expect(kinds["src/b.js"]).toBe("require");
    expect(kinds["src/c.js"]).toBe("dynamic");
    expect(kinds["src/d.js"]).toBe("reexport");
  });

  it("resolves Python relative imports (module + package __init__)", async () => {
    const graph = await connect([
      { path: "pkg/a.py", content: ["from .b import x", "from .sub import y"].join("\n") },
      { path: "pkg/b.py", content: "x = 1" },
      { path: "pkg/sub/__init__.py", content: "y = 1" },
    ]);
    const targets = graph.edges.map((e) => e.to).sort();
    expect(targets).toEqual(["pkg/b.py", "pkg/sub/__init__.py"]);
  });
});

describe("connect — external & unresolved", () => {
  it("a bare/package import is external, not a node, and is tallied", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: ["import React from 'react';", "import fs from 'node:fs';"].join("\n") },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.resolution.external).toBe(2);
    expect(graph.resolution.externalModules).toEqual(["node:fs", "react"]);
    // external specifiers never become nodes
    expect(graph.nodes.map((n) => n.path)).toEqual(["src/a.ts"]);
  });

  it("an unresolvable relative import is recorded, stage still succeeds", async () => {
    const graph = await connect([{ path: "src/a.ts", content: "import { gone } from './missing';" }]);
    expect(graph.edges).toEqual([]);
    expect(graph.resolution.unresolved).toBe(1);
    expect(graph.resolution.unresolvedImports).toEqual([{ from: "src/a.ts", specifier: "./missing" }]);
  });
});

describe("connect — FileNode projection", () => {
  it("one node per structure.files entry, with loc + symbolCount + role/language carried", async () => {
    const symbols: InventorySymbol[] = [
      { name: "a", kind: "function", filePath: "src/a.ts", line: 1, exported: true, language: "TypeScript" },
      { name: "b", kind: "function", filePath: "src/a.ts", line: 2, exported: false, language: "TypeScript" },
    ];
    const graph = await connect(
      [
        { path: "src/a.ts", content: "export function a() {}" },
        { path: "README.md", content: "# hi", role: "docs" },
        { path: "package.json", content: "{}", role: "config" },
      ],
      { loc: { "src/a.ts": 12 }, symbols },
    );

    expect(graph.nodes).toHaveLength(3);
    const byPath = Object.fromEntries(graph.nodes.map((n) => [n.path, n]));
    expect(byPath["src/a.ts"]).toMatchObject({
      id: "src/a.ts", // fileId === path
      name: "a.ts",
      layer: "source",
      language: "TypeScript",
      lines: 12,
      symbolCount: 2,
    });
    // non-source: loc falls back to 0 (LOC is a source-code metric — pre-flight decision)
    expect(byPath["README.md"]).toMatchObject({ lines: 0, symbolCount: 0, layer: "docs" });
    expect(byPath["package.json"]).toMatchObject({ lines: 0, layer: "config" });
  });
});

describe("connect — fileId consistency & boundary", () => {
  it("every edge endpoint exists as a node, and fileIds line up with structure.files (POSIX)", async () => {
    const specs: FileSpec[] = [
      { path: "src/a.ts", content: "import './b';\nimport './c';" },
      { path: "src/b.ts", content: "export const b = 1;" },
      { path: "src/c.ts", content: "export const c = 1;" },
    ];
    const graph = await connect(specs);
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const structurePaths = new Set(toRepoFiles(specs).map((f) => f.path));

    expect(graph.nodes.every((n) => n.id === n.path)).toBe(true); // fileId === path
    expect([...nodeIds].sort()).toEqual([...structurePaths].sort());
    for (const edge of graph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it("the stored graph slice carries NO metrics field (structure only)", async () => {
    const graph = await connect([{ path: "src/a.ts", content: "export const a = 1;" }]);
    expect(Object.keys(graph).sort()).toEqual(["edges", "nodes", "resolution"]);
    // no summary / centrality / degree on the slice or its nodes
    expect("summary" in graph).toBe(false);
    expect("degree" in graph.nodes[0]).toBe(false);
    expect("centrality" in graph.nodes[0]).toBe(false);
  });
});

describe("connect — completeness & resilience", () => {
  it("returns the FULL node + edge lists uncapped", async () => {
    const specs: FileSpec[] = [];
    for (let i = 0; i < 400; i++) {
      // each file imports the next → 399 edges, 400 nodes
      specs.push({ path: `src/f${i}.ts`, content: `import './f${i + 1}';\nexport const v${i} = ${i};` });
    }
    const graph = await connect(specs);
    expect(graph.nodes).toHaveLength(400);
    expect(graph.edges).toHaveLength(399); // f399 → f400 is unresolved (no such file)
    expect(graph.resolution.unresolved).toBe(1);
  });

  it("an unreadable source file contributes a node but no edges; stage still succeeds", async () => {
    // structure lists src/ghost.ts but the reader can't return it (null)
    const stage = createConnectStage({ readFile: async () => null, now: () => 1000 });
    const files = toRepoFiles([{ path: "src/ghost.ts", content: "" }]);
    const structure: RepoStructure = { layout: "flat", files, fileCount: 1 };
    const ctx: PipelineContext = {
      repoPath: "/repo",
      commitSha: "sha",
      prior: { structure, inventory: { symbols: [], entryPoints: [], symbolCount: 0, loc: {} } },
      cache: { async get() { return null; }, async set() {} },
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    };
    const { partial } = await stage.run(input, ctx);
    expect(partial.graph!.nodes).toHaveLength(1);
    expect(partial.graph!.edges).toEqual([]);
  });

  it("throws if the structure slice is missing (Map-structure must run first)", async () => {
    const stage = createConnectStage({ readFile: readerFor([]), now: () => 1 });
    const ctx = ctxFor([]);
    const noStructure: PipelineContext = { ...ctx, prior: {} };
    await expect(stage.run(input, noStructure)).rejects.toThrow(/structure/);
  });

  it("throws if repoPath is missing (Ingest must run first)", async () => {
    const stage = createConnectStage({ readFile: readerFor([]), now: () => 1 });
    const ctx = ctxFor([]);
    const noRepo: PipelineContext = { ...ctx, repoPath: undefined };
    await expect(stage.run(input, noRepo)).rejects.toThrow(/repoPath/);
  });
});
