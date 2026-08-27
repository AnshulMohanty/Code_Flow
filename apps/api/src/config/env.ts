import path from "node:path";
import dotenv from "dotenv";
import { ANALYZER_VERSION } from "@codeflow/config";

// Monorepo has a single root .env; apps run with cwd = their package dir (apps/<app>), so
// resolve the repo-root .env explicitly rather than dotenv's cwd-relative default. Skip under
// the test runner (NODE_ENV=test) so the hermetic suite never picks up a developer's local .env.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
}

export const env = {
  apiPort: Number(process.env.API_PORT || 4000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/codeflow",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  analyzerVersion: process.env.ANALYZER_VERSION || ANALYZER_VERSION,
  nodeEnv: process.env.NODE_ENV || "development",
};

export function isTestEnv() {
  return env.nodeEnv === "test";
}
