#!/usr/bin/env node
/**
 * TEST SELECTION, PROVEN BY FAULT INJECTION.
 *
 * "Run only the tests that reach the change" is worth something only if it never skips a test that
 * would have failed. So for N source files, chosen deterministically:
 *   1. CodeFlow selects the test files whose import closure reaches the file (its "tests reaching").
 *   2. The file is made to THROW the moment it loads (a fault every importer must observe).
 *   3. The FULL suite runs through the project's real test runner, and the failing test files are read
 *      from its machine-readable report.
 *   4. The file is restored byte for byte.
 * A failing test file outside CodeFlow's selection is a MISS — a test CI would have skipped. Savings is
 * the share of test files not selected. Test files that already fail before any fault are excluded.
 *
 * The fault is a load-time throw on purpose: it reaches every test that loads the file through any
 * path the real module loader takes, so it checks the graph against the runtime, not against itself.
 *
 * Runners: vitest | jest (JSON reporter) and go (`go test -json`, judged per package).
 *
 * USAGE
 *   node scripts/test-selection-eval.mjs --repo <path> --result <analysis.json> --runner vitest
 *        [--samples 20] [--test-cmd "npx vitest run"] [--out report.json]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repo = path.resolve(arg("--repo"));
const result = JSON.parse(readFileSync(path.resolve(arg("--result")), "utf8"));
const RUNNER = arg("--runner", "vitest");
const SAMPLES = Number(arg("--samples", "20"));
const TEST_CMD = arg("--test-cmd", RUNNER === "go" ? "go test -json ./..." : RUNNER === "jest" ? "npx jest" : "npx vitest run");

const nodes = new Map((result.graph?.nodes ?? []).map((node) => [node.id, node]));
const tests = [...nodes.values()].filter((node) => node.layer === "test" && isTestFile(node.id)).map((node) => node.id).sort();
const reverse = new Map();
for (const edge of result.graph?.edges ?? []) {
  if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
  reverse.get(edge.to).add(edge.from);
}

function isTestFile(file) {
  return RUNNER === "go" ? file.endsWith("_test.go") : /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** CodeFlow's selection: test files whose import closure reaches `file`. */
function selectedFor(file) {
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length) {
    for (const dependent of reverse.get(queue.pop()) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return tests.filter((test) => seen.has(test));
}

/** The failing test files (or Go packages) of one full run. */
function failingTests() {
  const report = path.join(tmpdir(), `codeflow-tse-${process.pid}.json`);
  rmSync(report, { force: true });
  const [command, ...rest] = TEST_CMD.split(" ");
  const extra = RUNNER === "vitest" ? ["--reporter=json", `--outputFile=${report}`] : RUNNER === "jest" ? ["--json", `--outputFile=${report}`] : [];
  const run = spawnSync(command, [...rest, ...extra], { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const failing = new Set();
  if (RUNNER === "go") {
    for (const line of run.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line);
      // A package whose tests fail (or fail to build or init) — every _test.go file in it is "failing".
      if ((event.Action === "fail" && !event.Test) || event.Action === "build-fail") failing.add(event.ImportPath ?? event.Package);
    }
    return failing;
  }
  if (!existsSync(report)) throw new Error(`the test runner wrote no report:\n${(run.stderr || run.stdout).slice(-2000)}`);
  const json = JSON.parse(readFileSync(report, "utf8"));
  for (const file of json.testResults ?? []) {
    if (file.status !== "passed") failing.add(path.relative(repo, file.name).split(path.sep).join("/"));
  }
  return failing;
}

/** Go judges per PACKAGE: map test files to their package import path via their directory. */
const goModule = RUNNER === "go" ? readFileSync(path.join(repo, "go.mod"), "utf8").match(/^module\s+(\S+)/m)?.[1] : undefined;
const unitOf = (testFile) => (RUNNER === "go" ? [goModule, path.posix.dirname(testFile)].filter((p) => p && p !== ".").join("/") : testFile);

function inject(file) {
  const full = path.join(repo, file);
  const original = readFileSync(full, "utf8");
  const fault =
    RUNNER === "go"
      ? original.replace(/^(package\s+\w+.*)$/m, `$1\n\nfunc init() { panic("codeflow-test-selection-fault") }`)
      : `throw new Error("codeflow-test-selection-fault");\n${original}`;
  writeFileSync(full, fault);
  return () => writeFileSync(full, original);
}

// Candidates: production source files some test reaches (a file no test reaches cannot be judged).
const sources = [...nodes.values()]
  .filter((node) => node.layer === "source" && (RUNNER === "go" ? node.id.endsWith(".go") : /\.[cm]?[jt]sx?$/.test(node.id)))
  .map((node) => node.id)
  .filter((file) => selectedFor(file).length > 0)
  .sort();
const sample = [];
for (let i = 0; i < SAMPLES && sources.length; i += 1) sample.push(sources[Math.floor(((i + 0.5) * sources.length) / SAMPLES)]);

console.log(`${tests.length} test files; ${sources.length} source files reached by a test; judging ${sample.length}`);
const baseline = failingTests();
console.log(`baseline: ${baseline.size} test unit(s) already failing (excluded)`);
const allUnits = new Set(tests.map(unitOf));

const rows = [];
for (const file of sample) {
  const selected = new Set(selectedFor(file).map(unitOf));
  const restore = inject(file);
  let failing;
  try {
    failing = failingTests();
  } finally {
    restore();
  }
  const newlyFailing = [...failing].filter((unit) => !baseline.has(unit));
  const missed = newlyFailing.filter((unit) => !selected.has(unit));
  rows.push({ file, selected: selected.size, failing: newlyFailing.length, missed, savedShare: 1 - selected.size / allUnits.size });
  console.log(
    `${file}: selected ${selected.size}/${allUnits.size}, failed ${newlyFailing.length}, missed ${missed.length}${missed.length ? ` (${missed.slice(0, 3).join(", ")})` : ""}`,
  );
}

const totalFailing = rows.reduce((sum, row) => sum + row.failing, 0);
const totalMissed = rows.reduce((sum, row) => sum + row.missed.length, 0);
const summary = {
  repo: path.basename(repo),
  runner: RUNNER,
  testUnits: allUnits.size,
  faultsInjected: rows.length,
  failuresObserved: totalFailing,
  failuresMissed: totalMissed,
  safety: totalFailing ? Number(((totalFailing - totalMissed) / totalFailing).toFixed(4)) : 1,
  meanShareOfTestsSkipped: Number((rows.reduce((sum, row) => sum + row.savedShare, 0) / Math.max(1, rows.length)).toFixed(4)),
  rows,
};
if (arg("--out")) writeFileSync(arg("--out"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
