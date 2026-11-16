import { describe, expect, it } from "vitest";
import { javaParser } from "../parsers/javaParser.js";
import { createParserRegistry } from "../registry.js";
import { extractCpgFacts } from "../treesitter/cpg.js";
import { initTreeSitter } from "../treesitter/runtime.js";
import { PARSER_VERSION, TREE_SITTER_PARSER_VERSION } from "../types.js";
import { scanJavaImports } from "../utils/importScan.js";

await initTreeSitter({ languages: ["java"] });

const SOURCE = `package com.acme.app;

import java.util.List;
import com.acme.util.Strings;
import com.acme.model.*;
import static com.acme.util.Checks.notNull;

@Service
public class Sample<T> extends Base implements Runnable, com.acme.api.Api {
    private final Strings.Helper helper = new Strings.Helper();
    @GetMapping("/users/{id}") public void run() { Util.call(); notNull(x); com.acme.other.Thing t = null; List<Model> m; Route::handle; }
    public static void main(String[] args) {}
    static class Builder {}
}
`;

describe("Java — graph facts (tree-sitter)", () => {
  const facts = extractCpgFacts({ path: "src/main/java/com/acme/app/Sample.java", content: SOURCE });

  it("reads the package, imports (static, on-demand) and top-level types", () => {
    expect(facts.engine).toBe(TREE_SITTER_PARSER_VERSION);
    expect(facts.packageName).toBe("com.acme.app");
    expect(facts.imports.map(({ source, isStatic }) => [source, Boolean(isStatic)])).toEqual([
      ["java.util.List", false],
      ["com.acme.util.Strings", false],
      ["com.acme.model.*", false],
      ["com.acme.util.Checks.notNull", true],
    ]);
    expect(facts.imports.every((entry) => entry.lazy)).toBe(true); // a JVM class cycle is not a load-time failure
    expect(facts.declarations!.map((decl) => decl.name)).toEqual(["Sample"]);
  });

  it("collects every type name used, the names that shadow, and fully qualified uses", () => {
    expect(facts.typeRefs).toEqual(expect.arrayContaining(["Base", "Runnable", "Strings", "Service", "Util", "List", "Model", "Route", "GetMapping"]));
    expect(facts.typeRefs).not.toContain("T"); // a type parameter, not a type
    expect(facts.localTypes).toEqual(["Builder", "Sample", "T"]);
    expect(facts.qualifiedRefs).toEqual(expect.arrayContaining(["com.acme.api.Api", "com.acme.other.Thing"]));
    expect(facts.headerRefs).toEqual(["Base", "Runnable"]);
  });

  it("finds Spring routes", () => {
    expect(facts.routes).toEqual([{ method: "GET", path: "/users/{id}", line: 11, framework: "unknown" }]);
  });

  it("parses past raw NUL bytes inside string literals (commons-lang fuzz tests)", () => {
    const content = `package p;\nclass T { String s = "a\u0000b"; void f() { Later.call(); } }\n`;
    expect(extractCpgFacts({ path: "T.java", content }).typeRefs).toContain("Later");
  });
});

describe("Java — Inventory symbols and fallback", () => {
  it("projects types and Class.method symbols", () => {
    const parsed = createParserRegistry().parseFile({ path: "Sample.java", content: SOURCE });
    expect(parsed.language).toBe("java");
    const names = parsed.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["Sample", "Sample.Builder", "Sample.run", "Sample.main"]));
    expect(parsed.exports.map((entry) => entry.name)).toEqual(["Sample"]);
  });

  it("the regex fallback keeps imports and types", () => {
    expect(scanJavaImports(SOURCE).map((entry) => entry.source)).toEqual([
      "java.util.List",
      "com.acme.util.Strings",
      "com.acme.model.*",
      "com.acme.util.Checks.notNull",
    ]);
    const parsed = javaParser.parseFile({ path: "Sample.java", content: SOURCE });
    expect(parsed.parserVersion).toBe(PARSER_VERSION);
    expect(parsed.symbols.map((symbol) => symbol.name)).toEqual(["Sample", "Builder"]);
  });
});
