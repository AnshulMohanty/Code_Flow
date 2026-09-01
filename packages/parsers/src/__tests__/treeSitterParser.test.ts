import { describe, expect, it } from "vitest";
import { createParserRegistry } from "../registry.js";
import { javascriptParser } from "../parsers/javascriptParser.js";
import { pythonParser } from "../parsers/pythonParser.js";
import { tsxParser, typescriptParser } from "../parsers/typescriptParser.js";
import { createTreeSitterParser } from "../treesitter/parseTreeSitter.js";
import { initTreeSitter, treeSitterStatus, TREE_SITTER_LANGUAGES } from "../treesitter/runtime.js";
import { PARSER_VERSION, TREE_SITTER_PARSER_VERSION } from "../types.js";

// Hermetic: the grammars are local `.wasm` files from a prod dependency. No network, no
// native toolchain, no live services.
//
// Loaded at MODULE scope (top-level await), not in `beforeAll` — a describe body runs during
// collection, so a parse there would silently use the regex fallback.
await initTreeSitter();

const js = createTreeSitterParser(javascriptParser);
const ts = createTreeSitterParser(typescriptParser);
const tsx = createTreeSitterParser(tsxParser);
const py = createTreeSitterParser(pythonParser);

describe("tree-sitter runtime", () => {
  it("loads a grammar for every supported language", () => {
    const status = treeSitterStatus();
    expect(status.ready).toBe(true);
    expect(status.loaded).toEqual(TREE_SITTER_LANGUAGES);
    expect(status.failed).toEqual([]);
  });

  it("is idempotent — repeat init shares one load", async () => {
    const first = await initTreeSitter();
    const second = await initTreeSitter();
    expect(second).toEqual(first);
  });

  it("marks tree-sitter output with its own parserVersion", () => {
    const parsed = js.parseFile({ path: "src/a.js", content: "export function a() {}\n" });
    expect(parsed.parserVersion).toBe(TREE_SITTER_PARSER_VERSION);
    expect(TREE_SITTER_PARSER_VERSION).not.toBe(PARSER_VERSION);
  });

  it("falls back to the regex parser for a language with no grammar (coverage never regresses)", () => {
    // `generic` has no grammar, so the registry hands back the regex generic parser.
    const registry = createParserRegistry();
    const parsed = registry.parseFile({ path: "notes.md", content: "# hi\nTODO: later\n" });
    expect(parsed.parserVersion).toBe(PARSER_VERSION);
    expect(parsed.imports).toEqual([]);
  });

  it("falls back to regex above the file-size guard, deterministically", () => {
    // Over TREE_SITTER_MAX_BYTES (2 MB) → regex engine, same ParserAdapter shape.
    const padding = `// ${"x".repeat(2 * 1024 * 1024)}\n`;
    const parsed = js.parseFile({ path: "src/huge.js", content: `${padding}export function big() {}\n` });
    expect(parsed.parserVersion).toBe(PARSER_VERSION);
    expect(parsed.symbols.map((symbol) => symbol.name)).toContain("big");
  });
});

describe("tree-sitter javascript parser", () => {
  const parsed = js.parseFile({
    path: "src/App.jsx",
    content: `
import React, { useMemo as memo } from "react";
import * as utils from "./utils";
import "./styles.css";
const helper = require("../helper");
const lazy = import("./lazy");
export function useThing() { return memo(() => 1, []); }
export class Widget {}
function plain() {}
const Dashboard = () => null;
export { Dashboard };
`,
  });

  it("extracts every import kind with specifiers", () => {
    expect(parsed.imports.map((item) => item.source)).toEqual([
      "react",
      "./utils",
      "./styles.css",
      "../helper",
      "./lazy",
    ]);
    expect(parsed.imports.find((item) => item.source === "react")?.specifiers).toEqual(["React", "memo"]);
    expect(parsed.imports.find((item) => item.source === "./utils")?.specifiers).toEqual(["utils"]);
    expect(parsed.imports.find((item) => item.source === "../helper")?.importKind).toBe("commonjs");
    expect(parsed.imports.find((item) => item.source === "../helper")?.specifiers).toEqual(["helper"]);
    expect(parsed.imports.find((item) => item.source === "./lazy")?.importKind).toBe("dynamic");
    expect(parsed.dependencies).toHaveLength(5);
  });

  it("extracts exports and classifies component / hook symbols", () => {
    expect(parsed.exports.map((item) => item.name).sort()).toEqual(["Dashboard", "Widget", "useThing"]);
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "useThing", kind: "hook", exported: true }),
        expect.objectContaining({ name: "Widget", kind: "class", exported: true }),
        expect.objectContaining({ name: "plain", kind: "function", exported: false }),
        expect.objectContaining({ name: "Dashboard", kind: "component" }),
      ]),
    );
  });

  it("gives every symbol a real end line (regex parsing could not)", () => {
    const widget = parsed.symbols.find((symbol) => symbol.name === "useThing");
    expect(widget?.lineStart).toBe(7);
    expect(widget?.lineEnd).toBe(7);
    for (const symbol of parsed.symbols) {
      expect(symbol.lineEnd).toBeGreaterThanOrEqual(symbol.lineStart);
    }
  });

  // The accuracy wins that a line-oriented regex structurally cannot get right.
  it("reads multi-line imports the regex parser missed", () => {
    const content = ["import {", "  alpha,", "  beta as gamma,", "} from './wide';", ""].join("\n");
    const multi = js.parseFile({ path: "src/multi.js", content });
    expect(multi.imports).toEqual([
      expect.objectContaining({ source: "./wide", specifiers: ["alpha", "gamma"], importKind: "static" }),
    ]);
    // Proof this is a real gain, not a wash: the line-oriented regex engine finds nothing.
    expect(javascriptParser.parseFile({ path: "src/multi.js", content }).imports).toEqual([]);
  });

  it("does not invent an import from a commented-out one", () => {
    const content = ["// import('./commented-out');", "import real from './real';", ""].join("\n");
    expect(js.parseFile({ path: "src/quiet.js", content }).imports.map((item) => item.source)).toEqual(["./real"]);
    // The regex engine reads the comment as a real dynamic import — a false POSITIVE that
    // becomes a fabricated graph edge. Tree-sitter knows it is a comment.
    expect(javascriptParser.parseFile({ path: "src/quiet.js", content }).imports.map((item) => item.source)).toEqual([
      "./commented-out",
      "./real",
    ]);
  });
});

