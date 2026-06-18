import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DiscoveredSourceFile, ParseRepositoryOptions } from "../types.js";
import { isSupportedSourceFile, shouldExcludePath } from "./fileFilters.js";
import { toPosixPath } from "../utils/pathUtils.js";

export async function discoverSourceFiles(
  repoRoot: string,
  options: ParseRepositoryOptions = {},
): Promise<DiscoveredSourceFile[]> {
  const root = path.resolve(repoRoot);
  const maxFiles = options.maxFiles ?? 5000;
  const maxFileSizeBytes = (options.maxFileSizeKB ?? 512) * 1024;
  const files: DiscoveredSourceFile[] = [];

  async function walk(current: string) {
    if (files.length >= maxFiles) return;
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const absolutePath = path.join(current, entry.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));

      if (entry.isDirectory()) {
        if (!shouldExcludePath(relativePath)) {
          await walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile() || !isSupportedSourceFile(relativePath)) {
        continue;
      }

      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxFileSizeBytes) {
        continue;
      }

      files.push({
        path: relativePath,
        absolutePath,
        sizeBytes: fileStat.size,
      });
    }
  }

  await walk(root);
  return files;
}
