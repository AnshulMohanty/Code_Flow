import type { ClassifiedEdge, ContainerLane, EdgeClass, LaneMap } from "./architecture";

/**
 * THE ROUTED CONTAINER DIAGRAM (TAB 01) — the design's C4 drawing, laid out over REAL lanes.
 *
 * The geometry is the design's: six lane frames on a 1156×596 board, module boxes inside them, and
 * orthogonal links routed box to box with a label placed wherever it clears every box, every lane
 * title and every other label. What goes IN it is the run's own architecture read-model:
 *
 *   frames  the lanes `assignLanes` produced (an empty lane is omitted, never drawn empty)
 *   boxes   each lane's modules ranked by how much code sits downstream of them — the boxes a
 *           change is most expensive in. The frame says how many of the lane it shows ("4 of 31").
 *   links   real resolved imports between two shown boxes, classed by `classifyEdges`
 *           (control / data / violation), labelled with the import's own specifier.
 *
 * A diagram cannot draw every edge of a real repository and stay readable, so by default it draws a
 * bounded set (each box's strongest outgoing links, violations first) and SAYS so; hovering or
 * focusing a box isolates ALL of that box's links among the shown modules.
 *
 * Pure: same analysis, same board.
 */

export const BOARD_W = 1156;
export const BOARD_H = 596;

interface Frame {
  lane: ContainerLane;
  x: number;
  y: number;
  w: number;
  h: number;
  cols: number;
  rows: number;
}

/** The design's frame positions, with the free bottom-left slot given to UNCLASSIFIED. */
const FRAMES: Frame[] = [
  { lane: "clients-entry", x: 24, y: 40, w: 186, h: 214, cols: 1, rows: 3 },
  { lane: "edge-transport", x: 272, y: 40, w: 196, h: 214, cols: 1, rows: 3 },
  { lane: "application", x: 530, y: 40, w: 196, h: 214, cols: 1, rows: 3 },
  { lane: "platform-libraries", x: 788, y: 40, w: 344, h: 300, cols: 2, rows: 5 },
  { lane: "domain-engine", x: 272, y: 300, w: 454, h: 272, cols: 2, rows: 4 },
  { lane: "data-configuration", x: 788, y: 392, w: 344, h: 180, cols: 2, rows: 2 },
  { lane: "unclassified", x: 24, y: 300, w: 186, h: 272, cols: 1, rows: 4 },
];

export interface DiagramGroup {
  lane: ContainerLane;
  x: number;
  y: number;
  w: number;
  h: number;
  shown: number;
  total: number;
}

export interface DiagramBox {
  id: string;
  lane: ContainerLane;
  x: number;
  y: number;
  w: number;
  h: number;
  downstream: number;
}

export interface DiagramLink {
  from: string;
  to: string;
  cls: EdgeClass;
  label: string;
  /** SVG path `M x y L x y …`. */
  d: string;
  /** The arrival dot, just short of the target box. */
  head: { x: number; y: number };
  points: Array<[number, number]>;
  /** In the default (un-hovered) drawing. */
  primary: boolean;
}

export interface PlacedLabel {
  from: string;
  to: string;
  x: number;
  y: number;
}

export interface SystemDiagram {
  groups: DiagramGroup[];
  boxes: DiagramBox[];
  links: DiagramLink[];
  /** Links among shown boxes, before the default cap — stated in the caption. */
  candidateCount: number;
}

export interface DiagramInput {
  lanes: LaneMap;
  edges: readonly ClassifiedEdge[];
  /** Modules transitively downstream of each module (full graph). */
  downstream: (fileId: string) => number;
  /** The import specifier for an edge, when the result recorded one. */
  specifier?: (from: string, to: string) => { specifier?: string; typeOnly?: boolean } | undefined;
}

/** Default drawn links: at most this many per source box, and this many overall. */
const PER_SOURCE = 2;
const LINK_CAP = 24;

