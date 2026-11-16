#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createMemoryFactsStore } from "@codeflow/parsers";
import { writeJsonFile } from "./jsonOut.js";
import path from "node:path";
import { buildReferenceIndex, formatVerificationReport, verifyReferences } from "@codeflow/analyzers";
import { analyzeLocal, queryLocal } from "./analyzeLocal.js";
import {
  changedFilesSince,
  checkoutToTemp,
  computeImpact,
  defaultBase,
  renderImpactMarkdown,
  isNotable,
  renderImpactText,
  selectTests,
  type ChangedFile,
} from "./impact.js";
import { checkRules, loadRules, RULES_FILE } from "./rules.js";
import { filesRunByPackageJson, findUnreferenced } from "./unused.js";

/**
 * `codeflow-local` — the LOCAL-FIRST CLI (V3-P5 task 4).
 *
 * Analyses a repository entirely on-device: `web-tree-sitter` WASM parsing, a keyless in-process
 * embedder, an embedded file-backed index, and the same graph/chunking/grounding code the hosted
 * pipeline uses. No API key, no network, no code leaves the machine.
 *
 * WHAT IT DOES NOT DO, stated up front rather than discovered: no AI SUMMARY. Synthesis needs an LLM
 * and there is no keyless local one, so a local run stops at a complete deterministic analysis plus a
 * searchable index. Everything that does not need a model — the graph, the metrics, the communities,
 * the cycles, and grounded retrieval — works offline.
 *
 *   codeflow-local analyze <repo-path> [--out result.json] [--no-index] [--no-cache] [--index-dir DIR]
 *   codeflow-local ask <repo-path> "<question>" [--index-dir DIR] [-k N]
 *   codeflow-local verify <repo-path> [text-file | -] [--text "…"] [--format text|markdown|json]
 *   codeflow-local impact <repo-path> [--base REF] [--files a,b] [--format text|markdown|json]
 */

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Tiny arg parser. No dependency for `--flag value` and `--flag=value`; a CLI framework for two
 *  commands would be more code than the commands. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }
    const name = token.replace(/^-+/, "");
    if (name.includes("=")) {
      const [key, ...rest] = name.split("=");
      flags[key] = rest.join("=");
      continue;
    }
    const next = argv[i + 1];
    // A following non-flag token is this flag's VALUE; otherwise the flag is boolean. That is what
    // lets `--no-index` and `--out result.json` both work without declaring a schema.
    if (next !== undefined && !next.startsWith("-")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

const USAGE = `codeflow-local — analyse a repository entirely on your machine (no key, no network).

  codeflow-local analyze <repo-path> [options]
      --out FILE          also write the AnalysisResult JSON here
      --index-dir DIR     where the searchable index lives (default <repo>/.codeflow)
      --no-index          deterministic analysis only; skip the searchable index
      --no-cache          parse every file (default: reuse unchanged files' parses from .codeflow/cache)

  codeflow-local ask <repo-path> "<question>" [options]
      --index-dir DIR     the index built by \`analyze\` (default <repo>/.codeflow)
      -k N                how many code chunks to return (default 5)

  codeflow-local verify <repo-path> [text-file | -] [options]
      Check every code reference in a piece of text — an agent's answer, a PR description, a review
      comment — against the repository: does the file exist, are the cited lines inside it, is the
      named symbol declared there? Reads the text from a file, from stdin ("-"), or from --text.
      --text "..."        the text to check, inline
      --format F          text (default) | markdown | json
      Exit code 1 when any reference is wrong.

  codeflow-local impact <repo-path> [options]
      What a change set touches: dependents (direct + transitive), entry points, tests that reach
      it, new import cycles and imports that resolve to nothing. Local git only — never fetches.
      --base REF          compare against REF's merge-base with HEAD (default origin/HEAD, main, master)
      --files a,b         use this file list instead of git
      --format F          text (default) | markdown (PR comment) | json
      --link-base URL     markdown only: prefix for file links (e.g. https://github.com/o/r/blob/SHA)
      --fail-on LIST      exit 1 on: new-cycle, broken-import, rule, untested (comma-separated)
      --quiet             print nothing unless there is a new cycle, a broken import, a rule
                          violation, or an untested change to a file 5+ files depend on

  codeflow-local check <repo-path> [--json]
      Architecture rules from codeflow.rules.json, checked against the resolved graph:
        { "rules": [ { "name": "web never imports the worker",
                       "from": "apps/web/**", "forbid": "apps/worker/**", "except": [] } ] }
      Exit code 1 on any violation. \`impact\` checks the same rules on a PR's changed files.

  codeflow-local unused <repo-path> [--json]
      Source files nothing in the repository imports, includes or calls (JS/TS, Python, C/C++
      headers), excluding entry points and files tools load by convention. A list to review —
      a dynamically loaded file is invisible to a static graph.

  codeflow-local tests <repo-path> [--base REF | --files a,b] [--json]
      The test files a change set can affect, one per line — for \`vitest run $(...)\`, \`go test\`,
      \`pytest\`. Every test whose import closure reaches a changed file, every changed test, and Go
      package tests. A change the graph cannot trace (package.json, a lockfile, a config, CI) selects
      EVERY test and says why on stderr: skipping a failing test is worse than running one more.

WHAT YOU GET, and what you do not:
  ✓ dependency graph, centrality, cycles, communities, symbols, entry points  — all offline
  ✓ grounded search over your code                                            — lexical, offline
  ✗ AI summary / reading order    — needs a model; there is no keyless local one
  ✗ semantic search               — the local embedder matches WORDS, not meaning

Nothing is uploaded. No API key is read. The published bundle contains no network client at all, and
it is shipped unminified so you can read it yourself rather than take that on trust.`;

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (!command || command === "help" || flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "analyze") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("analyze needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const analysis = await analyzeLocal({
      repoPath,
      ...(typeof flags["index-dir"] === "string" ? { indexDir: flags["index-dir"] } : {}),
      skipIndex: flags["no-index"] === true,
      ...(flags["no-cache"] === true ? { factsCache: false as const } : {}),
      onProgress: (message) => console.log(message),
    });

    const metrics = analysis.result.metrics;
    console.log("");
    console.log(`files:        ${analysis.result.graph?.nodes.length ?? 0}`);
    console.log(`dependencies: ${analysis.result.graph?.edges.length ?? 0}`);
    console.log(`symbols:      ${analysis.result.inventory?.symbolCount ?? 0}`);
    console.log(`cycles:       ${metrics?.cycles.length ?? 0}`);
    console.log(
      `communities:  ${metrics?.clusters ? `${metrics.clusters.count} (modularity ${metrics.clusters.modularity.toFixed(3)})` : "not computed"}`,
    );
    const entryPoints = (analysis.result.entryPoints ?? []).map((entry) => entry.fileId);
    console.log(
      `entry points: ${entryPoints.length === 0 ? "none detected" : `${entryPoints.slice(0, 6).join(", ")}${entryPoints.length > 6 ? ` (+${entryPoints.length - 6} more)` : ""}`}`,
    );
    console.log(`indexed:      ${analysis.chunkCount} chunk(s)${analysis.chunkCount ? ` in ${analysis.indexDir}` : ""}`);
    for (const warning of analysis.warnings) console.log(`warning:      ${warning}`);
    // Said every time, not once in a README: the absence of a summary is the one thing a user of the
    // hosted product would expect and not get.
    console.log("note:         no AI summary in local mode (no keyless local LLM). Everything above is deterministic.");

    if (typeof flags.out === "string") {
      writeJsonFile(path.resolve(flags.out), analysis.result);
      console.log(`wrote:        ${flags.out}`);
    }
    return 0;
  }

  if (command === "ask") {
    const repoPath = positional[0];
    const question = positional.slice(1).join(" ");
    if (!repoPath || !question) {
      console.error('ask needs a <repo-path> and a "<question>".\n');
      console.error(USAGE);
      return 1;
    }
    // Re-analysing to get the index METADATA rather than persisting it: the vectors and text are on
    // disk, but the chunk metadata lives in the AnalysisResult, and a local run is fast enough that
    // recomputing it beats maintaining a second on-disk format that could drift from the index.
    const analysis = await analyzeLocal({
      repoPath,
      ...(typeof flags["index-dir"] === "string" ? { indexDir: flags["index-dir"] } : {}),
      onProgress: () => {},
    });
    const answer = await queryLocal({
      result: analysis.result,
      indexDir: analysis.indexDir,
      question,
      ...(typeof flags.k === "string" ? { k: Number(flags.k) } : {}),
    });

    if (answer.refused || answer.chunks.length === 0) {
      // The similarity-floor refusal, unchanged offline. "Nothing here is relevant" is a real answer.
      console.log(`No indexed code in this repository is relevant to that (best match ${answer.topScore.toFixed(3)}).`);
      return 0;
    }
    for (const chunk of answer.chunks) {
      console.log(`\n--- ${chunk.fileId}:${chunk.startLine}-${chunk.endLine}`);
      console.log(chunk.text);
    }
    console.log("\nnote: local mode returns the GROUNDED CODE, not prose — there is no local LLM to summarise it.");
    return 0;
  }

  if (command === "verify") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("verify needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const text =
      typeof flags.text === "string"
        ? flags.text
        : positional[1] === "-" || (!positional[1] && !process.stdin.isTTY)
          ? await readStdin()
          : positional[1]
            ? await readFile(path.resolve(positional[1]), "utf8")
            : undefined;
    if (text === undefined) {
      console.error('verify needs the text to check: a file, "-" for stdin, or --text "...".');
      return 1;
    }
    const analysis = await analyzeLocal({ repoPath, skipIndex: true, onProgress: () => {} });
    const root = path.resolve(repoPath);
    const index = buildReferenceIndex(analysis.result, async (relative) => {
      // Only paths the analysis discovered reach here (buildReferenceIndex checks), so no traversal.
      const content = await readFile(path.join(root, relative), "utf8").catch(() => null);
      return content === null ? undefined : content.split(/\r\n|\r|\n/).length - (content.endsWith("\n") ? 1 : 0);
    });
    const report = await verifyReferences(text, index);
    const format = typeof flags.format === "string" ? flags.format : "text";
    console.log(format === "json" ? JSON.stringify(report, null, 2) : formatVerificationReport(report, format === "markdown" ? "markdown" : "text"));
    return report.fail > 0 ? 1 : 0;
  }

  if (command === "tests") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("tests needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const root = path.resolve(repoPath);
    let changed: ChangedFile[];
    if (typeof flags.files === "string") {
      changed = flags.files.split(",").map((file) => file.trim()).filter(Boolean).map((file) => ({ path: file, status: "modified" as const }));
    } else {
      const base = typeof flags.base === "string" ? flags.base : await defaultBase(root);
      if (!base) {
        console.error("tests: no --base given and none of origin/HEAD, origin/main, origin/master, main, master exists.");
        return 1;
      }
      changed = await changedFilesSince(root, base);
    }
    const head = await analyzeLocal({ repoPath: root, skipIndex: true, onProgress: () => {} });
    const selection = selectTests(head.result, changed);
    if (flags.json === true) {
      console.log(JSON.stringify({ changed: changed.map((file) => file.path), ...selection }, null, 2));
    } else {
      if (selection.all) console.error(`tests: running ALL ${selection.tests.length} test file(s) — ${selection.reason}`);
      else console.error(`tests: ${selection.tests.length} test file(s) reach ${changed.length} changed file(s)`);
      for (const test of selection.tests) console.log(test);
    }
    return 0;
  }

  if (command === "impact") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("impact needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const root = path.resolve(repoPath);
    let changed: ChangedFile[];
    let base: string | undefined;
    if (typeof flags.files === "string") {
      changed = flags.files.split(",").map((file) => file.trim()).filter(Boolean).map((file) => ({ path: file, status: "modified" as const }));
    } else {
      base = typeof flags.base === "string" ? flags.base : await defaultBase(root);
      if (!base) {
        console.error("impact: no --base given and none of origin/HEAD, origin/main, origin/master, main, master exists.");
        return 1;
      }
      changed = await changedFilesSince(root, base);
    }

    // One in-memory parse cache for both sides: every file the PR did not touch is parsed once.
    const shared = createMemoryFactsStore();
    const head = await analyzeLocal({ repoPath: root, skipIndex: true, factsCache: shared, onProgress: () => {} });
    let baseResult;
    if (base) {
      try {
        const checkout = await checkoutToTemp(root, base);
        try {
          baseResult = (await analyzeLocal({ repoPath: checkout.dir, skipIndex: true, factsCache: shared, onProgress: () => {} })).result;
        } finally {
          await checkout.cleanup();
        }
      } catch (error) {
        console.error(`impact: could not analyse base ${base} (${error instanceof Error ? error.message : String(error)}); new-cycle check skipped.`);
      }
    }
    const { rules, errors: ruleErrors } = await loadRules(root);
    if (ruleErrors.length) {
      for (const error of ruleErrors) console.error(`impact: ${error}`);
      return 1;
    }
    const report = computeImpact(head.result, changed, {
      ...(base ? { base } : {}),
      ...(baseResult ? { baseResult } : {}),
      rules,
    });
    const format = typeof flags.format === "string" ? flags.format : "text";
    // --quiet: say nothing unless something needs a human (see isNotable). A bot that always talks gets muted.
    const silent = flags.quiet === true && !isNotable(report);
    if (silent) {
      if (format === "json") console.log(JSON.stringify({ notable: false }));
    } else if (format === "json") console.log(JSON.stringify(report, null, 2));
    else if (format === "markdown") {
      console.log(renderImpactMarkdown(report, typeof flags["link-base"] === "string" ? { linkBase: flags["link-base"].replace(/\/$/, "") } : {}));
    } else console.log(renderImpactText(report));

    const failOn = new Set(typeof flags["fail-on"] === "string" ? flags["fail-on"].split(",").map((v) => v.trim()) : []);
    const failed =
      (failOn.has("new-cycle") && (report.newCycles?.length ?? 0) > 0) ||
      (failOn.has("broken-import") && report.brokenImports.length > 0) ||
      (failOn.has("rule") && report.ruleViolations.length > 0) ||
      (failOn.has("untested") && report.untested.length > 0);
    return failed ? 1 : 0;
  }

  if (command === "check") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("check needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const root = path.resolve(repoPath);
    const { rules, errors } = await loadRules(root);
    if (errors.length) {
      for (const error of errors) console.error(`check: ${error}`);
      return 1;
    }
    if (!rules.length) {
      console.error(`check: no rules — add a ${RULES_FILE} at the repository root (see \`codeflow-local help\`).`);
      return 1;
    }
    const head = await analyzeLocal({ repoPath: root, skipIndex: true, onProgress: () => {} });
    const violations = checkRules(head.result, rules);
    if (flags.json === true) console.log(JSON.stringify({ rules: rules.length, violations }, null, 2));
    else {
      console.log(`${rules.length} rule(s), ${violations.length} violation(s)`);
      for (const violation of violations) console.log(`  ${violation.rule}: ${violation.from} → ${violation.to}  (${violation.specifier})`);
    }
    return violations.length ? 1 : 0;
  }

  if (command === "unused") {
    const repoPath = positional[0];
    if (!repoPath) {
      console.error("unused needs a <repo-path>.\n");
      console.error(USAGE);
      return 1;
    }
    const root = path.resolve(repoPath);
    const head = await analyzeLocal({ repoPath: root, skipIndex: true, onProgress: () => {} });
    const nodeIds = (head.result.graph?.nodes ?? []).map((node) => node.id);
    const manifests: Array<{ path: string; json: Record<string, unknown> }> = [];
    for (const id of nodeIds.filter((file) => file === "package.json" || file.endsWith("/package.json"))) {
      try {
        manifests.push({ path: id, json: JSON.parse(await readFile(path.join(root, id), "utf8")) as Record<string, unknown> });
      } catch {
        // An unreadable manifest names nothing; the report just cannot use it.
      }
    }
    const { files, judged } = findUnreferenced(head.result, filesRunByPackageJson(manifests, new Set(nodeIds)));
    if (flags.json === true) console.log(JSON.stringify({ judged, unreferenced: files }, null, 2));
    else {
      console.log(`${files.length} of ${judged} judged source file(s) are imported, included or called by nothing in the repository:`);
      for (const file of files) console.log(`  ${file.path}  (${file.lines} lines)`);
      console.log(
        "\nCheck before deleting: a computed dynamic import, a plugin loaded by name, or a file another repository " +
          "imports is invisible to a static graph. Java/C#/Go and C/C++ source files are not judged per file.",
      );
    }
    return 0;
  }

  console.error(`Unknown command "${command}".\n`);
  console.error(USAGE);
  return 1;
}

