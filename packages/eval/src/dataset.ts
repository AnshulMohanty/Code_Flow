// The eval dataset contract: authored ground truth a human pins to a repo + commit SHA,
// graded against a specific embedding index. Plain serializable + versioned. The harness
// SHIPS the schema + ONE clearly-marked TEMPLATE only — fabricating a real repo's ground
// truth from guesses is worse than none. The real dataset is authored in P7 against a
// chosen repo and pinned SHA.

/** Bumped when the dataset shape changes in a breaking way. */
export const EVAL_SCHEMA_VERSION = 1;

/** One authored Q&A item: a question + the file(s)/line(s) that truly answer it. */
export interface RagEvalQuestion {
  id: string;
  question: string;
  /** fileId(s) that answer it (repo-relative POSIX path === graph.nodes[].id). */
  expectedFiles: string[];
  /** Tighter ground truth: the specific line range(s) that answer it, when known. */
  expectedLines?: { fileId: string; startLine: number; endLine: number }[];
}

/**
 * Authored ground truth for one repo at one commit, graded against one embedding index.
 * `embeddingModel` + `embeddingDim` pin the vector space the questions are graded in —
 * the runner refuses to score a query embedding from a different space (see runEval).
 */
export interface EvalDataset {
  evalSchemaVersion: number;
  repoUrl: string;
  /** Ground truth is pinned to a SHA — re-author if the repo's code moves. */
  commitSha: string;
  /** The embedding index this dataset is graded against. */
  embeddingModel: string;
  embeddingDim: number;
  synthesis: {
    /** fileIds a human says the reading order / keyFiles SHOULD surface to a newcomer. */
    expectedEntryPoints: string[];
  };
  questions: RagEvalQuestion[];
}

/**
 * The ONLY shipped dataset: a template skeleton with REPLACE_* placeholders. It is NOT
 * runnable ground truth — every value must be replaced with human-verified answers
 * against a real pinned commit (a P7 data task). Kept here so authors copy a correct
 * shape rather than invent one.
 */
export const TEMPLATE_DATASET: EvalDataset = {
  evalSchemaVersion: EVAL_SCHEMA_VERSION,
  repoUrl: "https://github.com/REPLACE_OWNER/REPLACE_REPO",
  commitSha: "REPLACE_WITH_PINNED_COMMIT_SHA",
  embeddingModel: "voyage-code-3",
  embeddingDim: 1024,
  synthesis: {
    // Replace with the files a human confirms a newcomer should be pointed at first.
    expectedEntryPoints: ["REPLACE/with/a/real/entrypoint.ts"],
  },
  questions: [
    {
      id: "q1",
      question: "REPLACE with a real question a developer would ask about this repo.",
      expectedFiles: ["REPLACE/with/the/file_that_answers_it.ts"],
      // Optional tighter ground truth:
      // expectedLines: [{ fileId: "REPLACE/...", startLine: 1, endLine: 40 }],
    },
  ],
};

/** Light structural validation for the CLI (a malformed dataset should fail loudly). */
export function assertDatasetShape(value: unknown): asserts value is EvalDataset {
  const d = value as Partial<EvalDataset> | null;
  if (!d || typeof d !== "object") throw new Error("Dataset must be a JSON object.");
  if (typeof d.repoUrl !== "string" || typeof d.commitSha !== "string") {
    throw new Error("Dataset must have string `repoUrl` and `commitSha`.");
  }
  if (typeof d.embeddingModel !== "string" || typeof d.embeddingDim !== "number") {
    throw new Error("Dataset must declare `embeddingModel` (string) + `embeddingDim` (number).");
  }
  if (!d.synthesis || !Array.isArray(d.synthesis.expectedEntryPoints)) {
    throw new Error("Dataset must have `synthesis.expectedEntryPoints` (string[]).");
  }
  if (!Array.isArray(d.questions)) {
    throw new Error("Dataset must have a `questions` array.");
  }
  if (d.commitSha.startsWith("REPLACE")) {
    throw new Error("Dataset still contains TEMPLATE placeholders — author real ground truth first (P7).");
  }
}
