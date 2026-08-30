import { FILE_TIMEOUT_MS, PARSE_CONCURRENCY } from "@codeflow/config";
import { createParserRegistry, type ParserRegistry } from "@codeflow/parsers";
import type {
  EntryPointEvidence,
  EntryPointKind,
  Inventory,
  InventoryEntryPoint,
  InventorySymbol,
  ParsedExport,
  ParsedSymbol,
  PipelineContext,
  PipelineInput,
  PipelineStage,
  ProgressEvent,
  ProjectTypeSignal,
  RepoFile,
  StageResult,
  SymbolKind,
} from "@codeflow/shared-types";
import { createLimiter, withTimeout } from "../util/concurrency.js";

/**
 * Reads repo-relative file CONTENTS (the same `readFile` shape Orient/Map-structure
 * use). Resolves `null` when the file cannot be read. Inventory only reads files the
 * structure slice already discovered — it never walks the tree itself.
 */
export interface InventoryDependencies {
  readFile(repoPath: string, relativePath: string): Promise<string | null>;
  /** Injectable parser registry (defaults to the standard JS/TS/Py + generic set). */
  registry?: ParserRegistry;
  /** Guard 2 — max files parsed concurrently (default @codeflow/config PARSE_CONCURRENCY). */
  concurrency?: number;
  /** Guard 3 — per-file read+parse timeout in ms (default @codeflow/config FILE_TIMEOUT_MS).
   *  A file that exceeds it is recorded unparsed; the run continues. */
  fileTimeoutMs?: number;
  /** Injectable clock (ms) for deterministic timing in tests. */
  now?: () => number;
}

/** Roles whose files Inventory parses for symbols. Source only — tests/docs/config
 *  are not part of the symbol surface. */
const PARSED_ROLES = new Set(["source"]);

/**
 * Stage 4 — Inventory (deterministic). Parses the source files discovered by
 * Map-structure into a complete, uncapped symbol list, detects entry points, and
 * captures real per-file LOC. It joins to Map-structure STRICTLY by repo-relative
 * POSIX path so symbols line up with `structure.files` (and Connect's graph next).
 *
 * It does NOT build the dependency graph (Connect, stage 5) and does NOT project
 * FileNode[] (also Connect, which joins structure.files + inventory.loc + graph once).
 * A single unparseable file is recorded and skipped — never a stage failure.
 */
export function createInventoryStage(deps: InventoryDependencies): PipelineStage<"inventory"> {
  const now = deps.now ?? Date.now;
  const registry = deps.registry ?? createParserRegistry();
  const concurrency = deps.concurrency ?? PARSE_CONCURRENCY;
  const fileTimeoutMs = deps.fileTimeoutMs ?? FILE_TIMEOUT_MS;

  return {
    id: "inventory",
    kind: "deterministic",
    label: "Taking inventory",
    owns: ["inventory"],
    async run(input: PipelineInput, ctx: PipelineContext): Promise<StageResult<"inventory">> {
      const startedAt = now();
      const repoPath = ctx.repoPath;
      if (!repoPath) {
        throw new Error("Inventory requires a resolved repoPath; Ingest must run first.");
      }
      const structure = ctx.prior.structure;
      if (!structure) {
        throw new Error("Inventory requires the structure slice; Map-structure must run first.");
      }

      // Load the tree-sitter grammars before the parse fan-out. Idempotent and shared with
      // Connect; if a grammar is unavailable the registry's parsers fall back to regex, so
      // this never fails the stage.
      const treeSitter = await registry.ready();
      if (!treeSitter.ready) {
        ctx.logger.warn("Inventory: no tree-sitter grammar loaded; parsing with the regex fallback.", {
          failed: treeSitter.failed.map((entry) => entry.language),
        });
      }

      const symbols: InventorySymbol[] = [];
      const loc: Record<string, number> = {};
      const unparsedFiles: string[] = [];
      let parsedCount = 0;

      const sourceFiles = structure.files.filter((file) => PARSED_ROLES.has(file.role));

      // Guard 2 (bounded concurrency) + Guard 3 (per-file timeout). Each file's read+parse
      // returns a RESULT object (never mutates shared state), so a late-completing timed-out
      // parse can't corrupt the inventory. Results are applied in sourceFiles order after all
      // settle ⇒ deterministic regardless of completion order.
      const limit = createLimiter(concurrency);
      const results = await Promise.all(
        sourceFiles.map((file) =>
          limit(async (): Promise<FileParseResult> => {
            const outcome = await withTimeout(parseFile(file, repoPath, registry, deps.readFile, ctx), fileTimeoutMs);
            if (outcome.timedOut) {
              ctx.logger.warn("Inventory: file read/parse timed out; recorded unparsed.", { path: file.path, fileTimeoutMs });
              return { kind: "unparsed", path: file.path };
            }
            return outcome.value;
          }),
        ),
      );

      for (const result of results) {
        if (result.kind === "parsed") {
          loc[result.path] = result.loc;
          for (const symbol of result.symbols) symbols.push(symbol);
          parsedCount += 1;
        } else {
          unparsedFiles.push(result.path);
        }
      }

      // Deterministic ordering (path, then line) — keeps output stable across runs.
      symbols.sort((a, b) => (a.filePath === b.filePath ? a.line - b.line : a.filePath.localeCompare(b.filePath)));
      unparsedFiles.sort(); // stable under concurrency

      const entryPoints = await detectEntryPoints(repoPath, structure.files, deps.readFile);
      const projectTypeSignal = deriveProjectTypeSignal(entryPoints);

      const inventory: Inventory = {
        symbols,
        entryPoints,
        symbolCount: symbols.length,
        loc,
        ...(projectTypeSignal ? { projectTypeSignal } : {}),
        ...(unparsedFiles.length ? { unparsedFiles } : {}),
      };

      const skipped = unparsedFiles.length ? `, ${unparsedFiles.length} skipped` : "";
      const event: ProgressEvent = {
        jobId: input.jobId,
        stage: "inventory",
        stageIndex: 4,
        stageCount: 4,
        kind: "deterministic",
        status: "completed",
        label: "Taking inventory",
        detail: `Parsed ${parsedCount} files → ${symbols.length} symbols, ${entryPoints.length} entry points${skipped}.`,
        progress: 0,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        preview: {
          filesParsed: parsedCount,
          symbolCount: symbols.length,
          entryPoints: entryPoints.length,
          projectTypeSignal: projectTypeSignal?.projectType ?? null,
        },
        emittedAt: new Date(now()).toISOString(),
      };

      return { partial: { inventory }, event };
    },
  };
}

