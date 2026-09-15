#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeLocal, queryLocal } from "./analyzeLocal.js";

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
 *   codeflow-local analyze <repo-path> [--out result.json] [--no-index] [--index-dir DIR]
 *   codeflow-local ask <repo-path> "<question>" [--index-dir DIR] [-k N]
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
    if (!token.startsWith("-")) {
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

  codeflow-local ask <repo-path> "<question>" [options]
      --index-dir DIR     the index built by \`analyze\` (default <repo>/.codeflow)
      -k N                how many code chunks to return (default 5)

WHAT YOU GET, and what you do not:
  ✓ dependency graph, centrality, cycles, communities, symbols, entry points  — all offline
  ✓ grounded search over your code                                            — lexical, offline
  ✗ AI summary / reading order    — needs a model; there is no keyless local one
  ✗ semantic search               — the local embedder matches WORDS, not meaning

Nothing is uploaded. No API key is read. The published bundle contains no network client at all —
grep it for "fetch(" if you would rather check than trust.`;

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
    console.log(`entry points: ${(analysis.result.entryPoints ?? []).map((entry) => entry.fileId).join(", ") || "none detected"}`);
    console.log(`indexed:      ${analysis.chunkCount} chunk(s)${analysis.chunkCount ? ` in ${analysis.indexDir}` : ""}`);
    for (const warning of analysis.warnings) console.log(`warning:      ${warning}`);
    // Said every time, not once in a README: the absence of a summary is the one thing a user of the
    // hosted product would expect and not get.
    console.log("note:         no AI summary in local mode (no keyless local LLM). Everything above is deterministic.");

    if (typeof flags.out === "string") {
      await writeFile(path.resolve(flags.out), `${JSON.stringify(analysis.result, null, 2)}\n`, "utf8");
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
 * separator, so on Windows this path is delimited by backslashes — and the previous pattern's
 * character class matched only a forward slash. The guard was therefore ALWAYS FALSE on Windows, and
 * `codeflow-local` exited 0 with NO OUTPUT on every Windows machine: not an error, not a usage
 * message, nothing. A silent no-op is the worst way for an entrypoint guard to fail, because nothing
 * looks wrong — and it is invisible to a POSIX-only CI.
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

/** `process.argv[1]` with the platform separator normalised to "/". Exported for the test. */
export function normalizeEntryPath(argvPath: string | undefined): string {
  return (argvPath ?? "").split(path.sep).join("/");
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
