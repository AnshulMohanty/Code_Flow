import type { GraphModel } from "./graphModel";

/**
 * THE HERO MAP — a real dependency graph, laid out the way the design draws one.
 *
 * Everything drawn is a real module and every line a real resolved import from ONE analysis (the
 * bundled snapshot, or the visitor's own run). The layout is the design's radial system map:
 *
 *   ring   = how foundational a module is. The CENTRE holds the modules with the most code
 *            downstream of them (a change there reaches the most files); leaves sit on the rim.
 *   wedge  = the module's area — its package or top-level directory — so a subsystem reads as a
 *            contiguous sector. That is a fact from the path, not an inference.
 *
 * What it does NOT do is draw all of a large repository: a few hundred dots would be a hairball and
 * say nothing. It draws the most connected modules and STATES the cut ("64 of 472 modules") wherever
 * it is labelled. Hover figures — downstream count and hop depth — are computed over the FULL graph,
 * so the number a reader sees is the true blast radius, not the radius inside the drawing.
 *
 * Pure and deterministic: the same analysis always produces the same picture.
 */

export interface HeroNode {
  id: string;
  label: string;
  area: string;
  /** 0 = centre ring. */
  ring: number;
  angle: number;
  /** Final world position (the canvas centres and scales the whole layout). */
  x: number;
  y: number;
  radius: number;
  /** Resolved edges in either direction, within the FULL graph. */
  degree: number;
  /** Modules that transitively import this one (full graph). */
  downstream: number;
  /** Longest shortest-path among those importers — how far a change travels. */
  hops: number;
  /** Index of the area in `areas`, for colour. */
  areaIndex: number;
}

export interface HeroEdge {
  /** Index of the importer in `nodes`. */
  from: number;
  /** Index of the imported module in `nodes`. */
  to: number;
}

export interface HeroGraphLayout {
  nodes: HeroNode[];
  edges: HeroEdge[];
  ringRadii: number[];
  areas: string[];
  /** Modules drawn vs in the analysis — stated in the label, never hidden. */
  drawn: number;
  total: number;
  totalEdges: number;
}

export const HERO_MAX_NODES = 56;
const RINGS = 5;
const R0 = 74;
const RING_GAP = 62;
const MIN_ARC = 52;

/**
 * A short, recognisable name: `packages/shared-types/src/index.ts` → `shared-types`,
 * `apps/web/src/site/Hero.tsx` → `site/Hero`. `src` carries no meaning in a label and an `index`
 * file is named for its directory, which is how people refer to it.
 */
export function heroLabel(path: string): string {
  const segments = path.replace(/\.[^./]+$/, "").split("/").filter((segment) => segment !== "src");
  const last = segments[segments.length - 1];
  if ((last === "index" || last === "__init__" || last === "mod") && segments.length > 1) {
    return segments[segments.length - 2];
  }
  return segments.slice(-2).join("/");
}

/** `apps/web/src/x.ts` → `apps/web`; `src/lib/x.ts` → `src`; `README.md` → `(root)`. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(root)";
  if ((parts[0] === "apps" || parts[0] === "packages" || parts[0] === "libs" || parts[0] === "services") && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/** Downstream count and depth for one module: BFS over importers, shortest distance per module. */
export function downstreamOf(importers: Map<string, string[]>, id: string): { count: number; hops: number; byHop: Map<string, number> } {
  const byHop = new Map<string, number>();
  const seen = new Set<string>([id]);
  let frontier = [id];
  let hop = 0;
  while (frontier.length > 0) {
    hop += 1;
    const next: string[] = [];
    for (const current of frontier) {
      for (const importer of importers.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        byHop.set(importer, hop);
        next.push(importer);
      }
    }
    frontier = next;
  }
  let hops = 0;
  for (const value of byHop.values()) hops = Math.max(hops, value);
  return { count: byHop.size, hops, byHop };
}

