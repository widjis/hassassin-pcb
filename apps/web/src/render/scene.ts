/**
 * Drawable geometry built from *computed* rule values, cached per node so that an edit
 * only re-tessellates the nodes it touched.
 */
import {
  arcPoints,
  distToSegment,
  emptyBox,
  frameOf,
  growBox,
  padGeom,
  padOutline,
  place,
  pointInPolygon,
  toWorld,
  type BBox,
  type Doc,
  type DocNode,
  type StyleEngine,
  type Vec2,
} from '@hassassin/core';
import { circle, fillPolygon, polyline, ring, type Tris } from './geometry.ts';

export const HOLES = 'Holes';

export interface Pickable {
  uid: string;
  layers: string[];
  /** Larger wins when several shapes are under the cursor. */
  priority: number;
  box: BBox;
  hit: (p: Vec2, tol: number) => boolean;
  /** Snap point offered to tools (pad/via centre). */
  anchor?: Vec2;
}

export interface TextItem {
  uid: string;
  layer: string;
  pos: Vec2;
  rot: number;
  text: string;
  size: number;
  kind: 'text' | 'padNumber';
}

type Sink = (layer: string) => Tris | null;

interface NodeGeom {
  tris: Map<string, Tris>;
  pick: Pickable[];
  texts: TextItem[];
}

const v2 = (e: StyleEngine, uid: string, rule: string): Vec2 | undefined => {
  const v = e.get(uid, rule)?.value;
  return v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined;
};
const numOf = (e: StyleEngine, uid: string, rule: string, d: number) => {
  const v = e.get(uid, rule)?.value;
  return typeof v === 'number' ? v : d;
};
const strOf = (e: StyleEngine, uid: string, rule: string, d: string) => {
  const v = e.get(uid, rule)?.value;
  return typeof v === 'string' ? v : d;
};
const listOf = (e: StyleEngine, uid: string, rule: string): string[] => {
  const v = e.get(uid, rule)?.value;
  return Array.isArray(v) ? (v as string[]) : [];
};
const expand = (layers: string[], copper: string[]) => layers.flatMap((l) => (l === '*' ? copper : [l]));

export function copperSpan(layers: string[], copper: string[]): string[] {
  const idx = layers.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
  if (idx.length < 2) return layers.length ? layers : copper;
  return copper.slice(Math.min(...idx), Math.max(...idx) + 1);
}

