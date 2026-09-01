import type { AnalysisResult, RepositoryRef } from "@codeflow/shared-types";
import type { Sandbox, SandboxLoader } from "./contracts.js";

/**
 * Build a sandbox from an already-loaded analysis.
 *
 * The fileId set is computed ONCE and frozen: every verifier grounds against it, so
 * recomputing it per check would be both wasteful and — if the result were ever mutated
 * mid-run — inconsistent between two verifiers grading the same output.
 */
export function createSandbox(result: AnalysisResult): Sandbox {
  // graph.nodes is the canonical FileNode home; `files` is its derived view. Prefer the
  // former and fall back, so a result assembled either way still grounds correctly.
  const ids = new Set<string>((result.graph?.nodes ?? result.files ?? []).map((node) => node.id));

  return {
    repo: result.repository,
    commitSha: result.commitSha ?? "",
    result,
    fileIds: () => ids,
    hasFile: (fileId: string) => ids.has(fileId),
  };
}

/**
 * Load a frozen sandbox for `{repo, sha}` through an injected loader — in production the
 * EXISTING SHA-keyed analysis cache, so the Arena never re-analyzes a repo just to grade
 * against it. Returns null when nothing is cached, which callers must handle: silently
 * analyzing on demand would make grading cost money and vary by cache state.
 */
export async function loadSandbox(
  loader: SandboxLoader,
  repo: RepositoryRef,
  commitSha: string,
): Promise<Sandbox | null> {
  const result = await loader(repo, commitSha);
  if (!result) return null;
  // A result that does not match the requested SHA is a DIFFERENT world; grading against it
  // would silently compare agents on different code.
  if (result.commitSha && result.commitSha !== commitSha) {
    throw new Error(
      `Sandbox mismatch: asked for ${commitSha} but the loaded analysis is ${result.commitSha}. ` +
        "Grading against the wrong commit would compare agents on different code.",
    );
  }
  return createSandbox(result);
}
