import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const jobSchema = new Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["queued", "cloning", "parsing", "analyzing", "completed", "failed"], required: true },
    progress: { type: Number, required: true, default: 0 },
    currentStep: { type: String, required: true, default: "Analysis job queued." },
    parsedFiles: { type: Number, required: true, default: 0 },
    totalFiles: { type: Number, required: true, default: 42 },
    repoFullName: { type: String, required: true },
    analysisId: { type: String },
    cached: { type: Boolean, default: false },
    error: { type: String },
    // Terminal pipeline outcome surfaced by the worker (the #19 fix): SSE answers "live",
    // REST answers "what happened" on a reconnect after completion.
    runStatus: { type: String, enum: ["completed", "partial", "failed", "aborted"] },
    runStatusReason: { type: String, enum: ["repo-too-large", "budget-exhausted"] },
    repositoryRef: { type: Schema.Types.Mixed, required: true },
    mode: { type: String, enum: ["public_hosted"], required: true },
    commitSha: { type: String, required: true },
    analyzerVersion: { type: String, required: true },
  },
  {
    strict: true,
    timestamps: true,
  },
);

export type JobDocument = InferSchemaType<typeof jobSchema>;

export const JobModel = models.Job || model("Job", jobSchema, "jobs");
