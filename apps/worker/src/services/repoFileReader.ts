import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const realRoots = new Map<string, Promise<string>>();

/**
 * Reads a repo-relative file from the cloned working tree, for every pipeline stage. Returns null
 * when the file does not exist (so Orient can probe known manifest/README paths without walking
 * the tree) — and when it RESOLVES OUTSIDE the clone.
 *
 * The clone is untrusted input. A public repository can commit `README.md -> /proc/self/environ`
 * (or any source file pointing at a secret); following it would put this process's environment —
 * provider keys, database URIs — into the stored analysis, the Q&A index and an LLM prompt. So the
 * real path must stay inside the real clone root. Symlinks that stay inside the repository still work.
 */
export async function readRepoFile(repoPath: string, relativePath: string): Promise<string | null> {
  let real: string;
  let root: string;
  try {
    let rootPromise = realRoots.get(repoPath);
    if (!rootPromise) {
      rootPromise = realpath(repoPath);
      realRoots.set(repoPath, rootPromise);
      if (realRoots.size > 64) realRoots.delete(realRoots.keys().next().value!);
    }
    [root, real] = await Promise.all([rootPromise, realpath(path.join(repoPath, relativePath))]);
  } catch (error) {
    realRoots.delete(repoPath);
    if (isMissing(error)) return null;
    throw error;
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  try {
    return await readFile(real, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR" || code === "ELOOP";
}
