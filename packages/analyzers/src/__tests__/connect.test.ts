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
  ".go": "Go",
  ".java": "Java",
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

describe("connect — real-repo resolution", () => {
  it("resolves ESM `.js` specifiers to `.ts` sources (NodeNext TypeScript)", async () => {
    const graph = await connect([
      { path: "src/app.ts", content: "import { routes } from './routes/index.js';" },
      { path: "src/routes/index.ts", content: "export const routes = [];" },
    ]);
    expect(graph.edges).toEqual([
      { from: "src/app.ts", to: "src/routes/index.ts", kind: "import", specifier: "./routes/index.js" },
    ]);
    expect(graph.resolution.unresolved).toBe(0);
  });

  it("resolves a workspace package import to its source entry", async () => {
    const graph = await connect([
      { path: "packages/graph/package.json", content: JSON.stringify({ name: "@acme/graph", main: "dist/index.js" }), role: "config" },
      { path: "packages/graph/src/index.ts", content: "export const g = 1;" },
      { path: "apps/api/src/app.ts", content: "import { g } from '@acme/graph';" },
    ]);
    expect(graph.edges).toEqual([
      { from: "apps/api/src/app.ts", to: "packages/graph/src/index.ts", kind: "import", specifier: "@acme/graph" },
    ]);
    expect(graph.resolution.external).toBe(0);
  });

  it("parses TEST files too, so tests that reach a module are visible in the graph", async () => {
    const graph = await connect([
      { path: "src/math.ts", content: "export const add = (a: number, b: number) => a + b;" },
      { path: "test/math.test.ts", content: "import { add } from '../src/math';\nadd(1, 2);", role: "test" },
    ]);
    expect(graph.edges).toEqual([{ from: "test/math.test.ts", to: "src/math.ts", kind: "import", specifier: "../src/math" }]);
  });

  it("`from . import sessions` edges to the submodule, so no fake cycle through __init__", async () => {
    const graph = await connect([
      { path: "pkg/__init__.py", content: "from . import sessions" },
      { path: "pkg/sessions.py", content: "from . import models" },
      { path: "pkg/models.py", content: "x = 1" },
    ]);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "pkg/__init__.py->pkg/sessions.py",
      "pkg/sessions.py->pkg/models.py",
    ]);
  });
});

describe("connect — runtime vs type-only vs lazy imports", () => {
  it("marks TS `import type` / all-`type` specifiers / `export type … from` as typeOnly", async () => {
    const graph = await connect([
      {
        path: "src/a.ts",
        content: [
          "import type { B } from './b';",
          "import { type C } from './c';",
          "import { d, type D } from './d';",
          "export type { E } from './e';",
        ].join("\n"),
      },
      { path: "src/b.ts", content: "export type B = 1;" },
      { path: "src/c.ts", content: "export type C = 1;" },
      { path: "src/d.ts", content: "export const d = 1; export type D = 1;" },
      { path: "src/e.ts", content: "export type E = 1;" },
    ]);
    const typeOnly = Object.fromEntries(graph.edges.map((e) => [e.to, e.typeOnly === true]));
    expect(typeOnly).toEqual({ "src/b.ts": true, "src/c.ts": true, "src/d.ts": false, "src/e.ts": true });
  });

  it("marks Python TYPE_CHECKING imports typeOnly and function-body imports lazy", async () => {
    const graph = await connect([
      {
        path: "pkg/a.py",
        content: [
          "from typing import TYPE_CHECKING",
          "from . import b",
          "if TYPE_CHECKING:",
          "    from . import c",
          "else:",
          "    from . import d",
          "def run():",
          "    from . import e",
        ].join("\n"),
      },
      ...["b", "c", "d", "e"].map((name) => ({ path: `pkg/${name}.py`, content: "x = 1" })),
      { path: "pkg/__init__.py", content: "" },
    ]);
    const flags = Object.fromEntries(
      graph.edges.map((e) => [e.to, [e.typeOnly ? "type" : "", e.lazy ? "lazy" : ""].filter(Boolean).join("+") || "runtime"]),
    );
    expect(flags).toEqual({ "pkg/b.py": "runtime", "pkg/c.py": "type", "pkg/d.py": "runtime", "pkg/e.py": "lazy" });
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

  it("the stored graph slice carries NO metrics field (structure + properties only)", async () => {
    const graph = await connect([{ path: "src/a.ts", content: "export const a = 1;" }]);
    // V3-P1 added the code-property-graph slices (cpgEdges / routes / cpg provenance).
    // They are STRUCTURE and PROPERTIES, not metrics — the boundary this test guards.
    expect(Object.keys(graph).sort()).toEqual(["cpg", "cpgEdges", "edges", "nodes", "resolution", "routes"]);
    // no summary / centrality / degree on the slice or its nodes
    expect("summary" in graph).toBe(false);
    expect("degree" in graph.nodes[0]).toBe(false);
    expect("centrality" in graph.nodes[0]).toBe(false);
    expect("clusters" in graph).toBe(false); // communities are a metric (Analyze owns them)
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

describe("connect — Go", () => {
  const GO_REPO: FileSpec[] = [
    { path: "go.mod", content: "module github.com/acme/app\n\ngo 1.22\n", role: "config" },
    {
      path: "cmd/app/main.go",
      content: `package main

import (
	"fmt"

	"github.com/acme/app/store"
)

func main() { s := store.Open(); fmt.Println(s); run() }
`,
    },
    { path: "cmd/app/run.go", content: "package main\n\nfunc run() {}\n" },
    { path: "store/store.go", content: "package store\n\ntype Store struct{}\n" },
    { path: "store/open.go", content: "package store\n\nfunc Open() *Store { return &Store{} }\n" },
    {
      path: "store/open_test.go",
      content: "package store_test\n\nimport (\n\t\"testing\"\n\t\"github.com/acme/app/store\"\n)\n\nfunc TestOpen(t *testing.T) { store.Open() }\n",
      role: "test",
    },
    { path: "store/gone.go", content: 'package store\n\nimport "github.com/acme/app/missing"\n\nvar _ = missing.X\n' },
  ];

  it("resolves through go.mod to the declaring file, keeps stdlib external and flags a broken import", async () => {
    const graph = await connect(GO_REPO);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "cmd/app/main.go", to: "store/open.go", kind: "import", specifier: "github.com/acme/app/store" },
        { from: "store/open_test.go", to: "store/open.go", kind: "import", specifier: "github.com/acme/app/store" },
      ]),
    );
    expect(graph.edges).toHaveLength(2);
    expect(graph.resolution.externalModules).toEqual(["fmt", "testing"]);
    expect(graph.resolution.unresolvedImports).toEqual([{ from: "store/gone.go", specifier: "github.com/acme/app/missing" }]);
  });

  it("call edges reach the declaring file, including same-package calls that need no import", async () => {
    const graph = await connect(GO_REPO);
    const calls = graph.cpgEdges!.filter((edge) => edge.kind === "call").map(({ from, to, symbol }) => [from, to, symbol]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["cmd/app/main.go", "store/open.go", "store.Open"],
        ["cmd/app/main.go", "cmd/app/run.go", "run"],
      ]),
    );
    // `fmt.Println` is external, and the composite literal in open.go is not a call — no edge is invented.
    expect(calls.some(([, to]) => to === "store/store.go")).toBe(false);
  });
});