// --- Per-file read + parse (timeout-wrappable, side-effect free) ------------
// Returns a RESULT instead of mutating shared state so a timed-out parse that finishes
// late can be discarded safely (Guard 3). A single bad/unreadable file is "unparsed",
// never a stage failure.

type FileParseResult =
  | { kind: "parsed"; path: string; loc: number; symbols: InventorySymbol[] }
  | { kind: "unparsed"; path: string };

async function parseFile(
  file: RepoFile,
  repoPath: string,
  registry: ParserRegistry,
  readFile: InventoryDependencies["readFile"],
  ctx: PipelineContext,
): Promise<FileParseResult> {
  const content = await readFile(repoPath, file.path);
  if (content === null) return { kind: "unparsed", path: file.path };
  try {
    const parsed = registry.parseFile({ path: file.path, content, repoRoot: repoPath });
    const fileSymbols: InventorySymbol[] = [];
    collectSymbols(parsed.symbols, parsed.exports, file, fileSymbols);
    return { kind: "parsed", path: file.path, loc: parsed.loc, symbols: fileSymbols };
  } catch (error) {
    ctx.logger.warn("Inventory: failed to parse file; skipping.", {
      path: file.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "unparsed", path: file.path };
  }
}

// --- Symbol extraction ------------------------------------------------------
// Builds InventorySymbols from the parser's `symbols` (declarations) and `exports`
// (public surface). Exports on names already declared in-file just FLIP the `exported`
// flag; exports of names NOT declared in-file (barrel / re-export points) become their
// own symbols. This avoids duplicate-name noise while still capturing the export surface.

function collectSymbols(
  parsedSymbols: ParsedSymbol[],
  parsedExports: ParsedExport[],
  file: RepoFile,
  out: InventorySymbol[],
): void {
  const byName = new Map<string, InventorySymbol[]>();

  const index = (symbol: InventorySymbol) => {
    const bucket = byName.get(symbol.name);
    if (bucket) bucket.push(symbol);
    else byName.set(symbol.name, [symbol]);
    out.push(symbol);
  };

  for (const parsed of parsedSymbols) {
    index({
      name: parsed.name,
      kind: normalizeSymbolKind(parsed.kind, parsed.signature),
      filePath: file.path,
      line: parsed.lineStart,
      ...(parsed.lineEnd !== undefined ? { endLine: parsed.lineEnd } : {}),
      exported: parsed.exported === true,
      language: file.language,
      // V3-P2: carried through rather than discarded — RAG chunk enrichment reads it, and it
      // is where a typed language states its types. Only when non-empty: an empty string would
      // be indistinguishable from "the parser found one and it was blank".
      ...(parsed.signature ? { signature: parsed.signature } : {}),
    });
  }

  for (const exported of parsedExports) {
    const existing = byName.get(exported.name);
    if (existing && existing.length > 0) {
      // Declared in-file — mark the declaration(s) as part of the public surface.
      for (const symbol of existing) symbol.exported = true;
      continue;
    }
    // Re-export / barrel entry: a public name with no in-file declaration.
    index({
      name: exported.name,
      kind: exportKindToSymbolKind(exported.kind),
      filePath: file.path,
      line: exported.line,
      exported: true,
      language: file.language,
    });
  }
}

/** Map the parser's symbol kind onto the normalized SymbolKind union. The parser tags
 *  TS interfaces/types as `unknown` (carrying a signature), and React component/hook
 *  variants of functions — both are folded here. */
function normalizeSymbolKind(kind: ParsedSymbol["kind"], signature?: string): SymbolKind {
  switch (kind) {
    case "function":
    case "method":
    case "class":
    case "variable":
      return kind;
    case "component":
    case "hook":
      return "function";
    case "unknown":
    default:
      return inferKindFromSignature(signature);
  }
}

/** TS `unknown` symbols carry their declaration line as `signature`; recover the kind. */
function inferKindFromSignature(signature?: string): SymbolKind {
  if (!signature) return "variable";
  if (/^\s*(?:export\s+)?interface\b/.test(signature)) return "interface";
  if (/^\s*(?:export\s+)?type\b/.test(signature)) return "type";
  if (/^\s*(?:export\s+)?(?:const\s+)?enum\b/.test(signature)) return "enum";
  return "variable";
}

function exportKindToSymbolKind(kind: ParsedExport["kind"]): SymbolKind {
  switch (kind) {
    case "function":
    case "class":
    case "variable":
    case "type":
    case "interface":
      return kind;
    case "unknown":
    default:
      return "export";
  }
}

// --- Entry-point detection --------------------------------------------------

const SOURCE_BASENAME_KINDS: Record<string, EntryPointKind> = {
  index: "index",
  main: "main",
  server: "server",
  app: "app",
};

// Cheap framework-convention entries (basename → kind). Evidence "framework".
const FRAMEWORK_BASENAME_KINDS: Record<string, EntryPointKind> = {
  "manage.py": "cli-bin", // Django management CLI
  "wsgi.py": "server",
  "asgi.py": "server",
  "__main__.py": "main", // Python module entry
};

async function detectEntryPoints(
  repoPath: string,
  files: RepoFile[],
  readFile: InventoryDependencies["readFile"],
): Promise<InventoryEntryPoint[]> {
  const seen = new Set<string>();
  const entries: InventoryEntryPoint[] = [];

  const add = (filePath: string, kind: EntryPointKind, evidence: EntryPointEvidence) => {
    const normalized = normalizePosix(filePath);
    if (!normalized) return;
    const key = `${normalized} ${kind} ${evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ filePath: normalized, kind, evidence });
  };

  // 1) package.json bin / main / module / exports.
  const pkgRaw = await readFile(repoPath, "package.json");
  if (pkgRaw !== null) {
    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      pkg = null; // present-but-unparseable: no package-json evidence
    }
    if (pkg) {
      for (const path of binPaths(pkg.bin)) add(path, "cli-bin", "package-json-bin");
      // `main` and `module` are both single main-entry fields.
      for (const field of ["main", "module"]) {
        if (typeof pkg[field] === "string") add(pkg[field] as string, "main", "package-json-main");
      }
      for (const path of exportsPaths(pkg.exports)) add(path, "main", "package-json-exports");
    }
  }

  // 2) filename conventions + cheap framework conventions over source files.
  for (const file of files) {
    if (file.role !== "source") continue;
    const base = basename(file.path).toLowerCase();
    const frameworkKind = FRAMEWORK_BASENAME_KINDS[base];
    if (frameworkKind) {
      add(file.path, frameworkKind, "framework");
      continue;
    }
    const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
    const conventionKind = SOURCE_BASENAME_KINDS[stem];
    if (conventionKind) add(file.path, conventionKind, "filename-convention");
  }

  entries.sort((a, b) =>
    a.filePath === b.filePath ? a.evidence.localeCompare(b.evidence) : a.filePath.localeCompare(b.filePath),
  );
  return entries;
}

/** Hard evidence only: a package.json `bin` ⇒ this is a CLI. Everything softer is left
 *  to Orient's heuristic (the orchestrator reconciles using this signal). */
function deriveProjectTypeSignal(entryPoints: InventoryEntryPoint[]): ProjectTypeSignal | undefined {
  if (entryPoints.some((entry) => entry.evidence === "package-json-bin")) {
    return { projectType: "cli", evidence: "package-json-bin" };
  }
  return undefined;
}

function binPaths(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (bin && typeof bin === "object") {
    return Object.values(bin as Record<string, unknown>).filter((value): value is string => typeof value === "string");
  }
  return [];
}

/** Collect string leaf paths from the `exports` field (string, or a possibly-nested
 *  conditional-exports object). Skips non-relative condition values. */
function exportsPaths(exportsField: unknown): string[] {
  const paths: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") {
      paths.push(node);
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) visit(value);
    }
  };
  visit(exportsField);
  return paths;
}

function normalizePosix(path: string): string {
  let normalized = path.replace(/\\/g, "/").trim();
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.startsWith("/")) normalized = normalized.slice(1);
  return normalized;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
