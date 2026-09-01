import { describe, expect, it } from "vitest";
import type {
  FileRole,
  Inventory,
  PipelineContext,
  PipelineInput,
  RepoFile,
  RepoGraph,
  RepoStructure,
} from "@codeflow/shared-types";
import { createConnectStage } from "../stages/connect.js";

// V3-P1 — the CODE PROPERTY GRAPH half of Connect: call + inheritance edges and HTTP
// routes, from one tree-sitter pass per source file. These tests pin the boundary:
// `graph.edges` keeps its old dependency-only meaning, the enrichment is ADDITIVE, and
// nothing is invented when a target cannot be resolved.
//
// Hermetic: in-memory file contents, local grammar wasm, no live services.

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

async function connect(specs: FileSpec[]): Promise<RepoGraph> {
  const files = toRepoFiles(specs);
  const structure: RepoStructure = { layout: "flat", files, fileCount: files.length };
  const inventory: Inventory = { symbols: [], entryPoints: [], symbolCount: 0, loc: {} };
  const ctx: PipelineContext = {
    repoPath: "/repo",
    commitSha: "sha",
    prior: { structure, inventory },
    cache: {
      async get() {
        return null;
      },
      async set() {},
    },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
  const stage = createConnectStage({ readFile: readerFor(specs), now: () => 1000 });
  const { partial } = await stage.run(input, ctx);
  return partial.graph!;
}

describe("connect CPG — call + inheritance edges", () => {
  it("turns calls into an imported symbol into ONE counted call edge", async () => {
    const graph = await connect([
      {
        path: "src/a.ts",
        content: `import { helper } from './b';

export function run() {
  helper(1);
  helper(2);
  return helper(3);
}
`,
      },
      { path: "src/b.ts", content: "export function helper(n: number) { return n; }\n" },
    ]);

    // The dependency edge is unchanged by the enrichment...
    expect(graph.edges).toEqual([{ from: "src/a.ts", to: "src/b.ts", kind: "import", specifier: "./b" }]);
    // ...and the call relationship is a separate, aggregated, citable edge.
    expect(graph.cpgEdges).toEqual([
      { from: "src/a.ts", to: "src/b.ts", kind: "call", symbol: "helper", count: 3, line: 4 },
    ]);
  });

  it("records `new Foo()` as a call and keeps the FIRST occurrence line", async () => {
    const graph = await connect([
      {
        path: "src/a.ts",
        content: `import { Widget } from './widget';

const first = new Widget();
const second = new Widget();
`,
      },
      { path: "src/widget.ts", content: "export class Widget {}\n" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "src/a.ts", to: "src/widget.ts", kind: "call", symbol: "Widget", count: 2, line: 3 },
    ]);
  });

  it("resolves a namespace-import member call to the imported file", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: "import * as utils from './utils';\nexport const v = utils.parse('x');\n" },
      { path: "src/utils.ts", content: "export function parse(s: string) { return s; }\n" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "src/a.ts", to: "src/utils.ts", kind: "call", symbol: "utils.parse", count: 1, line: 2 },
    ]);
  });

  it("records a CommonJS destructured require binding", async () => {
    const graph = await connect([
      {
        path: "src/a.js",
        content: "const { renderTemplate } = require('./templates');\nmodule.exports = () => renderTemplate('x');\n",
      },
      { path: "src/templates.js", content: "exports.renderTemplate = (s) => s;\n" },
    ]);
    expect(graph.edges).toEqual([
      { from: "src/a.js", to: "src/templates.js", kind: "require", specifier: "./templates" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "src/a.js", to: "src/templates.js", kind: "call", symbol: "renderTemplate", count: 1, line: 2 },
    ]);
  });

  it("records extends and implements as distinct kinds", async () => {
    const graph = await connect([
      {
        path: "src/service.ts",
        content: `import { Base } from './base';
import type { Contract } from './contract';

export class Service extends Base implements Contract {}
`,
      },
      { path: "src/base.ts", content: "export class Base {}\n" },
      { path: "src/contract.ts", content: "export interface Contract { x: number }\n" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "src/service.ts", to: "src/base.ts", kind: "extends", symbol: "Base", count: 1, line: 4 },
      { from: "src/service.ts", to: "src/contract.ts", kind: "implements", symbol: "Contract", count: 1, line: 4 },
    ]);
  });

  it("records a plain-JS `extends` with no clause wrapper", async () => {
    const graph = await connect([
      { path: "src/a.js", content: "import { Base } from './base';\nexport class Child extends Base {}\n" },
      { path: "src/base.js", content: "export class Base {}\n" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "src/a.js", to: "src/base.js", kind: "extends", symbol: "Base", count: 1, line: 2 },
    ]);
  });

  it("records a Python superclass and a call through a from-import", async () => {
    const graph = await connect([
      {
        path: "pkg/service.py",
        content: `from .models import Base, make

class Service(Base):
    def build(self):
        return make()
`,
      },
      { path: "pkg/models.py", content: "class Base:\n    pass\n\ndef make():\n    return 1\n" },
    ]);
    expect(graph.cpgEdges).toEqual([
      { from: "pkg/service.py", to: "pkg/models.py", kind: "call", symbol: "make", count: 1, line: 5 },
      { from: "pkg/service.py", to: "pkg/models.py", kind: "extends", symbol: "Base", count: 1, line: 3 },
    ]);
  });

  it("invents nothing for a local call, a global, or an external import", async () => {
    const graph = await connect([
      {
        path: "src/a.ts",
        content: `import { external } from 'some-package';

function local() { return 1; }

export function run() {
  local();
  external();
  return unknownGlobal();
}
`,
      },
    ]);
    expect(graph.cpgEdges).toEqual([]);
    expect(graph.resolution.external).toBe(1);
    expect(graph.resolution.externalModules).toEqual(["some-package"]);
  });

  it("keeps every cpgEdge endpoint grounded in a real graph node", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: "import { b } from './b';\nexport const v = b();\n" },
      { path: "src/b.ts", content: "export function b() { return 1; }\n" },
    ]);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    expect(graph.cpgEdges?.length).toBeGreaterThan(0);
    for (const edge of graph.cpgEdges ?? []) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });

  it("stores cpgEdges in a deterministic order and re-runs byte-identically", async () => {
    const specs: FileSpec[] = [
      { path: "src/z.ts", content: "import { a } from './a';\nimport { m } from './m';\nexport const v = a() + m();\n" },
      { path: "src/a.ts", content: "export function a() { return 1; }\n" },
      { path: "src/m.ts", content: "export function m() { return 2; }\n" },
    ];
    const first = await connect(specs);
    const second = await connect(specs);
    expect(JSON.stringify(second.cpgEdges)).toBe(JSON.stringify(first.cpgEdges));
    expect((first.cpgEdges ?? []).map((edge) => `${edge.from} ${edge.to} ${edge.kind} ${edge.symbol}`)).toEqual([
      "src/z.ts src/a.ts call a",
      "src/z.ts src/m.ts call m",
    ]);
  });
});

