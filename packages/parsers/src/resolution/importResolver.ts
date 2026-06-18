import path from "node:path";
import { statSync } from "node:fs";
import { toPosixPath } from "../utils/pathUtils.js";

const JS_RESOLUTION_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

export interface ResolveImportInput {
  fromFile: string;
  source: string;
  repoRoot?: string;
}

export function resolveRelativeImport(input: ResolveImportInput): string | undefined {
  if (!input.source.startsWith(".")) {
    return undefined;
  }

  const fromDirectory = path.dirname(input.fromFile);
  const base = path.normalize(path.join(fromDirectory, input.source));
  const repoRoot = input.repoRoot ? path.resolve(input.repoRoot) : undefined;

  for (const suffix of JS_RESOLUTION_CANDIDATES) {
    const candidate = `${base}${suffix}`;
    const absoluteCandidate = repoRoot ? path.resolve(repoRoot, candidate) : candidate;
    if (!repoRoot || fileExists(absoluteCandidate)) {
      return toPosixPath(candidate);
    }
  }

  return toPosixPath(base);
}

export function resolvePythonImport(input: ResolveImportInput): string | undefined {
  if (!input.source.startsWith(".")) {
    return undefined;
  }

  const dots = input.source.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = input.source.slice(dots).replace(/\./g, "/");
  let directory = path.dirname(input.fromFile);
  for (let i = 1; i < dots; i += 1) {
    directory = path.dirname(directory);
  }

  const base = path.normalize(path.join(directory, moduleName));
  const candidates = [`${base}.py`, `${base}/__init__.py`];
  const repoRoot = input.repoRoot ? path.resolve(input.repoRoot) : undefined;

  for (const candidate of candidates) {
    const absoluteCandidate = repoRoot ? path.resolve(repoRoot, candidate) : candidate;
    if (!repoRoot || fileExists(absoluteCandidate)) {
      return toPosixPath(candidate);
    }
  }

  return toPosixPath(base);
}

function fileExists(filePath: string) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
