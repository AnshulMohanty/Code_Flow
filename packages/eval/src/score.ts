import type { RagChunk, Synthesis } from "@codeflow/shared-types";
import type { RagEvalQuestion } from "./dataset.js";
import { retrieve } from "@codeflow/analyzers";

// All scoring is PURE + deterministic given fixed inputs (the mock embeddings are
// deterministic). Per-question detail is reported, not just aggregates — a single number
// hides which files the AI missed.

// ── Synthesis scoring ────────────────────────────────────────────────────────

export interface SynthesisScores {
  /** Fraction of expectedEntryPoints surfaced in the top-k reading order ∪ top-k keyFiles. */
  readingOrderRecallAtK: number;
  k: number;
  /** Fraction of reading-order citations that resolve to a real graph node (≈1.0 given grounding). */
  citationResolutionRate: number;
  /** Fraction of LLM-cited steps dropped by grounding — a quality signal, surfaced not hidden. */
  droppedCitationsRate: number;
  expectedCount: number;
  /** The surfaced set (top-k reading order ∪ top-k keyFiles), sorted — for the report. */
  surfaced: string[];
}

/**
 * Score the onboarding synthesis against authored expected entry points. "Surfaced" = the
 * union of the top-k reading order (by `order`) and the top-k deterministic keyFiles — the
 * dataset says these fileIds SHOULD point a newcomer at the right place.
 */
export function scoreSynthesis(
  synthesis: Synthesis,
  keyFiles: string[],
  nodeIds: Set<string>,
  expectedEntryPoints: string[],
  k: number,
): SynthesisScores {
  const topReading = [...synthesis.readingOrder]
    .sort((a, b) => a.order - b.order || a.fileId.localeCompare(b.fileId))
    .slice(0, k)
    .map((step) => step.fileId);
  const surfaced = new Set<string>([...topReading, ...keyFiles.slice(0, k)]);

  const expected = expectedEntryPoints;
  const recall = expected.length === 0 ? 1 : expected.filter((id) => surfaced.has(id)).length / expected.length;

  const total = synthesis.readingOrder.length;
  const grounded = synthesis.readingOrder.filter((step) => nodeIds.has(step.fileId)).length;
  const citationResolutionRate = total === 0 ? 1 : grounded / total;

  const dropped = synthesis.droppedCitations ?? 0;
  const droppedCitationsRate = total + dropped === 0 ? 0 : dropped / (total + dropped);

  return {
    readingOrderRecallAtK: recall,
    k,
    citationResolutionRate,
    droppedCitationsRate,
    expectedCount: expected.length,
    surfaced: [...surfaced].sort(),
  };
}

// ── RAG retrieval scoring ──────────────────────────────────────────────────────

export interface PerQuestionResult {
  id: string;
  question: string;
  /** The retrieved chunks (top-k), trimmed to citation coordinates for the report. */
  retrieved: { id: string; fileId: string; startLine: number; endLine: number }[];
  /** recall@k over this question's expected targets (files, or line ranges when given). */
  recallAtK: number;
  /** Reciprocal rank of the first retrieved hit (1/rank; 0 if none in top-k). */
  reciprocalRank: number;
  hit: boolean;
  /** Expected targets NOT found in the top-k (surfaced, not hidden). */
  missed: string[];
  /**
   * True when the question has NO expected targets — a deliberate NEGATIVE CONTROL asking
   * something the repo cannot answer. Retrieval always returns a top-k, so such a question
   * has nothing to recall and is EXCLUDED from recall/MRR (see aggregateRag). Its value is
   * on the answer path, where an honest refusal is the correct behaviour and is scored as
   * `refusalJustified`. Counting it as recall 0 would penalise exactly the right answer.
   */
  negativeControl: boolean;
}

export interface RagScores {
  k: number;
  meanRecallAtK: number;
  /** Mean reciprocal rank across questions. */
  mrr: number;
  /** Questions the means are computed over — negative controls EXCLUDED. */
  questionCount: number;
  /** Negative-control questions present but not scored here (scored on the answer path). */
  negativeControlCount: number;
}

interface Target {
  fileId: string;
  startLine?: number;
  endLine?: number;
  /** Stable label for the report's `missed` list. */
  label: string;
}

/** A question's expected targets: line ranges when authored, else whole files. */
function targetsFor(question: RagEvalQuestion): Target[] {
  if (question.expectedLines && question.expectedLines.length > 0) {
    return question.expectedLines.map((line) => ({
      fileId: line.fileId,
      startLine: line.startLine,
      endLine: line.endLine,
      label: `${line.fileId}#${line.startLine}-${line.endLine}`,
    }));
  }
  return question.expectedFiles.map((fileId) => ({ fileId, label: fileId }));
}

/** Does a retrieved chunk satisfy a target (file match, or line-range overlap when tighter)? */
function chunkHitsTarget(chunk: RagChunk, target: Target): boolean {
  if (chunk.fileId !== target.fileId) return false;
  if (target.startLine === undefined || target.endLine === undefined) return true;
  return chunk.startLine <= target.endLine && chunk.endLine >= target.startLine;
}

/** Score one question: retrieve top-k for its query vector, then recall@k + reciprocal rank. */
export function scoreQuestion(question: RagEvalQuestion, chunks: RagChunk[], queryVector: number[], k: number): PerQuestionResult {
  const top = retrieve(chunks, queryVector, k);
  const targets = targetsFor(question);

  const hitTargets = targets.filter((target) => top.some((chunk) => chunkHitsTarget(chunk, target)));
  const recallAtK = targets.length === 0 ? 0 : hitTargets.length / targets.length;

  let reciprocalRank = 0;
  for (let i = 0; i < top.length; i++) {
    if (targets.some((target) => chunkHitsTarget(top[i], target))) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }

  const hitLabels = new Set(hitTargets.map((target) => target.label));
  return {
    id: question.id,
    question: question.question,
    retrieved: top.map((chunk) => ({ id: chunk.id, fileId: chunk.fileId, startLine: chunk.startLine, endLine: chunk.endLine })),
    recallAtK,
    reciprocalRank,
    hit: recallAtK > 0,
    missed: targets.filter((target) => !hitLabels.has(target.label)).map((target) => target.label),
    negativeControl: targets.length === 0,
  };
}

/** Aggregate per-question results into mean recall@k + MRR. */
/**
 * Aggregate retrieval scores over the questions that HAVE targets.
 *
 * Negative controls (no expected files — a question the repo cannot answer) are excluded
 * rather than scored 0: retrieval always returns a top-k, so there is nothing for them to
 * recall, and averaging them in would penalise the very behaviour they exist to test. They
 * are counted separately so their presence is visible, and they are genuinely scored on the
 * answer path via `refusalJustified`.
 */
export function aggregateRag(perQuestion: PerQuestionResult[], k: number): RagScores {
  const scored = perQuestion.filter((entry) => !entry.negativeControl);
  const n = scored.length;
  const meanRecallAtK = n === 0 ? 0 : scored.reduce((sum, r) => sum + r.recallAtK, 0) / n;
  const mrr = n === 0 ? 0 : scored.reduce((sum, r) => sum + r.reciprocalRank, 0) / n;
  return {
    k,
    meanRecallAtK,
    mrr,
    questionCount: n,
    negativeControlCount: perQuestion.length - n,
  };
}
