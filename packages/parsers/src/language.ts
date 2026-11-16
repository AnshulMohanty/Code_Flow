import type { LanguageId } from "@codeflow/shared-types";
import { TREE_SITTER_LANGUAGES, type TreeSitterLanguageId } from "./treesitter/runtime.js";
import { extensionOf } from "./utils/pathUtils.js";

const LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  ".cjs": "javascript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".ipp": "cpp",
  ".inl": "cpp",
  ".tcc": "cpp",
  ".ts": "typescript",
  ".tsx": "tsx",
};

export function detectLanguage(filePath: string): LanguageId {
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? "generic";
}

export function isJavaScriptLike(language: LanguageId) {
  return language === "javascript" || language === "typescript" || language === "jsx" || language === "tsx";
}

/** The tree-sitter grammars needed to parse `paths` — what a pipeline loads instead of all of them. */
export function grammarsFor(paths: Iterable<string>): TreeSitterLanguageId[] {
  const needed = new Set<string>();
  for (const path of paths) needed.add(detectLanguage(path));
  return TREE_SITTER_LANGUAGES.filter((language) => needed.has(language));
}
