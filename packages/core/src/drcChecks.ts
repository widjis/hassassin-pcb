/**
 * More DRC checks (docs/05-pcb-improvements.md, P12): courtyard overlap, silkscreen over pads, annular ring,
 * hole-to-hole distance, traces with an unconnected end and vias connected on fewer than two layers. Each
 * limit is a layout rule (annularRingMin, holeToHoleMin, silkClearance), as for the other checks. The checks
 * follow the descriptions of KiCad 8's design rule checks in its manual (Board Setup > Violation Severity);
 * the method is our own.
 */
import { collectCopper, inArea, type CopperShape } from './copper.ts';
import { frameOf, toWorld } from './frames.ts';
import { arcPoints, distToSegment, emptyBox, growBox, pointInPolygon, segSegDist, segSegMid, type BBox } from './geom.ts';
import { fromIPath, hasClipper, intersect, toIAreas } from './clip.ts';
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { formatLength } from './units.ts';
import { boardTextStrokes } from './strokeFont.ts';

/** A violation found here, in the shape `runDrc` reports (it adds the id when none is given). */
export interface FoundViolation {
  id?: string;
  kind: 'courtyardOverlap' | 'silkOverPad' | 'annularRing' | 'holeToHole' | 'danglingTrace' | 'unusedVia';
  severity: 'error' | 'warning';
  message: string;
  at: Vec2;
  layer?: string;
  uids: string[];
  actual?: number;
  required?: number;
}

const EPS = 1e-4;
const L = (mm: number) => formatLength(mm);
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const num = (engine: StyleEngine, uid: string, name: string, fallback: number) => {
  const v = Number(engine.get(uid, name)?.value);
  return Number.isFinite(v) ? v : fallback;
};
const boxOf = (pts: Vec2[], pad = 0): BBox => {
  const b = emptyBox();
  for (const p of pts) growBox(b, p.x, p.y, pad);
  return b;
};
const boxesMeet = (a: BBox, b: BBox, pad = 0) => !(a.maxX + pad < b.minX || b.maxX + pad < a.minX || a.maxY + pad < b.minY || b.maxY + pad < a.minY);

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!;
    const r = p[(i + 1) % p.length]!;
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

/** Area (mm²) of the overlap of two sets of closed outlines; null without the geometry engine. */
function overlapArea(a: Vec2[][], b: Vec2[][]): number | null {
  if (!hasClipper()) return null;
  return Math.abs(intersect(toIAreas(a), toIAreas(b)).reduce((s, r) => s + signedArea(fromIPath(r)), 0));
}

function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ---------------------------------------------------------------- courtyards

export interface Courtyard {
  el: string;
  layer: string;
  /** Closed outlines, in board coordinates. */
  loops: Vec2[][];
  box: BBox;
}

/** Join open pieces whose ends meet into closed loops; pieces left over are returned apart. */
function chainLoops(pieces: Vec2[][]): { loops: Vec2[][]; open: Vec2[][] } {
  const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
  const left = pieces.map((p) => [...p]);
  const loops: Vec2[][] = [];
  const open: Vec2[][] = [];
  while (left.length) {
    let path = left.pop()!;
    let grew = true;
    while (grew && !(path.length > 2 && near(path[0]!, path[path.length - 1]!))) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const q = left[i]!;
        const end = path[path.length - 1]!;
        if (near(end, q[0]!)) path = [...path, ...q.slice(1)];
        else if (near(end, q[q.length - 1]!)) path = [...path, ...[...q].reverse().slice(1)];
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (path.length > 3 && near(path[0]!, path[path.length - 1]!)) loops.push(path.slice(0, -1));
    else open.push(path);
  }
  return { loops, open };
}

