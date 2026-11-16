import type { DependencyEdge, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import type { ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { scanCSharpUsings } from "../utils/importScan.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

const TYPE_LINE = /\b(class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/;

/** The regex C# parser: the fallback when the grammar did not load. `using`s and type declarations. */
export const csharpParser: ParserAdapter = {
  language: "csharp",
  extensions: [".cs"],
  parseFile(input) {
    const imports: ParsedImport[] = scanCSharpUsings(input.content).map((entry) => ({
      source: entry.target,
      specifiers: entry.alias ? [entry.alias] : [],
      importKind: "static",
      line: entry.line,
      confidence: 0.8,
    }));
    const symbols: ParsedSymbol[] = [];
    splitLines(input.content).forEach((line, index) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const type = TYPE_LINE.exec(line);
      if (type) {
        symbols.push({
          name: type[2],
          kind: type[1] === "interface" || type[1] === "enum" ? "unknown" : "class",
          lineStart: lineNumber(index),
          signature: `${type[1]} ${type[2]}`,
          exported: /\bpublic\b/.test(line),
          confidence: 0.7,
        });
      }
    });
    return {
      path: input.path,
      language: "csharp",
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
