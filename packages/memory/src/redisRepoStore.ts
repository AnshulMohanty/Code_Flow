import { REPO_MAX_SNAPSHOTS } from "@codeflow/config";
import type { RepoMemoryStore, RepoSnapshot } from "./contracts.js";

/**
 * THE REDIS-BACKED REPO-SNAPSHOT STORE (V3-P5 task 5, ledger #21).
 *
 * WHAT WAS WRONG. `what_changed` compares snapshots of a repository across commits, and the store
 * holding them was a process-local Map. So after any API restart the tool reported "only one commit
 * analysed" — for a feature whose entire value is remembering the previous one — and two replicas
 * each remembered a different half of the history. V3-P3 named this as a P5 wiring task rather than
 * half-building it then; this is that wiring.
 *
 * A HASH, NOT A LIST OR A SORTED SET, and the reason is the dedup rule rather than convenience.
 * `put` must OVERWRITE the same commit SHA (re-analysing a commit produces an identical snapshot; an
 * append would waste one of the ten slots and make `list()` lie about how many commits are known).
 * A hash field IS that upsert, and it is atomic per field — which matters here because the
 * alternative, read-modify-write on one JSON blob, silently loses a snapshot whenever two replicas
 * put different commits at the same time. With a hash both land.
 *
 * ORDER COMES FROM `capturedAt` INSIDE THE VALUES, not from Redis. That keeps this adapter free of
 * clock reads (the property `snapshotOf` was built around) and means a hash — which has no order —
 * is sufficient. `hgetall` then returns everything for `list()` in ONE round trip, which a sorted
 * set plus N payload fetches could not.
 *
 * BOUNDED BY A TTL *AND* BY COUNT, because they bound different things: the count bounds how much
 * history one repository keeps (the product decision, `REPO_MAX_SNAPSHOTS`), and the TTL bounds how
 * long a repository nobody asks about occupies memory (the operational one). Neither alone is
 * enough — a count-only bound leaks a key per repository forever, and a TTL-only bound lets a
 * heavily-analysed repository grow without limit inside its window.
 *
 * INTEGRATION-ONLY, same arrangement as the session store: the hermetic suite drives it against a
 * fake, and a live round trip is in the deferred manual bucket. What can actually be wrong in this
 * file is the key scheme, the dedup, the ordering, the trim and the serialisation — all of which a
 * fake exercises exactly.
 */

/** The Redis subset this store needs. Structurally satisfied by an `ioredis` instance. */
export interface RepoRedisLike {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisRepoStoreOptions {
  redis: RepoRedisLike;
  /** Key prefix. Namespaced so a shared Redis can also hold sessions, the budget and the cache. */
  keyPrefix?: string;
  /** How long a repository's history survives with no writes. Default 30 days. */
  ttlSeconds?: number;
  /** Max snapshots kept per repository. Defaults to the shared constant. */
  maxSnapshots?: number;
  onError?(error: unknown, operation: string): void;
}

const DEFAULT_PREFIX = "codeflow:repo";
/**
 * 30 days. Longer than a session's 24h by two orders of scale, deliberately: a conversation is
 * abandoned in minutes, whereas "what changed since last month's release" is the exact question
 * this data exists to answer, and expiring it at 24h would make the feature useless while looking
 * like it worked.
 */
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export function createRedisRepoStore(options: RedisRepoStoreOptions): RepoMemoryStore {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const maxSnapshots = options.maxSnapshots ?? REPO_MAX_SNAPSHOTS;
  const key = (repoFullName: string) => `${prefix}:${repoFullName}`;

  /**
   * Redis failures FAIL SOFT, matching the session store's judgement and for the same reason with
   * a smaller cost: a lost snapshot means `what_changed` reports less history than it could, which
   * degrades one answer. A 500 on the Q&A endpoint because a memory write failed would be worse.
   * Reported, never swallowed silently.
   */
  const report = (error: unknown, operation: string) => options.onError?.(error, operation);

  /** Newest first, by `capturedAt` then SHA. The SHA tiebreak keeps `list()` a TOTAL order, so two
   *  snapshots captured in the same millisecond do not swap places between calls. */
  const sortNewestFirst = (snapshots: RepoSnapshot[]): RepoSnapshot[] =>
    snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.commitSha.localeCompare(a.commitSha));

  const readAll = async (repoFullName: string): Promise<RepoSnapshot[]> => {
    const raw = await options.redis.hgetall(key(repoFullName));
    const out: RepoSnapshot[] = [];
    for (const value of Object.values(raw ?? {})) {
      try {
        out.push(JSON.parse(value) as RepoSnapshot);
      } catch {
        // One corrupt field must not poison the whole history. Skipped, not thrown: the remaining
        // snapshots are still a usable answer, and a diff against nine commits beats an error.
      }
    }
    return sortNewestFirst(out);
  };

  return {
    id: "redis-repo-store",

    async put(snapshot: RepoSnapshot): Promise<void> {
      try {
        // `hset` on the SHA field is the upsert: re-analysing a commit replaces its snapshot
        // rather than adding a second copy.
        await options.redis.hset(key(snapshot.repoFullName), snapshot.commitSha, JSON.stringify(snapshot));
        // TTL refreshed on every write, so an actively-analysed repository never expires while a
        // dormant one eventually does.
        await options.redis.expire(key(snapshot.repoFullName), ttl);

        // Trim oldest-first past the bound. Read-then-delete, so a concurrent put could in
        // principle over-trim by one — accepted deliberately: the cost is one forgotten commit in
        // a race, versus holding a lock on the hot path of a feature that tolerates gaps.
        const all = await readAll(snapshot.repoFullName);
        if (all.length > maxSnapshots) {
          const doomed = all.slice(maxSnapshots).map((entry) => entry.commitSha);
          if (doomed.length) await options.redis.hdel(key(snapshot.repoFullName), ...doomed);
        }
      } catch (error) {
        report(error, "put");
      }
    },

    async list(repoFullName: string): Promise<RepoSnapshot[]> {
      try {
        const all = await readAll(repoFullName);
        // Bound re-applied on READ as well as write: a hash written by an older build (or one that
        // lost a trim to a race) must not be able to return more history than the contract allows,
        // because callers size prompts against that bound.
        return all.slice(0, maxSnapshots);
      } catch (error) {
        report(error, "list");
        // EMPTY, not a throw. An empty history is a state the caller already handles ("only one
        // commit analysed"); an exception here would fail a question that has nothing to do with
        // memory.
        return [];
      }
    },

    async get(repoFullName: string, commitSha: string): Promise<RepoSnapshot | null> {
      try {
        const raw = await options.redis.hget(key(repoFullName), commitSha);
        return raw ? (JSON.parse(raw) as RepoSnapshot) : null;
      } catch (error) {
        report(error, "get");
        return null;
      }
    },

    async clear(repoFullName: string): Promise<void> {
      try {
        await options.redis.del(key(repoFullName));
      } catch (error) {
        report(error, "clear");
      }
    },
  };
}
