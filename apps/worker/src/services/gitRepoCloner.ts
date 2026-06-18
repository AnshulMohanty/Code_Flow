import type { RepoCloner } from "@codeflow/analyzers";
import { clonePublicRepo, getHeadCommitSha, normalizeGitHubRepoInput } from "./publicRepoCloneService.js";

/**
 * Real RepoCloner used by the worker: validates the repo ref, shallow-clones the
 * public GitHub repo, and resolves the real HEAD commit SHA. Wraps the existing
 * publicRepoCloneService so the orchestrator's Ingest stage stays infra-agnostic.
 */
export function createGitRepoCloner(): RepoCloner {
  return {
    async clone({ repositoryRef }) {
      const normalized = normalizeGitHubRepoInput({
        owner: repositoryRef.owner,
        repo: repositoryRef.name,
        branch: repositoryRef.branch,
      });
      const cloned = await clonePublicRepo({
        owner: normalized.owner,
        repo: normalized.repo,
        branch: normalized.branch,
      });
      const commitSha = await getHeadCommitSha(cloned.repoPath);
      return { repoPath: cloned.repoPath, commitSha };
    },
  };
}
