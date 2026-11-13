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
import { arcPoints, distToSegment, pointInPolygon, route45 } from './geom.ts';
import { netSignals } from './signal.ts';
import { shoveChains, type ShovePusher, type ShoveSeg } from './shove.ts';

export interface AutorouteOptions {
  /** Only these nets (default: every net with unrouted connections). */
  nets?: string[];
  /** Grid pitch in mm (default: picked from board size, 0.1–0.25). */
  grid?: number;
  /** Extra cost of a via, in grid steps, for every net (default: the net's `viaCost` rule, else 4 mm of trace). */
  viaCost?: number;
  /**
   * Preferred direction per copper layer (P8f), overriding the `routeDirection` rule: e.g.
   * `{ 'F.Cu': 'horizontal', 'B.Cu': 'vertical' }`. Layers not named keep the rule's pattern.
   */
  directions?: Record<string, 'horizontal' | 'vertical' | 'any'>;
  /** Cost factor of a straight step against a layer's direction (default 1.5; 1 = no preference). A 45° step costs half as much extra. */
  directionCost?: number;
  /** Cost per grid step of running right next to other nets' copper, fading out one trace pitch away (default 0.3; 0 = off). */
  proximityCost?: number;
  /** Order of connections: `short` (default: shortest first) or `difficulty` (fine-pitch pads first, then long connections). The `autoPlacePriority` rule comes before either. */
  order?: 'difficulty' | 'short';
  /**
   * Cost per grid step of running over a gap in the reference plane (P8f): where no pour lies on a
   * neighbouring copper layer, or a trace laid by this run cuts it (default 0 = off: on the benchmark board it
   * cost length and vias without keeping more copper over a plane). The net's `planeGapCost` rule takes
   * precedence, for nets that need a solid return path.
   */
  planeGapCost?: number;
  /** Fan out dense parts first (P8f; default true): straight stubs out of fine-pitch pad rows, where routing starts. */
  fanout?: boolean;
  /** Layers to route on (default: all copper layers). */
  layers?: string[];
  /**
   * Called now and then while routing (P8g, for a progress line): the rip-up round, the connections that
   * hold a route and how many there are.
   */
  onProgress?: (p: { round: number; routed: number; total: number }) => void;
  /** Try to shove the routes in the way of a connection that is still open after rip-up (P9; default true). */
  shove?: boolean;
  /** Route differential pairs (nets with a `diffGap`) together as coupled traces (P10; default true). */
  pairs?: boolean;
  /** Corner style for every net, overriding the `cornerStyle` rule (P8e). */
  cornerStyle?: '45' | 'arc' | '90';
  /** Rounds of rip-up and retry (default 30; 1 = route once, no rip-up). */
  rounds?: number;
  /** Stop after this many milliseconds (default 30 s); connections not tried are reported as `time limit`. */
  timeLimitMs?: number;
}

export interface AutorouteReport {
  /** `uids`: the trace and via objects the plan adds for this connection (P8g: to take it out again). */
  routed: { net: string; from: Vec2; to: Vec2; length: number; vias: number; uids?: string[] }[];
  failed: { net: string; from: Vec2; to: Vec2; reason: string }[];
  grid: number;
  ms: number;
  /** Pads fanned out before routing (P8f). */
  fanouts?: number;
  /** Connections that belong to a bundle (P8f): their pads neighbour another connection's at both ends. */
  bundled?: number;
  /** Connections routed by shoving the routes in their way aside instead of ripping them up (P9). */
  shoved?: number;
  /** Differential pairs routed together (P10). */
  pairs?: number;
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
  const pairSignals = netSignals(doc);
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

