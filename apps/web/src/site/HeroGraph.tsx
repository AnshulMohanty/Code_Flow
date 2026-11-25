import { useEffect, useRef } from "react";
import type { HeroGraphLayout, HeroNode } from "../lib/heroGraph";
import { hasFinePointer, prefersReducedMotion } from "../lib/motion";

/**
 * THE HERO CANVAS — a real dependency graph behind the headline.
 *
 * The drawing engine is the design's own (radial rings, curved edges bundled toward the centre, a
 * travelling dash showing import direction, hover lighting a module's whole downstream by hop
 * distance, a gentle zoom toward the focus as the page scrolls). The DATA is not: every node and
 * edge comes from `buildHeroGraph`, i.e. from one real analysis, and the component that mounts this
 * labels it with that analysis's repository and commit.
 *
 * Canvas, not SVG, because this is ambient: ~60 nodes and ~150 curves redrawn every frame with a
 * moving dash is exactly what a canvas is for. The SAME facts are reachable without it — the canvas
 * is `aria-hidden`, the hover readout is mirrored in text, and the keyboard-reachable graph lives in
 * section 01.
 *
 * STILLNESS IS RESPECTED. Under `prefers-reduced-motion` nodes start in place, nothing travels, and
 * the canvas only redraws when the pointer or the size changes. Off-screen, it stops drawing at all.
 */

export interface HeroHover {
  label: string;
  downstream: number;
  hops: number;
  area: string;
}

export interface HeroGraphProps {
  layout: HeroGraphLayout;
  onHover(hover: HeroHover | null): void;
}

/** The design's eight muted domain hues, used here for AREAS (a package or top-level directory). */
const AREA_HUES = ["#8C4038", "#41626A", "#6B5B45", "#75505C", "#37484F", "#4F4A38", "#5C4E40", "#42504A"];
const C = {
  edge: "rgba(22,18,15,0.17)",
  node: "#F2EDE3",
  ring: "rgba(22,18,15,0.55)",
  label: "rgba(22,18,15,0.5)",
  hot: "#7C2D2A",
  dim: "rgba(22,18,15,0.06)",
  flow: "rgba(22,18,15,0.3)",
  guide: "rgba(22,18,15,0.055)",
};
/** Labels are reserved for the most connected modules — everything else is a dot until hovered. */
const LABELLED = 9;
const OFF_X = 0.17;
const OFF_Y = 0.03;
const ZOOM = 1.06;
const MAX_ZOOM = 1.2;

export function HeroGraph({ layout, onHover }: HeroGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || layout.nodes.length === 0) return;
    // jsdom has no 2D context; asking for one there only prints a "not implemented" warning.
    if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const engine = createEngine(canvas, ctx, layout, (hover) => hoverRef.current(hover));
    return () => engine.destroy();
  }, [layout]);

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />;
}

interface LiveNode extends HeroNode {
  index: number;
  sx: number;
  sy: number;
  px: number;
  py: number;
  hue: string;
}