describe("connect — committed bundles", () => {
  it("leaves a browserify/webpack bundle out of the graph instead of reporting its internal requires as broken", async () => {
    const graph = await connect([
      { path: "src/app.js", content: "const live = require('../vendor-ish/livereload.js');" },
      {
        path: "vendor-ish/livereload.js",
        content:
          '(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);var a=new Error("Cannot find module \'"+i+"\'");throw a.code="MODULE_NOT_FOUND",a}}}}})()\nvar wks = require("./_wks");\n',
      },
      { path: "public/app.bundle.js", content: "var m = __webpack_require__(12); require('./_internal');" },
    ]);
    expect(graph.edges).toEqual([{ from: "src/app.js", to: "vendor-ish/livereload.js", kind: "require", specifier: "../vendor-ish/livereload.js" }]);
    expect(graph.resolution.unresolvedImports).toEqual([]);
    expect(graph.cpg?.bundledFiles).toBe(2);
  });
});

describe("connect — Java", () => {
  it("imports, same-package uses and on-demand imports become lazy edges; external libraries do not", async () => {
    const graph = await connect([
      {
        path: "src/main/java/com/acme/app/App.java",
        content:
          "package com.acme.app;\nimport java.util.List;\nimport com.acme.model.*;\nimport com.acme.util.Strings;\npublic class App { Helper h; User u; List<String> l; void f() { Strings.trim(); h.run(); } }\n",
      },
      { path: "src/main/java/com/acme/app/Helper.java", content: "package com.acme.app;\npublic class Helper { App back; void run() {} }\n" },
      { path: "src/main/java/com/acme/model/User.java", content: "package com.acme.model;\npublic class User {}\n" },
      { path: "src/main/java/com/acme/model/Order.java", content: "package com.acme.model;\npublic class Order {}\n" },
      { path: "src/main/java/com/acme/util/Strings.java", content: "package com.acme.util;\npublic final class Strings { public static String trim() { return \"\"; } }\n" },
    ]);
    const pairs = graph.edges.map(({ from, to, specifier, lazy }) => [from.split("/").pop(), to.split("/").pop(), specifier, lazy]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["App.java", "Strings.java", "com.acme.util.Strings", true],
        ["App.java", "User.java", "com.acme.model.*", true],
        ["App.java", "Helper.java", "com.acme.app.Helper", true],
        ["Helper.java", "App.java", "com.acme.app.App", true],
      ]),
    );
    expect(pairs.some(([, to]) => to === "Order.java")).toBe(false); // on-demand import, never used
    expect(graph.resolution.externalModules).toEqual(["java.util.List"]);
    const calls = graph.cpgEdges!.map(({ from, to, symbol }) => [from.split("/").pop(), to.split("/").pop(), symbol]);
    expect(calls).toEqual(expect.arrayContaining([["App.java", "Strings.java", "Strings.trim"]]));
  });
});
