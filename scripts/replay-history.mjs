#!/usr/bin/env node
/**
 * REPLAY A PROJECT'S HISTORY THROUGH THE PR CHECK.
 *
 * For each of the last N first-parent commits: check it out in a throwaway git worktree, run the
 * same `codeflow-local impact` the GitHub Action runs (against the commit's parent), and record what
 * the QUIET bot would have done — stay silent, or comment, and why. Two numbers come out:
 *   - how often it would have spoken (a bot that speaks on every push gets muted), and
 *   - what it would have said (each finding is listed so a person can check it is real).
 * Local git only; the repository's own checkout is never touched.
 *
 * USAGE  node scripts/replay-history.mjs --repo <path with history> [--commits 50] [--out report.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repo = path.resolve(arg("--repo"));
const COMMITS = Number(arg("--commits", "50"));
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../apps/local-cli/dist/index.js");
const { isNotable } = await import(new URL("../apps/local-cli/dist/impact.js", import.meta.url).href);

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commits = git("rev-list", "--first-parent", "-n", String(COMMITS + 1), "HEAD").split("\n").slice(0, COMMITS);

const rows = [];
for (const sha of commits) {
  let parent;
  try {
    parent = git("rev-parse", `${sha}^`);
  } catch {
    continue; // the shallow boundary: no parent to compare with
  }
  const dir = mkdtempSync(path.join(tmpdir(), "codeflow-replay-"));
  try {
    git("worktree", "add", "--detach", "-q", dir, sha);
    const out = execFileSync(process.execPath, [CLI, "impact", dir, "--base", parent, "--format", "json"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const report = JSON.parse(out);
    const notable = isNotable(report);
    const reasons = [
      ...(report.newCycles ?? []).map((cycle) => `new cycle: ${cycle.join(" → ")}`),
      ...report.brokenImports.map((entry) => `broken import: ${entry.from} imports "${entry.specifier}"`),
      ...report.ruleViolations.map((v) => `rule: ${v.rule}`),
      ...report.files
        .filter((file) => report.untested.includes(file.path) && file.transitiveDependents >= 5)
        .map((file) => `untested change to ${file.path} (${file.transitiveDependents} dependents)`),
    ];
    rows.push({ sha: sha.slice(0, 10), subject: git("log", "-1", "--format=%s", sha).slice(0, 80), changed: report.changed.length, notable, reasons });
    console.log(`${sha.slice(0, 10)} ${notable ? "COMMENT" : "silent "} ${String(report.changed.length).padStart(4)} files  ${reasons.slice(0, 2).join(" | ")}`);
  } catch (error) {
    rows.push({ sha: sha.slice(0, 10), error: String(error.message ?? error).slice(0, 200) });
    console.log(`${sha.slice(0, 10)} ERROR ${String(error.message ?? error).slice(0, 120)}`);
  } finally {
    try {
      git("worktree", "remove", "--force", dir);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const judged = rows.filter((row) => !row.error);
const summary = {
  repo: path.basename(repo),
  commits: judged.length,
  errors: rows.length - judged.length,
  wouldComment: judged.filter((row) => row.notable).length,
  silentShare: judged.length ? Number((judged.filter((row) => !row.notable).length / judged.length).toFixed(3)) : null,
  findings: judged.filter((row) => row.notable).map((row) => ({ sha: row.sha, subject: row.subject, reasons: row.reasons })),
};
if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
