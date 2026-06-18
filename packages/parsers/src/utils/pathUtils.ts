import path from "node:path";

export function toPosixPath(value: string) {
  return value.replace(/\\/g, "/");
}

export function normalizeRepoRelativePath(value: string) {
  return toPosixPath(value).replace(/^\/+/, "");
}

export function extensionOf(filePath: string) {
  return path.extname(filePath).toLowerCase();
}

export function fileNameOf(filePath: string) {
  const normalized = toPosixPath(filePath);
  return normalized.split("/").pop() ?? normalized;
}
