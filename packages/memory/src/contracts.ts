import type { RepositoryRef } from "@codeflow/shared-types";

/**
 * `@codeflow/memory` — session and repository memory for the agentic Q&A path (V3-P3).
 *
 * TWO KINDS OF MEMORY, and they are genuinely different things:
 *
 *   SESSION memory is what makes a conversation a conversation. "What about its callers?" is
 *   unanswerable without knowing what "it" was. It holds the turns, the chunk ids already
 *   retrieved, and the entities (files, symbols) resolved so far.
 *
 *   REPO memory is what makes "what changed?" answerable. It holds a small deterministic
 *   SNAPSHOT per analysed commit, so two snapshots can be diffed into an answer without
 *   re-analysing anything or keeping whole results around.
 *
 * EVERYTHING IS BOUNDED. That is not a nicety here: memory feeds the agent's prompt, so
 * unbounded memory is a context-budget bug that grows silently until a request starts costing
 * three times what it did last week. Every store caps what it keeps, the caps are named
 * constants, and dropping is explicit rather than emergent.
 *
 * INJECTABLE, in-memory by default. The hermetic suite and a single-container demo use the
 * in-memory stores; production swaps a Redis-backed session store behind the same interface
 * (Redis reached through an injected `MemoryRedisLike`, the V3-P0 `BudgetRedisLike` pattern, so
 * this package depends on no driver). Nothing here does I/O of its own.
 */

// -- Session memory -------------------------------------------------------------------

/** An entity the conversation has resolved — what a pronoun in a follow-up refers to. */
export interface ResolvedEntity {
  kind: "file" | "symbol";
  /** A fileId, or a symbol name. */
  value: string;
  /** The fileId a symbol was found in, when known — so a follow-up can scope a search. */
  fileId?: string;
  /** Index of the turn that introduced it. Later turns win when resolving "it". */
  turn: number;
}

/** One completed question/answer exchange. */
export interface MemoryTurn {
  /** 1-based, in order. */
  turn: number;
  question: string;
  /** The answer text, TRUNCATED to a bounded length — memory is a prompt input, not an archive. */
  answer: string;
  /** Whether the agent actually answered, or honestly refused. Both are worth remembering:
   *  a refusal tells the next turn what has already been tried and failed. */
  answered: boolean;
  /** Grounded citations from that answer. */
  citations: Array<{ fileId: string; startLine?: number; endLine?: number }>;
  /** Chunk ids retrieved while answering it. */
  retrievedChunkIds: string[];
  /** Tool ids used. Lets the tool router skip a tool that has already produced nothing. */
  toolsUsed: string[];
}

/** Everything the agent remembers about one conversation. */
export interface SessionMemory {
  sessionId: string;
  /** The analysis this conversation is about — a session must never mix two repositories. */
  analysisId: string;
  /** Most recent LAST. Bounded (see SESSION_MAX_TURNS). */
  turns: MemoryTurn[];
  /** Union of chunk ids retrieved across the session, bounded and deduped. Lets a later turn
   *  avoid re-reading the same chunk, and lets grounding accept a citation from an earlier turn. */
  retrievedChunkIds: string[];
  /** Resolved entities, most recent FIRST — the order a pronoun resolves in. Bounded. */
  resolvedEntities: ResolvedEntity[];
}

/**
 * Where session memory lives. `append` returns the memory AFTER the append so a caller never
 * has to re-read to see its own write.
 */
export interface SessionMemoryStore {
  readonly id: string;
  load(sessionId: string): Promise<SessionMemory | null>;
  /** Append a turn, applying the bounds. Creates the session when absent. */
  append(sessionId: string, analysisId: string, turn: NewTurn): Promise<SessionMemory>;
  clear(sessionId: string): Promise<void>;
}

/** What a caller supplies for a new turn — `turn` is assigned by the store, not the caller,
 *  so two concurrent appends cannot both claim to be turn 3. */
export type NewTurn = Omit<MemoryTurn, "turn"> & {
  /** Entities this turn resolved. The store stamps them with the assigned turn number. */
  entities?: Array<Omit<ResolvedEntity, "turn">>;
};

// -- Repo memory ----------------------------------------------------------------------

/**
 * A small deterministic summary of one analysed commit — enough to diff, and nothing more.
 *
 * Deliberately NOT the whole `AnalysisResult`: keeping results around per SHA is how a memory
 * layer turns into a second database. This is fileIds, edges as `from>to` strings, symbol names
 * per file, and the cycle sets — all sorted, so two snapshots of the same tree are byte-identical
 * and a diff of them is empty by construction rather than by luck.
 */
export interface RepoSnapshot {
  repoFullName: string;
  commitSha: string;
  /** Sorted fileIds. */
  fileIds: string[];
  /** Sorted `from>to` dependency edges. */
  edges: string[];
  /** fileId -> sorted symbol names. Only files that have symbols appear. */
  symbolsByFile: Record<string, string[]>;
  /** Sorted, each a sorted `a|b|c` cycle key. */
  cycles: string[];
  /** When the snapshot was taken, ISO. Supplied by the caller — this package reads no clock,
   *  because a clock read inside a pure derivation makes it untestable and non-reproducible. */
  capturedAt: string;
}

/** What changed between two snapshots of one repository. */
export interface RepoDiff {
  repoFullName: string;
  fromSha: string;
  toSha: string;
  addedFiles: string[];
  removedFiles: string[];
  /** Files present in both whose SYMBOL SET changed — the closest thing to "this file changed"
   *  available without hashing contents, and more meaningful than a byte diff for onboarding. */
  changedFiles: Array<{ fileId: string; addedSymbols: string[]; removedSymbols: string[] }>;
  addedEdges: string[];
  removedEdges: string[];
  /** Cycles that appear only in `to` — the single most useful regression signal in a diff. */
  newCycles: string[];
  resolvedCycles: string[];
  /** True when nothing at all differs. */
  identical: boolean;
}

/**
 * Where repo snapshots live. Bounded per repository (see REPO_MAX_SNAPSHOTS) — the point is
 * "what changed recently", not a full history, and an unbounded store would grow forever for a
 * feature nobody asked to be exhaustive.
 */
export interface RepoMemoryStore {
  readonly id: string;
  put(snapshot: RepoSnapshot): Promise<void>;
  /** Snapshots for a repository, most recent FIRST. */
  list(repoFullName: string): Promise<RepoSnapshot[]>;
  get(repoFullName: string, commitSha: string): Promise<RepoSnapshot | null>;
  clear(repoFullName: string): Promise<void>;
}

/** `owner/name`, or the bare name for a local/zip repo. The one canonical key form. */
export function repoKeyOf(ref: RepositoryRef): string {
  return ref.owner ? `${ref.owner}/${ref.name}` : ref.name;
}
