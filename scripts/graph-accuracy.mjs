#!/usr/bin/env node
/**
 * GRAPH ACCURACY vs THE TYPESCRIPT COMPILER — the import graph, scored against ground truth.
 *
 * For every JS/TS file CodeFlow analysed, the TypeScript compiler lists the module specifiers
 * (`ts.preProcessFile`: import, export-from, require, dynamic import, `import type`) and resolves each
 * with `ts.resolveModuleName` under the NEAREST tsconfig/jsconfig — exactly what `tsc` would do. Each
 * (file, specifier) pair is then compared with CodeFlow's edge for the same pair:
 *
 *   agree        both resolve it to the same repository file
 *   wrong        both resolve it, to DIFFERENT files                         (precision error)
 *   missed       tsc resolves it to a repo source file, CodeFlow has no edge (recall error)
 *   extra        CodeFlow has an edge, tsc resolves it to nothing in-repo     (reported, with samples)
 *
 * Ground truth is restricted to targets that are repository SOURCE files: a resolution into
 * node_modules or into a build directory (dist/) is not an edge CodeFlow should draw. "extra" is
 * printed with samples rather than silently counted as an error, because the common case is a
 * workspace package whose dist/ was never built in this checkout — tsc cannot resolve it, CodeFlow
 * maps it to src/ — and a reader should judge those, not a number.
 *
 * USAGE
 *   node apps/local-cli/dist/index.js analyze <repo> --no-index --out /tmp/r.json
 *   node scripts/graph-accuracy.mjs <repo> /tmp/r.json [--json]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const [repoArg, resultArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const asJson = process.argv.includes("--json");
if (!repoArg || !resultArg) {
  console.error("usage: graph-accuracy.mjs <repo-path> <analysis-result.json> [--json]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const result = JSON.parse(await readFile(path.resolve(resultArg), "utf8"));

const JS_LANGS = new Set(["TypeScript", "JavaScript"]);
const BUILD_DIR = /(^|\/)(dist|build|out|lib\/esm|lib\/cjs)\//;
const nodes = result.graph?.nodes ?? [];
const nodeIds = new Set(nodes.map((n) => n.id));
const files = nodes.filter((n) => JS_LANGS.has(n.language) && (n.layer === "source" || n.layer === "test")).map((n) => n.id);

const codeflow = new Map();
for (const edge of result.graph?.edges ?? []) codeflow.set(`${edge.from}\u0000${edge.specifier}`, edge.to);

const configCache = new Map();
function optionsFor(absFile) {
  const configPath =
    ts.findConfigFile(path.dirname(absFile), ts.sys.fileExists, "tsconfig.json") ??
    ts.findConfigFile(path.dirname(absFile), ts.sys.fileExists, "jsconfig.json");
  if (configPath && !configPath.startsWith(repo)) return defaults();
  if (!configPath) return defaults();
  if (!configCache.has(configPath)) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(configPath));
    configCache.set(configPath, { allowJs: true, resolveJsonModule: true, ...parsed.options });
  }
  return configCache.get(configPath);
}
function defaults() {
  return {
    allowJs: true,
    resolveJsonModule: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
}

const counts = { agree: 0, wrong: 0, missed: 0, extra: 0, pairs: 0 };
const samples = { wrong: [], missed: [], extra: [] };
const sample = (kind, value) => samples[kind].length < 8 && samples[kind].push(value);

for (const file of files) {
  const abs = path.join(repo, file);
  let content;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    continue;
  }
  const options = optionsFor(abs);
  const specifiers = new Set(ts.preProcessFile(content, true, true).importedFiles.map((f) => f.fileName));
  for (const specifier of specifiers) {
    counts.pairs += 1;
    const resolved = ts.resolveModuleName(specifier, abs, options, ts.sys).resolvedModule;
    let truth = null;
    if (resolved && !resolved.isExternalLibraryImport) {
      const real = ts.sys.realpath ? ts.sys.realpath(resolved.resolvedFileName) : resolved.resolvedFileName;
      const relative = path.relative(repo, real).split(path.sep).join("/");
      if (!relative.startsWith("..") && !relative.includes("node_modules/") && !BUILD_DIR.test(relative) && nodeIds.has(relative)) {
        truth = relative;
      }
    }
    const ours = codeflow.get(`${file}\u0000${specifier}`) ?? null;
    if (truth && ours) {
      if (truth === ours) counts.agree += 1;
      else {
        counts.wrong += 1;
        sample("wrong", { file, specifier, tsc: truth, codeflow: ours });
      }
    } else if (truth) {
      counts.missed += 1;
      sample("missed", { file, specifier, tsc: truth });
    } else if (ours) {
      counts.extra += 1;
      sample("extra", { file, specifier, codeflow: ours });
    }
  }
}

const truthEdges = counts.agree + counts.wrong + counts.missed;
const ourEdgesJudged = counts.agree + counts.wrong;
const precision = ourEdgesJudged ? counts.agree / ourEdgesJudged : 1;
const recall = truthEdges ? counts.agree / truthEdges : 1;
const summary = {
  repo: result.repository?.name ?? path.basename(repo),
  filesChecked: files.length,
  specifiers: counts.pairs,
  tscInRepoEdges: truthEdges,
  ...counts,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  samples,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`${summary.repo}: ${files.length} JS/TS files, ${counts.pairs} specifiers, ${truthEdges} in-repo edges per tsc`);
  console.log(`  precision ${(precision * 100).toFixed(2)}%  recall ${(recall * 100).toFixed(2)}%  (agree ${counts.agree}, wrong ${counts.wrong}, missed ${counts.missed}, extra ${counts.extra})`);
  for (const kind of ["wrong", "missed", "extra"]) {
    for (const s of samples[kind]) console.log(`  ${kind.padEnd(6)} ${s.file}  "${s.specifier}"  tsc=${s.tsc ?? "-"}  codeflow=${s.codeflow ?? "-"}`);
  }
}
