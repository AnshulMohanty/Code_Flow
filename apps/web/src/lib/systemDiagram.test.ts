import { describe, expect, it } from "vitest";
import { assignLanes, classifyEdges } from "./architecture";
import type { GraphModel } from "./graphModel";
import { BOARD_H, BOARD_W, buildSystemDiagram, placeLabels, shortSpecifier } from "./systemDiagram";

/**
 * The routed board for TAB 01 is a drawing of real data: every box a real module in its real lane,
 * every link a real classified import. These pin that, and the geometry rules that keep it legible.
 */

function model(edges: Array<[string, string]>): GraphModel {
  const ids = [...new Set(edges.flat())];
  return {
    nodes: ids.map((id) => ({ id, path: id, name: id, role: "source", centrality: 0, loc: 0, inCycle: false, size: 1 })),
    links: edges.map(([source, target]) => ({ source, target, kind: "import" as const, inCycle: false })),
    nodeCount: ids.length,
    linkCount: edges.length,
    unresolvedCount: 0,
    externalCount: 0,
  };
}

const graph = model([
  ["src/cli/main.ts", "src/core/engine.ts"],
  ["src/server/route.ts", "src/api/users.ts"],
  ["src/api/users.ts", "src/core/engine.ts"],
  ["src/api/users.ts", "src/db/pool.ts"],
  ["src/core/engine.ts", "src/lib/log.ts"],
]);
const lanes = assignLanes(graph.nodes.map((node) => ({ fileId: node.id, path: node.path, role: "source" })));
const classified = classifyEdges(graph, lanes);
const specifiers = new Map([["src/api/users.ts>src/db/pool.ts", { specifier: "../db/pool.js" }]]);

const diagram = buildSystemDiagram({
  lanes,
  edges: classified.edges,
  downstream: () => 0,
  specifier: (from, to) => specifiers.get(`${from}>${to}`),
});

describe("buildSystemDiagram", () => {
  it("draws one frame per NON-EMPTY lane and one box per module", () => {
    expect(diagram.boxes.map((box) => box.id).sort()).toEqual(graph.nodes.map((node) => node.id).sort());
    expect(new Set(diagram.groups.map((group) => group.lane)).size).toBe(diagram.groups.length);
    for (const group of diagram.groups) expect(group.total).toBeGreaterThan(0);
  });

  it("keeps every box inside its frame and on the board", () => {
    for (const box of diagram.boxes) {
      const frame = diagram.groups.find((group) => group.lane === box.lane)!;
      expect(box.x).toBeGreaterThanOrEqual(frame.x);
      expect(box.y).toBeGreaterThanOrEqual(frame.y);
      expect(box.x + box.w).toBeLessThanOrEqual(frame.x + frame.w);
      expect(box.y + box.h).toBeLessThanOrEqual(frame.y + frame.h);
      expect(box.x + box.w).toBeLessThanOrEqual(BOARD_W);
      expect(box.y + box.h).toBeLessThanOrEqual(BOARD_H);
    }
  });

  it("links only real edges, keeping their class, and labels them with the import as written", () => {
    expect(diagram.links).toHaveLength(graph.links.length);
    const violation = diagram.links.find((link) => link.from === "src/api/users.ts" && link.to === "src/db/pool.ts")!;
    expect(violation.cls).toBe("violation");
    expect(violation.label).toBe("pool");
    // No specifier recorded ⇒ a neutral word, not an invented call name.
    const other = diagram.links.find((link) => link.from === "src/cli/main.ts")!;
    expect(other.label).toBe("import");
  });

  it("routes orthogonally — every segment horizontal or vertical", () => {
    for (const link of diagram.links) {
      for (let i = 0; i < link.points.length - 1; i++) {
        const [a, b] = [link.points[i], link.points[i + 1]];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      }
    }
  });

  it("never overlaps two placed labels", () => {
    const labels = placeLabels(diagram, diagram.links);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const same = Math.abs(labels[i].x - labels[j].x) < 1 && Math.abs(labels[i].y - labels[j].y) < 1;
        expect(same).toBe(false);
      }
    }
  });
});

describe("shortSpecifier", () => {
  it("keeps the meaningful part of an import specifier", () => {
    expect(shortSpecifier("@codeflow/shared-types")).toBe("shared-types");
    expect(shortSpecifier("../lib/useMeta.js")).toBe("useMeta");
    expect(shortSpecifier("./components/index.ts")).toBe("components");
  });
});
