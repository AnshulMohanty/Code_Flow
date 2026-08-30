// @codeflow/memory — session and repository memory for the agentic Q&A path (V3-P3).
//
// Two different things behind two interfaces: SESSION memory makes a conversation a
// conversation ("what about its callers?" needs to know what "it" was); REPO memory makes
// "what changed?" answerable from small per-commit snapshots. Everything is BOUNDED, because
// memory feeds the prompt and unbounded memory is a context-budget bug that grows silently.
//
// Depends on @codeflow/shared-types + @codeflow/config only; no database driver (production
// injects one, the V3-P0 `BudgetRedisLike` pattern).

export type {
  MemoryTurn,
  NewTurn,
  RepoDiff,
  RepoMemoryStore,
  RepoSnapshot,
  ResolvedEntity,
  SessionMemory,
  SessionMemoryStore,
} from "./contracts.js";
export { repoKeyOf } from "./contracts.js";

export {
  appendTurn,
  applySessionBounds,
  createMemorySessionStore,
  emptySession,
  mostRecentEntity,
} from "./sessionStore.js";
export {
  createRedisSessionStore,
  type MemoryRedisLike,
  type RedisSessionStoreOptions,
} from "./redisSessionStore.js";

export {
  createMemoryRepoStore,
  describeDiff,
  diffSnapshots,
  snapshotOf,
} from "./repoMemory.js";
