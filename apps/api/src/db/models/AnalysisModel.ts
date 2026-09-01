import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const analysisSchema = new Schema(
  {
    repoFullName: { type: String, required: true, index: true },
    repositoryRef: { type: Schema.Types.Mixed, required: true },
    commitSha: { type: String, required: true, index: true },
    branch: { type: String, required: true },
    mode: { type: String, enum: ["public_hosted"], required: true },
    analyzerVersion: { type: String, required: true, index: true },
    result: { type: Schema.Types.Mixed, required: true },
    summary: { type: Schema.Types.Mixed, required: true },
    completedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true },
    /**
     * V3-P5 (ledger #20): which heavy fields were externalized, if any. ABSENT on the common case,
     * so an existing document reads back unchanged.
     *
     * The manifest lives on the ANALYSIS rather than only on the overflow document because a read
     * must know what to expect BEFORE fetching it — that is what lets a missing overflow be
     * reported as "incomplete" instead of silently looking like a repo with no call edges.
     */
    overflow: {
      type: new Schema(
        {
          fields: { type: [String], required: true },
          originalJsonBytes: { type: Number, required: true },
          storedJsonBytes: { type: Number, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
  },
  {
    strict: true,
    timestamps: { createdAt: true, updatedAt: false },
  },
);

analysisSchema.index(
  { repoFullName: 1, commitSha: 1, analyzerVersion: 1 },
  { unique: true, name: "analysis_cache_key" },
);

export type AnalysisDocument = InferSchemaType<typeof analysisSchema>;

export const AnalysisModel = models.Analysis || model("Analysis", analysisSchema, "analyses");
