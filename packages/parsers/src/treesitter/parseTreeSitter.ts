import type { Tree } from "web-tree-sitter";
import { TREE_SITTER_MAX_BYTES } from "@codeflow/config";
import type { DependencyEdge, LanguageId, ParsedFile, ParsedImport } from "@codeflow/shared-types";
import { resolvePythonImport, resolveRelativeImport } from "../resolution/importResolver.js";
import type { ParseFileInput, ParserAdapter } from "../types.js";
import { TREE_SITTER_PARSER_VERSION } from "../types.js";
import { countLoc } from "../utils/lineUtils.js";
import { extensionOf } from "../utils/pathUtils.js";
import { extractJsLike } from "./jsLike.js";
import { extractPython } from "./python.js";
import { grammarParser, hasGrammar } from "./runtime.js";

/**
 * Parse one file with tree-sitter, or return `null` when tree-sitter cannot handle it —
 * no grammar loaded for the language, or the file is over the size guard. The caller then
 * uses the regex parser, so COVERAGE NEVER REGRESSES.
 *
 * This function is SYNCHRONOUS. Grammar loading is the only async part (see
 * `initTreeSitter`), which is what lets the `ParserAdapter` contract stay unchanged.
 *
 * The size guard is a BYTE COUNT, never a clock: a time-based bail-out would make the
 * deterministic spine non-deterministic (the same input could parse on one run and fall
 * back on the next).
 */
export function parseTreeSitterFile(input: ParseFileInput, language: LanguageId): ParsedFile | null {
  if (!hasGrammar(language)) return null;
  if (input.content.length > TREE_SITTER_MAX_BYTES) return null;
  const parser = grammarParser(language);
  if (!parser) return null;

  const tree = parser.parse(input.content);
  if (!tree) return null;
  try {
    return language === "python"
      ? pythonParsedFile(tree, input)
      : jsLikeParsedFile(tree, input, language);
  } finally {
    // The tree lives in the wasm heap — releasing it is not optional on a big repo.
    tree.delete();
  }
}

function jsLikeParsedFile(tree: Tree, input: ParseFileInput, language: LanguageId): ParsedFile {
  const extract = extractJsLike(tree, (source) =>
    resolveRelativeImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
  );
  return {
    path: input.path,
    language,
    extension: extensionOf(input.path),
    loc: countLoc(input.content),
    imports: extract.imports,
    exports: extract.exports,
    symbols: extract.symbols,
    dependencies: extract.imports.map((parsedImport, index) => toDependency(input.path, parsedImport, index)),
    warnings: [],
    parserVersion: TREE_SITTER_PARSER_VERSION,
  };
}

function pythonParsedFile(tree: Tree, input: ParseFileInput): ParsedFile {
  const extract = extractPython(tree, (source) =>
    resolvePythonImport({ fromFile: input.path, source, repoRoot: input.repoRoot }),
  );
  return {
    path: input.path,
    language: "python",
    extension: extensionOf(input.path),
    loc: countLoc(input.content),
    imports: extract.imports,
    exports: [],
    symbols: extract.symbols,
    dependencies: extract.imports.map((parsedImport, index) => toPythonDependency(input.path, parsedImport, index)),
    warnings: [],
    parserVersion: TREE_SITTER_PARSER_VERSION,
  };
}

/**
 * Wrap a regex `ParserAdapter` so tree-sitter is used when its grammar is loaded and the
 * regex parser is used otherwise. The returned adapter has the SAME `ParserAdapter`
 * shape — callers cannot tell which engine ran except by reading `ParsedFile.parserVersion`
 * (`treesitter-v1` vs `parser-v1`), which is exactly the honest, machine-readable signal.
 */
export function createTreeSitterParser(fallback: ParserAdapter): ParserAdapter {
  return {
    language: fallback.language,
    extensions: fallback.extensions,
    parseFile(input: ParseFileInput): ParsedFile {
      return parseTreeSitterFile(input, fallback.language) ?? fallback.parseFile(input);
    },
  };
}

// Dependency projections mirror the regex parsers' exactly — same id scheme, same
// dependencyType mapping — so Connect and @codeflow/graph see an unchanged shape.

function toDependency(from: string, parsedImport: ParsedImport, index: number): DependencyEdge {
  const dependencyType =
    parsedImport.importKind === "dynamic"
      ? "dynamic-import"
      : parsedImport.importKind === "commonjs"
        ? "require"
        : "import";
  const target = parsedImport.resolvedPath ?? parsedImport.source;
  return {
    id: `${from}:import:${index + 1}`,
    source: from,
    target,
    kind: parsedImport.importKind === "dynamic" ? "unknown" : "import",
    weight: 1,
    from,
    to: target,
    dependencyType,
    confidence: parsedImport.confidence,
    evidence: parsedImport.source,
    sourceLine: parsedImport.line,
  };
}

function toPythonDependency(from: string, parsedImport: ParsedImport, index: number): DependencyEdge {
  const target = parsedImport.resolvedPath ?? parsedImport.source;
  return {
    id: `${from}:python-import:${index + 1}`,
    source: from,
    target,
    kind: "import",
    weight: 1,
    from,
    to: target,
    dependencyType: "python-import",
    confidence: parsedImport.confidence,
    evidence: parsedImport.source,
    sourceLine: parsedImport.line,
  };
}
