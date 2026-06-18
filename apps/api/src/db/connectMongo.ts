import mongoose from "mongoose";
import { env, isTestEnv } from "../config/env.js";

export async function connectMongo() {
  if (isTestEnv()) {
    return;
  }

  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log("MongoDB connected for CodeFlow analysis cache.");
  } catch (error) {
    console.error("MongoDB connection failed. Start Docker Desktop and run docker compose up -d.");
    throw error;
  }
}

export function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

export async function disconnectMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
