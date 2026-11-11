/**
 * Design rule check. Reads only computed rule values, so every limit comes from the
 * same rules the user edits (keepOut, traceWidthMin, holeSizeMin, boardEdgeClearance).
 */
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { boxValid, dist, pointInPolygon, segSegDist, segSegMid, type BBox } from './geom.ts';
import { boardOutline, clearanceFor, collectCopper, inArea, type CopperShape } from './copper.ts';
import { computeRatsnest, type Ratsnest } from './connectivity.ts';
import { formatLength } from './units.ts';

export type Severity = 'error' | 'warning';

export type ViolationKind =
  | 'short'
  | 'clearance'
  | 'unrouted'
  | 'edgeClearance'
  | 'outsideBoard'
  | 'traceWidth'
  | 'holeSize'
  | 'noOutline';

export const VIOLATION_LABEL: Record<ViolationKind, string> = {
  short: 'Short circuit',
  clearance: 'Copper clearance',
  unrouted: 'Unrouted connection',
  edgeClearance: 'Board edge clearance',
  outsideBoard: 'Copper outside board',
  traceWidth: 'Trace too narrow',
  holeSize: 'Hole too small',
  noOutline: 'Board outline missing',
};

export interface Violation {
  id: string;
  kind: ViolationKind;
  severity: Severity;
  message: string;
  at: Vec2;
  layer?: string;
  uids: string[];
  /** For clearance: actual and required distance (mm). */
  actual?: number;
  required?: number;
}

export interface DrcResult {
  violations: Violation[];
  ms: number;
  checkedShapes: number;
}

const EPS = 1e-4;

/** Smallest gap between two copper shapes (negative / 0 when they overlap), and where. */
export function shapeGap(a: CopperShape, b: CopperShape): { gap: number; at: Vec2 } {
  // Overlap by containment (one shape inside the other's area).
  for (const area of a.areas) if (inArea(b.probe, area)) return { gap: -1, at: b.probe };
  for (const area of b.areas) if (inArea(a.probe, area)) return { gap: -1, at: a.probe };
  let best = Infinity;
  let at: Vec2 = a.probe;
  // Pre-filter edges by the other shape's box to keep pour-vs-item checks cheap.
  const near = (e: [Vec2, Vec2, number], box: BBox, pad: number) =>
    Math.max(e[0].x, e[1].x) + e[2] + pad >= box.minX &&
    Math.min(e[0].x, e[1].x) - e[2] - pad <= box.maxX &&
    Math.max(e[0].y, e[1].y) + e[2] + pad >= box.minY &&
    Math.min(e[0].y, e[1].y) - e[2] - pad <= box.maxY;
  const ea = a.edges.length > 64 ? a.edges.filter((e) => near(e, b.box, 2)) : a.edges;
  const eb = b.edges.length > 64 ? b.edges.filter((e) => near(e, a.box, 2)) : b.edges;
  for (const e of ea) {
    for (const f of eb) {
      const d = segSegDist(e[0], e[1], f[0], f[1]) - e[2] - f[2];
      if (d < best) {
        best = d;
        at = segSegMid(e[0], e[1], f[0], f[1]);
      }
    }
  }
  return { gap: best, at };
}

class Grid {
  private cells = new Map<string, number[]>();
  constructor(private size: number) {}
  private key(i: number, j: number) {
    return `${i},${j}`;
  }
  add(idx: number, b: BBox): void {
    const s = this.size;
    for (let i = Math.floor(b.minX / s); i <= Math.floor(b.maxX / s); i++)
      for (let j = Math.floor(b.minY / s); j <= Math.floor(b.maxY / s); j++) {
        const k = this.key(i, j);
        const c = this.cells.get(k);
        if (c) c.push(idx);
        else this.cells.set(k, [idx]);
      }
  }
  query(b: BBox, out: Set<number>): void {
    const s = this.size;
    for (let i = Math.floor(b.minX / s); i <= Math.floor(b.maxX / s); i++)
      for (let j = Math.floor(b.minY / s); j <= Math.floor(b.maxY / s); j++) for (const x of this.cells.get(this.key(i, j)) ?? []) out.add(x);
  }
}

export interface DrcOptions {
  ratsnest?: Ratsnest;
  /** Skip the (slow) pour-vs-everything pairs; handy while dragging. */
  skipFills?: boolean;
}

