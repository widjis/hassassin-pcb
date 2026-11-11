/**
 * Copper connectivity per net and the ratsnest (shortest set of missing connections).
 *
 * Items of a net — pads, trace segments, vias, pour polygons — are joined when they
 * touch on a shared copper layer. Each connected group is an "island"; the ratsnest is
 * a minimum spanning tree over the islands using the nearest anchor points.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { arcPoints, dist, distToSegment, pointInPolygon } from './geom.ts';
import { padGeom, type PadGeom } from './frames.ts';
import { inArea, type PolyWithHoles } from './copper.ts';

export interface RatLine {
  net: string;
  a: Vec2;
  b: Vec2;
}

export interface NetStatus {
  net: string;
  islands: number;
  pads: number;
}

export interface Ratsnest {
  lines: RatLine[];
  nets: NetStatus[];
  /** Nets with more than one island. */
  unroutedNets: number;
}

class DSU {
  p: number[] = [];
  add(): number {
    this.p.push(this.p.length);
    return this.p.length - 1;
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]!]!;
      i = this.p[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

interface TraceItem {
  id: number;
  layer: string;
  path: Vec2[];
  half: number;
}
interface ViaItem {
  id: number;
  c: Vec2;
  r: number;
  layers: Set<string>;
}
interface PadItem {
  id: number;
  g: PadGeom;
  layers: Set<string>;
}
interface FillItem {
  id: number;
  layer: string;
  poly: PolyWithHoles;
}

export function computeRatsnest(doc: Doc, engine: StyleEngine, copper: string[]): Ratsnest {
  const copperSet = new Set(copper);
  const padsByNet = new Map<string, DocNode[]>();
  const netNodes = new Map<string, DocNode>();
  for (const n of doc.nodes.values()) {
    if (n.type === 'pad' && typeof n.props.net === 'string' && n.props.net) {
      const list = padsByNet.get(n.props.net) ?? [];
      list.push(n);
      padsByNet.set(n.props.net, list);
    } else if (n.type === 'net') netNodes.set(n.name, n);
  }
  const names = new Set([...padsByNet.keys(), ...netNodes.keys()]);
  const lines: RatLine[] = [];
  const nets: NetStatus[] = [];

  for (const net of names) {
    if (net === '(no net)') continue;
    const dsu = new DSU();
    const anchors: { id: number; p: Vec2 }[] = [];
    const pads: PadItem[] = [];
    const traces: TraceItem[] = [];
    const vias: ViaItem[] = [];
    const fills: FillItem[] = [];

    for (const p of padsByNet.get(net) ?? []) {
      if (engine.get(p.uid, 'enabled')?.value === false) continue;
      const g = padGeom(doc, engine, p, copper);
      if (!g) continue;
      const layers = new Set(g.layers.filter((l) => copperSet.has(l)));
      if (!layers.size) continue;
      const id = dsu.add();
      pads.push({ id, g, layers });
      anchors.push({ id, p: g.center });
    }
    const netNode = netNodes.get(net);
    for (const c of netNode?.children ?? []) {
      const n = doc.nodes.get(c);
      if (!n || engine.get(n.uid, 'enabled')?.value === false) continue;
      if (n.type === 'trace') {
        const s = vec(engine.get(n.uid, 'start')?.value);
        const e = vec(engine.get(n.uid, 'end')?.value);
        if (!s || !e) continue;
        const m = vec(engine.get(n.uid, 'mid')?.value);
        const id = dsu.add();
        const w = Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25);
        traces.push({ id, layer: String(engine.get(n.uid, 'layer')?.value ?? 'F.Cu'), path: m ? arcPoints(s, m, e) : [s, e], half: w / 2 });
        anchors.push({ id, p: s }, { id, p: e });
      } else if (n.type === 'via') {
        const c0 = vec(engine.get(n.uid, 'position')?.value);
        if (!c0) continue;
        const id = dsu.add();
        const raw = engine.get(n.uid, 'layers')?.value;
        const ls = (Array.isArray(raw) ? (raw as string[]) : []).flatMap((l) => (l === '*' ? copper : [l]));
        // through/blind: span between the listed copper layers
        const idx = ls.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
        const span = idx.length >= 2 ? copper.slice(Math.min(...idx), Math.max(...idx) + 1) : copper;
        vias.push({ id, c: c0, r: Number(engine.get(n.uid, 'viaDiameter')?.value ?? 0.6) / 2, layers: new Set(span) });
        anchors.push({ id, p: c0 });
      } else if (n.type === 'fill') {
        const polys = (n.data?.fills ?? {}) as Record<string, PolyWithHoles[]>;
        for (const [layer, list] of Object.entries(polys)) {
          for (const poly of list) {
            if (!poly[0] || poly[0].length < 3) continue;
            fills.push({ id: dsu.add(), layer, poly });
          }
        }
      }
    }

    const ends = (t: TraceItem) => [t.path[0]!, t.path[t.path.length - 1]!];
    const onTrace = (p: Vec2, t: TraceItem, extra: number) => {
      for (let i = 0; i + 1 < t.path.length; i++) if (distToSegment(p, t.path[i]!, t.path[i + 1]!) <= t.half + extra) return true;
      return false;
    };

    // trace ↔ trace (shared endpoint or T-junction), trace ↔ pad, trace ↔ via, trace ↔ fill
    for (let i = 0; i < traces.length; i++) {
      const a = traces[i]!;
      for (let j = i + 1; j < traces.length; j++) {
        const b = traces[j]!;
        if (a.layer !== b.layer) continue;
        if (ends(a).some((p) => onTrace(p, b, 1e-3)) || ends(b).some((p) => onTrace(p, a, 1e-3))) dsu.union(a.id, b.id);
      }
      for (const p of pads) {
        if (!p.layers.has(a.layer)) continue;
        if (ends(a).some((e) => pointInPolygon(e, p.g.outline) || dist(e, p.g.center) <= a.half) || onTrace(p.g.center, a, 0)) dsu.union(a.id, p.id);
      }
      for (const v of vias) {
        if (!v.layers.has(a.layer)) continue;
        if (ends(a).some((e) => dist(e, v.c) <= v.r + 1e-3) || onTrace(v.c, a, 0)) dsu.union(a.id, v.id);
      }
      for (const f of fills) if (f.layer === a.layer && ends(a).some((e) => inArea(e, f.poly))) dsu.union(a.id, f.id);
    }
    for (const v of vias) {
      for (const p of pads) if ([...v.layers].some((l) => p.layers.has(l)) && pointInPolygon(v.c, p.g.outline)) dsu.union(v.id, p.id);
      for (const f of fills) if (v.layers.has(f.layer) && inArea(v.c, f.poly)) dsu.union(v.id, f.id);
      for (const w of vias) if (w.id < v.id && dist(w.c, v.c) < Math.max(w.r, v.r)) dsu.union(v.id, w.id);
    }
    for (const p of pads) for (const f of fills) if (p.layers.has(f.layer) && (inArea(p.g.center, f.poly) || p.g.outline.some((q) => inArea(q, f.poly)))) dsu.union(p.id, f.id);
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const a = pads[i]!;
        const b = pads[j]!;
        if ([...a.layers].some((l) => b.layers.has(l)) && (pointInPolygon(a.g.center, b.g.outline) || pointInPolygon(b.g.center, a.g.outline))) dsu.union(a.id, b.id);
      }
    }

    // Group anchors by island; only islands that contain a pad matter for "unrouted".
    const islands = new Map<number, Vec2[]>();
    const islandHasPad = new Set<number>();
    for (const p of pads) islandHasPad.add(dsu.find(p.id));
    for (const a of anchors) {
      const r = dsu.find(a.id);
      if (!islandHasPad.has(r)) continue;
      const list = islands.get(r) ?? [];
      list.push(a.p);
      islands.set(r, list);
    }
    const groups = [...islands.values()];
    nets.push({ net, islands: groups.length, pads: pads.length });
    if (groups.length < 2) continue;

    // Prim's MST over islands.
    const inTree = new Array(groups.length).fill(false);
    const best = new Array<number>(groups.length).fill(Infinity);
    const bestPair = new Array<[Vec2, Vec2] | null>(groups.length).fill(null);
    const nearest = (A: Vec2[], B: Vec2[]): [number, Vec2, Vec2] => {
      let d = Infinity;
      let pa = A[0]!;
      let pb = B[0]!;
      for (const a of A) for (const b of B) {
        const x = dist(a, b);
        if (x < d) [d, pa, pb] = [x, a, b];
      }
      return [d, pa, pb];
    };
    inTree[0] = true;
    for (let k = 1; k < groups.length; k++) {
      const [d, a, b] = nearest(groups[0]!, groups[k]!);
      best[k] = d;
      bestPair[k] = [a, b];
    }
    for (let added = 1; added < groups.length; added++) {
      let pick = -1;
      for (let k = 0; k < groups.length; k++) if (!inTree[k] && (pick < 0 || best[k]! < best[pick]!)) pick = k;
      if (pick < 0) break;
      inTree[pick] = true;
      const pair = bestPair[pick]!;
      lines.push({ net, a: pair[0], b: pair[1] });
      for (let k = 0; k < groups.length; k++) {
        if (inTree[k]) continue;
        const [d, a, b] = nearest(groups[pick]!, groups[k]!);
        if (d < best[k]!) {
          best[k] = d;
          bestPair[k] = [b, a];
        }
      }
    }
  }
  return { lines, nets, unroutedNets: nets.filter((n) => n.islands > 1).length };
}
