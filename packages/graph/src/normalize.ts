import path from "node:path";

export function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function labelForPath(filePath: string) {
  const normalized = normalizePath(filePath);
  return normalized.split("/").pop() || normalized || "unknown";
}

export function createStableNodeId(filePath: string, index: number) {
  const normalized = normalizePath(filePath);
  return `file-${index + 1}-${normalized.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function normalizeMaybePath(value: string) {
  return normalizePath(path.normalize(value));
}
