/**
 * Interactive routing that respects clearance (docs/05-pcb-improvements.md, P4): the geometry behind the
 * editor's route tool, the segment drag and the agents' `route` tool.
 *
 * A `RouteWorld` holds, for one net, the copper of every other net (pads, traces, vias; pours are left out,
 * they are filled again around new copper) grown by the clearance the two sides demand and half the new
 * trace's width, plus the board edge with its clearance. A trace is legal when its centre line keeps out of
 * every grown shape.
 *
 * `walkaround` finds a 45° path from the last point to the cursor: the plain two-segment path when it is
 * legal, else a search over a grid (8 directions, cells kept a half-diagonal further from obstacles than the
 * trace needs, so each step between free cells is legal) that is then pulled tight into as few 45° segments
 * as stay legal. When the cursor cannot be reached the path stops at the free point nearest to it (the
 * search also stops after `budgetMs`, so a preview under the mouse stays quick).
 * Written from the textbook idea of grid search plus path smoothing, not from another tool's source.
 */
import type { Op } from './commands.ts';
import { boardOutline, clearanceFor, collectCopper, inArea, type CopperShape } from './copper.ts';
import { padGeom } from './frames.ts';
import { diffPairs, netLengths } from './lengths.ts';
import { distToSegment, pointInPolygon, route45, segSegDist } from './geom.ts';
import { newUid, type Doc, type DocNode, type KeepOut, type Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

interface Obstacle {
  uid: string;
  net: string | null;
  kind: CopperShape['kind'];
  a: Vec2;
  b: Vec2;
  /** Distance the new trace's centre line must keep from the segment a–b. */
  r: number;
  /** A closed area (pad outline) the centre line may not enter. */
  area?: Vec2[][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RouteWorld {
  net: string;
  width: number;
  /** Clearance of the net's own copper (the `keepOut` of its net) to traces. */
  clearance: number;
  layers: string[];
  /** Obstacles per layer, in a bucket grid for fast lookup. */
  grid: Map<string, Map<string, Obstacle[]>>;
  cell: number;
  /** The board outline (first loop) and edge segments with the distance to keep from them. */
  outline?: Vec2[];
  edges: Obstacle[];
}

export interface WorldOptions {
  /** Trace width (default: the net's `traceWidth` rule, else 0.25). */
  width?: number;
  /** Copper uids to leave out (e.g. traces being dragged, or other nets' traces when they will be shoved). */
  ignore?: Set<string>;
  /** Leave out every trace of other nets: they are shoved, not walked around. */
  shove?: boolean;
  /** Other nets whose copper is not in the way (the partner of a pair routed together). */
  own?: string[];
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

function netNodeOf(doc: Doc, net: string): DocNode | undefined {
  for (const n of doc.nodes.values()) if (n.type === 'net' && n.name === net) return n;
  return undefined;
}

/** The net's rules the router needs: width, via size and keep-out. */
export function netRouteRules(doc: Doc, engine: StyleEngine, net: string): { width: number; viaDiameter: number; viaHole: number; keepOut: KeepOut } {
  const n = netNodeOf(doc, net);
  const get = (k: string) => (n ? engine.get(n.uid, k)?.value : undefined);
  const num = (k: string, d: number) => (typeof get(k) === 'number' ? (get(k) as number) : d);
  const k = get('keepOut') as KeepOut | undefined;
  return { width: num('traceWidth', 0.25), viaDiameter: num('viaDiameter', 0.6), viaHole: num('viaHole', 0.3), keepOut: k && typeof k === 'object' && 'byType' in k ? k : { byType: {} } };
}

export function routeWorld(doc: Doc, engine: StyleEngine, copper: string[], net: string, opts: WorldOptions = {}): RouteWorld {
  const rules = netRouteRules(doc, engine, net);
  const width = opts.width ?? rules.width;
  const half = width / 2;
  const cell = 1;
  const grid = new Map<string, Map<string, Obstacle[]>>();
  for (const l of copper) grid.set(l, new Map());
  const file = (layer: string, o: Obstacle) => {
    const g = grid.get(layer);
    if (!g) return;
    for (let i = Math.floor(o.minX / cell); i <= Math.floor(o.maxX / cell); i++)
      for (let j = Math.floor(o.minY / cell); j <= Math.floor(o.maxY / cell); j++) {
        const k = `${i},${j}`;
        const c = g.get(k);
        if (c) c.push(o);
        else g.set(k, [o]);
      }
  };
  for (const s of collectCopper(doc, engine, copper)) {
    if (s.kind === 'fill' || s.net === net || opts.ignore?.has(s.uid) || (s.net && opts.own?.includes(s.net))) continue;
    if (opts.shove && s.kind === 'trace') continue;
    // The larger of what the new trace demands of this copper and what this copper demands of a trace.
    const cl = Math.max(clearanceFor(rules.keepOut, s.kind), clearanceFor(s.keepOut, 'trace'));
    for (const [a, b, r] of s.edges) {
      const rr = r + cl + half;
      file(s.layer, { uid: s.uid, net: s.net, kind: s.kind, a, b, r: rr, ...(s.kind === 'pad' ? { area: s.areas[0] } : {}), minX: Math.min(a.x, b.x) - rr, minY: Math.min(a.y, b.y) - rr, maxX: Math.max(a.x, b.x) + rr, maxY: Math.max(a.y, b.y) + rr });
    }
  }
  const board = boardOutline(doc, engine);
  const edgeCl = Number(engine.get(netNodeOf(doc, net)?.uid ?? doc.rootId, 'boardEdgeClearance')?.value ?? 0) || 0;
  const edges: Obstacle[] = board.segments.map(([a, b]) => ({ uid: 'edge', net: null, kind: 'trace', a, b, r: edgeCl + half, minX: 0, minY: 0, maxX: 0, maxY: 0 }));
  return { net, width, clearance: clearanceFor(rules.keepOut, 'trace'), layers: copper, grid, cell, ...(board.loops[0] ? { outline: board.loops[0] } : {}), edges };
}

function near(w: RouteWorld, layer: string, minX: number, minY: number, maxX: number, maxY: number): Set<Obstacle> {
  const out = new Set<Obstacle>();
  const g = w.grid.get(layer);
  if (!g) return out;
  for (let i = Math.floor(minX / w.cell); i <= Math.floor(maxX / w.cell); i++)
    for (let j = Math.floor(minY / w.cell); j <= Math.floor(maxY / w.cell); j++) for (const o of g.get(`${i},${j}`) ?? []) out.add(o);
  return out;
}

/** How far the point is inside the nearest obstacle's grown shape (≤ 0: free), and which copper that is. */
export function pointBlock(w: RouteWorld, layer: string, p: Vec2, extra = 0): { depth: number; uid?: string; net?: string | null } {
  let worst: { depth: number; uid?: string; net?: string | null } = { depth: -Infinity };
  for (const o of near(w, layer, p.x - extra, p.y - extra, p.x + extra, p.y + extra)) {
    let d = o.r + extra - distToSegment(p, o.a, o.b);
    if (o.area && inArea(p, o.area)) d = Math.max(d, o.r + extra);
    if (d > worst.depth) worst = { depth: d, uid: o.uid, net: o.net };
  }
  if (w.outline && !pointInPolygon(p, w.outline)) return { depth: Infinity, uid: 'edge', net: null };
  for (const o of w.edges) {
    const d = o.r + extra - distToSegment(p, o.a, o.b);
    if (d > worst.depth) worst = { depth: d, uid: 'edge', net: null };
  }
  return worst;
}

export const pointFree = (w: RouteWorld, layer: string, p: Vec2, extra = 0) => pointBlock(w, layer, p, extra).depth <= 1e-9;

/** The first copper a straight piece of trace would break the clearance of, or undefined when it is legal. */
export function segmentHit(w: RouteWorld, layer: string, a: Vec2, b: Vec2): { uid: string; net: string | null } | undefined {
  for (const o of near(w, layer, Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y))) {
    if (segSegDist(a, b, o.a, o.b) < o.r - 1e-9) return { uid: o.uid, net: o.net };
    if (o.area && (inArea(a, o.area) || inArea(b, o.area))) return { uid: o.uid, net: o.net };
  }
  if (w.outline && (!pointInPolygon(a, w.outline) || !pointInPolygon(b, w.outline))) return { uid: 'edge', net: null };
  for (const o of w.edges) if (segSegDist(a, b, o.a, o.b) < o.r - 1e-9) return { uid: 'edge', net: null };
  return undefined;
}

export const segmentFree = (w: RouteWorld, layer: string, a: Vec2, b: Vec2) => !segmentHit(w, layer, a, b);

export function pathFree(w: RouteWorld, layer: string, pts: Vec2[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (!segmentFree(w, layer, pts[i]!, pts[i + 1]!)) return false;
  return true;
}

/** A via of the net (diameter `d`) at `p`: legal on every copper layer it spans. */
export function viaFree(w: RouteWorld, p: Vec2, d: number, layers = w.layers): boolean {
  const extra = d / 2 - w.width / 2;
  return layers.every((l) => pointFree(w, l, p, extra));
}

export interface WalkResult {
  /** The path from `from`, 45° segments, collinear points merged. */
  path: Vec2[];
  /** True when the path ends at `to`; false when it stops at the free point nearest to it. */
  reached: boolean;
}

function simplify(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    if (out.length && Math.hypot(p.x - out[out.length - 1]!.x, p.y - out[out.length - 1]!.y) < 1e-9) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cross) < 1e-9 && dot >= 0) out.pop();
      else break;
    }
    out.push(p);
  }
  return out;
}

