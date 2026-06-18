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
