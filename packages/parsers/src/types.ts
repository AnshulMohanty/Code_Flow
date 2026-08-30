import type { LanguageId, ParsedFile } from "@codeflow/shared-types";

export type {
  DependencyEdge,
  LanguageId,
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedSymbol,
  ParserConfidence,
  ParserWarning,
} from "@codeflow/shared-types";

export interface ParseFileInput {
  path: string;
  absolutePath?: string;
  content: string;
  repoRoot?: string;
}

export interface ParserAdapter {
  language: LanguageId;
  extensions: string[];
  parseFile(input: ParseFileInput): ParsedFile;
}

export interface DiscoveredSourceFile {
  path: string;
  absolutePath: string;
  sizeBytes: number;
}

export interface ParseRepositoryOptions {
  maxFiles?: number;
  maxFileSizeKB?: number;
}

/** Regex/line-scanning parsers (the fallback engine). */
export const PARSER_VERSION = "parser-v1";

/**
 * tree-sitter (WASM) parsers — the default engine for every language with a loaded
 * grammar. `ParsedFile.parserVersion` therefore says which engine produced a result,
 * so a silent fallback to regex is always visible in the output.
 */
export const TREE_SITTER_PARSER_VERSION = "treesitter-v1";
