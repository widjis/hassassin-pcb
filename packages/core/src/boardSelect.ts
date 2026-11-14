/**
 * Box selection on the board (docs/05-pcb-improvements.md, P1), and moving / rotating a selection as one
 * group. The same rule as the schematic (S2): a box drawn left to right picks what lies fully inside it, a
 * box drawn right to left also what it touches. A filter says which kinds of item a box picks and on which
 * layers.
 */
import type { Op } from './commands.ts';
import { componentExtent } from './autoplace.ts';
import { frameOf, padGeom, toWorld } from './frames.ts';
import { arcPoints, place, pointInPolygon } from './geom.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export type BoxKind = 'parts' | 'traces' | 'vias' | 'pours' | 'graphics';
export const BOX_KINDS: BoxKind[] = ['parts', 'traces', 'vias', 'pours', 'graphics'];

export interface BoxRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BoxFilter {
  /** Kinds the box picks (default: all). */
  kinds?: BoxKind[];
  /** Whether an item on these layers may be picked (e.g. visible layers, or the active layer only). */
  layer?: (layer: string) => boolean;
}

const GRAPHICS = new Set(['line', 'arc', 'circle', 'polygon', 'rectangle', 'text']);
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** The shape of one selectable item: closed or open polylines (world), and its layers. */
interface Shape {
  uid: string;
  kind: BoxKind;
  layers: string[];
  paths: { pts: Vec2[]; closed: boolean; pad: number; filled?: boolean }[];
}

function expand(raw: unknown, copper: string[]): string[] {
  const ls = Array.isArray(raw) ? (raw as string[]) : [];
  return ls.flatMap((l) => (l === '*' ? copper : l === '*.Cu' ? copper : [l]));
}

function shapeOf(doc: Doc, engine: StyleEngine, copper: string[], n: DocNode): Shape | undefined {
  if (engine.get(n.uid, 'enabled')?.value === false) return undefined;
  const parent = n.parent ? doc.nodes.get(n.parent) : undefined;
  if (n.type === 'element') {
    const pos = vec(engine.get(n.uid, 'position')?.value) ?? { x: 0, y: 0 };
    const e = componentExtent(doc, engine, n, copper);
    const pts = [
      { x: pos.x + e.minX, y: pos.y + e.minY },
      { x: pos.x + e.maxX, y: pos.y + e.minY },
      { x: pos.x + e.maxX, y: pos.y + e.maxY },
      { x: pos.x + e.minX, y: pos.y + e.maxY },
    ];
    const layers = new Set<string>([String(engine.get(n.uid, 'layer')?.value ?? 'F.Cu')]);
    for (const c of n.children) {
      const p = doc.nodes.get(c);
      if (p?.type === 'pad') for (const l of padGeom(doc, engine, p, copper)?.layers ?? []) layers.add(l);
    }
    return { uid: n.uid, kind: 'parts', layers: [...layers], paths: [{ pts, closed: true, pad: 0, filled: true }] };
  }
  if (n.type === 'trace') {
    const s = vec(engine.get(n.uid, 'start')?.value);
    const t = vec(engine.get(n.uid, 'end')?.value);
    if (!s || !t) return undefined;
    const m = vec(engine.get(n.uid, 'mid')?.value);
    const w = Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25);
    return { uid: n.uid, kind: 'traces', layers: [String(engine.get(n.uid, 'layer')?.value ?? '')], paths: [{ pts: m ? arcPoints(s, m, t) : [s, t], closed: false, pad: w / 2 }] };
  }
  if (n.type === 'via') {
    const c = vec(engine.get(n.uid, 'position')?.value);
    if (!c) return undefined;
    const d = Number(engine.get(n.uid, 'viaDiameter')?.value ?? 0.6);
    return { uid: n.uid, kind: 'vias', layers: expand(engine.get(n.uid, 'layers')?.value, copper), paths: [{ pts: [c], closed: false, pad: d / 2 }] };
  }
  if (n.type === 'zone' || n.type === 'fill') {
    const pts = (engine.get(n.uid, 'points')?.value as Vec2[] | undefined) ?? [];
    if (pts.length < 3) return undefined;
    return { uid: n.uid, kind: 'pours', layers: expand(engine.get(n.uid, 'layers')?.value, copper), paths: [{ pts, closed: true, pad: 0, filled: true }] };
  }
  if (GRAPHICS.has(n.type) && parent?.type !== 'element') {
    const f = frameOf(doc, engine, n);
    const W = (p: Vec2) => toWorld(f, p);
    const layer = String(engine.get(n.uid, 'layer')?.value ?? 'F.SilkS');
    const w = Number(engine.get(n.uid, 'strokeWidth')?.value ?? 0.15);
    const g = (k: string) => vec(engine.get(n.uid, k)?.value);
    let pts: Vec2[] = [];
    let closed = false;
    if (n.type === 'line') {
      const s = g('start');
      const t = g('end');
      if (s && t) pts = [W(s), W(t)];
    } else if (n.type === 'arc') {
      const s = g('start');
      const m = g('mid');
      const t = g('end');
      if (s && m && t) pts = arcPoints(W(s), W(m), W(t));
    } else if (n.type === 'circle') {
      const c = g('center');
      const r = Number(engine.get(n.uid, 'radius')?.value ?? 0);
      if (c) {
        const cw = W(c);
        pts = Array.from({ length: 32 }, (_, i) => ({ x: cw.x + Math.cos((i / 32) * 2 * Math.PI) * r, y: cw.y + Math.sin((i / 32) * 2 * Math.PI) * r }));
        closed = true;
      }
    } else if (n.type === 'text') {
      const p = g('position');
      const size = Number(engine.get(n.uid, 'fontSize')?.value ?? 1);
      if (p) pts = [W(p)];
      return pts.length ? { uid: n.uid, kind: 'graphics', layers: [layer], paths: [{ pts, closed: false, pad: size / 2 }] } : undefined;
    } else {
      pts = ((engine.get(n.uid, 'points')?.value as Vec2[] | undefined) ?? []).map(W);
      closed = true;
    }
    const filled = closed && engine.get(n.uid, 'filled')?.value === true;
    return pts.length ? { uid: n.uid, kind: 'graphics', layers: [layer], paths: [{ pts, closed, pad: w / 2, filled }] } : undefined;
  }
  return undefined;
}

