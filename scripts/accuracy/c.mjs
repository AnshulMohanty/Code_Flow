#!/usr/bin/env node
/**
 * C/C++ GRAPH ACCURACY vs CLANG, with the project's own build flags.
 *
 * Ground truth: CMake configures the project and writes compile_commands.json (every file's real
 * `-I`/`-D` flags); each translation unit is then compiled with
 *   -fsyntax-only -H -Xclang -header-include-format=json -Xclang -header-include-filtering=direct-per-file
 * which prints, for every file the compiler opened, the files its `#include` directives resolved to —
 * re-includes skipped by include guards included.
 *
 * CodeFlow is compared file by file. For each CodeFlow edge (file, "spec" → target):
 *   agree      the compiler's include set for that file contains the target
 *   wrong      the compiler resolved a header of that name to a DIFFERENT file (in the repo or a
 *              system header) — a precision error
 *   unjudged   the compiler never processed that directive (an `#if` branch the build did not take)
 * and every in-repo file the compiler included that CodeFlow has no edge to is MISSED (recall).
 *
 * Runs clang + cmake in the `silkeh/clang:19` image (both are in it), so nothing is installed.
 *
 * USAGE
 *   node scripts/accuracy/c.mjs <repo> <analysis.json> [--cmake "-DFOO=OFF ..."] [--json] [--truth t.json] [--save-truth t.json]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const IMAGE = "silkeh/clang:21";
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const valued = new Set(["--cmake", "--truth", "--save-truth"]);
const positional = args.filter((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1]));
const [repoArg, resultArg] = positional;
if (!repoArg || !resultArg) {
  console.error('usage: c.mjs <repo> <analysis.json> [--cmake "<args>"] [--json] [--truth t.json] [--save-truth t.json]');
  process.exit(2);
}
const repo = path.resolve(repoArg);
const asJson = args.includes("--json");

function docker(work, script) {
  return execFileSync(
    "docker",
    ["run", "--rm", "-v", `${repo}:/repo:ro`, "-v", `${work}:/out`, IMAGE, "sh", "-c", script],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Repo-relative POSIX path for a container path, or null when it is outside the repository. */
function inRepo(containerPath, cwd) {
  const absolute = path.posix.normalize(path.posix.isAbsolute(containerPath) ? containerPath : path.posix.join(cwd, containerPath));
  return absolute.startsWith("/repo/") ? absolute.slice("/repo/".length) : null;
}

function clangTruth() {
  const work = mkdtempSync(path.join(tmpdir(), "codeflow-ctruth-"));
  docker(
    work,
    `cmake -S /repo -B /out/build -G "Unix Makefiles" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ ${flag("--cmake") ?? ""} > /out/cmake.log 2>&1 || (tail -30 /out/cmake.log >&2; exit 1)`,
  );
  const commands = JSON.parse(readFileSync(path.join(work, "build", "compile_commands.json"), "utf8"));
  const extra = "-fsyntax-only -H -Xclang -header-include-format=json -Xclang -header-include-filtering=direct-per-file";
  const lines = ["#!/bin/sh", "mkdir -p /out/h"];
  commands.forEach((entry, index) => {
    const argv = entry.arguments ?? entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
    const kept = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === "-o") {
        i += 1;
        continue;
      }
      if (argv[i] === "-c" || argv[i].startsWith("-M")) continue;
      kept.push(argv[i]);
    }
    const quoted = kept.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    lines.push(`cd '${entry.directory}' && ${quoted} ${extra} 2> /out/h/${index}.txt; echo '${entry.directory}' > /out/h/${index}.cwd`);
  });
  writeFileSync(path.join(work, "run.sh"), `${lines.join("\n")}\n`);
  docker(work, "sh /out/run.sh > /dev/null 2>&1 || true");

  // file → every file its includes resolved to (repo-relative, or `outside:<absolute>`).
  const includes = new Map();
  const add = (from, target) => {
    const set = includes.get(from) ?? new Set();
    set.add(target);
    includes.set(from, set);
  };
  for (const name of readdirSync(path.join(work, "h"))) {
    if (!name.endsWith(".txt")) continue;
    const cwd = readFileSync(path.join(work, "h", name.replace(".txt", ".cwd")), "utf8").trim();
    for (const text of readFileSync(path.join(work, "h", name), "utf8").split("\n")) {
      const trimmed = text.trim();
      if (!trimmed.startsWith("[") && !trimmed.startsWith('{"version"')) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Two clang formats: `[{source, includes: [path]}]` and `{dependencies: [{source, includes: [{file}]}]}`.
      for (const dependency of Array.isArray(parsed) ? parsed : parsed.dependencies ?? []) {
        const from = inRepo(dependency.source, cwd);
        if (!from) continue;
        for (const include of dependency.includes ?? []) {
          const file = typeof include === "string" ? include : include.file;
          const target = inRepo(file, cwd);
          add(from, target ?? `outside:${path.posix.normalize(path.posix.isAbsolute(file) ? file : path.posix.join(cwd, file))}`);
        }
      }
    }
  }
  return {
    translationUnits: commands.length,
    includes: Object.fromEntries([...includes].map(([from, set]) => [from, [...set].sort()])),
  };
}

