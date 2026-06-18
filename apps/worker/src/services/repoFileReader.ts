import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Reads a repo-relative file from the cloned working tree. Returns null when the file
 * does not exist (so Orient can probe known manifest/README paths without walking the
 * tree). Used as the Orient stage's `readFile` dependency.
 */
export async function readRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoPath, relativePath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR") {
      return null;
    }
    throw error;
  }
}