function createEngine(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  layout: HeroGraphLayout,
  report: (hover: HeroHover | null) => void,
) {
  const still = prefersReducedMotion();
  const hoverable = hasFinePointer();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const maxRing = Math.max(0, ...layout.nodes.map((node) => node.ring));

  const nodes: LiveNode[] = layout.nodes.map((node, index) => ({
    ...node,
    index,
    sx: node.x,
    sy: node.y,
    px: node.x,
    py: node.y,
    hue: AREA_HUES[node.areaIndex % AREA_HUES.length],
  }));
  const edges = layout.edges.map((edge, k) => ({ ...edge, k, prog: still ? 1 : 0 }));
  const importersOf = new Map<number, number[]>();
  for (const edge of layout.edges) {
    const list = importersOf.get(edge.to) ?? [];
    list.push(edge.from);
    importersOf.set(edge.to, list);
  }
  const labelled = new Set(
    [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, LABELLED).map((node) => node.index),
  );
  const hubs = new Set([...labelled].slice(0, 5));

  let W = 1;
  let H = 1;
  let running = true;
  let visible = true;
  let rafId = 0;
  let T0 = performance.now();
  const cam = { x: 0, y: 0, s: 1 };
  const target = { x: 0, y: 0, s: 1 };
  let first = true;
  let scrollP = 0;
  let hover: LiveNode | null = null;
  let hoverT = 0;
  let blast: Map<number, number> | null = null;
  let pointer: { x: number; y: number } | null = null;

  // Nodes start pushed outward on their own spoke and ease home, inner rings last — the design's
  // "graph easing into place". Under reduced motion they simply start home.
  const seed = () => {
    nodes.forEach((node, i) => {
      const k = still ? 1 : 1.62 + ((i * 37) % 100) / 320;
      const spin = still ? 0 : (((i * 71) % 100) / 100 - 0.5) * 0.34;
      const r = Math.hypot(node.x, node.y);
      node.sx = Math.cos(node.angle + spin) * r * k;
      node.sy = Math.sin(node.angle + spin) * r * k;
      node.px = node.sx;
      node.py = node.sy;
    });
    T0 = performance.now();
    edges.forEach((edge) => (edge.prog = still ? 1 : 0));
  };
  const settle = (now: number) => {
    nodes.forEach((node) => {
      const k = still ? 1 : Math.max(0, Math.min(1, (now - T0 - (maxRing - node.ring) * 58) / 820));
      const e = 1 - Math.pow(1 - k, 3);
      node.px = node.sx + (node.x - node.sx) * e;
      node.py = node.sy + (node.y - node.sy) * e;
    });
  };
  seed();

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (Math.abs(rect.width - W) > 0.5 || Math.abs(rect.height - H) > 0.5) {
      W = rect.width;
      H = rect.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    return true;
  };

  const origin = () => ({ x: W / 2 + OFF_X * W, y: H / 2 + OFF_Y * H });
  const toWorld = (px: number, py: number) => {
    const o = origin();
    return { x: (px - o.x) / cam.s + cam.x, y: (py - o.y) / cam.s + cam.y };
  };
  // A quadratic bundled toward the centre, so links read as spokes of one system.
  const control = (ax: number, ay: number, bx: number, by: number) => ({ x: ((ax + bx) / 2) * 0.72, y: ((ay + by) / 2) * 0.72 });

  const blastOf = (index: number): Map<number, number> => {
    const seen = new Map<number, number>([[index, 0]]);
    const queue = [index];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const importer of importersOf.get(current) ?? []) {
        if (!seen.has(importer)) {
          seen.set(importer, seen.get(current)! + 1);
          queue.push(importer);
        }
      }
    }
    return seen;
  };

  const onMove = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const w = toWorld(pointer.x, pointer.y);
    let best: LiveNode | null = null;
    let bestDistance = Infinity;
    for (const node of nodes) {
      // Picked in SCREEN pixels so the hit area stays the same size at any zoom.
      const hit = node.radius + 9;
      const distance = Math.hypot(node.px - w.x, node.py - w.y) * cam.s;
      if (distance < hit && distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    canvas.style.cursor = best ? "pointer" : "default";
    if (best !== hover) {
      hover = best;
      hoverT = performance.now();
      blast = hover ? blastOf(hover.index) : null;
      report(hover ? { label: hover.label, downstream: hover.downstream, hops: hover.hops, area: hover.area } : null);
    }
    if (still) draw(performance.now());
  };
  const onLeave = () => {
    pointer = null;
    if (hover) {
      hover = null;
      blast = null;
      report(null);
    }
    if (still) draw(performance.now());
  };
  if (hoverable) {
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
  }

  const onScroll = () => {
    scrollP = Math.max(0, Math.min(1, window.scrollY / (window.innerHeight || 800)));
  };
  if (!still) window.addEventListener("scroll", onScroll, { passive: true });

  const hopWeight = (d: number) => (d <= 1 ? 1 : d === 2 ? 0.72 : d === 3 ? 0.4 : 0.22);

  function draw(now: number) {
    if (!running) return;
    if (!resize()) {
      schedule();
      return;
    }
    const t = now - T0;
    settle(now);
    if (!still) edges.forEach((edge) => {
      if (edge.prog < 1 && t > 240 + edge.k * 6) edge.prog = Math.min(1, edge.prog + 0.05);
    });

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.px);
      maxX = Math.max(maxX, node.px);
      minY = Math.min(minY, node.py);
      maxY = Math.max(maxY, node.py);
    }
    const bw = Math.max(60, maxX - minX);
    const bh = Math.max(60, maxY - minY);
    const padX = Math.max(26, W * 0.08);
    const padY = Math.max(26, H * 0.09);
    const availW = Math.max(80, W - padX - Math.abs(OFF_X) * W * 1.2);
    const availH = Math.max(80, H - padY - Math.abs(OFF_Y) * H * 1.2);
    const fit = Math.min(availW / bw, availH / bh);
    target.s = Math.min(MAX_ZOOM, fit * ZOOM * (1 + scrollP * 0.5));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    target.x = hover ? cx + (hover.px - cx) * scrollP * 0.9 : cx;
    target.y = hover ? cy + (hover.py - cy) * scrollP * 0.9 : cy;
    if (first) {
      cam.x = target.x;
      cam.y = target.y;
      cam.s = still ? target.s : target.s * 0.74;
      first = false;
    }
    const ease = still ? 1 : 0.07;
    cam.x += (target.x - cam.x) * ease;
    cam.y += (target.y - cam.y) * ease;
    cam.s += (target.s - cam.s) * ease;

    const o = origin();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(cam.s, cam.s);
    ctx.translate(-cam.x, -cam.y);

    const sinceHover = now - hoverT;
    // Lit modules lean outward along their ring, nearest hops first.
    const pull = (node: LiveNode) => {
      if (!hover || !blast || !blast.has(node.index) || node === hover) return { x: node.px, y: node.py };
      const k = still ? 0.055 : Math.min(1, Math.max(0, (sinceHover - blast.get(node.index)! * 110) / 420)) * 0.055;
      return { x: node.px * (1 + k), y: node.py * (1 + k) };
    };

    ctx.lineWidth = 1 / cam.s;
    ctx.strokeStyle = C.guide;
    for (const r of layout.ringRadii) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.lineCap = "round";
    for (const edge of edges) {
      const A = pull(nodes[edge.from]);
      const B = pull(nodes[edge.to]);
      const lit = blast && blast.has(edge.from) && blast.has(edge.to) && Math.abs(blast.get(edge.from)! - blast.get(edge.to)!) === 1;
      const depth = lit ? Math.max(blast!.get(edge.from)!, blast!.get(edge.to)!) : 0;
      const arrive = still ? 1 : Math.max(0, Math.min(1, (sinceHover - depth * 110) / 240));
      const ex = A.x + (B.x - A.x) * edge.prog;
      const ey = A.y + (B.y - A.y) * edge.prog;
      const c = control(A.x, A.y, ex, ey);
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.quadraticCurveTo(c.x, c.y, ex, ey);
      };
      path();
      if (lit && arrive > 0) {
        const hw = hopWeight(depth);
        ctx.strokeStyle = C.hot;
        ctx.globalAlpha = (0.16 + 0.6 * arrive) * hw;
        ctx.lineWidth = (1.14 + arrive * hw) / cam.s;
      } else {
        ctx.strokeStyle = blast ? C.dim : C.edge;
        ctx.globalAlpha = edge.prog * (blast ? 1 : 0.81);
        ctx.lineWidth = 1.28 / cam.s;
      }
      ctx.stroke();
      // The travelling dash: direction of the import, importer → imported.
      if (!still && edge.prog >= 1 && !blast) {
        path();
        ctx.setLineDash([2.5 / cam.s, 26 / cam.s]);
        ctx.lineDashOffset = -((now / 26) % 400) / cam.s;
        ctx.strokeStyle = C.flow;
        ctx.globalAlpha = 0.26;
        ctx.lineWidth = 1.2 / cam.s;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    // A faint guide from the pointer to the nearest module: the graph is reaching for you.
    if (pointer && !still) {
      const w = toWorld(pointer.x, pointer.y);
      let best: LiveNode | null = null;
      let bestDistance = Infinity;
      for (const node of nodes) {
        const d = Math.hypot(node.px - w.x, node.py - w.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = node;
        }
      }
      if (best && bestDistance < 240) {
        ctx.save();
        ctx.setLineDash([3 / cam.s, 4 / cam.s]);
        ctx.strokeStyle = C.hot;
        ctx.globalAlpha = 0.34 * (1 - bestDistance / 240);
        ctx.lineWidth = 1 / cam.s;
        ctx.beginPath();
        ctx.moveTo(w.x, w.y);
        ctx.lineTo(best.px, best.py);
        ctx.stroke();
        ctx.restore();
      }
    }

    const labels: Array<{ x: number; y: number; node: LiveNode; hot: boolean; force: boolean; size: number }> = [];
    const litCount = blast ? blast.size - 1 : 0;
    for (const node of nodes) {
      const p = pull(node);
      const inBlast = Boolean(blast && blast.has(node.index));
      const isFocus = hover === node;
      let size = node.radius;
      if (hubs.has(node.index) && !still) size += Math.sin(now / 640 + node.index) * 1.05;
      if (isFocus) size += 2.6;
      size /= cam.s;
      const hw = inBlast ? hopWeight(blast!.get(node.index)!) : 1;
      ctx.globalAlpha = blast && !inBlast ? 0.2 : inBlast && !isFocus ? 0.34 + 0.66 * hw : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fillStyle = isFocus ? C.hot : inBlast && hw > 0.5 ? C.hot : node.hue;
      ctx.fill();
      ctx.lineWidth = (isFocus ? 2.2 : 1.1) / cam.s;
      ctx.strokeStyle = isFocus || inBlast ? C.hot : C.ring;
      ctx.stroke();
      if (isFocus && !still) {
        const rr = size + ((now / 9) % 44) / cam.s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.globalAlpha = Math.max(0, 0.36 - (rr * cam.s) / 130);
        ctx.lineWidth = 1.4 / cam.s;
        ctx.strokeStyle = C.hot;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const near = inBlast && blast!.get(node.index)! <= 1;
      const wanted = blast ? isFocus || near || (litCount <= 8 && inBlast) : labelled.has(node.index);
      if (wanted) labels.push({ x: p.x, y: p.y, node, hot: inBlast || isFocus, force: isFocus, size });
    }
    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '9px "Martian Mono", ui-monospace, monospace';
    ctx.textBaseline = "middle";
    const placed: Array<{ x: number; y: number; w: number }> = [];
    labels.sort((a, b) => Number(b.hot) - Number(a.hot) || b.node.degree - a.node.degree);
    const free = (x: number, y: number, w: number) =>
      placed.every((p) => !(x < p.x + p.w + 7 && x + w + 7 > p.x && Math.abs(y - p.y) < 13));
    for (const label of labels) {
      const sx = (label.x - cam.x) * cam.s + o.x;
      const sy = (label.y - cam.y) * cam.s + o.y;
      if (sx < -40 || sx > W + 40 || sy < -20 || sy > H + 20) continue;
      const w = ctx.measureText(label.node.label).width;
      const gap = label.size * cam.s + 8;
      const outward = Math.cos(label.node.angle) >= 0;
      const candidates = outward ? [sx + gap, sx - gap - w] : [sx - gap - w, sx + gap];
      let x: number | null = null;
      for (const candidate of candidates) {
        if (candidate > 2 && candidate + w < W - 2 && free(candidate, sy, w)) {
          x = candidate;
          break;
        }
      }
      if (x === null) {
        if (!label.force) continue;
        x = Math.max(2, Math.min(W - w - 2, sx + gap));
      }
      x = Math.max(3, Math.min(W - w - 3, x));
      placed.push({ x, y: sy, w });
      ctx.globalAlpha = 0.86;
      ctx.fillStyle = C.node;
      ctx.fillRect(x - 3, sy - 6.5, w + 6, 13);
      ctx.globalAlpha = blast && !label.hot ? 0.42 : 1;
      ctx.fillStyle = label.hot ? C.hot : C.label;
      ctx.fillText(label.node.label, x, sy);
    }
    ctx.globalAlpha = 1;
    schedule();
  }

  function schedule() {
    if (!running || still || !visible || document.hidden) return;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }

  const observer =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          if (visible) schedule();
        })
      : null;
  observer?.observe(canvas);
  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => (still ? draw(performance.now()) : schedule())) : null;
  resizeObserver?.observe(canvas);
  const onVisibility = () => schedule();
  document.addEventListener("visibilitychange", onVisibility);

  draw(performance.now());
  // Labels are measured in Martian Mono; once the webfont lands, a still canvas must redraw or it
  // keeps the fallback font's widths (an animating one picks it up on the next frame anyway).
  void document.fonts?.ready.then(() => {
    if (running) draw(performance.now());
  });

  return {
    destroy() {
      running = false;
      cancelAnimationFrame(rafId);
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("scroll", onScroll);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    },
  };
}