const inRect = (p: Vec2, r: BoxRect, pad = 0) => p.x - pad >= r.minX && p.x + pad <= r.maxX && p.y - pad >= r.minY && p.y + pad <= r.maxY;

function segHitsRect(a: Vec2, b: Vec2, r: BoxRect, pad: number): boolean {
  const R = { minX: r.minX - pad, minY: r.minY - pad, maxX: r.maxX + pad, maxY: r.maxY + pad };
  if (inRect(a, R) || inRect(b, R)) return true;
  // Liang–Barsky clip of the segment against the rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [
    [-dx, a.x - R.minX],
    [dx, R.maxX - a.x],
    [-dy, a.y - R.minY],
    [dy, R.maxY - a.y],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function touches(s: Shape, r: BoxRect): boolean {
  for (const path of s.paths) {
    const { pts, closed, pad, filled } = path;
    if (pts.length === 1) {
      if (segHitsRect(pts[0]!, pts[0]!, r, pad)) return true;
      continue;
    }
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) if (segHitsRect(pts[i]!, pts[(i + 1) % pts.length]!, r, pad)) return true;
    // A box wholly inside a filled shape (a part, a pour) touches it too; an outline only by its edges.
    if (filled && pointInPolygon({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 }, pts)) return true;
  }
  return false;
}

const inside = (s: Shape, r: BoxRect) => s.paths.every((p) => p.pts.every((q) => inRect(q, r, p.pad)));

/** The board items a box picks: `inside` (drawn left to right) or `touch` (right to left). */
export function boardItemsInRect(doc: Doc, engine: StyleEngine, copper: string[], r: BoxRect, mode: 'inside' | 'touch', f: BoxFilter = {}): string[] {
  const kinds = new Set(f.kinds ?? BOX_KINDS);
  const out: string[] = [];
  for (const n of doc.nodes.values()) {
    const s = shapeOf(doc, engine, copper, n);
    if (!s || !kinds.has(s.kind)) continue;
    if (f.layer && !s.layers.some(f.layer)) continue;
    if (mode === 'inside' ? inside(s, r) : touches(s, r)) out.push(n.uid);
  }
  return out;
}

