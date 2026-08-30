import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertDatasetShape, type EvalDataset } from "./dataset.js";

/**
 * Load the authored golden datasets from `packages/eval/datasets/` (V3-P0 §0.4).
 *
 * Every file goes through `assertDatasetShape`, which is real RUNTIME validation, not a cast:
 * a dataset is arbitrary JSON on disk, and a malformed one produces a silently wrong score
 * rather than a crash (see the reasoning on that function).
 */

/** Resolve `datasets/` relative to THIS module, so the loader works from src and from dist. */
function datasetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/  -> ../datasets ; dist/ -> ../datasets
  return path.resolve(here, "..", "datasets");
}

export interface LoadedDataset {
  /** File name without the extension (e.g. "chalk") — the dataset's stable handle. */
  name: string;
  path: string;
  dataset: EvalDataset;
}

/** Load every `*.json` in `datasets/`, validated, sorted by name for deterministic order. */
export async function loadGoldenDatasets(dir = datasetsDir()): Promise<LoadedDataset[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = entries.filter((name) => name.endsWith(".json")).sort();

  const loaded: LoadedDataset[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = await readFile(full, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error(`Dataset ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      assertDatasetShape(parsed);
    } catch (error: unknown) {
      // Name the file — "questions[7] has an impossible line range" is useless without it.
      throw new Error(`Dataset ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    loaded.push({ name: file.replace(/\.json$/, ""), path: full, dataset: parsed });
  }
  return loaded;
}

/** Total authored questions across all golden datasets (a coverage number worth watching). */
export function totalQuestions(datasets: LoadedDataset[]): number {
  return datasets.reduce((sum, entry) => sum + entry.dataset.questions.length, 0);
}

/** Questions with NO expected files — the deliberate negative controls (refusal tests). */
export function totalNegativeControls(datasets: LoadedDataset[]): number {
  return datasets.reduce(
    (sum, entry) => sum + entry.dataset.questions.filter((question) => question.expectedFiles.length === 0).length,
    0,
  );
}
