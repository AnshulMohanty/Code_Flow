// CLI: `pnpm --filter @codeflow/eval run synthetic <analysisResult.json> [out.json]`
//
// The synthetic-data flywheel (V3-P2 task 4), runnable. Reads an `AnalysisResult`, generates
// guaranteed-correct Q&A from its code property graph, and writes a scoreable `EvalDataset`
// plus the mined hard negatives.
//
// KEYLESS AND OFFLINE, which is the point: labels come from the graph oracle, so there is no
// provider, no spend and nothing to wait for. That is what makes it a flywheel rather than a
// data-labelling project.
//
// It deliberately does NOT write into `packages/eval/datasets/`. That directory holds the
// AUTHORED golden set, whose whole value is that a human read code for every question. Mixing
// generated questions in would destroy that guarantee, and would let a retrieval score be
// dominated by the mechanical half of the eval while the judgement half quietly stopped
// mattering. Output goes wherever the caller asks, defaulting to `reports/`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AnalysisResult } from "@codeflow/shared-types";
import { assertDatasetShape } from "./dataset.js";
import { buildSyntheticDataset, summarizeSyntheticDataset } from "./syntheticDataset.js";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function main(): Promise<void> {
  const [resultPath, outPath] = process.argv.slice(2);
  if (!resultPath) {
    throw new Error(
      "usage: pnpm --filter @codeflow/eval run synthetic <analysisResult.json> [out.json]\n" +
        "  The result must carry a `graph` slice (Connect must have run) and a full 40-character\n" +
        "  commit SHA — ground truth is only meaningful pinned to an exact commit.",
    );
  }

  const raw = await readFile(resultPath, "utf8");
  const result = JSON.parse(raw) as AnalysisResult;

  const rag = result.ai?.rag;
  if (!rag) {
    // The dataset must declare the space it will be graded in, and the honest source for that
    // is the index the result actually built. Guessing it would produce a dataset the
    // homogeneity guard then refuses to score — a confusing failure two steps later.
    throw new Error(
      `${resultPath} has no ai.rag index, so the embedding space to grade against is unknown. ` +
        "Run the pipeline with the RAG stage enabled first.",
    );
  }

  const built = buildSyntheticDataset({
    result,
    embeddingModel: rag.embeddingModel,
    embeddingDim: rag.embeddingDim,
  });

  // Validate our own output with the SAME runtime check the loader applies to authored
  // datasets. A generator that emits something the loader rejects has produced nothing usable,
  // and finding that out here beats finding it out during a scored run.
  assertDatasetShape(built.dataset);

  const target = outPath ?? path.join(packageRoot(), "reports", "synthetic.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify({ dataset: built.dataset, hardNegatives: built.extras.hardNegatives, summary: built.extras.summary }, null, 2)}\n`,
    "utf8",
  );

  console.log(summarizeSyntheticDataset(built));
  console.log(`  repo ${built.dataset.repoUrl}@${built.dataset.commitSha.slice(0, 12)}`);
  console.log(`  space ${built.dataset.embeddingModel}/${built.dataset.embeddingDim}`);
  console.log(`  wrote ${path.relative(process.cwd(), target)}`);
  console.log(
    "\n  NOTE: this set measures only the MECHANICALLY-VERIFIABLE half of retrieval. Track it as\n" +
      "  its own series — its thresholds are not comparable to the authored golden set's, because a\n" +
      "  different question distribution measures a different thing.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown synthetic-generation error.";
  console.error(`synthetic generation failed: ${message}`);
  process.exit(1);
});