const round4 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/**
 * A legal 45° path from `from` towards `to` on one layer (see the module comment). `from` and `to` may sit
 * on the net's own pads (they are not obstacles); the first and last steps may leave a spot that is too
 * close to other copper only if the plain check of that piece passes.
 */
export function walkaround(w: RouteWorld, layer: string, from: Vec2, to: Vec2, opts: { diagonalFirst?: boolean; margin?: number; maxCells?: number; budgetMs?: number } = {}): WalkResult {
  const first = opts.diagonalFirst ?? true;
  const t0 = performance.now();
  for (const d of [first, !first]) {
    const p = route45(from, to, d);
    if (pathFree(w, layer, p)) return { path: simplify(p), reached: true };
  }
  // Grid search in a window around both points.
  const margin = opts.margin ?? 6;
  const span = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) + 2 * margin;
  const maxCells = opts.maxCells ?? 250_000;
  let step = Math.min(0.1, Math.max(0.025, w.width / 4));
  while ((span / step) ** 2 > maxCells) step *= 1.25;
  const x0 = Math.min(from.x, to.x) - margin;
  const y0 = Math.min(from.y, to.y) - margin;
  const nx = Math.ceil((Math.max(from.x, to.x) + margin - x0) / step) + 1;
  const ny = Math.ceil((Math.max(from.y, to.y) + margin - y0) / step) + 1;
  const N = nx * ny;
  const free = new Uint8Array(N); // 0 unknown, 1 free, 2 blocked
  const slack = step * 0.7072;
  const at = (c: number): Vec2 => ({ x: x0 + (c % nx) * step, y: y0 + Math.floor(c / nx) * step });
  const cellOf = (p: Vec2) => Math.round((p.y - y0) / step) * nx + Math.round((p.x - x0) / step);
  const isFree = (c: number) => {
    if (!free[c]) free[c] = pointFree(w, layer, at(c), slack) ? 1 : 2;
    return free[c] === 1;
  };
  const s = cellOf(from);
  const t = cellOf(to);
  const sp = at(s);
  // Cells next to the start that the plain check allows (leaving a pad between neighbours).
  const startOk = (c: number) => isFree(c) || (Math.hypot(at(c).x - sp.x, at(c).y - sp.y) < 1.5 && segmentFree(w, layer, from, at(c)));
  const g = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const dirOf = new Int8Array(N).fill(-1);
  const open: [number, number][] = [];
  const push = (c: number, f: number) => {
    open.push([f, c]);
    let i = open.length - 1;
    while (i > 0) {
      const pI = (i - 1) >> 1;
      if (open[pI]![0] <= open[i]![0]) break;
      [open[pI], open[i]] = [open[i]!, open[pI]!];
      i = pI;
    }
  };
  const pop = (): number => {
    const top = open[0]!;
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < open.length && open[l]![0] < open[m]![0]) m = l;
        if (r < open.length && open[r]![0] < open[m]![0]) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i]!, open[m]!];
        i = m;
      }
    }
    return top[1];
  };
  const tp = at(t);
  const hx = (c: number) => {
    const p = at(c);
    const dx = Math.abs(p.x - tp.x);
    const dy = Math.abs(p.y - tp.y);
    return (Math.max(dx, dy) - Math.min(dx, dy) + Math.SQRT2 * Math.min(dx, dy)) / step;
  };
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  g[s] = 0;
  push(s, hx(s));
  let best = s;
  let bestH = hx(s);
  let found = false;
  const tFree = segmentFree(w, layer, to, to);
  let expanded = 0;
  while (open.length) {
    const c = pop();
    if (c === t) {
      found = true;
      break;
    }
    if (++expanded > maxCells || (opts.budgetMs !== undefined && (expanded & 255) === 0 && performance.now() - t0 > opts.budgetMs)) break;
    const h = hx(c);
    if (h < bestH) (bestH = h), (best = c);
    const cx = c % nx;
    const cy = Math.floor(c / nx);
    for (let k = 0; k < 8; k++) {
      const x = cx + DX[k]!;
      const y = cy + DY[k]!;
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
      const n = y * nx + x;
      const ok = n === t ? tFree || isFree(n) : c === s || prev[c] === s ? startOk(n) : isFree(n);
      if (!ok) continue;
      // A turn costs a little, so the path keeps few corners; a sharp turn (90° or more) costs more.
      const dc = dirOf[c]!;
      const turn = dc < 0 ? 0 : Math.min((k - dc + 8) % 8, (dc - k + 8) % 8);
      const cost = g[c]! + (k % 2 ? Math.SQRT2 : 1) + (turn === 0 ? 0 : turn === 1 ? 0.3 : 3);
      if (cost < g[n]!) {
        g[n] = cost;
        prev[n] = c;
        dirOf[n] = k;
        push(n, cost + hx(n));
      }
    }
  }
  const end = found ? t : best;
  const cells: number[] = [];
  for (let c = end; c >= 0; c = prev[c]!) cells.push(c);
  cells.reverse();
  const raw = cells.map(at);
  raw[0] = from;
  if (found) raw[raw.length - 1] = to;
  // Pull tight: from each point, jump to the farthest later point a legal 45° path reaches.
  const out: Vec2[] = [from];
  let i = 0;
  while (i < raw.length - 1) {
    let j = i + 1;
    let via: Vec2[] = [raw[i]!, raw[j]!];
    let misses = 0;
    for (let k = i + 2; k < raw.length && misses < 40; k++) {
      let ok: Vec2[] | undefined;
      for (const d of [first, !first]) {
        const p = route45(raw[i]!, raw[k]!, d);
        if (pathFree(w, layer, p)) {
          ok = p;
          break;
        }
      }
      if (ok) (j = k), (via = ok), (misses = 0);
      else misses++;
    }
    out.push(...via.slice(1));
    i = j;
  }
  const path = simplify(out.map((p, k) => (k === 0 || (found && k === out.length - 1) ? p : round4(p))));
  // A last check of each piece: cut the path at the first piece that is not legal.
  for (let k = 0; k + 1 < path.length; k++) {
    if (!segmentFree(w, layer, path[k]!, path[k + 1]!)) return { path: path.slice(0, k + 1), reached: false };
  }
  return { path: path.length >= 2 ? path : [from], reached: found };
}

