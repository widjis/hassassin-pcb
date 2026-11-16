/**
 * Teardrops (docs/05-pcb-improvements.md, P14): a flared piece of copper where a trace enters a via or a pad,
 * so a drill that wanders a little does not break the joint. The idea and its usual parameters (length and
 * width as a share of the pad or via size, with a maximum; vias, plated pads, all pads) follow the KiCad 8
 * manual (Edit > Edit Teardrops); the shape and the method are our own.
 *
 * A teardrop is a filled copper polygon of the trace's net (`polygon` node under the net, props
 * `teardrop: true`, `of` = the pad or via, `trace` = the trace), so the editor, DRC, the pours and the Gerbers
 * see it as copper. They are made again from the rules on every pour refill: the net rule `teardrops`
 * (off, vias, through = vias and plated pads, all) says where, `teardropLength` caps the length.
 */
import type { Op } from './commands.ts';
import { clearanceFor, collectCopper, inArea, type CopperShape } from './copper.ts';
import { shapeGap } from './drc.ts';
import { distToSegment, emptyBox, growBox, pointInPolygon, type BBox } from './geom.ts';
import { keepoutAreas, polygonsOverlap } from './keepout.ts';
import { newUid, type Doc, type DocNode, type Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export const TEARDROP_MODES = ['off', 'vias', 'through', 'all'] as const;
export type TeardropMode = (typeof TEARDROP_MODES)[number];

/** Length of a teardrop past the pad edge: this share of the pad / via size, at most `teardropLength`. */
const LENGTH_RATIO = 0.5;
/** Width where the teardrop meets the pad: this share of the pad / via size, at most 2 mm. */
const WIDTH_RATIO = 0.9;
const WIDTH_MAX = 2;

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });

export const isTeardrop = (n: DocNode | undefined) => n?.type === 'polygon' && n.props.teardrop === true;

/** Distance from `p` along unit `d` to the boundary of the closed outline (p inside), or null. */
function exitDistance(p: Vec2, d: Vec2, outline: Vec2[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den;
    const u = ((a.x - p.x) * d.y - (a.y - p.y) * d.x) / den;
    if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Quadratic Bézier from a through control k to b, `n` steps (a excluded). */
function bezier(a: Vec2, k: Vec2, b: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * k.x + t * t * b.x, y: u * u * a.y + 2 * u * t * k.y + t * t * b.y });
  }
  return out;
}

/**
 * The outline of one teardrop: from the trace end `e` (inside the pad) along the trace towards `f`, the pad
 * being `inside` (a test) with its edge `exit` away along the trace; `size` is the pad / via size, `w` the
 * trace width. Null when there is no room (short trace, pad not wider than the trace).
 */
export function teardropOutline(e: Vec2, f: Vec2, w: number, size: number, exit: number, inside: (p: Vec2) => boolean, maxLength: number): Vec2[] | null {
  const len = Math.hypot(f.x - e.x, f.y - e.y);
  if (len < 1e-6) return null;
  const d = { x: (f.x - e.x) / len, y: (f.y - e.y) / len };
  const n = { x: -d.y, y: d.x };
  let W = Math.min(WIDTH_RATIO * size, WIDTH_MAX);
  // The base stays inside the pad: narrow it until both corners are in.
  while (W > w * 1.15 && !(inside(add(e, n, W / 2)) && inside(add(e, n, -W / 2)))) W *= 0.85;
  if (W <= w * 1.15) return null;
  let L = Math.min(LENGTH_RATIO * size, maxLength);
  // On the straight part of the trace only, and leave some of the trace bare.
  L = Math.min(L, len - exit - w / 2);
  if (L < w) return null;
  const tip = add(e, d, exit + L);
  const edge = add(e, d, exit);
  const side = (s: 1 | -1) => {
    const base = add(e, n, (s * W) / 2);
    const end = add(tip, n, (s * w) / 2);
    // Control near the pad edge, a little outside the trace: a concave flare.
    const ctrl = add(edge, n, s * (w / 2 + (W - w) * 0.18));
    return [base, ...bezier(base, ctrl, end, 8)];
  };
  const plus = side(1);
  const minus = side(-1).reverse();
  return [...plus, ...minus];
}

interface Anchor {
  uid: string;
  kind: 'via' | 'pad';
  layers: string[];
  center: Vec2;
  size: number;
  /** Whether a point is on the pad / via copper. */
  inside: (p: Vec2) => boolean;
  outline?: Vec2[];
  r?: number;
}

