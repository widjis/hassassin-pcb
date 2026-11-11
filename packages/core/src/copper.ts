/**
 * World-space copper shapes and the board outline, shared by DRC, pours and fabrication
 * output. All shapes are reduced to two primitives:
 *   - "edges": line segments with a radius (traces, vias as zero-length segments,
 *     polygon borders with radius 0)
 *   - "areas": closed polygons (pads, pours) used for containment tests
 */
import type { Doc, DocNode, KeepOut, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { arcPoints, dist, emptyBox, growBox, pointInPolygon, type BBox } from './geom.ts';
import { frameOf, padGeom, toWorld } from './frames.ts';

export type CopperKind = 'pad' | 'trace' | 'via' | 'fill';

/** A polygon with optional holes: [outer, ...holes]. */
export type PolyWithHoles = Vec2[][];

export interface CopperShape {
  uid: string;
  kind: CopperKind;
  /** Net name, or null for unconnected copper (each such shape is its own net). */
  net: string | null;
  layer: string;
  /** Segments with a radius: [a, b, r]. */
  edges: [Vec2, Vec2, number][];
  /** Closed areas for containment (pads: outline; pours: polygons with holes). */
  areas: PolyWithHoles[];
  box: BBox;
  keepOut: KeepOut;
  edgeClearance: number;
  /** A point guaranteed to lie on this copper (for overlap detection). */
  probe: Vec2;
  /** Pad rotation (deg) for thermal spokes and flashes. */
  rot?: number;
  /** Pad/via drill (for npth handling and fabrication). */
  hole?: { center: Vec2; size: Vec2; rot: number; plated: boolean };
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export function netNameOf(doc: Doc, n: DocNode): string | null {
  if (n.type === 'pad') return typeof n.props.net === 'string' && n.props.net ? n.props.net : null;
  const p = n.parent ? doc.nodes.get(n.parent) : undefined;
  return p?.type === 'net' && p.name !== '(no net)' ? p.name : null;
}

function keepOutOf(engine: StyleEngine, uid: string): KeepOut {
  const v = engine.get(uid, 'keepOut')?.value as KeepOut | undefined;
  return v && typeof v === 'object' && 'byType' in v ? v : { byType: {} };
}

/** Clearance a shape demands from another kind of object. */
export function clearanceFor(k: KeepOut, other: CopperKind | 'net'): number {
  return k.byType[other] ?? (other !== 'fill' ? k.byType.net : undefined) ?? k.all ?? 0;
}

export function inArea(p: Vec2, a: PolyWithHoles): boolean {
  const [outer, ...holes] = a;
  if (!outer || !pointInPolygon(p, outer)) return false;
  return !holes.some((h) => pointInPolygon(p, h));
}

export function collectCopper(doc: Doc, engine: StyleEngine, copper: string[]): CopperShape[] {
  const out: CopperShape[] = [];
  const cu = new Set(copper);
  const edgeCl = (uid: string) => Number(engine.get(uid, 'boardEdgeClearance')?.value ?? 0) || 0;
  const disabled = (uid: string) => engine.get(uid, 'enabled')?.value === false;

  for (const n of doc.nodes.values()) {
    if (disabled(n.uid)) continue;
    const net = netNameOf(doc, n);
    if (n.type === 'pad') {
      const g = padGeom(doc, engine, n, copper);
      if (!g) continue;
      const padType = String(engine.get(n.uid, 'padType')?.value ?? 'smd');
      const hole = g.hole ? { center: g.center, size: g.hole, rot: g.rot, plated: padType !== 'npth' } : undefined;
      const ring = g.outline;
      const edges: [Vec2, Vec2, number][] = ring.map((p, i) => [p, ring[(i + 1) % ring.length]!, 0]);
      const box = emptyBox();
      for (const p of ring) growBox(box, p.x, p.y);
      for (const layer of g.layers) {
        if (!cu.has(layer)) continue;
        out.push({ uid: n.uid, kind: 'pad', net, layer, edges, areas: [[ring]], box, keepOut: keepOutOf(engine, n.uid), edgeClearance: edgeCl(n.uid), probe: g.center, rot: g.rot, ...(hole ? { hole } : {}) });
      }
      // An unplated hole with no copper still matters for fabrication.
      if (hole && !hole.plated && !g.layers.some((l) => cu.has(l))) {
        out.push({ uid: n.uid, kind: 'pad', net: null, layer: '__npth', edges: [], areas: [], box, keepOut: { byType: {} }, edgeClearance: 0, probe: g.center, hole });
      }
    } else if (n.type === 'trace') {
      const s = vec(engine.get(n.uid, 'start')?.value);
      const e = vec(engine.get(n.uid, 'end')?.value);
      const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
      if (!s || !e || !cu.has(layer)) continue;
      const m = vec(engine.get(n.uid, 'mid')?.value);
      const r = Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25) / 2;
      const path = m ? arcPoints(s, m, e) : [s, e];
      const edges: [Vec2, Vec2, number][] = [];
      const box = emptyBox();
      for (let i = 0; i + 1 < path.length; i++) edges.push([path[i]!, path[i + 1]!, r]);
      for (const p of path) growBox(box, p.x, p.y, r);
      out.push({ uid: n.uid, kind: 'trace', net, layer, edges, areas: [], box, keepOut: keepOutOf(engine, n.uid), edgeClearance: edgeCl(n.uid), probe: s });
    } else if (n.type === 'via') {
      const c = vec(engine.get(n.uid, 'position')?.value);
      if (!c) continue;
      const d = Number(engine.get(n.uid, 'viaDiameter')?.value ?? 0.6);
      const hd = Number(engine.get(n.uid, 'viaHole')?.value ?? 0.3);
      const raw = engine.get(n.uid, 'layers')?.value;
      const ls = (Array.isArray(raw) ? (raw as string[]) : []).flatMap((l) => (l === '*' ? copper : [l]));
      const idx = ls.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
      const span = idx.length >= 2 ? copper.slice(Math.min(...idx), Math.max(...idx) + 1) : copper;
      const box = emptyBox();
      growBox(box, c.x, c.y, d / 2);
      for (const layer of span) {
        out.push({
          uid: n.uid, kind: 'via', net, layer, edges: [[c, c, d / 2]], areas: [], box, keepOut: keepOutOf(engine, n.uid),
          edgeClearance: edgeCl(n.uid), probe: c, hole: { center: c, size: { x: hd, y: hd }, rot: 0, plated: true },
        });
      }
    } else if (n.type === 'fill') {
      const fills = (n.data?.fills ?? {}) as Record<string, PolyWithHoles[]>;
      for (const [layer, polys] of Object.entries(fills)) {
        if (!cu.has(layer)) continue;
        for (const poly of polys) {
          const outer = poly[0];
          if (!outer || outer.length < 3) continue;
          const edges: [Vec2, Vec2, number][] = [];
          const box = emptyBox();
          for (const ring of poly) for (let i = 0; i < ring.length; i++) edges.push([ring[i]!, ring[(i + 1) % ring.length]!, 0]);
          for (const p of outer) growBox(box, p.x, p.y);
          out.push({ uid: n.uid, kind: 'fill', net, layer, edges, areas: [poly], box, keepOut: keepOutOf(engine, n.uid), edgeClearance: edgeCl(n.uid), probe: outer[0]! });
        }
      }
    }
  }
  return out;
}

// ---------- board outline ----------

export interface BoardOutline {
  /** Closed loops; the first is the largest (the board), others are cutouts. */
  loops: Vec2[][];
  /** Every Edge.Cuts segment, for edge-clearance checks. */
  segments: [Vec2, Vec2][];
}

function areaOf(loop: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % loop.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Chain Edge.Cuts graphics into closed loops. */
export function boardOutline(doc: Doc, engine: StyleEngine): BoardOutline {
  const pieces: Vec2[][] = [];
  const closed: Vec2[][] = [];
  for (const n of doc.nodes.values()) {
    if (!['line', 'arc', 'circle', 'polygon', 'rectangle'].includes(n.type)) continue;
    if (engine.get(n.uid, 'layer')?.value !== 'Edge.Cuts') continue;
    const f = frameOf(doc, engine, n);
    const W = (p: Vec2) => toWorld(f, p);
    const g = (k: string) => vec(engine.get(n.uid, k)?.value);
    if (n.type === 'line') {
      const s = g('start');
      const e = g('end');
      if (s && e) pieces.push([W(s), W(e)]);
    } else if (n.type === 'arc') {
      const s = g('start');
      const m = g('mid');
      const e = g('end');
      if (s && m && e) pieces.push(arcPoints(W(s), W(m), W(e)));
    } else if (n.type === 'circle') {
      const c = g('center');
      const r = Number(engine.get(n.uid, 'radius')?.value ?? 0);
      if (c && r > 0) {
        const cw = W(c);
        const k = Math.max(32, Math.ceil(r * 8));
        closed.push(Array.from({ length: k }, (_, i) => ({ x: cw.x + Math.cos((i / k) * Math.PI * 2) * r, y: cw.y + Math.sin((i / k) * Math.PI * 2) * r })));
      }
    } else {
      const pts = (engine.get(n.uid, 'points')?.value as Vec2[] | undefined)?.map(W);
      if (pts && pts.length >= 3) closed.push(pts);
    }
  }
  const segments: [Vec2, Vec2][] = [];
  for (const p of pieces) for (let i = 0; i + 1 < p.length; i++) segments.push([p[i]!, p[i + 1]!]);
  for (const c of closed) for (let i = 0; i < c.length; i++) segments.push([c[i]!, c[(i + 1) % c.length]!]);

  // Greedy chaining of open pieces by matching endpoints.
  const tol = 0.01;
  const left = pieces.slice();
  while (left.length) {
    let chain = left.pop()!.slice();
    let grew = true;
    while (grew) {
      grew = false;
      const end = chain[chain.length - 1]!;
      const start = chain[0]!;
      if (chain.length > 2 && dist(end, start) < tol) break;
      for (let i = 0; i < left.length; i++) {
        const p = left[i]!;
        const a = p[0]!;
        const b = p[p.length - 1]!;
        if (dist(end, a) < tol) chain = chain.concat(p.slice(1));
        else if (dist(end, b) < tol) chain = chain.concat(p.slice(0, -1).reverse());
        else if (dist(start, b) < tol) chain = p.slice(0, -1).concat(chain);
        else if (dist(start, a) < tol) chain = p.slice(1).reverse().concat(chain);
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain.length > 3 && dist(chain[0]!, chain[chain.length - 1]!) < tol) closed.push(chain.slice(0, -1));
  }
  closed.sort((a, b) => Math.abs(areaOf(b)) - Math.abs(areaOf(a)));
  return { loops: closed, segments };
}