// ---------- dragging a trace segment ----------

export interface DragPlan {
  ops: Op[];
  /** The segments after the drag (for a preview): uid (or 'new'), layer, ends, width. */
  pieces: { uid: string; layer: string; a: Vec2; b: Vec2; w: number }[];
  /** The offset that was applied (it may be less than asked: the drag stops at other copper). */
  offset: number;
  error?: string;
}

const eqp = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * Drag one straight trace segment sideways by `offset` mm (along its normal, to the left of start → end):
 * the segments joined to its ends (same net and layer, no pad or via at the joint) keep their direction and
 * stretch to meet it; an end on a pad, a via or a branch keeps its place and gets a 45° piece. With `world`
 * the offset is cut back to what stays clear of other copper (the drag stops at it).
 */
export function planDragSegment(doc: Doc, engine: StyleEngine, copper: string[], uid: string, offset: number, opts: { world?: RouteWorld } = {}): DragPlan {
  const fail = (error: string): DragPlan => ({ ops: [], pieces: [], offset: 0, error });
  const t = doc.nodes.get(uid);
  if (t?.type !== 'trace') return fail('not a trace');
  if (engine.get(uid, 'mid')?.value) return fail('arcs cannot be dragged sideways');
  const a = vec(engine.get(uid, 'start')?.value);
  const b = vec(engine.get(uid, 'end')?.value);
  const layer = String(engine.get(uid, 'layer')?.value ?? '');
  if (!a || !b || eqp(a, b)) return fail('the trace has no length');
  const net = t.parent ? doc.nodes.get(t.parent) : undefined;
  if (net?.type !== 'net') return fail('the trace is not on a net');
  if (t.props.locked || net.props.locked) return fail('the trace is locked');
  const width = (n: DocNode) => Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25);
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
  const nrm = { x: u.y, y: -u.x };
  const shapes = collectCopper(doc, engine, copper);
  const anchored = (p: Vec2) => shapes.some((s) => s.net === net.name && (s.kind === 'via' || (s.kind === 'pad' && s.layer === layer)) && (s.kind === 'via' ? Math.hypot(p.x - s.probe.x, p.y - s.probe.y) <= (s.edges[0]?.[2] ?? 0) : !!s.areas[0] && inArea(p, s.areas[0])));
  const sibs = net.children.map((c) => doc.nodes.get(c)!).filter((n) => n.type === 'trace' && n.uid !== uid && engine.get(n.uid, 'layer')?.value === layer && !engine.get(n.uid, 'mid')?.value);
  const joint = (p: Vec2) => {
    const at = sibs.filter((n) => eqp(vec(engine.get(n.uid, 'start')?.value)!, p) || eqp(vec(engine.get(n.uid, 'end')?.value)!, p));
    if (at.length !== 1 || anchored(p)) return undefined;
    const n = at[0]!;
    const s = vec(engine.get(n.uid, 'start')?.value)!;
    const e = vec(engine.get(n.uid, 'end')?.value)!;
    const far = eqp(s, p) ? e : s;
    const atStart = eqp(s, p);
    if (n.props.locked) return undefined;
    return { n, far, atStart };
  };
  const ja = joint(a);
  const jb = joint(b);
  const w0 = width(t);

  const build = (d: number): DragPlan['pieces'] | undefined => {
    const A = { x: a.x + nrm.x * d, y: a.y + nrm.y * d };
    const B = { x: b.x + nrm.x * d, y: b.y + nrm.y * d };
    const pieces: DragPlan['pieces'] = [];
    // One end: the new end of the dragged segment, and the neighbour's new piece (or a 45° connector).
    const end = (p: Vec2, P: Vec2, j: ReturnType<typeof joint>, sign: 1 | -1): Vec2 | undefined => {
      if (j) {
        const v = { x: j.far.x - p.x, y: j.far.y - p.y };
        const cross = u.x * v.y - u.y * v.x;
        if (Math.abs(cross) > 1e-6 * Math.hypot(v.x, v.y)) {
          // Where the neighbour's line meets the moved segment's line.
          const tau = ((P.x - j.far.x) * u.y - (P.y - j.far.y) * u.x) / (v.x * u.y - v.y * u.x);
          const q = { x: j.far.x + v.x * tau, y: j.far.y + v.y * tau };
          // The neighbour may shrink but not turn round.
          if ((q.x - j.far.x) * -v.x + (q.y - j.far.y) * -v.y <= 1e-6) return undefined;
          pieces.push({ uid: j.n.uid, layer, a: j.atStart ? q : j.far, b: j.atStart ? j.far : q, w: width(j.n) });
          return q;
        }
      }
      // A fixed end (or a straight continuation): a 45° piece from the old end into the moved segment.
      const q = { x: P.x + u.x * sign * Math.abs(d), y: P.y + u.y * sign * Math.abs(d) };
      pieces.push({ uid: 'new', layer, a: p, b: q, w: w0 });
      return q;
    };
    const qa = end(a, A, ja, 1);
    const qb = end(b, B, jb, -1);
    if (!qa || !qb) return undefined;
    // The dragged segment may not turn round either.
    if ((qb.x - qa.x) * u.x + (qb.y - qa.y) * u.y <= 1e-6) return undefined;
    pieces.unshift({ uid, layer, a: qa, b: qb, w: w0 });
    return pieces.map((p) => ({ ...p, a: round4(p.a), b: round4(p.b) }));
  };
  const legal = (ps: DragPlan['pieces'] | undefined) => !!ps && (!opts.world || ps.every((p) => segmentFree(opts.world!, p.layer, p.a, p.b)));
  let d = offset;
  let pieces = build(d);
  if (!legal(pieces)) {
    // Binary search for the largest legal part of the offset.
    let lo = 0;
    let hi = offset;
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (legal(build(mid))) lo = mid;
      else hi = mid;
    }
    // Rounded towards zero (the search ends right at the clearance; rounding outwards would cross it),
    // stepping back a little more while the rounded ends still break it.
    d = Math.trunc(lo * 1e4) / 1e4;
    pieces = undefined;
    for (let k = 0; k < 5 && Math.abs(d) > 1e-4; k++, d = Math.trunc((d - Math.sign(d) * 1e-4) * 1e4) / 1e4) {
      const ps = build(d);
      if (legal(ps)) {
        pieces = ps;
        break;
      }
    }
    if (!pieces) return { ops: [], pieces: [], offset: 0, error: 'other copper is in the way' };
  }
  const ops: Op[] = [];
  let index = net.children.length;
  for (const p of pieces!) {
    if (eqp(p.a, p.b)) {
      if (p.uid !== 'new') ops.push({ op: 'remove', uid: p.uid });
      continue;
    }
    if (p.uid === 'new') {
      const own = t.rules.find((r) => r.name === 'traceWidth');
      ops.push({ op: 'add', parent: net.uid, index: index++, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: p.a }, { name: 'end', value: p.b }, { name: 'layer', value: layer }, ...(own ? [own] : [])], parent: net.uid, children: [] }] } });
    } else {
      ops.push({ op: 'setRule', uid: p.uid, name: 'start', decl: { name: 'start', value: p.a } }, { op: 'setRule', uid: p.uid, name: 'end', decl: { name: 'end', value: p.b } });
    }
  }
  return { ops, pieces: pieces!, offset: d };
}

