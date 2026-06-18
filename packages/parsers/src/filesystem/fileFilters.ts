import { extensionOf, toPosixPath } from "../utils/pathUtils.js";

export const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "target",
  ".turbo",
  ".cache",
]);

const BINARY_OR_MEDIA_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".so",
  ".svg",
  ".webp",
  ".zip",
]);

const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "poetry.lock"]);

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

export function shouldExcludePath(filePath: string) {
  const normalized = toPosixPath(filePath);
  const parts = normalized.split("/");
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) {
    return true;
  }

  const name = parts[parts.length - 1] ?? "";
  if (LOCKFILES.has(name)) {
    return true;
  }

  return BINARY_OR_MEDIA_EXTENSIONS.has(extensionOf(name));
}

export function isSupportedSourceFile(filePath: string) {
  return !shouldExcludePath(filePath) && SOURCE_EXTENSIONS.has(extensionOf(filePath));
}