/** The courtyard outlines of every part, per courtyard layer (graphics on *.CrtYd). */
export function courtyards(doc: Doc, engine: StyleEngine): Courtyard[] {
  const out: Courtyard[] = [];
  for (const el of doc.nodes.values()) {
    if (el.type !== 'element' || engine.get(el.uid, 'enabled')?.value === false) continue;
    const byLayer = new Map<string, { loops: Vec2[][]; pieces: Vec2[][] }>();
    for (const c of el.children) {
      const g = doc.nodes.get(c);
      if (!g) continue;
      const layer = String(engine.get(g.uid, 'layer')?.value ?? '');
      if (!layer.endsWith('CrtYd')) continue;
      const f = frameOf(doc, engine, g);
      const W = (p: Vec2) => toWorld(f, p);
      const slot = byLayer.get(layer) ?? { loops: [], pieces: [] };
      byLayer.set(layer, slot);
      const s = vec(engine.get(g.uid, 'start')?.value);
      const e = vec(engine.get(g.uid, 'end')?.value);
      if (g.type === 'line' && s && e) slot.pieces.push([W(s), W(e)]);
      else if (g.type === 'arc') {
        const m = vec(engine.get(g.uid, 'mid')?.value);
        if (s && m && e) slot.pieces.push(arcPoints(W(s), W(m), W(e)));
      } else if (g.type === 'rectangle' && !Array.isArray(engine.get(g.uid, 'points')?.value) && s && e) {
        slot.loops.push([W(s), W({ x: e.x, y: s.y }), W(e), W({ x: s.x, y: e.y })]);
      } else if (g.type === 'circle') {
        const ctr = vec(engine.get(g.uid, 'center')?.value);
        const r = num(engine, g.uid, 'radius', 0);
        if (ctr && r > 0) slot.loops.push(Array.from({ length: 32 }, (_, k) => W({ x: ctr.x + Math.cos((k / 32) * 2 * Math.PI) * r, y: ctr.y + Math.sin((k / 32) * 2 * Math.PI) * r })));
      } else if (g.type === 'polygon' || g.type === 'rectangle') {
        // Rectangles are stored by their corners (`points`), or by two corners (`start`, `end`) above.
        const pts = engine.get(g.uid, 'points')?.value;
        if (Array.isArray(pts) && pts.length >= 3) slot.loops.push((pts as Vec2[]).map(W));
      }
    }
    for (const [layer, slot] of byLayer) {
      const chained = chainLoops(slot.pieces);
      const loops = [...slot.loops, ...chained.loops];
      // Pieces that do not close a loop: their convex hull stands for the courtyard.
      if (chained.open.length) {
        const hull = convexHull(chained.open.flat());
        if (hull.length >= 3) loops.push(hull);
      }
      if (loops.length) out.push({ el: el.uid, layer, loops, box: boxOf(loops.flat()) });
    }
  }
  return out;
}

function courtyardChecks(doc: Doc, engine: StyleEngine): FoundViolation[] {
  const v: FoundViolation[] = [];
  const list = courtyards(doc, engine);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.layer !== b.layer || a.el === b.el || !boxesMeet(a.box, b.box)) continue;
      const area = overlapArea(a.loops, b.loops);
      // Courtyards that only touch are fine; without the geometry engine, a corner inside the other counts.
      const hit = area !== null ? area > 1e-3 : a.loops.some((p) => p.some((q) => b.loops.some((r) => pointInPolygon(q, r)))) || b.loops.some((p) => p.some((q) => a.loops.some((r) => pointInPolygon(q, r))));
      if (!hit) continue;
      const ea = doc.nodes.get(a.el)!;
      const eb = doc.nodes.get(b.el)!;
      const at = { x: (Math.max(a.box.minX, b.box.minX) + Math.min(a.box.maxX, b.box.maxX)) / 2, y: (Math.max(a.box.minY, b.box.minY) + Math.min(a.box.maxY, b.box.maxY)) / 2 };
      v.push({
        kind: 'courtyardOverlap', severity: 'error', layer: a.layer, at, uids: [a.el, b.el],
        message: `The courtyards of ${ea.name} and ${eb.name} overlap on ${a.layer}${area !== null ? ` (${area.toFixed(2)} mm²)` : ''}`,
      });
    }
  }
  return v;
}

// ---------------------------------------------------------------- silkscreen

interface SilkItem {
  uid: string;
  layer: string;
  /** Stroked pieces: [a, b, half width]. */
  edges: [Vec2, Vec2, number][];
  /** Filled areas (filled shapes, text boxes). */
  areas: Vec2[][];
  box: BBox;
  what: string;
}

