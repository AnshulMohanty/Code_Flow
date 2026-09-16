// CLI: `pnpm eval <dataset.json> <analysisResult.json>` — loads an authored dataset + a
// stored AnalysisResult, builds the embedding client from env (the SAME provider selection
// the worker uses), scores, and prints the report. Exits non-zero if thresholds fail.
//
// This is a P7 DATA tool: it needs a real embedding key to embed the dataset's questions,
// so it is NOT exercised by the hermetic test suite (which drives runEval with fixtures and
// a mock client). It never runs the real analysis pipeline — it grades a result you already
// produced.

import { readFile } from "node:fs/promises";
import { createEmbeddingClientFromEnv } from "@codeflow/analyzers";
import type { AnalysisResult } from "@codeflow/shared-types";
import { assertDatasetShape } from "./dataset.js";
import { runEval } from "./runEval.js";

async function main(): Promise<void> {
  const [datasetPath, resultPath] = process.argv.slice(2);
  if (!datasetPath || !resultPath) {
    throw new Error("Usage: pnpm eval <dataset.json> <analysisResult.json>");
  }

  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as unknown;
  assertDatasetShape(dataset);
  const result = JSON.parse(await readFile(resultPath, "utf8")) as AnalysisResult;

  const embeddingClient = createEmbeddingClientFromEnv(process.env);
  if (!embeddingClient) {
    throw new Error(
      "No embedding provider configured. Set VOYAGE_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY (and EMBEDDING_PROVIDER if more than one).",
    );
  }

  const report = await runEval(dataset, result, embeddingClient);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n${report.summary}`);
  if (!report.thresholds.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown eval error.";
  console.error(`eval failed: ${message}`);
  process.exit(1);
});
