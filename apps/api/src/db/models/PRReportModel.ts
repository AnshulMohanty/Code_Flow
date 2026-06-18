import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const prReportSchema = new Schema(
  {
    repoFullName: { type: String, required: true, index: true },
    analysisId: { type: String, required: true },
    pullRequestNumber: { type: Number, required: true },
    report: { type: Schema.Types.Mixed, required: true },
  },
  {
    strict: true,
    timestamps: true,
  },
);

export type PRReportDocument = InferSchemaType<typeof prReportSchema>;

// Placeholder only. PR report behavior is deferred.
export const PRReportModel = models.PRReport || model("PRReport", prReportSchema, "prReports");