/** Emit one node's own geometry (not its children). */
export function emitNode(doc: Doc, e: StyleEngine, node: DocNode, copper: string[], sink: Sink, geom?: NodeGeom): void {
  const uid = node.uid;
  if (e.get(uid, 'enabled')?.value === false) return;
  if (node.type !== 'text' && e.get(uid, 'visible')?.value === false) return;

  const reg = (layers: string[], priority: number, box: BBox, hit: Pickable['hit'], anchor?: Vec2) => {
    geom?.pick.push({ uid, layers, priority, box, hit, ...(anchor ? { anchor } : {}) });
  };

  switch (node.type) {
    case 'trace': {
      const s = v2(e, uid, 'start');
      const t = v2(e, uid, 'end');
      if (!s || !t) return;
      const w = numOf(e, uid, 'traceWidth', 0.25);
      const layer = strOf(e, uid, 'layer', 'F.Cu');
      const mid = v2(e, uid, 'mid');
      const path = mid ? arcPoints(s, mid, t) : [s, t];
      const out = sink(layer);
      if (out) polyline(out, path, w, false);
      const box = emptyBox();
      for (const p of path) growBox(box, p.x, p.y, w / 2);
      reg([layer], 3, box, (p, tol) => {
        for (let i = 0; i + 1 < path.length; i++) if (distToSegment(p, path[i]!, path[i + 1]!) <= w / 2 + tol) return true;
        return false;
      });
      return;
    }
    case 'via': {
      const c = v2(e, uid, 'position');
      if (!c) return;
      const d = numOf(e, uid, 'viaDiameter', 0.6);
      const h = numOf(e, uid, 'viaHole', 0.3);
      const span = copperSpan(expand(listOf(e, uid, 'layers'), copper), copper);
      for (const l of span) {
        const out = sink(l);
        if (out) ring(out, c, d / 2, h / 2);
      }
      const hole = sink(HOLES);
      if (hole) circle(hole, c, h / 2);
      const box = emptyBox();
      growBox(box, c.x, c.y, d / 2);
      reg(span, 4, box, (p, tol) => Math.hypot(p.x - c.x, p.y - c.y) <= d / 2 + tol, c);
      return;
    }
    case 'pad': {
      const g = padGeom(doc, e, node, copper);
      if (!g) return;
      const custom = e.get(uid, 'points')?.value as Vec2[] | undefined;
      const customWorld = Array.isArray(custom) && custom.length >= 3 ? custom.map((p) => place(p, g.center, g.rot)) : null;
      for (const l of g.layers) {
        const out = sink(l);
        if (!out) continue;
        fillPolygon(out, g.outline);
        if (customWorld) fillPolygon(out, customWorld);
      }
      if (g.hole) {
        const hole = sink(HOLES);
        if (hole) fillPolygon(hole, padOutline(g.hole.x === g.hole.y ? 'circle' : 'oval', g.hole, 0.5).map((p) => place(p, g.center, g.rot)));
      }
      const box = emptyBox();
      for (const p of g.outline) growBox(box, p.x, p.y);
      reg(g.layers, 5, box, (p, tol) => pointInPolygon(p, g.outline) || (tol > 0 && g.outline.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol)), g.center);
      const label = String(node.props.number ?? node.name);
      const sizeV = e.get(uid, 'size')?.value as Vec2 | number | undefined;
      const minSide = typeof sizeV === 'number' ? sizeV : sizeV ? Math.min(sizeV.x, sizeV.y) : 1;
      if (label && geom) geom.texts.push({ uid, layer: g.layers.find((l) => l.endsWith('.Cu')) ?? g.layers[0] ?? 'F.Cu', pos: g.center, rot: 0, text: label, size: minSide * 0.55, kind: 'padNumber' });
      return;
    }
    case 'fill': {
      const fills = (node.data?.fills ?? {}) as Record<string, Vec2[][]>;
      let any = false;
      for (const [layer, polys] of Object.entries(fills)) {
        const out = sink(layer);
        if (!out) continue;
        for (const poly of polys) fillPolygon(out, poly);
        any = true;
      }
      const outline = (e.get(uid, 'points')?.value as Vec2[]) ?? [];
      if (!any && outline.length > 2) {
        for (const l of expand(listOf(e, uid, 'layers'), copper)) {
          const out = sink(l);
          if (out) polyline(out, outline, 0.1, true);
        }
      }
      return;
    }
    case 'zone': {
      const outline = (e.get(uid, 'points')?.value as Vec2[]) ?? [];
      for (const l of expand(listOf(e, uid, 'layers'), copper)) {
        const out = sink(l);
        if (out) polyline(out, outline, 0.08, true);
      }
      return;
    }
    case 'line':
    case 'arc':
    case 'circle':
    case 'polygon':
    case 'rectangle': {
      const f = frameOf(doc, e, node);
      const W = (p: Vec2) => toWorld(f, p);
      const layer = strOf(e, uid, 'layer', 'F.SilkS');
      const w = numOf(e, uid, 'strokeWidth', 0.15);
      const filled = e.get(uid, 'filled')?.value === true;
      let path: Vec2[] = [];
      let closed = false;
      if (node.type === 'line') {
        const s = v2(e, uid, 'start');
        const t = v2(e, uid, 'end');
        if (s && t) path = [W(s), W(t)];
      } else if (node.type === 'arc') {
        const s = v2(e, uid, 'start');
        const m = v2(e, uid, 'mid');
        const t = v2(e, uid, 'end');
        if (s && m && t) path = arcPoints(W(s), W(m), W(t));
      } else if (node.type === 'circle') {
        const c = v2(e, uid, 'center');
        if (!c) return;
        const cw = W(c);
        const r = numOf(e, uid, 'radius', 0);
        const n = Math.max(24, Math.ceil(r * 16));
        path = Array.from({ length: n }, (_, i) => ({ x: cw.x + Math.cos((i / n) * 2 * Math.PI) * r, y: cw.y + Math.sin((i / n) * 2 * Math.PI) * r }));
        closed = true;
      } else {
        path = ((e.get(uid, 'points')?.value as Vec2[]) ?? []).map(W);
        closed = true;
      }
      if (path.length < 2) return;
      const out = sink(layer);
      if (out) {
        if (filled && closed) fillPolygon(out, path);
        if (w > 0) polyline(out, path, w, closed);
      }
      const box = emptyBox();
      for (const p of path) growBox(box, p.x, p.y, w / 2);
      reg([layer], 1, box, (p, tol) => {
        if (filled && closed && pointInPolygon(p, path)) return true;
        for (let i = 0; i + 1 < path.length; i++) if (distToSegment(p, path[i]!, path[i + 1]!) <= w / 2 + tol) return true;
        return closed && path.length > 2 ? distToSegment(p, path[path.length - 1]!, path[0]!) <= w / 2 + tol : false;
      });
      return;
    }
    case 'text': {
      if (!geom || e.get(uid, 'visible')?.value === false) return;
      const local = v2(e, uid, 'position');
      const text = strOf(e, uid, 'text', node.name);
      if (!local || !text) return;
      const f = frameOf(doc, e, node);
      geom.texts.push({
        uid,
        layer: strOf(e, uid, 'layer', 'F.SilkS'),
        pos: toWorld(f, local),
        rot: f.rot + numOf(e, uid, 'rotation', 0),
        text,
        size: numOf(e, uid, 'fontSize', 1),
        kind: 'text',
      });
      return;
    }
    default:
      return;
  }
}

