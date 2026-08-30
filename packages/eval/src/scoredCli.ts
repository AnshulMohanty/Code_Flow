// CLI: `pnpm --filter @codeflow/eval run eval:scored` — the OUT-OF-BAND scored eval.
//
// This is the run that needs real keys and spends money, which is why it is not in the
// per-push CI (see .github/workflows/eval-scored.yml). It grades every authored golden
// dataset on ALL THREE axes: retrieval (recall@k / MRR), the ANSWER path (citation validity,
// relevance, justified vs unjustified refusals) and — advisory until calibrated —
// faithfulness from an LLM judge.
//
// INPUT IT DOES NOT PRODUCE ITSELF: an `AnalysisResult` per dataset, at
// `packages/eval/results/<dataset>.json`. Producing one means cloning the pinned SHA and
// running the full pipeline including the AI stages, which is a worker concern (the cloner,
// the queue, the provider wiring all live in apps/worker) and needs the owner's key. Rather
// than duplicate that machinery here, this CLI fails with the exact instruction — grading a
// result you already produced is the same contract `pnpm eval` has always had.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AnalysisCacheHandle, AnalysisResult } from "@codeflow/shared-types";
import {
  answerQuestion,
  createEmbeddingClientFromEnv,
  createInMemoryBudgetHandle,
  createLlmClientFromEnv,
} from "@codeflow/analyzers";
import { RAG_TOP_K } from "@codeflow/config";
import { loadGoldenDatasets, type LoadedDataset } from "./datasets.js";
import { buildJudgePrompt, parseJudgeVerdict, JUDGE_SYSTEM_PROMPT, type Judge } from "./judge.js";
import { runEval, type AnswerRunner, type EvalReport } from "./runEval.js";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function memCache(): AnalysisCacheHandle {
  const store = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string) {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set<T = unknown>(key: string, value: T) {
      store.set(key, value);
    },
  };
}

async function main(): Promise<void> {
  const root = packageRoot();
  const requested = (process.env.EVAL_DATASET ?? "all").trim();
  const failOnThreshold = process.env.EVAL_FAIL_ON_THRESHOLD === "true";

  const all = await loadGoldenDatasets();
  const datasets = requested === "all" ? all : all.filter((entry) => entry.name === requested);
  if (datasets.length === 0) {
    throw new Error(`No dataset matched "${requested}". Available: ${all.map((entry) => entry.name).join(", ") || "(none)"}`);
  }

  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  if (!embeddingClient) {
    throw new Error("No embedding provider configured. Set VOYAGE_API_KEY or GEMINI_API_KEY (and EMBEDDING_PROVIDER if both).");
  }
  const chatClient = createLlmClientFromEnv(process.env);
  if (!chatClient) {
    // The answer path and the judge both need chat. Without it this would silently degrade to
    // the retrieval-only eval, which is exactly the "looks like it ran" trap V3-P0 removes.
    throw new Error("No chat provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY (and LLM_PROVIDER if both).");
  }

  const reportsDir = path.join(root, "reports");
  await mkdir(reportsDir, { recursive: true });

  const reports: Array<{ name: string; report: EvalReport }> = [];
  for (const entry of datasets) {
    const result = await loadAnalysisResult(root, entry);
    const report = await runEval(entry.dataset, result, embeddingClient, {
      answer: makeAnswerRunner(entry, result, embeddingClient, chatClient),
      judge: makeJudge(chatClient),
      // No human labels are shipped yet, so the judge stays ADVISORY by construction: it is
      // reported and cannot fail a threshold. Authoring labels is what promotes it to a gate.
      judgeLabels: undefined,
    });
    reports.push({ name: entry.name, report });

    await writeFile(path.join(reportsDir, `${entry.name}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n=== ${entry.name} ===\n${report.summary}`);
    if (report.thresholds.failures.length) {
      for (const failure of report.thresholds.failures) console.log(`  threshold miss: ${failure}`);
    }
    if (report.judgeGate.gateable === false && report.judgeFaithfulness !== null) {
      console.log(`  judge is ADVISORY (${report.judgeGate.reasons.join("; ")}) — it did not affect pass/fail.`);
    }
  }

  const summaryPath = path.join(reportsDir, "summary.md");
  await writeFile(summaryPath, renderSummary(reports), "utf8");
  console.log(`\nwrote ${reports.length} report(s) + ${summaryPath}`);
  console.log(
    "\nNEXT: thresholds in packages/eval/src/thresholds.ts are PLACEHOLDERS. Calibrate them from\n" +
      "the numbers above, then re-run with fail-on-threshold enabled.",
  );

  if (failOnThreshold && reports.some((entry) => !entry.report.thresholds.passed)) {
    process.exitCode = 1;
  }
}

/** Load the pre-produced AnalysisResult, with an actionable error when it is absent. */
async function loadAnalysisResult(root: string, entry: LoadedDataset): Promise<AnalysisResult> {
  const file = path.join(root, "results", `${entry.name}.json`);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) {
    throw new Error(
      `Missing ${path.relative(process.cwd(), file)}.\n` +
        `Produce it by running the full pipeline (including the AI stages) against\n` +
        `  ${entry.dataset.repoUrl} @ ${entry.dataset.commitSha}\n` +
        `and saving the resulting AnalysisResult JSON there. The index MUST be built in the\n` +
        `dataset's embedding space (${entry.dataset.embeddingModel} / dim ${entry.dataset.embeddingDim}) — the runner\n` +
        `refuses to score across two embedding spaces.`,
    );
  }
  return JSON.parse(raw) as AnalysisResult;
}

