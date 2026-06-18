import type {
  DetectedManifest,
  PackageEcosystem,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProjectType,
  ProgressEvent,
  ReadmeCapture,
  RepoOrientation,
  StageResult,
} from "@codeflow/shared-types";

/**
 * Reads repo-relative files. Resolves `null` when the file does not exist. Orient
 * only ever asks for SPECIFIC known paths (manifests + README candidates) — it never
 * lists/walks the tree (that is Map-structure's job, stage 3).
 */
export interface OrientDependencies {
  readFile(repoPath: string, relativePath: string): Promise<string | null>;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

// README is probed as a candidate set rather than glob-matched: true case-insensitive
// `README.*` matching needs a directory listing, which belongs to Map-structure.
const README_CANDIDATES = [
  "README.md",
  "Readme.md",
  "readme.md",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README",
  "readme",
];

interface ManifestSpec {
  path: string;
  ecosystem: PackageEcosystem;
  language: string;
}

// Root dependency manifests Orient recognises. Extensions beyond the brief
// (setup.py, build.gradle.kts) are flagged in the session notes.
const MANIFEST_SPECS: ManifestSpec[] = [
  { path: "package.json", ecosystem: "npm", language: "JavaScript" },
  { path: "requirements.txt", ecosystem: "pip", language: "Python" },
  { path: "pyproject.toml", ecosystem: "pip", language: "Python" },
  { path: "setup.py", ecosystem: "pip", language: "Python" },
  { path: "go.mod", ecosystem: "go", language: "Go" },
  { path: "Cargo.toml", ecosystem: "cargo", language: "Rust" },
  { path: "pom.xml", ecosystem: "maven", language: "Java" },
  { path: "build.gradle", ecosystem: "gradle", language: "Java" },
  { path: "build.gradle.kts", ecosystem: "gradle", language: "Kotlin" },
  { path: "Gemfile", ecosystem: "rubygems", language: "Ruby" },
  { path: "composer.json", ecosystem: "composer", language: "PHP" },
];

// Monorepo signal files (not dependency manifests, so not listed in `manifests`).
const WORKSPACE_SIGNAL_FILES = ["pnpm-workspace.yaml", "lerna.json"];

/** Framework/notable-dependency name → label, scanned per ecosystem. */
const FRAMEWORK_KEYWORDS: Record<string, string> = {
  // JS/TS
  react: "React",
  next: "Next.js",
  vue: "Vue",
  "@angular/core": "Angular",
  svelte: "Svelte",
  express: "Express",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  koa: "Koa",
  // Python
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
  // Go
  "gin-gonic/gin": "Gin",
  "labstack/echo": "Echo",
  "gofiber/fiber": "Fiber",
  "spf13/cobra": "Cobra",
  "urfave/cli": "urfave/cli",
  // Rust
  "actix-web": "Actix Web",
  axum: "Axum",
  rocket: "Rocket",
  // JVM
  "spring-boot": "Spring Boot",
  // Ruby
  rails: "Rails",
  sinatra: "Sinatra",
  // PHP
  "laravel/framework": "Laravel",
  symfony: "Symfony",
};

/**
 * Stage 2 — Orient (deterministic). Detects languages, frameworks and a best-effort
 * project type from ROOT MANIFESTS + README only. Captures the raw README text as a
 * fact for P3. The AI "what is this project" 3-liner is deferred to P3 — no LLM here.
 */
export function createOrientStage(deps: OrientDependencies): PipelineStage<"orientation"> {
  const now = deps.now ?? Date.now;

  return {
    id: "orient",
    kind: "deterministic",
    label: "Orienting",
    owns: ["orientation"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"orientation">> {
      const startedAt = now();
      const repoPath = ctx.repoPath;
      if (!repoPath) {
        throw new Error("Orient requires a resolved repoPath; Ingest must run first.");
      }

      const orientation = await detectOrientation(repoPath, deps.readFile);

      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "orient",
        stageIndex: 2,
        stageCount: 2,
        kind: "deterministic",
        status: "completed",
        label: "Orienting",
        detail: orientation.manifests.length
          ? `Detected ${orientation.languages.join(", ") || "no languages"} (${orientation.projectType}).`
          : "No manifests found.",
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          projectType: orientation.projectType,
          languages: orientation.languages.join(", "),
          manifests: orientation.manifests.length,
          hasReadme: orientation.readme !== null,
        },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { orientation }, event };
    },
  };
}

