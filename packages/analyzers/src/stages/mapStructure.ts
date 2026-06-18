import type {
  FileRole,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  RepoFile,
  RepoLayout,
  RepoStructure,
  StageResult,
} from "@codeflow/shared-types";

/** One entry from a directory listing. `sizeBytes` is 0 for directories. */
export interface WalkEntry {
  name: string;
  /** Repo-relative POSIX path. */
  path: string;
  type: "file" | "dir";
  sizeBytes: number;
}

/**
 * File-tree access for Map-structure. `readDir` lists the immediate children of a
 * repo-relative directory ("" = root); `readFile` reads a specific file (used only for
 * `.gitignore`). Behind an interface so tests fake the tree — no real fs in unit tests.
 */
export interface MapStructureDependencies {
  readDir(repoPath: string, relativeDir: string): Promise<WalkEntry[]>;
  readFile(repoPath: string, relativePath: string): Promise<string | null>;
  now?: () => number;
}

// Directory names we never descend into or classify (build output, vendored deps, VCS,
// tool caches). Junk like this must never reach the classified file list.
const HARD_IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
]);

/**
 * Stage 3 — Map-structure (deterministic). Discovers the full file tree, classifies
 * each file by role, and detects the layout convention. File-level facts ONLY: it does
 * not read source for symbols (Inventory, stage 4) or build the graph (Connect, stage
 * 5). The discovered file list is COMPLETE and never truncated.
 */
export function createMapStructureStage(deps: MapStructureDependencies): PipelineStage<"structure"> {
  const now = deps.now ?? Date.now;

  return {
    id: "map-structure",
    kind: "deterministic",
    label: "Mapping structure",
    owns: ["structure"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"structure">> {
      const startedAt = now();
      const repoPath = ctx.repoPath;
      if (!repoPath) {
        throw new Error("Map-structure requires a resolved repoPath; Ingest must run first.");
      }

      const ignoreRules = parseGitignore(await deps.readFile(repoPath, ".gitignore"));
      const files = await walk(repoPath, deps.readDir, ignoreRules);
      files.sort((a, b) => a.path.localeCompare(b.path)); // deterministic order

      const layout = detectLayout(files);

      // The layout fact is owned here. If Orient's projectType disagrees we do NOT
      // overwrite it (reconciled when Inventory lands) — just note it.
      const orientType = ctx.prior.orientation?.projectType;
      if (layout === "monorepo" && orientType && orientType !== "monorepo") {
        ctx.logger.info("Layout=monorepo disagrees with orientation.projectType; layout wins (not overwriting).", {
          layout,
          projectType: orientType,
        });
      }

      const structure: RepoStructure = { layout, files, fileCount: files.length };

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "map-structure",
        stageIndex: 3,
        stageCount: 3,
        kind: "deterministic",
        status: "completed",
        label: "Mapping structure",
        detail: `Discovered ${files.length} files (${layout}).`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: { layout, fileCount: files.length },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { structure }, event };
    },
  };
}

async function walk(
  repoPath: string,
  readDir: MapStructureDependencies["readDir"],
  ignoreRules: IgnoreRule[],
): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

  async function descend(relativeDir: string): Promise<void> {
    const entries = await readDir(repoPath, relativeDir);
    for (const entry of entries) {
      if (entry.type === "dir") {
        if (HARD_IGNORE_DIRS.has(entry.name)) continue;
        if (isIgnored(entry.path, true, ignoreRules)) continue;
        await descend(entry.path);
        continue;
      }
      if (isIgnored(entry.path, false, ignoreRules)) continue;
      const ext = extensionOf(entry.name);
      files.push({
        path: entry.path,
        ext,
        role: classifyRole(entry.path, ext),
        language: languageForExt(ext),
        sizeBytes: entry.sizeBytes,
      });
    }
  }

  await descend("");
  return files;
}

// --- Layout detection -------------------------------------------------------

function detectLayout(files: RepoFile[]): RepoLayout {
  const topSegments = new Set(files.map((file) => file.path.split("/")[0]));
  // Monorepo: a top-level packages/ or apps/ tree (workspaces convention).
  if (files.some((file) => file.path.startsWith("packages/") || file.path.startsWith("apps/"))) {
    return "monorepo";
  }
  if (topSegments.has("src")) return "src-rooted";
  if (topSegments.has("app")) return "app-rooted";
  return "flat";
}

// --- Role classification ----------------------------------------------------
// Ordered: test > docs > build > config > asset > source > other. The first match
// wins, so e.g. a `*.test.ts` is `test` (not `source`) and a CI yml is `build`
// (not generic `config`). Genuinely ambiguous cases are flagged in the session notes.

const ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".bmp", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".webm",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".psd", ".ai", ".sketch",
]);

const CONFIG_EXTS = new Set([
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env", ".lock",
]);

