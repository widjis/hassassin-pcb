/**
 * Grid autorouter: routes the ratsnest connections one by one with A* over a grid per
 * copper layer (8 directions → 45° traces) with through vias, keeping each net's
 * clearance from other copper, with negotiated rip-up and retry (P8d) and no push-and-shove.
 * Connections it cannot complete are reported, never forced.
 *
 * Clearance (P8b, docs/05-pcb-improvements.md): every grid cell keeps the distance to the
 * nearest copper of the two nearest different owners (a two-label distance field), with the
 * clearance that copper demands. A cell is usable for a net when the nearest copper that is not
 * its own is at least half the net's width plus the larger of the two clearances away, so each
 * net is checked with its own width and clearance (no zone shared by all nets).
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, KeepOut, RuleDecl, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { boardOutline, clearanceFor, collectCopper, inArea } from './copper.ts';
import { computeRatsnest } from './connectivity.ts';
import { arcPoints, distToSegment, pointInPolygon } from './geom.ts';

export interface AutorouteOptions {
  /** Only these nets (default: every net with unrouted connections). */
  nets?: string[];
  /** Grid pitch in mm (default: picked from board size, 0.1–0.25). */
  grid?: number;
  /** Extra cost of a via, in grid steps (default 12). */
  viaCost?: number;
  /** Layers to route on (default: all copper layers). */
  layers?: string[];
  /** Corner style for every net, overriding the `cornerStyle` rule (P8e). */
  cornerStyle?: '45' | 'arc' | '90';
  /** Rounds of rip-up and retry (default 30; 1 = route once, no rip-up). */
  rounds?: number;
  /** Stop after this many milliseconds (default 30 s); connections not tried are reported as `time limit`. */
  timeLimitMs?: number;
}

export interface AutorouteReport {
  routed: { net: string; from: Vec2; to: Vec2; length: number; vias: number }[];
  failed: { net: string; from: Vec2; to: Vec2; reason: string }[];
  grid: number;
  ms: number;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0]!;
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1]! < k[c]!) c++;
        if (k[c]! >= lk) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

