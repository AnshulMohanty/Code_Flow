import type { DependencyEdge, LanguageId, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import type { ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { scanCIncludes } from "../utils/importScan.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

const FUNCTION_LINE = /^(?!\s*(?:if|for|while|switch|return|else)\b)[A-Za-z_][\w\s\*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*$/;

/**
 * The regex C/C++ parser: the fallback when the grammar did not load. `#include`s and a rough list
 * of function definitions — a missing grammar degrades the symbol list, never the include graph.
 */
function cFamilyParser(language: LanguageId, extensions: string[]): ParserAdapter {
  return {
    language,
    extensions,
    parseFile(input) {
      const imports: ParsedImport[] = scanCIncludes(input.content).map((entry) => ({
        source: entry.path,
        specifiers: [],
        importKind: "static",
        line: entry.line,
        confidence: 0.8,
      }));
      const symbols: ParsedSymbol[] = [];
      splitLines(input.content).forEach((line, index) => {
        if (/^\s/.test(line)) return; // definitions start at column 0 in the overwhelming majority of C
        const match = FUNCTION_LINE.exec(line);
        if (match) symbols.push({ name: match[1], kind: "function", lineStart: lineNumber(index), signature: line.trim(), confidence: 0.6 });
      });
      return {
        path: input.path,
        language,
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
}

export const cParser = cFamilyParser("c", [".c", ".h"]);
export const cppParser = cFamilyParser("cpp", [".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".ipp", ".inl", ".tcc"]);
