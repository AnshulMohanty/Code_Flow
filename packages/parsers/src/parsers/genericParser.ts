import type { DependencyEdge, ParserWarning } from "@codeflow/shared-types";
import { detectLanguage } from "../language.js";
import type { ParseFileInput, ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";

export const genericParser: ParserAdapter = {
  language: "generic",
  extensions: ["*"],
  parseFile(input: ParseFileInput) {
    return {
      path: input.path,
      language: detectLanguage(input.path),
      extension: extensionOf(input.path),
      loc: countLoc(input.content),
      imports: [],
      exports: [],
      symbols: [],
      dependencies: [] satisfies DependencyEdge[],
      warnings: findTodoWarnings(input.content),
      parserVersion: PARSER_VERSION,
    };
  },
};

function findTodoWarnings(content: string): ParserWarning[] {
  return splitLines(content).flatMap((line, index) => {
    if (/\b(?:TODO|FIXME)\b/i.test(line)) {
      return [
        {
          message: line.trim(),
          line: lineNumber(index),
          severity: "info" as const,
        },
      ];
    }
    return [];
  });
}
