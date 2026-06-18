import { env, isTestEnv } from "../config/env.js";

export const ANALYSIS_QUEUE_NAME = "codeflow-analysis";

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: Record<string, never>;
  maxRetriesPerRequest?: null;
}

export function isRedisQueueEnabled() {
  return !isTestEnv() && Boolean(env.redisUrl);
}

export function createRedisConnectionOptions(options: { forWorker?: boolean } = {}): RedisConnectionOptions {
  const url = new URL(env.redisUrl);
  const connection: RedisConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
  };

  if (url.username) {
    connection.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  if (url.pathname && url.pathname !== "/") {
    connection.db = Number(url.pathname.slice(1));
  }
  if (url.protocol === "rediss:") {
    connection.tls = {};
  }
  if (options.forWorker) {
    connection.maxRetriesPerRequest = null;
  }

  return connection;
}
