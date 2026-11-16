import type { DependencyEdge, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import type { ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { scanGoImports } from "../utils/importScan.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

const FUNC_LINE = /^func\s+(?:\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*)?([A-Za-z_]\w*)/;
const TYPE_LINE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)?/;

/**
 * The regex Go parser: the fallback `createTreeSitterParser` uses when the Go grammar did
 * not load. Imports (single and grouped) plus top-level funcs, methods and types — enough
 * that a missing grammar degrades the symbol list, never the dependency graph.
 */
export const goParser: ParserAdapter = {
  language: "go",
  extensions: [".go"],
  parseFile(input) {
    const imports: ParsedImport[] = scanGoImports(input.content).map((entry) => ({
      source: entry.source,
      specifiers: entry.name ? [entry.name] : [],
      importKind: "static",
      line: entry.line,
      confidence: 0.8,
    }));
    const symbols: ParsedSymbol[] = [];
    splitLines(input.content).forEach((line, index) => {
      const func = FUNC_LINE.exec(line);
      if (func) {
        const [, receiver, name] = func;
        symbols.push({
          name: receiver ? `${receiver}.${name}` : name,
          kind: receiver ? "method" : "function",
          lineStart: lineNumber(index),
          signature: line.trim(),
          exported: /^[A-Z]/.test(name),
          confidence: 0.7,
        });
        return;
      }
      const type = TYPE_LINE.exec(line);
      if (type) {
        symbols.push({
          name: type[1],
          kind: type[2] === "struct" ? "class" : "unknown",
          lineStart: lineNumber(index),
          signature: line.trim(),
          exported: /^[A-Z]/.test(type[1]),
          confidence: 0.7,
        });
      }
    });
    return {
      path: input.path,
      language: "go",
      extension: extensionOf(input.path),
      loc: countLoc(input.content),
      imports,
      exports: [],
      symbols,
      dependencies: imports.map((entry, index): DependencyEdge => ({
        id: `${input.path}:import:${index + 1}`,
        source: input.path,
        target: entry.source,
        kind: "import",
        weight: 1,
        from: input.path,
        to: entry.source,
        dependencyType: "import",
        confidence: entry.confidence,
        evidence: entry.source,
        sourceLine: entry.line,
      })),
      warnings: [],
      parserVersion: PARSER_VERSION,
    };
  },
};
