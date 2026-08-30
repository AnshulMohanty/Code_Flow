// Pass/fail thresholds for the eval. These are NAMED CONSTANTS flagged for **P7 tuning** —
// you cannot pick real thresholds against a mock fixture; they are calibrated against the
// real scored run on a chosen repo in P7. The report computes pass/fail against them, but
// the eval is **NOT wired into CI gating** (CI stays hermetic + fast; the gating run needs
// real keys ⇒ P7). See CURRENT_STATE / PHASE_LOG ledger.

export interface EvalThresholds {
  readingOrderRecallAtK: { k: number; min: number };
  ragRecallAtK: { k: number; min: number };
  /** Upper bound — a high dropped-citation rate signals a weak/hallucinating synthesis. */
  maxDroppedCitationsRate: number;
  // ── Answer-path thresholds (V3-P0 §0.4) ───────────────────────────────────
  /** Min share of citations that resolve to a retrieved chunk + an in-range line span.
   *  This is GROUNDING, checked by code — strict enough to gate without a model. */
  minCitationValidity: number;
  /** Max refusals where an expected file WAS retrievable. A justified refusal (nothing
   *  relevant retrievable) is correct behaviour and is counted separately, never here. */
  maxUnjustifiedRefusals: number;
  /** Min mean judge faithfulness. ONLY gates when the judge passes calibration
   *  (see judge.ts `judgeIsGateable`); otherwise reported and ignored. */
  minJudgeFaithfulness: number;
}

export const EVAL_THRESHOLDS: EvalThresholds = {
  readingOrderRecallAtK: { k: 5, min: 0.6 }, // PLACEHOLDER — calibrate against the scored run
  ragRecallAtK: { k: 5, min: 0.6 }, // PLACEHOLDER — calibrate against the scored run
  maxDroppedCitationsRate: 0.1, // PLACEHOLDER — calibrate against the scored run
  // V3-P0 answer-path placeholders. citationValidity is set HIGH on purpose: it is a
  // grounding check, and a citation that does not resolve to a retrieved chunk is a
  // fabricated reference, not a near miss — 1.0 would be defensible once measured.
  minCitationValidity: 0.9, // PLACEHOLDER — calibrate against the scored run
  maxUnjustifiedRefusals: 1, // PLACEHOLDER — calibrate against the scored run
  minJudgeFaithfulness: 0.8, // PLACEHOLDER — and inert until the judge is calibrated
};

/**
 * TODO (owner, out-of-band — needs a real GEMINI_API_KEY and spends money):
 * calibrate every value above against the scored run on `datasets/*.json`.
 * Until then these are PLACEHOLDERS: the numbers are plausible, not measured, and no gating
 * decision should rest on them. The hermetic CI check deliberately asserts SHAPE +
 * DETERMINISM, never these thresholds — see .github/workflows/ci.yml.
 */