const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".adoc"]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".cs", ".swift", ".scala",
  ".m", ".mm", ".vue", ".svelte", ".sh", ".bash", ".sql", ".r", ".lua", ".dart",
  ".ex", ".exs", ".clj", ".hs", ".ml", ".pl",
]);

const CONFIG_FILENAMES = new Set([
  "go.mod", "go.sum", "gemfile", "gemfile.lock", "requirements.txt", "pipfile", "pipfile.lock",
]);

const BUILD_FILENAMES = new Set([
  "dockerfile", "makefile", "gnumakefile", "cmakelists.txt", "jenkinsfile", "vagrantfile", "procfile",
  "build.gradle", "build.gradle.kts", ".gitlab-ci.yml", ".travis.yml", "build", "build.bazel", "workspace.bazel",
]);

function classifyRole(path: string, ext: string): FileRole {
  const segments = path.toLowerCase().split("/");
  const base = segments[segments.length - 1];

  if (isTest(base, segments)) return "test";
  if (isDocs(base, segments, ext)) return "docs";
  if (isBuild(base, path)) return "build";
  if (isConfig(base, ext)) return "config";
  if (ASSET_EXTS.has(ext)) return "asset";
  if (SOURCE_EXTS.has(ext)) return "source";
  return "other";
}

function isTest(base: string, segments: string[]): boolean {
  if (segments.some((s) => s === "__tests__" || s === "__test__" || s === "test" || s === "tests" || s === "spec")) {
    return true;
  }
  return (
    /\.(test|spec)\.[^.]+$/.test(base) ||
    /(^|[._])test_[^/]*\.py$/.test(base) ||
    /_test\.(go|py|rb)$/.test(base)
  );
}

function isDocs(base: string, segments: string[], ext: string): boolean {
  if (segments.some((s) => s === "docs" || s === "doc")) return true;
  if (DOC_EXTS.has(ext)) return true;
  return /^(readme|changelog|licen[cs]e|contributing|authors|notice|code_of_conduct)\b/i.test(base);
}

function isBuild(base: string, path: string): boolean {
  if (BUILD_FILENAMES.has(base)) return true;
  if (base.startsWith("dockerfile") || base.startsWith("docker-compose")) return true;
  if (base.endsWith(".gradle") || base.endsWith(".bazel") || base.endsWith(".bzl")) return true;
  if (path.startsWith(".github/workflows/") || path.includes("/.github/workflows/")) return true;
  if (path.startsWith(".circleci/") || path.includes("/.circleci/")) return true;
  return false;
}

function isConfig(base: string, ext: string): boolean {
  if (CONFIG_FILENAMES.has(base)) return true;
  if (/\.config\.[^.]+$/.test(base)) return true;
  if (CONFIG_EXTS.has(ext)) return true;
  // Dotfiles with no extension (.eslintrc, .prettierrc, .gitignore, .npmrc, .editorconfig…).
  if (base.startsWith(".") && ext === "") return true;
  return false;
}

// --- Small helpers ----------------------------------------------------------

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
  ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".scala": "Scala",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++",
  ".vue": "Vue", ".svelte": "Svelte", ".sh": "Shell", ".bash": "Shell", ".sql": "SQL",
  ".md": "Markdown", ".mdx": "Markdown", ".rst": "reStructuredText",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".html": "HTML", ".css": "CSS",
};

function languageForExt(ext: string): string {
  return LANGUAGE_BY_EXT[ext] ?? "Unknown";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : ""; // dot>0 keeps dotfiles extension-less
}

// --- .gitignore (pragmatic subset) ------------------------------------------
// Supports: comments/blanks, `!` negation (last match wins), trailing-slash dir-only,
// leading-slash / embedded-slash anchoring, `*` (within a segment), `**` (across
// segments), `?`. NOT supported (flagged): nested .gitignore files, `[]` char classes,
// and full Git edge-case fidelity. Combined with HARD_IGNORE_DIRS.

interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

function parseGitignore(content: string | null): IgnoreRule[] {
  if (!content) return [];
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    let dirOnly = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    const cleaned = line.startsWith("/") ? line.slice(1) : line;
    if (!cleaned) continue;
    rules.push({ negate, dirOnly, regex: globToRegExp(cleaned, anchored) });
  }
  return rules;
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 2;
        } else {
          body += ".*";
          i += 1;
        }
      } else {
        body += "[^/]*";
      }
    } else if (char === "?") {
      body += "[^/]";
    } else {
      body += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Anchored to repo root, or matchable at any depth (basename / any segment).
  return anchored ? new RegExp(`^${body}(?:/.*)?$`) : new RegExp(`(?:^|/)${body}(?:/.*)?$`);
}

function isIgnored(path: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(path)) ignored = !rule.negate;
  }
  return ignored;
}