// ---------- pairs routed by hand ----------

/** The polyline moved sideways by `d` (left of the direction of travel), corners mitred. */
export function offsetPath(pts: Vec2[], d: number): Vec2[] {
  if (pts.length < 2) return pts.slice();
  const dirs: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    dirs.push({ x: (b.x - a.x) / L, y: (b.y - a.y) / L });
  }
  const n = (u: Vec2) => ({ x: u.y, y: -u.x });
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const u0 = dirs[Math.max(0, i - 1)]!;
    const u1 = dirs[Math.min(dirs.length - 1, i)]!;
    if (i === 0 || i === pts.length - 1) {
      const m = n(i === 0 ? u1 : u0);
      out.push({ x: p.x + m.x * d, y: p.y + m.y * d });
      continue;
    }
    const m0 = n(u0);
    const m1 = n(u1);
    const bis = { x: m0.x + m1.x, y: m0.y + m1.y };
    const bl = Math.hypot(bis.x, bis.y);
    if (bl < 1e-9) {
      out.push({ x: p.x + m1.x * d, y: p.y + m1.y * d });
      continue;
    }
    const cos = (bis.x * m0.x + bis.y * m0.y) / bl;
    const k = d / Math.max(0.2, cos);
    out.push({ x: p.x + (bis.x / bl) * k, y: p.y + (bis.y / bl) * k });
  }
  return out;
}

