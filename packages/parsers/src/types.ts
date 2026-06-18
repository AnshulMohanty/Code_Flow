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

export const PARSER_VERSION = "parser-v1";