/** Per-node geometry cache with cheap partial updates. */
export class SceneCache {
  private nodes = new Map<string, NodeGeom>();
  private dirtyLayers = true;
  private layerCache = new Map<string, Float32Array>();
  private pickCache: Pickable[] | null = null;
  private textCache: TextItem[] | null = null;

  constructor(
    private doc: Doc,
    private engine: StyleEngine,
    private copper: string[],
  ) {
    this.rebuildAll();
  }

  private emit(n: DocNode): void {
    const g: NodeGeom = { tris: new Map(), pick: [], texts: [] };
    const sink: Sink = (layer) => {
      let a = g.tris.get(layer);
      if (!a) g.tris.set(layer, (a = []));
      return a;
    };
    emitNode(this.doc, this.engine, n, this.copper, sink, g);
    if (g.tris.size || g.pick.length || g.texts.length) this.nodes.set(n.uid, g);
    else this.nodes.delete(n.uid);
  }

  private invalidate(): void {
    this.dirtyLayers = true;
    this.pickCache = null;
    this.textCache = null;
  }

  rebuildAll(): void {
    this.nodes.clear();
    for (const n of this.doc.nodes.values()) this.emit(n);
    this.invalidate();
  }

  /** Re-emit the given nodes and all their descendants; drop ones that no longer exist. */
  update(uids: Iterable<string>): void {
    const seen = new Set<string>();
    const visit = (uid: string) => {
      if (seen.has(uid)) return;
      seen.add(uid);
      const n = this.doc.nodes.get(uid);
      if (!n) {
        this.nodes.delete(uid);
        return;
      }
      this.emit(n);
      n.children.forEach(visit);
    };
    for (const u of uids) visit(u);
    this.invalidate();
  }

  /** Returns per-layer triangle buffers; `changed` is true when they were rebuilt. */
  layers(): { layers: Map<string, Float32Array>; changed: boolean } {
    if (!this.dirtyLayers) return { layers: this.layerCache, changed: false };
    const sizes = new Map<string, number>();
    for (const g of this.nodes.values()) for (const [l, t] of g.tris) sizes.set(l, (sizes.get(l) ?? 0) + t.length);
    const out = new Map<string, Float32Array>();
    const offs = new Map<string, number>();
    for (const [l, n] of sizes) {
      out.set(l, new Float32Array(n));
      offs.set(l, 0);
    }
    for (const g of this.nodes.values()) {
      for (const [l, t] of g.tris) {
        const arr = out.get(l)!;
        const o = offs.get(l)!;
        arr.set(t, o);
        offs.set(l, o + t.length);
      }
    }
    this.layerCache = out;
    this.dirtyLayers = false;
    return { layers: out, changed: true };
  }

  get pick(): Pickable[] {
    if (!this.pickCache) this.pickCache = [...this.nodes.values()].flatMap((g) => g.pick);
    return this.pickCache;
  }

  get texts(): TextItem[] {
    if (!this.textCache) this.textCache = [...this.nodes.values()].flatMap((g) => g.texts);
    return this.textCache;
  }

  get bbox(): BBox {
    const b = emptyBox();
    for (const p of this.pick) {
      growBox(b, p.box.minX, p.box.minY);
      growBox(b, p.box.maxX, p.box.maxY);
    }
    return b;
  }
}

/** Triangles for a set of nodes and all their descendants, merged into one array. */
export function highlightTris(doc: Doc, e: StyleEngine, uids: Iterable<string>, copper: string[], visible: (layer: string) => boolean): Float32Array {
  const out: Tris = [];
  const seen = new Set<string>();
  const sink: Sink = (layer) => (visible(layer) && layer !== HOLES ? out : null);
  const visit = (uid: string) => {
    if (seen.has(uid)) return;
    seen.add(uid);
    const n = doc.nodes.get(uid);
    if (!n) return;
    emitNode(doc, e, n, copper, sink);
    for (const c of n.children) visit(c);
  };
  for (const u of uids) visit(u);
  return new Float32Array(out);
}
