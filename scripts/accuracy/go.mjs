#!/usr/bin/env node
/**
 * GO GRAPH ACCURACY vs THE GO TOOLCHAIN.
 *
 * Ground truth comes from `go-truth.go`: go/parser lists every file's imports, and
 * `go list -deps -test` (run in every module) says which DIRECTORY each import path resolves to.
 * CodeFlow resolves a Go import to the FILE(S) declaring what is used, so an edge is compared
 * by its directory:
 *
 *   agree   every CodeFlow target of (file, import) is in the directory go resolved it to
 *   wrong   at least one target is in another directory              (precision error)
 *   missed  go resolves it inside the repo, CodeFlow has no edge     (recall error)
 *   extra   CodeFlow has an edge, go resolves it to nothing in-repo  (reported with samples)
 *
 * Needs Go: the local `go` when installed, otherwise the official `golang` Docker image.
 *
 * USAGE
 *   node apps/local-cli/dist/index.js analyze <repo> --no-index --out /tmp/r.json
 *   node scripts/accuracy/go.mjs <repo> /tmp/r.json [--json] [--truth truth.json] [--gopath <import path>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GO_IMAGE = "golang:1.25-alpine";
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const positional = args.filter((arg, index) => !arg.startsWith("--") && !["--truth", "--gopath"].includes(args[index - 1]));
const [repoArg, resultArg] = positional;
if (!repoArg || !resultArg) {
  console.error("usage: go.mjs <repo-path> <analysis-result.json> [--json] [--truth cached-truth.json]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const asJson = args.includes("--json");
const here = path.dirname(fileURLToPath(import.meta.url));

const gopathImport = flag("--gopath"); // GOPATH-era repo: the import path it is checked out under

function goTruth() {
  const hasGo = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;
  const options = { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 };
  // GOPATH mode needs the repo AT $GOPATH/src/<import path>; only the container can arrange that.
  if (hasGo && !gopathImport) return execFileSync("go", ["run", path.join(here, "go-truth.go"), repo], options);
  const mountAt = gopathImport ? `/go/src/${gopathImport}` : "/repo";
  return execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${repo}:${mountAt}`,
      ...(gopathImport ? ["-e", `CODEFLOW_GOPATH_IMPORT=${gopathImport}`] : []),
      "-v", `${here}:/tool:ro`,
      "-v", "codeflow-gomodcache:/go/pkg/mod", // module downloads survive between runs
      "-e", "GOTOOLCHAIN=auto", // the image pins `local`; a repo may need a newer Go
      "-w", "/tool",
      GO_IMAGE, "go", "run", "/tool/go-truth.go", mountAt,
    ],
    options,
  );
}

const truthText = flag("--truth") ? await readFile(flag("--truth"), "utf8") : goTruth();
const truth = JSON.parse(truthText);
for (const [module, message] of Object.entries(truth.errors ?? {})) {
  const real = message.split("\n").filter((line) => line && !/^go: (downloading|finding)/.test(line));
  if (real.length && !asJson) console.error(`go list (${module || "."}): ${real.slice(0, 2).join(" | ")}`);
}
const result = JSON.parse(await readFile(path.resolve(resultArg), "utf8"));

const nodes = result.graph?.nodes ?? [];
const analysed = new Set(
  nodes.filter((n) => n.language === "Go" && (n.layer === "source" || n.layer === "test")).map((n) => n.id),
);
const ours = new Map();
for (const edge of result.graph?.edges ?? []) {
  const key = `${edge.from}\u0000${edge.specifier}`;
  const list = ours.get(key) ?? [];
  list.push(edge.to);
  ours.set(key, list);
}

const moduleDirs = Object.keys(truth.modules ?? {}).sort((a, b) => b.length - a.length);
const moduleOf = (file) => moduleDirs.find((dir) => dir === "" || file.startsWith(`${dir}/`));
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const counts = { agree: 0, wrong: 0, missed: 0, extra: 0, pairs: 0, noModule: 0 };
const samples = { wrong: [], missed: [], extra: [] };
const sample = (kind, value) => samples[kind].length < 10 && samples[kind].push(value);

for (const [file, imports] of Object.entries(truth.imports ?? {})) {
  if (!analysed.has(file)) continue;
  const module = moduleOf(file);
  if (module === undefined) {
    counts.noModule += 1; // GOPATH-era file: go list cannot place it without a GOPATH checkout
    continue;
  }
  const resolved = truth.modules[module];
  for (const importPath of new Set(imports)) {
    counts.pairs += 1;
    const expected = resolved[importPath];
    const targets = ours.get(`${file}\u0000${importPath}`) ?? [];
    if (expected !== undefined && targets.length) {
      const off = targets.filter((target) => dirname(target) !== expected);
      if (off.length === 0) counts.agree += 1;
      else {
        counts.wrong += 1;
        sample("wrong", { file, import: importPath, go: expected, codeflow: off[0] });
      }
    } else if (expected !== undefined) {
      counts.missed += 1;
      sample("missed", { file, import: importPath, go: expected });
    } else if (targets.length) {
      counts.extra += 1;
      sample("extra", { file, import: importPath, codeflow: targets[0] });
    }
  }
}

const truthEdges = counts.agree + counts.wrong + counts.missed;
const judged = counts.agree + counts.wrong;
const precision = judged ? counts.agree / judged : 1;
const recall = truthEdges ? counts.agree / truthEdges : 1;
const summary = {
  repo: result.repository?.name ?? path.basename(repo),
  language: "Go",
  filesChecked: Object.keys(truth.imports ?? {}).filter((file) => analysed.has(file)).length,
  modules: moduleDirs.length,
  importPairs: counts.pairs,
  goInRepoEdges: truthEdges,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};

if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `${summary.repo}: ${summary.filesChecked} Go files, ${summary.modules} module(s), ${counts.pairs} imports, ${truthEdges} in-repo per go list`,
  );
  console.log(
    `  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, wrong ${counts.wrong}, missed ${counts.missed}, extra ${counts.extra}${counts.noModule ? `, ${counts.noModule} files outside any module` : ""})`,
  );
  for (const kind of ["wrong", "missed", "extra"]) {
    for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file}  "${s.import}"  go=${s.go ?? "-"}  codeflow=${s.codeflow ?? "-"}`);
  }
}