  // Clearance between nets of particular signal classes (P16, rule `classClearance`, e.g. switching nets
  // kept away from analog and sensitive ones): the larger of the two nets' values, 0 when neither asks.
  // It applies between traces and vias, not to pads (two neighbouring pins of a header could never be
  // routed otherwise), and is checked against the routes of this run and when a piece is placed; the
  // distance field (copper that was on the board before) keeps the ordinary clearance.
  const normCls = (s: unknown) => (typeof s === 'string' ? s.replace(/-/g, '').toLowerCase() : '');
  const clsOf = new Map<number, string>();
  const ccOf = new Map<number, KeepOut>();
  for (const n of netNode.values()) {
    const id = netId(n.name);
    if (n.props.signal) clsOf.set(id, normCls(n.props.signal));
    const k = engine.get(n.uid, 'classClearance')?.value as KeepOut | undefined;
    if (k && Object.keys(k.byType ?? {}).length) ccOf.set(id, { byType: Object.fromEntries(Object.entries(k.byType).map(([t, v]) => [normCls(t), v])) });
  }
  // A differential pair's clearance to other nets (P10, rule `diffPairClearance`, 3 W by default from
  // classify_nets): like classClearance, between traces and vias of this run, never to its partner.
  const dpcOf = new Map<number, number>();
  const partnerOf = new Map<number, number>();
  for (const n of netNode.values()) {
    const v = engine.get(n.uid, 'diffPairClearance')?.value;
    if (typeof v === 'number' && v > 0) dpcOf.set(netId(n.name), v);
    const w = n.props.pairWith;
    if (typeof w === 'string' && netNode.has(w)) partnerOf.set(netId(n.name), netId(w)), partnerOf.set(netId(w), netId(n.name));
  }
  for (const x of pairSignals) if (x.pair && netNode.has(x.pair) && !partnerOf.has(netId(x.net))) partnerOf.set(netId(x.net), netId(x.pair));
  const pairMemo = new Map<number, number>();
  let maxPairCl = 0;
  for (const k of ccOf.values()) for (const v of Object.values(k.byType)) maxPairCl = Math.max(maxPairCl, v);
  for (const v of dpcOf.values()) maxPairCl = Math.max(maxPairCl, v);
  const pairCl = (a: number, b: number): number => {
    if ((!ccOf.size && !dpcOf.size) || a === b || a < 0 || b < 0) return 0;
    const key = a * 1048576 + b;
    let v = pairMemo.get(key);
    if (v === undefined) {
      const ca = clsOf.get(a);
      const cb = clsOf.get(b);
      v = Math.max((cb && ccOf.get(a)?.byType[cb]) || 0, (ca && ccOf.get(b)?.byType[ca]) || 0);
      if (partnerOf.get(a) !== b) v = Math.max(v, dpcOf.get(a) ?? 0, dpcOf.get(b) ?? 0);
      pairMemo.set(key, v);
    }
    return v;
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

  // ---- Fanout (P8f). Pads of a dense part (8 or more SMD pads on a layer, centres closer than 0.85 mm)
  // escape first: a straight stub along the pad's long axis, out of the pad row, as a person would draw it.
  // The stubs are laid as fixed copper of their nets before routing, and a connection at such a pad starts
  // (or ends) at the stub's outer end, never from the side of the pad. Pads whose connections all stay at
  // the part (a link between two of its pins) and stubs without room are left out. Vias stay outside pads.
  interface Fan { pad: (typeof shapes)[number]; stub: (typeof shapes)[number]; li: number; a: Vec2; e: Vec2; half: number; out: [number, number]; off: boolean }
  const fans: Fan[] = [];
  if (opts.fanout !== false) {
    const byPart = new Map<string, typeof shapes>();
    for (const s of shapes) {
      if (s.kind !== 'pad' || s.hole || !s.areas[0] || !layers.includes(s.layer)) continue;
      const part = doc.nodes.get(s.uid)?.parent;
      if (!part) continue;
      const k = `${part}|${s.layer}`;
      (byPart.get(k) ?? byPart.set(k, []).get(k)!).push(s);
    }
    const mid = (s: (typeof shapes)[number]) => ({ x: (s.box.minX + s.box.maxX) / 2, y: (s.box.minY + s.box.maxY) / 2 });
    for (const pads of byPart.values()) {
      if (pads.length < 8) continue;
      const ms = pads.map(mid);
      let pitch = Infinity;
      for (let x = 0; x < ms.length; x++) for (let y = x + 1; y < ms.length; y++) pitch = Math.min(pitch, Math.hypot(ms[x]!.x - ms[y]!.x, ms[x]!.y - ms[y]!.y));
      if (pitch >= 0.85) continue;
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
      for (const s of pads) (px0 = Math.min(px0, s.box.minX)), (py0 = Math.min(py0, s.box.minY)), (px1 = Math.max(px1, s.box.maxX)), (py1 = Math.max(py1, s.box.maxY));
      const pc = { x: (px0 + px1) / 2, y: (py0 + py1) / 2 };
      const inPart = (q: Vec2) => q.x >= px0 - 0.5 && q.x <= px1 + 0.5 && q.y >= py0 - 0.5 && q.y <= py1 + 0.5;
      for (const [k, pad] of pads.entries()) {
        if (!pad.net || !routedNets.includes(pad.net)) continue;
        const onPad = (q: Vec2) => q.x >= pad.box.minX - 1e-6 && q.x <= pad.box.maxX + 1e-6 && q.y >= pad.box.minY - 1e-6 && q.y <= pad.box.maxY + 1e-6;
        const mine = rats.filter((r) => r.net === pad.net && (onPad(r.a) || onPad(r.b)));
        if (!mine.length || mine.every((r) => inPart(onPad(r.a) ? r.b : r.a))) continue;
        const bw = pad.box.maxX - pad.box.minX;
        const bh = pad.box.maxY - pad.box.minY;
        if (Math.max(bw, bh) < 1.4 * Math.min(bw, bh)) continue; // square pads (BGA balls, thermal pads): no straight escape
        const a = ms[k]!;
        const alongX = bw > bh;
        const sgn = Math.sign(alongX ? a.x - pc.x : a.y - pc.y);
        if (!sgn) continue;
        const w = Math.min(netRule(pad.net, 'traceWidth', 0.25), Math.min(bw, bh));
        const cn = netClear(pad.net);
        const ext = Math.max(0.4, 1.5 * (w + cn));
        // The outer end lies on a grid line across the escape, so the router picks it up cleanly.
        const edgeAt = (alongX ? a.x + (sgn * bw) / 2 : a.y + (sgn * bh) / 2) + sgn * ext;
        const base = alongX ? minX : minY;
        const snapped = base + (sgn > 0 ? Math.ceil((edgeAt - base) / g - 1e-9) : Math.floor((edgeAt - base) / g + 1e-9)) * g;
        const e = alongX ? { x: snapped, y: a.y } : { x: a.x, y: snapped };
        const half = w / 2;
        const edgeCl = netRule(pad.net, 'boardEdgeClearance', 0.3);
        let ok = pointInPolygon(e, outline) && board.segments.every(([p, q]) => segSegDist(a, e, p, q) >= half + edgeCl - 1e-6);
        for (const sh of [...shapes, ...fans.map((f) => f.stub)]) {
          if (!ok) break;
          if (sh.layer !== pad.layer || sh.net === pad.net || sh.kind === 'fill') continue;
          const need = half + Math.max(cn, clearanceFor(sh.keepOut, 'trace'), sh.kind === 'pad' ? 0 : pairCl(netId(pad.net), netId(sh.net))) - 1e-6;
          if (sh.box.minX - need > Math.max(a.x, e.x) || sh.box.maxX + need < Math.min(a.x, e.x) || sh.box.minY - need > Math.max(a.y, e.y) || sh.box.maxY + need < Math.min(a.y, e.y)) continue;
          if (sh.edges.some(([p, q, rr]) => segSegDist(a, e, p, q) - rr < need) || (sh.kind === 'pad' && sh.areas[0] && inArea(e, sh.areas[0]))) ok = false;
        }
        if (!ok) continue;
        const keepOut = (netNode.get(pad.net) && (engine.get(netNode.get(pad.net)!.uid, 'keepOut')?.value as KeepOut | undefined)) || pad.keepOut;
        const box = { minX: Math.min(a.x, e.x) - half, minY: Math.min(a.y, e.y) - half, maxX: Math.max(a.x, e.x) + half, maxY: Math.max(a.y, e.y) + half };
        const stub = { uid: `fan:${pad.uid}`, kind: 'trace' as const, net: pad.net, layer: pad.layer, edges: [[a, e, half]] as [Vec2, Vec2, number][], areas: [], box, keepOut, edgeClearance: edgeCl, probe: a };
        fans.push({ pad, stub, li: layers.indexOf(pad.layer), a, e, half, out: alongX ? [sgn, 0] : [0, sgn], off: false });
      }
    }
    for (const f of fans) shapes.push(f.stub);
  }
  report.fanouts = fans.length;
  // How far the distance field must reach: the widest half-width plus the largest clearance that
  // any routed net or any copper asks for, plus one cell for the step between cell centres.
  let reachW = 0;
  let reachC = 0;
  for (const n of routedNets) {
    reachW = Math.max(reachW, netRule(n, 'traceWidth', 0.25) / 2, netRule(n, 'viaDiameter', 0.6) / 2);
    reachC = Math.max(reachC, netClear(n));
    // A pair routed together (P10) is a body of half width w + gap / 2, its vias side by side.
    const gp = netRule(n, 'diffGap', 0);
    if (gp) {
      const w = netRule(n, 'traceWidth', 0.25);
      const vd = netRule(n, 'viaDiameter', 0.6);
      reachW = Math.max(reachW, w + gp / 2, Math.max((w + gp) / 2, (vd + Math.max(gp, netClear(n))) / 2) + vd / 2);
    }
  }
  for (const s of shapes) reachC = Math.max(reachC, clearanceFor(s.keepOut, 'trace'));
  reachC = Math.max(reachC, maxPairCl);
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
  // Exception: a large SMD pad of a net (an exposed / thermal pad under a QFN, at least 2 mm and twice the
  // widest via across) takes vias of its own net inside, the usual way to join it to a plane; `thermal`
  // holds that net's id on its cells.
  const padMask = new Uint8Array(N);
  const thermal = new Int32Array(N);
  const maxVia = Math.max(0.6, ...routedNets.map((n) => netRule(n, 'viaDiameter', 0.6)));
  for (const s of shapes) {
    if (s.kind !== 'pad') continue;
    const big = !s.hole && !!s.net && Math.min(s.box.maxX - s.box.minX, s.box.maxY - s.box.minY) >= Math.max(2, 2 * maxVia);
    const tid = big ? netId(s.net) : 0;
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
          for (let i = i0; i <= i1; i++) {
            const c = j * W + i;
            if (tid && (!padMask[c] || thermal[c] === tid)) thermal[c] = tid;
            else thermal[c] = 0;
            padMask[c] = 1;
          }
        }
      }
    }
  }

  for (const s of shapes) {
    const li = layerIdx.get(s.layer);
    if (li === undefined) continue;
    const id = netId(s.net);
    // Pours are refilled around new traces, so they are no obstacles, also when their own net still has
    // connections to make (then the pour still counts as that net's copper to start or end on: the islands
    // are built from the shapes, not from this field). Painting them closed a whole poured layer to every
    // other net (fixture mcu: GND poured on B.Cu with SMD pads still to join, all routing went to F.Cu).
    if (s.kind === 'fill') continue;
    paint(li, id, { edges: s.edges, areas: s.kind === 'pad' ? s.areas : [] }, clearanceFor(s.keepOut, 'trace'));
  }

  // Reference plane (P8f): cells covered by a pour, per copper layer (the pours as filled before routing).
  // A trace on layer li has a plane under it where a neighbouring copper layer is covered there and no
  // trace laid by this run cuts that pour (checked during the search).
  const cov = copper.map(() => null as Uint8Array | null);
  // Each pour rasterised once (cell centres inside it): the islands of a poured net test their cells against
  // it, not against the pour's polygon (which made every connection of that net scan the whole board).
  const fillMask = new Map<(typeof shapes)[number], Uint8Array>();
  for (const s of shapes) {
    if (s.kind !== 'fill') continue;
    const own = new Uint8Array(N);
    fillMask.set(s, own);
    for (const ar of s.areas) {
      let y0 = Infinity, y1 = -Infinity;
      for (const ring of ar) for (const q of ring) (y0 = Math.min(y0, q.y)), (y1 = Math.max(y1, q.y));
      for (let j = Math.max(0, Math.ceil((y0 - minY) / g)); j <= Math.min(H - 1, Math.floor((y1 - minY) / g)); j++) {
        const y = cy(j);
        const xs: number[] = [];
        for (const ring of ar)
          for (let t = 0; t < ring.length; t++) {
            const a0 = ring[t]!;
            const b0 = ring[(t + 1) % ring.length]!;
            if ((a0.y > y) !== (b0.y > y)) xs.push(a0.x + ((y - a0.y) * (b0.x - a0.x)) / (b0.y - a0.y));
          }
        xs.sort((u, v) => u - v);
        for (let t = 0; t + 1 < xs.length; t += 2)
          for (let i = Math.max(0, Math.ceil((xs[t]! - minX) / g)); i <= Math.min(W - 1, Math.floor((xs[t + 1]! - minX) / g)); i++) own[j * W + i] = 1;
      }
    }
    const k = copper.indexOf(s.layer);
    if (k < 0) continue;
    const m = (cov[k] ??= new Uint8Array(N));
    for (let c = 0; c < N; c++) if (own[c]) m[c] = 1;
  }
  /** Per routing layer: its neighbouring copper layers that carry a pour, with their routing-layer index (-1 if not routed). */
  const refAdj = layers.map((l) => {
    const k = copper.indexOf(l);
    return [k - 1, k + 1].filter((x) => x >= 0 && x < copper.length && cov[x]).map((x) => ({ m: cov[x]!, lj: layers.indexOf(copper[x]!) }));
  });

  // Order (P8f): the `autoPlacePriority` rule first (higher first); then the shortest first (default), or by
  // difficulty (`order: 'difficulty'`): connections with a fine-pitch pad at an end (pad centres closer
  // than 0.85 mm to a pad of another net), then the long ones. On the benchmark board shortest-first gave
  // fewer vias and less length; negotiated rip-up makes room for the hard ones afterwards.
  const padShapes = shapes.filter((s) => s.kind === 'pad');
  const finePitch = (q: Vec2, net: string) => {
    const own = padShapes.find((s) => s.net === net && s.areas[0] && inArea(q, s.areas[0]));
    if (!own) return false;
    const b = own.box;
    const mid = (x: { minX: number; minY: number; maxX: number; maxY: number }) => ({ x: (x.minX + x.maxX) / 2, y: (x.minY + x.maxY) / 2 });
    const m = mid(b);
    return padShapes.some((s) => s !== own && s.net !== net && s.layer === own.layer && Math.hypot(mid(s.box).x - m.x, mid(s.box).y - m.y) < 0.85);
  };
  const lenOf = (r: (typeof rats)[number]) => Math.hypot(r.a.x - r.b.x, r.a.y - r.b.y);
  const prio = (r: (typeof rats)[number]) => netRule(r.net, 'autoPlacePriority', 0);
  const fine = new Map(rats.map((r) => [r, finePitch(r.a, r.net) || finePitch(r.b, r.net)]));
  const order = rats.slice().sort((a, b) => {
    const p = prio(b) - prio(a);
    if (p) return p;
    if (opts.order !== 'difficulty') return lenOf(a) - lenOf(b);
    const f = Number(fine.get(b)) - Number(fine.get(a));
    return f || lenOf(b) - lenOf(a);
  });
  // Bundles (P8f): two connections of different nets whose pads are neighbours on one part at one end and
  // on one part at the other end (a bus, a row of header pins) are mates; they are counted (`bundled`) for
  // the signal classes of P16. Neighbours: centres no further apart than 1.25 × the pad's closest neighbour
  // on its part, and at most 2.6 mm (a 0.1" header). No cost of their own: a bonus for running beside a mate
  // pulled the routes tighter than the pins' pitch, crossed them and added vias (bus fixture, RGB lamp),
  // while proximity and the layer directions already lay a bus side by side.
  const bundled = new Set<(typeof rats)[number]>();
  /** Per connection of a bus: where it may cross the front row of its pins' part (see Lanes below). */
  const lanes = new Map<(typeof rats)[number], { alongX: boolean; sg: number; uLo: number; uHi: number; vLo: number; vHi: number }>();
  {
    const midOf = (s: (typeof shapes)[number]) => ({ x: (s.box.minX + s.box.maxX) / 2, y: (s.box.minY + s.box.maxY) / 2 });
    const partPads = new Map<string, Vec2[]>();
    const padAt = (q: Vec2) => {
      const s = padShapes.find((x) => x.box.minX - 1e-6 <= q.x && q.x <= x.box.maxX + 1e-6 && x.box.minY - 1e-6 <= q.y && q.y <= x.box.maxY + 1e-6 && (!x.areas[0] || inArea(q, x.areas[0])));
      const part = s && doc.nodes.get(s.uid)?.parent;
      return s && part ? { part, m: midOf(s) } : undefined;
    };
    for (const s of padShapes) {
      const part = doc.nodes.get(s.uid)?.parent;
      if (part) (partPads.get(part) ?? partPads.set(part, []).get(part)!).push(midOf(s));
    }
    const nearest = new Map<string, number>();
    const closest = (part: string, m: Vec2) => {
      const k = `${part}|${m.x}|${m.y}`;
      let d = nearest.get(k);
      if (d === undefined) {
        d = Infinity;
        for (const o of partPads.get(part) ?? []) {
          const x = Math.hypot(o.x - m.x, o.y - m.y);
          if (x > 1e-6) d = Math.min(d, x);
        }
        nearest.set(k, d);
      }
      return d;
    };
    type End = { part: string; m: Vec2 };
    const ends = rats.map((r) => [padAt(r.a), padAt(r.b)] as const);
    const near = (p: End, q: End) => {
      if (p.part !== q.part) return 0;
      const d = Math.hypot(p.m.x - q.m.x, p.m.y - q.m.y);
      return d > 1e-6 && d <= 2.6 && d <= 1.25 * closest(p.part, p.m) + 1e-6 ? d : 0;
    };
    for (let x = 0; x < rats.length; x++) {
      const [a1, b1] = ends[x]!;
      if (!a1 || !b1 || a1.part === b1.part) continue;
      for (let y = x + 1; y < rats.length; y++) {
        if (rats[x]!.net === rats[y]!.net) continue;
        const [a2, b2] = ends[y]!;
        if (!a2 || !b2) continue;
        let da = near(a1, a2), db = near(b1, b2);
        if (!da || !db) (da = near(a1, b2)), (db = near(b1, a2));
        if (!da || !db) continue;
        bundled.add(rats[x]!).add(rats[y]!);
      }
    }
    // Lanes (P8f): a bus that leaves a part with more than one row of pins (a 2 × n header) has to keep its
    // order. The nets are ordered by their pins at the other part; a net whose pin sits in a rear row then
    // gets the gap in the front row (the row towards the other part) that keeps that order, e.g. the odd
    // pins of a header pass above their even neighbours, not below them, and the traces need not cross.
    // While routing, such a net may cross the front row only through its gap. Nothing is planned when the
    // front row's own nets are out of order or a gap is too narrow.
    const groups = new Map<string, number[]>();
    rats.forEach((r, i) => {
      const [a, b] = ends[i]!;
      if (!bundled.has(r) || !a || !b) return;
      const k = [a.part, b.part].sort().join('|');
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
    });
    const padBoxAt = (q: Vec2) => padShapes.find((x) => x.box.minX - 1e-6 <= q.x && q.x <= x.box.maxX + 1e-6 && x.box.minY - 1e-6 <= q.y && q.y <= x.box.maxY + 1e-6 && (!x.areas[0] || inArea(q, x.areas[0])));
    for (const idx of groups.values()) {
      if (idx.length < 3) continue;
      const [e0a, e0b] = ends[idx[0]!]!;
      for (const [P, Q] of [[e0a!.part, e0b!.part], [e0b!.part, e0a!.part]] as const) {
        const atP = (i: number) => (ends[i]![0]!.part === P ? 0 : 1);
        const ptsP = idx.map((i) => (atP(i) === 0 ? rats[i]!.a : rats[i]!.b));
        const ptsQ = idx.map((i) => (atP(i) === 0 ? rats[i]!.b : rats[i]!.a));
        const cP = { x: ptsP.reduce((t, q) => t + q.x, 0) / ptsP.length, y: ptsP.reduce((t, q) => t + q.y, 0) / ptsP.length };
        const cQ = { x: ptsQ.reduce((t, q) => t + q.x, 0) / ptsQ.length, y: ptsQ.reduce((t, q) => t + q.y, 0) / ptsQ.length };
        const alongX = Math.abs(cQ.x - cP.x) >= Math.abs(cQ.y - cP.y);
        const sg = Math.sign(alongX ? cQ.x - cP.x : cQ.y - cP.y) || 1;
        const U = (q: Vec2) => (alongX ? q.x : q.y) * sg;
        const V = (q: Vec2) => (alongX ? q.y : q.x);
        const partPadsP = padShapes.filter((x) => doc.nodes.get(x.uid)?.parent === P);
        const uniq = new Map<string, (typeof shapes)[number]>();
        for (const x of partPadsP) uniq.set(`${midOf(x).x.toFixed(3)},${midOf(x).y.toFixed(3)}`, x);
        const pads = [...uniq.values()];
        const front = Math.max(...pads.map((x) => U(midOf(x))));
        const frontPads = pads.filter((x) => U(midOf(x)) > front - 0.1).sort((x, y) => V(midOf(x)) - V(midOf(y)));
        const own = idx.map((i, k) => padBoxAt(ptsP[k]!));
        if (own.some((x) => !x)) continue;
        const isFront = own.map((x) => U(midOf(x!)) > front - 0.1);
        if (isFront.every(Boolean) || frontPads.length < 2) continue;
        // Order along the front row as the pins at Q run (either way round, whichever the front nets follow).
        let seq = idx.map((_, k) => k).sort((x, y) => V(ptsQ[x]!) - V(ptsQ[y]!));
        const frontV = (ks: number[]) => ks.filter((k) => isFront[k]).map((k) => V(midOf(own[k]!)));
        const mono = (vs: number[]) => vs.every((v, j) => j === 0 || v > vs[j - 1]!);
        if (!mono(frontV(seq))) {
          seq = seq.reverse();
          if (!mono(frontV(seq))) continue;
        }
        const lo = (x: (typeof shapes)[number]) => (alongX ? x.box.minY : x.box.minX);
        const hi = (x: (typeof shapes)[number]) => (alongX ? x.box.maxY : x.box.maxX);
        const gaps = [{ lo: -Infinity, hi: lo(frontPads[0]!), used: 0 }];
        for (let j = 0; j + 1 < frontPads.length; j++) gaps.push({ lo: hi(frontPads[j]!), hi: lo(frontPads[j + 1]!), used: 0 });
        gaps.push({ lo: hi(frontPads[frontPads.length - 1]!), hi: Infinity, used: 0 });
        const need = (i: number) => netRule(rats[i]!.net, 'traceWidth', 0.25) + netClear(rats[i]!.net);
        let cur = -Infinity;
        const plan = new Map<number, (typeof gaps)[number]>();
        let ok = true;
        for (let j = 0; j < seq.length && ok; j++) {
          const k = seq[j]!;
          if (isFront[k]) {
            cur = Math.max(cur, V(midOf(own[k]!)));
            continue;
          }
          const next = seq.slice(j + 1).find((x) => isFront[x]);
          const limit = next === undefined ? Infinity : V(midOf(own[next]!));
          const i = idx[k]!;
          // A gap after the last placed net and before the next front-row net, with room for one more trace.
          const fits = gaps.filter((gp) => gp.lo >= cur - 1e-6 && gp.hi <= limit + 1e-6 && gp.hi - gp.lo >= (gp.used + 1) * need(i) + netClear(rats[i]!.net) - 1e-6);
          if (!fits.length) {
            ok = false;
            break;
          }
          const mine = V(midOf(own[k]!));
          const gp = fits.reduce((x, y) => (Math.abs((Math.max(x.lo, mine - 50) + Math.min(x.hi, mine + 50)) / 2 - mine) <= Math.abs((Math.max(y.lo, mine - 50) + Math.min(y.hi, mine + 50)) / 2 - mine) ? x : y));
          gp.used++;
          plan.set(i, gp);
          cur = Math.max(cur, gp.lo);
        }
        if (!ok || !plan.size) continue;
        const uLo = Math.min(...frontPads.map((x) => (alongX ? (sg > 0 ? x.box.minX : -x.box.maxX) : sg > 0 ? x.box.minY : -x.box.maxY)));
        const uHi = Math.max(...frontPads.map((x) => (alongX ? (sg > 0 ? x.box.maxX : -x.box.minX) : sg > 0 ? x.box.maxY : -x.box.minY)));
        for (const [i, gp] of plan) lanes.set(rats[i]!, { alongX, sg, uLo, uHi, vLo: gp.lo, vHi: gp.hi });
        break;
      }
    }
  }
  report.bundled = bundled.size;
  // Preferred direction per layer (P8f): from the `routeDirection` rule pattern over the copper stack
  // (alternate = top horizontal, next vertical …), overridden per layer by `opts.directions`. 0 = any,
  // 1 = horizontal, 2 = vertical. With a single routing layer there is no preference.
  const dirK = opts.directionCost ?? 1.5;
  const proxK = opts.proximityCost ?? 0.3;
  const layerDirs = (net: string): number[] => {
    const n = netNode.get(net);
    const pat = (n ? engine.get(n.uid, 'routeDirection')?.value : undefined) ?? 'alternate';
    return layers.map((l) => {
      const o = opts.directions?.[l];
      if (o) return o === 'horizontal' ? 1 : o === 'vertical' ? 2 : 0;
      if (layers.length < 2 || pat === 'any') return 0;
      const k = copper.indexOf(l);
      return (k % 2 === 0) === (pat !== 'alternate-v') ? 1 : 2;
    });
  };
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
  const proxStamp = new Int32Array(N * L);
  const proxVal = new Float32Array(N * L);
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
  const routeConn = (r: (typeof rats)[number], pres: number, hist: Float32Array, noLane = false): { ok: true; route: Route; victims: Set<number>; contested: number[] } | { ok: false; reason: string; joined?: boolean } => {
    const lane = noLane ? undefined : lanes.get(r);
    const id = netId(r.net);
    const width = netRule(r.net, 'traceWidth', 0.25);
    const viaD = netRule(r.net, 'viaDiameter', 0.6);
    const cn = netClear(r.net);
    const viaR = Math.ceil((viaD / 2 + cn - width / 2) / g);
    const soft = pres !== Infinity;
    const viaRule = netRule(r.net, 'viaCost', 0);
    const viaCost = opts.viaCost ?? (viaRule || 4) / g;
    const ldir = layerDirs(r.net);
    // Step cost factor per layer and direction index (DIRS order): along the layer's direction 1, against
    // it dirK, a 45° step halfway.
    const stepK = ldir.map((d) => DIRS.map(([di, dj]) => (d === 0 ? 1 : di && dj ? 1 + (dirK - 1) / 2 : (d === 1 ? dj : di) ? dirK : 1)));
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
        if (distToSegment(p, cp.a, cp.b) - cp.r < half + slack + Math.max(cn, cp.cl, pairCl(id, cp.id)) - 1e-6) {
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
      if (ok && lane) {
        // A bus net crosses the front row of its part only through its own gap (Lanes).
        const i = c % W;
        const x = cx(i);
        const y = cy((c - i) / W);
        const u = (lane.alongX ? x : y) * lane.sg;
        const v = lane.alongX ? y : x;
        const m = halfFull + cn;
        if (u >= lane.uLo - m && u <= lane.uHi + m && (v < lane.vLo || v > lane.vHi)) ok = false;
      }
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
      // A via never sits on or touches a pad, the net's own included, except inside a thermal pad of its net.
      const inThermal = thermal[c] === id;
      for (let dj = -viaR; dj <= viaR && ok; dj++)
        for (let di = -viaR; di <= viaR; di++) {
          if (di * di + dj * dj > viaR * viaR) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= W || jj >= H) {
            ok = false;
            break;
          }
          const cc = jj * W + ii;
          if (padMask[cc] && !(inThermal && thermal[cc] === id)) {
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
    /** Is q on this net's copper on layer li with some margin (not on its very edge, where rounding can put an end outside)? */
    const wellOn = (q: Vec2, li: number) => {
      const e = 0.005;
      return [q, { x: q.x + e, y: q.y }, { x: q.x - e, y: q.y }, { x: q.x, y: q.y + e }, { x: q.x, y: q.y - e }].every((x) => ownLayersAt(x).includes(li));
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
        const need = half + Math.max(cn, clearanceFor(sh.keepOut, 'trace'), sh.kind === 'pad' ? 0 : pairCl(id, netId(sh.net))) - 1e-6;
        if (sh.box.minX - need > Math.max(a.x, b.x) || sh.box.maxX + need < Math.min(a.x, b.x) || sh.box.minY - need > Math.max(a.y, b.y) || sh.box.maxY + need < Math.min(a.y, b.y)) continue;
        for (const [e0, e1, er] of sh.edges) if (segSegDist(a, b, e0, e1) - er < need) return false;
        if (sh.kind === 'pad' && sh.areas[0] && (inArea(a, sh.areas[0]) || inArea(b, sh.areas[0]))) return false;
      }
      if (!soft) for (const cp of capsAlong(li, a, b)) if (cp.id !== id && segSegDist(a, b, cp.a, cp.b) - cp.r < half + Math.max(cn, cp.cl, pairCl(id, cp.id)) - 1e-6) return false;
      return true;
    };
    type End = Map<number, { cost: number; pts: Vec2[]; dir?: [number, number]; strict?: boolean }>;
    /** Entry states at end point q: grid state → cost (in cells) and the exact points from q up to (not including) the cell. */
    const entries = (q: Vec2, out: End, dirOut?: [number, number], isl?: Set<number>) => {
      // Only the layers where the end's own island has copper at q: an SMD pad over a pour of its net on the
      // other layer is left on the pad's layer, not straight from the pour under it (no via there).
      let ls = ownLayersAt(q);
      if (isl) {
        const onIsl = ls.filter((li) => [...isl].some((k) => memLayers[k]!.has(li) && onMem(mems[k]!, li, q, 1e-6)));
        if (onIsl.length) ls = onIsl;
      }
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
          // At a fanout stub's end the trace carries on outwards: no turn of 90° or more onto the stub.
          if (!cur || cur.cost > len / g) out.set(st, dirOut ? { cost: len / g, pts: [q], dir: dirOut, strict: true } : { cost: len / g, pts: [q] });
          return;
        }
        // Turns inside the entry may not be acute; the first piece should follow the pad's long axis.
        for (let k = 1; k + 1 < kept.length; k++) if (dirDot(kept[k - 1]!, kept[k]!, kept[k + 1]!) < -1e-9) return;
        const f0 = kept[0]!;
        const f1 = kept[1]!;
        if (dirOut && (f1.x - f0.x) * dirOut[0] + (f1.y - f0.y) * dirOut[1] < 1e-9) return;
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
    // ---- Islands. The copper of this net (fixed shapes, and the run-routes of the net) is grouped into
    // islands by the same rules the connectivity check uses (a trace joins a pad when one of its ends lies
    // in the pad or it runs over the pad's centre, a trace or via when an end lies on it, a pour when an end
    // lies in it; layers join only through one object on several layers: through-hole pads and vias). Copper
    // that merely touches (a trace grazing a pad's edge, an SMD pad over a bottom trace) is not joined, so the
    // router never counts a connection as made that the ratsnest still shows open.
    interface Mem { kind: string; shapes: typeof shapes; route?: Route }
    const mems: Mem[] = [];
    const byUid = new Map<string, Mem>();
    for (const sh of ownShapes) {
      let m = byUid.get(sh.uid);
      if (!m) byUid.set(sh.uid, (m = { kind: sh.kind, shapes: [] })), mems.push(m);
      m.shapes.push(sh);
    }
    for (const rt of routes.values()) if (rt.id === id) mems.push({ kind: 'route', shapes: [], route: rt });
    const onMem = (m: Mem, li: number, q: Vec2, extra: number) => {
      if (m.route) {
        for (const cp of m.route.caps) if (cp.li === li && distToSegment(q, cp.a, cp.b) <= cp.r + extra) return true;
        return false;
      }
      for (const sh of m.shapes) {
        if (layerIdx.get(sh.layer) !== li) continue;
        if (q.x < sh.box.minX - extra - 1e-6 || q.x > sh.box.maxX + extra + 1e-6 || q.y < sh.box.minY - extra - 1e-6 || q.y > sh.box.maxY + extra + 1e-6) continue;
        if (sh.kind === 'fill' && extra === 0) {
          // Grid tests (island cells, starts and ends): the pour's raster at q's cell.
          const c = cellOf(q);
          if (c >= 0 && fillMask.get(sh)![c]) return true;
          continue;
        }
        if (sh.kind === 'pad' || sh.kind === 'fill' ? sh.areas.some((ar) => inArea(q, ar)) : sh.edges.some(([a, b, rr]) => distToSegment(q, a, b) <= rr + extra)) return true;
      }
      return false;
    };
    /** Points of a member that join it to copper they lie on: trace and route ends, via and pad centres. */
    const endPts = (m: Mem, li: number): Vec2[] => {
      if (m.route) {
        const out: Vec2[] = [...m.route.vias];
        for (const sg of m.route.segs) if (sg.li === li) out.push(sg.a, sg.b);
        return out;
      }
      const out: Vec2[] = [];
      for (const sh of m.shapes) {
        if (layerIdx.get(sh.layer) !== li) continue;
        if (sh.kind === 'pad') out.push({ x: (sh.box.minX + sh.box.maxX) / 2, y: (sh.box.minY + sh.box.maxY) / 2 });
        else if (sh.kind !== 'fill') for (const [a, b] of sh.edges) out.push(a, b);
      }
      return out;
    };
    const memLayers = mems.map((m) => new Set(m.route ? m.route.caps.map((cp) => cp.li) : m.shapes.map((sh) => layerIdx.get(sh.layer)).filter((x): x is number => x !== undefined)));
    const parent = mems.map((_, k) => k);
    const findSet = (k: number): number => (parent[k] === k ? k : (parent[k] = findSet(parent[k]!)));
    const flat = (m: Mem) => m.kind === 'pad' || m.kind === 'via' || m.kind === 'fill';
    for (let x = 0; x < mems.length; x++)
      for (let y = x + 1; y < mems.length; y++) {
        const A = mems[x]!;
        const B = mems[y]!;
        if (flat(A) && flat(B) && !((A.kind === 'fill') !== (B.kind === 'fill'))) continue; // pad–pad, via–via, pad–via, fill–fill
        for (const li of memLayers[x]!) {
          if (!memLayers[y]!.has(li)) continue;
          if (endPts(A, li).some((e) => onMem(B, li, e, 1e-3)) || endPts(B, li).some((e) => onMem(A, li, e, 1e-3))) {
            parent[findSet(x)] = findSet(y);
            break;
          }
        }
      }
    /**
     * The island of a ratsnest end q. The ratsnest is made before the run, so q is on fixed copper (often
     * on a pad's edge): only fixed copper at q counts, never a run-route that happens to pass there.
     */
    const islandOf = (q: Vec2): Set<number> => {
      const roots = new Set<number>();
      // A ratsnest end on a pad belongs to that pad's island only: an SMD pad over a pour of its net on the
      // other layer is not joined to it (fixture mcu: every SMD GND pad over the B.Cu pour counted as done).
      for (let k = 0; k < mems.length; k++) if (mems[k]!.kind === 'pad') for (const li of memLayers[k]!) if (onMem(mems[k]!, li, q, 1e-6)) roots.add(findSet(k));
      if (!roots.size) for (let k = 0; k < mems.length; k++) if (!mems[k]!.route) for (const li of memLayers[k]!) if (onMem(mems[k]!, li, q, 1e-6)) roots.add(findSet(k));
      if (!roots.size) for (let k = 0; k < mems.length; k++) for (const li of memLayers[k]!) if (onMem(mems[k]!, li, q, 1e-6)) roots.add(findSet(k));
      const out = new Set<number>();
      for (let k = 0; k < mems.length; k++) if (roots.has(findSet(k))) out.add(k);
      return out;
    };
    /** Grid states whose cell centre is on copper of the island (up to 60 000). */
    const islandCells = (isl: Set<number>): Set<number> => {
      const seen = new Set<number>();
      for (const k of isl) {
        const m = mems[k]!;
        for (const li of memLayers[k]!) {
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          if (m.route) for (const cp of m.route.caps) if (cp.li === li) (bx0 = Math.min(bx0, cp.a.x - cp.r, cp.b.x - cp.r)), (by0 = Math.min(by0, cp.a.y - cp.r, cp.b.y - cp.r)), (bx1 = Math.max(bx1, cp.a.x + cp.r, cp.b.x + cp.r)), (by1 = Math.max(by1, cp.a.y + cp.r, cp.b.y + cp.r));
          for (const sh of m.shapes) if (layerIdx.get(sh.layer) === li) (bx0 = Math.min(bx0, sh.box.minX)), (by0 = Math.min(by0, sh.box.minY)), (bx1 = Math.max(bx1, sh.box.maxX)), (by1 = Math.max(by1, sh.box.maxY));
          const i0 = Math.max(0, Math.ceil((bx0 - minX) / g - 1e-9));
          const i1 = Math.min(W - 1, Math.floor((bx1 - minX) / g + 1e-9));
          const j0 = Math.max(0, Math.ceil((by0 - minY) / g - 1e-9));
          const j1 = Math.min(H - 1, Math.floor((by1 - minY) / g + 1e-9));
          for (let j = j0; j <= j1 && seen.size < 60000; j++)
            for (let i = i0; i <= i1; i++) {
              const st = li * N + j * W + i;
              if (!seen.has(st) && onMem(m, li, { x: cx(i), y: cy(j) }, 0)) seen.add(st);
            }
        }
      }
      return seen;
    };
    const islA = islandOf(r.a);
    const islB = islandOf(r.b);
    if ([...islB].some((k) => islA.has(k))) return { ok: false, reason: '', joined: true };
    const groupA = islandCells(islA);
    const groupB = islandCells(islB);
    const seeds: End = new Map();
    const goals: End = new Map();
    // A cell is a start or end only if its centre is on the island's copper with some margin (not on its very
    // edge, where rounding can put the end outside) and the trace has room there.
    const onIsland = (isl: Set<number>, li: number, q: Vec2) => {
      const e = 0.005;
      return [q, { x: q.x + e, y: q.y }, { x: q.x - e, y: q.y }, { x: q.x, y: q.y + e }, { x: q.x, y: q.y - e }].every((x) => [...isl].some((k) => memLayers[k]!.has(li) && onMem(mems[k]!, li, x, 0)));
    };
    const onOwn = (st: number, isl: Set<number>) => {
      const li = Math.floor(st / N);
      const c = st % N;
      const i = c % W;
      return usable(li, c) && onIsland(isl, li, { x: cx(i), y: cy((c - i) / W) });
    };
    // A cell on copper of both islands (they overlap without being joined, e.g. a trace grazing a pad) is no
    // start: a path must leave island A and end in island B, so it gets at least one piece of trace.
    // Fanned-out pads of this net (and their stubs) are no start or end: a connection there leaves from the
    // stub's outer end, straight on or at 45°.
    const myFans = fans.filter((f) => !f.off && f.pad.net === r.net);
    const fanAt = (q: Vec2) => myFans.find((f) => q.x >= f.pad.box.minX - 1e-6 && q.x <= f.pad.box.maxX + 1e-6 && q.y >= f.pad.box.minY - 1e-6 && q.y <= f.pad.box.maxY + 1e-6);
    // A stub points away from its part. When the other end lies behind the pad (e.g. a pin to the exposed
    // pad of its own part), leaving from the stub's end means turning straight back: the connection then
    // leaves from the pad, and the stub stays for the connections that go outwards.
    // Only towards a pad of the same part: a target across the board may lie "behind" too, and that one
    // still wants the stub to get out of the pad row…
    const partOf = (uid: string) => doc.nodes.get(uid)?.parent;
    const behind = (f: Fan | undefined, other: Vec2) => {
      if (!f) return false;
      const c = { x: (f.pad.box.minX + f.pad.box.maxX) / 2, y: (f.pad.box.minY + f.pad.box.maxY) / 2 };
      if ((other.x - c.x) * f.out[0] + (other.y - c.y) * f.out[1] >= 0) return false;
      const part = partOf(f.pad.uid);
      // …and one without a stub of its own (the exposed pad): a pin on the far side of the part is fanned
      // out itself and is reached around the part, through both stubs.
      return shapes.some((sh) => sh.kind === 'pad' && sh.net === r.net && !!sh.areas[0] && partOf(sh.uid) === part && inArea(other, sh.areas[0]) && !fans.some((g) => g.pad === sh));
    };
    const fa0 = fanAt(r.a);
    const fb0 = fanAt(r.b);
    const fa = behind(fa0, r.b) ? undefined : fa0;
    const fb = behind(fb0, r.a) ? undefined : fb0;
    const freed = new Set([fa0 !== fa ? fa0 : undefined, fb0 !== fb ? fb0 : undefined].filter(Boolean));
    const fanned = (st: number) => {
      if (!myFans.length) return false;
      const li = Math.floor(st / N);
      const c = st % N;
      const p = { x: cx(c % W), y: cy(Math.floor(c / W)) };
      return myFans.some((f) => !freed.has(f) && f.li === li && ((f.pad.areas[0] && inArea(p, f.pad.areas[0])) || distToSegment(p, f.a, f.e) <= f.half + 1e-6));
    };
    for (const st of groupA) if (!groupB.has(st) && !fanned(st) && onOwn(st, islA)) seeds.set(st, { cost: 0, pts: [] });
    for (const st of groupB) if (!fanned(st) && onOwn(st, islB)) goals.set(st, { cost: 0, pts: [] });
    entries(fa ? fa.e : r.a, seeds, fa?.out, islA);
    entries(fb ? fb.e : r.b, goals, fb?.out, islB);
    // No way out of a stub's end: start from the pad after all.
    if (fa && !seeds.size) {
      for (const st of groupA) if (!groupB.has(st) && onOwn(st, islA)) seeds.set(st, { cost: 0, pts: [] });
      entries(r.a, seeds, undefined, islA);
    }
    if (fb && !goals.size) {
      for (const st of groupB) if (onOwn(st, islB)) goals.set(st, { cost: 0, pts: [] });
      entries(r.b, goals, undefined, islB);
    }
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
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    /**
     * Proximity (P8f): cost of running right next to other nets' copper (fixed copper and run-routes),
     * fading to 0 one trace pitch (width + clearance) beyond the closest legal distance, so a long parallel
     * run next to another net costs more than a short pass, and traces keep some air where there is room.
     */
    const band = width + cn;
    const gapK = refAdj.some((x) => x.length) ? netRule(r.net, 'planeGapCost', opts.planeGapCost ?? 0) : 0;
    /** Is there a plane under cell c of layer li (a pour on a neighbouring layer, not cut by a trace of this run)? */
    const planeUnder = (li: number, c: number, p: Vec2) => {
      for (const { m, lj } of refAdj[li]!) {
        if (!m[c]) continue;
        if (lj < 0) return true;
        let cut = false;
        for (const cp of capsNear(lj, p)) if (distToSegment(p, cp.a, cp.b) < cp.r + cp.cl + halfFull) (cut = true);
        if (!cut) return true;
      }
      return false;
    };
    /** Proximity to other nets and plane gaps under the cell: extra cost of entering it (memoised per search). */
    const proximity = (li: number, c: number) => {
      const s = li * N + c;
      if (proxStamp[s] === call) return proxVal[s]!;
      let v = 0;
      if (proxK > 0) {
        const f = field[li]!;
        let m = Math.min(f.zd[c]! - cn, f.ze[c]!);
        if (f.o1[c] !== id) m = Math.min(m, f.d1[c]! - cn, f.e1[c]!);
        if (f.o2[c] !== id) m = Math.min(m, f.d2[c]! - cn, f.e2[c]!);
        const i = c % W;
        const p = { x: cx(i), y: cy((c - i) / W) };
        for (const cp of capsNear(li, p)) if (cp.id !== id) m = Math.min(m, distToSegment(p, cp.a, cp.b) - cp.r - Math.max(cn, cp.cl, pairCl(id, cp.id)));
        const ex = m - halfFull - slackFull;
        if (ex < band) v = proxK * (1 - Math.max(0, ex) / band);
      }
      if (gapK > 0 && refAdj[li]!.length) {
        const i = c % W;
        if (!planeUnder(li, c, { x: cx(i), y: cy((c - i) / W) })) v += gapK;
      }
      proxStamp[s] = call;
      proxVal[s] = v;
      return v;
    };
    /** Extra cost of entering a cell: run-routes in the way (soft only), the cell's history and proximity. */
    const extra = (li: number, c: number) => (soft ? pres * crowd(li, c) : 0) + hist[li * N + c]! + proximity(li, c);
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
      if (e.strict && e.dir) return pd[0] * e.dir[0] + pd[1] * e.dir[1] < 0;
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
      const sk = stepK[li]!;
      for (let dk = 0; dk < 8; dk++) {
        const [di, dj, w0] = DIRS[dk]!;
        const w = w0 * sk[dk]!;
        // Turns: straight is free, 45° costs little, 90° a little more, acute never.
        let turn = 0;
        if (pd) {
          const dot = pd[0] * di + pd[1] * dj;
          if (dot < 0 || (dot === 0 && from[s]! < 0 && seeds.get(s)?.strict)) continue;
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
    // A route that leaves from a fanout stub's end takes the stub in as its first (or last) piece, unless a
    // route of the net already holds it, so the corner passes treat the escape like any other corner.
    // Held = a piece that starts at the pad's centre and runs out along the stub (a route of the net that
    // leaves the pad inwards, to the exposed pad, starts there too but does not hold the stub).
    const alongStub = (f: Fan, from: Vec2, to: Vec2) => Math.hypot(from.x - f.a.x, from.y - f.a.y) < 1e-6 && (to.x - f.a.x) * f.out[0] + (to.y - f.a.y) * f.out[1] > 1e-6 && distToSegment(to, f.a, { x: f.a.x + f.out[0] * 1e3, y: f.a.y + f.out[1] * 1e3 }) < 1e-6;
    const stubFree = (f: Fan) => ![...routes.values()].some((rt) => rt.id === id && rt.segs.some((sg) => sg.li === f.li && (alongStub(f, sg.a, sg.b) || alongStub(f, sg.b, sg.a))));
    const atStub = (f: Fan | undefined, q: Vec2 | undefined, li: number) => !!f && !!q && li === f.li && Math.hypot(q.x - f.e.x, q.y - f.e.y) < 1e-6 && stubFree(f);
    let cur: { layer: number; pts: Vec2[] } = { layer: cells[0]!.li, pts: [...seeds.get(first)!.pts] };
    if (atStub(fa, cur.pts[0], cur.layer)) cur.pts.unshift(fa!.a);
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
    if (atStub(fb, cur.pts[cur.pts.length - 1], cur.layer) && fb !== fa) cur.pts.push(fb!.a);
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
    /**
     * Short pieces between two long ones (a grid offset at a fanout stub's or pad's end, a small stair) are
     * replaced by the corner where the two long lines meet: at 45° that corner itself, at 90° a full chamfer
     * (the setback on each side), so no 45° piece is left too short to see and the turn reads as sharp.
     */
    const tidy = (li: number, P: Vec2[]): Vec2[] => {
      if (style === '90') return P;
      const len = (a: Vec2, b: Vec2) => Math.hypot(b.x - a.x, b.y - a.y);
      const dirOf = (a: Vec2, b: Vec2) => ({ x: (b.x - a.x) / len(a, b), y: (b.y - a.y) / len(a, b) });
      // A fanout stub's end stays: other connections of the pad start there, and the stub is laid only as
      // part of the first route through it.
      const fixedPt = (q: Vec2) => myFans.some((f) => Math.hypot(f.e.x - q.x, f.e.y - q.y) < 1e-6);
      for (let k = 1; k + 1 < P.length; k++) {
        let j = k;
        while (j + 1 < P.length - 1 && j - k < 3 && len(P[j]!, P[j + 1]!) < setback - 1e-6) j++;
        if (j === k) continue;
        if (P.slice(k, j + 1).some(fixedPt)) continue;
        const A = P[k - 1]!, V = P[k]!, D = P[j]!, E = P[j + 1]!;
        const u = dirOf(A, V), w = dirOf(D, E);
        const dot = u.x * w.x + u.y * w.y;
        const cross = u.x * w.y - u.y * w.x;
        const is45 = Math.abs(dot - Math.SQRT1_2) < 1e-6;
        if (dot > 1 - 1e-9 && Math.abs(cross) < 1e-9) {
          // A small offset between two parallel runs (typically where a run meets a pad centre off its line):
          // move the corner before it (or after it) so one run lies on the other's line, and the jog is gone.
          const meet = (p0: Vec2, d0: Vec2, q0: Vec2, d1: Vec2): Vec2 | undefined => {
            const c = d0.x * d1.y - d0.y * d1.x;
            if (Math.abs(c) < 1e-9) return undefined;
            const t2 = ((q0.x - p0.x) * d1.y - (q0.y - p0.y) * d1.x) / c;
            return { x: p0.x + d0.x * t2, y: p0.y + d0.y * t2 };
          };
          let done = false;
          if (k - 2 >= 0 && !fixedPt(A)) {
            const Z = P[k - 2]!;
            const z = dirOf(Z, A);
            const A2 = meet(Z, z, E, w);
            if (A2 && (A2.x - Z.x) * z.x + (A2.y - Z.y) * z.y > 1e-6 && (E.x - A2.x) * w.x + (E.y - A2.y) * w.y > 1e-6 && clearPath(li, [Z, A2, E])) {
              P = [...P.slice(0, k - 1), A2, ...P.slice(j + 1)];
              done = true;
            }
          }
          if (!done && j + 2 < P.length && !fixedPt(E)) {
            const F = P[j + 2]!;
            const f = dirOf(E, F);
            const E2 = meet(A, u, E, f);
            if (E2 && (E2.x - A.x) * u.x + (E2.y - A.y) * u.y > 1e-6 && (F.x - E2.x) * f.x + (F.y - E2.y) * f.y > 1e-6 && clearPath(li, [A, E2, F])) {
              P = [...P.slice(0, k), E2, ...P.slice(j + 2)];
              done = true;
            }
          }
          // At the path's start or end on a pad (the corner there is a via or the pad itself): run on along the
          // first line and end in the pad off its centre, close enough to it to count as connected.
          const inOwnPad = (q: Vec2, c: Vec2) =>
            padShapes.some((x) => x.net === r.net && x.layer === layers[li] && x.areas[0] && inArea(c, x.areas[0]) && inArea(q, x.areas[0]) && Math.hypot(q.x - c.x, q.y - c.y) <= 0.25 * Math.min(x.box.maxX - x.box.minX, x.box.maxY - x.box.minY));
          if (!done && j + 1 === P.length - 1 && !fixedPt(E)) {
            const s2 = (E.x - A.x) * u.x + (E.y - A.y) * u.y;
            const Y = { x: A.x + u.x * s2, y: A.y + u.y * s2 };
            if (s2 > len(A, V) && inOwnPad(Y, E) && clearPath(li, [A, Y])) {
              P = [...P.slice(0, k), Y];
              done = true;
            }
          }
          if (!done && k - 1 === 0 && !fixedPt(A)) {
            const s2 = (A.x - E.x) * w.x + (A.y - E.y) * w.y;
            const Y = { x: E.x + w.x * s2, y: E.y + w.y * s2 };
            if (s2 < 0 && -s2 > len(D, E) && inOwnPad(Y, A) && clearPath(li, [Y, E])) {
              P = [Y, ...P.slice(j + 1)];
              done = true;
            }
          }
          if (done) k = Math.max(0, k - 2);
          continue;
        }
        if (!(is45 || Math.abs(dot) < 1e-6) || Math.abs(cross) < 1e-9) continue;
        // X = A + t·u = D + s·w.
        const t = ((D.x - A.x) * w.y - (D.y - A.y) * w.x) / cross;
        const X = { x: A.x + u.x * t, y: A.y + u.y * t };
        const tx = len(A, X), sx = len(X, E);
        if (t <= 1e-6 || (E.x - X.x) * w.x + (E.y - X.y) * w.y <= 1e-6) continue;
        let pts: Vec2[] | undefined;
        if (is45) pts = clearPath(li, [A, X, E]) ? [X] : undefined;
        else {
          // The old 45° piece's leg, if the short pieces are one 45° piece: a chamfer must beat it.
          const old = j === k + 1 && Math.abs(Math.abs(dirOf(V, D).x) - Math.SQRT1_2) < 1e-6 ? len(V, D) / Math.SQRT2 : 0;
          let sb = Math.min(setback, k - 1 === 0 ? tx : tx / 2, j + 1 === P.length - 1 ? sx : sx / 2);
          for (let tries = 0; tries < 4 && sb > Math.max(old + 1e-6, Math.min(0.05, width / 4)) && !pts; tries++, sb /= 1.5) {
            const c = [{ x: X.x - u.x * sb, y: X.y - u.y * sb }, { x: X.x + w.x * sb, y: X.y + w.y * sb }];
            if (clearPath(li, [A, ...c, E])) pts = c;
          }
        }
        if (!pts) continue;
        P = [...P.slice(0, k), ...pts, ...P.slice(j + 1)];
      }
      return merged(P);
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
      if (first && P.length > 2 && short(P[0]!, P[1]!) && wellOn(P[1]!, li)) P = P.slice(1);
      if (last && P.length > 2 && short(P[P.length - 2]!, P[P.length - 1]!) && wellOn(P[P.length - 2]!, li)) P = P.slice(0, -1);
      return P;
    };
    for (const [ri, sgm] of raw.entries()) {
      const pieces = soften(sgm.layer, tidy(sgm.layer, smooth(sgm.layer, trimEnds(sgm.layer, merged(sgm.pts), ri === 0, ri === raw.length - 1))));
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
    // Checked on every layer: a route may end in a via onto copper on the other layer.
    const ends = [route.segs[0]?.a ?? vias[0], route.segs[route.segs.length - 1]?.b ?? vias[vias.length - 1], ...vias];
    for (const q of ends) {
      if (!q) continue;
      for (let li = 0; li < L; li++) for (const cp of capsNear(li, q)) if (cp.id === id && cp.route !== key && distToSegment(q, cp.a, cp.b) <= cp.r) route.deps.add(cp.route);
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
  /** A finished piece of route of `net` (half width `half`): inside the board and clear of the edge, of other
   *  nets' fixed copper and of other routes (`own`: the route it belongs to, left out). */
  const pieceOk = (net: string, li: number, a: Vec2, b: Vec2, half: number, own: number) => {
    const id = netId(net);
    const cn = netClear(net);
    const edgeCl = netRule(net, 'boardEdgeClearance', 0.3);
    if (outline && (!pointInPolygon(a, outline) || !pointInPolygon(b, outline))) return false;
    if (!board.segments.every(([p, q]) => segSegDist(a, b, p, q) >= half + edgeCl - 1e-6)) return false;
    for (const sh of shapes) {
      if (sh.layer !== layers[li] || sh.net === net || sh.kind === 'fill') continue;
      const need = half + Math.max(cn, clearanceFor(sh.keepOut, 'trace'), sh.kind === 'pad' ? 0 : pairCl(id, netId(sh.net))) - 1e-6;
      if (sh.box.minX - need > Math.max(a.x, b.x) || sh.box.maxX + need < Math.min(a.x, b.x) || sh.box.minY - need > Math.max(a.y, b.y) || sh.box.maxY + need < Math.min(a.y, b.y)) continue;
      if (sh.edges.some(([p, q, rr]) => segSegDist(a, b, p, q) - rr < need)) return false;
      if (sh.kind === 'pad' && sh.areas[0] && (inArea(a, sh.areas[0]) || inArea(b, sh.areas[0]))) return false;
    }
    for (const cp of capsAlong(li, a, b)) if (cp.id !== id && cp.route !== own && segSegDist(a, b, cp.a, cp.b) - cp.r < half + Math.max(cn, cp.cl, pairCl(id, cp.id)) - 1e-6) return false;
    return true;
  };
  // ---- Shove (P9): a route that runs into routes of other nets first tries to push them aside (walked round
  // the new route, see shove.ts) before they are ripped up. The pushed routes are checked here like any
  // piece of route: clear of fixed copper, the board edge and every other route, and still touching
  // whatever rests on them; otherwise everything goes back as it was and the routes in the way are ripped.
  const tryShove = (ci: number, res: { route: Route; victims: Set<number> }): boolean => {
    if (opts.shove === false || !res.victims.size) return false;
    const r = order[ci]!;
    const live0: ShoveSeg[] = [];
    for (const rt of routes.values()) rt.segs.forEach((sg, k) => live0.push({ uid: `${rt.key}:${k}`, net: rt.net, layer: String(sg.li), a: sg.a, b: sg.b, w: sg.w, locked: false, arc: !!sg.mid, old: true, group: String(rt.key) }));
    const pushers: ShovePusher[] = [
      ...res.route.segs.map((sg) => ({ net: r.net, layers: [String(sg.li)], a: sg.a, b: sg.b, half: sg.w / 2 })),
      ...res.route.vias.map((v) => ({ net: r.net, layers: layers.map((_, li) => String(li)), a: v, b: v, half: netRule(r.net, 'viaDiameter', 0.6) / 2 })),
    ];
    const viaOf = (net: string) => [...routes.values()].filter((rt) => rt.net === net).flatMap((rt) => rt.vias);
    const fixedPt = (net: string, layer: string, q: Vec2, live: ShoveSeg[]) => {
      const li = Number(layer);
      if (padShapes.some((sh) => sh.net === net && sh.layer === layers[li] && sh.areas[0] && inArea(q, sh.areas[0]))) return true;
      if (viaOf(net).some((v) => Math.hypot(v.x - q.x, v.y - q.y) <= netRule(net, 'viaDiameter', 0.6) / 2 + 1e-6)) return true;
      return live.filter((x) => x.net === net && x.layer === layer && (Math.hypot(x.a.x - q.x, x.a.y - q.y) < 1e-6 || Math.hypot(x.b.x - q.x, x.b.y - q.y) < 1e-6)).length !== 2;
    };
    const out = shoveChains(live0, pushers, { clearance: (x, y) => Math.max(netClear(x), netClear(y), pairCl(netId(x), netId(y))), fixed: fixedPt });
    if ('error' in out) return false;
    const changed = new Set<number>();
    for (const u of out.removed) changed.add(Number(u.split(':')[0]));
    for (const x of out.live) if (!x.old) changed.add(Number(x.group));
    if (!changed.size) return false;
    // Put the moved routes in place for a moment, check, and keep or undo.
    const backup = new Map<number, { segs: Route['segs']; caps: Cap[]; length: number }>();
    for (const k of changed) {
      const rt = routes.get(k)!;
      backup.set(k, { segs: rt.segs, caps: rt.caps, length: rt.length });
      for (const cp of rt.caps) fileCap(cp, false);
      const cl = netClear(rt.net);
      const rid = netId(rt.net);
      rt.segs = out.live.filter((x) => Number(x.group) === k).map((x) => ({ li: Number(x.layer), a: x.a, b: x.b, w: x.w }));
      rt.caps = [...rt.segs.map((sg) => ({ li: sg.li, a: sg.a, b: sg.b, r: sg.w / 2, id: rid, cl, route: k })), ...rt.vias.flatMap((v) => layers.map((_, li) => ({ li, a: v, b: v, r: netRule(rt.net, 'viaDiameter', 0.6) / 2, id: rid, cl, route: k })))];
      rt.length = rt.segs.reduce((t, sg) => t + Math.hypot(sg.b.x - sg.a.x, sg.b.y - sg.a.y), 0);
      for (const cp of rt.caps) fileCap(cp, true);
    }
    let ok = true;
    for (const k of changed) {
      const rt = routes.get(k)!;
      for (const sg of rt.segs) if (ok && !pieceOk(rt.net, sg.li, sg.a, sg.b, sg.w / 2, k)) ok = false;
    }
    // The new route itself, now that the others moved.
    for (const sg of res.route.segs) if (ok && !pieceOk(r.net, sg.li, sg.a, sg.b, sg.w / 2, res.route.key)) ok = false;
    for (const cp of res.route.caps) for (const o of capsAlong(cp.li, cp.a, cp.b)) if (ok && o.id !== cp.id && segSegDist(cp.a, cp.b, o.a, o.b) - o.r - cp.r < Math.max(cp.cl, o.cl, pairCl(cp.id, o.id)) - 1e-6) ok = false;
    // Routes that end on a moved route must still touch it.
    for (const other of routes.values()) {
      if (!ok) break;
      for (const k of changed) {
        if (!other.deps.has(k)) continue;
        const rt = routes.get(k)!;
        const ends = [other.segs[0]?.a, other.segs[other.segs.length - 1]?.b, ...other.vias].filter((q): q is Vec2 => !!q);
        if (!ends.some((q) => rt.caps.some((cp) => distToSegment(q, cp.a, cp.b) <= cp.r + 1e-6))) ok = false;
      }
    }
    if (!ok) {
      for (const [k, bk] of backup) {
        const rt = routes.get(k)!;
        for (const cp of rt.caps) fileCap(cp, false);
        Object.assign(rt, bk);
        for (const cp of rt.caps) fileCap(cp, true);
      }
      return false;
    }
    report.shoved = (report.shoved ?? 0) + 1;
    return true;
  };
  /** One pair, routed together (see below). Returns the two routes, or undefined to route them one by one. */
  const routePair = (pNet: string, nNet: string, pa: Vec2, pb: Vec2, na: Vec2, nb: Vec2, gap: number): { p: Route; n: Route } | undefined => {
    const idP = netId(pNet);
    const idN = netId(nNet);
    const w = Math.max(netRule(pNet, 'traceWidth', 0.25), netRule(nNet, 'traceWidth', 0.25));
    const cn = Math.max(netClear(pNet), netClear(nNet));
    const viaD = Math.max(netRule(pNet, 'viaDiameter', 0.6), netRule(nNet, 'viaDiameter', 0.6));
    const edgeCl = Math.max(netRule(pNet, 'boardEdgeClearance', 0.3), netRule(nNet, 'boardEdgeClearance', 0.3));
    const off = (w + gap) / 2; // trace centre from the path centre
    const half = off + w / 2; // half width of the pair
    const viaOff = Math.max(off, (viaD + Math.max(gap, cn)) / 2); // via centre from the path centre
    const viaHalf = viaOff + viaD / 2;
    const own = (k: number) => k === 0 || k === idP || k === idN;
    // Clearance to copper of net k already on the board: with the pair clearance, as the check of each
    // piece afterwards asks (the field does not tell pads from traces, so near pads it is stricter).
    const ownerCl = (k: number) => Math.max(cn, pairCl(idP, k), pairCl(idN, k));
    // Room for the pair's body (half width h) at cell c of layer li.
    const room = (li: number, c: number, h: number) => {
      if (!own(core[li]![c]!)) return false;
      if (edgeDist[c]! < h + edgeCl - 1e-6) return false;
      const f = field[li]!;
      let m = Math.min(f.zd[c]! - cn, f.ze[c]!);
      if (!own(f.o1[c]!)) m = Math.min(m, f.d1[c]! - ownerCl(f.o1[c]!), f.e1[c]!);
      if (!own(f.o2[c]!)) m = Math.min(m, f.d2[c]! - ownerCl(f.o2[c]!), f.e2[c]!);
      if (m < h + g * 0.71 - 1e-6) return false;
      const i = c % W;
      const q = { x: cx(i), y: cy((c - i) / W) };
      for (const cp of capsNear(li, q)) if (cp.id !== idP && cp.id !== idN && distToSegment(q, cp.a, cp.b) - cp.r < h + Math.max(cn, cp.cl, pairCl(idP, cp.id), pairCl(idN, cp.id)) - 1e-6) return false;
      return true;
    };
    const ma = { x: (pa.x + na.x) / 2, y: (pa.y + na.y) / 2 };
    const minRun = Math.ceil(((w + gap) / 2) / g) + 1;
    const endR = Math.max(Math.hypot(pa.x - na.x, pa.y - na.y), Math.hypot(pb.x - nb.x, pb.y - nb.y)) / 2 + 1.5;
    const mb = { x: (pb.x + nb.x) / 2, y: (pb.y + nb.y) / 2 };
    // Search box: the two middles and a margin.
    const margin = 8;
    const i0 = Math.max(0, toI(Math.min(ma.x, mb.x) - margin)), i1 = Math.min(W - 1, toI(Math.max(ma.x, mb.x) + margin));
    const j0 = Math.max(0, toJ(Math.min(ma.y, mb.y) - margin)), j1 = Math.min(H - 1, toJ(Math.max(ma.y, mb.y) + margin));
    const D8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const viaSteps = (netRule(pNet, 'viaCost', 0) || 4) / g;
    // Start and goal: cells with room for the pair near each middle, any first direction.
    const near = (m: Vec2) => {
      const out: number[] = [];
      const R = Math.ceil(Math.max(Math.hypot(pa.x - na.x, pa.y - na.y) / 4, 2 * g) / g);
      const ci = toI(m.x), cj = toJ(m.y);
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const i = ci + di, j = cj + dj;
        if (i < i0 || i > i1 || j < j0 || j > j1 || di * di + dj * dj > R * R) continue;
        for (let li = 0; li < L; li++) if (room(li, j * W + i, half)) out.push(li * N + j * W + i);
      }
      return out;
    };
    const starts = near(ma);
    const goals = new Set(near(mb));
    if (!starts.length || !goals.size) return undefined;
    const gi = toI(mb.x), gj = toJ(mb.y);
    const hcost = (c: number) => {
      const i = c % W, j = (c - i) / W;
      const dx = Math.abs(i - gi), dy = Math.abs(j - gj);
      // Weighted a little (1.3): the pair's search space is eight directions per cell, and an exact A* spends
      // its time on equal-cost detours.
      return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    };
    const best = new Map<number, number>();
    const from = new Map<number, number>();
    const heap = new Heap();
    const sid = (st: number, d: number) => st * 8 + d;
    // Direction d runs square to the line between the two pads of an end (within a few degrees).
    const square = (d: number, p: Vec2, q: Vec2) => {
      const [di, dj] = D8[d]!;
      const l = Math.hypot(q.x - p.x, q.y - p.y) * Math.hypot(di, dj);
      return l < 1e-9 || Math.abs((q.x - p.x) * di + (q.y - p.y) * dj) / l < 0.1;
    };
    for (const st of starts) {
      const i = st % N % W, j = ((st % N) - i) / W;
      // Starting away from the middle costs extra, so both breakouts stay short and alike.
      const startCost = (4 * Math.hypot(cx(i) - ma.x, cy(j) - ma.y)) / g;
      for (let d = 0; d < 8; d++) {
        // The pair leaves its pads square to the line between them, as a person draws it.
        if (!square(d, pa, na)) continue;
        const k = sid(st, d);
        best.set(k, startCost);
        from.set(k, -1);
        heap.push(startCost + hcost(st % N), k);
      }
    }
    // Ending away from the middle costs extra too: a goal cell is a candidate end at its cost plus that; the
    // search stops once nothing left in the heap can beat the best candidate.
    let found = -1;
    let foundCost = Infinity;
    let pops = 0;
    const closed = new Set<number>();
    while (heap.size) {
      const k = heap.pop();
      // Each state is expanded once (later, stale heap entries for it are skipped).
      if (closed.has(k)) continue;
      closed.add(k);
      if (++pops > 600000) break;
      const st = Math.floor(k / 8), d = k % 8;
      const cost = best.get(k)!;
      if (cost + hcost(st % N) >= foundCost) break;
      if (goals.has(st) && square(d, pb, nb)) {
        const c0 = st % N, i0g = c0 % W;
        const end = cost + (4 * Math.hypot(cx(i0g) - mb.x, cy((c0 - i0g) / W) - mb.y)) / g;
        if (end < foundCost) (foundCost = end), (found = k);
      }
      const li = Math.floor(st / N), c = st % N;
      const i = c % W, j = (c - i) / W;
      // Straight on, or a 45° turn either way; never 90° or more in one place. Close to either end the pair
      // runs straight (square to its pads), so the breakouts stay short and mirror each other.
      const qx = cx(i), qy = cy(j);
      const nearEnd = Math.hypot(qx - ma.x, qy - ma.y) < endR || Math.hypot(qx - mb.x, qy - mb.y) < endR;
      // A turn only after a straight run of a few cells on this layer, so the two traces' corners (offset to
      // either side) do not fold over each other or back behind a via pair just placed.
      let run = 0;
      for (let q = k; q >= 0 && q % 8 === d && Math.floor(q / 8 / N) === li && run < minRun; q = from.get(q)!) run++;
      const turns = !nearEnd && run >= minRun;
      for (const nd of turns ? [d, (d + 1) % 8, (d + 7) % 8] : [d]) {
        const [di, dj] = D8[nd]!;
        const ni = i + di, nj = j + dj;
        if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
        const nc = nj * W + ni;
        if (!room(li, nc, half)) continue;
        // No corner cutting on diagonals.
        if (di && dj && (!room(li, j * W + ni, half) || !room(li, nj * W + i, half))) continue;
        const ns = li * N + nc;
        const nk = sid(ns, nd);
        const nCost = cost + (di && dj ? Math.SQRT2 : 1) + (nd !== d ? 2.5 : 0);
        if (nCost < (best.get(nk) ?? Infinity) - 1e-9) {
          best.set(nk, nCost);
          from.set(nk, k);
          heap.push(nCost + hcost(nc), nk);
        }
      }
      // A pair of vias here, on a straight run (the path goes on in the same direction on the other layer):
      // room for them on every layer.
      for (let lj = 0; lj < L && run >= minRun; lj++) {
        if (lj === li) continue;
        let ok = true;
        for (let lk = 0; lk < L && ok; lk++) if (!room(lk, c, viaHalf)) ok = false;
        if (!ok) continue;
        const ns = lj * N + c;
        const nk = sid(ns, d);
        const nCost = cost + 2 * viaSteps;
        if (nCost < (best.get(nk) ?? Infinity) - 1e-9) {
          best.set(nk, nCost);
          from.set(nk, k);
          heap.push(nCost + hcost(c), nk);
        }
      }
    }
    if (found < 0) return undefined;
    // The centre path per layer, corners only where the direction changes.
    const states: number[] = [];
    for (let k = found; k >= 0; k = from.get(k)!) states.push(k);
    states.reverse();
    type Leg = { li: number; pts: Vec2[] };
    const legs: Leg[] = [];
    const viaAt: Vec2[] = [];
    for (const k of states) {
      const st = Math.floor(k / 8), li = Math.floor(st / N), c = st % N, i = c % W;
      const q = { x: cx(i), y: cy((c - i) / W) };
      const cur = legs[legs.length - 1];
      if (!cur || cur.li !== li) {
        if (cur) viaAt.push(q);
        legs.push({ li, pts: [q] });
      } else {
        const P = cur.pts;
        if (P.length >= 2) {
          const a = P[P.length - 2]!, b = P[P.length - 1]!;
          if (Math.abs((b.x - a.x) * (q.y - b.y) - (b.y - a.y) * (q.x - b.x)) < 1e-9) P.pop();
        }
        P.push(q);
      }
    }
    // Which side P runs on: the side of its pad at the start; it must be the same side at the end (a pair
    // that swaps sides would have to cross).
    const sideAt = (P: Vec2[], at: 'start' | 'end', q: Vec2) => {
      const a = at === 'start' ? P[0]! : P[P.length - 2] ?? P[0]!;
      const b = at === 'start' ? P[1] ?? P[0]! : P[P.length - 1]!;
      const dx = b.x - a.x, dy = b.y - a.y;
      const o = at === 'start' ? a : b;
      return Math.sign(dx * (q.y - o.y) - dy * (q.x - o.x));
    };
    const first = legs[0]!, last = legs[legs.length - 1]!;
    if (first.pts.length < 2 || last.pts.length < 2) return undefined;
    const sP = sideAt(first.pts, 'start', pa);
    if (!sP || sideAt(last.pts, 'end', pb) !== sP) return undefined;
    // Offset a polyline by s (left normal positive), corners where the offset lines meet.
    const offset = (P: Vec2[], s: number): Vec2[] => {
      const nrm = (a: Vec2, b: Vec2) => {
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
        return { x: -dy / l, y: dx / l };
      };
      const out: Vec2[] = [];
      for (let k = 0; k < P.length; k++) {
        if (k === 0 || k === P.length - 1) {
          const n = k === 0 ? nrm(P[0]!, P[1]!) : nrm(P[k - 1]!, P[k]!);
          out.push({ x: P[k]!.x + n.x * s, y: P[k]!.y + n.y * s });
          continue;
        }
        const n1 = nrm(P[k - 1]!, P[k]!), n2 = nrm(P[k]!, P[k + 1]!);
        const bx = n1.x + n2.x, by = n1.y + n2.y;
        const dot = (bx * n1.x + by * n1.y) || 1;
        out.push({ x: P[k]!.x + (bx / dot) * s, y: P[k]!.y + (by / dot) * s });
      }
      return out;
    };
    const build = (net: string, side: number, from: Vec2, to: Vec2) => {
      const pieces: { li: number; a: Vec2; b: Vec2 }[] = [];
      const vias: Vec2[] = [];
      const add = (li: number, pts: Vec2[]) => {
        for (let k = 0; k + 1 < pts.length; k++) if (Math.hypot(pts[k + 1]!.x - pts[k]!.x, pts[k + 1]!.y - pts[k]!.y) > 1e-6) pieces.push({ li, a: pts[k]!, b: pts[k + 1]! });
      };
      let prevEnd: Vec2 = from;
      // A 45° breakout: from the pad straight onto this net's line, meeting it as far along as the pad lies
      // to the side of it (the line's first or last piece runs straight, see the search above).
      const onto = (q: Vec2, a: Vec2, b: Vec2, atStart: boolean) => {
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
        const o = atStart ? a : b;
        const v = { x: q.x - o.x, y: q.y - o.y };
        const along = v.x * u.x + v.y * u.y;
        const perp = Math.abs(v.x * u.y - v.y * u.x);
        const t = atStart ? Math.max(0, along + perp) : Math.min(0, along - perp);
        return { x: o.x + u.x * t, y: o.y + u.y * t, t: Math.abs(t), l };
      };
      // Near a via the line steps out by the difference of the via's and the line's offsets, at 45°.
      const step = Math.max(0, viaOff - off);
      const trim = (P: Vec2[], atStart: boolean): Vec2[] => {
        if (step < 1e-6 || P.length < 2) return P;
        const a = atStart ? P[0]! : P[P.length - 1]!;
        const b = atStart ? P[1]! : P[P.length - 2]!;
        const l = Math.hypot(b.x - a.x, b.y - a.y);
        if (l <= step + 1e-6) return P;
        const q = { x: a.x + ((b.x - a.x) / l) * step, y: a.y + ((b.y - a.y) / l) * step };
        return atStart ? [q, ...P.slice(1)] : [...P.slice(0, -1), q];
      };
      legs.forEach((leg, li) => {
        let line = offset(leg.pts, side * off);
        if (li > 0) line = trim(line, true);
        if (li + 1 < legs.length) line = trim(line, false);
        // Breakout from the pad (first leg) or from this net's via (later legs).
        const startPt = li === 0 ? from : vias[vias.length - 1]!;
        if (li === 0 && line.length >= 2) {
          const X = onto(startPt, line[0]!, line[1]!, true);
          if (X.t < X.l - 1e-6) line = [{ x: X.x, y: X.y }, ...line.slice(1)];
        }
        if (li === legs.length - 1 && line.length >= 2) {
          const Y = onto(to, line[line.length - 2]!, line[line.length - 1]!, false);
          if (Y.t < Y.l - 1e-6 && (line.length > 2 || li > 0 || Y.t + 1e-6 < Math.hypot(line[1]!.x - line[0]!.x, line[1]!.y - line[0]!.y))) line = [...line.slice(0, -1), { x: Y.x, y: Y.y }];
        }
        add(leg.li, li === 0 ? [startPt, ...route45(startPt, line[0]!, false).slice(1), ...line.slice(1)] : [startPt, ...line]);
        if (li + 1 < legs.length) {
          // This net's via, beside the centre path's via, across the direction of travel.
          const P = leg.pts;
          const a = P[P.length - 2] ?? P[0]!, b = P[P.length - 1]!;
          const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
          const v = { x: viaAt[li]!.x - (dy / l) * side * viaOff, y: viaAt[li]!.y + (dx / l) * side * viaOff };
          add(leg.li, [line[line.length - 1]!, v]);
          vias.push(v);
        } else {
          prevEnd = line[line.length - 1]!;
          add(leg.li, [prevEnd, ...route45(prevEnd, to, true).slice(1)]);
        }
      });
      return { pieces, vias, net };
    };
    const P = build(pNet, sP, pa, pb);
    const Nn = build(nNet, -sP, na, nb);
    // Check every piece and via like any route.
    for (const side of [P, Nn]) {
      const id = netId(side.net);
      for (const pc of side.pieces) if (!pieceOk(side.net, pc.li, pc.a, pc.b, w / 2, -1)) return undefined;
      for (const v of side.vias) for (let li = 0; li < L; li++) if (!pieceOk(side.net, li, v, v, viaD / 2, -1)) return undefined;
      // The two halves keep their gap from each other (the partner is another net).
      const other = side === P ? Nn : P;
      for (const pc of side.pieces)
        for (const oc of other.pieces)
          if (pc.li === oc.li && segSegDist(pc.a, pc.b, oc.a, oc.b) < w + Math.min(gap, cn) - 1e-6) return undefined;
      for (const v of side.vias) for (const u of other.vias) if (Math.hypot(v.x - u.x, v.y - u.y) < viaD + cn - 1e-6) return undefined;
      void id;
    }
    const mk = (side: typeof P): Route => {
      const key = ++routeKey;
      const id = netId(side.net);
      const cl = netClear(side.net);
      const route: Route = { key, conn: -1, net: side.net, id, caps: [], segs: [], vias: side.vias, length: 0, deps: new Set() };
      for (const pc of side.pieces) {
        route.segs.push({ li: pc.li, a: pc.a, b: pc.b, w });
        route.caps.push({ li: pc.li, a: pc.a, b: pc.b, r: w / 2, id, cl, route: key });
        route.length += Math.hypot(pc.b.x - pc.a.x, pc.b.y - pc.a.y);
      }
      for (const v of side.vias) for (let li = 0; li < L; li++) route.caps.push({ li, a: v, b: v, r: viaD / 2, id, cl, route: key });
      return route;
    };
    return { p: mk(P), n: mk(Nn) };
  };
  // ---- Differential pairs routed together (P10). Two connections of a pair (nets with a `diffGap`, each the
  // other's partner) whose ends lie side by side are routed as one path of width 2·w + gap between the
  // middles of their pad pairs, with 45° turns only, then split into two traces (w each, gap apart) on
  // either side of it; a layer change becomes two vias side by side. Each pad is joined to its trace with a
  // short 45° breakout. Every piece is checked like any piece of route; if anything fails, the two
  // connections are routed one by one as before.
  const pairOf = new Map<string, string>();
  for (const n of netNode.values()) {
    const w = n.props.pairWith;
    if (typeof w === 'string' && netNode.has(w)) pairOf.set(n.name, w), pairOf.set(w, n.name);
  }
  // Partners by name too (X_P / X_N …), as netSignals finds them.
  for (const x of pairSignals) if (x.pair && !pairOf.has(x.net)) pairOf.set(x.net, x.pair);
  const pairedConn = new Set<number>();
  if (opts.pairs !== false) {
    const done = new Set<string>();
    for (const [pNet, nNet] of pairOf) {
      if (done.has(pNet) || done.has(nNet)) continue;
      done.add(pNet).add(nNet);
      const gap = netRule(pNet, 'diffGap', 0);
      if (!gap || !netRule(nNet, 'diffGap', 0)) continue;
      const cP = order.map((r, i) => [r, i] as const).filter(([r]) => r.net === pNet);
      const cN = order.map((r, i) => [r, i] as const).filter(([r]) => r.net === nNet);
      for (const [rp, ip] of cP) {
        // The partner's connection with its ends next to these (either way round).
        let best: { rn: (typeof rats)[number]; inn: number; flip: boolean; d: number } | undefined;
        for (const [rn, inn] of cN) {
          if (pairedConn.has(inn)) continue;
          for (const flip of [false, true]) {
            const na = flip ? rn.b : rn.a;
            const nb = flip ? rn.a : rn.b;
            const d = Math.max(Math.hypot(na.x - rp.a.x, na.y - rp.a.y), Math.hypot(nb.x - rp.b.x, nb.y - rp.b.y));
            if (d <= 5 && (!best || d < best.d)) best = { rn, inn, flip, d };
          }
        }
        if (!best || routeOf.has(ip) || routeOf.has(best.inn)) continue;
        const na = best.flip ? best.rn.b : best.rn.a;
        const nb = best.flip ? best.rn.a : best.rn.b;
        const res = routePair(rp.net, best.rn.net, rp.a, rp.b, na, nb, gap);
        if (!res) continue;
        commit(ip, res.p);
        commit(best.inn, res.n);
        pairedConn.add(ip).add(best.inn);
        report.pairs = (report.pairs ?? 0) + 1;
      }
    }
  }
  let pending = order.map((_, i) => i);
  let pres = 2;
  let timedOut = false;
  let told = 0;
  const tell = (round: number, force = false) => {
    if (!opts.onProgress) return;
    const now = performance.now();
    if (!force && now - told < 150) return;
    told = now;
    opts.onProgress({ round, routed: routeOf.size + joined.size, total: order.length });
  };
  for (let round = 0; round < maxRounds && pending.length && !timedOut; round++) {
    const again = new Set<number>();
    tell(round, true);
    for (const ci of pending) {
      tell(round);
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
      let res = round + 1 < maxRounds ? routeConn(r, pres, hist) : hard;
      // A bus lane that cannot be kept (even by ripping up others) is given up for this connection.
      if (!res.ok && lanes.has(r)) {
        const free = routeConn(r, Infinity, hist, true);
        res = free.ok ? free : round + 1 < maxRounds ? routeConn(r, pres, hist, true) : free;
      }
      if (!res.ok) {
        // Blocked by fixed copper, not by other routes of this run: no rip-up can help.
        failReason.set(ci, res.ok === false && !res.joined ? res.reason : hard.reason);
        continue;
      }
      for (const s of res.contested) hist[s] = hist[s]! + 1;
      if (tryShove(ci, res)) {
        commit(ci, res.route);
        continue;
      }
      for (const v of res.victims) rip(v, again);
      commit(ci, res.route);
    }
    pending = [...again].sort((a, b) => a - b);
    pres *= 1.6;
  }
  for (const ci of pending) if (!routeOf.has(ci) && !joined.has(ci)) failReason.set(ci, timedOut ? 'time limit' : 'congestion: could not be fitted in after rip-up and retry');


  // ---- Emit, in the order the connections were planned.
  const nextIndex = new Map<string, number>();
  const emitted: Route[] = [];
  const emittedAt: number[] = [];
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
    const uids: string[] = [];
    for (const s of route.segs) {
      const rules: RuleDecl[] = [{ name: 'start', value: s.a }, { name: 'end', value: s.b }, { name: 'layer', value: layers[s.li]! }];
      if (s.mid) rules.push({ name: 'mid', value: s.mid });
      if (s.w < width) rules.push({ name: 'traceWidth', value: s.w });
      const uid = newUid('tr');
      uids.push(uid);
      ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid, type: 'trace', name: '', props: { autorouted: true }, rules, parent: node.uid, children: [] }] } });
    }
    for (const v of route.vias) {
      const uid = newUid('via');
      uids.push(uid);
      ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid, type: 'via', name: '', props: { autorouted: true }, rules: [{ name: 'position', value: v }, { name: 'layers', value: [...copper] }], parent: node.uid, children: [] }] } });
    }
    nextIndex.set(node.uid, idx);
    report.routed.push({ net: r.net, from: r.a, to: r.b, length: Math.round(route.length * 1000) / 1000, vias: route.vias.length, uids });
    emitted.push(route);
    emittedAt.push(report.routed.length - 1);
  }
  // A fanout stub is written by the route that leaves from it. A route may also end on a stub without
  // taking it in (its ratsnest point lay on the stub, or the pad's own connection went inwards to the
  // exposed pad): then the stub is written here, so the copper reaches the pad.
  for (const f of fans) {
    if (f.off) continue;
    const mine = emitted.filter((rt) => rt.net === f.pad.net);
    const onStub = (q: Vec2) => distToSegment(q, f.a, f.e) <= f.half + 1e-6 && !(f.pad.areas[0] && inArea(q, f.pad.areas[0]));
    const touched = mine.some((rt) => rt.segs.some((sg) => sg.li === f.li && (onStub(sg.a) || onStub(sg.b))) || rt.vias.some(onStub));
    const has = mine.some((rt) => rt.segs.some((sg) => sg.li === f.li && [sg.a, sg.b].some((q) => Math.hypot(q.x - f.a.x, q.y - f.a.y) < 1e-6) && [sg.a, sg.b].some((q) => distToSegment(q, f.a, f.e) <= 1e-6 && Math.hypot(q.x - f.a.x, q.y - f.a.y) > 1e-6)));
    const node = netNode.get(f.pad.net!);
    if (!touched || has || !node) continue;
    const width = netRule(f.pad.net!, 'traceWidth', 0.25);
    let idx = nextIndex.get(node.uid) ?? node.children.length;
    const rules: RuleDecl[] = [{ name: 'start', value: f.a }, { name: 'end', value: f.e }, { name: 'layer', value: layers[f.li]! }];
    if (2 * f.half < width - 1e-9) rules.push({ name: 'traceWidth', value: Math.round(2 * f.half * 1000) / 1000 });
    const uid = newUid('tr');
    ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid, type: 'trace', name: '', props: { autorouted: true }, rules, parent: node.uid, children: [] }] } });
    // The stub belongs to every connection that ends on it: taking one of them out takes the stub too.
    emitted.forEach((rt, k) => {
      if (rt.net === f.pad.net && (rt.segs.some((sg) => sg.li === f.li && (onStub(sg.a) || onStub(sg.b))) || rt.vias.some(onStub))) report.routed[emittedAt[k]!]!.uids!.push(uid);
    });
    nextIndex.set(node.uid, idx);
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
