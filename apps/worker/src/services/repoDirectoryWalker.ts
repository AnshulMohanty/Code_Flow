import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WalkEntry } from "@codeflow/analyzers";

/**
 * Lists the immediate children of a repo-relative directory from the cloned working
 * tree. Symlinks are skipped (we never follow them). Used as Map-structure's `readDir`
 * dependency; the stage owns recursion + ignore handling.
 */
export async function readRepoDir(repoPath: string, relativeDir: string): Promise<WalkEntry[]> {
  const absoluteDir = path.join(repoPath, relativeDir);
  const dirents = await readdir(absoluteDir, { withFileTypes: true });
  const entries: WalkEntry[] = [];

  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const relativePath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: relativePath, type: "dir", sizeBytes: 0 });
    } else if (dirent.isFile()) {
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(path.join(repoPath, relativePath))).size;
      } catch {
        sizeBytes = 0;
      }
      entries.push({ name: dirent.name, path: relativePath, type: "file", sizeBytes });
    }
  }

  return entries;
}
