/**
 * Measuring on the board (docs/05-pcb-improvements.md, P7): snap points for the measure tool (pad centres,
 * pad edges, trace centre lines, via centres) and the clearance between two objects.
 */
import { clearanceFor, collectCopper, inArea, type CopperShape } from './copper.ts';
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

/** Closest points of segments a–b and c–d. */
export function closestOnSegments(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [Vec2, Vec2] {
  const proj = (p: Vec2, s: Vec2, t: Vec2): Vec2 => {
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const l2 = dx * dx + dy * dy;
    const k = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0;
    return { x: s.x + k * dx, y: s.y + k * dy };
  };
  // Crossing segments meet at a point.
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) > 1e-12) {
    const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      return [p, p];
    }
  }
  const cands: [Vec2, Vec2][] = [[a, proj(a, c, d)], [b, proj(b, c, d)], [proj(c, a, b), c], [proj(d, a, b), d]];
  let best = cands[0]!;
  for (const x of cands) if (Math.hypot(x[0].x - x[1].x, x[0].y - x[1].y) < Math.hypot(best[0].x - best[1].x, best[0].y - best[1].y)) best = x;
  return best;
}

export interface Clearance {
  /** Edge-to-edge gap (mm); 0 when they touch or overlap. */
  gap: number;
  /** Closest points on the two objects' copper edges. */
  a: Vec2;
  b: Vec2;
  layer: string;
  /** Clearance the two objects demand of each other. */
  required: number;
}

/** The copper of a board object: its own shapes, or a part's pads. */
function shapesOf(doc: Doc, all: CopperShape[], uid: string): CopperShape[] {
  const n = doc.nodes.get(uid);
  if (n?.type === 'element') {
    const pads = new Set(n.children);
    return all.filter((s) => pads.has(s.uid));
  }
  return all.filter((s) => s.uid === uid);
}

/** The clearance between two objects (pads, traces, vias, pours, or parts by their pads), on the layer
 *  where they come closest; undefined when they share no copper layer. */
export function clearanceBetween(doc: Doc, engine: StyleEngine, copper: string[], uidA: string, uidB: string): Clearance | undefined {
  const all = collectCopper(doc, engine, copper);
  const A = shapesOf(doc, all, uidA);
  const B = shapesOf(doc, all, uidB);
  let best: Clearance | undefined;
  for (const s of A)
    for (const t of B) {
      if (s.layer !== t.layer) continue;
      const required = Math.max(clearanceFor(s.keepOut, t.kind), clearanceFor(t.keepOut, s.kind));
      // One inside the other's area.
      for (const [x, y] of [[s, t], [t, s]] as const)
        for (const ar of x.areas)
          if (inArea(y.probe, ar)) {
            if (!best || best.gap > 0) best = { gap: 0, a: y.probe, b: y.probe, layer: s.layer, required };
          }
      for (const [p, q, r] of s.edges)
        for (const [u, v, w] of t.edges) {
          const [ca, cb] = closestOnSegments(p, q, u, v);
          const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
          const gap = Math.max(0, d - r - w);
          if (best && gap >= best.gap) continue;
          // Move the closest points out to the copper edges (by the capsule radii).
          const ux = d > 1e-12 ? (cb.x - ca.x) / d : 0;
          const uy = d > 1e-12 ? (cb.y - ca.y) / d : 0;
          best = { gap, a: { x: ca.x + ux * r, y: ca.y + uy * r }, b: { x: cb.x - ux * w, y: cb.y - uy * w }, layer: s.layer, required };
        }
    }
  return best && { ...best, gap: Math.round(best.gap * 1e4) / 1e4 };
}

/**
 * Where the measure tool snaps near `p` (within `tol` mm): a pad or via centre first, then the nearest pad
 * edge, then the nearest trace centre line; else `p` itself.
 */
export function measureSnap(doc: Doc, engine: StyleEngine, copper: string[], p: Vec2, tol: number, shapes = collectCopper(doc, engine, copper)): { at: Vec2; what: 'centre' | 'edge' | 'trace' | 'free' } {
  let best: { at: Vec2; d: number; what: 'centre' | 'edge' | 'trace' } | undefined;
  const take = (at: Vec2, what: 'centre' | 'edge' | 'trace', bias: number) => {
    const d = Math.hypot(at.x - p.x, at.y - p.y) + bias;
    if (d <= tol + bias && (!best || d < best.d)) best = { at, d, what };
  };
  for (const s of shapes) {
    if (s.box.minX - tol > p.x || s.box.maxX + tol < p.x || s.box.minY - tol > p.y || s.box.maxY + tol < p.y) continue;
    if (s.kind === 'pad' || s.kind === 'via') take(s.kind === 'via' ? s.edges[0]![0] : s.probe, 'centre', -tol * 0.5);
    if (s.kind === 'pad') for (const [a, b] of s.edges) take(closestOnSegments(p, p, a, b)[1], 'edge', 0);
    if (s.kind === 'trace') for (const [a, b] of s.edges) take(closestOnSegments(p, p, a, b)[1], 'trace', 0.0001);
  }
  return best ? { at: best.at, what: best.what } : { at: p, what: 'free' };
}
