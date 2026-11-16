import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AnalysisResult } from "@codeflow/shared-types";

const execFileAsync = promisify(execFile);

/**
 * PR IMPACT — what a change set touches, computed from the import graph. Deterministic, offline.
 *
 * Uses only LOCAL, read-only git commands (`diff`, `merge-base`, `archive`); it never fetches. In CI
 * the checkout must therefore contain the base commit (`fetch-depth: 0`, or fetch the base ref).
 */

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface FileImpact {
  path: string;
  status: ChangedFile["status"];
  role: string | undefined;
  /** Production (non-test) files importing it directly. */
  directDependents: number;
  /** Production files that reach it transitively. */
  transitiveDependents: number;
  /** Rank in keyFiles (1 = most load-bearing), when it is a source file. */
  keyFileRank?: number;
  /** Test files that reach it over the import graph (reachability, not coverage). */
  testsReaching: number;
  entryPointsReaching: string[];
}

export interface ImpactReport {
  base?: string;
  changed: ChangedFile[];
  files: FileImpact[];
  /** Union of production dependents of every changed file (excluding the changed files themselves). */
  blastRadius: string[];
  entryPointsAffected: string[];
  testsReaching: string[];
  /** Changed SOURCE files no test file reaches. */
  untested: string[];
  /** Load-time cycles present at head and absent at base (null = base not analysed). */
  newCycles: string[][] | null;
  /** Load-time cycles at head that include a changed file. */
  cyclesTouched: string[][];
  /** Imports written in changed files that resolve to nothing in the repository. */
  brokenImports: Array<{ from: string; specifier: string }>;
  totalSourceFiles: number;
}

const IMPORT_PARSED_LANGUAGES = new Set(["TypeScript", "JavaScript", "Python"]);

// ── git ───────────────────────────────────────────────────────────────────────────

/**
 * A ref is passed to git as an argument (never through a shell), but git still parses a leading
 * `-` as an OPTION — `--base=--output=/x` would make `git archive` write a file. Refs never start
 * with `-`, so refuse anything that does.
 */
export function assertSafeRef(ref: string): string {
  if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) throw new Error(`refusing unsafe git ref "${ref}"`);
  return ref;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The default base: the first of origin/HEAD, origin/main, origin/master, main, master that exists. */
export async function defaultBase(repoPath: string): Promise<string | undefined> {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    try {
      await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch {
      // try the next
    }
  }
  return undefined;
}

