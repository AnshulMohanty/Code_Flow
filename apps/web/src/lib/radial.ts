import type { GraphModel, GraphModelNode } from "./graphModel";

/**
 * RADIAL LAYOUT — "RINGS = HOW FOUNDATIONAL" (V3-FINAL).
 *
 * THE ONE IDEA the design's caption states, and the layout has to earn it: a module's DISTANCE FROM
 * THE CENTRE is how foundational it is. Foundational means "much depends on it" — high fan-in — so
 * the most-depended-upon modules sit at the middle and leaves sit on the rim. That makes the picture
 * answer a question at a glance ("what is load-bearing here?") instead of being a hairball.
 *
 * WHY NOT A FORCE SIMULATION. The previous UI used `react-force-graph-2d`, which produces a
 * physically pleasing layout — but its positions are NON-DETERMINISTIC and encode nothing: two loads
 * of the same repository give two different pictures, and neither says which module is foundational.
 * A radial layout is a pure function of the graph, so the same analysis always draws the same map and
 * a reader can compare two runs. Reproducibility is worth more here than prettiness, and dropping the
 * dependency took ~90 kB of canvas + physics out of the bundle.
 *
 * DETERMINISM, precisely: ring by fan-in RANK (not raw fan-in, so one enormous hub cannot flatten
 * every other ring), angle by position in a stably-sorted order within the ring. No RNG, no clock,
 * no iteration-order dependence.
 */

export interface RadialNode {
  id: string;
  label: string;
  /** 0 = centre ring. */
  ring: number;
  /** Radians. */
  angle: number;
  x: number;
  y: number;
  /** Dot radius, from fan-in — so the two encodings agree rather than competing. */
  radius: number;
  fanIn: number;
  fanOut: number;
  role: string;
  /** Shown as a text label. Only the most foundational few get one; the rest would be unreadable. */
  labelled: boolean;
}

export interface RadialEdge {
  from: string;
  to: string;
  /** Path from `from` to `to`, curved toward the centre so bundles read as flows. */
  path: string;
}

export interface RadialLayout {
  nodes: RadialNode[];
  edges: RadialEdge[];
  /** Ring radii, for drawing the guide circles. */
  rings: number[];
  /** Layout box; the SVG uses this as its viewBox. */
  size: number;
}

/** Rings, including the centre. More than this and the outer rings crowd. */
export const RADIAL_RINGS = 5;
/** How many nodes get a text label. The most foundational ones — the rest are dots. */
export const RADIAL_LABELS = 6;
/** Nodes drawn. Beyond this the picture stops being readable; the count shown is always the FULL
 *  one, so "31 modules" never becomes "31 modules, some of which we drew". */
export const RADIAL_MAX_NODES = 64;

