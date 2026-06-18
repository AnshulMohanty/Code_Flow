import type { DependencyEdge, LanguageId, ParsedExport, ParsedImport, ParsedSymbol } from "@codeflow/shared-types";
import { resolveRelativeImport } from "../resolution/importResolver.js";
import type { ParseFileInput, ParserAdapter } from "../types.js";
import { PARSER_VERSION } from "../types.js";
import { countLoc, lineNumber, splitLines } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";
import { isPascalCase, isReactHookName, uniquePush } from "../utils/symbolUtils.js";

export function createJavaScriptParser(language: LanguageId, extensions: string[]): ParserAdapter {
  return {
    language,
    extensions,
    parseFile(input) {
      return parseJavaScriptLike(input, language);
    },
  };
}

export const javascriptParser = createJavaScriptParser("javascript", [".js", ".mjs", ".cjs"]);

export function parseJavaScriptLike(input: ParseFileInput, language: LanguageId) {
  const lines = splitLines(input.content);
  const imports: ParsedImport[] = [];
  const exports: ParsedExport[] = [];
  const symbols: ParsedSymbol[] = [];

  lines.forEach((line, index) => {
    const currentLine = lineNumber(index);
    collectImports(line, currentLine, input, imports);
    collectExports(line, currentLine, exports);
    collectSymbols(line, currentLine, exports, symbols);
  });

  return {
    path: input.path,
    language,
    extension: extensionOf(input.path),
    loc: countLoc(input.content),
    imports,
    exports,
    symbols,
    dependencies: imports.map((parsedImport, index) => toDependency(input.path, parsedImport, index)),
    warnings: [],
    parserVersion: PARSER_VERSION,
  };
}

function collectImports(line: string, currentLine: number, input: ParseFileInput, imports: ParsedImport[]) {
  const staticMatch = line.match(/^\s*import\s+(?:type\s+)?(?:(.*?)\s+from\s+)?["']([^"']+)["']/);
  if (staticMatch) {
    const source = staticMatch[2];
    imports.push({
      source,
      specifiers: parseImportSpecifiers(staticMatch[1] ?? ""),
      importKind: "static",
      line: currentLine,
      resolvedPath: resolveRelativeImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
      confidence: source.startsWith(".") ? 1.0 : 0.9,
    });
  }

  const requireMatch = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/);
  if (requireMatch) {
    const source = requireMatch[2];
    imports.push({
      source,
      specifiers: [requireMatch[1]],
      importKind: "commonjs",
      line: currentLine,
      resolvedPath: resolveRelativeImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
      confidence: source.startsWith(".") ? 1.0 : 0.9,
    });
  }

  const dynamicMatch = line.match(/\bimport\(\s*["']([^"']+)["']\s*\)/);
  if (dynamicMatch) {
    const source = dynamicMatch[1];
    imports.push({
      source,
      specifiers: [],
      importKind: "dynamic",
      line: currentLine,
      resolvedPath: resolveRelativeImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
      confidence: source.startsWith(".") ? 0.8 : 0.2,
    });
  }
}

function collectExports(line: string, currentLine: number, exports: ParsedExport[]) {
  const exportMatch = line.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$]*)/);
  if (exportMatch) {
    exports.push({
      name: exportMatch[2],
      kind: exportKind(exportMatch[1]),
      line: currentLine,
      confidence: 0.8,
    });
  }

  const namedExportMatch = line.match(/^\s*export\s*\{([^}]+)\}/);
  if (namedExportMatch) {
    for (const name of namedExportMatch[1].split(",")) {
      const exported = name.trim().split(/\s+as\s+/i).pop()?.trim();
      if (exported) {
        exports.push({ name: exported, kind: "unknown", line: currentLine, confidence: 0.8 });
      }
    }
  }
}

function collectSymbols(
  line: string,
  currentLine: number,
  exports: ParsedExport[],
  symbols: ParsedSymbol[],
) {
  const exportedNames = new Set(exports.map((item) => item.name));
  const patterns: Array<{ match: RegExpMatchArray | null; kind: ParsedSymbol["kind"]; nameIndex: number }> = [
    {
      match: line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/),
      kind: "function",
      nameIndex: 1,
    },
    {
      match: line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/),
      kind: "class",
      nameIndex: 1,
    },
    {
      match: line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/),
      kind: "function",
      nameIndex: 1,
    },
    {
      match: line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/),
      kind: "function",
      nameIndex: 1,
    },
  ];

  for (const pattern of patterns) {
    if (!pattern.match) continue;
    const name = pattern.match[pattern.nameIndex];
    const kind = symbolKindForName(name, pattern.kind);
    uniquePush(
      symbols,
      {
        name,
        kind,
        lineStart: currentLine,
        signature: line.trim(),
        exported: exportedNames.has(name) || /^\s*export\b/.test(line),
        confidence: 0.8,
      },
      (symbol) => `${symbol.name}:${symbol.lineStart}:${symbol.kind}`,
    );
  }
}

function parseImportSpecifiers(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const specifiers: string[] = [];

  const namespaceMatch = trimmed.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) {
    specifiers.push(namespaceMatch[1]);
  }

  const namedMatch = trimmed.match(/\{([^}]+)\}/);
  if (namedMatch) {
    specifiers.push(
      ...namedMatch[1]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/i).pop()?.trim())
        .filter((part): part is string => Boolean(part)),
    );
  }

  const defaultName = trimmed.split(",")[0]?.trim();
  if (defaultName && /^[A-Za-z_$][\w$]*$/.test(defaultName)) {
    specifiers.unshift(defaultName);
  }

  return specifiers;
}

function exportKind(kind: string): ParsedExport["kind"] {
  if (kind === "const" || kind === "let" || kind === "var") return "variable";
  if (kind === "interface") return "interface";
  if (kind === "type") return "type";
  if (kind === "function" || kind === "class") return kind;
  return "unknown";
}

function symbolKindForName(name: string, baseKind: ParsedSymbol["kind"]): ParsedSymbol["kind"] {
  if (isReactHookName(name)) return "hook";
  if (baseKind === "function" && isPascalCase(name)) return "component";
  return baseKind;
}

function toDependency(from: string, parsedImport: ParsedImport, index: number): DependencyEdge {
  const dependencyType =
    parsedImport.importKind === "dynamic" ? "dynamic-import" : parsedImport.importKind === "commonjs" ? "require" : "import";

  return {
    id: `${from}:import:${index + 1}`,
    source: from,
    target: parsedImport.resolvedPath ?? parsedImport.source,
    kind: parsedImport.importKind === "dynamic" ? "unknown" : "import",
    weight: 1,
    from,
    to: parsedImport.resolvedPath ?? parsedImport.source,
    dependencyType,
    confidence: parsedImport.confidence,
    evidence: parsedImport.source,
    sourceLine: parsedImport.line,
  };
}