export const pathLength = (pts: Vec2[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) : 0), 0);

/** The partner of a differential pair (by name or `pairWith`) and the pair gap, when the net is in one with a `diffGap`. */
export function pairPartner(doc: Doc, engine: StyleEngine, net: string): { partner: string; gap: number; name: string } | undefined {
  const pair = diffPairs(netLengths(doc, engine)).find((d) => d.p === net || d.n === net);
  if (!pair) return undefined;
  const partner = pair.p === net ? pair.n : pair.p;
  const gapOf = (n: string) => {
    const nn = netNodeOf(doc, n);
    const v = nn ? engine.get(nn.uid, 'diffGap')?.value : undefined;
    return typeof v === 'number' ? v : 0;
  };
  const gap = Math.max(gapOf(net), gapOf(partner));
  return gap > 0 ? { partner, gap, name: pair.name } : undefined;
}

/** Pad centres of a net, with the copper layers each pad is on. */
export function netPads(doc: Doc, engine: StyleEngine, copper: string[], net: string): { uid: string; at: Vec2; layers: string[] }[] {
  const out: { uid: string; at: Vec2; layers: string[] }[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'pad' || n.props.net !== net) continue;
    const g = padGeom(doc, engine, n, copper);
    if (g) out.push({ uid: n.uid, at: g.center, layers: g.layers.filter((l) => copper.includes(l)) });
  }
  return out;
}

/** Routed length of a net (straight and arc traces). */
export function routedLength(doc: Doc, engine: StyleEngine, net: string): number {
  return netLengths(doc, engine).find((l) => l.net === net)?.length ?? 0;
}
