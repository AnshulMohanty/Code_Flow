import mongoose from "mongoose";
import type { EventLogStore, ProgressMessage } from "@codeflow/shared-types";
import { isMongoConnected } from "../db/connectMongo.js";

const { Schema, model, models } = mongoose;

let testOverride: EventLogStore | null = null;
let inMemory: EventLogStore | null = null;
let mongoStore: EventLogStore | null = null;

/** Tests inject an in-memory store here (mirrors setProgressSubscriberForTests). */
export function setEventLogStoreForTests(store: EventLogStore | null) {
  testOverride = store;
}

/**
 * The SSE replay buffer. In prod the worker appends to Mongo and the API reads from it
 * (shared across processes); when Mongo is unavailable we fall back to a per-process
 * in-memory store (single-instance only) so the API still functions.
 */
export function getEventLogStore(): EventLogStore {
  if (testOverride) return testOverride;
  if (isMongoConnected()) {
    mongoStore ??= createMongoEventLogStore();
    return mongoStore;
  }
  inMemory ??= createInMemoryEventLogStore();
  return inMemory;
}

/** In-memory append-only log keyed by jobId — the test default + single-process fallback. */
export function createInMemoryEventLogStore(): EventLogStore {
  const logs = new Map<string, ProgressMessage[]>();
  return {
    async append(jobId, message) {
      const list = logs.get(jobId) ?? [];
      list.push(message);
      logs.set(jobId, list);
    },
    async read(jobId) {
      return [...(logs.get(jobId) ?? [])];
    },
  };
}

// Mongo-backed event log (shared across worker + API instances). One doc per emitted
// message; `seq` preserves emit order. Integration-only — exercised against real Mongo.
const eventLogSchema = new Schema(
  {
    jobId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    message: { type: Schema.Types.Mixed, required: true },
  },
  { strict: true, timestamps: { createdAt: true, updatedAt: false } },
);
eventLogSchema.index({ jobId: 1, seq: 1 }, { unique: true });

const EventLogModel = models.JobEvent || model("JobEvent", eventLogSchema, "jobevents");

export function createMongoEventLogStore(): EventLogStore {
  return {
    async append(jobId, message) {
      const count = await EventLogModel.countDocuments({ jobId });
      await EventLogModel.create({ jobId, seq: count, message });
    },
    async read(jobId) {
      const docs = await EventLogModel.find({ jobId }).sort({ seq: 1 }).lean();
      return docs.map((doc) => doc.message as ProgressMessage);
    },
  };
}