/**
 * Drive the PRODUCTION answer path (`answerQuestion`) so the eval grades what users get —
 * same retrieval, same grounding, same refusal floor — rather than a re-implementation.
 */
function makeAnswerRunner(
  entry: LoadedDataset,
  result: AnalysisResult,
  embeddingClient: NonNullable<ReturnType<typeof createEmbeddingClientFromEnv>>,
  chatClient: NonNullable<ReturnType<typeof createLlmClientFromEnv>>,
): AnswerRunner {
  const ragIndex = result.ai?.rag;
  if (!ragIndex) {
    throw new Error(`${entry.name}: the AnalysisResult has no ai.rag index — the RAG stage did not run.`);
  }
  const cache = memCache();
  const budget = createInMemoryBudgetHandle();

  return async (question: string) => {
    const answer = await answerQuestion({
      question,
      ragIndex,
      chatClient,
      embeddingClient,
      cache,
      budget,
      commitSha: result.commitSha,
      k: RAG_TOP_K,
    });
    // Recover the chunk objects the answer was built from, so citation validity is checked
    // against exactly what the model could legitimately have seen.
    const byId = new Map(ragIndex.chunks.map((chunk) => [chunk.id, chunk]));
    const retrieved = answer.retrievedChunkIds
      .map((id) => byId.get(id))
      .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk));
    return { answer, retrieved };
  };
}

/** An LLM judge over the shared prompt. One wording for every caller — a judge re-worded
 *  per caller is not the judge that was calibrated. */
function makeJudge(chatClient: NonNullable<ReturnType<typeof createLlmClientFromEnv>>): Judge {
  return async (request) => {
    const completed = await chatClient.complete({
      cachePrefix: JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(request),
      temperature: 0,
    });
    return parseJudgeVerdict(completed.text);
  };
}

function renderSummary(reports: Array<{ name: string; report: EvalReport }>): string {
  const lines = ["# Scored eval report", ""];
  for (const { name, report } of reports) {
    lines.push(`## ${name}`);
    lines.push("");
    lines.push(`- repo: ${report.repoUrl} @ \`${report.commitSha}\``);
    lines.push(`- space: ${report.embeddingModel} / dim ${report.embeddingDim}`);
    lines.push(`- synthesis recall@${report.synthesisScores.k}: ${report.synthesisScores.readingOrderRecallAtK.toFixed(3)}`);
    if (report.ragScores) {
      lines.push(
        `- retrieval recall@${report.ragScores.k}: ${report.ragScores.meanRecallAtK.toFixed(3)}, ` +
          `MRR ${report.ragScores.mrr.toFixed(3)} over ${report.ragScores.questionCount}q ` +
          `(+${report.ragScores.negativeControlCount} negative control(s), scored on the answer path)`,
      );
    }
    if (report.answerScores) {
      lines.push(
        `- answers: ${report.answerScores.answerRate.toFixed(3)} answered, ` +
          `citation validity ${report.answerScores.meanCitationValidity.toFixed(3)}, ` +
          `relevance ${report.answerScores.meanCitationRelevance.toFixed(3)}, ` +
          `refusals ${report.answerScores.justifiedRefusals} justified / ${report.answerScores.unjustifiedRefusals} not, ` +
          `${report.answerScores.totalDroppedCitations} dropped citation(s)`,
      );
    }
    if (report.judgeFaithfulness !== null) {
      lines.push(
        `- faithfulness (judge): ${report.judgeFaithfulness.toFixed(3)} — ` +
          `${report.judgeGate.gateable ? "GATING" : `ADVISORY: ${report.judgeGate.reasons.join("; ")}`}`,
      );
    }
    lines.push(`- thresholds: ${report.thresholds.passed ? "PASS" : `FAIL — ${report.thresholds.failures.join("; ")}`}`);
    lines.push("");
  }
  lines.push("> Thresholds are PLACEHOLDERS until calibrated from a run like this one.");
  lines.push("");
  return lines.join("\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown scored-eval error.";
  console.error(`scored eval failed: ${message}`);
  process.exit(1);
});
