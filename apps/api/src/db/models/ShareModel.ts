import mongoose, { type InferSchemaType } from "mongoose";

const { Schema, model, models } = mongoose;

const shareSchema = new Schema(
  {
    analysisId: { type: String, required: true, index: true },
    slug: { type: String, required: true, unique: true },
    visibility: { type: String, enum: ["public", "private"], required: true, default: "public" },
  },
  {
    strict: true,
    timestamps: true,
  },
);

export type ShareDocument = InferSchemaType<typeof shareSchema>;

// Placeholder only. Share-link behavior is deferred.
export const ShareModel = models.Share || model("Share", shareSchema, "shares");