describe("connect CPG — HTTP routes", () => {
  it("detects Express routes and mount points, with the path exactly as written", async () => {
    const graph = await connect([
      {
        path: "src/api/server.js",
        content: `const express = require('express');
const app = express();

app.get('/health', handler);
app.post('/orders/:id', handler);
app.use('/static', serveStatic);
`,
      },
    ]);
    expect(graph.routes).toEqual([
      { fileId: "src/api/server.js", method: "GET", path: "/health", line: 4, framework: "express" },
      { fileId: "src/api/server.js", method: "POST", path: "/orders/:id", line: 5, framework: "express" },
      { fileId: "src/api/server.js", method: "USE", path: "/static", line: 6, framework: "express" },
    ]);
  });

  it("labels a router named by convention as express", async () => {
    const graph = await connect([
      { path: "src/api/orders.ts", content: "export const ordersRouter = r();\nordersRouter.patch('/orders', h);\n" },
    ]);
    expect(graph.routes).toEqual([
      { fileId: "src/api/orders.ts", method: "PATCH", path: "/orders", line: 2, framework: "express" },
    ]);
  });

  it("never claims a map/cache lookup as an express route", async () => {
    const graph = await connect([
      {
        path: "src/cache.ts",
        content: `const cache = new Map<string, string>();
export const read = (key: string) => cache.get(key);
export const missing = () => lookup.get('no-leading-slash');
export const tmp = () => cache.get('/tmp/not-a-route');
`,
      },
    ]);
    // A non-literal key and a key without a leading "/" are rejected outright. The
    // "/tmp/..." lookup is on an object that is not route-shaped, so it is labelled
    // `unknown` rather than fabricated as an Express route.
    expect(graph.routes?.some((route) => route.framework === "express")).toBe(false);
    expect(graph.routes).toEqual([
      { fileId: "src/cache.ts", method: "GET", path: "/tmp/not-a-route", line: 4, framework: "unknown" },
    ]);
  });

  it("expands a Flask `methods=[...]` decorator into one route per verb", async () => {
    const graph = await connect([
      {
        path: "pkg/web/app.py",
        content: `from flask import Flask

app = Flask(__name__)


@app.route("/health")
def health():
    return "ok"


@app.route("/orders/<order_id>", methods=["GET", "DELETE"])
def order_detail(order_id):
    return order_id
`,
      },
    ]);
    expect(graph.routes).toEqual([
      { fileId: "pkg/web/app.py", method: "GET", path: "/health", line: 6, framework: "flask" },
      { fileId: "pkg/web/app.py", method: "DELETE", path: "/orders/<order_id>", line: 11, framework: "flask" },
      { fileId: "pkg/web/app.py", method: "GET", path: "/orders/<order_id>", line: 11, framework: "flask" },
    ]);
  });

  it("detects FastAPI verb decorators", async () => {
    const graph = await connect([
      {
        path: "pkg/web/api.py",
        content: `from fastapi import APIRouter

router = APIRouter()


@router.get("/items/{item_id}")
async def read_item(item_id: int):
    return item_id
`,
      },
    ]);
    expect(graph.routes).toEqual([
      { fileId: "pkg/web/api.py", method: "GET", path: "/items/{item_id}", line: 6, framework: "fastapi" },
    ]);
  });
});

describe("connect CPG — provenance", () => {
  it("reports which engine produced the CPG so a degraded run is visible", async () => {
    const graph = await connect([
      { path: "src/a.ts", content: "import { b } from './b';\nexport const v = b();\n" },
      { path: "src/b.ts", content: "export function b() { return 1; }\n" },
      // A docs file is not parsed at all (source role only) — it just contributes a node.
      { path: "notes.md", content: "# hi\n", role: "docs" },
    ]);
    expect(graph.cpg).toEqual({ treeSitterFiles: 2, fallbackFiles: 0, enriched: true });
    expect(graph.nodes).toHaveLength(3);
  });

  it("counts a source file with no tree-sitter grammar as a fallback (imports still found)", async () => {
    // `.rb` has no grammar: the regex fallback still extracts nothing here, but the file
    // is counted as un-enriched rather than silently reported as call-free.
    const graph = await connect([{ path: "lib/thing.rb", content: "require 'json'\nclass Thing\nend\n" }]);
    expect(graph.cpg).toEqual({ treeSitterFiles: 0, fallbackFiles: 1, enriched: false });
    expect(graph.cpgEdges).toEqual([]);
  });
});
