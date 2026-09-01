/**
 * VERSIONED BLACKBOARD for full run replay (V3-P5 task 2).
 *
 * WHAT V3-P4's BLACKBOARD ALREADY DID: collected structured findings so a supervisor could read a
 * bounded selection. What it could NOT do: tell you what the blackboard looked like at the moment
 * the supervisor read it. By the time a run finishes, the blackboard holds every finding — so
 * "why did the supervisor say that?" is unanswerable, because the input it actually saw is gone.
 *
 * This wraps it in an APPEND-ONLY VERSION LOG. Every write produces a new version with the writer,
 * the reason and a monotonic sequence number; a read can be recorded against the version it saw. So
 * a run becomes replayable: pick a version, and you have exactly the state a given agent reasoned
 * over.
 *
 * APPEND-ONLY IS THE WHOLE DESIGN. A mutable blackboard with a "history" field alongside it would
 * let the two disagree, and the first time they did, the history would be the thing that looked
 * authoritative while being wrong. Here the current state IS the last version — there is nowhere for
 * a second truth to live.
 *
 * BOUNDED, for the same reason V3-P3's memory is: a version log that grows without limit is a memory
 * leak in a long-lived worker. Old versions are dropped OLDEST-first and the drop is REPORTED, so a
 * replay that cannot reach far enough back says so rather than silently starting mid-run.
 */

export interface BlackboardVersion<T> {
  /** Monotonic from 1. Gaps mean versions were trimmed — see `trimmedBefore`. */
  version: number;
  /** Who wrote it — an agent id, a stage id, "supervisor". */
  writer: string;
  /** Why. Free-form, and worth the bytes: a version log without reasons is a diff nobody can read. */
  reason: string;
  /** Milliseconds relative to the log's creation. Injected clock — no wall-clock reads. */
  atMs: number;
  /** The state AFTER this write. Deep-frozen, so a holder cannot mutate history. */
  state: T;
}

/** A recorded read: which version an actor actually saw. This is what makes a decision explainable. */
export interface BlackboardRead {
  reader: string;
  version: number;
  atMs: number;
  /** What the reader took, when it took a subset (e.g. the supervisor's bounded selection). */
  note?: string;
}

export interface VersionedBlackboardReport<T> {
  versions: BlackboardVersion<T>[];
  reads: BlackboardRead[];
  /** Lowest version still retained. > 1 means older ones were trimmed. */
  trimmedBefore: number;
  /** Total writes ever, including trimmed ones — so a count is never misread as "all of them". */
  totalWrites: number;
}

export interface VersionedBlackboardOptions {
  /** Versions retained. Default 50 — enough for a full fan-out, bounded for a long-lived worker. */
  maxVersions?: number;
  /** Injectable clock (ms, relative). */
  clock?: () => number;
}

export interface VersionedBlackboard<T> {
  /** Append a new version. Returns its number. */
  write(state: T, writer: string, reason: string): number;
  /** The current state, or null before the first write. */
  current(): T | null;
  /** The current version number, 0 before the first write. */
  currentVersion(): number;
  /** Read the current state AND record who read it — the pairing that makes replay meaningful. */
  read(reader: string, note?: string): { version: number; state: T | null };
  /** The state at a specific version, or null when it was trimmed or never existed. */
  at(version: number): T | null;
  report(): VersionedBlackboardReport<T>;
}

const DEFAULT_MAX_VERSIONS = 50;

export function createVersionedBlackboard<T>(options: VersionedBlackboardOptions = {}): VersionedBlackboard<T> {
  const maxVersions = Math.max(1, options.maxVersions ?? DEFAULT_MAX_VERSIONS);
  const started = Date.now();
  const clock = options.clock ?? (() => Date.now() - started);

  const versions: BlackboardVersion<T>[] = [];
  const reads: BlackboardRead[] = [];
  let totalWrites = 0;

  return {
    write(state, writer, reason) {
      totalWrites += 1;
      versions.push({
        version: totalWrites,
        writer,
        reason,
        atMs: clock(),
        // Structured-cloned on the way IN. Without this the log would hold a reference the writer
        // can keep mutating, and "the state at version 3" would silently become "the state now".
        state: structuredClone(state),
      });
      if (versions.length > maxVersions) versions.splice(0, versions.length - maxVersions);
      return totalWrites;
    },

    current() {
      const latest = versions.at(-1);
      return latest ? structuredClone(latest.state) : null;
    },

    currentVersion() {
      return totalWrites;
    },

    read(reader, note) {
      const latest = versions.at(-1);
      reads.push({
        reader,
        version: totalWrites,
        atMs: clock(),
        ...(note ? { note } : {}),
      });
      return { version: totalWrites, state: latest ? structuredClone(latest.state) : null };
    },

    at(version) {
      const found = versions.find((entry) => entry.version === version);
      return found ? structuredClone(found.state) : null;
    },

    report() {
      return {
        versions: versions.map((entry) => ({ ...entry, state: structuredClone(entry.state) })),
        reads: [...reads],
        trimmedBefore: versions[0]?.version ?? 1,
        totalWrites,
      };
    },
  };
}

/**
 * Render a version log as prose. What a replay session reads first.
 *
 * Reads are interleaved with writes at their version, because the interesting question is always
 * "what had been written by the time X read it" — and a log that listed them separately would make
 * the reader do that join by hand.
 */
export function renderBlackboardHistory<T>(report: VersionedBlackboardReport<T>): string {
  const lines = [
    `blackboard — ${report.totalWrites} write(s), ${report.reads.length} read(s)` +
      (report.trimmedBefore > 1 ? `, versions before ${report.trimmedBefore} were TRIMMED` : ""),
  ];
  const readsByVersion = new Map<number, BlackboardRead[]>();
  for (const entry of report.reads) {
    const bucket = readsByVersion.get(entry.version) ?? [];
    bucket.push(entry);
    readsByVersion.set(entry.version, bucket);
  }
  for (const version of report.versions) {
    lines.push(`  v${version.version} @${version.atMs}ms by ${version.writer}: ${version.reason}`);
    for (const entry of readsByVersion.get(version.version) ?? []) {
      lines.push(`      ↳ read by ${entry.reader}${entry.note ? ` (${entry.note})` : ""} @${entry.atMs}ms`);
    }
  }
  return lines.join("\n");
}