/** Silkscreen items as strokes and areas; texts as the strokes of the vector font. */
export function silkItems(doc: Doc, engine: StyleEngine): SilkItem[] {
  const out: SilkItem[] = [];
  for (const n of doc.nodes.values()) {
    if (engine.get(n.uid, 'enabled')?.value === false) continue;
    const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
    if (!layer.endsWith('SilkS')) continue;
    const f = frameOf(doc, engine, n);
    const W = (p: Vec2) => toWorld(f, p);
    const hw = num(engine, n.uid, 'strokeWidth', 0.15) / 2;
    let path: Vec2[] = [];
    let closed = false;
    if (n.type === 'text') {
      // The strokes of the vector font, as in the legend Gerbers (P13).
      const t = boardTextStrokes(doc, engine, n);
      if (!t) continue;
      const edges: [Vec2, Vec2, number][] = [];
      for (const st of t.strokes) for (let k = 1; k < st.length; k++) edges.push([st[k - 1]!, st[k]!, t.width / 2]);
      if (!edges.length) continue;
      out.push({ uid: n.uid, layer, edges, areas: [], box: boxOf(t.strokes.flat(), t.width / 2), what: `text "${String(engine.get(n.uid, 'text')?.value ?? n.name)}"` });
      continue;
    }
    const s = vec(engine.get(n.uid, 'start')?.value);
    const e = vec(engine.get(n.uid, 'end')?.value);
    if (n.type === 'line' && s && e) path = [W(s), W(e)];
    else if (n.type === 'arc') {
      const m = vec(engine.get(n.uid, 'mid')?.value);
      if (s && m && e) path = arcPoints(W(s), W(m), W(e));
    } else if (n.type === 'rectangle' && !Array.isArray(engine.get(n.uid, 'points')?.value) && s && e) {
      path = [W(s), W({ x: e.x, y: s.y }), W(e), W({ x: s.x, y: e.y })];
      closed = true;
    } else if (n.type === 'circle') {
      const c = vec(engine.get(n.uid, 'center')?.value);
      const r = num(engine, n.uid, 'radius', 0);
      if (c && r > 0) path = Array.from({ length: 32 }, (_, k) => W({ x: c.x + Math.cos((k / 32) * 2 * Math.PI) * r, y: c.y + Math.sin((k / 32) * 2 * Math.PI) * r }));
      closed = true;
    } else if (n.type === 'polygon' || n.type === 'rectangle') {
      const pts = engine.get(n.uid, 'points')?.value;
      if (Array.isArray(pts)) path = (pts as Vec2[]).map(W);
      closed = true;
    }
    if (path.length < 2) continue;
    const edges: [Vec2, Vec2, number][] = [];
    for (let i = 0; i + 1 < path.length; i++) edges.push([path[i]!, path[i + 1]!, hw]);
    if (closed) edges.push([path[path.length - 1]!, path[0]!, hw]);
    const filled = closed && engine.get(n.uid, 'filled')?.value === true;
    out.push({ uid: n.uid, layer, edges, areas: filled ? [path] : [], box: boxOf(path, hw), what: n.type });
  }
  return out;
}

function silkChecks(doc: Doc, engine: StyleEngine, shapes: CopperShape[], copper: string[]): FoundViolation[] {
  const v: FoundViolation[] = [];
  const pads = shapes.filter((s) => s.kind === 'pad' && s.layer !== '__npth');
  const outer = { top: copper[0] ?? 'F.Cu', bottom: copper[copper.length - 1] ?? 'B.Cu' };
  for (const s of silkItems(doc, engine)) {
    const cu = s.layer.startsWith('B.') ? outer.bottom : outer.top;
    const need = num(engine, s.uid, 'silkClearance', 0);
    for (const p of pads) {
      if (p.layer !== cu || !boxesMeet(s.box, p.box, need + EPS)) continue;
      let gap = Infinity;
      let at = p.probe;
      if (s.areas.some((a) => pointInPolygon(p.probe, a)) || s.edges.some(([a]) => p.areas.some((x) => inArea(a, x)))) gap = -1;
      else
        for (const [a, b, r] of s.edges)
          for (const [c, d] of p.edges) {
            const g = segSegDist(a, b, c, d) - r;
            if (g < gap) (gap = g), (at = segSegMid(a, b, c, d));
          }
      if (gap + EPS >= need && !(need === 0 && gap <= EPS)) continue;
      const pad = doc.nodes.get(p.uid);
      const el = pad?.parent ? doc.nodes.get(pad.parent) : undefined;
      v.push({
        id: `silkOverPad:${s.uid}|${p.uid}`,
        kind: 'silkOverPad', severity: 'warning', layer: s.layer, at, uids: [s.uid, p.uid],
        message: `Silkscreen ${s.what} on ${s.layer} ${gap <= EPS ? 'covers' : `is ${L(Math.max(0, gap))} from`} pad ${el?.name ?? ''}${pad ? `.${pad.name}` : ''}${need > 0 ? `; need ${L(need)}` : ''}`,
        ...(need > 0 ? { actual: Math.max(0, gap), required: need } : {}),
      });
    }
  }
  return v;
}

