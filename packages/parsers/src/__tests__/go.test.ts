import { describe, expect, it } from "vitest";
import { goParser } from "../parsers/goParser.js";
import { createParserRegistry } from "../registry.js";
import { extractCpgFacts } from "../treesitter/cpg.js";
import { isGoExported } from "../treesitter/go.js";
import { initTreeSitter } from "../treesitter/runtime.js";
import { PARSER_VERSION, TREE_SITTER_PARSER_VERSION } from "../types.js";
import { scanGoImports } from "../utils/importScan.js";

await initTreeSitter();

const SERVER = `package server

import "fmt"
import (
	cfg "github.com/acme/app/internal/config"
	. "github.com/acme/app/pkg/dot"
	_ "github.com/acme/app/pkg/side"
	"github.com/acme/app/pkg/store" // trailing comment
	raw \`github.com/acme/app/pkg/raw\`
)

type Server struct {
	store.Store
	*Local
	c *cfg.Config
}

type (
	Handler func()
	Reader interface{ Read() error }
)

var (
	Default, other = cfg.Default, 1
)

const Version = "1"

func New(c cfg.Config) *Server { fmt.Println(store.Open()); Helper(); return &Server{} }

func (s *Server) Run() error { http.HandleFunc("/health", nil); r.GET("/users/:id", nil); return nil }

func init() {}
`;

describe("Go — graph facts (tree-sitter)", () => {
  const facts = extractCpgFacts({ path: "internal/server/server.go", content: SERVER });

  it("reads the package clause and every import form", () => {
    expect(facts.engine).toBe(TREE_SITTER_PARSER_VERSION);
    expect(facts.packageName).toBe("server");
    expect(facts.imports.map(({ source, specifiers }) => [source, specifiers])).toEqual([
      ["fmt", []],
      ["github.com/acme/app/internal/config", ["cfg"]],
      ["github.com/acme/app/pkg/dot", ["."]],
      ["github.com/acme/app/pkg/side", ["_"]],
      ["github.com/acme/app/pkg/store", []],
      ["github.com/acme/app/pkg/raw", ["raw"]],
    ]);
  });

  it("lists top-level declarations — funcs, types, grouped vars and consts — but not methods", () => {
    expect(facts.declarations!.map((decl) => decl.name).sort()).toEqual(
      ["Default", "Handler", "New", "Reader", "Server", "Version", "init", "other"].sort(),
    );
  });

  it("records x.Y references in types and expressions, and calls by their root binding", () => {
    const refs = facts.references!.map((ref) => ref.symbol);
    expect(refs).toEqual(expect.arrayContaining(["cfg.Config", "cfg.Default", "store.Open", "store.Store", "fmt.Println"]));
    const calls = facts.calls.map((call) => [call.binding, call.symbol]);
    expect(calls).toEqual(expect.arrayContaining([["store", "store.Open"], ["Helper", "Helper"], ["fmt", "fmt.Println"]]));
  });

  it("treats embedding as inheritance", () => {
    expect(facts.inheritance.map((relation) => relation.symbol)).toEqual(["store.Store", "Local"]);
  });

  it("finds net/http and router routes", () => {
    expect(facts.routes.map(({ method, path }) => [method, path])).toEqual([
      ["ALL", "/health"],
      ["GET", "/users/:id"],
    ]);
  });
});

describe("Go — Inventory symbols", () => {
  it("projects declarations and methods, exported by capitalisation", () => {
    const registry = createParserRegistry();
    const parsed = registry.parseFile({ path: "internal/server/server.go", content: SERVER });
    expect(parsed.language).toBe("go");
    expect(parsed.parserVersion).toBe(TREE_SITTER_PARSER_VERSION);
    const byName = Object.fromEntries(parsed.symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.Server).toMatchObject({ kind: "class", exported: true });
    expect(byName["Server.Run"]).toMatchObject({ kind: "method", exported: true });
    expect(byName.other).toMatchObject({ kind: "variable", exported: false });
    expect(byName.init).toBeUndefined();
    expect(parsed.exports.map((entry) => entry.name)).toEqual(["Server", "Handler", "Reader", "Default", "Version", "New"]);
  });

  it("isGoExported follows the language rule, including non-ASCII", () => {
    expect(isGoExported("Open")).toBe(true);
    expect(isGoExported("open")).toBe(false);
    expect(isGoExported("_x")).toBe(false);
    expect(isGoExported("Ünïcode")).toBe(true);
  });
});

describe("Go — regex fallback", () => {
  it("scans single and grouped imports, aliases and raw strings", () => {
    expect(scanGoImports(SERVER).map(({ source, name }) => [source, name])).toEqual([
      ["fmt", undefined],
      ["github.com/acme/app/internal/config", "cfg"],
      ["github.com/acme/app/pkg/dot", "."],
      ["github.com/acme/app/pkg/side", "_"],
      ["github.com/acme/app/pkg/store", undefined],
      ["github.com/acme/app/pkg/raw", "raw"],
    ]);
    expect(scanGoImports('package x\nimport ( "a"; "b" )\n').map((entry) => entry.source)).toEqual(["a"]);
    expect(scanGoImports("package x\n// import \"nope\"\nvar importer = 1\n")).toEqual([]);
  });

  it("the fallback parser keeps imports and symbols when the grammar is missing", () => {
    const parsed = goParser.parseFile({ path: "a.go", content: SERVER });
    expect(parsed.parserVersion).toBe(PARSER_VERSION);
    expect(parsed.imports).toHaveLength(6);
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(
      expect.arrayContaining(["Server", "New", "Server.Run", "init"]),
    );
  });
});
