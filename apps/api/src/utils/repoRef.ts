import type { AnalysisMode, RepositoryRef } from "@codeflow/shared-types";
import type { AnalyzeRequestBody } from "../types/api.js";
import { ApiError } from "../middleware/errorHandler.js";

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const COMMIT_SHA_RE = /^[A-Fa-f0-9]{7,40}$/;

export function validateAnalyzeRequest(body: AnalyzeRequestBody): {
  mode: AnalysisMode;
  repository: RepositoryRef;
} {
  if (!body || typeof body !== "object") {
    throw new ApiError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  if (body.mode !== "public_hosted") {
    throw new ApiError(400, "INVALID_REQUEST", "Only public_hosted mode is accepted by the Phase 4 API.", {
      mode: body.mode,
    });
  }

  const parsed = body.repoUrl ? parseGitHubRepoUrl(body.repoUrl) : parseOwnerRepo(body.owner, body.repo);
  if (!parsed) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Provide either repoUrl or owner/repo for a public GitHub repository.",
      {
        expected: ["repoUrl", "owner + repo"],
      },
    );
  }

  const branch = normalizeBranch(body.branch);
  if (!isValidBranch(branch)) {
    throw new ApiError(400, "INVALID_REQUEST", "Branch contains unsupported characters for hosted public analysis.", {
      branch,
    });
  }

  if (body.commitSha !== undefined && !isValidCommitSha(body.commitSha)) {
    throw new ApiError(400, "INVALID_REQUEST", "commitSha must be a 7 to 40 character hexadecimal Git SHA.", {
      commitSha: body.commitSha,
    });
  }

  return {
    mode: "public_hosted",
    repository: {
      provider: "github",
      owner: parsed.owner,
      name: parsed.repo,
      repo: parsed.repo,
      branch,
      url: `https://github.com/${parsed.owner}/${parsed.repo}`,
    },
  };
}

function parseOwnerRepo(owner?: string, repo?: string) {
  if (!owner || !repo) return null;
  const combined = `${owner}/${repo}`;
  if (!OWNER_REPO_RE.test(combined)) return null;
  return { owner, repo };
}

function parseGitHubRepoUrl(repoUrl: string) {
  if (typeof repoUrl !== "string") return null;
  // Strip any query string / hash (e.g. a pasted "?utm_source=..." tracking suffix) before
  // parsing — it's not part of the owner/repo and would otherwise fail the match.
  const trimmed = repoUrl.trim().split(/[?#]/, 1)[0];
  const match = trimmed.match(/^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
  };
}

function normalizeBranch(branch?: string) {
  if (!branch || typeof branch !== "string") return "main";
  return branch.trim() || "main";
}

export function getRequestedCommitSha(body: AnalyzeRequestBody) {
  if (!body.commitSha) return undefined;
  const commitSha = body.commitSha.trim();
  return isValidCommitSha(commitSha) ? commitSha : undefined;
}

function isValidBranch(branch: string) {
  return (
    BRANCH_RE.test(branch) &&
    !branch.includes("..") &&
    !branch.startsWith("-")
  );
}

function isValidCommitSha(commitSha: string) {
  return typeof commitSha === "string" && COMMIT_SHA_RE.test(commitSha.trim());
}