/** Ops that remove the board's teardrops and make them again from the `teardrops` rule of each net. */
export function teardropOps(doc: Doc, engine: StyleEngine, copper: string[]): { ops: Op[]; added: number; removed: number; skipped: number } {
  const ops: Op[] = [];
  let removed = 0;
  for (const n of doc.nodes.values()) if (isTeardrop(n)) (ops.push({ op: 'remove', uid: n.uid }), removed++);
  const modeOf = (net: DocNode) => {
    const v = String(engine.get(net.uid, 'teardrops')?.value ?? 'off');
    return ((TEARDROP_MODES as readonly string[]).includes(v) ? v : 'off') as TeardropMode;
  };
  const nets = [...doc.nodes.values()].filter((n) => n.type === 'net' && modeOf(n) !== 'off');
  if (!nets.length) return { ops, added: 0, removed, skipped: 0 };

  // Copper without the old teardrops and without the pours (they are filled again around the new ones).
  const shapes = collectCopper(doc, engine, copper).filter((s) => s.kind !== 'fill' && !isTeardrop(doc.nodes.get(s.uid)));
  const keepouts = keepoutAreas(doc, engine, copper).filter((k) => k.forbid.has('traces'));
  const byLayer = new Map<string, CopperShape[]>();
  for (const s of shapes) (byLayer.get(s.layer) ?? byLayer.set(s.layer, []).get(s.layer)!).push(s);

  let added = 0;
  let skipped = 0;
  for (const net of nets) {
    const mode = modeOf(net);
    const maxLength = Number(engine.get(net.uid, 'teardropLength')?.value ?? 1) || 1;
    // Where traces of the net may get a teardrop: its vias, and (by the mode) its pads.
    const anchors: Anchor[] = [];
    for (const s of shapes) {
      if (s.net !== net.name) continue;
      if (s.kind === 'via') {
        const [c, , r] = s.edges[0]!;
        if (!anchors.some((a) => a.uid === s.uid)) anchors.push({ uid: s.uid, kind: 'via', layers: shapes.filter((x) => x.uid === s.uid).map((x) => x.layer), center: c, size: r * 2, r, inside: (p) => Math.hypot(p.x - c.x, p.y - c.y) <= r + 1e-6 });
      } else if (s.kind === 'pad' && mode !== 'vias') {
        const plated = !!s.hole?.plated;
        if (mode === 'through' && !plated) continue;
        if (anchors.some((a) => a.uid === s.uid)) continue;
        const outline = s.areas[0]![0]!;
        const box = s.box;
        anchors.push({ uid: s.uid, kind: 'pad', layers: shapes.filter((x) => x.uid === s.uid).map((x) => x.layer), center: s.probe, size: Math.min(box.maxX - box.minX, box.maxY - box.minY), outline, inside: (p) => pointInPolygon(p, outline) || outline.some((q, i) => distToSegment(p, q, outline[(i + 1) % outline.length]!) < 1e-6) });
      }
    }
    if (!anchors.length) continue;
    for (const c of net.children) {
      const t = doc.nodes.get(c);
      if (t?.type !== 'trace' || engine.get(t.uid, 'enabled')?.value === false || engine.get(t.uid, 'mid')?.value) continue;
      const layer = String(engine.get(t.uid, 'layer')?.value ?? '');
      const s = vec(engine.get(t.uid, 'start')?.value);
      const e = vec(engine.get(t.uid, 'end')?.value);
      const w = Number(engine.get(t.uid, 'traceWidth')?.value ?? 0.25);
      if (!s || !e) continue;
      for (const [p, q] of [[s, e], [e, s]] as const) {
        const a = anchors.find((x) => x.layers.includes(layer) && x.inside(p));
        // The trace must leave the pad: its other end outside.
        if (!a || a.inside(q)) continue;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        const d = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
        let exit: number | null;
        if (a.kind === 'via') {
          // Ray from p (inside the circle) to its edge.
          const ox = p.x - a.center.x;
          const oy = p.y - a.center.y;
          const b = ox * d.x + oy * d.y;
          exit = -b + Math.sqrt(Math.max(0, b * b - (ox * ox + oy * oy - a.r! * a.r!)));
        } else exit = exitDistance(p, d, a.outline!);
        if (exit === null) continue;
        let poly: Vec2[] | null = null;
        // Full size first; when it would come too close to other copper, a shorter one; else none.
        for (const k of [1, 0.6]) {
          const cand = teardropOutline(p, q, w, a.size, exit, a.inside, maxLength * k);
          if (cand && fits(cand, net.name, layer, engine, t.uid, byLayer.get(layer) ?? [], keepouts)) {
            poly = cand;
            break;
          }
        }
        if (!poly) {
          skipped++;
          continue;
        }
        added++;
        ops.push({
          op: 'add', parent: net.uid, index: net.children.length,
          tree: { nodes: [{ uid: newUid('td'), type: 'polygon', name: 'teardrop', parent: net.uid, children: [], props: { teardrop: true, of: a.uid, trace: t.uid }, rules: [{ name: 'layer', value: layer }, { name: 'points', value: poly.map((v) => ({ x: +v.x.toFixed(6), y: +v.y.toFixed(6) })) }, { name: 'filled', value: true }, { name: 'strokeWidth', value: 0 }] }] },
        });
      }
    }
  }
  return { ops, added, removed, skipped };
}

/** Whether a teardrop outline keeps the clearance from other nets' copper and stays out of keep-outs. */
function fits(poly: Vec2[], net: string, layer: string, engine: StyleEngine, trace: string, others: CopperShape[], keepouts: ReturnType<typeof keepoutAreas>): boolean {
  const box: BBox = emptyBox();
  for (const p of poly) growBox(box, p.x, p.y);
  const keepOut = (engine.get(trace, 'keepOut')?.value as CopperShape['keepOut'] | undefined) ?? { byType: {} };
  const me: CopperShape = { uid: '__td', kind: 'trace', net, layer, edges: poly.map((p, i) => [p, poly[(i + 1) % poly.length]!, 0]), areas: [[poly]], box, keepOut, edgeClearance: 0, probe: centroid(poly) };
  for (const o of others) {
    if (o.net === net && o.net !== null) continue;
    const need = Math.max(clearanceFor(keepOut, o.kind), clearanceFor(o.keepOut, 'trace'));
    if (o.box.maxX + need < box.minX || box.maxX + need < o.box.minX || o.box.maxY + need < box.minY || box.maxY + need < o.box.minY) continue;
    if (shapeGap(me, o).gap + 1e-4 < need) return false;
  }
  return !keepouts.some((k) => k.layers.includes(layer) && polygonsOverlap(poly, k.poly));
}

export function centroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) (x += p.x), (y += p.y);
  const c = { x: x / poly.length, y: y / poly.length };
  return inArea(c, [poly]) ? c : poly[0]!;
}