export function buildHeroGraph(model: GraphModel, maxNodes = HERO_MAX_NODES): HeroGraphLayout {
  const importers = new Map<string, string[]>();
  const degree = new Map<string, number>();
  for (const node of model.nodes) {
    importers.set(node.id, []);
    degree.set(node.id, 0);
  }
  for (const link of model.links) {
    if (link.source === link.target) continue;
    importers.get(link.target)?.push(link.source);
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  // The most connected modules, with a stable tie-break. Isolated files (docs, config with no
  // imports) carry no edges, so they say nothing in a dependency picture and are never chosen.
  const chosen = model.nodes
    .filter((node) => (degree.get(node.id) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, maxNodes);

  const stats = new Map(chosen.map((node) => [node.id, downstreamOf(importers, node.id)]));

  // Areas ordered by how many drawn modules they hold, so the biggest subsystem gets the first wedge.
  const areaCount = new Map<string, number>();
  for (const node of chosen) areaCount.set(areaOf(node.path), (areaCount.get(areaOf(node.path)) ?? 0) + 1);
  const areas = [...areaCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([area]) => area);
  const areaIndex = new Map(areas.map((area, index) => [area, index]));

  // Ring by rank of downstream count. Ring k holds a share proportional to k+1, because an outer
  // ring has more circumference — equal bands would crowd the rim and leave the centre empty.
  const ranked = [...chosen].sort(
    (a, b) =>
      (stats.get(b.id)!.count - stats.get(a.id)!.count) ||
      ((degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)) ||
      a.id.localeCompare(b.id),
  );
  const weights = Array.from({ length: RINGS }, (_, ring) => ring + 1);
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  const ringOf = new Map<string, number>();
  let cursor = 0;
  weights.forEach((weight, ring) => {
    const size = ring === RINGS - 1 ? ranked.length - cursor : Math.max(1, Math.round((ranked.length * weight) / weightSum));
    for (const node of ranked.slice(cursor, cursor + size)) ringOf.set(node.id, ring);
    cursor += size;
  });

  const byRing = new Map<number, typeof chosen>();
  for (const node of chosen) {
    const ring = ringOf.get(node.id) ?? RINGS - 1;
    const bucket = byRing.get(ring) ?? [];
    bucket.push(node);
    byRing.set(ring, bucket);
  }

  const nodes: HeroNode[] = [];
  const ringRadii: number[] = [];
  for (const ring of [...byRing.keys()].sort((a, b) => a - b)) {
    const members = byRing.get(ring)!;
    // Same area order on every ring keeps a subsystem radially aligned — the wedge.
    members.sort(
      (a, b) => (areaIndex.get(areaOf(a.path))! - areaIndex.get(areaOf(b.path))!) || a.id.localeCompare(b.id),
    );
    const n = members.length;
    const radius = Math.max(R0 + ring * RING_GAP, n > 1 ? (n * MIN_ARC) / (Math.PI * 2) : 0);
    ringRadii.push(radius);
    members.forEach((node, index) => {
      const angle = (n === 1 ? 0 : (index / n) * Math.PI * 2) - Math.PI / 2;
      const stat = stats.get(node.id)!;
      const d = degree.get(node.id) ?? 0;
      nodes.push({
        id: node.id,
        label: heroLabel(node.path),
        area: areaOf(node.path),
        ring,
        angle,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        radius: 4.2 + Math.min(8, Math.sqrt(d) * 1.1),
        degree: d,
        downstream: stat.count,
        hops: stat.hops,
        areaIndex: areaIndex.get(areaOf(node.path)) ?? 0,
      });
    });
  }

  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const edges: HeroEdge[] = [];
  const pairs = new Set<string>();
  for (const link of model.links) {
    const from = index.get(link.source);
    const to = index.get(link.target);
    if (from === undefined || to === undefined || from === to) continue;
    // A value import and a type import between the same two files are one line in a picture.
    const key = `${from}>${to}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    edges.push({ from, to });
  }

  return { nodes, edges, ringRadii, areas, drawn: nodes.length, total: model.nodeCount, totalEdges: model.linkCount };
}
