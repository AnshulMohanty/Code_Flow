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
}

export const EVAL_THRESHOLDS: EvalThresholds = {
  readingOrderRecallAtK: { k: 5, min: 0.6 }, // PLACEHOLDER — tune in P7
  ragRecallAtK: { k: 5, min: 0.6 }, // PLACEHOLDER — tune in P7
  maxDroppedCitationsRate: 0.1, // PLACEHOLDER — tune in P7
};
