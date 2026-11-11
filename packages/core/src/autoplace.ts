/**
 * Simple autoplacer: moves components onto the board, connected parts near each other,
 * without overlapping courtyards. Greedy (largest / most connected first, spiral search
 * around the parts it connects to). A starting point for the user, not a final placement.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { boardOutline } from './copper.ts';
import { frameOf, padGeom, toWorld } from './frames.ts';
import { distToSegment, pointInPolygon } from './geom.ts';

export interface AutoplaceOptions {
  /** Place these references (default: every part that is not on the board yet). */
  refs?: string[];
  /** Also re-place parts that are already on the board. */
  all?: boolean;
  /** Space kept between parts and from the board edge (mm, default 0.5). */
  spacing?: number;
}

export interface AutoplaceReport {
  placed: { ref: string; at: Vec2 }[];
  failed: string[];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** Extent of a component relative to its origin (pads + courtyard), in board orientation. */
export function componentExtent(doc: Doc, engine: StyleEngine, el: DocNode, copper: string[]): Box {
  const pos = vec(engine.get(el.uid, 'position')?.value) ?? { x: 0, y: 0 };
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p: Vec2) => {
    b.minX = Math.min(b.minX, p.x - pos.x);
    b.minY = Math.min(b.minY, p.y - pos.y);
    b.maxX = Math.max(b.maxX, p.x - pos.x);
    b.maxY = Math.max(b.maxY, p.y - pos.y);
  };
  for (const c of el.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'pad') {
      const g = padGeom(doc, engine, n, copper);
      if (g) g.outline.forEach(add);
    } else if (String(engine.get(n.uid, 'layer')?.value ?? '').includes('CrtYd')) {
      const f = frameOf(doc, engine, n);
      const pts = (engine.get(n.uid, 'points')?.value as Vec2[] | undefined) ?? [vec(engine.get(n.uid, 'start')?.value), vec(engine.get(n.uid, 'end')?.value)].filter((x): x is Vec2 => !!x);
      const ctr = vec(engine.get(n.uid, 'center')?.value);
      const r = Number(engine.get(n.uid, 'radius')?.value ?? 0);
      if (ctr && r) [{ x: ctr.x - r, y: ctr.y - r }, { x: ctr.x + r, y: ctr.y + r }].forEach((p) => add(toWorld(f, p)));
      pts.forEach((p) => add(toWorld(f, p)));
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return b;
}

export function planAutoplace(doc: Doc, engine: StyleEngine, copper: string[], opts: AutoplaceOptions = {}): { ops: Op[]; report: AutoplaceReport } {
  const report: AutoplaceReport = { placed: [], failed: [] };
  const outline = boardOutline(doc, engine).loops[0];
  if (!outline) return { ops: [], report: { placed: [], failed: opts.refs ?? [] } };
  const sp = opts.spacing ?? 0.5;
  const elements = [...doc.nodes.values()].filter((n) => n.type === 'element');
  const posOf = (el: DocNode) => vec(engine.get(el.uid, 'position')?.value) ?? { x: 0, y: 0 };
  const ext = new Map(elements.map((e) => [e.uid, componentExtent(doc, engine, e, copper)]));
  const boxAt = (el: DocNode, p: Vec2): Box => {
    const e = ext.get(el.uid)!;
    return { minX: p.x + e.minX, minY: p.y + e.minY, maxX: p.x + e.maxX, maxY: p.y + e.maxY };
  };
  const inside = (b: Box) => {
    const corners = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
    if (!corners.every((c) => pointInPolygon(c, outline))) return false;
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k]!;
      const c = outline[(k + 1) % outline.length]!;
      for (const q of corners) if (distToSegment(q, a, c) < sp) return false;
      // Board edge vertices inside the box (notches) also block.
      if (a.x > b.minX && a.x < b.maxX && a.y > b.minY && a.y < b.maxY) return false;
    }
    return true;
  };
  const onBoard = (el: DocNode) => inside(boxAt(el, posOf(el)));
  const wanted = new Set(opts.refs ?? []);
  const toPlace = elements.filter((e) => !e.props.locked && (opts.refs ? wanted.has(e.name) : opts.all || !onBoard(e)));
  const fixed = elements.filter((e) => !toPlace.includes(e));
  const placedBoxes: Box[] = fixed.map((e) => boxAt(e, posOf(e)));

  // Connectivity weights between components (shared nets, small nets weigh more).
  const netsOf = new Map<string, Set<string>>();
  const membersOf = new Map<string, Set<string>>();
  for (const el of elements) {
    const s = new Set<string>();
    for (const c of el.children) {
      const n = doc.nodes.get(c);
      if (n?.type === 'pad' && typeof n.props.net === 'string' && n.props.net && !n.props.net.startsWith('unconnected-')) s.add(n.props.net);
    }
    netsOf.set(el.uid, s);
    for (const net of s) (membersOf.get(net) ?? membersOf.set(net, new Set()).get(net)!).add(el.uid);
  }
  const weight = (a: string, b: string) => {
    let w = 0;
    for (const net of netsOf.get(a) ?? []) if (membersOf.get(net)?.has(b)) w += 1 / Math.max(1, (membersOf.get(net)!.size - 1));
    return w;
  };

  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of outline) (bx0 = Math.min(bx0, p.x)), (by0 = Math.min(by0, p.y)), (bx1 = Math.max(bx1, p.x)), (by1 = Math.max(by1, p.y));
  const centre = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
  const area = (e: DocNode) => {
    const b = ext.get(e.uid)!;
    return (b.maxX - b.minX) * (b.maxY - b.minY);
  };
  const positions = new Map<string, Vec2>();
  for (const e of fixed) positions.set(e.uid, posOf(e));
  const remaining = toPlace.slice().sort((a, b) => area(b) - area(a));
  const ops: Op[] = [];
  const overlaps = (b: Box) => placedBoxes.some((o) => b.minX < o.maxX + sp && b.maxX > o.minX - sp && b.minY < o.maxY + sp && b.maxY > o.minY - sp);
  const step = 0.5;
  while (remaining.length) {
    // Next: most connected to what is placed (ties: biggest).
    let best = 0;
    let bestW = -1;
    remaining.forEach((e, i) => {
      let w = 0;
      for (const uid of positions.keys()) w += weight(e.uid, uid);
      if (w > bestW + 1e-9) (bestW = w), (best = i);
    });
    const el = remaining.splice(best, 1)[0]!;
    // Target: weighted centroid of connected placed parts, else the board centre.
    let tx = 0, ty = 0, tw = 0;
    for (const [uid, p] of positions) {
      const w = weight(el.uid, uid);
      if (w > 0) (tx += p.x * w), (ty += p.y * w), (tw += w);
    }
    const target = tw ? { x: tx / tw, y: ty / tw } : centre;
    let found: Vec2 | null = null;
    for (let ring = 0; ring < 400 && !found; ring++) {
      const cands: Vec2[] = [];
      if (ring === 0) cands.push(target);
      else
        for (let k = -ring; k <= ring; k++)
          cands.push({ x: target.x + k * step, y: target.y - ring * step }, { x: target.x + k * step, y: target.y + ring * step }, { x: target.x - ring * step, y: target.y + k * step }, { x: target.x + ring * step, y: target.y + k * step });
      cands.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y));
      for (const c of cands) {
        const p = { x: Math.round(c.x * 20) / 20, y: Math.round(c.y * 20) / 20 };
        const b = boxAt(el, p);
        if (inside(b) && !overlaps(b)) {
          found = p;
          break;
        }
      }
    }
    if (!found) {
      report.failed.push(el.name);
      continue;
    }
    placedBoxes.push(boxAt(el, found));
    positions.set(el.uid, found);
    ops.push({ op: 'setRule', uid: el.uid, name: 'position', decl: { name: 'position', value: found } });
    report.placed.push({ ref: el.name, at: found });
  }
  return { ops, report };
}