function boxRect(frame: Frame, index: number): { x: number; y: number; w: number; h: number } {
  const padLeft = 20;
  const padRight = 10;
  const gap = 6;
  const top = 34;
  const inner = frame.w - padLeft - padRight;
  const w = (inner - gap * (frame.cols - 1)) / frame.cols;
  const step = (frame.h - top - 8) / frame.rows;
  const h = Math.min(40, step - 12);
  const col = index % frame.cols;
  const row = Math.floor(index / frame.cols);
  return { x: frame.x + padLeft + col * (w + gap), y: frame.y + top + row * step, w, h };
}

/** `@codeflow/shared-types` → `shared-types`; `../lib/useMeta.js` → `useMeta`; `./index` → `index`. */
export function shortSpecifier(specifier: string): string {
  const cleaned = specifier.replace(/\.(m?[jt]sx?|py|go|java|cs|h|hpp)$/, "");
  const parts = cleaned.split("/").filter((part) => part && part !== "." && part !== "..");
  if (parts.length === 0) return cleaned;
  let last = parts[parts.length - 1];
  if ((last === "index" || last === "src") && parts.length > 1) last = parts[parts.length - 2];
  return last.length > 20 ? `${last.slice(0, 19)}…` : last;
}

export function buildSystemDiagram(input: DiagramInput): SystemDiagram {
  const groups: DiagramGroup[] = [];
  const boxes: DiagramBox[] = [];

  for (const frame of FRAMES) {
    const members = input.lanes.byLane.get(frame.lane) ?? [];
    if (members.length === 0) continue;
    const capacity = frame.cols * frame.rows;
    const ranked = [...members].sort((a, b) => input.downstream(b) - input.downstream(a) || a.localeCompare(b));
    const shown = ranked.slice(0, capacity);
    groups.push({ lane: frame.lane, x: frame.x, y: frame.y, w: frame.w, h: frame.h, shown: shown.length, total: members.length });
    shown.forEach((id, index) => {
      boxes.push({ id, lane: frame.lane, ...boxRect(frame, index), downstream: input.downstream(id) });
    });
  }

  const byId = new Map(boxes.map((box) => [box.id, box]));
  // One link per module pair. A file can import another twice (a value import and a type-only
  // import); on a box diagram that is one connection, and two would draw the same route twice.
  const seenPairs = new Set<string>();
  const candidates = input.edges.filter((edge) => {
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to)) return false;
    const key = `${edge.from}>${edge.to}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key);
    return true;
  });

  // The default drawing: violations first (they are the point of the diagram), then links that
  // cross lanes (the architecture), then by how much depends on the target.
  const rank = (edge: ClassifiedEdge) =>
    (edge.class === "violation" ? 0 : 2) + (byId.get(edge.from)!.lane === byId.get(edge.to)!.lane ? 1 : 0);
  const ordered = [...candidates].sort(
    (a, b) => rank(a) - rank(b) || byId.get(b.to)!.downstream - byId.get(a.to)!.downstream || `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`),
  );
  const perSource = new Map<string, number>();
  const primary = new Set<string>();
  for (const edge of ordered) {
    if (primary.size >= LINK_CAP) break;
    const used = perSource.get(edge.from) ?? 0;
    if (used >= PER_SOURCE) continue;
    perSource.set(edge.from, used + 1);
    primary.add(`${edge.from}>${edge.to}`);
  }

  // Stagger the runs leaving one source so their corridors never coincide.
  const runIndex = new Map<string, number>();
  const links: DiagramLink[] = ordered.map((edge) => {
    const A = byId.get(edge.from)!;
    const B = byId.get(edge.to)!;
    const i = runIndex.get(edge.from) ?? 0;
    runIndex.set(edge.from, i + 1);
    const points = route(A, B, i);
    const last = points[points.length - 1];
    const prev = points[points.length - 2];
    const dx = Math.sign(last[0] - prev[0]);
    const dy = Math.sign(last[1] - prev[1]);
    const spec = input.specifier?.(edge.from, edge.to);
    const label = spec?.specifier ? `${spec.typeOnly ? "type " : ""}${shortSpecifier(spec.specifier)}` : "import";
    return {
      from: edge.from,
      to: edge.to,
      cls: edge.class,
      label,
      d: `M${points.map((p) => `${round(p[0])} ${round(p[1])}`).join(" L")}`,
      head: { x: round(last[0] - dx * 5), y: round(last[1] - dy * 5) },
      points,
      primary: primary.has(`${edge.from}>${edge.to}`),
    };
  });

  return { groups, boxes, links, candidateCount: candidates.length };
}

/** Orthogonal route between two boxes: horizontal-first when they sit side by side, else vertical. */
function route(A: DiagramBox, B: DiagramBox, i: number): Array<[number, number]> {
  if (B.x >= A.x + A.w + 4 || B.x + B.w <= A.x - 4) {
    const right = B.x >= A.x + A.w;
    const x0 = right ? A.x + A.w : A.x;
    const x1 = right ? B.x : B.x + B.w;
    const y0 = A.y + A.h / 2;
    const y1 = B.y + B.h / 2;
    const span = Math.max(20, Math.abs(x1 - x0));
    const run = Math.min(span - 8, 16 + (i % 4) * 15 + span * 0.32);
    const mx = right ? x0 + run : x0 - run;
    return [
      [x0, y0],
      [mx, y0],
      [mx, y1],
      [x1, y1],
    ];
  }
  const down = B.y >= A.y + A.h;
  const x0 = A.x + A.w / 2 + ((i % 3) - 1) * 10;
  const x1 = B.x + B.w / 2;
  const y0 = down ? A.y + A.h : A.y;
  const y1 = down ? B.y : B.y + B.h;
  const span = Math.max(16, Math.abs(y1 - y0));
  const run = Math.min(span - 8, 14 + (i % 4) * 13 + span * 0.3);
  const my = down ? y0 + run : y0 - run;
  return [
    [x0, y0],
    [x0, my],
    [x1, my],
    [x1, y1],
  ];
}

/**
 * Walk each visible link and put its label at the first point where the label box clears every
 * module box, every lane title and every label already placed — trying both sides of the run.
 * A label that fits nowhere is dropped; the link is still drawn.
 */
export function placeLabels(diagram: SystemDiagram, visible: readonly DiagramLink[]): PlacedLabel[] {
  const obstacles = diagram.boxes
    .map((box) => ({ x: box.x - 4, y: box.y - 4, w: box.w + 8, h: box.h + 8 }))
    .concat(diagram.groups.map((group) => ({ x: group.x, y: group.y, w: group.w, h: 24 })));
  const hits = (r: Rect, o: Rect) => !(r.x + r.w < o.x || r.x > o.x + o.w || r.y + r.h < o.y || r.y > o.y + o.h);
  const placed: Rect[] = [];
  const out: PlacedLabel[] = [];

  for (const link of visible) {
    const lw = link.label.length * 5.8 + 10;
    const lh = 14;
    let best: { x: number; y: number; rect: Rect } | null = null;
    for (let s = 0; s < link.points.length - 1 && !best; s++) {
      const a = link.points[s];
      const b = link.points[s + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.floor(length / 7));
      const vertical = Math.abs(b[0] - a[0]) < 1;
      for (let k = 0; k <= steps && !best; k++) {
        const t = k / steps;
        const cx = a[0] + (b[0] - a[0]) * t;
        const cy = a[1] + (b[1] - a[1]) * t;
        const candidates: Array<[number, number]> = vertical
          ? [
              [cx + lw / 2 + 7, cy],
              [cx - lw / 2 - 7, cy],
            ]
          : [
              [cx, cy - 10],
              [cx, cy + 10],
            ];
        for (const [px, py] of candidates) {
          const rect = { x: px - lw / 2, y: py - lh / 2, w: lw, h: lh };
          if (rect.x < 6 || rect.x + rect.w > BOARD_W - 6 || rect.y < 4 || rect.y + rect.h > BOARD_H - 4) continue;
          if (obstacles.some((o) => hits(rect, o)) || placed.some((o) => hits(rect, o))) continue;
          best = { x: px, y: py, rect };
          break;
        }
      }
    }
    if (best) {
      placed.push(best.rect);
      out.push({ from: link.from, to: link.to, x: best.x, y: best.y });
    }
  }
  return out;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
