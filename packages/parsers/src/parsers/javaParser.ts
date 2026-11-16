import type { DependencyEdge, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import type { ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { scanJavaImports } from "../utils/importScan.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

const TYPE_LINE = /^\s*(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/;

/**
 * The regex Java parser: the fallback when the Java grammar did not load. Imports and type
 * declarations only — a missing grammar degrades the symbol list, never the import list.
 */
export const javaParser: ParserAdapter = {
  language: "java",
  extensions: [".java"],
  parseFile(input) {
    const imports: ParsedImport[] = scanJavaImports(input.content).map((entry) => ({
      source: entry.source,
      specifiers: [entry.source.split(".").pop() ?? entry.source],
      importKind: "static",
      line: entry.line,
      confidence: 0.8,
    }));
    const symbols: ParsedSymbol[] = [];
    splitLines(input.content).forEach((line, index) => {
      const type = TYPE_LINE.exec(line);
      if (!type) return;
      symbols.push({
        name: type[2],
        kind: type[1] === "class" || type[1] === "record" ? "class" : "unknown",
        lineStart: lineNumber(index),
        signature: `${type[1]} ${type[2]}`,
        exported: /\bpublic\b/.test(line),
        confidence: 0.7,
      });
    });
    return {
      path: input.path,
      language: "java",
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