/**
 * Run only when INVOKED, not when imported.
 *
 * Without this guard, a test importing `parseArgs` from here would execute `main()` as a side effect
 * of the import — which is exactly what happened the first time, and it surfaced as
 * "process.exit unexpectedly called with 1" rather than as anything that named the cause.
 *
 * THE SEPARATOR IS NORMALISED FIRST, and that is not a nicety. `process.argv[1]` uses the PLATFORM
 * separator, so on Windows this path is delimited by backslashes — and the original pattern's
 * character class matched only a forward slash. The guard was therefore ALWAYS FALSE on Windows, and
 * `codeflow-local` exited 0 with NO OUTPUT on every Windows machine: not an error, not a usage
 * message, nothing. A silent no-op is the worst way for an entrypoint guard to fail, because nothing
 * looks wrong — and it is invisible to a POSIX-only CI.
 *
 * THE FIRST FIX FOR THAT WAS ITSELF PLATFORM-DEPENDENT, which is the more interesting bug. It split on
 * `path.sep`, and `path.sep` describes the HOST, not the string: on Linux it is "/", so a Windows-style
 * argv path passed straight through with its backslashes intact. The result was a normaliser that
 * worked only where normalisation was already unnecessary — green on a Windows laptop, red on the
 * Linux CI runner. The normalisation is now unconditional (see `normalizeEntryPath`), so the guard
 * reads the string it was given instead of inferring anything from the platform underneath it.
 *
 * Built with `new RegExp` over a normalised path rather than a literal, so the pattern needs no
 * escape sequences at all and cannot regress into the same class of bug.
 *
 * THREE ENTRYPOINTS, because there are three ways this file legitimately becomes `argv[1]`:
 *   - `src/index.ts`   — `pnpm dev:local`, via tsx
 *   - `dist/index.js`  — the tsc output, inside the workspace
 *   - `codeflow-local.mjs` — the PUBLISHED bundle, which is what `npx codeflow-local` runs
 *
 * The third was missed on the first pass and the symptom was identical to the Windows bug above:
 * the bundle ran, matched nothing, and exited 0 in silence. Anything narrower than this ships a CLI
 * that works everywhere except where users actually run it.
 */
