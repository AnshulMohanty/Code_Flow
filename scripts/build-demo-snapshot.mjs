#!/usr/bin/env node
/**
 * BUILD THE BUNDLED DEMO SNAPSHOT — a real analysis, stamped with its provenance.
 *
 * WHY THIS SCRIPT EXISTS AT ALL rather than a committed fixture: a fixture is authored, and the one
 * thing this product may never ship is authored data wearing the costume of a measurement. So the
 * snapshot is GENERATED, from a real repository, by the real analyser, and the command that produced
 * it is in this file where anyone can re-run it and diff the result.
 *
 * WHAT IT RUNS: `codeflow-local analyze`, the project's own offline CLI. No key, no network, no
 * provider — web-tree-sitter WASM parsing, the same stages, the same graph code. That matters twice
 * over: the snapshot is reproducible by anyone with a checkout, and generating it cannot silently
 * become an API call that costs money.
 *
 * WHAT IT REFUSES TO DO:
 *   - Run on a DIRTY working tree. The provenance pins a commit SHA, and a snapshot of uncommitted
 *     changes labelled with a commit is a lie about which code was analysed — and every citation in
 *     it would link to source that does not match.
 *   - Invent a commit. `codeflow-local` sets `commitSha: "local"` because it reads a working tree
 *     rather than cloning; the real SHA comes from `git rev-parse` here, and if git cannot answer,
 *     this exits rather than shipping a snapshot whose citations cannot resolve.
 *
 * USAGE
 *   node scripts/build-demo-snapshot.mjs                      # this repo -> apps/web/src/demo/snapshot.json
 *   node scripts/build-demo-snapshot.mjs --repo ../express --name expressjs/express
 *   node scripts/build-demo-snapshot.mjs --out /tmp/snap.json --allow-dirty
 *
 * `--allow-dirty` exists for local experimentation and marks the provenance accordingly, so a
 * snapshot produced that way cannot be mistaken for a clean one.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const target = resolve(arg("repo", repoRoot));
const outPath = resolve(arg("out", join(repoRoot, "apps/web/src/demo/snapshot.json")));
const allowDirty = flag("allow-dirty");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fail(message) {
  console.error(`build-demo-snapshot: ${message}`);
  process.exit(1);
}

// ── Provenance, resolved BEFORE the analysis so a bad tree fails fast ────────────────────────────
let commitSha;
let repoFullName = arg("name", undefined);
try {
  commitSha = git(["rev-parse", "HEAD"], target);
} catch {
  fail(`${target} is not a git repository, so there is no commit to pin the snapshot to.`);
}

const dirty = (() => {
  try {
    return git(["status", "--porcelain"], target).length > 0;
  } catch {
    return true;
  }
})();

if (dirty && !allowDirty) {
  fail(
    "the working tree has uncommitted changes. The snapshot pins a commit SHA, and analysing a " +
      "dirty tree under that label would misstate which code was read — every citation in it would " +
      "point at source that does not match. Commit, stash, or pass --allow-dirty.",
  );
}

if (!repoFullName) {
  try {
    const origin = git(["remote", "get-url", "origin"], target);
    const match = origin.match(/github\.com[:/]+([^/]+)\/([^/.]+)/i);
    if (match) repoFullName = `${match[1]}/${match[2]}`;
  } catch {
    /* no origin — handled below */
  }
}
if (!repoFullName) {
  fail("could not determine owner/repo from the git remote. Pass --name owner/repo.");
}

// ── Run the real analyser ────────────────────────────────────────────────────────────────────────
const scratch = join(repoRoot, "node_modules", ".cache", "codeflow-demo-snapshot.json");
await mkdir(dirname(scratch), { recursive: true });

console.log(`analysing ${target} (offline, deterministic) …`);
try {
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      join(repoRoot, "apps/local-cli/src/index.ts"),
      "analyze",
      target,
      "--no-index",
      "--out",
      scratch,
    ],
    { cwd: join(repoRoot, "apps/local-cli"), stdio: "inherit" },
  );
} catch {
  fail("codeflow-local failed. Run it directly to see why.");
}

const result = JSON.parse(await readFile(scratch, "utf8"));
await rm(scratch, { force: true });

// The CLI reads a working tree, so it stamps `commitSha: "local"` and knows nothing about a remote.
// Both are filled in here from git, which is the only source that can be right about them.
result.commitSha = commitSha;
const [owner, name] = repoFullName.split("/");
result.repository = { ...(result.repository ?? {}), provider: "github", owner, name, repo: name };

/**
 * WHAT A LOCAL RUN DOES NOT PRODUCE. Written into the snapshot rather than into a README, so it
 * travels with the data to every view that renders it. A reader who sees a sparse graph deserves to
 * know whether that is the repository or the method.
 */
const limitations = [
  "No AI summary and no reading order: synthesis needs a chat provider and this was produced offline with no key.",
  "No Q&A index: the same reason. Ask-the-repo is unavailable on this snapshot.",
  "Imports that resolve to workspace package names rather than to files are counted as unresolved, so the dependency graph is sparser than a hosted run on the same commit.",
];
if (dirty) {
  limitations.unshift(
    "GENERATED FROM A DIRTY WORKING TREE (--allow-dirty): the analysed source does not exactly match the pinned commit.",
  );
}

const snapshot = {
  provenance: {
    repoFullName,
    commitSha,
    generatedAt: new Date().toISOString(),
    analyzerVersion: result.producedBy?.analyzerVersion ?? result.analyzerVersion ?? "unknown",
    producedBy: "codeflow-local (offline, deterministic, no provider key)",
    limitations,
  },
  result,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(snapshot)}\n`, "utf8");

const bytes = JSON.stringify(snapshot).length;
console.log(`\nwrote ${outPath}`);
console.log(`  ${repoFullName} @ ${commitSha.slice(0, 7)}`);
console.log(`  ${result.graph?.nodes?.length ?? 0} files · ${result.graph?.edges?.length ?? 0} resolved edges`);
console.log(`  ${(bytes / 1024).toFixed(0)} KB — loaded as its own lazy chunk, never in the entry bundle.`);
