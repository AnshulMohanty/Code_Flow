#!/usr/bin/env node
/**
 * C# GRAPH ACCURACY vs ROSLYN.
 *
 * Ground truth comes from `csharp-truth/` (Roslyn, the C# compiler): every .csproj is compiled with its
 * project references, global usings and each target framework's preprocessor symbols, and every name in
 * the source that binds to a type declared in this repository gives an edge (file → the files declaring
 * that type). CodeFlow's C# edges are compared as file pairs: agree / extra (precision) / missed (recall).
 * An extra edge into source the build takes from a NuGet package of the same repository (the compiler binds
 * to the package, CodeFlow to the source it was built from) is counted as extra and also reported apart.
 *
 * Needs the .NET SDK (it builds the tool against the Roslyn shipped inside the SDK — no NuGet download):
 * the local `dotnet` when it has SDK 10+, otherwise the official mcr.microsoft.com/dotnet/sdk image.
 *
 * USAGE
 *   node apps/local-cli/dist/index.js analyze <repo> --no-index --out /tmp/r.json
 *   node scripts/accuracy/csharp.mjs <repo> /tmp/r.json [--json] [--truth truth.json | --save-truth truth.json]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, existsSync, cpSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SDK_IMAGE = "mcr.microsoft.com/dotnet/sdk:10.0";
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const positional = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--truth" && args[index - 1] !== "--save-truth");
const [repoArg, resultArg] = positional;
if (!repoArg || !resultArg) {
  console.error("usage: csharp.mjs <repo-path> <analysis-result.json> [--json] [--truth cached-truth.json]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const asJson = args.includes("--json");
const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), "csharp-truth");

function localRoslyn() {
  const sdks = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8" });
  if (sdks.status !== 0) return undefined;
  for (const line of sdks.stdout.trim().split("\n").reverse()) {
    const match = /^(\d+)\.\S+\s+\[(.+)\]$/.exec(line.trim());
    if (!match || Number(match[1]) < 10) continue;
    const bincore = path.join(match[2], line.trim().split(/\s+/)[0], "Roslyn", "bincore");
    if (existsSync(path.join(bincore, "Microsoft.CodeAnalysis.CSharp.dll"))) return bincore;
  }
  return undefined;
}

function roslynTruth() {
  const options = { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] };
  const roslyn = localRoslyn();
  if (roslyn) {
    const work = path.join(os.tmpdir(), "codeflow-csharp-truth");
    mkdirSync(work, { recursive: true });
    for (const file of readdirSync(tool)) cpSync(path.join(tool, file), path.join(work, file));
    execFileSync("dotnet", ["build", work, "-c", "Release", "-o", path.join(work, "out"), `-p:RoslynDir=${roslyn}`, "-nologo", "-v", "q"], {
      ...options,
      stdio: ["ignore", "ignore", "inherit"],
    });
    return execFileSync("dotnet", [path.join(work, "out", "CSharpTruth.dll"), repo], options);
  }
  const script = [
    "set -e",
    "ROSLYN=$(dirname $(ls -d /usr/share/dotnet/sdk/*/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll | sort | tail -1))",
    "mkdir -p /build/src && cp /tool/* /build/src/",
    "dotnet build /build/src -c Release -o /build/out -p:RoslynDir=$ROSLYN -nologo -v q 1>&2",
    "dotnet /build/out/CSharpTruth.dll /repo",
  ].join("\n");
  return execFileSync(
    "docker",
    [
      "run", "--rm",
      "-e", "DOTNET_CLI_TELEMETRY_OPTOUT=1", "-e", "DOTNET_NOLOGO=1", "-e", `CSHARP_TRUTH_EXPLAIN=${process.env.CSHARP_TRUTH_EXPLAIN ?? ""}`,
      "-v", `${repo}:/repo:ro`, "-v", `${tool}:/tool:ro`, "-v", "codeflow-csharp-truth:/build",
      SDK_IMAGE, "sh", "-c", script,
    ],
    options,
  );
}

const rawTruth = flag("--truth") ? await readFile(flag("--truth"), "utf8") : roslynTruth();
const truth = JSON.parse(rawTruth);
if (flag("--save-truth")) await writeFile(flag("--save-truth"), rawTruth);
const result = JSON.parse(await readFile(path.resolve(resultArg), "utf8"));

const nodes = result.graph?.nodes ?? [];
const analysed = new Set(nodes.filter((n) => n.language === "C#" && (n.layer === "source" || n.layer === "test")).map((n) => n.id));
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

const viaOwnPackage = new Set();
for (const [from, targets] of Object.entries(truth.viaOwnPackage ?? {})) for (const to of targets) viaOwnPackage.add(`${from}\u0000${to}`);
const counts = { agree: 0, extra: 0, missed: 0, extraViaOwnPackage: 0 };
const samples = { extra: [], missed: [] };
const sample = (kind, key) => {
  if (samples[kind].length >= 15) return;
  const [file, target] = key.split("\u0000");
  samples[kind].push({ file, target });
};
for (const key of ours) {
  if (theirs.has(key)) counts.agree += 1;
  else {
    counts.extra += 1;
    if (viaOwnPackage.has(key)) counts.extraViaOwnPackage += 1;
    else sample("extra", key);
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
  language: "C#",
  projects: truth.projects,
  filesChecked: [...analysed].filter((file) => truthFiles.has(file)).length,
  filesInNoProject: truth.filesInNoProject,
  roslynEdges: theirs.size,
  codeflowEdges: ours.size,
  parseErrors: truth.parseErrors,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};

if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(
    `${summary.repo}: ${summary.filesChecked} C# files in ${truth.projects} projects, ${theirs.size} in-repo edges per Roslyn (${truth.filesInNoProject} .cs files in no project)`,
  );
  console.log(`  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, extra ${counts.extra}, missed ${counts.missed})`);
  if (counts.extraViaOwnPackage) console.log(`  ${counts.extraViaOwnPackage} of the extra edges point at source the build takes from a NuGet package of this repository`);
  for (const kind of ["extra", "missed"]) for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file} -> ${s.target}`);
}
