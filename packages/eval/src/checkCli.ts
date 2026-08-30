// CLI: `pnpm --filter @codeflow/eval run check` — the HERMETIC eval check that runs in CI.
//
// It deliberately does NOT score anything: scoring needs an embedding provider, a real key and
// money, so that lives in the out-of-band scored workflow. What this verifies is that the
// golden set is well-formed, PINNED, substantial, and stable — the properties that fail first
// when a dataset rots, and whose failure would otherwise surface as a confidently wrong score
// months later.
//
// No secrets, no network, no repo clone.

import { loadGoldenDatasets, totalNegativeControls, totalQuestions } from "./datasets.js";
import { EVAL_THRESHOLDS } from "./thresholds.js";

async function main(): Promise<void> {
  const datasets = await loadGoldenDatasets();

  if (datasets.length === 0) {
    throw new Error("No golden datasets found in packages/eval/datasets/ — author at least one.");
  }

  console.log(`eval golden set — ${datasets.length} dataset(s), ${totalQuestions(datasets)} questions ` +
    `(${totalNegativeControls(datasets)} negative controls)`);

  for (const entry of datasets) {
    const { dataset } = entry;
    const negatives = dataset.questions.filter((question) => question.expectedFiles.length === 0).length;
    const withLines = dataset.questions.filter((question) => (question.expectedLines?.length ?? 0) > 0).length;
    console.log(
      `  ${entry.name.padEnd(10)} ${dataset.repoUrl}@${dataset.commitSha.slice(0, 12)} · ` +
        `${dataset.questions.length}q (${withLines} with line ranges, ${negatives} negative) · ` +
        `${dataset.synthesis.expectedEntryPoints.length} entry point(s) · ` +
        `space ${dataset.embeddingModel}/${dataset.embeddingDim}`,
    );
  }

  // Determinism: the loader is used by the scored run too, so a non-stable load would make
  // two scored runs incomparable for reasons that have nothing to do with the pipeline.
  const again = await loadGoldenDatasets();
  if (JSON.stringify(again) !== JSON.stringify(datasets)) {
    throw new Error("Golden-set load is NOT deterministic — two loads produced different data.");
  }
  console.log("  load is deterministic (byte-identical across two loads)");

  console.log(
    "\n  NOTE: thresholds are still PLACEHOLDERS " +
      `(recall@${EVAL_THRESHOLDS.ragRecallAtK.k} >= ${EVAL_THRESHOLDS.ragRecallAtK.min}, ` +
      `citationValidity >= ${EVAL_THRESHOLDS.minCitationValidity}). ` +
      "Calibrate them from the out-of-band scored run before gating on them.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown eval-check error.";
  console.error(`eval check failed: ${message}`);
  process.exit(1);
});