describe("tree-sitter typescript parser", () => {
  const parsed = ts.parseFile({
    path: "src/domain/user.ts",
    content: `
import type { UserId } from "./ids";
export interface User { id: UserId }
export type UserName = string;
export enum Role { Admin }
export async function loadUser() { return null; }
export class UserService extends BaseService {
  load(id: UserId) { return id; }
  private cache = new Map();
}
const internal = 42;
`,
  });

  it("extracts type-level declarations with the signature Inventory reads kinds from", () => {
    const byName = new Map(parsed.symbols.map((symbol) => [symbol.name, symbol]));
    // kind "unknown" + a signature is the protocol Inventory's inferKindFromSignature uses.
    expect(byName.get("User")).toEqual(
      expect.objectContaining({ kind: "unknown", exported: true, signature: "export interface User { id: UserId }" }),
    );
    expect(byName.get("UserName")?.signature).toBe("export type UserName = string;");
    expect(byName.get("Role")?.signature).toBe("export enum Role { Admin }");
  });

  it("extracts class methods — a symbol class the regex parser never produced for TS", () => {
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "load", kind: "method" })]),
    );
    expect(typescriptParser.parseFile({ path: "src/domain/user.ts", content: "class A { load() {} }\n" }).symbols).toEqual(
      [expect.objectContaining({ name: "A", kind: "class" })],
    );
  });

  it("records unexported top-level values and a class's real span", () => {
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "internal", kind: "variable", exported: false })]),
    );
    const service = parsed.symbols.find((symbol) => symbol.name === "UserService");
    expect(service?.lineStart).toBe(7);
    expect(service?.lineEnd).toBe(10);
  });

  it("handles `import x = require(...)` and re-export sources", () => {
    const legacy = ts.parseFile({
      path: "src/legacy.ts",
      content: 'import legacy = require("./legacy-impl");\nexport { thing } from "./other";\n',
    });
    expect(legacy.imports).toEqual([
      expect.objectContaining({ source: "./legacy-impl", importKind: "commonjs", specifiers: ["legacy"] }),
    ]);
    // A re-export is a dependency, not an import binding — it stays out of `imports`
    // (Connect classifies re-export edges) but its NAME is part of the export surface.
    expect(legacy.exports.map((item) => item.name)).toEqual(["thing"]);
  });
});

describe("tree-sitter tsx parser", () => {
  it("detects components and hooks through JSX", () => {
    const parsed = tsx.parseFile({
      path: "src/components/Profile.tsx",
      content: `
import React from "react";
export const ProfileCard = () => <section />;
const useProfile = () => ({});
`,
    });
    expect(parsed.language).toBe("tsx");
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "ProfileCard", kind: "component", exported: true }),
        expect.objectContaining({ name: "useProfile", kind: "hook" }),
      ]),
    );
  });
});

describe("tree-sitter python parser", () => {
  const parsed = py.parseFile({
    path: "pkg/service.py",
    content: `
import os, sys as system
from .models import User
from package.module import thing as alias
from . import sibling

class Service(Base):
    def __init__(self):
        pass

    @property
    async def load(self):
        return None

def build_service():
    return Service()
`,
  });

  it("extracts plain, aliased, relative and bare-relative imports", () => {
    expect(parsed.imports.map((item) => item.source)).toEqual([
      "os",
      "sys",
      ".models",
      "package.module",
      ".",
    ]);
    expect(parsed.imports.find((item) => item.source === "package.module")?.specifiers).toEqual(["thing"]);
    expect(parsed.imports.find((item) => item.source === ".")?.specifiers).toEqual(["sibling"]);
    expect(parsed.dependencies).toHaveLength(5);
  });

  it("distinguishes methods from functions structurally, decorators included", () => {
    expect(parsed.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Service", kind: "class" }),
        expect.objectContaining({ name: "__init__", kind: "method" }),
        expect.objectContaining({ name: "load", kind: "method" }),
        expect.objectContaining({ name: "build_service", kind: "function" }),
      ]),
    );
    // The decorated method's signature is the `async def` line, not the decorator.
    expect(parsed.symbols.find((symbol) => symbol.name === "load")?.signature).toBe("async def load(self):");
  });

  it("keeps `exports` empty — Python has no export syntax to read", () => {
    expect(parsed.exports).toEqual([]);
  });
});