// ---------------------------------------------------------------- holes

interface Hole {
  uid: string;
  /** The drill as a segment with a radius (a round hole has a = b). */
  a: Vec2;
  b: Vec2;
  r: number;
  plated: boolean;
}

function holesOf(shapes: CopperShape[]): Hole[] {
  const seen = new Set<string>();
  const out: Hole[] = [];
  for (const s of shapes) {
    if (!s.hole || seen.has(s.uid)) continue;
    seen.add(s.uid);
    const { center, size, rot, plated } = s.hole;
    const long = Math.max(size.x, size.y);
    const r = Math.min(size.x, size.y) / 2;
    const half = long / 2 - r;
    const t = ((rot + (size.y > size.x ? 90 : 0)) * Math.PI) / 180;
    const d = { x: Math.cos(t) * half, y: -Math.sin(t) * half };
    out.push({ uid: s.uid, a: { x: center.x - d.x, y: center.y - d.y }, b: { x: center.x + d.x, y: center.y + d.y }, r, plated });
  }
  return out;
}

function holeChecks(doc: Doc, engine: StyleEngine, shapes: CopperShape[]): FoundViolation[] {
  const v: FoundViolation[] = [];
  const holes = holesOf(shapes);
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i]!;
    const need = num(engine, h.uid, 'holeToHoleMin', 0);
    for (let j = i + 1; j < holes.length; j++) {
      const k = holes[j]!;
      const required = Math.max(need, num(engine, k.uid, 'holeToHoleMin', 0));
      if (!(required > 0)) continue;
      const gap = segSegDist(h.a, h.b, k.a, k.b) - h.r - k.r;
      if (gap + EPS >= required) continue;
      const name = (u: string) => {
        const n = doc.nodes.get(u);
        const el = n?.parent ? doc.nodes.get(n.parent) : undefined;
        return n?.type === 'via' ? 'via' : `pad ${el?.type === 'element' ? `${el.name}.` : ''}${n?.name ?? ''}`;
      };
      v.push({
        kind: 'holeToHole', severity: 'error', at: segSegMid(h.a, h.b, k.a, k.b), uids: [h.uid, k.uid], actual: Math.max(0, gap), required,
        message: `Holes of ${name(h.uid)} and ${name(k.uid)} are ${gap <= 0 ? 'touching' : `${L(gap)} apart`}; need ${L(required)}`,
      });
    }
  }
  return v;
}

function annularChecks(doc: Doc, engine: StyleEngine, shapes: CopperShape[]): FoundViolation[] {
  const v: FoundViolation[] = [];
  const seen = new Set<string>();
  for (const s of shapes) {
    if (!s.hole?.plated || seen.has(s.uid)) continue;
    seen.add(s.uid);
    const n = doc.nodes.get(s.uid);
    if (!n) continue;
    const min = num(engine, s.uid, 'annularRingMin', 0);
    if (!(min > 0)) continue;
    let ring: number;
    if (n.type === 'via') ring = (num(engine, n.uid, 'viaDiameter', 0.6) - num(engine, n.uid, 'viaHole', 0.3)) / 2;
    else {
      if (String(engine.get(n.uid, 'padShape')?.value ?? '') === 'custom') continue;
      const sv = engine.get(n.uid, 'size')?.value;
      const size: Vec2 = typeof sv === 'number' ? { x: sv, y: sv } : (vec(sv) ?? { x: 0, y: 0 });
      ring = Math.min((size.x - s.hole.size.x) / 2, (size.y - s.hole.size.y) / 2);
    }
    if (ring + EPS >= min) continue;
    const el = n.parent ? doc.nodes.get(n.parent) : undefined;
    v.push({
      kind: 'annularRing', severity: 'error', at: s.hole.center, uids: [n.uid], actual: ring, required: min,
      message: `${n.type === 'via' ? 'Via' : `Pad ${el?.type === 'element' ? `${el.name}.` : ''}${n.name}`} has an annular ring of ${L(Math.max(0, ring))}; minimum is ${L(min)}`,
    });
  }
  return v;
}

