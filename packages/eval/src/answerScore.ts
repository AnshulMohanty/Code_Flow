import type { ScoredCoords } from "./score.js";
import type { RagAnswer, RagAnswerCitation } from "@codeflow/analyzers";
import type { RagEvalQuestion } from "./dataset.js";

/**
 * Score the ANSWER path, not just the index (V3-P0 §0.4).
 *
 * Before this the eval measured retrieval only — recall@k and MRR over the chunk index. That
 * says the right chunks were FOUND; it says nothing about whether the answer built from them
 * was faithful or cited real code, which is the part a user actually reads.
 *
 * Two of the three measures here are DETERMINISTIC and need no model:
 *
 *   citationValidity   — every citation must point at a chunk that was actually retrieved,
 *                        and at a line range inside that chunk. This is grounding, checked
 *                        by code. A citation that fails is a fabricated reference.
 *   citationRelevance  — of the cited files, how many are in the dataset's expected set.
 *                        Answers the "cited real code, but the WRONG real code" failure.
 *   answerRate         — did it answer at all, and was refusing correct? A confident wrong
 *                        answer and an honest refusal are different outcomes and must not
 *                        average together silently.
 *
 * Faithfulness (does the prose follow from the chunks?) is NOT decidable by string matching,
 * so it is the one measure delegated to a judge — and only ever a CALIBRATED one; see
 * `judge.ts`.
 */

export interface AnswerScores {
  /** Share of citations that resolve to a retrieved chunk AND a line range inside it. */
  citationValidity: number;
  /** Share of cited files that appear in the question's expected file set. */
  citationRelevance: number;
  /** 1 when the question was answered, 0 when refused. */
  answered: number;
  /**
   * Citations the answer emitted that grounding DROPPED (a chunk id it never retrieved).
   * From `RagAnswer.droppedCitations` — the production path already records this, so the
   * eval reads the real number instead of re-deriving it.
   */
  droppedCitations: number;
  /** True when refusing was the RIGHT call — no expected file was retrievable at all. */
  refusalJustified: boolean;
}

export interface PerAnswerResult extends AnswerScores {
  id: string;
  question: string;
  answerText: string;
  citedFiles: string[];
}

export interface AggregateAnswerScores {
  questionCount: number;
  /** Share of questions that produced an answer (rather than an honest refusal). */
  answerRate: number;
  meanCitationValidity: number;
  meanCitationRelevance: number;
  /** Refusals where no expected file was retrievable — these are CORRECT behaviour. */
  justifiedRefusals: number;
  /** Refusals where the expected file WAS retrievable — these are real misses. */
  unjustifiedRefusals: number;
  totalDroppedCitations: number;
}

/**
 * Grade one answer. `retrieved` is the chunk set the answer was actually built from, so
 * citation validity is checked against what the model could legitimately have seen — not
 * against the whole index.
 */
export function scoreAnswer(
  question: RagEvalQuestion,
  answer: RagAnswer,
  retrieved: readonly ScoredCoords[],
): PerAnswerResult {
  const expectedFiles = new Set(question.expectedFiles);
  const citations: RagAnswerCitation[] = answer.citations ?? [];

  // A citation is VALID when its (fileId, startLine..endLine) falls inside a chunk that was
  // actually RETRIEVED. Production already grounds citations to file+line before they reach
  // here, so this is the independent check that the grounding held — not a duplicate of it.
  const valid = citations.filter((citation) => containedInRetrieved(retrieved, citation));

  const citedFiles = [...new Set(citations.map((citation) => citation.fileId))];
  const relevantCited = citedFiles.filter((fileId) => expectedFiles.has(fileId));

  // Was refusing correct? Only if none of the expected files was even retrievable — then
  // "I cannot answer from this repo" is the right answer, not a failure.
  const expectedWasRetrievable = retrieved.some((chunk) => expectedFiles.has(chunk.fileId));
  const refusalJustified = !answer.answered && !expectedWasRetrievable;

  return {
    id: question.id,
    question: question.question,
    answerText: answer.answer ?? "",
    citedFiles,
    // An ANSWER with no citations scores 0 validity (it cited nothing to check); a REFUSAL
    // with no citations scores 1, because citing nothing is the correct thing to do there.
    citationValidity: citations.length === 0 ? (answer.answered ? 0 : 1) : valid.length / citations.length,
    citationRelevance: citedFiles.length === 0 ? 0 : relevantCited.length / citedFiles.length,
    answered: answer.answered ? 1 : 0,
    droppedCitations: answer.droppedCitations?.count ?? 0,
    refusalJustified,
  };
}

/** Does this citation's file + line span sit inside a chunk the answer actually retrieved? */
function containedInRetrieved(retrieved: readonly ScoredCoords[], citation: RagAnswerCitation): boolean {
  return retrieved.some(
    (chunk) =>
      chunk.fileId === citation.fileId &&
      citation.startLine >= chunk.startLine &&
      citation.endLine <= chunk.endLine,
  );
}

/**
 * Aggregate per-answer scores. Justified and unjustified refusals are counted SEPARATELY
 * rather than folded into one "answer rate": an honest refusal on an unanswerable question is
 * the behaviour we want, and averaging it with a real miss would hide both.
 */
export function aggregateAnswers(perAnswer: PerAnswerResult[]): AggregateAnswerScores {
  const count = perAnswer.length;
  if (count === 0) {
    return {
      questionCount: 0,
      answerRate: 0,
      meanCitationValidity: 0,
      meanCitationRelevance: 0,
      justifiedRefusals: 0,
      unjustifiedRefusals: 0,
      totalDroppedCitations: 0,
    };
  }
  const refusals = perAnswer.filter((entry) => entry.answered === 0);
  return {
    questionCount: count,
    answerRate: mean(perAnswer.map((entry) => entry.answered)),
    meanCitationValidity: mean(perAnswer.map((entry) => entry.citationValidity)),
    meanCitationRelevance: mean(perAnswer.map((entry) => entry.citationRelevance)),
    justifiedRefusals: refusals.filter((entry) => entry.refusalJustified).length,
    unjustifiedRefusals: refusals.filter((entry) => !entry.refusalJustified).length,
    totalDroppedCitations: perAnswer.reduce((sum, entry) => sum + entry.droppedCitations, 0),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
