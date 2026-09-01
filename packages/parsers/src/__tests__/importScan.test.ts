import { describe, expect, it } from "vitest";
import { javascriptParser } from "../parsers/javascriptParser.js";
import { pythonParser } from "../parsers/pythonParser.js";
import { extractCpgFacts } from "../treesitter/cpg.js";
import {
  ARROW_ASSIGNMENT_LINE,
  namedBraceBody,
  parseStaticImportLine,
  PY_FROM_IMPORT_LINE,
  PY_IMPORT_LINE,
  splitAliasSegments,
} from "../utils/importScan.js";

/**
 * A line of source long enough that the patterns these scanners replaced could not finish it.
 *
 * Every one of them was quadratic or cubic in the length of a whitespace run: measured on the old
 * patterns, `import ` plus 4 000 spaces did not complete in twenty seconds, and the Python import
 * patterns took 608 ms at 16 000. At 200 000 the old cost is hours. The linear replacements
 * measure between 0.1 ms and 2 ms, so a two-second budget cannot flake and cannot be met by a
 * quadratic implementation.
 */
const PATHOLOGICAL_LENGTH = 200_000;
const REDOS_BUDGET_MS = 2_000;

/**
 * U+2028 LINE SEPARATOR is whitespace to `\s` but invisible to `.`, and `splitLines` does not
 * split on it — which is what makes a pathological "line" reachable and survive `.trim()`.
 * Built with `fromCharCode` rather than written literally: a raw line separator in source is an
 * invisible character, and some tools read it as a newline.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);

function withinBudget(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("importScan — behaviour preserved", () => {
  it("reads Python import lines, pinning the tail with \\S", () => {
    expect(PY_IMPORT_LINE.exec("import os")?.[1]).toBe("os");
    expect(PY_IMPORT_LINE.exec("import  os  as  o")?.[1]).toBe("os  as  o");
    expect(PY_IMPORT_LINE.exec("importos")).toBeNull();
    expect(PY_IMPORT_LINE.exec("import")).toBeNull();
  });

  it("reads Python from-import lines", () => {
    const match = PY_FROM_IMPORT_LINE.exec("from a.b import c, d as e");
    expect(match?.[1]).toBe("a.b");
    expect(match?.[2]).toBe("c, d as e");
    expect(PY_FROM_IMPORT_LINE.exec("from . import x")?.[1]).toBe(".");
    expect(PY_FROM_IMPORT_LINE.exec("fromx import y")).toBeNull();
  });

  it("splits on a whitespace-delimited `as`", () => {
    expect(splitAliasSegments("os")).toEqual(["os"]);
    expect(splitAliasSegments("os as o")).toEqual(["os", "o"]);
    expect(splitAliasSegments("a as b as c")).toEqual(["a", "b", "c"]);
    expect(splitAliasSegments("a  as  b")).toEqual(["a", "b"]);
    expect(splitAliasSegments("")).toEqual([""]);
  });

  it("needs a token on both sides of `as`, as `\\s+as\\s+` did", () => {
    // The delimiter required whitespace either side, so neither of these was a split point.
    expect(splitAliasSegments("x as")).toEqual(["x as"]);
    expect(splitAliasSegments("as x")).toEqual(["as x"]);
  });

  it("takes the first `{...}` body, including when braces nest", () => {
    expect(namedBraceBody("{ a, b }")).toBe(" a, b ");
    expect(namedBraceBody("{}")).toBeNull(); // `[^}]+` required a character
    expect(namedBraceBody("no braces")).toBeNull();
    expect(namedBraceBody("{ a, { b } }")).toBe(" a, { b ");
  });

  it("reads every static import form", () => {
    expect(parseStaticImportLine('import "./side.js"')).toEqual({ specifiers: "", source: "./side.js" });
    expect(parseStaticImportLine('import x from "./a"')).toEqual({ specifiers: "x", source: "./a" });
    expect(parseStaticImportLine("import x from './a'")).toEqual({ specifiers: "x", source: "./a" });
    expect(parseStaticImportLine('import { a, b } from "./a"')).toEqual({ specifiers: "{ a, b }", source: "./a" });
    expect(parseStaticImportLine('import * as ns from "./a"')).toEqual({ specifiers: "* as ns", source: "./a" });
    expect(parseStaticImportLine('import type { T } from "./t"')).toEqual({ specifiers: "{ T }", source: "./t" });
    expect(parseStaticImportLine('import x, { y } from "./a"')).toEqual({ specifiers: "x, { y }", source: "./a" });
    expect(parseStaticImportLine('  import x from "./a"')).toEqual({ specifiers: "x", source: "./a" });
  });

  it("rejects the near-misses the pattern it replaced also rejected", () => {
    expect(parseStaticImportLine('import x from"./a"')).toBeNull(); // `from` needed trailing whitespace
    expect(parseStaticImportLine('importx from "m"')).toBeNull();
    expect(parseStaticImportLine('export { a } from "./a"')).toBeNull();
    expect(parseStaticImportLine('import from "m"')).toBeNull(); // `from` needed a specifier before it
  });

  it("keeps the `type` keyword's backtracking behaviour", () => {
    // `(?:type\s+)?` was greedy-optional and gave the keyword back when the rest failed.
    expect(parseStaticImportLine('import type from "m"')).toEqual({ specifiers: "type", source: "m" });
    expect(parseStaticImportLine('import typex from "m"')).toEqual({ specifiers: "typex", source: "m" });
    expect(parseStaticImportLine('import type "x"')).toEqual({ specifiers: "", source: "x" });
  });

  it("reads `import \"a\" from \"b\"` as a side-effect import of `a`", () => {
    // The one behaviour change, on a line that is not valid JavaScript in any dialect: the lazy
    // `(.*?)` was free to swallow a quoted string and reported `b`. `[^"']*` stops at the quote.
    expect(parseStaticImportLine('import "a" from "b"')).toEqual({ specifiers: "", source: "a" });
  });

  it("matches arrow assignments and nothing else", () => {
    expect(ARROW_ASSIGNMENT_LINE.exec("const f = () => 1")?.[1]).toBe("f");
    expect(ARROW_ASSIGNMENT_LINE.exec("export const g = async (a, b) => a")?.[1]).toBe("g");
    expect(ARROW_ASSIGNMENT_LINE.exec("var h = a => a")?.[1]).toBe("h");
    expect(ARROW_ASSIGNMENT_LINE.exec("const x = 5")).toBeNull();
    expect(ARROW_ASSIGNMENT_LINE.exec("const y = a === b")).toBeNull();
    expect(ARROW_ASSIGNMENT_LINE.exec("const noArrow = function () {}")).toBeNull();
  });
});

describe("importScan — ReDoS regression", () => {
  const spaces = " ".repeat(PATHOLOGICAL_LENGTH);

  it.each([
    // U+2028 is whitespace to `\s` but not to `.`, and `splitLines` does not split on it, so this
    // is one line as far as the parser is concerned. The trailing `y` survives `.trim()`.
    ["PY_IMPORT_LINE", () => PY_IMPORT_LINE.exec(`import${spaces}${"X".repeat(PATHOLOGICAL_LENGTH)}${LINE_SEPARATOR}y`)],
    ["PY_FROM_IMPORT_LINE", () => PY_FROM_IMPORT_LINE.exec(`from . import${spaces}${"X".repeat(PATHOLOGICAL_LENGTH)}${LINE_SEPARATOR}y`)],
    ["parseStaticImportLine", () => parseStaticImportLine(`import ${spaces}`)],
    ["ARROW_ASSIGNMENT_LINE", () => ARROW_ASSIGNMENT_LINE.exec(`let $=${spaces}`)],
    ["namedBraceBody", () => namedBraceBody("{".repeat(PATHOLOGICAL_LENGTH))],
    ["splitAliasSegments", () => splitAliasSegments(spaces)],
  ])("%s stays linear on a pathological line", (_name, run) => {
    expect(withinBudget(run)).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("the Python parser does not stall on a pathological line", () => {
    const content = `import${spaces}${"X".repeat(PATHOLOGICAL_LENGTH)}${LINE_SEPARATOR}y\nfrom . import${spaces}z${LINE_SEPARATOR}w`;
    const elapsed = withinBudget(() => {
      pythonParser.parseFile({ path: "a.py", repoRoot: "/repo", content });
    });
    expect(elapsed).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("the JavaScript parser does not stall on a pathological line", () => {
    const content = `import ${spaces}\nlet $=${spaces}\nimport {${"{".repeat(PATHOLOGICAL_LENGTH)} from "m"`;
    const elapsed = withinBudget(() => {
      javascriptParser.parseFile({ path: "a.js", repoRoot: "/repo", content });
    });
    expect(elapsed).toBeLessThan(REDOS_BUDGET_MS);
  });

  it("the tree-sitter regex fallback does not stall on a pathological line", () => {
    // No grammar is loaded in the test process, so this exercises the fallback scanner.
    const python = withinBudget(() => {
      extractCpgFacts({
        path: "a.py",
        repoRoot: "/repo",
        content: `import${spaces}${"X".repeat(PATHOLOGICAL_LENGTH)}${LINE_SEPARATOR}y`,
      });
    });
    const javascript = withinBudget(() => {
      extractCpgFacts({ path: "a.js", repoRoot: "/repo", content: `import ${spaces}` });
    });
    expect(python).toBeLessThan(REDOS_BUDGET_MS);
    expect(javascript).toBeLessThan(REDOS_BUDGET_MS);
  });
});