const truth = flag("--truth") ? JSON.parse(readFileSync(flag("--truth"), "utf8")) : clangTruth();
if (flag("--save-truth")) writeFileSync(flag("--save-truth"), JSON.stringify(truth));
const result = JSON.parse(readFileSync(path.resolve(resultArg), "utf8"));

const C_LANGS = new Set(["C", "C++"]);
const analysed = new Set((result.graph?.nodes ?? []).filter((n) => C_LANGS.has(n.language) && (n.layer === "source" || n.layer === "test")).map((n) => n.id));
const oursByFile = new Map();
for (const edge of result.graph?.edges ?? []) {
  const list = oursByFile.get(edge.from) ?? [];
  list.push(edge);
  oursByFile.set(edge.from, list);
}

const counts = { agree: 0, wrong: 0, missed: 0, unjudged: 0, files: 0 };
const samples = { wrong: [], missed: [], unjudged: [] };
const sample = (kind, value) => samples[kind].length < 10 && samples[kind].push(value);
const endsWithSpec = (target, spec) => {
  const clean = spec.replace(/^(\.\.?\/)+/, "");
  const bare = target.replace(/^outside:/, "");
  return bare === clean || bare.endsWith(`/${clean}`);
};
for (const [file, targets] of Object.entries(truth.includes)) {
  if (!analysed.has(file)) continue;
  counts.files += 1;
  const inRepoTargets = new Set(targets.filter((t) => !t.startsWith("outside:")));
  const mine = oursByFile.get(file) ?? [];
  const mineTargets = new Set(mine.map((edge) => edge.to));
  for (const edge of mine) {
    if (inRepoTargets.has(edge.to)) counts.agree += 1;
    else if (targets.some((t) => endsWithSpec(t, edge.specifier))) {
      counts.wrong += 1;
      sample("wrong", { file, include: edge.specifier, clang: targets.find((t) => endsWithSpec(t, edge.specifier)), codeflow: edge.to });
    } else {
      counts.unjudged += 1;
      sample("unjudged", { file, include: edge.specifier, codeflow: edge.to });
    }
  }
  for (const target of inRepoTargets) {
    if (target === file || mineTargets.has(target)) continue;
    counts.missed += 1;
    sample("missed", { file, clang: target });
  }
}

const judged = counts.agree + counts.wrong;
const truthEdges = counts.agree + counts.wrong + counts.missed;
const precision = judged ? counts.agree / judged : 1;
const recall = truthEdges ? counts.agree / truthEdges : 1;
const summary = {
  repo: result.repository?.name ?? path.basename(repo),
  language: "C/C++",
  translationUnits: truth.translationUnits,
  clangInRepoIncludes: truthEdges,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};
if (asJson) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`${summary.repo}: ${truth.translationUnits} translation units, ${counts.files} files the build opened, ${truthEdges} in-repo includes per clang`);
  console.log(`  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, wrong ${counts.wrong}, missed ${counts.missed}; ${counts.unjudged} edges in #if branches the build did not take)`);
  for (const kind of ["wrong", "missed", "unjudged"]) {
    for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file}  "${s.include}"  clang=${s.clang ?? "-"}  codeflow=${s.codeflow ?? "-"}`);
  }
}
