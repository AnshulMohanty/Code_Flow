import { describe, expect, it } from "vitest";
import type { GraphModel } from "./graphModel";
import { backboneView, focusView, fullView } from "./graphView";

function model(
  nodes: Array<{ id: string; centrality?: number }>,
  links: Array<[string, string]>,
): GraphModel {
  return {
    nodes: nodes.map((n) => ({ id: n.id, path: n.id, name: n.id, role: "source", centrality: n.centrality ?? 0, loc: 0, inCycle: false, size: 3 })),
    links: links.map(([source, target]) => ({ source, target, kind: "import" as const, inCycle: false })),
    nodeCount: nodes.length,
    linkCount: links.length,
    unresolvedCount: 0,
    externalCount: 0,
  };
}

describe("graphView — backbone (top-N by centrality)", () => {
  const m = model(
    [
      { id: "a", centrality: 5 },
      { id: "b", centrality: 4 },
      { id: "c", centrality: 3 },
      { id: "d", centrality: 2 },
      { id: "e", centrality: 1 },
    ],
    [
      ["a", "b"],
      ["b", "c"],
      ["d", "e"],
    ],
  );

  it("selects the N most-central files + only induced edges, with honest N-of-M", () => {
    const view = backboneView(m, 2);
    expect(view.nodes.map((n) => n.id)).toEqual(["a", "b"]); // top-2 by centrality
    expect(view.shownCount).toBe(2);
    expect(view.totalCount).toBe(5);
    expect(view.truncated).toBe(true);
    expect(view.links).toEqual([{ source: "a", target: "b", kind: "import", inCycle: false }]); // induced
  });

  it("fullView shows everything, not truncated", () => {
    const view = fullView(m);
    expect(view.shownCount).toBe(5);
    expect(view.truncated).toBe(false);
    expect(view.links).toHaveLength(3);
  });
});

describe("graphView — focus (k-hop neighbourhood, undirected)", () => {
  // chain a — b — c — d
  const m = model([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], [["a", "b"], ["b", "c"], ["c", "d"]]);

  it("1-hop from b → {a, b, c}", () => {
    const view = focusView(m, "b", 1);
    expect(view.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(view.mode).toBe("focus");
    expect(view.focusId).toBe("b");
  });

  it("2-hop from b → the whole chain", () => {
    expect(focusView(m, "b", 2).nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("unknown id → empty focus view (no crash)", () => {
    const view = focusView(m, "zzz", 1);
    expect(view.nodes).toEqual([]);
    expect(view.totalCount).toBe(4);
  });
});

describe("graphView — empty model", () => {
  it("degrades gracefully (no nodes, not truncated)", () => {
    const view = backboneView(model([], []), 10);
    expect(view.nodes).toEqual([]);
    expect(view.truncated).toBe(false);
  });
});
