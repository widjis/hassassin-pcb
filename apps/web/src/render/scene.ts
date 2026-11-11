/**
 * Build drawable geometry from the document, reading only *computed* rule values.
 */
import type { Doc, DocNode, StyleEngine, Vec2 } from '@hassassin/core';
import {
  arcPoints,
  circle,
  distToSegment,
  emptyBox,
  fillPolygon,
  growBox,
  padOutline,
  place,
  pointInPolygon,
  polyline,
  ring,
  segment,
  type BBox,
  type Tris,
} from './geometry.ts';

export const HOLES = 'Holes';

export interface Pickable {
  uid: string;
  layers: string[];
  /** Larger wins when several shapes are under the cursor. */
  priority: number;
  box: BBox;
  hit: (p: Vec2, tol: number) => boolean;
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

export interface Scene {
  layers: Map<string, Float32Array>;
  bbox: BBox;
  pick: Pickable[];
  texts: TextItem[];
}

type Sink = (layer: string) => Tris | null;

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

/** Expand "*" (all copper) in a layer list. */
function expand(layers: string[], copper: string[]): string[] {
  return layers.flatMap((l) => (l === '*' ? copper : [l]));
}

/**
 * Emit triangles for one node (not its children) into `sink`, and optionally register
 * pickables / texts. Shared by the full scene build and selection highlighting.
 */
export function emitNode(
  doc: Doc,
  e: StyleEngine,
  node: DocNode,
  copper: string[],
  sink: Sink,
  extra?: { pick: Pickable[]; texts: TextItem[]; box: BBox },
): void {
  const uid = node.uid;
  if (e.get(uid, 'visible')?.value === false && node.type !== 'text') return;
  if (e.get(uid, 'enabled')?.value === false) return;

  const reg = (layers: string[], priority: number, box: BBox, hit: Pickable['hit']) => {
    if (!extra) return;
    extra.pick.push({ uid, layers, priority, box, hit });
    extra.box.minX = Math.min(extra.box.minX, box.minX);
    extra.box.minY = Math.min(extra.box.minY, box.minY);
    extra.box.maxX = Math.max(extra.box.maxX, box.maxX);
    extra.box.maxY = Math.max(extra.box.maxY, box.maxY);
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
      const layers = expand(listOf(e, uid, 'layers'), copper);
      const span = layers.length >= 2 ? copperSpan(layers, copper) : copper;
      for (const l of span) {
        const out = sink(l);
        if (out) ring(out, c, d / 2, h / 2);
      }
      const hole = sink(HOLES);
      if (hole) circle(hole, c, h / 2);
      const box = emptyBox();
      growBox(box, c.x, c.y, d / 2);
      reg(span, 4, box, (p, tol) => Math.hypot(p.x - c.x, p.y - c.y) <= d / 2 + tol);
      return;
    }
    case 'pad': {
      const c = v2(e, uid, 'position');
      if (!c) return;
      const sizeV = e.get(uid, 'size')?.value;
      const size: Vec2 = typeof sizeV === 'number' ? { x: sizeV, y: sizeV } : ((sizeV as Vec2) ?? { x: 1, y: 1 });
      const rot = numOf(e, uid, 'rotation', 0);
      const shape = strOf(e, uid, 'padShape', 'rect');
      const ratio = numOf(e, uid, 'cornerRatio', 0.25);
      const custom = e.get(uid, 'points')?.value as Vec2[] | undefined;
      const outline = padOutline(shape === 'custom' ? 'rect' : shape, size, ratio).map((p) => place(p, c, rot));
      const layers = expand(listOf(e, uid, 'layers'), copper);
      for (const l of layers) {
        const out = sink(l);
        if (!out) continue;
        fillPolygon(out, outline);
        if (shape === 'custom' && Array.isArray(custom) && custom.length >= 3) fillPolygon(out, custom);
      }
      const holeV = e.get(uid, 'holeSize')?.value;
      if (holeV !== undefined) {
        const hs: Vec2 = typeof holeV === 'number' ? { x: holeV, y: holeV } : (holeV as Vec2);
        const hole = sink(HOLES);
        if (hole) fillPolygon(hole, padOutline(hs.x === hs.y ? 'circle' : 'oval', hs, 0.5).map((p) => place(p, c, rot)));
      }
      const box = emptyBox();
      for (const p of outline) growBox(box, p.x, p.y);
      reg(layers, 5, box, (p, tol) => pointInPolygon(p, outline) || (tol > 0 && outline.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol)));
      if (extra) {
        const label = String(node.props.number ?? node.name);
        const layer = layers.find((l) => l.endsWith('.Cu')) ?? layers[0] ?? 'F.Cu';
        if (label) extra.texts.push({ uid, layer, pos: c, rot: 0, text: label, size: Math.min(size.x, size.y) * 0.55, kind: 'padNumber' });
      }
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
      const layer = strOf(e, uid, 'layer', 'F.SilkS');
      const w = numOf(e, uid, 'strokeWidth', 0.15);
      const filled = e.get(uid, 'filled')?.value === true;
      let path: Vec2[] = [];
      let closed = false;
      if (node.type === 'line') {
        const s = v2(e, uid, 'start');
        const t = v2(e, uid, 'end');
        if (s && t) path = [s, t];
      } else if (node.type === 'arc') {
        const s = v2(e, uid, 'start');
        const m = v2(e, uid, 'mid');
        const t = v2(e, uid, 'end');
        if (s && m && t) path = arcPoints(s, m, t);
      } else if (node.type === 'circle') {
        const c = v2(e, uid, 'center');
        if (!c) return;
        const r = numOf(e, uid, 'radius', 0);
        const n = Math.max(24, Math.ceil(r * 16));
        path = Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos((i / n) * 2 * Math.PI) * r, y: c.y + Math.sin((i / n) * 2 * Math.PI) * r }));
        closed = true;
      } else {
        path = (e.get(uid, 'points')?.value as Vec2[]) ?? [];
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
      if (!extra) return;
      if (e.get(uid, 'visible')?.value === false) return;
      const pos = v2(e, uid, 'position');
      const text = strOf(e, uid, 'text', node.name);
      if (!pos || !text) return;
      extra.texts.push({
        uid,
        layer: strOf(e, uid, 'layer', 'F.SilkS'),
        pos,
        rot: numOf(e, uid, 'rotation', 0),
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

function copperSpan(layers: string[], copper: string[]): string[] {
  const idx = layers.map((l) => copper.indexOf(l)).filter((i) => i >= 0);
  if (idx.length < 2) return layers;
  const lo = Math.min(...idx);
  const hi = Math.max(...idx);
  return copper.slice(lo, hi + 1);
}

export function buildScene(doc: Doc, e: StyleEngine, copper: string[]): Scene {
  const acc = new Map<string, Tris>();
  const sink: Sink = (layer) => {
    let a = acc.get(layer);
    if (!a) acc.set(layer, (a = []));
    return a;
  };
  const extra = { pick: [] as Pickable[], texts: [] as TextItem[], box: emptyBox() };
  for (const node of doc.nodes.values()) emitNode(doc, e, node, copper, sink, extra);
  const layers = new Map<string, Float32Array>();
  for (const [k, v] of acc) layers.set(k, new Float32Array(v));
  // Frame everything: unfinished boards often have parts parked outside the outline.
  return { layers, bbox: extra.box, pick: extra.pick, texts: extra.texts };
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

export function boxUnion(boxes: BBox[]): BBox {
  const b = emptyBox();
  for (const x of boxes) {
    growBox(b, x.minX, x.minY);
    growBox(b, x.maxX, x.maxY);
  }
  return b;
}

export { circle, segment };
