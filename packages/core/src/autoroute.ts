/**
 * Grid autorouter: routes the ratsnest connections one by one with A* over a grid per
 * copper layer (8 directions → 45° traces) with through vias, keeping each net's
 * clearance from other copper. Our own straightforward maze router: no rip-up and retry,
 * no push-and-shove. Connections it cannot complete are reported, never forced.
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
import { distToSegment, pointInPolygon } from './geom.ts';

export interface AutorouteOptions {
  /** Only these nets (default: every net with unrouted connections). */
  nets?: string[];
  /** Grid pitch in mm (default: picked from board size, 0.1–0.25). */
  grid?: number;
  /** Extra cost of a via, in grid steps (default 12). */
  viaCost?: number;
  /** Layers to route on (default: all copper layers). */
  layers?: string[];
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
  const outline = boardOutline(doc, engine).loops[0];
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
  const edgeMargin = 0.3;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = { x: cx(i), y: cy(j) };
      let ok = pointInPolygon(p, outline);
      if (ok) for (let k = 0; k < outline.length; k++) if (distToSegment(p, outline[k]!, outline[(k + 1) % outline.length]!) < edgeMargin) ok = false;
      if (!ok) for (const o of core) o[j * W + i] = -1;
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
  const ops: Op[] = [];
  const cost = new Float32Array(N * L);
  const from = new Int32Array(N * L);
  const stamp = new Int32Array(N * L);
  let run = 0;
  // Per-connection memo of the cell tests (value = 2 * run + result; stale runs read as unknown).
  const usableMemo = new Int32Array(N * L);
  const viaMemo = new Int32Array(N);
  let conn = 0;
  /** Copper laid by this run (for the exact checks of pad entries): capsules per layer, with owner and clearance. */
  const added: { li: number; a: Vec2; b: Vec2; r: number; id: number; cl: number }[] = [];
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;

  for (const r of order) {
    if (performance.now() - t0 > limit) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'time limit' });
      continue;
    }
    const id = netId(r.net);
    const width = netRule(r.net, 'traceWidth', 0.25);
    const viaD = netRule(r.net, 'viaDiameter', 0.6);
    const cn = netClear(r.net);
    const viaR = Math.ceil((viaD / 2 + cn - width / 2) / g);
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
    if (necks.some((n) => n.w < minTrace)) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'pad is narrower than the minimum trace width' });
      continue;
    }
    const neckAt = (x: number, y: number) => {
      let w = width;
      for (const n of necks) if (x >= n.box.minX && x <= n.box.maxX && y >= n.box.minY && y <= n.box.maxY) w = Math.min(w, n.w);
      return w;
    };
    // The step between two cell centres can pass closer to a corner of copper than either centre;
    // this margin covers it for a half-width + clearance of `R` (worst case: a point obstacle).
    const halfStep = g * Math.SQRT1_2;
    const slackFor = (R: number) => R - Math.sqrt(Math.max(0, R * R - halfStep * halfStep));
    /** Room at cell `c` for copper of this net with half-width `half`: nearest foreign copper far enough. */
    const clear = (li: number, c: number, half: number, slack: number) => {
      const f = field[li]!;
      let m = Math.min(f.zd[c]! - cn, f.ze[c]!);
      if (f.o1[c] !== id) m = Math.min(m, f.d1[c]! - cn, f.e1[c]!);
      if (f.o2[c] !== id) m = Math.min(m, f.d2[c]! - cn, f.e2[c]!);
      return m >= half + slack - 1e-6;
    };
    const halfFull = width / 2;
    const slackFull = slackFor(halfFull + cn);
    conn++;
    /** Every cell on the path must have room for the trace, necked down near narrow end pads. */
    const usable = (li: number, c: number) => {
      const m = usableMemo[li * N + c]!;
      if (m >> 1 === conn) return (m & 1) === 1;
      const ok = usableRaw(li, c);
      usableMemo[li * N + c] = (conn << 1) | (ok ? 1 : 0);
      return ok;
    };
    const usableRaw = (li: number, c: number) => {
      const k = core[li]![c]!;
      if (k !== 0 && k !== id) return false;
      if (!necks.length) return clear(li, c, halfFull, slackFull);
      const i = c % W;
      const w = neckAt(cx(i), cy((c - i) / W));
      return w === width ? clear(li, c, halfFull, slackFull) : clear(li, c, w / 2, slackFor(w / 2 + cn));
    };
    const viaOk = (c: number) => {
      const m = viaMemo[c]!;
      if (m >> 1 === conn) return (m & 1) === 1;
      const ok = viaOkRaw(c);
      viaMemo[c] = (conn << 1) | (ok ? 1 : 0);
      return ok;
    };
    const viaOkRaw = (c: number) => {
      for (let li = 0; li < L; li++) {
        const k = core[li]![c]!;
        if ((k !== 0 && k !== id) || !clear(li, c, viaD / 2, 0)) return false;
      }
      // A via never sits on or touches a pad, the net's own included.
      const i = c % W;
      const j = (c - i) / W;
      for (let dj = -viaR; dj <= viaR; dj++)
        for (let di = -viaR; di <= viaR; di++) {
          if (di * di + dj * dj > viaR * viaR) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H || padMask[jj * W + ii]) return false;
        }
      return true;
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
    const cellOf = (q: Vec2) => {
      const i = toI(q.x);
      const j = toJ(q.y);
      return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i;
    };
    /**
     * Layers where this net's copper covers point q, by the same tests the connectivity check uses
     * (inside a pad or pour, on a trace or via): a trace may only start or end where this holds.
     */
    const ownShapes = shapes.filter((sh) => sh.net === r.net);
    const ownLayersAt = (q: Vec2) => {
      const out = new Set<number>();
      for (const sh of ownShapes) {
        const li = layerIdx.get(sh.layer);
        if (li === undefined || out.has(li) || q.x < sh.box.minX - 1e-6 || q.x > sh.box.maxX + 1e-6 || q.y < sh.box.minY - 1e-6 || q.y > sh.box.maxY + 1e-6) continue;
        const on = sh.kind === 'pad' || sh.kind === 'fill' ? sh.areas.some((ar) => inArea(q, ar)) : sh.edges.some(([a, b, rr]) => distToSegment(q, a, b) <= rr);
        if (on) out.add(li);
      }
      for (const e of added) if (e.id === id && distToSegment(q, e.a, e.b) <= e.r + 1e-6) out.add(e.li);
      return [...out];
    };
    /** Half-extent of the net's pad under q (how far an entry may run before it is out of the pad row). */
    const padExtentAt = (q: Vec2) => {
      let ext = 0;
      for (const sh of shapes) if (sh.kind === 'pad' && sh.net === r.net && sh.areas[0] && inArea(q, sh.areas[0])) ext = Math.max(ext, (sh.box.maxX - sh.box.minX) / 2, (sh.box.maxY - sh.box.minY) / 2);
      return ext;
    };
    /** Exact check of a short piece of trace against foreign copper on layer li. */
    const pieceClear = (li: number, a: Vec2, b: Vec2) => {
      const half = segWidth(a, b) / 2;
      const ca = cellOf(a);
      const cb = cellOf(b);
      if (ca < 0 || cb < 0 || core[li]![ca] === -1 || core[li]![cb] === -1) return false;
      for (const sh of nearShapes) {
        if (sh.layer !== layers[li] || sh.net === r.net || sh.kind === 'fill') continue;
        const need = half + Math.max(cn, clearanceFor(sh.keepOut, 'trace')) - 1e-6;
        if (sh.box.minX - need > Math.max(a.x, b.x) || sh.box.maxX + need < Math.min(a.x, b.x) || sh.box.minY - need > Math.max(a.y, b.y) || sh.box.maxY + need < Math.min(a.y, b.y)) continue;
        for (const [e0, e1, er] of sh.edges) if (segSegDist(a, b, e0, e1) - er < need) return false;
        if (sh.kind === 'pad' && sh.areas[0] && (inArea(a, sh.areas[0]) || inArea(b, sh.areas[0]))) return false;
      }
      for (const e of added) if (e.li === li && e.id !== id && segSegDist(a, b, e.a, e.b) - e.r < half + Math.max(cn, e.cl) - 1e-6) return false;
      return true;
    };
    let nearShapes = shapes;
    type End = Map<number, { cost: number; pts: Vec2[] }>;
    /** Entry states at end point q: grid state → cost (in cells) and the exact points from q up to (not including) the cell. */
    const entries = (q: Vec2, out: End) => {
      const ls = ownLayersAt(q);
      const rho = padExtentAt(q) + width + cn + 3 * g;
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
        const cost = len / g + (pts.length > 1 ? 0.1 : 0);
        const cur = out.get(st);
        if (!cur || cur.cost > cost) out.set(st, { cost, pts: pts.filter((x, k) => k === 0 || Math.hypot(x.x - pts[k - 1]!.x, x.y - pts[k - 1]!.y) > 1e-9) });
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
    /** The net's copper group around q, flooded on the grid (4-neighbour, layers joined where copper is on both). */
    const group = (q: Vec2): Set<number> => {
      const seen = new Set<number>();
      const stack: number[] = [];
      const c0 = cellOf(q);
      if (c0 < 0) return seen;
      for (let li = 0; li < L; li++) if (core[li]![c0] === id) (seen.add(li * N + c0), stack.push(li * N + c0));
      while (stack.length && seen.size < 60000) {
        const st = stack.pop()!;
        const li = Math.floor(st / N);
        const c = st - li * N;
        const i = c % W;
        const j = (c - i) / W;
        const next = (ns: number) => {
          if (!seen.has(ns)) (seen.add(ns), stack.push(ns));
        };
        if (i > 0 && core[li]![c - 1] === id) next(st - 1);
        if (i < W - 1 && core[li]![c + 1] === id) next(st + 1);
        if (j > 0 && core[li]![c - W] === id) next(st - W);
        if (j < H - 1 && core[li]![c + W] === id) next(st + W);
        for (let lj = 0; lj < L; lj++) if (lj !== li && core[lj]![c] === id) next(lj * N + c);
      }
      return seen;
    };
    const groupA = group(r.a);
    const cB = cellOf(r.b);
    if (cB >= 0 && [...Array(L).keys()].some((li) => groupA.has(li * N + cB))) {
      // Already joined by copper laid earlier in this run.
      report.routed.push({ net: r.net, from: r.a, to: r.b, length: 0, vias: 0 });
      continue;
    }
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
    if (!seeds.size || !goals.size) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'no room to leave the pad with the current clearances' });
      continue;
    }
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
    for (const [st, e] of seeds) {
      stamp[st] = run;
      cost[st] = e.cost;
      from[st] = -1;
      heap.push(e.cost + hcost(st % N), st);
    }
    let found = -1;
    let expanded = 0;
    while (heap.size) {
      const s = heap.pop();
      if (goals.has(s)) {
        found = s;
        break;
      }
      if (++expanded > 1.2e6) break;
      const li = Math.floor(s / N);
      const c = s - li * N;
      const base = cost[s]!;
      const i = c % W;
      const j = (c - i) / W;
      for (const [di, dj, w] of DIRS) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const nc = jj * W + ii;
        if (!usable(li, nc)) continue;
        // No corner cutting past blocked cells on diagonals.
        if (di && dj && (!usable(li, j * W + ii) || !usable(li, jj * W + i))) continue;
        const ns = li * N + nc;
        const turn = from[s]! >= 0 && from[s]! !== s - (dj * W + di) ? 0.1 : 0;
        const nCost = base + w + turn;
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
          const nCost = base + viaCost;
          if (stamp[ns] === run && cost[ns]! <= nCost) continue;
          stamp[ns] = run;
          cost[ns] = nCost;
          from[ns] = s;
          heap.push(nCost + hcost(c), ns);
        }
      }
    }
    if (found < 0) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'no free path with the current clearances' });
      continue;
    }
    // Walk back.
    const cells: { li: number; c: number }[] = [];
    let first = found;
    for (let s = found; s >= 0; s = from[s]!) (cells.push({ li: Math.floor(s / N), c: s % N }), (first = s));
    cells.reverse();
    const pts = (k: number) => ({ x: cx(cells[k]!.c % W), y: cy(Math.floor(cells[k]!.c / W)) });
    const segs: { layer: number; pts: Vec2[] }[] = [];
    const vias: Vec2[] = [];
    let cur: { layer: number; pts: Vec2[] } = { layer: cells[0]!.li, pts: [...seeds.get(first)!.pts] };
    for (let k = 0; k < cells.length; k++) {
      const p = pts(k);
      if (cells[k]!.li !== cur.layer) {
        cur.pts.push(p);
        segs.push(cur);
        vias.push(p);
        cur = { layer: cells[k]!.li, pts: [p] };
      } else cur.pts.push(p);
    }
    cur.pts.push(...goals.get(found)!.pts.slice().reverse());
    segs.push(cur);

    const node = netNode.get(r.net);
    if (!node) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'net object missing (run update_pcb)' });
      continue;
    }
    let length = 0;
    let idx = node.children.length + ops.length;
    segs.forEach((sgm) => {
      // Merge collinear runs.
      const simple: Vec2[] = [];
      for (const p of sgm.pts) {
        if (simple.length && Math.hypot(p.x - simple[simple.length - 1]!.x, p.y - simple[simple.length - 1]!.y) < 1e-6) continue;
        if (simple.length >= 2) {
          const a = simple[simple.length - 2]!;
          const b = simple[simple.length - 1]!;
          const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
          if (Math.abs(cross) < 1e-9) {
            simple[simple.length - 1] = p;
            continue;
          }
        }
        simple.push(p);
      }
      for (let k = 0; k + 1 < simple.length; k++) {
        const a = simple[k]!;
        const b = simple[k + 1]!;
        length += Math.hypot(b.x - a.x, b.y - a.y);
        const w = segWidth(a, b);
        const rules: RuleDecl[] = [{ name: 'start', value: a }, { name: 'end', value: b }, { name: 'layer', value: layers[sgm.layer]! }];
        if (w < width) rules.push({ name: 'traceWidth', value: w });
        ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: { autorouted: true }, rules, parent: node.uid, children: [] }] } });
        paint(sgm.layer, id, { edges: [[a, b, w / 2]], areas: [] }, cn);
        added.push({ li: sgm.layer, a, b, r: w / 2, id, cl: cn });
      }
    });
    for (const v of vias) {
      ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', props: { autorouted: true }, rules: [{ name: 'position', value: v }, { name: 'layers', value: [...copper] }], parent: node.uid, children: [] }] } });
      for (let li = 0; li < L; li++) {
        paint(li, id, { edges: [[v, v, viaD / 2]], areas: [] }, cn);
        added.push({ li, a: v, b: v, r: viaD / 2, id, cl: cn });
      }
    }
    report.routed.push({ net: r.net, from: r.a, to: r.b, length: Math.round(length * 1000) / 1000, vias: vias.length });
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
