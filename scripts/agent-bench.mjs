#!/usr/bin/env node
/**
 * AGENT BENCHMARK — Claude Code alone vs Claude Code + the CodeFlow MCP server.
 *
 * Same model, same question, same read-only tools (Read, Grep, Glob) in both arms; the second arm
 * also has CodeFlow's graph tools over MCP. Questions are DEPENDENCY questions whose answer is a set
 * of files, and the truth comes from the COMPILER (the saved truth of scripts/accuracy/java.mjs or
 * c.mjs), not from CodeFlow — so CodeFlow is never grading itself.
 *
 *   dependents     "Which files directly depend on T?"   truth: the compiler's reverse edges of T
 *   dependencies   "Which files does F directly depend on?"  truth: the compiler's edges from F
 *
 * Graded per answer: precision and recall of the repo files named, and INVENTED paths (named, but not
 * in the repository). Measured per run: wall time, turns, input/output tokens, cost — read from
 * `claude -p --output-format json`.
 *
 * Runs are isolated: `--strict-mcp-config` (only the server given here), `--setting-sources project`
 * (no user hooks or plugins), `--no-session-persistence`, and no Bash/Edit/Write/web/subagents.
 *
 * USAGE
 *   node scripts/agent-bench.mjs --repo <path> --result <analysis.json> --truth <truth.json>
 *        [--questions 6] [--model sonnet] [--arms claude,codeflow] [--out dir] [--dry-run]
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const repo = path.resolve(arg("--repo"));
const resultPath = path.resolve(arg("--result"));
const truthPath = path.resolve(arg("--truth"));
const QUESTIONS = Number(arg("--questions", "6"));
const MODEL = arg("--model", "sonnet");
const ARMS = arg("--arms", "claude,codeflow").split(",");
const OUT = path.resolve(arg("--out", path.join(repo, ".codeflow", "agent-bench")));
const DRY = process.argv.includes("--dry-run");
const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.resolve(here, "../apps/mcp/dist/index.js");

// ── Truth: file → in-repo files it depends on, from a saved compiler truth ──────────────────────
const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const forward = new Map();
if (truth.edges) {
  for (const [from, targets] of Object.entries(truth.edges)) forward.set(from, new Set(targets.filter((t) => t !== from)));
} else if (truth.includes) {
  for (const [from, targets] of Object.entries(truth.includes)) {
    forward.set(from, new Set(targets.filter((t) => !t.startsWith("outside:") && t !== from)));
  }
} else {
  throw new Error("unsupported truth file: expected a Java (`edges`) or C/C++ (`includes`) truth");
}
const reverse = new Map();
for (const [from, targets] of forward) for (const to of targets) (reverse.get(to) ?? reverse.set(to, new Set()).get(to)).add(from);

const result = JSON.parse(readFileSync(resultPath, "utf8"));
const repoFiles = new Set((result.graph?.nodes ?? []).map((node) => node.id));

// ── Questions: deterministic picks of mid-sized answers (3–12 files) ─────────────────────────────
function pick(map, kind, count) {
  const candidates = [...map]
    .filter(([file, set]) => repoFiles.has(file) && set.size >= 3 && set.size <= 12)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const chosen = [];
  // Even spacing through the sorted list: deterministic, and not all from one directory.
  for (let i = 0; i < count && candidates.length; i += 1) chosen.push(candidates[Math.floor(((i + 0.5) * candidates.length) / count)]);
  return chosen.map(([file, set]) => ({
    id: `${kind}:${file}`,
    kind,
    file,
    truth: [...set].sort(),
    prompt:
      kind === "dependents"
        ? `In this repository, which files directly depend on \`${file}\` — they include or import it, or use a type, function or macro declared in it? Answer with a bullet list of repo-relative file paths only, nothing else.`
        : `In this repository, which other repository files does \`${file}\` directly depend on — files it includes or imports, or whose types, functions or macros it uses? Answer with a bullet list of repo-relative file paths only, nothing else.`,
  }));
}
const questions = [...pick(reverse, "dependents", Math.ceil(QUESTIONS / 2)), ...pick(forward, "dependencies", Math.floor(QUESTIONS / 2))];

// ── Running one question in one arm ──────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const mcpConfigPath = path.join(OUT, "codeflow-mcp.json");
writeFileSync(
  mcpConfigPath,
  JSON.stringify({
    mcpServers: {
      codeflow: {
        command: process.execPath,
        args: [MCP_ENTRY],
        env: { CODEFLOW_MCP_RESULT: resultPath, CODEFLOW_MCP_SCOPES: "graph,verify" },
      },
    },
  }),
);
const emptyMcpPath = path.join(OUT, "no-mcp.json");
writeFileSync(emptyMcpPath, JSON.stringify({ mcpServers: {} }));

const CODEFLOW_NOTE =
  "A CodeFlow MCP server is connected. It holds this repository's resolved dependency and call graph " +
  "(find_references, get_callers, find_usages, get_blast_radius, symbol_search, graph_facts, verify_citations). " +
  "Use it for dependency questions instead of reading files one by one.";

function runClaude(question, arm) {
  const argv = [
    "-p", question.prompt,
    "--output-format", "json",
    "--model", MODEL,
    "--strict-mcp-config",
    "--mcp-config", arm === "codeflow" ? mcpConfigPath : emptyMcpPath,
    "--setting-sources", "project",
    "--no-session-persistence",
    "--allowedTools", ...(arm === "codeflow" ? ["Read", "Grep", "Glob", "mcp__codeflow"] : ["Read", "Grep", "Glob"]),
    "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit",
    ...(arm === "codeflow" ? ["--append-system-prompt", CODEFLOW_NOTE] : []),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    execFile("claude", argv, { cwd: repo, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 }, (error, stdout) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      resolve({ wallMs: Date.now() - started, error: error && !parsed ? String(error.message).slice(0, 300) : null, json: parsed });
    });
  });
}

// ── Grading ──────────────────────────────────────────────────────────────────────────────────────
const fileList = [...repoFiles];
function namedFiles(text) {
  const named = new Set();
  const invented = new Set();
  for (const raw of text.match(/[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@+-]+\.[A-Za-z]{1,5}\b/g) ?? []) {
    const candidate = raw.replace(/^\.\//, "").replace(/[.,:;)]+$/, "");
    if (!/\.[A-Za-z]{1,5}$/.test(candidate)) continue;
    if (repoFiles.has(candidate)) named.add(candidate);
    else {
      const matches = fileList.filter((file) => file.endsWith(`/${candidate}`));
      if (matches.length === 1) named.add(matches[0]);
      else if (matches.length === 0) invented.add(candidate);
    }
  }
  return { named: [...named], invented: [...invented] };
}

function grade(question, answer) {
  const { named, invented } = namedFiles(answer);
  const expected = new Set(question.truth);
  const hit = named.filter((file) => expected.has(file)).length;
  return {
    named: named.length,
    precision: named.length ? hit / named.length : 0,
    recall: expected.size ? hit / expected.size : 1,
    invented,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────
console.log(`${questions.length} question(s) on ${path.basename(repo)}; arms: ${ARMS.join(", ")}; model: ${MODEL}`);
if (DRY) {
  for (const question of questions) console.log(`- [${question.kind}] ${question.file} → ${question.truth.length} file(s)`);
  process.exit(0);
}

const rows = [];
for (const question of questions) {
  for (const arm of ARMS) {
    const run = await runClaude(question, arm);
    const json = run.json ?? {};
    const answer = typeof json.result === "string" ? json.result : "";
    const graded = grade(question, answer);
    const usage = json.usage ?? {};
    const row = {
      question: question.id,
      arm,
      ok: !run.error && !json.is_error,
      wallMs: run.wallMs,
      turns: json.num_turns ?? null,
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? null,
      costUsd: json.total_cost_usd ?? null,
      ...graded,
      error: run.error,
    };
    rows.push(row);
    writeFileSync(path.join(OUT, `${rows.length}-${arm}.json`), JSON.stringify({ question, run: json, row }, null, 2));
    console.log(
      `${arm.padEnd(9)} ${question.id.slice(0, 60).padEnd(60)} P ${row.precision.toFixed(2)} R ${row.recall.toFixed(2)} ` +
        `invented ${row.invented.length}  ${(row.wallMs / 1000).toFixed(0)}s  turns ${row.turns}  $${row.costUsd?.toFixed(3) ?? "?"}`,
    );
  }
}

const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const summary = Object.fromEntries(
  ARMS.map((arm) => {
    const mine = rows.filter((row) => row.arm === arm);
    return [
      arm,
      {
        runs: mine.length,
        failures: mine.filter((row) => !row.ok).length,
        meanPrecision: mean(mine.map((row) => row.precision)),
        meanRecall: mean(mine.map((row) => row.recall)),
        inventedPaths: mine.reduce((sum, row) => sum + row.invented.length, 0),
        medianSeconds: median(mine.map((row) => row.wallMs / 1000)),
        medianTurns: median(mine.map((row) => row.turns)),
        medianInputTokens: median(mine.map((row) => row.inputTokens)),
        totalCostUsd: mine.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      },
    ];
  }),
);
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ repo: path.basename(repo), model: MODEL, questions: questions.length, summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