/** Files changed between the merge-base of `base` and HEAD, plus uncommitted and untracked changes. */
export async function changedFilesSince(repoPath: string, base: string): Promise<ChangedFile[]> {
  const mergeBase = (await git(repoPath, ["merge-base", assertSafeRef(base), "HEAD"])).trim();
  const raw = await git(repoPath, ["diff", "--name-status", "-M", mergeBase]);
  const byPath = new Map<string, ChangedFile>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...paths] = line.split("\t");
    const target = paths[paths.length - 1];
    const status: ChangedFile["status"] =
      code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified";
    byPath.set(target, { path: target, status });
  }
  const untracked = await git(repoPath, ["ls-files", "--others", "--exclude-standard"]);
  for (const line of untracked.split("\n")) {
    if (line.trim() && !byPath.has(line)) byPath.set(line, { path: line, status: "added" });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Materialise `ref` into a temp directory (git archive | tar), for analysing the base side. */
export async function checkoutToTemp(repoPath: string, ref: string): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codeflow-base-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const archive = spawn("git", ["archive", "--format=tar", assertSafeRef(ref)], { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
      const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
      archive.stdout.pipe(tar.stdin);
      let failed = false;
      const fail = (error: Error) => {
        if (!failed) {
          failed = true;
          reject(error);
        }
      };
      archive.on("error", fail);
      tar.on("error", fail);
      archive.on("close", (code) => code !== 0 && fail(new Error(`git archive ${ref} exited ${code}`)));
      tar.on("close", (code) => (code === 0 ? !failed && resolve() : fail(new Error(`tar exited ${code}`))));
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { dir, cleanup };
}

// ── graph ─────────────────────────────────────────────────────────────────────────

export function computeImpact(
  head: AnalysisResult,
  changed: ChangedFile[],
  options: { base?: string; baseResult?: AnalysisResult } = {},
): ImpactReport {
  const nodes = head.graph?.nodes ?? [];
  const roleOf = new Map(nodes.map((node) => [node.id, node.layer] as const));
  // Import reachability only exists where imports are parsed; "no test reaches it" is meaningless
  // for a shell script or a Go file, so those are never reported as untested.
  const importParsed = new Set(
    nodes.filter((node) => IMPORT_PARSED_LANGUAGES.has(node.language)).map((node) => node.id),
  );
  const isTest = (id: string) => roleOf.get(id) === "test";
  const dependents = new Map<string, string[]>();
  for (const edge of head.graph?.edges ?? []) {
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }
  const reachersOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const next of dependents.get(current) ?? []) {
        if (next === id || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const entryPoints = new Set((head.entryPoints ?? []).map((entry) => entry.fileId));
  const keyRank = new Map<string, number>();
  (head.metrics?.keyFiles ?? []).filter((id) => roleOf.get(id) === "source").forEach((id, i) => keyRank.set(id, i + 1));
  const changedSet = new Set(changed.map((file) => file.path));

  const blast = new Set<string>();
  const tests = new Set<string>();
  const affectedEntries = new Set<string>();
  const files: FileImpact[] = [];
  for (const file of changed) {
    if (!roleOf.has(file.path)) {
      files.push({ ...file, role: undefined, directDependents: 0, transitiveDependents: 0, testsReaching: 0, entryPointsReaching: [] });
      continue;
    }
    const reachers = reachersOf(file.path);
    const production = [...reachers].filter((id) => !isTest(id));
    const reachingTests = [...reachers].filter(isTest);
    const entries = [...reachers, file.path].filter((id) => entryPoints.has(id)).sort();
    production.forEach((id) => !changedSet.has(id) && blast.add(id));
    reachingTests.forEach((id) => tests.add(id));
    entries.forEach((id) => affectedEntries.add(id));
    files.push({
      ...file,
      role: roleOf.get(file.path),
      directDependents: (dependents.get(file.path) ?? []).filter((id) => !isTest(id)).length,
      transitiveDependents: production.length,
      ...(keyRank.has(file.path) ? { keyFileRank: keyRank.get(file.path) } : {}),
      testsReaching: reachingTests.length,
      entryPointsReaching: entries,
    });
  }
  files.sort((a, b) => b.transitiveDependents - a.transitiveDependents || a.path.localeCompare(b.path));

  const cycleKey = (cycle: string[]) => [...cycle].sort().join("\u0000");
  const headCycles = (head.metrics?.cycles ?? []).map((cycle) => cycle.files);
  const baseCycleKeys = options.baseResult ? new Set((options.baseResult.metrics?.cycles ?? []).map((c) => cycleKey(c.files))) : null;

  return {
    ...(options.base ? { base: options.base } : {}),
    changed,
    files,
    blastRadius: [...blast].sort(),
    entryPointsAffected: [...affectedEntries].sort(),
    testsReaching: [...tests].sort(),
    untested: files
      .filter((file) => file.role === "source" && importParsed.has(file.path) && file.status !== "deleted" && file.testsReaching === 0)
      .map((file) => file.path),
    newCycles: baseCycleKeys ? headCycles.filter((cycle) => !baseCycleKeys.has(cycleKey(cycle))) : null,
    cyclesTouched: headCycles.filter((cycle) => cycle.some((id) => changedSet.has(id))),
    brokenImports: (head.graph?.resolution.unresolvedImports ?? []).filter((entry) => changedSet.has(entry.from)),
    totalSourceFiles: nodes.filter((node) => node.layer === "source").length,
  };
}

// ── rendering ─────────────────────────────────────────────────────────────────────

const LIST_CAP = 15;

function capped(items: string[], render: (item: string) => string): string[] {
  const shown = items.slice(0, LIST_CAP).map(render);
  if (items.length > LIST_CAP) shown.push(`…and ${items.length - LIST_CAP} more`);
  return shown;
}

export function renderImpactMarkdown(report: ImpactReport, options: { linkBase?: string } = {}): string {
  const link = (file: string) => (options.linkBase ? `[\`${file}\`](${options.linkBase}/${file})` : `\`${file}\``);
  const sourceChanged = report.files.filter((file) => file.role === "source").length;
  const out: string[] = ["## CodeFlow impact report", ""];

  const flags: string[] = [];
  if (report.newCycles && report.newCycles.length) flags.push(`❌ **${report.newCycles.length} new import cycle(s)**`);
  if (report.brokenImports.length) flags.push(`❌ **${report.brokenImports.length} import(s) that resolve to nothing**`);
  if (report.untested.length) flags.push(`⚠️ ${report.untested.length} changed source file(s) no test reaches`);
  out.push(
    `**${report.changed.length}** file(s) changed (${sourceChanged} source) · **${report.blastRadius.length}** other production file(s) depend on them · ` +
      `**${report.entryPointsAffected.length}** entry point(s) affected · **${report.testsReaching.length}** test file(s) reach the change` +
      (report.base ? ` · base \`${report.base}\`` : ""),
  );
  out.push("", flags.length ? flags.join(" · ") : "✅ No new cycles, no broken imports.", "");

  const ranked = report.files.filter((file) => file.role !== undefined);
  if (ranked.length) {
    out.push("| Changed file | Dependents (direct / transitive) | Load-bearing rank | Tests reaching | Entry points |", "|---|---|---|---|---|");
    for (const file of ranked.slice(0, LIST_CAP)) {
      out.push(
        `| ${link(file.path)}${file.status === "added" ? " _(new)_" : file.status === "deleted" ? " _(deleted)_" : ""} | ` +
          `${file.directDependents} / ${file.transitiveDependents} | ${file.keyFileRank ? `#${file.keyFileRank} of ${report.totalSourceFiles}` : "—"} | ` +
          `${file.testsReaching || (report.untested.includes(file.path) ? "⚠️ 0" : "—")} | ` +
          `${file.entryPointsReaching.length || "—"} |`,
      );
    }
    if (ranked.length > LIST_CAP) out.push(`| …and ${ranked.length - LIST_CAP} more | | | | |`);
    out.push("");
  }

  if (report.newCycles?.length) {
    out.push("<details open><summary><b>New import cycles</b> (load-time; <code>import type</code> / TYPE_CHECKING / lazy imports excluded)</summary>", "");
    for (const cycle of report.newCycles.slice(0, LIST_CAP)) out.push(`- ${[...cycle, cycle[0]].map(link).join(" → ")}`);
    out.push("", "</details>", "");
  }
  if (report.brokenImports.length) {
    out.push("<details open><summary><b>Imports that resolve to nothing</b></summary>", "");
    for (const entry of report.brokenImports.slice(0, LIST_CAP)) out.push(`- ${link(entry.from)} imports \`${entry.specifier}\``);
    out.push("", "</details>", "");
  }
  if (report.entryPointsAffected.length) {
    out.push(`<details><summary><b>Entry points that reach this change</b> (${report.entryPointsAffected.length})</summary>`, "");
    out.push(...capped(report.entryPointsAffected, (file) => `- ${link(file)}`), "", "</details>", "");
  }
  if (report.blastRadius.length) {
    out.push(`<details><summary><b>Production files that depend on this change</b> (${report.blastRadius.length})</summary>`, "");
    out.push(...capped(report.blastRadius, (file) => `- ${link(file)}`), "", "</details>", "");
  }
  if (report.untested.length) {
    out.push(`<details><summary><b>Changed source files no test reaches</b> (${report.untested.length})</summary>`, "");
    out.push(...capped(report.untested, (file) => `- ${link(file)}`), "", "</details>", "");
  }
  out.push(
    "<sub>Deterministic, from the import graph — no model involved. \"Tests reaching\" is import reachability, not coverage. " +
      "Generated by <a href=\"https://github.com/AnshulMohanty/Code_Flow\">CodeFlow</a>.</sub>",
  );
  return out.join("\n");
}

function shortList(items: string[], max: number): string {
  return items.length > max ? `${items.slice(0, max).join(", ")} (+${items.length - max} more)` : items.join(", ");
}

export function renderImpactText(report: ImpactReport): string {
  const out: string[] = [];
  out.push(`changed:        ${report.changed.length} file(s)${report.base ? ` since ${report.base}` : ""}`);
  out.push(`blast radius:   ${report.blastRadius.length} other production file(s) depend on the change`);
  out.push(`entry points:   ${report.entryPointsAffected.length ? shortList(report.entryPointsAffected, 6) : "none affected"}`);
  out.push(`tests reaching: ${report.testsReaching.length} test file(s)`);
  out.push(`new cycles:     ${report.newCycles === null ? "base not analysed" : report.newCycles.length}`);
  out.push(`broken imports: ${report.brokenImports.length}`);
  out.push("");
  for (const file of report.files) {
    if (file.role === undefined) {
      out.push(`  ${file.status.padEnd(8)} ${file.path}  (not in the analysed graph)`);
      continue;
    }
    out.push(
      `  ${file.status.padEnd(8)} ${file.path}  deps ${file.directDependents}/${file.transitiveDependents}` +
        `${file.keyFileRank ? `  rank #${file.keyFileRank}` : ""}  tests ${file.testsReaching}` +
        `${file.entryPointsReaching.length ? `  → ${shortList(file.entryPointsReaching, 3)}` : ""}`,
    );
  }
  for (const cycle of report.newCycles ?? []) out.push(`NEW CYCLE: ${[...cycle, cycle[0]].join(" → ")}`);
  for (const entry of report.brokenImports) out.push(`BROKEN IMPORT: ${entry.from} imports "${entry.specifier}"`);
  for (const file of report.untested) out.push(`UNTESTED: ${file}`);
  return out.join("\n");
}