export function radialLayout(model: GraphModel, size = 560): RadialLayout {
  const centre = size / 2;
  const maxRadius = centre * 0.86;

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const node of model.nodes) {
    fanIn.set(node.id, 0);
    fanOut.set(node.id, 0);
  }
  for (const link of model.links) {
    fanIn.set(link.target, (fanIn.get(link.target) ?? 0) + 1);
    fanOut.set(link.source, (fanOut.get(link.source) ?? 0) + 1);
  }

  // Most foundational first. The tie-break is the file id, so the order — and therefore every
  // position — is identical across runs.
  const ranked = [...model.nodes].sort(
    (a, b) => (fanIn.get(b.id) ?? 0) - (fanIn.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );
  const drawn = ranked.slice(0, RADIAL_MAX_NODES);

  // Ring by RANK, in equal-sized bands. Rank rather than raw fan-in because one hub with 200
  // importers would otherwise put every other module on the rim and the rings would encode nothing.
  const perRing = Math.max(1, Math.ceil(drawn.length / RADIAL_RINGS));
  const byRing = new Map<number, GraphModelNode[]>();
  drawn.forEach((node, index) => {
    const ring = Math.min(RADIAL_RINGS - 1, Math.floor(index / perRing));
    const bucket = byRing.get(ring) ?? [];
    bucket.push(node);
    byRing.set(ring, bucket);
  });

  const nodes: RadialNode[] = [];
  const position = new Map<string, { x: number; y: number }>();

  for (const [ring, members] of [...byRing.entries()].sort((a, b) => a[0] - b[0])) {
    // The centre ring sits at a small non-zero radius: stacking several nodes at the exact centre
    // would overlap them into one dot and lose the thing the middle is meant to show.
    const radius = ring === 0 ? maxRadius * 0.1 : (maxRadius * (ring + 0.55)) / RADIAL_RINGS;
    members.forEach((node, index) => {
      // A per-ring angular offset so adjacent rings do not line up into visual spokes.
      const angle = (index / members.length) * Math.PI * 2 - Math.PI / 2 + ring * 0.35;
      const x = centre + Math.cos(angle) * radius;
      const y = centre + Math.sin(angle) * radius;
      position.set(node.id, { x, y });
      const inbound = fanIn.get(node.id) ?? 0;
      nodes.push({
        id: node.id,
        label: node.name,
        ring,
        angle,
        x,
        y,
        radius: 2.6 + Math.min(5.4, Math.sqrt(inbound) * 1.5),
        fanIn: inbound,
        fanOut: fanOut.get(node.id) ?? 0,
        role: node.role,
        labelled: nodes.length < RADIAL_LABELS,
      });
    });
  }

  const drawnIds = new Set(nodes.map((node) => node.id));
  const edges: RadialEdge[] = model.links
    .filter((link) => drawnIds.has(link.source) && drawnIds.has(link.target))
    .map((link) => {
      const from = position.get(link.source)!;
      const to = position.get(link.target)!;
      // A quadratic curve whose control point is pulled toward the centre. Straight chords across a
      // radial layout cross each other into noise; curving inward makes bundles of edges that share
      // a destination read as one flow, which is the shape a dependency graph actually has.
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
      const controlX = midX + (centre - midX) * 0.45;
      const controlY = midY + (centre - midY) * 0.45;
      return {
        from: link.source,
        to: link.target,
        path: `M${round(from.x)},${round(from.y)} Q${round(controlX)},${round(controlY)} ${round(to.x)},${round(to.y)}`,
      };
    });

  const rings = Array.from({ length: RADIAL_RINGS }, (_, ring) =>
    ring === 0 ? maxRadius * 0.1 : (maxRadius * (ring + 0.55)) / RADIAL_RINGS,
  );

  return { nodes, edges, rings, size };
}

/** One decimal. Keeps the emitted path short and — more usefully — byte-identical across runs. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Which nodes and edges light up when one module is selected: the module, everything that imports it,
 * and everything it imports. One hop, deliberately — a transitive highlight on a central module
 * lights the whole graph and tells a reader nothing.
 */
export function radialFocus(model: GraphModel, fileId: string | null): { nodes: Set<string>; edges: Set<string> } {
  if (!fileId) return { nodes: new Set(), edges: new Set() };
  const nodes = new Set<string>([fileId]);
  const edges = new Set<string>();
  for (const link of model.links) {
    if (link.source === fileId) {
      nodes.add(link.target);
      edges.add(edgeKey(link.source, link.target));
    } else if (link.target === fileId) {
      nodes.add(link.source);
      edges.add(edgeKey(link.source, link.target));
    }
  }
  return { nodes, edges };
}

/**
 * Separator for the edge key. NUL, because it is the one character a repo-relative POSIX path cannot
 * contain -- so `a|b` and `a` + `|b` can never collide into the same key and light the wrong edge.
 *
 * Built with `String.fromCharCode(0)` rather than embedded as a literal control byte. A raw 0x00 in
 * the source makes every tool treat the file as BINARY -- grep skips it, a diff refuses to show it,
 * and a copy-paste can silently drop the byte. That exact mistake was in the observability tracer
 * and was fixed the same way; this avoids repeating it.
 */
const EDGE_KEY_SEPARATOR = String.fromCharCode(0);

export function edgeKey(from: string, to: string): string {
  return `${from}${EDGE_KEY_SEPARATOR}${to}`;
}
