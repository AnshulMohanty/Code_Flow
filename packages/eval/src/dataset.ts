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
/**
 * Where a dataset's ground truth came from, and what it measures. Free-form on purpose — it
 * is read by humans, not by the scorer — but PRESENT on purpose too: a golden set whose
 * provenance is unrecorded cannot be trusted later, and "which pipeline version were these
 * numbers taken against?" is exactly the question a regression check has to answer.
 */
export interface DatasetProvenance {
  authoredOn?: string;
  authoredIn?: string;
  /** How the expected files/lines were established (e.g. "cloned at the SHA and read it"). */
  method?: string;
  /** Which analyzer behaviour the numbers are comparable against. */
  measures?: string;
  whyThisRepo?: string;
  thresholdStatus?: string;
}

export interface EvalDataset {
  evalSchemaVersion: number;
  /** Human-readable record of how this ground truth was established (see DatasetProvenance). */
  provenance?: DatasetProvenance;
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

/**
 * RUNTIME validation for a loaded dataset file — one of the three untrusted external
 * boundaries the V3-P0 contract rule names (alongside API request bodies and parsed LLM
 * JSON). A dataset arrives as arbitrary JSON from disk, so the TypeScript type is a promise,
 * not a guarantee.
 *
 * Every check below exists because getting it wrong produces a SILENTLY WRONG SCORE rather
 * than a crash: an unpinned SHA grades against code that has moved; a `commitSha` that is not
 * a real hash means the dataset is not pinned at all; a question with no `id` breaks the
 * per-question report; an inverted or zero line range can never be hit, so it looks like a
 * retrieval failure forever. Failing loudly here is the only way those stay visible.
 */
export function assertDatasetShape(value: unknown): asserts value is EvalDataset {
  const d = value as Partial<EvalDataset> | null;
  if (!d || typeof d !== "object") throw new Error("Dataset must be a JSON object.");
  if (typeof d.repoUrl !== "string" || typeof d.commitSha !== "string") {
    throw new Error("Dataset must have string `repoUrl` and `commitSha`.");
  }
  if (typeof d.embeddingModel !== "string" || typeof d.embeddingDim !== "number") {
    throw new Error("Dataset must declare `embeddingModel` (string) + `embeddingDim` (number).");
  }
  if (!Number.isInteger(d.embeddingDim) || d.embeddingDim <= 0) {
    throw new Error(`Dataset \`embeddingDim\` must be a positive integer (got ${String(d.embeddingDim)}).`);
  }
  if (!d.synthesis || !Array.isArray(d.synthesis.expectedEntryPoints)) {
    throw new Error("Dataset must have `synthesis.expectedEntryPoints` (string[]).");
  }
  if (!Array.isArray(d.questions)) {
    throw new Error("Dataset must have a `questions` array.");
  }
  if (d.commitSha.startsWith("REPLACE")) {
    throw new Error("Dataset still contains TEMPLATE placeholders — author real ground truth first.");
  }
  // A dataset that is not pinned to a real commit is grading against a moving target.
  if (!/^[0-9a-f]{40}$/.test(d.commitSha)) {
    throw new Error(
      `Dataset \`commitSha\` must be a full 40-character hex commit hash (got "${d.commitSha}"). ` +
        "Ground truth is only meaningful pinned to an exact commit.",
    );
  }
  if (d.evalSchemaVersion !== EVAL_SCHEMA_VERSION) {
    throw new Error(
      `Dataset evalSchemaVersion ${String(d.evalSchemaVersion)} != ${EVAL_SCHEMA_VERSION} — re-author or migrate it.`,
    );
  }

  const seenIds = new Set<string>();
  for (const [index, question] of d.questions.entries()) {
    const where = `questions[${index}]`;
    if (!question || typeof question !== "object") throw new Error(`${where} must be an object.`);
    if (typeof question.id !== "string" || !question.id) throw new Error(`${where} needs a non-empty string \`id\`.`);
    if (seenIds.has(question.id)) throw new Error(`${where} duplicates the id "${question.id}".`);
    seenIds.add(question.id);
    if (typeof question.question !== "string" || !question.question.trim()) {
      throw new Error(`${where} (${question.id}) needs a non-empty \`question\`.`);
    }
    // An EMPTY expectedFiles list is legal and meaningful: a negative control, i.e. a question
    // this repo cannot answer, used to test that refusing is correct. It must be an ARRAY though.
    if (!Array.isArray(question.expectedFiles)) {
      throw new Error(`${where} (${question.id}) needs \`expectedFiles\` (string[]; [] = negative control).`);
    }
    for (const fileId of question.expectedFiles) {
      if (typeof fileId !== "string" || !fileId) {
        throw new Error(`${where} (${question.id}) has a non-string entry in \`expectedFiles\`.`);
      }
      if (fileId.startsWith("/") || fileId.includes("\\")) {
        throw new Error(
          `${where} (${question.id}) expectedFiles must be repo-relative POSIX paths (got "${fileId}").`,
        );
      }
    }
    if (question.expectedLines !== undefined) {
      if (!Array.isArray(question.expectedLines)) {
        throw new Error(`${where} (${question.id}) \`expectedLines\` must be an array when present.`);
      }
      for (const range of question.expectedLines) {
        if (!range || typeof range.fileId !== "string" || !range.fileId) {
          throw new Error(`${where} (${question.id}) has an expectedLines entry without a \`fileId\`.`);
        }
        if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine)) {
          throw new Error(`${where} (${question.id}) expectedLines must use integer line numbers.`);
        }
        // 1-based and non-inverted: an impossible range can never be hit, so it would read as
        // a permanent retrieval failure rather than as the authoring mistake it is.
        if (range.startLine < 1 || range.endLine < range.startLine) {
          throw new Error(
            `${where} (${question.id}) has an impossible line range ${range.startLine}-${range.endLine} in ${range.fileId}.`,
          );
        }
        if (!question.expectedFiles.includes(range.fileId)) {
          throw new Error(
            `${where} (${question.id}) expectedLines names ${range.fileId}, which is not in expectedFiles.`,
          );
        }
      }
    }
  }
}