/** Point rules of a board item that move with it (start / end / mid, position, center, points). */
export function movablePoints(engine: StyleEngine, n: DocNode): Record<string, Vec2 | Vec2[]> {
  const out: Record<string, Vec2 | Vec2[]> = {};
  const keys = n.type === 'trace' || n.type === 'line' || n.type === 'arc' ? ['start', 'end', 'mid'] : n.type === 'circle' ? ['center'] : ['position'];
  for (const k of keys) {
    const v = vec(engine.get(n.uid, k)?.value);
    if (v) out[k] = { ...v };
  }
  if (['polygon', 'rectangle', 'zone', 'fill'].includes(n.type)) {
    const pts = engine.get(n.uid, 'points')?.value;
    if (Array.isArray(pts)) out.points = (pts as Vec2[]).map((p) => ({ ...p }));
  }
  return out;
}

/** Board items a selection drags along: parts, traces, vias, pours and graphics not inside a part. */
export function isBoardMovable(doc: Doc, n: DocNode): boolean {
  if (['element', 'trace', 'via', 'zone', 'fill'].includes(n.type)) return true;
  return GRAPHICS.has(n.type) && (n.parent ? doc.nodes.get(n.parent)?.type !== 'element' : true);
}

/**
 * Rotate a selection by `deg` (counter-clockwise, as the `rotation` rule) about the centre of its bounding
 * box, as one list of operations: parts turn and move round the centre; traces, vias, pours and graphics
 * have their points turned (a pour's filled copper too). Locked items stay.
 */
export function rotateSelectionOps(doc: Doc, engine: StyleEngine, copper: string[], uids: string[], deg: number): Op[] {
  const items = uids.map((u) => doc.nodes.get(u)).filter((n): n is DocNode => !!n && isBoardMovable(doc, n) && !n.props.locked);
  if (!items.length) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of items) {
    const s = shapeOf(doc, engine, copper, n);
    for (const p of s?.paths ?? []) for (const q of p.pts) (minX = Math.min(minX, q.x)), (minY = Math.min(minY, q.y)), (maxX = Math.max(maxX, q.x)), (maxY = Math.max(maxY, q.y));
  }
  if (!Number.isFinite(minX)) return [];
  const c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const turn = (p: Vec2): Vec2 => {
    const q = place({ x: p.x - c.x, y: p.y - c.y }, c, deg);
    return { x: Math.round(q.x * 1e4) / 1e4, y: Math.round(q.y * 1e4) / 1e4 };
  };
  const ops: Op[] = [];
  for (const n of items) {
    const pts = movablePoints(engine, n);
    for (const [k, v] of Object.entries(pts)) ops.push({ op: 'setRule', uid: n.uid, name: k, decl: { name: k, value: Array.isArray(v) ? v.map(turn) : turn(v) } });
    // A pour's filled copper turns with its outline (no refill needed for the move itself).
    if (n.type === 'fill' && n.data?.fills) ops.push({ op: 'setData', uid: n.uid, key: 'fills', value: mapFills(n.data.fills, turn) });
    if (n.type === 'element') {
      const cur = Number(engine.get(n.uid, 'rotation')?.value ?? 0);
      ops.push({ op: 'setRule', uid: n.uid, name: 'rotation', decl: { name: 'rotation', value: (((cur + deg) % 360) + 360) % 360 } });
    }
    if (n.type === 'text') {
      const cur = Number(engine.get(n.uid, 'rotation')?.value ?? 0);
      ops.push({ op: 'setRule', uid: n.uid, name: 'rotation', decl: { name: 'rotation', value: (((cur + deg) % 360) + 360) % 360 } });
    }
  }
  return ops;
}

/** A pour's filled polygons (per layer, polygons with holes) with every point mapped. */
export function mapFills(fills: unknown, f: (p: Vec2) => Vec2): Record<string, Vec2[][][]> {
  const out: Record<string, Vec2[][][]> = {};
  for (const [layer, polys] of Object.entries((fills ?? {}) as Record<string, Vec2[][][]>)) out[layer] = polys.map((poly) => poly.map((ring) => ring.map(f)));
  return out;
}