export function planAutoroute(doc: Doc, engine: StyleEngine, copper: string[], opts: AutorouteOptions = {}): { ops: Op[]; report: AutorouteReport } {
  const t0 = performance.now();
  const layers = (opts.layers ?? copper).filter((l) => copper.includes(l));
  const report: AutorouteReport = { routed: [], failed: [], grid: 0, ms: 0 };
  const board = boardOutline(doc, engine);
  const outline = board.loops[0];
  const rats = computeRatsnest(doc, engine, copper).lines.filter((l) => !opts.nets || opts.nets.includes(l.net));
  if (!outline || !rats.length || !layers.length) {
    report.ms = performance.now() - t0;
    if (!outline && rats.length) for (const r of rats) report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'no board outline' });
    return { ops: [], report };
  }

  // Grid over the board.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outline) (minX = Math.min(minX, p.x)), (minY = Math.min(minY, p.y)), (maxX = Math.max(maxX, p.x)), (maxY = Math.max(maxY, p.y));
  const area = (maxX - minX) * (maxY - minY);
  let g = opts.grid ?? Math.max(0.1, Math.min(0.25, Math.sqrt(area / 600000)));
  if ((area / (g * g)) * layers.length > 6e6) g = Math.sqrt((area * layers.length) / 6e6);
  report.grid = g;
  const W = Math.ceil((maxX - minX) / g) + 1;
  const H = Math.ceil((maxY - minY) / g) + 1;
  const N = W * H;
  const L = layers.length;
  const cx = (i: number) => minX + i * g;
  const cy = (j: number) => minY + j * g;
  const toI = (x: number) => Math.round((x - minX) / g);
  const toJ = (y: number) => Math.round((y - minY) / g);

  // Net ids.
  const netIds = new Map<string, number>();
  const netId = (n: string | null) => {
    if (!n) return -1;
    let id = netIds.get(n);
    if (id === undefined) netIds.set(n, (id = netIds.size + 1));
    return id;
  };

  const netNode = new Map<string, DocNode>();
  for (const n of doc.nodes.values()) if (n.type === 'net') netNode.set(n.name, n);
  const netRule = (net: string, name: string, d: number) => {
    const n = netNode.get(net);
    const v = n ? engine.get(n.uid, name)?.value : undefined;
    return typeof v === 'number' && v > 0 ? v : d;
  };
  const netClear = (net: string) => {
    const n = netNode.get(net);
    const k = n ? (engine.get(n.uid, 'keepOut')?.value as KeepOut | undefined) : undefined;
    return k ? clearanceFor(k, 'pad') : 0.2;
  };

  // Per layer: `core` = copper owner (net id, -1 for no-net copper / outside the board).
  const core = layers.map(() => new Int32Array(N));
  // Distance field per layer. Slot 1 and 2: the two nearest different owners of copper near the
  // cell (`o`), the distance from the cell centre to that owner's copper edge (`d`), and the smallest
  // distance minus the clearance that copper demands from a trace (`e`). An owner pushed out by two
  // nearer ones is folded into `zd` / `ze`, which every net must respect (conservative).
  const field = layers.map(() => ({
    o1: new Int32Array(N), d1: new Float32Array(N).fill(Infinity), e1: new Float32Array(N).fill(Infinity),
    o2: new Int32Array(N), d2: new Float32Array(N).fill(Infinity), e2: new Float32Array(N).fill(Infinity),
    zd: new Float32Array(N).fill(Infinity), ze: new Float32Array(N).fill(Infinity),
  }));
  const note = (li: number, c: number, owner: number, d: number, e: number) => {
    const f = field[li]!;
    if (f.o1[c] === owner && f.d1[c]! < Infinity) {
      if (d < f.d1[c]!) f.d1[c] = d;
      if (e < f.e1[c]!) f.e1[c] = e;
      return;
    }
    if (f.o2[c] === owner && f.d2[c]! < Infinity) {
      if (d < f.d2[c]!) f.d2[c] = d;
      if (e < f.e2[c]!) f.e2[c] = e;
      if (f.d2[c]! < f.d1[c]!) {
        const [o, dd, ee] = [f.o1[c]!, f.d1[c]!, f.e1[c]!];
        (f.o1[c] = f.o2[c]!), (f.d1[c] = f.d2[c]!), (f.e1[c] = f.e2[c]!);
        (f.o2[c] = o), (f.d2[c] = dd), (f.e2[c] = ee);
      }
      return;
    }
    // A new owner at this cell.
    const fold = (dd: number, ee: number) => {
      if (dd < f.zd[c]!) f.zd[c] = dd;
      if (ee < f.ze[c]!) f.ze[c] = ee;
    };
    if (d < f.d1[c]!) {
      if (f.d2[c]! < Infinity) fold(f.d2[c]!, f.e2[c]!);
      (f.o2[c] = f.o1[c]!), (f.d2[c] = f.d1[c]!), (f.e2[c] = f.e1[c]!);
      (f.o1[c] = owner), (f.d1[c] = d), (f.e1[c] = e);
    } else if (d < f.d2[c]!) {
      if (f.d2[c]! < Infinity) fold(f.d2[c]!, f.e2[c]!);
      (f.o2[c] = owner), (f.d2[c] = d), (f.e2[c] = e);
    } else fold(d, e);
  };
  // Distance from each cell centre to the board edge (outline and cutouts), up to EDGE_CAP mm: copper
  // must keep its half-width plus the board-edge clearance from it. Cells outside the board, or in a
  // cutout, belong to nobody (-1).
  const EDGE_CAP = 3;
  const edgeDist = new Float32Array(N).fill(EDGE_CAP);
  const cutouts = board.loops.slice(1);
  for (let j = 0; j < H; j++) {
    const y = cy(j);
    const rowSegs = board.segments.filter(([a, b]) => Math.min(a.y, b.y) <= y + EDGE_CAP && Math.max(a.y, b.y) >= y - EDGE_CAP);
    for (let i = 0; i < W; i++) {
      const p = { x: cx(i), y };
      const c = j * W + i;
      if (!pointInPolygon(p, outline) || cutouts.some((h) => pointInPolygon(p, h))) {
        for (const o of core) o[c] = -1;
        edgeDist[c] = 0;
        continue;
      }
      let d = EDGE_CAP;
      for (const [a, b] of rowSegs) if (Math.min(a.x, b.x) <= p.x + d && Math.max(a.x, b.x) >= p.x - d) d = Math.min(d, distToSegment(p, a, b));
      edgeDist[c] = d;
      if (d < 0.02) for (const o of core) o[c] = -1;
    }
  }

  const shapes = collectCopper(doc, engine, copper);
  const routedNets = [...new Set(rats.map((r) => r.net))];
  // How far the distance field must reach: the widest half-width plus the largest clearance that
  // any routed net or any copper asks for, plus one cell for the step between cell centres.
  let reachW = 0;
  let reachC = 0;
  for (const n of routedNets) {
    reachW = Math.max(reachW, netRule(n, 'traceWidth', 0.25) / 2, netRule(n, 'viaDiameter', 0.6) / 2);
    reachC = Math.max(reachC, netClear(n));
  }
  for (const s of shapes) reachC = Math.max(reachC, clearanceFor(s.keepOut, 'trace'));
  const reach = reachW + reachC + g * 1.5;

  /** Mark copper of `id` on layer `li` (copper core, and distances around it). `cl` = clearance it demands. */
  const paint = (li: number, id: number, s: { edges: [Vec2, Vec2, number][]; areas: Vec2[][][] }, cl: number) => {
    const co = core[li]!;
    const setCore = (c: number) => {
      const v = co[c]!;
      if (v === 0 || v === id || (v === -1 && id > 0)) co[c] = id;
    };
    const extra = reach;
    // Edges (traces, vias, outlines) as capsules: copper inside, distances around.
    for (const [a, b, r] of s.edges) {
      const reach = r + extra;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - minX) / g));
      const i1 = Math.min(W - 1, Math.ceil((Math.max(a.x, b.x) + reach - minX) / g));
      const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - minY) / g));
      const j1 = Math.min(H - 1, Math.ceil((Math.max(a.y, b.y) + reach - minY) / g));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = distToSegment({ x: cx(i), y: cy(j) }, a, b) - r;
          if (d >= extra) continue;
          const c = j * W + i;
          if (d <= 0) setCore(c);
          note(li, c, id, Math.max(0, d), Math.max(0, d) - cl);
        }
      }
    }
    // Areas (pads, pours): scanline fill, even-odd over all rings.
    for (const ar of s.areas) {
      let y0 = Infinity, y1 = -Infinity;
      for (const ring of ar) for (const p of ring) (y0 = Math.min(y0, p.y)), (y1 = Math.max(y1, p.y));
      const j0 = Math.max(0, Math.ceil((y0 - minY) / g));
      const j1 = Math.min(H - 1, Math.floor((y1 - minY) / g));
      for (let j = j0; j <= j1; j++) {
        const y = cy(j);
        const xs: number[] = [];
        for (const ring of ar) {
          for (let k = 0; k < ring.length; k++) {
            const p = ring[k]!;
            const q = ring[(k + 1) % ring.length]!;
            if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
          }
        }
        xs.sort((u, v) => u - v);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil((xs[k]! - minX) / g));
          const i1 = Math.min(W - 1, Math.floor((xs[k + 1]! - minX) / g));
          for (let i = i0; i <= i1; i++) setCore(j * W + i);
        }
      }
    }
  };
  const layerIdx = new Map(layers.map((l, i) => [l, i]));
  // Cells covered by any pad on any layer: a via may never sit in (or touch) a pad, own net
  // included (solder would wick into the hole, and castellated module pads have no room).
  const padMask = new Uint8Array(N);
  for (const s of shapes) {
    if (s.kind !== 'pad') continue;
    for (const ar of s.areas) {
      let y0 = Infinity, y1 = -Infinity;
      for (const ring of ar) for (const q of ring) (y0 = Math.min(y0, q.y)), (y1 = Math.max(y1, q.y));
      const j0 = Math.max(0, Math.floor((y0 - minY) / g));
      const j1 = Math.min(H - 1, Math.ceil((y1 - minY) / g));
      for (let j = j0; j <= j1; j++) {
        const y = cy(j);
        const xs: number[] = [];
        for (const ring of ar)
          for (let k = 0; k < ring.length; k++) {
            const a0 = ring[k]!;
            const b0 = ring[(k + 1) % ring.length]!;
            if ((a0.y > y) !== (b0.y > y)) xs.push(a0.x + ((y - a0.y) * (b0.x - a0.x)) / (b0.y - a0.y));
          }
        xs.sort((u, v) => u - v);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.floor((xs[k]! - minX) / g));
          const i1 = Math.min(W - 1, Math.ceil((xs[k + 1]! - minX) / g));
          for (let i = i0; i <= i1; i++) padMask[j * W + i] = 1;
        }
      }
    }
  }

  for (const s of shapes) {
    const li = layerIdx.get(s.layer);
    if (li === undefined) continue;
    const id = netId(s.net);
    // Pours of other nets are refilled around new traces, so they are not obstacles.
    if (s.kind === 'fill' && !(s.net && routedNets.includes(s.net))) continue;
    paint(li, id, { edges: s.kind === 'fill' ? [] : s.edges, areas: s.kind === 'fill' || s.kind === 'pad' ? s.areas : [] }, clearanceFor(s.keepOut, 'trace'));
  }

  // Order: short connections and small nets first.
  const order = rats.slice().sort((a, b) => Math.hypot(a.a.x - a.b.x, a.a.y - a.b.y) - Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y));
  const viaCost = opts.viaCost ?? 12;
  const limit = opts.timeLimitMs ?? 30000;
  const maxRounds = opts.rounds ?? 30;
  const ops: Op[] = [];
  const cost = new Float32Array(N * L);
  const from = new Int32Array(N * L);
  const stamp = new Int32Array(N * L);
  // States already expanded in the current search: a state is expanded once (later, stale heap entries
  // of it are skipped), so a search that finds nothing ends after at most one pass over the board.
  const closed = new Int32Array(N * L);
  let run = 0;
  // Per-call memo of the cell tests (value = 2 * call + result; stale calls read as unknown).
  const usableMemo = new Int32Array(N * L);
  const viaMemo = new Int32Array(N);
  const dynStamp = new Int32Array(N * L);
  const dynCount = new Uint8Array(N * L);
  let conn = 0;
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
  // The step between two cell centres can pass closer to a corner of copper than either centre;
  // this margin covers it for a half-width + clearance of `R` (worst case: a point obstacle).
  const halfStep = g * Math.SQRT1_2;
  const slackFor = (R: number) => R - Math.sqrt(Math.max(0, R * R - halfStep * halfStep));
  const cellOf = (q: Vec2) => {
    const i = toI(q.x);
    const j = toJ(q.y);
    return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
  };

  // ---- Routes laid by this run (P8d). They are kept apart from the fixed copper above so they can be
  // ripped up: capsules in buckets of BK mm per layer; a capsule is filed in every bucket within `reach`
  // of it, so the bucket of a point holds every capsule that can matter there.
  interface Cap { li: number; a: Vec2; b: Vec2; r: number; id: number; cl: number; route: number }
  interface Route { key: number; conn: number; net: string; id: number; caps: Cap[]; segs: { li: number; a: Vec2; b: Vec2; w: number; mid?: Vec2 }[]; vias: Vec2[]; length: number; deps: Set<number> }
  const BK = Math.max(1, reach * 2);
  const BW = Math.ceil((maxX - minX) / BK) + 2;
  const buckets = layers.map(() => new Map<number, Cap[]>());
  const bucketOf = (x: number, y: number) => Math.floor((y - minY) / BK + 1) * BW + Math.floor((x - minX) / BK + 1);
  const routes = new Map<number, Route>();
  let routeKey = 0;
  const fileCap = (cp: Cap, add: boolean) => {
    const m = cp.r + reach;
    const b = buckets[cp.li]!;
    for (let by = Math.floor((Math.min(cp.a.y, cp.b.y) - m - minY) / BK + 1); by <= Math.floor((Math.max(cp.a.y, cp.b.y) + m - minY) / BK + 1); by++)
      for (let bx = Math.floor((Math.min(cp.a.x, cp.b.x) - m - minX) / BK + 1); bx <= Math.floor((Math.max(cp.a.x, cp.b.x) + m - minX) / BK + 1); bx++) {
        const k = by * BW + bx;
        if (add) (b.get(k) ?? b.set(k, []).get(k)!).push(cp);
        else {
          const list = b.get(k);
          if (list) b.set(k, list.filter((x) => x !== cp));
        }
      }
  };
  const capsNear = (li: number, p: Vec2) => buckets[li]!.get(bucketOf(p.x, p.y)) ?? [];
  /** Every run-route capsule that can matter anywhere along segment a–b (all buckets it crosses). */
  const capsAlong = (li: number, a: Vec2, b: Vec2): Cap[] => {
    const out = new Set<Cap>();
    const bmap = buckets[li]!;
    for (let by = Math.floor((Math.min(a.y, b.y) - minY) / BK + 1); by <= Math.floor((Math.max(a.y, b.y) - minY) / BK + 1); by++)
      for (let bx = Math.floor((Math.min(a.x, b.x) - minX) / BK + 1); bx <= Math.floor((Math.max(a.x, b.x) - minX) / BK + 1); bx++) for (const cp of bmap.get(by * BW + bx) ?? []) out.add(cp);
    return [...out];
  };

  /** Try one connection. `pres` = cost per run-route in the way (Infinity: only free room). */
  const routeConn = (r: (typeof rats)[number], pres: number, hist: Float32Array): { ok: true; route: Route; victims: Set<number>; contested: number[] } | { ok: false; reason: string; joined?: boolean } => {
    const id = netId(r.net);
    const width = netRule(r.net, 'traceWidth', 0.25);
    const viaD = netRule(r.net, 'viaDiameter', 0.6);
    const cn = netClear(r.net);
    const viaR = Math.ceil((viaD / 2 + cn - width / 2) / g);
    const soft = pres !== Infinity;
    // Corner style (P8e): 45 = soften right angles into two 45° turns, arc = round every turn, 90 = keep
    // right angles. Acute corners are never made in any style.
    const styleRule = netNode.get(r.net) ? engine.get(netNode.get(r.net)!.uid, 'cornerStyle')?.value : undefined;
    const style: '45' | 'arc' | '90' = opts.cornerStyle ?? (styleRule === 'arc' || styleRule === '90' ? styleRule : '45');
    const setback = netRule(r.net, 'cornerSetback', 2 * width);
    // The corner pass softens right angles afterwards, so in the search they only cost a little more
    // than a 45° turn (a high price here makes the search wander and slows it down a lot).
    const turn90 = 0.3;
    // Pads of this net at the two ends that are narrower than the trace: inside a zone around them
    // (the pad grown by half the width plus the clearance) the trace necks down to the pad's width.
    const minTrace = netRule(r.net, 'traceWidthMin', 0.15);
    const necks: { box: { minX: number; minY: number; maxX: number; maxY: number }; w: number }[] = [];
    for (const end of [r.a, r.b]) {
      for (const sh of shapes) {
        if (sh.kind !== 'pad' || sh.net !== r.net || !sh.areas[0] || !inArea(end, sh.areas[0])) continue;
        const w = Math.min(sh.box.maxX - sh.box.minX, sh.box.maxY - sh.box.minY);
        if (w >= width) continue;
        const m = width / 2 + cn;
        necks.push({ box: { minX: sh.box.minX - m, minY: sh.box.minY - m, maxX: sh.box.maxX + m, maxY: sh.box.maxY + m }, w: Math.floor(w * 1000) / 1000 });
      }
    }
    if (necks.some((n) => n.w < minTrace)) return { ok: false, reason: 'pad is narrower than the minimum trace width' };
    const neckAt = (x: number, y: number) => {
      let w = width;
      for (const n of necks) if (x >= n.box.minX && x <= n.box.maxX && y >= n.box.minY && y <= n.box.maxY) w = Math.min(w, n.w);
      return w;
    };
    const edgeCl = netRule(r.net, 'boardEdgeClearance', 0.3);
    /** Room at cell `c` for copper of this net with half-width `half`: nearest fixed foreign copper and the board edge far enough. */
    const clear = (li: number, c: number, half: number, slack: number) => {
      if (edgeDist[c]! < half + slack + edgeCl - 1e-6) return false;
      const f = field[li]!;
      let m = Math.min(f.zd[c]! - cn, f.ze[c]!);
      if (f.o1[c] !== id) m = Math.min(m, f.d1[c]! - cn, f.e1[c]!);
      if (f.o2[c] !== id) m = Math.min(m, f.d2[c]! - cn, f.e2[c]!);
      return m >= half + slack - 1e-6;
    };
    /** Run-routes of other nets too close to point p for copper of half-width `half`. */
    const dynHits = (li: number, p: Vec2, half: number, slack: number, out?: Set<number>) => {
      let n = 0;
      for (const cp of capsNear(li, p)) {
        if (cp.id === id) continue;
        if (distToSegment(p, cp.a, cp.b) - cp.r < half + slack + Math.max(cn, cp.cl) - 1e-6) {
          n++;
          out?.add(cp.route);
        }
      }
      return n;
    };
    const halfFull = width / 2;
    const slackFull = slackFor(halfFull + cn);
    const call = ++conn;
    const halfAt = (c: number) => {
      if (!necks.length) return halfFull;
      const i = c % W;
      return neckAt(cx(i), cy((c - i) / W)) / 2;
    };
    const fixedOk = (li: number, c: number) => {
      const m = usableMemo[li * N + c]!;
      if (m >> 1 === call) return (m & 1) === 1;
      const k = core[li]![c]!;
      let ok = k === 0 || k === id;
      if (ok) {
        const h = halfAt(c);
        ok = clear(li, c, h, h === halfFull ? slackFull : slackFor(h + cn));
      }
      usableMemo[li * N + c] = (call << 1) | (ok ? 1 : 0);
      return ok;
    };
    /** Run-routes of other nets in the way at cell c (memoised). */
    const crowd = (li: number, c: number) => {
      const s = li * N + c;
      if (dynStamp[s] === call) return dynCount[s]!;
      const i = c % W;
      const h = halfAt(c);
      const n = Math.min(255, dynHits(li, { x: cx(i), y: cy((c - i) / W) }, h, h === halfFull ? slackFull : slackFor(h + cn)));
      dynStamp[s] = call;
      dynCount[s] = n;
      return n;
    };
    /** Every cell on the path must have room for the trace (necked down near narrow end pads). */
    const usable = (li: number, c: number) => fixedOk(li, c) && (soft || crowd(li, c) === 0);
    const viaOk = (c: number) => {
      const m = viaMemo[c]!;
      if (m >> 1 === call) return (m & 1) === 1;
      let ok = true;
      const i = c % W;
      const j = (c - i) / W;
      for (let li = 0; li < L && ok; li++) {
        const k = core[li]![c]!;
        if ((k !== 0 && k !== id) || !clear(li, c, viaD / 2, 0)) ok = false;
        else if (!soft && dynHits(li, { x: cx(i), y: cy(j) }, viaD / 2, 0)) ok = false;
      }
      // A via never sits on or touches a pad, the net's own included.
      for (let dj = -viaR; dj <= viaR && ok; dj++)
        for (let di = -viaR; di <= viaR; di++) {
          if (di * di + dj * dj > viaR * viaR) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H || padMask[jj * W + ii]) {
            ok = false;
            break;
          }
        }
      viaMemo[c] = (call << 1) | (ok ? 1 : 0);
      return ok;
    };
    /** Width of a segment: necked down if any part of it lies in a neck zone. */
    const segWidth = (a: Vec2, b: Vec2) => {
      let w = width;
      for (const n of necks) if (segmentHitsBox(a, b, n.box)) w = Math.min(w, n.w);
      return w;
    };

    // ---- Ends (P8c). A connection starts and ends on any copper of its net: every cell of the copper
    // group at each end (found by flooding the net's copper on the grid) that has room for the trace, and
    // short exact entries from the end point itself (a straight 0° / 45° / 90° run out of the pad, then at
    // most one 45° or straight jog onto the grid), so pads off the grid are entered cleanly.
    /**
     * Layers where this net's copper covers point q, by the same tests the connectivity check uses
     * (inside a pad or pour, on a trace or via): a trace may only start or end where this holds.
     */
    const ownShapes = shapes.filter((sh) => sh.net === r.net);
    const ownRouteAt = (li: number, q: Vec2) => {
      for (const cp of capsNear(li, q)) if (cp.id === id && distToSegment(q, cp.a, cp.b) <= cp.r) return cp.route;
      return -1;
    };
    const ownLayersAt = (q: Vec2) => {
      const out = new Set<number>();
      for (const sh of ownShapes) {
        const li = layerIdx.get(sh.layer);
        if (li === undefined || out.has(li) || q.x < sh.box.minX - 1e-6 || q.x > sh.box.maxX + 1e-6 || q.y < sh.box.minY - 1e-6 || q.y > sh.box.maxY + 1e-6) continue;
        const on = sh.kind === 'pad' || sh.kind === 'fill' ? sh.areas.some((ar) => inArea(q, ar)) : sh.edges.some(([a, b, rr]) => distToSegment(q, a, b) <= rr);
        if (on) out.add(li);
      }
      for (let li = 0; li < L; li++) if (!out.has(li) && ownRouteAt(li, q) >= 0) out.add(li);
      return [...out];
    };
    /** Half-extent of the net's pad under q (how far an entry may run before it is out of the pad row). */
    const padExtentAt = (q: Vec2) => {
      let ext = 0;
      for (const sh of ownShapes) if (sh.kind === 'pad' && sh.areas[0] && inArea(q, sh.areas[0])) ext = Math.max(ext, (sh.box.maxX - sh.box.minX) / 2, (sh.box.maxY - sh.box.minY) / 2);
      return ext;
    };
    let nearShapes = shapes;
    /** Exact check of a short piece of trace against foreign copper on layer li (fixed copper; run-routes too unless soft). */
    const pieceClear = (li: number, a: Vec2, b: Vec2) => {
      const half = segWidth(a, b) / 2;
      const ca = cellOf(a);
      const cb = cellOf(b);
      if (ca < 0 || cb < 0 || core[li]![ca] === -1 || core[li]![cb] === -1) return false;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (Math.min(edgeDist[ca]!, edgeDist[cb]!) < half + edgeCl + len + g) {
        const needE = half + edgeCl - 1e-6;
        for (const [e0, e1] of board.segments) {
          if (Math.min(e0.x, e1.x) - needE > Math.max(a.x, b.x) || Math.max(e0.x, e1.x) + needE < Math.min(a.x, b.x) || Math.min(e0.y, e1.y) - needE > Math.max(a.y, b.y) || Math.max(e0.y, e1.y) + needE < Math.min(a.y, b.y)) continue;
          if (segSegDist(a, b, e0, e1) < needE) return false;
        }
      }
      for (const sh of nearShapes) {
        if (sh.layer !== layers[li] || sh.net === r.net || sh.kind === 'fill') continue;
        const need = half + Math.max(cn, clearanceFor(sh.keepOut, 'trace')) - 1e-6;
        if (sh.box.minX - need > Math.max(a.x, b.x) || sh.box.maxX + need < Math.min(a.x, b.x) || sh.box.minY - need > Math.max(a.y, b.y) || sh.box.maxY + need < Math.min(a.y, b.y)) continue;
        for (const [e0, e1, er] of sh.edges) if (segSegDist(a, b, e0, e1) - er < need) return false;
        if (sh.kind === 'pad' && sh.areas[0] && (inArea(a, sh.areas[0]) || inArea(b, sh.areas[0]))) return false;
      }
      if (!soft) for (const cp of capsAlong(li, a, b)) if (cp.id !== id && segSegDist(a, b, cp.a, cp.b) - cp.r < half + Math.max(cn, cp.cl) - 1e-6) return false;
      return true;
    };
    type End = Map<number, { cost: number; pts: Vec2[]; dir?: [number, number] }>;
    /** Entry states at end point q: grid state → cost (in cells) and the exact points from q up to (not including) the cell. */
    const entries = (q: Vec2, out: End) => {
      const ls = ownLayersAt(q);
      const rho = padExtentAt(q) + width + cn + 3 * g;
      // A person leaves a pad straight along its long axis: other first directions cost a little more.
      let axis: 'x' | 'y' | null = null;
      for (const sh of ownShapes) {
        if (sh.kind !== 'pad' || !sh.areas[0] || !inArea(q, sh.areas[0])) continue;
        const bw = sh.box.maxX - sh.box.minX;
        const bh = sh.box.maxY - sh.box.minY;
        if (Math.abs(bw - bh) > 0.05) axis = bw > bh ? 'x' : 'y';
      }
      nearShapes = shapes.filter((sh) => sh.box.maxX >= q.x - rho - reach && sh.box.minX <= q.x + rho + reach && sh.box.maxY >= q.y - rho - reach && sh.box.minY <= q.y + rho + reach);
      const offer = (li: number, pts: Vec2[], cell: Vec2) => {
        const c = cellOf(cell);
        if (c < 0 || !usable(li, c)) return;
        const path = [...pts, cell];
        let len = 0;
        for (let k = 0; k + 1 < path.length; k++) {
          const a = path[k]!;
          const b = path[k + 1]!;
          const l = Math.hypot(b.x - a.x, b.y - a.y);
          if (l < 1e-9) continue;
          if (!pieceClear(li, a, b)) return;
          len += l;
        }
        const st = li * N + c;
        const kept = path.filter((x, k) => k === 0 || Math.hypot(x.x - path[k - 1]!.x, x.y - path[k - 1]!.y) > 1e-9);
        if (kept.length < 2) {
          const cur = out.get(st);
          if (!cur || cur.cost > len / g) out.set(st, { cost: len / g, pts: [q] });
          return;
        }
        // Turns inside the entry may not be acute; the first piece should follow the pad's long axis.
        for (let k = 1; k + 1 < kept.length; k++) if (dirDot(kept[k - 1]!, kept[k]!, kept[k + 1]!) < -1e-9) return;
        const f0 = kept[0]!;
        const f1 = kept[1]!;
        const offAxis = axis === 'x' ? Math.abs(f1.y - f0.y) > 1e-9 : axis === 'y' ? Math.abs(f1.x - f0.x) > 1e-9 : false;
        const cost = len / g + (kept.length > 2 ? 0.1 : 0) + (offAxis ? 1 : 0);
        const l0 = kept[kept.length - 2]!;
        const l1 = kept[kept.length - 1]!;
        const dir: [number, number] = [Math.sign(Math.round((l1.x - l0.x) * 1e4)), Math.sign(Math.round((l1.y - l0.y) * 1e4))];
        const cur = out.get(st);
        if (!cur || cur.cost > cost) out.set(st, { cost, pts: kept.slice(0, -1), dir });
      };
      const steps = Math.ceil(rho / g) + 1;
      const i0 = Math.round((q.x - minX) / g);
      const j0 = Math.round((q.y - minY) / g);
      for (const li of ls) {
        for (let k = -steps; k <= steps; k++) {
          const i = i0 + k;
          const j = j0 + k;
          // Horizontal run along y = q.y to x = column - |dy|, then a 45° jog onto row j.
          for (const jj of [Math.floor((q.y - minY) / g), Math.ceil((q.y - minY) / g)]) {
            const dy = cy(jj) - q.y;
            const sx = Math.sign(cx(i) - q.x) || 1;
            const tx = cx(i) - sx * Math.abs(dy);
            if ((tx - q.x) * sx >= -1e-9) offer(li, [q, { x: tx, y: q.y }], { x: cx(i), y: cy(jj) });
          }
          // Vertical run along x = q.x, then a 45° jog onto column ii.
          for (const ii of [Math.floor((q.x - minX) / g), Math.ceil((q.x - minX) / g)]) {
            const dx = cx(ii) - q.x;
            const sy = Math.sign(cy(j) - q.y) || 1;
            const ty = cy(j) - sy * Math.abs(dx);
            if ((ty - q.y) * sy >= -1e-9) offer(li, [q, { x: q.x, y: ty }], { x: cx(ii), y: cy(j) });
          }
          // 45° runs to column i, then a straight jog onto the nearest rows.
          const ddx = cx(i) - q.x;
          for (const sy of [-1, 1]) {
            const ty = q.y + sy * Math.abs(ddx);
            for (const jj of [Math.floor((ty - minY) / g), Math.ceil((ty - minY) / g)]) offer(li, [q, { x: cx(i), y: ty }], { x: cx(i), y: cy(jj) });
          }
        }
      }
      nearShapes = shapes;
    };
    /** Is cell c on layer li this net's copper (fixed copper on the grid, or a run-route of the net)? */
    const ownCell = (li: number, c: number) => {
      if (core[li]![c] === id) return true;
      const i = c % W;
      return ownRouteAt(li, { x: cx(i), y: cy((c - i) / W) }) >= 0;
    };
    /** The net's copper group around q, flooded on the grid (4-neighbour, layers joined where copper is on both). */
    const group = (q: Vec2): Set<number> => {
      const seen = new Set<number>();
      const stack: number[] = [];
      const c0 = cellOf(q);
      if (c0 < 0) return seen;
      for (let li = 0; li < L; li++) if (ownCell(li, c0)) (seen.add(li * N + c0), stack.push(li * N + c0));
      while (stack.length && seen.size < 60000) {
        const st = stack.pop()!;
        const li = Math.floor(st / N);
        const c = st - li * N;
        const i = c % W;
        const j = (c - i) / W;
        const next = (ns: number, lj: number, nc: number) => {
          if (!seen.has(ns) && ownCell(lj, nc)) (seen.add(ns), stack.push(ns));
        };
        if (i > 0) next(st - 1, li, c - 1);
        if (i < W - 1) next(st + 1, li, c + 1);
        if (j > 0) next(st - W, li, c - W);
        if (j < H - 1) next(st + W, li, c + W);
        for (let lj = 0; lj < L; lj++) if (lj !== li) next(lj * N + c, lj, c);
      }
      return seen;
    };
    const groupA = group(r.a);
    const cB = cellOf(r.b);
    if (cB >= 0 && [...Array(L).keys()].some((li) => groupA.has(li * N + cB))) return { ok: false, reason: '', joined: true };
    const groupB = group(r.b);
    const seeds: End = new Map();
    const goals: End = new Map();
    // A group cell is a start or end only if its centre is really on the net's copper (the grid marks
    // cells whose centre is on a pad's edge too) and the trace has room there.
    const onOwn = (st: number) => {
      const li = Math.floor(st / N);
      const c = st % N;
      const i = c % W;
      return usable(li, c) && ownLayersAt({ x: cx(i), y: cy((c - i) / W) }).includes(li);
    };
    for (const st of groupA) if (onOwn(st)) seeds.set(st, { cost: 0, pts: [] });
    for (const st of groupB) if (onOwn(st)) goals.set(st, { cost: 0, pts: [] });
    entries(r.a, seeds);
    entries(r.b, goals);
    if (!seeds.size || !goals.size) return { ok: false, reason: 'no room to leave the pad with the current clearances' };
    run++;
    const heap = new Heap();
    // Heuristic: octile distance to the box around the goal cells (never more than the true distance).
    let gi0 = Infinity, gi1 = -Infinity, gj0 = Infinity, gj1 = -Infinity;
    for (const st of goals.keys()) {
      const c = st % N;
      const i = c % W;
      const j = (c - i) / W;
      (gi0 = Math.min(gi0, i)), (gi1 = Math.max(gi1, i)), (gj0 = Math.min(gj0, j)), (gj1 = Math.max(gj1, j));
    }
    const hcost = (c: number) => {
      const i = c % W;
      const j = (c - i) / W;
      const dx = i < gi0 ? gi0 - i : i > gi1 ? i - gi1 : 0;
      const dy = j < gj0 ? gj0 - j : j > gj1 ? j - gj1 : 0;
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    /** Extra cost of entering a cell: run-routes in the way (soft only) and the cell's history. */
    const extra = (li: number, c: number) => (soft ? pres * crowd(li, c) : 0) + hist[li * N + c]!;
    /** Direction of the last step into state s (grid units), or null after a via or at a plain start. */
    const predDir = (s: number, li: number, i: number, j: number): [number, number] | null => {
      const p = from[s]!;
      if (p < 0) return seeds.get(s)?.dir ?? null;
      const pli = Math.floor(p / N);
      if (pli !== li) return null;
      const pc = p - pli * N;
      const pi = pc % W;
      return [i - pi, j - (pc - pi) / W];
    };
    /** A goal reached through an entry is accepted only if the turn onto the entry is not acute. */
    const goalOk = (s: number) => {
      const e = goals.get(s)!;
      if (!e.pts.length) return true;
      const li = Math.floor(s / N);
      const c = s - li * N;
      const i = c % W;
      const j = (c - i) / W;
      const pd = predDir(s, li, i, j);
      if (!pd) return true;
      const t = e.pts[e.pts.length - 1]!;
      return pd[0] * (t.x - cx(i)) + pd[1] * (t.y - cy(j)) >= -1e-9;
    };
    for (const [st, e] of seeds) {
      stamp[st] = run;
      cost[st] = e.cost + extra(Math.floor(st / N), st % N);
      from[st] = -1;
      heap.push(cost[st]! + hcost(st % N), st);
    }
    let found = -1;
    let expanded = 0;
    while (heap.size) {
      const s = heap.pop();
      if (closed[s] === run) continue;
      closed[s] = run;
      if (goals.has(s) && goalOk(s)) {
        found = s;
        break;
      }
      if (++expanded > 1.2e6) break;
      const li = Math.floor(s / N);
      const c = s - li * N;
      const base = cost[s]!;
      const i = c % W;
      const j = (c - i) / W;
      const pd = predDir(s, li, i, j);
      for (const [di, dj, w] of DIRS) {
        // Turns: straight is free, 45° costs little, 90° a little more, acute never.
        let turn = 0;
        if (pd) {
          const dot = pd[0] * di + pd[1] * dj;
          if (dot < 0) continue;
          if (dot === 0) turn = turn90;
          else if (pd[0] !== di || pd[1] !== dj) turn = 0.1;
        }
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const nc = jj * W + ii;
        if (!usable(li, nc)) continue;
        // No corner cutting past blocked cells on diagonals.
        if (di && dj && (!usable(li, j * W + ii) || !usable(li, jj * W + i))) continue;
        const ns = li * N + nc;
        const nCost = base + w + turn + extra(li, nc);
        if (stamp[ns] === run && cost[ns]! <= nCost) continue;
        stamp[ns] = run;
        cost[ns] = nCost;
        from[ns] = s;
        heap.push(nCost + hcost(nc), ns);
      }
      if (L > 1 && viaOk(c)) {
        for (let lj = 0; lj < L; lj++) {
          if (lj === li) continue;
          const ns = lj * N + c;
          let nCost = base + viaCost + hist[ns]!;
          if (soft) for (let lk = 0; lk < L; lk++) nCost += pres * dynHits(lk, { x: cx(i), y: cy(j) }, viaD / 2, 0);
          if (stamp[ns] === run && cost[ns]! <= nCost) continue;
          stamp[ns] = run;
          cost[ns] = nCost;
          from[ns] = s;
          heap.push(nCost + hcost(c), ns);
        }
      }
    }
    if (found < 0) return { ok: false, reason: 'no free path with the current clearances' };
    // Walk back.
    const cells: { li: number; c: number }[] = [];
    let first = found;
    for (let s = found; s >= 0; s = from[s]!) (cells.push({ li: Math.floor(s / N), c: s % N }), (first = s));
    cells.reverse();
    const pts = (k: number) => ({ x: cx(cells[k]!.c % W), y: cy(Math.floor(cells[k]!.c / W)) });
    const raw: { layer: number; pts: Vec2[] }[] = [];
    const vias: Vec2[] = [];
    let cur: { layer: number; pts: Vec2[] } = { layer: cells[0]!.li, pts: [...seeds.get(first)!.pts] };
    for (let k = 0; k < cells.length; k++) {
      const p = pts(k);
      if (cells[k]!.li !== cur.layer) {
        cur.pts.push(p);
        raw.push(cur);
        vias.push(p);
        cur = { layer: cells[k]!.li, pts: [p] };
      } else cur.pts.push(p);
    }
    cur.pts.push(...goals.get(found)!.pts.slice().reverse());
    raw.push(cur);
    const key = ++routeKey;
    const route: Route = { key, conn: -1, net: r.net, id, caps: [], segs: [], vias, length: 0, deps: new Set() };
    // ---- Clean-up (P8e): smooth the grid path into long 0° / 45° / 90° runs, then soften its corners
    // by style. Every new piece is checked against the real copper before it replaces the old ones.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const sg of raw) for (const q of sg.pts) (x0 = Math.min(x0, q.x)), (y0 = Math.min(y0, q.y)), (x1 = Math.max(x1, q.x)), (y1 = Math.max(y1, q.y));
    const m = reach + setback + 1;
    nearShapes = shapes.filter((sh) => sh.box.maxX >= x0 - m && sh.box.minX <= x1 + m && sh.box.maxY >= y0 - m && sh.box.minY <= y1 + m);
    const merged = (pts: Vec2[]) => {
      const simple: Vec2[] = [];
      for (const p of pts) {
        if (simple.length && Math.hypot(p.x - simple[simple.length - 1]!.x, p.y - simple[simple.length - 1]!.y) < 1e-6) continue;
        if (simple.length >= 2) {
          const a = simple[simple.length - 2]!;
          const b = simple[simple.length - 1]!;
          const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
          if (Math.abs(cross) < 1e-9 && (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0) {
            simple[simple.length - 1] = p;
            continue;
          }
        }
        simple.push(p);
      }
      return simple;
    };
    const clearPath = (li: number, pts: Vec2[]) => {
      for (let k = 0; k + 1 < pts.length; k++) if (Math.hypot(pts[k + 1]!.x - pts[k]!.x, pts[k + 1]!.y - pts[k]!.y) > 1e-9 && !pieceClear(li, pts[k]!, pts[k + 1]!)) return false;
      return true;
    };
    /** Octilinear ways from a to b: straight if a–b is at 0° / 45° / 90°, else a 45° piece and a straight one (either order). */
    const connectors = (a: Vec2, b: Vec2): Vec2[][] => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      if (ax < 1e-9 || ay < 1e-9 || Math.abs(ax - ay) < 1e-9) return [[]];
      const d = Math.min(ax, ay);
      const sx = Math.sign(dx);
      const sy = Math.sign(dy);
      return [[{ x: a.x + sx * d, y: a.y + sy * d }], [{ x: b.x - sx * d, y: b.y - sy * d }]];
    };
    const smooth = (li: number, P: Vec2[]): Vec2[] => {
      if (P.length < 4) return P;
      const out: Vec2[] = [P[0]!, P[1]!];
      let i = 1;
      const last = P.length - 1;
      while (i < last) {
        let done = false;
        // Keep the first piece (the pad entry) and the last one; join point i to the farthest point it can reach.
        for (let j = Math.min(last - 1, i + 60); j > i + 1 && !done; j--) {
          for (const mids of connectors(P[i]!, P[j]!)) {
            const path = [P[i]!, ...mids, P[j]!];
            const before = out[out.length - 2]!;
            if (dirDot(before, P[i]!, path[1]!) < -1e-9 || dirDot(path[path.length - 2]!, P[j]!, P[j + 1]!) < -1e-9) continue;
            if (mids.length && dirDot(P[i]!, mids[0]!, P[j]!) < -1e-9) continue;
            if (!clearPath(li, path)) continue;
            out.push(...mids, P[j]!);
            i = j;
            done = true;
            break;
          }
        }
        if (!done) {
          out.push(P[i + 1]!);
          i++;
        }
      }
      return merged(out);
    };
    /** Corner pass by style: pieces (straight, or an arc with a mid point) along P. */
    const soften = (li: number, P: Vec2[]): { a: Vec2; b: Vec2; mid?: Vec2 }[] => {
      const out: { a: Vec2; b: Vec2; mid?: Vec2 }[] = [];
      let cur = P[0]!;
      const n = P.length - 1;
      for (let k = 1; k < n; k++) {
        const A = P[k - 1]!;
        const V = P[k]!;
        const B = P[k + 1]!;
        const lin = Math.hypot(V.x - A.x, V.y - A.y);
        const lout = Math.hypot(B.x - V.x, B.y - V.y);
        const u = { x: (V.x - A.x) / lin, y: (V.y - A.y) / lin };
        const v = { x: (B.x - V.x) / lout, y: (B.y - V.y) / lout };
        const theta = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
        const deg = (theta * 180) / Math.PI;
        const want = style === 'arc' ? deg > 0.5 : style === '45' ? deg >= 89.5 : false;
        let doneHere = false;
        // A short Z jog (90°, a short piece, 90° back to the first direction) becomes one 45° piece that
        // replaces both corners, as a person would draw it; too short for two chamfers of its own.
        if (style !== '90' && deg >= 89.5 && k + 2 <= n && lout < 2 * setback) {
          const C = P[k + 2]!;
          const lc = Math.hypot(C.x - B.x, C.y - B.y);
          const w2 = { x: (C.x - B.x) / lc, y: (C.y - B.y) / lc };
          const half = lout / 2;
          if (Math.abs(w2.x - u.x) < 1e-6 && Math.abs(w2.y - u.y) < 1e-6 && Math.hypot(V.x - cur.x, V.y - cur.y) > half + 1e-6 && lc > half + 1e-6) {
            const P1 = { x: V.x - u.x * half, y: V.y - u.y * half };
            const P2 = { x: B.x + u.x * half, y: B.y + u.y * half };
            if (pieceClear(li, P1, P2)) {
              out.push({ a: cur, b: P1 }, { a: P1, b: P2 });
              cur = P2;
              k++;
              continue;
            }
          }
        }
        if (want) {
          // Room on each side: what is left of the incoming piece, and the outgoing piece: half of it when the
          // next corner will be cut too, all of it when it will not (or it runs into the end point).
          const roomIn = Math.hypot(V.x - cur.x, V.y - cur.y) - 1e-6;
          let nextCut = false;
          if (k + 1 < n) {
            const C = P[k + 2]!;
            const lc = Math.hypot(C.x - B.x, C.y - B.y);
            const dn = (Math.acos(Math.max(-1, Math.min(1, (v.x * (C.x - B.x) + v.y * (C.y - B.y)) / lc))) * 180) / Math.PI;
            nextCut = style === 'arc' ? dn > 0.5 : dn >= 89.5;
          }
          const roomOut = (nextCut ? lout / 2 : lout) - 1e-6;
          let sb = Math.min(setback, roomIn, roomOut);
          // A chamfer shorter than this is pointless; an arc may be tiny (a grid offset next to a pad).
          const minSb = style === 'arc' ? 0.002 : Math.min(0.05, width / 4);
          for (let tries = 0; tries < 3 && sb > minSb && !doneHere; tries++, sb /= 2) {
            const P1 = { x: V.x - u.x * sb, y: V.y - u.y * sb };
            const P2 = { x: V.x + v.x * sb, y: V.y + v.y * sb };
            if (style === '45') {
              if (!pieceClear(li, P1, P2)) continue;
              if (Math.hypot(P1.x - cur.x, P1.y - cur.y) > 1e-6) out.push({ a: cur, b: P1 });
              out.push({ a: P1, b: P2 });
              cur = P2;
              doneHere = true;
            } else {
              const R = sb / Math.tan(theta / 2);
              const bx = v.x - u.x;
              const by = v.y - u.y;
              const bl = Math.hypot(bx, by);
              const vc = R / Math.cos(theta / 2);
              const mid = { x: V.x + (bx / bl) * (vc - R), y: V.y + (by / bl) * (vc - R) };
              if (!clearPath(li, arcPoints(P1, mid, P2))) continue;
              if (Math.hypot(P1.x - cur.x, P1.y - cur.y) > 1e-6) out.push({ a: cur, b: P1 });
              out.push({ a: P1, b: P2, mid });
              cur = P2;
              doneHere = true;
            }
          }
        }
        if (!doneHere) {
          out.push({ a: cur, b: V });
          cur = V;
        }
      }
      if (Math.hypot(P[n]!.x - cur.x, P[n]!.y - cur.y) > 1e-9) out.push({ a: cur, b: P[n]! });
      return out;
    };
    /**
     * Drop a short first or last piece whose inner end is already on the net's own copper (typically the
     * jog from a grid cell inside a large pad to the pad's centre): the trace still ends on its copper,
     * and no needless corner is left inside the pad.
     */
    const trimEnds = (li: number, P: Vec2[], first: boolean, last: boolean) => {
      const short = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y) < Math.max(setback, width);
      if (first && P.length > 2 && short(P[0]!, P[1]!) && ownLayersAt(P[1]!).includes(li)) P = P.slice(1);
      if (last && P.length > 2 && short(P[P.length - 2]!, P[P.length - 1]!) && ownLayersAt(P[P.length - 2]!).includes(li)) P = P.slice(0, -1);
      return P;
    };
    for (const [ri, sgm] of raw.entries()) {
      const pieces = soften(sgm.layer, smooth(sgm.layer, trimEnds(sgm.layer, merged(sgm.pts), ri === 0, ri === raw.length - 1)));
      for (const pc of pieces) {
        const w = segWidth(pc.a, pc.b);
        if (pc.mid) {
          const poly = arcPoints(pc.a, pc.mid, pc.b);
          for (let k = 0; k + 1 < poly.length; k++) {
            route.length += Math.hypot(poly[k + 1]!.x - poly[k]!.x, poly[k + 1]!.y - poly[k]!.y);
            route.caps.push({ li: sgm.layer, a: poly[k]!, b: poly[k + 1]!, r: w / 2, id, cl: cn, route: key });
          }
          route.segs.push({ li: sgm.layer, a: pc.a, b: pc.b, w, mid: pc.mid });
        } else {
          route.length += Math.hypot(pc.b.x - pc.a.x, pc.b.y - pc.a.y);
          route.segs.push({ li: sgm.layer, a: pc.a, b: pc.b, w });
          route.caps.push({ li: sgm.layer, a: pc.a, b: pc.b, r: w / 2, id, cl: cn, route: key });
        }
      }
    }
    nearShapes = shapes;
    for (const v of vias) for (let li = 0; li < L; li++) route.caps.push({ li, a: v, b: v, r: viaD / 2, id, cl: cn, route: key });
    // Run-routes of this net that the new route starts or ends on: it depends on them.
    const ends = [route.segs[0]?.a, route.segs[route.segs.length - 1]?.b];
    for (const [k, q] of ends.entries()) {
      if (!q) continue;
      const li = route.segs[k === 0 ? 0 : route.segs.length - 1]!.li;
      for (const cp of capsNear(li, q)) if (cp.id === id && distToSegment(q, cp.a, cp.b) <= cp.r) route.deps.add(cp.route);
    }
    // Exact conflicts with run-routes of other nets: the routes to rip up for this one.
    const victims = new Set<number>();
    const contested: number[] = [];
    if (soft) {
      for (const cp of route.caps)
        for (const other of capsAlong(cp.li, cp.a, cp.b))
          if (other.id !== id && segSegDist(cp.a, cp.b, other.a, other.b) - other.r - cp.r < Math.max(cn, other.cl) - 1e-6) victims.add(other.route);
      for (const cl of cells) if (crowd(cl.li, cl.c) > 0) contested.push(cl.li * N + cl.c);
    }
    return { ok: true, route, victims, contested };
  };

  // ---- Negotiated rip-up and retry (P8d; after McMurchie and Ebeling, "PathFinder", 1995). Each round
  // routes the waiting connections in free room; one that cannot get through is routed again with the
  // run-routes of other nets allowed in its way at a price (`pres`, rising each round) plus a history cost
  // on contested cells (rising each time a cell is fought over). The routes in its way are ripped up and
  // wait for the next round; routes that end on a ripped route are ripped too. Every committed route is
  // legal, so whatever the round limit or the time limit leaves is a legal board.
  const hist = new Float32Array(N * L);
  const routeOf = new Map<number, number>(); // connection → route key
  const joined = new Set<number>();
  const failReason = new Map<number, string>();
  const commit = (ci: number, route: Route) => {
    route.conn = ci;
    routes.set(route.key, route);
    routeOf.set(ci, route.key);
    for (const cp of route.caps) fileCap(cp, true);
  };
  /** Rip up a route and everything resting on it; returns the connections that must be routed again. */
  const rip = (key: number, out: Set<number>) => {
    const route = routes.get(key);
    if (!route) return;
    routes.delete(key);
    routeOf.delete(route.conn);
    for (const cp of route.caps) fileCap(cp, false);
    out.add(route.conn);
    for (const other of [...routes.values()]) if (other.deps.has(key)) rip(other.key, out);
    // Connections counted as joined through this net's copper may be open now.
    for (const ci of [...joined]) if (order[ci]!.net === route.net) (joined.delete(ci), out.add(ci));
  };
  let pending = order.map((_, i) => i);
  let pres = 2;
  let timedOut = false;
  for (let round = 0; round < maxRounds && pending.length && !timedOut; round++) {
    const again = new Set<number>();
    for (const ci of pending) {
      if (routeOf.has(ci) || joined.has(ci)) continue;
      if (performance.now() - t0 > limit) {
        timedOut = true;
        again.add(ci);
        continue;
      }
      const r = order[ci]!;
      failReason.delete(ci);
      const hard = routeConn(r, Infinity, hist);
      if (hard.ok) {
        commit(ci, hard.route);
        continue;
      }
      if (hard.joined) {
        joined.add(ci);
        continue;
      }
      if (hard.reason !== 'no free path with the current clearances' && hard.reason !== 'no room to leave the pad with the current clearances') {
        failReason.set(ci, hard.reason);
        continue;
      }
      const res = round + 1 < maxRounds ? routeConn(r, pres, hist) : hard;
      if (!res.ok) {
        // Blocked by fixed copper, not by other routes of this run: no rip-up can help.
        failReason.set(ci, res.ok === false && !res.joined ? res.reason : hard.reason);
        continue;
      }
      for (const s of res.contested) hist[s] = hist[s]! + 1;
      for (const v of res.victims) rip(v, again);
      commit(ci, res.route);
    }
    pending = [...again].sort((a, b) => a - b);
    pres *= 1.6;
  }
  for (const ci of pending) if (!routeOf.has(ci) && !joined.has(ci)) failReason.set(ci, timedOut ? 'time limit' : 'congestion: could not be fitted in after rip-up and retry');

  // ---- Emit, in the order the connections were planned.
  const nextIndex = new Map<string, number>();
  for (const [ci, r] of order.entries()) {
    if (joined.has(ci)) {
      report.routed.push({ net: r.net, from: r.a, to: r.b, length: 0, vias: 0 });
      continue;
    }
    const key = routeOf.get(ci);
    const route = key === undefined ? undefined : routes.get(key);
    if (!route) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: failReason.get(ci) ?? 'no free path with the current clearances' });
      continue;
    }
    const node = netNode.get(r.net);
    if (!node) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'net object missing (run update_pcb)' });
      continue;
    }
    let idx = nextIndex.get(node.uid) ?? node.children.length;
    const width = netRule(r.net, 'traceWidth', 0.25);
    for (const s of route.segs) {
      const rules: RuleDecl[] = [{ name: 'start', value: s.a }, { name: 'end', value: s.b }, { name: 'layer', value: layers[s.li]! }];
      if (s.mid) rules.push({ name: 'mid', value: s.mid });
      if (s.w < width) rules.push({ name: 'traceWidth', value: s.w });
      ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: { autorouted: true }, rules, parent: node.uid, children: [] }] } });
    }
    for (const v of route.vias) ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', props: { autorouted: true }, rules: [{ name: 'position', value: v }, { name: 'layers', value: [...copper] }], parent: node.uid, children: [] }] } });
    nextIndex.set(node.uid, idx);
    report.routed.push({ net: r.net, from: r.a, to: r.b, length: Math.round(route.length * 1000) / 1000, vias: route.vias.length });
  }
  report.ms = Math.round(performance.now() - t0);
  return { ops, report };
}

/** Does segment a–b touch the axis-aligned box (Liang–Barsky clipping)? */
function segmentHitsBox(a: Vec2, b: Vec2, box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a.x - box.minX) && clip(dx, box.maxX - a.x) && clip(-dy, a.y - box.minY) && clip(dy, box.maxY - a.y);
}

/** Shortest distance between segments a–b and c–d. */
function segSegDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(a, c, d), distToSegment(b, c, d), distToSegment(c, a, b), distToSegment(d, a, b));
}

/** Dot product of the directions a→b and b→c (unit vectors): below 0 means an acute corner at b. */
function dirDot(a: Vec2, b: Vec2, c: Vec2): number {
  const l1 = Math.hypot(b.x - a.x, b.y - a.y);
  const l2 = Math.hypot(c.x - b.x, c.y - b.y);
  if (l1 < 1e-9 || l2 < 1e-9) return 1;
  return ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2);
}
