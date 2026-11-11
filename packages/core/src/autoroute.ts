/**
 * Grid autorouter: routes the ratsnest connections one by one with A* over a grid per
 * copper layer (8 directions → 45° traces) with through vias, keeping each net's
 * clearance from other copper. Our own straightforward maze router: no rip-up and retry,
 * no push-and-shove. Connections it cannot complete are reported, never forced.
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
  /** Stop after this many milliseconds (default 20 s). */
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

  // Per layer: `core` = copper owner (net id, -1 for no-net copper / outside the board),
  // `halo` = clearance zone owner (net id, -1 where two nets' zones meet).
  const core = layers.map(() => new Int32Array(N));
  const haloA = layers.map(() => new Int32Array(N));
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
  // Widest trace half-width + clearance among nets we route: the halo kept around foreign copper.
  const routedNets = [...new Set(rats.map((r) => r.net))];
  let halo = 0;
  for (const n of routedNets) halo = Math.max(halo, netRule(n, 'traceWidth', 0.25) / 2 + netClear(n));
  const diag = g * 0.75;

  /** Mark copper (and its halo) of `id` on layer `li`. Cells claimed by two nets become blocked. */
  const paint = (li: number, id: number, s: { edges: [Vec2, Vec2, number][]; areas: Vec2[][][] }, extra: number) => {
    const co = core[li]!;
    const ha = haloA[li]!;
    const setCore = (c: number) => {
      const v = co[c]!;
      if (v === 0 || v === id || (v === -1 && id > 0)) co[c] = id;
    };
    // Edges (traces, vias, outlines) as capsules: copper inside, clearance halo around.
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
          else if (ha[c] === 0) ha[c] = id;
          else if (ha[c] !== id) ha[c] = -1;
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
    paint(li, id, { edges: s.kind === 'fill' ? [] : s.edges, areas: s.kind === 'fill' || s.kind === 'pad' ? s.areas : [] }, Math.max(halo, clearanceFor(s.keepOut, 'trace') + halo - 0.2) + diag);
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
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;

  for (const r of order) {
    if (performance.now() - t0 > limit) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'time limit' });
      continue;
    }
    const id = netId(r.net);
    const width = netRule(r.net, 'traceWidth', 0.25);
    const viaD = netRule(r.net, 'viaDiameter', 0.6);
    const viaR = Math.ceil((viaD / 2 + netClear(r.net) - width / 2) / g);
    // Own copper is usable only where it is also clear of other nets' halo (a trace inside
    // its own pad can still stick out towards a neighbour); the end cells are always allowed.
    let endA = -1;
    let endB = -1;
    const usable = (li: number, c: number) => {
      if (c === endA || c === endB) return core[li]![c] === id;
      const k = core[li]![c]!;
      if (k !== 0 && k !== id) return false;
      const h = haloA[li]![c]!;
      return h === 0 || h === id;
    };
    const viaOk = (c: number) => {
      const i = c % W;
      const j = (c - i) / W;
      for (let li = 0; li < L; li++)
        for (let dj = -viaR; dj <= viaR; dj++)
          for (let di = -viaR; di <= viaR; di++) {
            if (di * di + dj * dj > viaR * viaR) continue;
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= W || jj >= H || padMask[jj * W + ii] || !usable(li, jj * W + ii)) return false;
          }
      return true;
    };
    // Endpoints: the layers where the net's copper sits at each end.
    const ends = (p: Vec2) => {
      const c = toJ(p.y) * W + toI(p.x);
      const ls: number[] = [];
      for (let li = 0; li < L; li++) if (core[li]![c] === id) ls.push(li);
      return { c, ls };
    };
    const A = ends(r.a);
    const B = ends(r.b);
    endA = A.c;
    endB = B.c;
    if (!A.ls.length || !B.ls.length || toI(r.a.x) < 0 || toI(r.b.x) >= W) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'endpoint is blocked by nearby copper' });
      continue;
    }
    run++;
    const heap = new Heap();
    const bi = B.c % W;
    const bj = (B.c - bi) / W;
    const hcost = (c: number) => {
      const i = c % W;
      const j = (c - i) / W;
      const dx = Math.abs(i - bi);
      const dy = Math.abs(j - bj);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    for (const li of A.ls) {
      const s = li * N + A.c;
      stamp[s] = run;
      cost[s] = 0;
      from[s] = -1;
      heap.push(hcost(A.c), s);
    }
    const goal = new Set(B.ls.map((li) => li * N + B.c));
    let found = -1;
    let expanded = 0;
    while (heap.size) {
      const s = heap.pop();
      if (goal.has(s)) {
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
    for (let s = found; s >= 0; s = from[s]!) cells.push({ li: Math.floor(s / N), c: s % N });
    cells.reverse();
    // Claim the path (with halo) so later connections keep clear.
    const pts = (k: number) => ({ x: cx(cells[k]!.c % W), y: cy(Math.floor(cells[k]!.c / W)) });
    const segs: { layer: number; pts: Vec2[] }[] = [];
    const vias: Vec2[] = [];
    let cur: { layer: number; pts: Vec2[] } = { layer: cells[0]!.li, pts: [r.a] };
    for (let k = 0; k < cells.length; k++) {
      const p = pts(k);
      if (cells[k]!.li !== cur.layer) {
        cur.pts.push(p);
        segs.push(cur);
        vias.push(p);
        cur = { layer: cells[k]!.li, pts: [p] };
      } else cur.pts.push(p);
    }
    cur.pts.push(r.b);
    segs.push(cur);

    // Neck down where a trace end sits inside a foreign clearance zone (fine-pitch pads).
    const minTrace = netRule(r.net, 'traceWidthMin', 0.15);
    const neckAt = (p: Vec2, cell: number, li: number): number | null => {
      const h = haloA[li]![cell]!;
      if (h === 0 || h === id) return null;
      let best = Infinity;
      for (const sh of shapes) {
        if (sh.kind !== 'pad' || sh.net !== r.net || sh.layer !== layers[li] || !sh.areas[0] || !inArea(p, sh.areas[0])) continue;
        best = Math.min(best, sh.box.maxX - sh.box.minX, sh.box.maxY - sh.box.minY);
      }
      return Number.isFinite(best) && best < width ? best : null;
    };
    const neckA = neckAt(r.a, A.c, cells[0]!.li);
    const neckB = neckAt(r.b, B.c, cells[cells.length - 1]!.li);
    if ((neckA !== null && neckA < minTrace) || (neckB !== null && neckB < minTrace)) {
      report.failed.push({ net: r.net, from: r.a, to: r.b, reason: 'pad is narrower than the minimum trace width' });
      continue;
    }
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
        const near = (q: Vec2) => Math.min(Math.hypot(a.x - q.x, a.y - q.y), Math.hypot(b.x - q.x, b.y - q.y)) < g * 1.5;
        const neck = neckA !== null && near(r.a) ? neckA : neckB !== null && near(r.b) ? neckB : null;
        const rules: RuleDecl[] = [{ name: 'start', value: a }, { name: 'end', value: b }, { name: 'layer', value: layers[sgm.layer]! }];
        if (neck !== null) rules.push({ name: 'traceWidth', value: Math.floor(neck * 1000) / 1000 });
        ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: { autorouted: true }, rules, parent: node.uid, children: [] }] } });
      }
      paint(sgm.layer, id, { edges: simple.slice(1).map((b, k) => [simple[k]!, b, width / 2] as [Vec2, Vec2, number]), areas: [] }, halo + diag);
    });
    for (const v of vias) {
      ops.push({ op: 'add', parent: node.uid, index: idx++, tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', props: { autorouted: true }, rules: [{ name: 'position', value: v }, { name: 'layers', value: [...copper] }], parent: node.uid, children: [] }] } });
      for (let li = 0; li < L; li++) paint(li, id, { edges: [[v, v, viaD / 2]], areas: [] }, halo + diag);
    }
    report.routed.push({ net: r.net, from: r.a, to: r.b, length: Math.round(length * 1000) / 1000, vias: vias.length });
  }
  report.ms = Math.round(performance.now() - t0);
  return { ops, report };
}
