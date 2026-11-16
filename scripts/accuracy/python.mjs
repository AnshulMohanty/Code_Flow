#!/usr/bin/env node
/**
 * PYTHON GRAPH ACCURACY vs PYTHON'S OWN IMPORT MACHINERY.
 *
 * Ground truth: `python-truth.py` reads each file's imports with `ast` and locates every imported name
 * with `importlib.machinery.PathFinder` — the finder `import` uses — without executing anything.
 * Compared per (file, import as written, target file):
 *   agree    both resolve the import to that file
 *   missed   Python finds an in-repo target, CodeFlow has no edge to it    (recall)
 *   extra    CodeFlow has an edge Python does not                          (precision)
 *
 * USAGE  node scripts/accuracy/python.mjs <repo> <analysis.json> [--json] [--truth truth.json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--truth");
const [repoArg, resultArg] = positional;
if (!repoArg || !resultArg) {
  console.error("usage: python.mjs <repo> <analysis.json> [--json] [--truth truth.json]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const here = path.dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(
  flag("--truth")
    ? readFileSync(flag("--truth"), "utf8")
    : execFileSync("python3", ["-I", path.join(here, "python-truth.py"), repo], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }),
);
const result = JSON.parse(readFileSync(path.resolve(resultArg), "utf8"));

const analysed = new Set((result.graph?.nodes ?? []).filter((n) => n.language === "Python" && (n.layer === "source" || n.layer === "test")).map((n) => n.id));
const ours = new Map(); // `${file}\0${source}` → Set(target)
for (const edge of result.graph?.edges ?? []) {
  const key = `${edge.from}\u0000${edge.specifier}`;
  if (!ours.has(key)) ours.set(key, new Set());
  ours.get(key).add(edge.to);
}

const counts = { agree: 0, missed: 0, extra: 0, imports: 0 };
const samples = { missed: [], extra: [] };
const sample = (kind, value) => samples[kind].length < 10 && samples[kind].push(value);
for (const [file, entries] of Object.entries(truth.files)) {
  if (!analysed.has(file)) continue;
  const bySource = new Map();
  for (const entry of entries) {
    if (!bySource.has(entry.source)) bySource.set(entry.source, new Set());
    for (const target of entry.targets) bySource.get(entry.source).add(target);
  }
  for (const [source, expected] of bySource) {
    counts.imports += 1;
    const mine = ours.get(`${file}\u0000${source}`) ?? new Set();
    for (const target of expected) {
      if (mine.has(target)) counts.agree += 1;
      else {
        counts.missed += 1;
        sample("missed", { file, import: source, python: target });
      }
    }
    for (const target of mine) {
      if (!expected.has(target)) {
        counts.extra += 1;
        sample("extra", { file, import: source, codeflow: target });
      }
    }
  }
}

const precision = counts.agree + counts.extra ? counts.agree / (counts.agree + counts.extra) : 1;
const recall = counts.agree + counts.missed ? counts.agree / (counts.agree + counts.missed) : 1;
const summary = {
  repo: path.basename(repo),
  language: "Python",
  filesChecked: Object.keys(truth.files).filter((file) => analysed.has(file)).length,
  pythonInRepoEdges: counts.agree + counts.missed,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};
if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${summary.repo}: ${summary.filesChecked} Python files, ${counts.imports} imports, ${summary.pythonInRepoEdges} in-repo edges per Python`);
  console.log(`  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, extra ${counts.extra}, missed ${counts.missed})`);
  for (const kind of ["extra", "missed"]) for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file}  "${s.import}"  python=${s.python ?? "-"}  codeflow=${s.codeflow ?? "-"}`);
}
