import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const repoSchema = new Schema(
  {
    provider: { type: String, enum: ["github"], required: true },
    owner: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    fullName: { type: String, required: true, unique: true, index: true },
    defaultBranch: { type: String, required: true, default: "main" },
    visibility: { type: String, enum: ["public", "private", "unknown"], required: true, default: "unknown" },
    cloneUrl: { type: String },
    stars: { type: Number },
    lastAnalyzedAt: { type: Date },
  },
  {
    strict: true,
    timestamps: true,
  },
);

export type RepoDocument = InferSchemaType<typeof repoSchema>;

export const RepoModel = models.Repo || model("Repo", repoSchema, "repos");