export function runDrc(doc: Doc, engine: StyleEngine, copper: string[], opts: DrcOptions = {}): DrcResult {
  const t0 = performance.now();
  const v: Violation[] = [];
  const seen = new Set<string>();
  const push = (x: Omit<Violation, 'id'>, explicitId?: string) => {
    const id = explicitId ?? `${x.kind}:${[...x.uids].sort().join('|')}:${x.layer ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    v.push({ id, ...x });
  };
  const L = (mm: number) => formatLength(mm);

  const shapes = collectCopper(doc, engine, copper).filter((s) => s.layer !== '__npth' && (!opts.skipFills || s.kind !== 'fill'));

  // ---- clearance & shorts ----
  const byLayer = new Map<string, number[]>();
  shapes.forEach((s, i) => {
    const list = byLayer.get(s.layer) ?? [];
    list.push(i);
    byLayer.set(s.layer, list);
  });
  for (const [layer, idxs] of byLayer) {
    const grid = new Grid(2);
    const big: number[] = [];
    for (const i of idxs) {
      const s = shapes[i]!;
      const w = s.box.maxX - s.box.minX;
      const h = s.box.maxY - s.box.minY;
      if (w * h > 400) big.push(i); // pours: checked against everything on the layer
      else grid.add(i, s.box);
    }
    const maxCl = 2;
    const check = (i: number, j: number) => {
      const a = shapes[i]!;
      const b = shapes[j]!;
      if (a.uid === b.uid) return;
      if (a.net !== null && a.net === b.net) return;
      const required = Math.max(clearanceFor(a.keepOut, b.kind), clearanceFor(b.keepOut, a.kind));
      const pad = required + EPS;
      if (a.box.maxX + pad < b.box.minX || b.box.maxX + pad < a.box.minX || a.box.maxY + pad < b.box.minY || b.box.maxY + pad < a.box.minY) return;
      const { gap, at } = shapeGap(a, b);
      if (gap <= EPS) {
        push({
          kind: 'short', severity: 'error', layer, at, uids: [a.uid, b.uid],
          message: `${a.net ?? 'unconnected'} touches ${b.net ?? 'unconnected'} on ${layer}`,
          actual: Math.max(0, gap), required,
        });
      } else if (gap + EPS < required) {
        push({
          kind: 'clearance', severity: 'error', layer, at, uids: [a.uid, b.uid],
          message: `${a.kind} (${a.net ?? 'no net'}) and ${b.kind} (${b.net ?? 'no net'}) are ${L(gap)} apart; need ${L(required)}`,
          actual: gap, required,
        });
      }
    };
    const cand = new Set<number>();
    for (const i of idxs) {
      if (big.includes(i)) continue;
      const s = shapes[i]!;
      cand.clear();
      grid.query({ minX: s.box.minX - maxCl, minY: s.box.minY - maxCl, maxX: s.box.maxX + maxCl, maxY: s.box.maxY + maxCl }, cand);
      for (const j of cand) if (j > i) check(i, j);
    }
    for (const i of big) for (const j of idxs) if (j !== i && (!big.includes(j) || j > i)) check(i, j);
  }

  // ---- board outline ----
  const outline = boardOutline(doc, engine);
  const board = outline.loops[0];
  if (!board) {
    push({ kind: 'noOutline', severity: 'warning', at: { x: 0, y: 0 }, uids: [], message: 'No closed board outline on Edge.Cuts; edge checks skipped.' });
  } else {
    for (const s of shapes) {
      if (!boxValid(s.box)) continue;
      const pts = s.areas.length ? s.areas.flatMap((a) => a[0] ?? []) : s.edges.flatMap((e) => [e[0], e[1]]);
      const outside = pts.find((p) => !pointInPolygon(p, board));
      if (outside) {
        push({ kind: 'outsideBoard', severity: 'error', layer: s.layer, at: outside, uids: [s.uid], message: `${s.kind} ${s.net ?? ''} extends outside the board outline` });
        continue;
      }
      if (s.kind === 'fill') continue; // pours follow their own edge rule when filled
      const need = s.edgeClearance;
      if (!(need > 0)) continue;
      let best = Infinity;
      let at = s.probe;
      for (const [p, q] of outline.segments) {
        for (const e of s.edges) {
          const d = segSegDist(p, q, e[0], e[1]) - e[2];
          if (d < best) {
            best = d;
            at = segSegMid(p, q, e[0], e[1]);
          }
        }
      }
      if (best + EPS < need) {
        push({ kind: 'edgeClearance', severity: 'error', layer: s.layer, at, uids: [s.uid], message: `${s.kind} ${s.net ?? ''} is ${L(Math.max(0, best))} from the board edge; need ${L(need)}`, actual: best, required: need });
      }
    }
  }

  // ---- widths and holes ----
  for (const n of doc.nodes.values()) {
    if (n.type === 'trace') {
      const w = Number(engine.get(n.uid, 'traceWidth')?.value ?? 0);
      const min = Number(engine.get(n.uid, 'traceWidthMin')?.value ?? 0);
      if (min > 0 && w + EPS < min) {
        const s = engine.get(n.uid, 'start')?.value as Vec2;
        push({ kind: 'traceWidth', severity: 'error', at: s, layer: String(engine.get(n.uid, 'layer')?.value ?? ''), uids: [n.uid], message: `Trace is ${L(w)} wide; minimum is ${L(min)}`, actual: w, required: min });
      }
    } else if (n.type === 'via' || n.type === 'pad') {
      const min = Number(engine.get(n.uid, 'holeSizeMin')?.value ?? 0);
      const hv = n.type === 'via' ? engine.get(n.uid, 'viaHole')?.value : engine.get(n.uid, 'holeSize')?.value;
      if (hv === undefined || !(min > 0)) continue;
      const d = typeof hv === 'number' ? hv : Math.min((hv as Vec2).x, (hv as Vec2).y);
      if (d + EPS < min) {
        const shape = shapes.find((s) => s.uid === n.uid);
        push({ kind: 'holeSize', severity: 'error', at: shape?.probe ?? { x: 0, y: 0 }, uids: [n.uid], message: `${n.type === 'via' ? 'Via' : 'Pad'} hole is ${L(d)}; minimum is ${L(min)}`, actual: d, required: min });
      }
    }
  }

  // ---- unrouted ----
  const rn = opts.ratsnest ?? computeRatsnest(doc, engine, copper);
  for (const l of rn.lines) {
    push(
      { kind: 'unrouted', severity: 'error', at: { x: (l.a.x + l.b.x) / 2, y: (l.a.y + l.b.y) / 2 }, uids: [], message: `${l.net}: ${L(dist(l.a, l.b))} still to route` },
      `unrouted:${l.net}:${l.a.x.toFixed(3)},${l.a.y.toFixed(3)}:${l.b.x.toFixed(3)},${l.b.y.toFixed(3)}`,
    );
  }

  return { violations: v, ms: performance.now() - t0, checkedShapes: shapes.length };
}
