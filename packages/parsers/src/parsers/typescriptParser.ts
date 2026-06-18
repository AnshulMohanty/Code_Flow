import type { ParseFileInput } from "../types.js";
import { createJavaScriptParser, parseJavaScriptLike } from "./javascriptParser.js";
import { lineNumber, splitLines } from "../utils/lineUtils.js";
import { uniquePush } from "../utils/symbolUtils.js";

export const typescriptParser = createJavaScriptParser("typescript", [".ts"]);
export const tsxParser = createJavaScriptParser("tsx", [".tsx"]);
export const jsxParser = createJavaScriptParser("jsx", [".jsx"]);

export function parseTypeScriptLike(input: ParseFileInput, language: "typescript" | "tsx") {
  const parsed = parseJavaScriptLike(input, language);
  splitLines(input.content).forEach((line, index) => {
    const currentLine = lineNumber(index);
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (interfaceMatch) {
      uniquePush(
        parsed.symbols,
        {
          name: interfaceMatch[1],
          kind: "unknown",
          lineStart: currentLine,
          signature: line.trim(),
          exported: /^\s*export\b/.test(line),
          confidence: 0.8,
        },
        (symbol) => `${symbol.name}:${symbol.lineStart}:${symbol.kind}`,
      );
    }

    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (typeMatch) {
      uniquePush(
        parsed.symbols,
        {
          name: typeMatch[1],
          kind: "unknown",
          lineStart: currentLine,
          signature: line.trim(),
          exported: /^\s*export\b/.test(line),
          confidence: 0.8,
        },
        (symbol) => `${symbol.name}:${symbol.lineStart}:${symbol.kind}`,
      );
    }
  });

  return parsed;
}

typescriptParser.parseFile = (input) => parseTypeScriptLike(input, "typescript");
tsxParser.parseFile = (input) => parseTypeScriptLike(input, "tsx");
