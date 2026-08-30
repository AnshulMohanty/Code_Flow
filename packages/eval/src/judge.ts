/**
 * What the judge needs to see of a chunk: where it came from and what it said. A narrow local
 * type rather than `RetrievedChunk` — V3-P2 split the persisted metadata from the text, and the
 * judge is the one consumer that genuinely needs BOTH, so it states that requirement itself
 * instead of depending on whichever richer type happens to satisfy it today.
 */
export interface JudgeChunk {
  id: string;
  fileId: string;
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * LLM-as-judge for the ONE thing code cannot decide: faithfulness — does the answer's prose
 * actually follow from the retrieved chunks, or did the model add something plausible that is
 * not in the evidence?
 *
 * THE RULE THIS MODULE ENFORCES: a judge is never used as a gate until its agreement with
 * human labels has been measured. An uncalibrated judge is not a measurement, it is a second
 * opinion with a confident voice — and gating on it would let a model's bias silently become
 * the project's quality bar. `calibrateJudge` produces a concordance number, and
 * `judgeIsGateable` is the only thing that authorizes gating. `runEval` reports judge scores
 * regardless, but refuses to fail a threshold on them without that authorization.
 */

/** A judge's verdict on one answer. */
export interface JudgeVerdict {
  /** 0..1 — the share of the answer's claims supported by the provided chunks. */
  faithfulness: number;
  /** True when the judge found at least one claim with NO support in the chunks. */
  unsupportedClaim: boolean;
  /** The judge's own words, kept for the audit trail (never parsed for scoring). */
  rationale: string;
}

/** What a judge is asked to grade. Deliberately the answer + ONLY the chunks it was built
 *  from — a judge given the whole repo would be grading a different question. */
export interface JudgeRequest {
  question: string;
  answer: string;
  chunks: readonly JudgeChunk[];
}

/** Injectable so the hermetic suite drives a deterministic fake and spends nothing. */
export type Judge = (request: JudgeRequest) => Promise<JudgeVerdict>;

/** One human-labeled example used to calibrate a judge. */
export interface JudgeLabel {
  id: string;
  request: JudgeRequest;
  /** The human verdict: was the answer faithful to the chunks? */
  humanFaithful: boolean;
}

export interface JudgeConcordance {
  /** How many labeled examples the calibration ran on. */
  sampleSize: number;
  /** Share of examples where the judge agreed with the human (after thresholding). */
  agreement: number;
  /** Cohen's kappa — agreement CORRECTED for chance. Raw agreement on a skewed label set can
   *  look excellent while the judge is doing nothing; kappa is what catches that. */
  kappa: number;
  /** Judge said faithful, human said faithful. */
  truePositives: number;
  /** Judge said faithful, human said NOT — the dangerous direction (a rubber stamp). */
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  /** The faithfulness score at or above which the judge's verdict counts as "faithful". */
  threshold: number;
  /**
   * 95% Wald confidence interval on `agreement`. Reported because agreement measured on a
   * handful of examples is not a number anyone should gate on, and the interval makes that
   * visible instead of leaving it to be assumed.
   */
  confidenceInterval: { low: number; high: number };
}

/** The bar a judge must clear before it may gate anything. */
export const JUDGE_GATE_REQUIREMENTS = {
  /** Fewer labels than this and the confidence interval is too wide to mean anything. */
  minSampleSize: 20,
  /** Chance-corrected agreement, not raw — see `kappa`. 0.6 is the conventional
   *  "substantial agreement" floor. PLACEHOLDER pending real labels (see thresholds.ts). */
  minKappa: 0.6,
  /** The lower bound of the interval must clear this, not the point estimate. */
  minAgreementLowerBound: 0.7,
} as const;

/**
 * Measure a judge against human labels. Runs the judge over every labeled example and
 * compares thresholded verdicts, reporting raw agreement, Cohen's kappa, the confusion
 * matrix, and a confidence interval.
 */
export async function calibrateJudge(
  judge: Judge,
  labels: JudgeLabel[],
  threshold = 0.7,
): Promise<JudgeConcordance> {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  for (const label of labels) {
    const verdict = await judge(label.request);
    const judgeFaithful = verdict.faithfulness >= threshold;
    if (judgeFaithful && label.humanFaithful) truePositives += 1;
    else if (judgeFaithful && !label.humanFaithful) falsePositives += 1;
    else if (!judgeFaithful && !label.humanFaithful) trueNegatives += 1;
    else falseNegatives += 1;
  }

  const sampleSize = labels.length;
  const agreement = sampleSize === 0 ? 0 : (truePositives + trueNegatives) / sampleSize;

  return {
    sampleSize,
    agreement,
    kappa: cohensKappa({ truePositives, falsePositives, trueNegatives, falseNegatives }),
    truePositives,
    falsePositives,
    trueNegatives,
    falseNegatives,
    threshold,
    confidenceInterval: waldInterval(agreement, sampleSize),
  };
}

/**
 * Cohen's kappa on a 2x2 confusion matrix: (observed - expected) / (1 - expected).
 *
 * Why not just use agreement: if 95% of labeled answers are faithful, a judge that always
 * says "faithful" scores 95% agreement while carrying zero information. Kappa scores that
 * judge at 0. Returns 0 for a degenerate matrix (a single class present) — where kappa is
 * undefined, "no measured skill" is the honest reading, not a free pass.
 */
export function cohensKappa(matrix: {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}): number {
  const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = matrix;
  const total = tp + fp + tn + fn;
  if (total === 0) return 0;

  const observed = (tp + tn) / total;
  const judgeYes = (tp + fp) / total;
  const humanYes = (tp + fn) / total;
  const expected = judgeYes * humanYes + (1 - judgeYes) * (1 - humanYes);
  if (expected >= 1) return 0; // degenerate: every prediction identical
  return (observed - expected) / (1 - expected);
}

/** 95% Wald interval, clamped to [0,1]. Wide by design on a small sample — that is the point. */
export function waldInterval(proportion: number, sampleSize: number): { low: number; high: number } {
  if (sampleSize === 0) return { low: 0, high: 1 };
  const margin = 1.96 * Math.sqrt((proportion * (1 - proportion)) / sampleSize);
  return { low: clamp01(proportion - margin), high: clamp01(proportion + margin) };
}

/**
 * May this judge gate a threshold? Only with enough labels, chance-corrected agreement above
 * the floor, AND a confidence-interval lower bound that clears the bar. Returns the reasons
 * it cannot, so a report can say WHY the judge is advisory rather than just that it is.
 */
export function judgeIsGateable(concordance: JudgeConcordance | null): { gateable: boolean; reasons: string[] } {
  if (!concordance) {
    return { gateable: false, reasons: ["judge was never calibrated against human labels"] };
  }
  const reasons: string[] = [];
  if (concordance.sampleSize < JUDGE_GATE_REQUIREMENTS.minSampleSize) {
    reasons.push(`sample size ${concordance.sampleSize} < ${JUDGE_GATE_REQUIREMENTS.minSampleSize}`);
  }
  if (concordance.kappa < JUDGE_GATE_REQUIREMENTS.minKappa) {
    reasons.push(`kappa ${concordance.kappa.toFixed(3)} < ${JUDGE_GATE_REQUIREMENTS.minKappa}`);
  }
  if (concordance.confidenceInterval.low < JUDGE_GATE_REQUIREMENTS.minAgreementLowerBound) {
    reasons.push(
      `agreement CI lower bound ${concordance.confidenceInterval.low.toFixed(3)} < ${JUDGE_GATE_REQUIREMENTS.minAgreementLowerBound}`,
    );
  }
  return { gateable: reasons.length === 0, reasons };
}

/** Prompt for a real LLM judge. Exported so the out-of-band scored run and any future
 *  provider adapter share ONE wording — a judge re-worded per caller is not calibrated. */
export const JUDGE_SYSTEM_PROMPT =
  "You are grading whether an ANSWER is faithful to the CODE CHUNKS it was given. Faithful " +
  "means every factual claim in the answer is supported by the chunks. Do NOT reward or " +
  "penalise style, completeness, or whether you personally know the answer to be true — only " +
  "support by the provided chunks. Respond with a SINGLE JSON object and nothing else: " +
  '{"faithfulness": number between 0 and 1, "unsupportedClaim": boolean, "rationale": string}.';

/** Build the judge's user prompt: the question, the answer, and ONLY the chunks it saw. */
export function buildJudgePrompt(request: JudgeRequest): string {
  const lines = ["## Question", request.question, "", "## Answer", request.answer, "", "## Code chunks"];
  for (const chunk of request.chunks) {
    lines.push(`\n### ${chunk.id} (${chunk.fileId}:${chunk.startLine}-${chunk.endLine})`);
    lines.push(chunk.text);
  }
  lines.push("\nGrade the answer's faithfulness to the chunks above. Return JSON only.");
  return lines.join("\n");
}

/** Parse a judge completion defensively — a malformed verdict must not be scored as 0
 *  faithfulness (that would silently penalise a good answer for the judge's bad JSON). */
export function parseJudgeVerdict(completion: string): JudgeVerdict {
  const stripped = completion.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(stripped);
  if (!parsed || typeof parsed !== "object") throw new Error("Judge returned a non-object verdict.");
  const record = parsed as Record<string, unknown>;
  const faithfulness = record.faithfulness;
  if (typeof faithfulness !== "number" || !Number.isFinite(faithfulness)) {
    throw new Error("Judge verdict is missing a numeric `faithfulness`.");
  }
  return {
    faithfulness: clamp01(faithfulness),
    unsupportedClaim: record.unsupportedClaim === true,
    rationale: typeof record.rationale === "string" ? record.rationale : "",
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}
