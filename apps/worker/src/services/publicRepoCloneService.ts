import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "target",
  ".turbo",
  ".cache",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".php": "PHP",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".tsx": "TypeScript",
  ".ts": "TypeScript",
  ".vue": "Vue",
  ".yml": "YAML",
  ".yaml": "YAML",
};

export interface NormalizedGitHubRepo {
  owner: string;
  repo: string;
  branch: string;
}

export interface ClonePublicRepoInput extends NormalizedGitHubRepo {
  destinationRoot?: string;
}

export interface ClonePublicRepoResult {
  repoPath: string;
  cloneUrl: string;
}

export interface DiscoveredRepoFile {
  path: string;
  name: string;
  extension: string;
  language: string;
  sizeBytes: number;
  lines: number;
}

export interface DiscoverRepoFilesResult {
  files: DiscoveredRepoFile[];
  totalFiles: number;
  languageBreakdown: Record<string, number>;
  truncated: boolean;
}

export function normalizeGitHubRepoInput(input: {
  owner?: string;
  repo?: string;
  branch?: string;
}): NormalizedGitHubRepo {
  const owner = input.owner?.trim();
  const repo = input.repo?.trim();
  const branch = input.branch?.trim() || "main";

  if (!owner || !OWNER_REPO_RE.test(owner)) {
    throw new Error("Invalid GitHub owner for hosted public analysis.");
  }
  if (!repo || !OWNER_REPO_RE.test(repo)) {
    throw new Error("Invalid GitHub repository name for hosted public analysis.");
  }
  if (!isSafeBranch(branch)) {
    throw new Error("Invalid Git branch for hosted public analysis.");
  }

  return { owner, repo, branch };
}

export function buildPublicCloneUrl(owner: string, repo: string) {
  const normalized = normalizeGitHubRepoInput({ owner, repo });
  return `https://github.com/${normalized.owner}/${normalized.repo}.git`;
}

export async function clonePublicRepo(input: ClonePublicRepoInput): Promise<ClonePublicRepoResult> {
  const normalized = normalizeGitHubRepoInput(input);
  const destinationRoot = path.resolve(input.destinationRoot ?? defaultTempRoot());
  await mkdir(destinationRoot, { recursive: true });
  const repoPath = await makeRepoTempPath(destinationRoot, normalized);
  const cloneUrl = buildPublicCloneUrl(normalized.owner, normalized.repo);

  // `branch` defaults to "main" when the caller didn't specify one, but a repo's real default
  // may be "master" (or anything else). Cloning a non-existent branch fails hard, so resolve
  // the branch to clone against the remote first.
  const branch = await resolveCloneBranch(cloneUrl, normalized.branch);

  await runGit([
    "clone",
    "--depth=1",
    "--branch",
    branch,
    "--single-branch",
    cloneUrl,
    repoPath,
  ]);

  return { repoPath, cloneUrl };
}

/**
 * Decide which branch to clone: the requested one if it exists on the remote, otherwise the
 * repo's actual default branch (the HEAD symref). This prevents "Remote branch main not found"
 * when the caller's implicit default ("main") doesn't match the repo (e.g. a "master" default).
 */
async function resolveCloneBranch(cloneUrl: string, requestedBranch: string): Promise<string> {
  const { stdout } = await runGit(["ls-remote", "--symref", cloneUrl, "HEAD"]);
  const defaultBranch = stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  if (!defaultBranch || requestedBranch === defaultBranch) {
    return defaultBranch ?? requestedBranch;
  }
  const { stdout: heads } = await runGit(["ls-remote", "--heads", cloneUrl, requestedBranch]);
  return heads.trim() ? requestedBranch : defaultBranch;
}

export async function getHeadCommitSha(repoPath: string) {
  const result = await runGit(["rev-parse", "HEAD"], { cwd: repoPath });
  return result.stdout.trim();
}

export async function discoverRepoFiles(
  repoPath: string,
  options: { maxFiles?: number } = {},
): Promise<DiscoverRepoFilesResult> {
  const maxFiles = options.maxFiles ?? getMaxFiles();
  const root = path.resolve(repoPath);
  const files: DiscoveredRepoFile[] = [];
  let truncated = false;

  async function walk(current: string) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await walk(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = toPosixRelative(root, absolutePath);
      const extension = path.extname(entry.name).toLowerCase();
      const fileStat = await stat(absolutePath);
      files.push({
        path: relativePath,
        name: entry.name,
        extension,
        language: languageForExtension(extension),
        sizeBytes: fileStat.size,
        lines: await countLinesIfSmall(absolutePath, fileStat.size),
      });
    }
  }

  await walk(root);

  return {
    files,
    totalFiles: files.length,
    languageBreakdown: buildLanguageBreakdown(files),
    truncated,
  };
}

export async function cleanupRepoPath(repoPath: string) {
  if (process.env.CODEFLOW_KEEP_TMP === "true") {
    return;
  }
  await rm(repoPath, { recursive: true, force: true });
}

export function shouldExcludeDirectory(name: string) {
  return EXCLUDED_DIRS.has(name);
}

export function languageForExtension(extension: string) {
  return LANGUAGE_BY_EXTENSION[extension.toLowerCase()] ?? "Other";
}

export function buildLanguageBreakdown(files: Array<{ language: string }>) {
  return files.reduce<Record<string, number>>((acc, file) => {
    acc[file.language] = (acc[file.language] ?? 0) + 1;
    return acc;
  }, {});
}

function isSafeBranch(branch: string) {
  return BRANCH_RE.test(branch) && !branch.includes("..") && !branch.startsWith("-");
}

function defaultTempRoot() {
  return process.env.CODEFLOW_TMP_DIR || path.join(os.tmpdir(), "codeflow-public-repos");
}

async function makeRepoTempPath(destinationRoot: string, input: NormalizedGitHubRepo) {
  const prefix = path.join(destinationRoot, `${input.owner}-${input.repo}-${randomUUID()}-`);
  await mkdir(prefix, { recursive: false });
  return prefix;
}

// Run git strictly NON-INTERACTIVELY: never block on a credential/host prompt (the classic
// "Ingest hangs forever" cause on a machine with a credential manager or an unauthenticated
// throttle), and abort a stalled HTTP transfer rather than waiting indefinitely.
const GIT_NONINTERACTIVE_FLAGS = [
  "-c",
  "credential.helper=", // disable all credential helpers (no GUI/keychain prompt)
  "-c",
  "credential.interactive=false", // Git Credential Manager: never prompt
  "-c",
  "core.askpass=", // no askpass helper
  "-c",
  "http.lowSpeedLimit=1000", // if transfer drops below ~1KB/s …
  "-c",
  "http.lowSpeedTime=20", // … for 20s, abort instead of hanging
];

function gitTimeoutMs() {
  const parsed = Number(process.env.CODEFLOW_GIT_TIMEOUT_MS || 120_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

async function runGit(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? gitTimeoutMs();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", [...GIT_NONINTERACTIVE_FLAGS, ...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      // Belt-and-suspenders with the -c flags: git's own env switch to refuse prompts.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `git ${args[0]} timed out after ${timeoutMs}ms (non-interactive; check network or repo access).`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args[0]} failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

function getMaxFiles() {
  const parsed = Number(process.env.CODEFLOW_MAX_FILES || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

function toPosixRelative(root: string, absolutePath: string) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function countLinesIfSmall(filePath: string, sizeBytes: number) {
  if (sizeBytes > 128 * 1024) {
    return 0;
  }

  try {
    const content = await readFile(filePath, "utf8");
    return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
  } catch {
    return 0;
  }
}