async function detectOrientation(
  repoPath: string,
  readFile: OrientDependencies["readFile"],
): Promise<RepoOrientation> {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const manifests: DetectedManifest[] = [];

  const signals = { monorepo: false, cli: false, library: false };

  for (const spec of MANIFEST_SPECS) {
    const content = await readFile(repoPath, spec.path);
    if (content === null) continue;

    manifests.push({ path: spec.path, ecosystem: spec.ecosystem });
    languages.add(spec.language);

    if (spec.path === "package.json" || spec.path === "composer.json") {
      applyJsonManifest(spec, content, { languages, frameworks, signals });
    } else {
      applyTextManifest(content, frameworks, signals);
    }
  }

  // Monorepo signal files (probed individually — no directory walk).
  for (const signalFile of WORKSPACE_SIGNAL_FILES) {
    if ((await readFile(repoPath, signalFile)) !== null) {
      signals.monorepo = true;
    }
  }

  const readme = await captureReadme(repoPath, readFile);

  return {
    languages: [...languages],
    frameworks: [...frameworks],
    projectType: deriveProjectType(manifests.length, signals),
    manifests,
    readme,
  };
}

function applyJsonManifest(
  spec: ManifestSpec,
  content: string,
  acc: { languages: Set<string>; frameworks: Set<string>; signals: { monorepo: boolean; cli: boolean; library: boolean } },
): void {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return; // present but unparseable — manifest still counted, no extra signal
  }

  const deps = collectDependencyNames(json);
  for (const name of deps) {
    const label = FRAMEWORK_KEYWORDS[name];
    if (label) acc.frameworks.add(label);
  }

  if (spec.ecosystem === "npm") {
    if (deps.includes("typescript")) acc.languages.add("TypeScript");
    if ("workspaces" in json) acc.signals.monorepo = true;
    if (json.bin !== undefined) acc.signals.cli = true;
    const isPublic = json.private !== true;
    if (isPublic && (json.main !== undefined || json.module !== undefined || json.exports !== undefined)) {
      acc.signals.library = true;
    }
  }
}

function applyTextManifest(
  content: string,
  frameworks: Set<string>,
  signals: { monorepo: boolean; cli: boolean; library: boolean },
): void {
  const lower = content.toLowerCase();
  for (const [keyword, label] of Object.entries(FRAMEWORK_KEYWORDS)) {
    if (lower.includes(keyword.toLowerCase())) frameworks.add(label);
  }
  // Project-type signals from common manifest markers (regex/substring — not full
  // TOML/XML parsing, consistent with the regex-based parser stance in PLAN §9).
  // Go has no manifest field for "CLI"; a cobra/urfave-cli dependency is the only
  // manifest-only signal (real CLI vs app/lib otherwise needs Inventory, stage 4).
  if (
    content.includes("[[bin]]") ||
    lower.includes("[project.scripts]") ||
    lower.includes("console_scripts") ||
    lower.includes("spf13/cobra") ||
    lower.includes("urfave/cli")
  ) {
    signals.cli = true;
  }
  if (content.includes("[lib]") || lower.includes("find_packages") || /\bpackages\s*=/.test(content)) {
    signals.library = true;
  }
}

function collectDependencyNames(json: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "require", "require-dev"]) {
    const section = json[field];
    if (section && typeof section === "object") {
      names.push(...Object.keys(section as Record<string, unknown>));
    }
  }
  return names;
}

/** Heuristic precedence: monorepo > cli > library > application; unknown when no manifests. */
function deriveProjectType(
  manifestCount: number,
  signals: { monorepo: boolean; cli: boolean; library: boolean },
): ProjectType {
  if (manifestCount === 0) return "unknown";
  if (signals.monorepo) return "monorepo";
  if (signals.cli) return "cli";
  if (signals.library) return "library";
  return "application";
}

async function captureReadme(
  repoPath: string,
  readFile: OrientDependencies["readFile"],
): Promise<ReadmeCapture | null> {
  for (const candidate of README_CANDIDATES) {
    const text = await readFile(repoPath, candidate);
    if (text !== null) {
      return { path: candidate, text }; // FULL text — a fact, never truncated here
    }
  }
  return null;
}
