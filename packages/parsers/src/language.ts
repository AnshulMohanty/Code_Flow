import type { LanguageId } from "@codeflow/shared-types";
import { extensionOf } from "./utils/pathUtils.js";

const LANGUAGE_BY_EXTENSION: Record<string, LanguageId> = {
  ".cjs": "javascript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "tsx",
};

export function detectLanguage(filePath: string): LanguageId {
  return LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? "generic";
}

export function isJavaScriptLike(language: LanguageId) {
  return language === "javascript" || language === "typescript" || language === "jsx" || language === "tsx";
}