const ENTRY_PATTERN = new RegExp("(?:local-cli/(?:dist|src)/index[.](?:js|ts)|codeflow-local(?:[.]mjs)?)$");

/**
 * `process.argv[1]` with EVERY backslash turned into "/", on every platform. Exported for the test.
 *
 * Deliberately NOT `path.sep`. `path.sep` is whatever the RUNNING host uses, so on Linux it is "/"
 * and splitting on it leaves a backslash-delimited path completely untouched — the normaliser became
 * a no-op on exactly the platform that needed it least and the CI that needed it most. A backslash is
 * never a legal character in a POSIX path segment here, so rewriting it unconditionally is safe in
 * both directions and makes the guard depend on the STRING it was handed rather than on the OS it
 * happens to be running under.
 *
 * `BACKSLASH` is spelled by char code for the same reason the test does it: this function exists to
 * fix an escaping bug, and it should not be able to be defeated by one.
 */
const BACKSLASH = String.fromCharCode(92);

export function normalizeEntryPath(argvPath: string | undefined): string {
  return (argvPath ?? "").split(BACKSLASH).join("/");
}

/** True when this module is the process entrypoint rather than an import. Exported for the test. */
export function isDirectInvocation(argvPath: string | undefined): boolean {
  return ENTRY_PATTERN.test(normalizeEntryPath(argvPath));
}

const invokedDirectly = isDirectInvocation(process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(`codeflow-local failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
