import type { ProgressEvent } from "@codeflow/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamJobEvents } from "./apiClient";

// Minimal fake EventSource (jsdom has none) to assert streamJobEvents parses the REAL
// ProgressEvent shape + the terminal done frame.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  closed = false;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamJobEvents (#19 shape)", () => {
  it("parses per-stage ProgressEvents and the terminal done frame", () => {
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);

    const stageEvents: ProgressEvent[] = [];
    let done: { jobId: string; status: string } | null = null;
    streamJobEvents("job-1", {
      onStageEvent: (e) => stageEvents.push(e),
      onDone: (d) => (done = d),
    });

    const source = FakeEventSource.last!;
    const event: ProgressEvent = {
      jobId: "job-1",
      stage: "connect",
      stageIndex: 5,
      stageCount: 8,
      kind: "deterministic",
      status: "completed",
      label: "Connect",
      detail: "Built graph: 4 nodes, 2 edges.",
      preview: { nodes: 4, edges: 2 },
      progress: 5 / 8,
      startedAt: "2026-06-10T00:00:00.000Z",
      durationMs: 130,
      emittedAt: "2026-06-10T00:00:00.130Z",
    };
    source.emit("progress", event);
    source.emit("done", { jobId: "job-1", status: "partial" });

    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0].stageIndex).toBe(5);
    expect(stageEvents[0].label).toBe("Connect");
    expect(stageEvents[0].preview).toEqual({ nodes: 4, edges: 2 });
    expect(done).toEqual({ jobId: "job-1", status: "partial" });
    expect(source.closed).toBe(true); // terminal closes the stream
  });

  it("returns null when EventSource is unavailable (test/SSR ⇒ caller polls)", () => {
    expect(streamJobEvents("job-1", {})).toBeNull();
  });
});