// ---------------------------------------------------------------- dangling copper

/** Whether point p (on `layer`) lies on copper of `net` other than the item `uid`. */
function onNetCopper(p: Vec2, r: number, layer: string, net: string, uid: string, byNetLayer: Map<string, CopperShape[]>): boolean {
  for (const s of byNetLayer.get(`${net}|${layer}`) ?? []) {
    if (s.uid === uid) continue;
    if (p.x < s.box.minX - r - EPS || p.x > s.box.maxX + r + EPS || p.y < s.box.minY - r - EPS || p.y > s.box.maxY + r + EPS) continue;
    if (s.kind === 'pad' || s.kind === 'fill') {
      if (s.areas.some((a) => inArea(p, a))) return true;
      if (s.kind === 'pad' && s.edges.some(([a, b]) => distToSegment(p, a, b) <= r + EPS)) return true;
    } else if (s.edges.some(([a, b, w]) => distToSegment(p, a, b) <= w + r + EPS)) return true;
  }
  return false;
}

function danglingChecks(doc: Doc, engine: StyleEngine, shapes: CopperShape[]): FoundViolation[] {
  const v: FoundViolation[] = [];
  const byNetLayer = new Map<string, CopperShape[]>();
  for (const s of shapes) {
    if (s.net === null) continue;
    const k = `${s.net}|${s.layer}`;
    const list = byNetLayer.get(k) ?? [];
    list.push(s);
    byNetLayer.set(k, list);
  }
  const vias = new Map<string, CopperShape[]>();
  for (const s of shapes) {
    if (s.kind === 'trace') {
      // Trace ends: on the net's other copper, or the end of another piece of the same trace (an arc).
      const path = s.edges.map((e) => e[0]).concat([s.edges[s.edges.length - 1]![1]]);
      for (const end of [path[0]!, path[path.length - 1]!]) {
        // Its round end touching the net's copper counts, as for the connectivity (copper that overlaps).
        if (s.net !== null && onNetCopper(end, s.edges[0]![2], s.layer, s.net, s.uid, byNetLayer)) continue;
        v.push({
          id: `danglingTrace:${s.uid}:${end.x.toFixed(3)},${end.y.toFixed(3)}`,
          kind: 'danglingTrace', severity: 'warning', layer: s.layer, at: end, uids: [s.uid],
          message: `Trace${s.net ? ` of ${s.net}` : ''} on ${s.layer} has an unconnected end`,
        });
      }
    } else if (s.kind === 'via') {
      const list = vias.get(s.uid) ?? [];
      list.push(s);
      vias.set(s.uid, list);
    }
  }
  for (const [uid, list] of vias) {
    const s = list[0]!;
    const c = s.edges[0]![0];
    const r = s.edges[0]![2];
    const connected = s.net === null ? [] : list.filter((x) => onNetCopper(c, r, x.layer, s.net!, uid, byNetLayer)).map((x) => x.layer);
    if (connected.length >= 2) continue;
    v.push({
      kind: 'unusedVia', severity: 'warning', at: c, uids: [uid],
      message: `Via${s.net ? ` of ${s.net}` : ''} ${connected.length ? `is connected on ${connected[0]} only` : 'is not connected'}`,
    });
  }
  return v;
}

// ---------------------------------------------------------------- all

/** The P12 checks. `shapes` are the board's copper as `runDrc` collected it (pours included). */
export function moreDrcChecks(doc: Doc, engine: StyleEngine, copper: string[], shapes = collectCopper(doc, engine, copper)): FoundViolation[] {
  return [...courtyardChecks(doc, engine), ...silkChecks(doc, engine, shapes, copper), ...annularChecks(doc, engine, shapes), ...holeChecks(doc, engine, shapes), ...danglingChecks(doc, engine, shapes)];
}
