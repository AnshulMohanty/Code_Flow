import {
  SESSION_MAX_ANSWER_CHARS,
  SESSION_MAX_CHUNK_IDS,
  SESSION_MAX_ENTITIES,
  SESSION_MAX_TURNS,
} from "@codeflow/config";
import type { MemoryTurn, NewTurn, ResolvedEntity, SessionMemory, SessionMemoryStore } from "./contracts.js";

/**
 * Session memory (V3-P3), with the bounds applied in ONE place.
 *
 * `applySessionBounds` is exported and shared by every store implementation, in-memory and
 * Redis alike. That is deliberate: the bounds are a behavioural contract (how much of a
 * conversation the agent can see, and therefore what a follow-up can resolve against), not a
 * storage detail. Two implementations trimming differently would mean the SAME conversation
 * behaved differently depending on whether Redis happened to be configured — the class of bug
 * V3-P0 removed from the budget.
 */

/** A brand-new empty session. */
export function emptySession(sessionId: string, analysisId: string): SessionMemory {
  return { sessionId, analysisId, turns: [], retrievedChunkIds: [], resolvedEntities: [] };
}

/**
 * Fold a new turn into a session and re-apply every bound. Pure — no I/O, no clock, no RNG —
 * so a store's only job is to persist the result.
 *
 * The turn number is assigned HERE from the existing turns rather than taken from the caller:
 * two concurrent appends must not both claim to be turn 3, and a caller that tracked its own
 * counter would be the thing that got it wrong.
 */
export function appendTurn(session: SessionMemory, incoming: NewTurn): SessionMemory {
  const turnNumber = (session.turns.at(-1)?.turn ?? 0) + 1;
  const turn: MemoryTurn = {
    turn: turnNumber,
    question: incoming.question,
    // Truncated on the way IN, not on the way out: if the full answer were stored, the bound
    // would depend on every reader remembering to apply it.
    answer: truncate(incoming.answer, SESSION_MAX_ANSWER_CHARS),
    answered: incoming.answered,
    citations: incoming.citations,
    retrievedChunkIds: incoming.retrievedChunkIds,
    toolsUsed: incoming.toolsUsed,
  };

  // Newly resolved entities go to the FRONT (most recent first — the order "it" resolves in),
  // and a repeat mention is MOVED to the front rather than duplicated, so recency is the only
  // thing the order encodes.
  const fresh: ResolvedEntity[] = (incoming.entities ?? []).map((entity) => ({ ...entity, turn: turnNumber }));
  const merged: ResolvedEntity[] = [...fresh];
  const seen = new Set(fresh.map((entity) => `${entity.kind}:${entity.value}`));
  for (const existing of session.resolvedEntities) {
    const key = `${existing.kind}:${existing.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(existing);
  }

  const chunkIds = dedupeKeepingLatest([...session.retrievedChunkIds, ...incoming.retrievedChunkIds]);

  return applySessionBounds({
    ...session,
    turns: [...session.turns, turn],
    retrievedChunkIds: chunkIds,
    resolvedEntities: merged,
  });
}

/**
 * Enforce every session bound. Idempotent, so calling it twice is safe and a store can apply it
 * defensively after loading data written by an older version.
 *
 * Turns are dropped OLDEST first — a conversation's recent context is what a follow-up needs.
 * Chunk ids are trimmed from the OLDEST end for the same reason.
 */
export function applySessionBounds(session: SessionMemory): SessionMemory {
  return {
    ...session,
    turns: session.turns.slice(-SESSION_MAX_TURNS),
    retrievedChunkIds: session.retrievedChunkIds.slice(-SESSION_MAX_CHUNK_IDS),
    resolvedEntities: session.resolvedEntities.slice(0, SESSION_MAX_ENTITIES),
  };
}

/**
 * The entity a pronoun in a follow-up most likely refers to: the most recently resolved one,
 * optionally filtered by kind.
 *
 * Deliberately a SIMPLE rule — most-recent-first — and not an attempt at real coreference. A
 * heuristic that is stated and predictable is better here than one that is clever and
 * occasionally surprising, because the agent's prompt also receives the full entity list and the
 * model can override this choice with better judgement than a rule could encode.
 */
export function mostRecentEntity(session: SessionMemory, kind?: ResolvedEntity["kind"]): ResolvedEntity | null {
  for (const entity of session.resolvedEntities) {
    if (!kind || entity.kind === kind) return entity;
  }
  return null;
}

/**
 * The in-memory session store — the HERMETIC DEFAULT and a real single-process implementation.
 *
 * Honest about what it is: a conversation lives in one API process's heap, so it does not
 * survive a restart and a second replica sees a different conversation. That is fine for a demo
 * and wrong for production, which is why the Redis store exists and why the mode is reported
 * through `store.id`.
 */
export function createMemorySessionStore(): SessionMemoryStore {
  const sessions = new Map<string, SessionMemory>();

  return {
    id: "memory-session-store",

    async load(sessionId: string): Promise<SessionMemory | null> {
      const found = sessions.get(sessionId);
      // Deep-copied on the way out: a caller must not be able to mutate stored memory by
      // editing what it was handed, or two turns later the store's contents are a mystery.
      return found ? structuredClone(found) : null;
    },

    async append(sessionId: string, analysisId: string, turn: NewTurn): Promise<SessionMemory> {
      const existing = sessions.get(sessionId);
      // A session is scoped to ONE analysis. Appending under a different analysisId is not a
      // continuation, it is a new conversation about different code, and silently mixing the two
      // would let a follow-up resolve "it" to a file from another repository.
      const base = existing && existing.analysisId === analysisId ? existing : emptySession(sessionId, analysisId);
      const next = appendTurn(base, turn);
      sessions.set(sessionId, next);
      return structuredClone(next);
    },

    async clear(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
    },
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

/** Dedupe preserving the LAST occurrence's position, so recency survives the trim. */
function dedupeKeepingLatest(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.reverse();
}
