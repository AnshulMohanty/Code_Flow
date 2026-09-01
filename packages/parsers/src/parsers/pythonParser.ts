import type { DependencyEdge, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { resolvePythonImport } from "../resolution/importResolver.js";
import type { ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import {
  PY_FROM_IMPORT_LINE,
  PY_IMPORT_LINE,
  splitAliasSegments,
} from "../utils/importScan.js";
import { countLoc, indentationOf, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

export const pythonParser: ParserAdapter = {
  language: "python",
  extensions: [".py"],
  parseFile(input) {
    const lines = splitLines(input.content);
    const imports: ParsedImport[] = [];
    const symbols: ParsedSymbol[] = [];
    let activeClassIndent: number | null = null;

    lines.forEach((line, index) => {
      const currentLine = lineNumber(index);
      const trimmed = line.trim();
      const indent = indentationOf(line);

      if (activeClassIndent !== null && trimmed && indent <= activeClassIndent) {
        activeClassIndent = null;
      }

      const importMatch = PY_IMPORT_LINE.exec(trimmed);
      if (importMatch) {
        for (const part of importMatch[1].split(",")) {
          const source = splitAliasSegments(part)[0]?.trim();
          if (source) {
            imports.push({
              source,
              specifiers: [],
              importKind: "python",
              line: currentLine,
              confidence: 0.9,
            });
          }
        }
      }

      const fromMatch = PY_FROM_IMPORT_LINE.exec(trimmed);
      if (fromMatch) {
        const source = fromMatch[1];
        imports.push({
          source,
          specifiers: fromMatch[2].split(",").map((value) => splitAliasSegments(value)[0] ?? value.trim()),
          importKind: "python",
          line: currentLine,
          resolvedPath: resolvePythonImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
          confidence: source.startsWith(".") ? 0.8 : 0.9,
        });
      }

      const classMatch = line.match(/^(\s*)class\s+([A-Za-z_][\w]*)\s*(?:\([^)]*\))?:/);
      if (classMatch) {
        activeClassIndent = classMatch[1].length;
        symbols.push({
          name: classMatch[2],
          kind: "class",
          lineStart: currentLine,
          signature: trimmed,
          confidence: 0.8,
        });
      }

      const defMatch = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:/);
      if (defMatch) {
        const isMethod = activeClassIndent !== null && defMatch[1].length > activeClassIndent;
        symbols.push({
          name: defMatch[2],
          kind: isMethod ? "method" : "function",
          lineStart: currentLine,
          signature: trimmed,
          confidence: 0.8,
        });
      }
    });

    return {
      path: input.path,
      language: "python",
      extension: extensionOf(input.path),
      loc: countLoc(input.content),
      imports,
      exports: [] satisfies ParsedExport[],
      symbols,
      dependencies: imports.map((parsedImport, index) => toDependency(input.path, parsedImport, index)),
      warnings: [],
      parserVersion: PARSER_VERSION,
    };
  },
};

function toDependency(from: string, parsedImport: ParsedImport, index: number): DependencyEdge {
  return {
    id: `${from}:python-import:${index + 1}`,
    source: from,
    target: parsedImport.resolvedPath ?? parsedImport.source,
    kind: "import",
    weight: 1,
    from,
    to: parsedImport.resolvedPath ?? parsedImport.source,
    dependencyType: "python-import",
    confidence: parsedImport.confidence,
    evidence: parsedImport.source,
    sourceLine: parsedImport.line,
  };
}
