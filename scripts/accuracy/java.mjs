#!/usr/bin/env node
/**
 * JAVA GRAPH ACCURACY vs JAVAC.
 *
 * Ground truth comes from `JavaTruth.java`: javac parses and attributes every source file, and
 * each name in the source that resolves to a type declared in this repository gives an edge
 * (file → file declaring that type). That is the compiler's own name resolution — imports,
 * same-package types, nested types, fully qualified names, static imports.
 *
 * CodeFlow's Java edges are compared as file pairs:
 *   agree   both have the edge
 *   extra   CodeFlow has it, javac does not   (precision error)
 *   missed  javac has it, CodeFlow does not   (recall error)
 *
 * Needs a JDK 17+: the local `java` when installed, otherwise the official eclipse-temurin image.
 *
 * USAGE
 *   node apps/local-cli/dist/index.js analyze <repo> --no-index --out /tmp/r.json
 *   node scripts/accuracy/java.mjs <repo> /tmp/r.json [--json] [--truth truth.json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JDK_IMAGE = "eclipse-temurin:21-jdk";
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--truth");
const [repoArg, resultArg] = positional;
if (!repoArg || !resultArg) {
  console.error("usage: java.mjs <repo-path> <analysis-result.json> [--json] [--truth cached-truth.json]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const asJson = args.includes("--json");
const here = path.dirname(fileURLToPath(import.meta.url));

function javacTruth() {
  const options = { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 };
  const local = spawnSync("java", ["-version"], { stdio: "ignore" }).status === 0;
  if (local) return execFileSync("java", ["-Xmx6g", path.join(here, "JavaTruth.java"), repo], options);
  return execFileSync(
    "docker",
    ["run", "--rm", "-v", `${repo}:/repo:ro`, "-v", `${here}:/tool:ro`, JDK_IMAGE, "java", "-Xmx6g", "/tool/JavaTruth.java", "/repo"],
    options,
  );
}

const truth = JSON.parse(flag("--truth") ? await readFile(flag("--truth"), "utf8") : javacTruth());
const result = JSON.parse(await readFile(path.resolve(resultArg), "utf8"));

const nodes = result.graph?.nodes ?? [];
const analysed = new Set(nodes.filter((n) => n.language === "Java" && (n.layer === "source" || n.layer === "test")).map((n) => n.id));
const truthFiles = new Set(Object.keys(truth.edges ?? {}));
const inScope = (file) => analysed.has(file) && truthFiles.has(file);

const ours = new Set();
for (const edge of result.graph?.edges ?? []) {
  if (inScope(edge.from) && inScope(edge.to) && edge.from !== edge.to) ours.add(`${edge.from}\u0000${edge.to}`);
}
const theirs = new Set();
for (const [from, targets] of Object.entries(truth.edges ?? {})) {
  if (!inScope(from)) continue;
  for (const to of targets) if (inScope(to)) theirs.add(`${from}\u0000${to}`);
}

const counts = { agree: 0, extra: 0, missed: 0 };
const samples = { extra: [], missed: [] };
const sample = (kind, key) => {
  if (samples[kind].length >= 10) return;
  const [file, target] = key.split("\u0000");
  samples[kind].push({ file, target });
};
for (const key of ours) {
  if (theirs.has(key)) counts.agree += 1;
  else {
    counts.extra += 1;
    sample("extra", key);
  }
}
for (const key of theirs) {
  if (!ours.has(key)) {
    counts.missed += 1;
    sample("missed", key);
  }
}

const precision = ours.size ? counts.agree / ours.size : 1;
const recall = theirs.size ? counts.agree / theirs.size : 1;
const summary = {
  repo: result.repository?.name ?? path.basename(repo),
  language: "Java",
  filesChecked: [...analysed].filter((file) => truthFiles.has(file)).length,
  javacEdges: theirs.size,
  codeflowEdges: ours.size,
  javacErrors: truth.javacErrors,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};

if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${summary.repo}: ${summary.filesChecked} Java files, ${theirs.size} in-repo edges per javac (${truth.javacErrors} javac errors from unresolved external libraries)`);
  console.log(`  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, extra ${counts.extra}, missed ${counts.missed})`);
  for (const kind of ["extra", "missed"]) for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file} -> ${s.target}`);
}
