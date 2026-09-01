import { useMemo } from "react";

/**
 * THE LANDING MESH — decoration, and LABELLED as such.
 *
 * The design's hero has an animated dependency mesh behind the headline. On a page whose whole
 * argument is "we show you real data", an unlabelled graph-shaped graphic is the product
 * contradicting itself in its own hero: a reader has no way to know it is not their repository.
 *
 * So two decisions, and the brief sanctions both:
 *   1. It is a BUNDLED representative snapshot — a fixed, seeded shape, not a repository — and it
 *      carries a visible `representative shape · not a repository` badge.
 *   2. It is `aria-hidden`, because it states nothing a screen reader needs; every fact the page
 *      makes is in text.
 *
 * SEEDED, not random: the same shape on every load. A hero that reshuffled itself would suggest it
 * was reading something, which is the impression this component must not create.
 */

/** Nodes in the mesh. Enough to read as a graph, few enough not to cost a frame. */
const MESH_NODES = 34;
/** Edges per node, roughly. */
const MESH_LINKS = 46;

interface MeshPoint {
  x: number;
  y: number;
  r: number;
  tone: string;
  delay: number;
}

/**
 * xorshift32, seeded — the same generator `@codeflow/graph`'s community detection uses, and for the
 * same reason: a deterministic sequence with no dependence on a clock or on iteration order.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

const TONES = ["rgba(16,14,11,0.30)", "rgba(138,43,38,0.42)", "rgba(181,80,60,0.34)", "rgba(16,14,11,0.18)"];

export function HeroMesh() {
  const { points, links } = useMemo(() => {
    const random = seeded(0x5f3759df);
    const generated: MeshPoint[] = Array.from({ length: MESH_NODES }, (_, index) => ({
      x: 4 + random() * 92,
      y: 4 + random() * 92,
      r: 0.3 + random() * 0.55,
      tone: TONES[index % TONES.length],
      delay: random() * 9,
    }));
    const generatedLinks: Array<[number, number]> = [];
    for (let index = 0; index < MESH_LINKS; index++) {
      const from = Math.floor(random() * generated.length);
      const to = Math.floor(random() * generated.length);
      if (from !== to) generatedLinks.push([from, to]);
    }
    return { points: generated, links: generatedLinks };
  }, []);

  return (
    <>
      <svg className="hero-mesh" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        {links.map(([from, to], index) => (
          <line
            key={index}
            className="hero-mesh-line"
            x1={points[from].x}
            y1={points[from].y}
            x2={points[to].x}
            y2={points[to].y}
          />
        ))}
        {points.map((point, index) => (
          <circle
            key={index}
            className="hero-mesh-node"
            cx={point.x}
            cy={point.y}
            r={point.r}
            fill={point.tone}
            style={{ animationDelay: `${point.delay}s` }}
          />
        ))}
      </svg>
      <span className="hero-mesh-badge">representative shape · not a repository</span>
    </>
  );
}
