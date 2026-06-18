import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Directories never counted toward the size cap (VCS metadata; not analyzed anyway). */
const SKIP_DIRS = new Set([".git", ".hg", ".svn"]);

/**
 * Walks the cloned working tree and returns file count + total bytes (Guard 1's
 * `measureRepoSize`). Skips symlinks (never followed) and `.git`-style VCS dirs. A shallow
 * clone of a public repo has no `node_modules` (not in git), so the raw tree ≈ source size.
 * Integration-only — exercised against a real clone, not the hermetic suite (Ingest's cap
 * logic is unit-tested with a mocked measure).
 */
export async function measureRepoSize(repoPath: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        await walk(path.join(dir, dirent.name));
      } else if (dirent.isFile()) {
        fileCount += 1;
        try {
          totalBytes += (await stat(path.join(dir, dirent.name))).size;
        } catch {
          // unreadable file — counted, size 0
        }
      }
    }
  }

  await walk(repoPath);
  return { fileCount, totalBytes };
}
