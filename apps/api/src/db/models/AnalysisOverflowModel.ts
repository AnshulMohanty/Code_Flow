import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

/**
 * The overflow collection (V3-P5 task 5, ledger #20).
 *
 * Holds the heavy fields shed from an oversized analysis document. See `analysisOverflow.ts` for the
 * measurement that decides when anything lands here at all — the common case writes nothing.
 *
 * KEYED ON THE CACHE KEY, NOT ON THE ANALYSIS `_id`, and that is the load-bearing choice. The `_id`
 * does not exist until the insert completes, so keying on it would force a write, a read-back of the
 * generated id, and a second write — three round trips, with a window in which the analysis exists
 * and its overflow does not. `(repoFullName, commitSha, analyzerVersion)` is already the unique
 * cache key, so it is known BEFORE either write and both can proceed independently.
 *
 * ONE DOCUMENT PER ANALYSIS, not one per field. The fields are read together or not at all (a read
 * rehydrates the manifest), so splitting them would multiply round trips to save nothing. The 16 MB
 * limit still applies to THIS document — which is exactly why `analysisOverflow` reports
 * `stillTooLarge` rather than assuming an overflow document is unbounded.
 */
const analysisOverflowSchema = new Schema(
  {
    repoFullName: { type: String, required: true },
    commitSha: { type: String, required: true },
    analyzerVersion: { type: String, required: true },
    /** Field path -> value, e.g. `{"graph.cpgEdges": [...]}`. Mixed: the values are the analyzer's
     *  own types, and re-declaring them here would be a second schema to keep in sync. */
    payload: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  { strict: true },
);

// Same shape as the analyses cache key, so the lookup is one indexed read.
analysisOverflowSchema.index(
  { repoFullName: 1, commitSha: 1, analyzerVersion: 1 },
  { unique: true, name: "analysis_overflow_key" },
);

export type AnalysisOverflowDocument = InferSchemaType<typeof analysisOverflowSchema>;

export const AnalysisOverflowModel =
  models.AnalysisOverflow || model("AnalysisOverflow", analysisOverflowSchema, "analysis_overflow");
