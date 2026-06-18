import { describe, expect, it } from "vitest";
import { createParserRegistry, typescriptParser } from "@codeflow/parsers";
import type {
  FileRole,
  Inventory,
  InventoryEntryPoint,
  PipelineContext,
  PipelineInput,
  RepoFile,
  RepoStructure,
} from "@codeflow/shared-types";
import { createInventoryStage } from "../stages/inventory.js";

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
  ".jsx": "JavaScript",
  ".py": "Python",
};

interface FileSpec {
  path: string;
  content: string;
  role?: FileRole;
  language?: string;
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
      language: spec.language ?? LANG_BY_EXT[ext] ?? "Unknown",
      sizeBytes: spec.content.length,
    };
  });
}

function ctxFor(specs: FileSpec[], structureFiles?: FileSpec[]): PipelineContext {
  const files = toRepoFiles(structureFiles ?? specs);
  const structure: RepoStructure = { layout: "flat", files, fileCount: files.length };
  return {
    repoPath: "/repo",
    commitSha: "sha",
    prior: { structure },
    cache: { async get() { return null; }, async set() {} },
    logger: { info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
}

function readerFor(specs: FileSpec[]) {
  const map = new Map(specs.map((spec) => [spec.path, spec.content] as const));
  return async (_repoPath: string, relativePath: string) =>
    map.has(relativePath) ? map.get(relativePath)! : null;
}

/**
 * Run Inventory over an in-memory set of files. `structureFiles` overrides what the
 * structure slice lists (to test files that are listed but unreadable); by default the
 * structure mirrors the readable set.
 */
async function inventory(
  specs: FileSpec[],
  opts: { registry?: ReturnType<typeof createParserRegistry>; structureFiles?: FileSpec[] } = {},
): Promise<Inventory> {
  const stage = createInventoryStage({ readFile: readerFor(specs), registry: opts.registry, now: () => 1000 });
  const { partial } = await stage.run(input, ctxFor(specs, opts.structureFiles));
  return partial.inventory!;
}

function findEntry(entries: InventoryEntryPoint[], filePath: string, evidence: InventoryEntryPoint["evidence"]) {
  return entries.find((entry) => entry.filePath === filePath && entry.evidence === evidence);
}

const TS_SOURCE = [
  "export function foo() {", // 1
  "  return 1;", // 2
  "}", // 3
  "", // 4
  "class Bar {}", // 5
  "", // 6
  "export const baz = () => 2;", // 7
  "", // 8
  "interface Priv {}", // 9
  "", // 10
  "export interface Pub {", // 11
  "  x: number;", // 12
  "}", // 13
  "", // 14
  "type Alias = string;", // 15
  "", // 16
  "export type PubAlias = number;", // 17
].join("\n");

describe("inventory — symbol extraction", () => {
  it("extracts functions/classes/exports/interfaces/types with kind, line and exported flag (TS)", async () => {
    const inv = await inventory([{ path: "src/app.ts", content: TS_SOURCE }]);
    const byName = Object.fromEntries(inv.symbols.map((s) => [s.name, s]));

    expect(byName.foo).toMatchObject({ kind: "function", line: 1, exported: true, filePath: "src/app.ts", language: "TypeScript" });
    expect(byName.Bar).toMatchObject({ kind: "class", line: 5, exported: false });
    expect(byName.baz).toMatchObject({ kind: "function", line: 7, exported: true });
    expect(byName.Priv).toMatchObject({ kind: "interface", line: 9, exported: false });
    expect(byName.Pub).toMatchObject({ kind: "interface", line: 11, exported: true });
    expect(byName.Alias).toMatchObject({ kind: "type", line: 15, exported: false });
    expect(byName.PubAlias).toMatchObject({ kind: "type", line: 17, exported: true });

    // symbolCount mirrors the list; no name duplicated by the export pass
    expect(inv.symbolCount).toBe(inv.symbols.length);
    expect(inv.symbols.filter((s) => s.name === "Pub")).toHaveLength(1);
  });

  it("extracts functions / classes / methods (Python), all non-exported", async () => {
    const py = ["import os", "", "def top():", "    return 1", "", "class C:", "    def method(self):", "        return 2"].join("\n");
    const inv = await inventory([{ path: "svc/worker.py", content: py }]);
    const byName = Object.fromEntries(inv.symbols.map((s) => [s.name, s]));

    expect(byName.top).toMatchObject({ kind: "function", line: 3, exported: false, language: "Python" });
    expect(byName.C).toMatchObject({ kind: "class", line: 6 });
    expect(byName.method).toMatchObject({ kind: "method", line: 7 });
  });

  it("extracts JS functions + flips the exported flag from the export surface", async () => {
    const js = ["function helper() {}", "export function pub() {}", "export const arrow = () => {}"].join("\n");
    const inv = await inventory([{ path: "lib/util.js", content: js }]);
    const byName = Object.fromEntries(inv.symbols.map((s) => [s.name, s]));

    expect(byName.helper).toMatchObject({ kind: "function", exported: false, language: "JavaScript" });
    expect(byName.pub).toMatchObject({ kind: "function", exported: true });
    expect(byName.arrow).toMatchObject({ kind: "function", exported: true });
  });

  it("captures real LOC per file keyed by POSIX path (the one place LOC is produced)", async () => {
    const inv = await inventory([
      { path: "a.ts", content: "export const a = 1;\n\nexport const b = 2;\n" },
      { path: "b.py", content: "x = 1\n" },
    ]);
    expect(inv.loc["a.ts"]).toBe(2); // blank line not counted
    expect(inv.loc["b.py"]).toBe(1);
  });

  it("only parses source-role files (tests/config/docs are not symbol surface)", async () => {
    const inv = await inventory([
      { path: "src/app.ts", content: "export function used() {}" },
      { path: "src/app.test.ts", content: "export function notParsed() {}", role: "test" },
      { path: "package.json", content: "{}", role: "config" },
    ]);
    expect(inv.symbols.map((s) => s.name)).toEqual(["used"]);
    expect(inv.loc["src/app.test.ts"]).toBeUndefined();
  });
});

describe("inventory — POSIX join", () => {
  it("every symbol.filePath matches a structure.files path exactly", async () => {
    const specs: FileSpec[] = [
      { path: "src/app.ts", content: TS_SOURCE },
      { path: "svc/worker.py", content: "def go():\n    return 1\n" },
    ];
    const structurePaths = new Set(toRepoFiles(specs).map((f) => f.path));
    const inv = await inventory(specs);
    expect(inv.symbols.length).toBeGreaterThan(0);
    expect(inv.symbols.every((s) => structurePaths.has(s.filePath))).toBe(true);
  });
});

describe("inventory — entry-point detection", () => {
  it("detects bin⇒cli-bin, main, exports, filename + framework conventions with evidence", async () => {
    const pkg = JSON.stringify({
      name: "x",
      bin: { mycli: "bin/cli.js" },
      main: "lib/index.js",
      exports: "./lib/index.js",
    });
    const specs: FileSpec[] = [
      { path: "package.json", content: pkg, role: "config" },
      { path: "bin/cli.js", content: "#!/usr/bin/env node\n" },
      { path: "lib/index.js", content: "export const x = 1;\n" },
      { path: "src/server.ts", content: "export const s = 1;\n" },
      { path: "manage.py", content: "import sys\n" },
    ];
    const inv = await inventory(specs);
    const e = inv.entryPoints;

    expect(findEntry(e, "bin/cli.js", "package-json-bin")).toMatchObject({ kind: "cli-bin" });
    expect(findEntry(e, "lib/index.js", "package-json-main")).toMatchObject({ kind: "main" });
    expect(findEntry(e, "lib/index.js", "package-json-exports")).toMatchObject({ kind: "main" });
    // filename convention: index.* and server.*
    expect(findEntry(e, "lib/index.js", "filename-convention")).toMatchObject({ kind: "index" });
    expect(findEntry(e, "src/server.ts", "filename-convention")).toMatchObject({ kind: "server" });
    // cheap framework convention
    expect(findEntry(e, "manage.py", "framework")).toMatchObject({ kind: "cli-bin" });
  });

  it("a string-form bin is also cli-bin", async () => {
    const inv = await inventory([
      { path: "package.json", content: JSON.stringify({ bin: "./cli.js" }), role: "config" },
      { path: "cli.js", content: "run();\n" },
    ]);
    expect(findEntry(inv.entryPoints, "cli.js", "package-json-bin")).toMatchObject({ kind: "cli-bin" });
  });

  it("emits a cli projectTypeSignal ONLY on a package.json bin (hard evidence)", async () => {
    const withBin = await inventory([
      { path: "package.json", content: JSON.stringify({ bin: "cli.js" }), role: "config" },
      { path: "cli.js", content: "run();\n" },
    ]);
    expect(withBin.projectTypeSignal).toEqual({ projectType: "cli", evidence: "package-json-bin" });

    const noBin = await inventory([
      { path: "package.json", content: JSON.stringify({ main: "index.js" }), role: "config" },
      { path: "index.js", content: "export const x = 1;\n" },
    ]);
    expect(noBin.projectTypeSignal).toBeUndefined();
  });
});

describe("inventory — completeness & resilience", () => {
  it("returns the FULL symbol list uncapped", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`export function f${i}() {}`);
    const inv = await inventory([{ path: "big.ts", content: lines.join("\n") }]);
    expect(inv.symbolCount).toBe(500);
    expect(inv.symbols).toHaveLength(500);
  });

  it("skips an unparseable file + an unreadable file, records them, and still succeeds", async () => {
    const throwingAdapter = {
      language: "generic" as const,
      extensions: [".bad"],
      parseFile() {
        throw new Error("boom");
      },
    };
    const registry = createParserRegistry([throwingAdapter, typescriptParser]);

    const inv = await inventory(
      [
        { path: "ok.ts", content: "export function ok() {}" },
        { path: "bad.bad", content: "garbage" },
      ],
      {
        registry,
        // structure also lists a file the reader cannot return (null content)
        structureFiles: [
          { path: "ok.ts", content: "export function ok() {}" },
          { path: "bad.bad", content: "garbage" },
          { path: "missing.ts", content: "" },
        ],
      },
    );

    expect(inv.symbols.map((s) => s.name)).toEqual(["ok"]);
    expect(inv.symbolCount).toBe(1);
    expect(inv.unparsedFiles).toEqual(expect.arrayContaining(["bad.bad", "missing.ts"]));
    expect(inv.loc["bad.bad"]).toBeUndefined();
  });

  it("throws if the structure slice is missing (Map-structure must run first)", async () => {
    const stage = createInventoryStage({ readFile: readerFor([]), now: () => 1 });
    const ctx = ctxFor([]);
    const noStructure: PipelineContext = { ...ctx, prior: {} };
    await expect(stage.run(input, noStructure)).rejects.toThrow(/structure/);
  });

  it("throws if repoPath is missing (Ingest must run first)", async () => {
    const stage = createInventoryStage({ readFile: readerFor([]), now: () => 1 });
    const ctx = ctxFor([]);
    const noRepo: PipelineContext = { ...ctx, repoPath: undefined };
    await expect(stage.run(input, noRepo)).rejects.toThrow(/repoPath/);
  });
});
