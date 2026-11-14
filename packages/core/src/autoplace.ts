/**
 * Autoplacer: moves components onto the board, connected parts near each other, without overlapping
 * courtyards. First greedy (largest / most connected first, spiral search around the parts it connects
 * to); then an improvement pass (P11, docs/05-pcb-improvements.md): simulated annealing, written from
 * the textbook description, that moves, swaps and turns parts (0 / 90 / 180 / 270°) to shorten the total
 * ratsnest (half-perimeter per net), with penalties for courtyard overlap and leaving the board, keeps
 * the parts of a schematic block (group box, or sheet when there are several) together, places each
 * decoupling capacitor next to its IC's power pin and moves it with the IC (several ICs on one supply share
 * its capacitors), and puts connectors with the
 * part property `placeAtEdge` against the board edge, facing out. Locked parts stay.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { boardOutline } from './copper.ts';
import { frameOf, padGeom, toWorld } from './frames.ts';
import { distToSegment, place, pointInPolygon } from './geom.ts';
import { netSignals } from './signal.ts';

export interface AutoplaceOptions {
  /** Place these references (default: every part that is not on the board yet). */
  refs?: string[];
  /** Also re-place parts that are already on the board. */
  all?: boolean;
  /** Space kept between parts and from the board edge (mm, default 0.5). */
  spacing?: number;
  /** Improvement pass after the greedy placement (default true). */
  improve?: boolean;
  /** Annealing moves per run (default 20000 per part, at most 1.5 million). */
  iterations?: number;
  /** Seed of the pseudo-random moves (default 1), so a run can be repeated. */
  seed?: number;
  /** Try turning parts by 90° steps (default true). */
  rotate?: boolean;
  /** Annealing runs from the greedy start, each with its own seed, made legal; the best is kept (default 3). */
  restarts?: number;
  /** Progress of the improvement pass, now and then (run, share of its moves done). */
  onProgress?: (p: { run: number; runs: number; done: number }) => void;
}

export interface AutoplaceReport {
  placed: { ref: string; at: Vec2; rotation?: number }[];
  failed: string[];
  /** Total ratsnest length (half-perimeter per net, mm) after the greedy start and after improving. */
  ratsnest?: { greedy: number; improved: number };
  /** Decoupling capacitors placed with their IC. */
  decoupling?: { cap: string; ic: string; pin: string }[];
  /** Parts kept together per schematic block. */
  clusters?: { block: string; parts: string[] }[];
  /** Connectors placed against the board edge. */
  atEdge?: string[];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** Extent of a component relative to its origin (pads + courtyard), in board orientation. */
export function componentExtent(doc: Doc, engine: StyleEngine, el: DocNode, copper: string[]): Box {
  const pos = vec(engine.get(el.uid, 'position')?.value) ?? { x: 0, y: 0 };
  const b: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (p: Vec2) => {
    b.minX = Math.min(b.minX, p.x - pos.x);
    b.minY = Math.min(b.minY, p.y - pos.y);
    b.maxX = Math.max(b.maxX, p.x - pos.x);
    b.maxY = Math.max(b.maxY, p.y - pos.y);
  };
  for (const c of el.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'pad') {
      const g = padGeom(doc, engine, n, copper);
      if (g) g.outline.forEach(add);
    } else if (String(engine.get(n.uid, 'layer')?.value ?? '').includes('CrtYd')) {
      const f = frameOf(doc, engine, n);
      const pts = (engine.get(n.uid, 'points')?.value as Vec2[] | undefined) ?? [vec(engine.get(n.uid, 'start')?.value), vec(engine.get(n.uid, 'end')?.value)].filter((x): x is Vec2 => !!x);
      const ctr = vec(engine.get(n.uid, 'center')?.value);
      const r = Number(engine.get(n.uid, 'radius')?.value ?? 0);
      if (ctr && r) [{ x: ctr.x - r, y: ctr.y - r }, { x: ctr.x + r, y: ctr.y + r }].forEach((p) => add(toWorld(f, p)));
      pts.forEach((p) => add(toWorld(f, p)));
    }
  }
  if (!Number.isFinite(b.minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return b;
}

/**
 * Distance to the board edge on a grid (mm, positive inside the outline, negative outside), so a part's
 * box can be tested against an outline of many points (a round board) quickly. Cell 0.25 mm.
 */
function boardDistance(outline: Vec2[]): (p: Vec2) => number {
  const cell = 0.25;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of outline) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  x0 -= 4, y0 -= 4, x1 += 4, y1 += 4;
  const W = Math.ceil((x1 - x0) / cell) + 1, H = Math.ceil((y1 - y0) / cell) + 1;
  const inside = new Uint8Array(W * H);
  // Scanline fill: every row's crossings with the outline.
  for (let j = 0; j < H; j++) {
    const y = y0 + j * cell;
    const xs: number[] = [];
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k]!, b = outline[(k + 1) % outline.length]!;
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell)), i1 = Math.min(W - 1, Math.floor((xs[k + 1]! - x0) / cell));
      for (let i = i0; i <= i1; i++) inside[j * W + i] = 1;
    }
  }
  // Chamfer distance (3-4) from the other side, for both sides.
  const dist = (want: number) => {
    const d = new Float32Array(W * H);
    for (let q = 0; q < W * H; q++) d[q] = inside[q] === want ? 1e9 : 0;
    const a = cell, b = cell * Math.SQRT2;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const q = j * W + i;
        if (!d[q]) continue;
        let v = d[q]!;
        if (i > 0) v = Math.min(v, d[q - 1]! + a);
        if (j > 0) {
          v = Math.min(v, d[q - W]! + a);
          if (i > 0) v = Math.min(v, d[q - W - 1]! + b);
          if (i + 1 < W) v = Math.min(v, d[q - W + 1]! + b);
        }
        d[q] = v;
      }
    for (let j = H - 1; j >= 0; j--)
      for (let i = W - 1; i >= 0; i--) {
        const q = j * W + i;
        if (!d[q]) continue;
        let v = d[q]!;
        if (i + 1 < W) v = Math.min(v, d[q + 1]! + a);
        if (j + 1 < H) {
          v = Math.min(v, d[q + W]! + a);
          if (i + 1 < W) v = Math.min(v, d[q + W + 1]! + b);
          if (i > 0) v = Math.min(v, d[q + W - 1]! + b);
        }
        d[q] = v;
      }
    return d;
  };
  const dIn = dist(1), dOut = dist(0);
  return (p: Vec2) => {
    const i = Math.round((p.x - x0) / cell), j = Math.round((p.y - y0) / cell);
    if (i < 0 || j < 0 || i >= W || j >= H) return -Math.max(Math.abs(p.x - (x0 + x1) / 2) - (x1 - x0) / 2, Math.abs(p.y - (y0 + y1) / 2) - (y1 - y0) / 2, 0) - 4;
    const q = j * W + i;
    return inside[q] ? dIn[q]! - cell / 2 : -dOut[q]! + cell / 2;
  };
}

/** Eight points on a box's outline: corners and side middles. */
const samples = (b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] => {
  const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
  return [{ x: b.minX, y: b.minY }, { x: mx, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: my }, { x: b.maxX, y: b.maxY }, { x: mx, y: b.maxY }, { x: b.minX, y: b.maxY }, { x: b.minX, y: my }];
};

export function planAutoplace(doc: Doc, engine: StyleEngine, copper: string[], opts: AutoplaceOptions = {}): { ops: Op[]; report: AutoplaceReport } {
  const report: AutoplaceReport = { placed: [], failed: [] };
  const outline = boardOutline(doc, engine).loops[0];
  if (!outline) return { ops: [], report: { placed: [], failed: opts.refs ?? [] } };
  const sp = opts.spacing ?? 0.5;
  const elements = [...doc.nodes.values()].filter((n) => n.type === 'element');
  const posOf = (el: DocNode) => vec(engine.get(el.uid, 'position')?.value) ?? { x: 0, y: 0 };
  const ext = new Map(elements.map((e) => [e.uid, componentExtent(doc, engine, e, copper)]));
  /** The part's box at p, turned by `turn` degrees (90° steps) from its rotation now. */
  const boxAt = (el: DocNode, p: Vec2, turn = 0): Box => {
    const e = ext.get(el.uid)!;
    if (!turn) return { minX: p.x + e.minX, minY: p.y + e.minY, maxX: p.x + e.maxX, maxY: p.y + e.maxY };
    const cs = [{ x: e.minX, y: e.minY }, { x: e.maxX, y: e.minY }, { x: e.maxX, y: e.maxY }, { x: e.minX, y: e.maxY }].map((c) => place(c, p, turn));
    return { minX: Math.min(...cs.map((c) => c.x)), minY: Math.min(...cs.map((c) => c.y)), maxX: Math.max(...cs.map((c) => c.x)), maxY: Math.max(...cs.map((c) => c.y)) };
  };
  const edgeDist = boardDistance(outline);
  let ox0 = Infinity, oy0 = Infinity, ox1 = -Infinity, oy1 = -Infinity;
  for (const q of outline) (ox0 = Math.min(ox0, q.x)), (oy0 = Math.min(oy0, q.y)), (ox1 = Math.max(ox1, q.x)), (oy1 = Math.max(oy1, q.y));
  const inside = (b: Box) => {
    if (b.minX < ox0 + sp || b.minY < oy0 + sp || b.maxX > ox1 - sp || b.maxY > oy1 - sp) return false;
    // Quick reject on the distance grid (0.25 mm cells), then the exact test against the edges near the box.
    if (samples(b).some((q) => edgeDist(q) < sp - 0.3)) return false;
    const corners = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
    if (!corners.every((c) => pointInPolygon(c, outline))) return false;
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k]!;
      const c = outline[(k + 1) % outline.length]!;
      if (Math.max(a.x, c.x) < b.minX - sp || Math.min(a.x, c.x) > b.maxX + sp || Math.max(a.y, c.y) < b.minY - sp || Math.min(a.y, c.y) > b.maxY + sp) continue;
      for (const q of corners) if (distToSegment(q, a, c) < sp) return false;
      // Board edge vertices inside the box (notches) also block.
      if (a.x > b.minX && a.x < b.maxX && a.y > b.minY && a.y < b.maxY) return false;
    }
    return true;
  };
  const onBoard = (el: DocNode) => inside(boxAt(el, posOf(el)));
  const wanted = new Set(opts.refs ?? []);
  const toPlace = elements.filter((e) => !e.props.locked && (opts.refs ? wanted.has(e.name) : opts.all || !onBoard(e)));
  const fixed = elements.filter((e) => !toPlace.includes(e));
  const placedBoxes: Box[] = fixed.map((e) => boxAt(e, posOf(e)));

  // Connectivity weights between components (shared nets, small nets weigh more).
  const netsOf = new Map<string, Set<string>>();
  const membersOf = new Map<string, Set<string>>();
  for (const el of elements) {
    const s = new Set<string>();
    for (const c of el.children) {
      const n = doc.nodes.get(c);
      if (n?.type === 'pad' && typeof n.props.net === 'string' && n.props.net && !n.props.net.startsWith('unconnected-')) s.add(n.props.net);
    }
    netsOf.set(el.uid, s);
    for (const net of s) (membersOf.get(net) ?? membersOf.set(net, new Set()).get(net)!).add(el.uid);
  }
  const weight = (a: string, b: string) => {
    let w = 0;
    for (const net of netsOf.get(a) ?? []) if (membersOf.get(net)?.has(b)) w += 1 / Math.max(1, (membersOf.get(net)!.size - 1));
    return w;
  };

  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of outline) (bx0 = Math.min(bx0, p.x)), (by0 = Math.min(by0, p.y)), (bx1 = Math.max(bx1, p.x)), (by1 = Math.max(by1, p.y));
  const centre = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
  const area = (e: DocNode) => {
    const b = ext.get(e.uid)!;
    return (b.maxX - b.minX) * (b.maxY - b.minY);
  };
  const positions = new Map<string, Vec2>();
  for (const e of fixed) positions.set(e.uid, posOf(e));
  const remaining = toPlace.slice().sort((a, b) => area(b) - area(a));
  const ops: Op[] = [];
  const overlaps = (b: Box) => placedBoxes.some((o) => b.minX < o.maxX + sp && b.maxX > o.minX - sp && b.minY < o.maxY + sp && b.maxY > o.minY - sp);
  const step = 0.5;
  const maxRing = Math.ceil(Math.hypot(ox1 - ox0, oy1 - oy0) / step) + 2;
  const turned = new Map<string, number>();
  while (remaining.length) {
    // Next: most connected to what is placed (ties: biggest).
    let best = 0;
    let bestW = -1;
    remaining.forEach((e, i) => {
      let w = 0;
      for (const uid of positions.keys()) w += weight(e.uid, uid);
      if (w > bestW + 1e-9) (bestW = w), (best = i);
    });
    const el = remaining.splice(best, 1)[0]!;
    // Target: weighted centroid of connected placed parts, else the board centre.
    let tx = 0, ty = 0, tw = 0;
    for (const [uid, p] of positions) {
      const w = weight(el.uid, uid);
      if (w > 0) (tx += p.x * w), (ty += p.y * w), (tw += w);
    }
    const target = tw ? { x: tx / tw, y: ty / tw } : centre;
    let found: Vec2 | null = null;
    let turn = 0;
    // As it is; where it does not fit, turned by 90° steps (only parts on a 90° step now).
    const rot0 = Number(engine.get(el.uid, 'rotation')?.value ?? 0) || 0;
    const turns = Math.abs(rot0 / 90 - Math.round(rot0 / 90)) < 1e-6 && opts.rotate !== false ? [0, 90, 180, 270] : [0];
    for (const t of turns) {
      for (let ring = 0; ring < maxRing && !found; ring++) {
        const cands: Vec2[] = [];
        if (ring === 0) cands.push(target);
        else
          for (let k = -ring; k <= ring; k++)
            cands.push({ x: target.x + k * step, y: target.y - ring * step }, { x: target.x + k * step, y: target.y + ring * step }, { x: target.x - ring * step, y: target.y + k * step }, { x: target.x + ring * step, y: target.y + k * step });
        cands.sort((a, b) => Math.hypot(a.x - target.x, a.y - target.y) - Math.hypot(b.x - target.x, b.y - target.y));
        for (const c of cands) {
          const p = { x: Math.round(c.x * 20) / 20, y: Math.round(c.y * 20) / 20 };
          const b = boxAt(el, p, t);
          if (!overlaps(b) && inside(b)) {
            found = p;
            break;
          }
        }
      }
      if (found) {
        turn = t;
        break;
      }
    }
    if (!found) {
      report.failed.push(el.name);
      continue;
    }
    placedBoxes.push(boxAt(el, found, turn));
    positions.set(el.uid, found);
    if (turn) turned.set(el.uid, turn);
    ops.push({ op: 'setRule', uid: el.uid, name: 'position', decl: { name: 'position', value: found } });
    if (turn) ops.push({ op: 'setRule', uid: el.uid, name: 'rotation', decl: { name: 'rotation', value: (rot0 + turn) % 360 } });
    report.placed.push({ ref: el.name, at: found, ...(turn ? { rotation: (rot0 + turn) % 360 } : {}) });
  }
  if (opts.improve === false || !report.placed.length) return { ops, report };
  const better = improvePlacement(doc, engine, copper, outline, { fixed, moving: toPlace.filter((e) => !fixed.includes(e)), positions, turned, failed: new Set(toPlace.filter((e) => !positions.has(e.uid)).map((e) => e.uid)), centre, ext, sp, inside, edgeDist, opts });
  if (!better) return { ops, report };
  const out: Op[] = [];
  const placed: AutoplaceReport['placed'] = [];
  for (const m of better.moves) {
    out.push({ op: 'setRule', uid: m.el.uid, name: 'position', decl: { name: 'position', value: m.at } });
    const r0 = Number(engine.get(m.el.uid, 'rotation')?.value ?? 0) || 0;
    if (((m.rot - r0) % 360 + 360) % 360) out.push({ op: 'setRule', uid: m.el.uid, name: 'rotation', decl: { name: 'rotation', value: m.rot } });
    placed.push({ ref: m.el.name, at: m.at, ...(((m.rot - r0) % 360 + 360) % 360 ? { rotation: m.rot } : {}) });
  }
  return {
    ops: out,
    report: {
      placed,
      failed: better.unplaced,
      ratsnest: better.ratsnest,
      ...(better.decoupling.length ? { decoupling: better.decoupling } : {}),
      ...(better.clusters.length ? { clusters: better.clusters } : {}),
      ...(better.atEdge.length ? { atEdge: better.atEdge } : {}),
    },
  };
}

/** Total ratsnest length of the board as placed: half-perimeter of every net's pads (mm). */
export function ratsnestHpwl(doc: Doc, engine: StyleEngine, copper: string[]): number {
  const box = new Map<string, Box>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'pad' || typeof n.props.net !== 'string' || !n.props.net || n.props.net.startsWith('unconnected-')) continue;
    const g = padGeom(doc, engine, n, copper);
    if (!g) continue;
    const b = box.get(n.props.net) ?? { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    b.minX = Math.min(b.minX, g.center.x), b.minY = Math.min(b.minY, g.center.y), b.maxX = Math.max(b.maxX, g.center.x), b.maxY = Math.max(b.maxY, g.center.y);
    box.set(n.props.net, b);
  }
  let t = 0;
  for (const b of box.values()) t += b.maxX - b.minX + (b.maxY - b.minY);
  return Math.round(t * 100) / 100;
}

/** Small deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COS4 = [1, 0, -1, 0], SIN4 = [0, 1, 0, -1];
const GROUND = /^(a|d|p|s)?gnd|^vss|^0v$|^earth/i;
const POWER = /^(\+|v(cc|dd|in|bat|bus|sys|out|aa|io|ref)?\b|v(cc|dd)|\d+v\d*$|3v3|5v)/i;

function improvePlacement(
  doc: Doc,
  engine: StyleEngine,
  copper: string[],
  outline: Vec2[],
  ctx: { fixed: DocNode[]; moving: DocNode[]; positions: Map<string, Vec2>; turned: Map<string, number>; failed: Set<string>; centre: Vec2; ext: Map<string, Box>; sp: number; inside: (b: Box) => boolean; edgeDist: (p: Vec2) => number; opts: AutoplaceOptions },
): { moves: { el: DocNode; at: Vec2; rot: number }[]; unplaced: string[]; ratsnest: { greedy: number; improved: number }; decoupling: { cap: string; ic: string; pin: string }[]; clusters: { block: string; parts: string[] }[]; atEdge: string[] } | undefined {
  const { sp, opts } = ctx;
  const all = [...ctx.fixed, ...ctx.moving];
  // ---- parts: local box (at rotation 0) and pads in the part's own frame
  type Part = { el: DocNode; i: number; movable: boolean; pos: Vec2; rot: number; rot0: number; turn: boolean; local: Vec2[]; pads: { net: string; at: Vec2 }[]; front?: Vec2; edge: boolean; lead?: number; followers: number[] };
  const parts: Part[] = all.map((el, i) => {
    const rot0 = Number(engine.get(el.uid, 'rotation')?.value ?? 0) || 0;
    const e = ctx.ext.get(el.uid)!;
    const corners = [{ x: e.minX, y: e.minY }, { x: e.maxX, y: e.minY }, { x: e.maxX, y: e.maxY }, { x: e.minX, y: e.maxY }];
    // Back to the part's own frame (exact for 90° steps, a bound otherwise), grown by room for the traces
    // that leave its pads: about one track (0.5 mm) per connected pad spread round its outline (measured:
    // without it the mcu fixture's QFN could not be routed out; twice as much everywhere costs the RGB lamp
    // most of its gain).
    const nPads = el.children.filter((c) => {
      const n = doc.nodes.get(c);
      return n?.type === 'pad' && typeof n.props.net === 'string' && !!n.props.net && !n.props.net.startsWith('unconnected-');
    }).length;
    const perim = 2 * (e.maxX - e.minX + (e.maxY - e.minY));
    // Fine pitch (0.65 mm or less, the parts the router fans out) needs twice the room.
    const centres = el.children.map((c) => doc.nodes.get(c)).filter((n) => n?.type === 'pad').map((n) => vec(engine.get(n!.uid, 'position')?.value)).filter((v): v is Vec2 => !!v);
    let pitch = Infinity;
    for (let a = 0; a < centres.length && centres.length < 200; a++) for (let b = a + 1; b < centres.length; b++) pitch = Math.min(pitch, Math.hypot(centres[a]!.x - centres[b]!.x, centres[a]!.y - centres[b]!.y));
    const halo = Math.min(3, ((pitch <= 0.65 + 1e-6 ? 2 : 1) * nPads * 0.5) / Math.max(perim, 1));
    const local = [{ x: e.minX - halo, y: e.minY - halo }, { x: e.maxX + halo, y: e.minY - halo }, { x: e.maxX + halo, y: e.maxY + halo }, { x: e.minX - halo, y: e.maxY + halo }].map((c) => place(c, { x: 0, y: 0 }, -rot0));
    const pads: { net: string; at: Vec2 }[] = [];
    for (const c of el.children) {
      const n = doc.nodes.get(c);
      if (n?.type !== 'pad') continue;
      const at = vec(engine.get(n.uid, 'position')?.value);
      const net = typeof n.props.net === 'string' && n.props.net && !n.props.net.startsWith('unconnected-') ? n.props.net : '';
      if (at) pads.push({ net, at });
    }
    const movable = ctx.moving.includes(el);
    return { el, i, movable, pos: ctx.positions.get(el.uid) ?? ctx.centre, rot: (rot0 + (ctx.turned.get(el.uid) ?? 0)) % 360, rot0, turn: opts.rotate !== false && Math.abs(rot0 / 90 - Math.round(rot0 / 90)) < 1e-6, local, pads, edge: false, followers: [] };
  });
  const byName = new Map(parts.map((q) => [q.el.name, q]));
  // ---- nets
  const netParts = new Map<string, { part: number; at: Vec2 }[]>();
  for (const q of parts) for (const pd of q.pads) if (pd.net) (netParts.get(pd.net) ?? netParts.set(pd.net, []).get(pd.net)!).push({ part: q.i, at: pd.at });
  for (const [k, v] of netParts) if (v.length < 2) netParts.delete(k);
  const netList = [...netParts.keys()];
  const netIdx = new Map(netList.map((n, i) => [n, i]));
  const partNets = parts.map((q) => [...new Set(q.pads.filter((pd) => netIdx.has(pd.net)).map((pd) => netIdx.get(pd.net)!))]);
  const world = (q: Part, at: Vec2) => place(at, q.pos, q.rot);
  // Per net: its pads as (part, local x, local y), flat, for a fast half-perimeter.
  const netFlat = netList.map((n) => {
    const ms = netParts.get(n)!;
    const part = new Int32Array(ms.length), lx = new Float64Array(ms.length), ly = new Float64Array(ms.length);
    ms.forEach((m, i) => ((part[i] = m.part), (lx[i] = m.at.x), (ly[i] = m.at.y)));
    return { part, lx, ly };
  });
  const hpwl = (k: number) => {
    const f = netFlat[k]!;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < f.part.length; i++) {
      const q = parts[f.part[i]!]!;
      // 90° steps from a table (most parts); any other angle the long way.
      const k4 = q.rot / 90;
      let c: number, sn: number;
      if (k4 === (k4 | 0)) (c = COS4[k4 & 3]!), (sn = SIN4[k4 & 3]!);
      else {
        const r = (q.rot * Math.PI) / 180;
        (c = Math.cos(r)), (sn = Math.sin(r));
      }
      const x = q.pos.x + f.lx[i]! * c + f.ly[i]! * sn, y = q.pos.y - f.lx[i]! * sn + f.ly[i]! * c;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return x1 - x0 + (y1 - y0);
  };
  // ---- decoupling capacitors: a 2-pad C on a power net and ground, tied to an IC on the same two nets
  const sig = new Map(netSignals(doc).map((x) => [x.net, x.signal]));
  const isGnd = (n: string) => sig.get(n) === 'ground' || GROUND.test(n);
  const isPwr = (n: string) => !isGnd(n) && (sig.get(n) === 'power' || POWER.test(n));
  const isIc = (q: Part) => q.pads.filter((pd) => pd.net).length >= 3 && !/^(J|P|CN|X|TP)\d/i.test(q.el.name);
  const decoupling: { cap: string; ic: string; pin: string }[] = [];
  const tie: { cap: number; capPad: Vec2; ic: number; icPad: Vec2 }[] = [];
  for (const q of parts) {
    if (!q.movable || !/^C\d/i.test(q.el.name) || q.pads.length !== 2) continue;
    const pw = q.pads.find((pd) => isPwr(pd.net)), gd = q.pads.find((pd) => isGnd(pd.net));
    if (!pw || !gd) continue;
    const ics = parts.filter((o) => o !== q && isIc(o) && o.pads.some((pd) => pd.net === pw.net) && o.pads.some((pd) => pd.net === gd.net));
    if (!ics.length) continue;
    // One IC on that supply: that one. Several: the one with the fewest capacitors per supply pin so far
    // (more supply pins first), so each IC gets its share.
    const load = (o: Part) => tie.filter((t) => t.ic === o.i).length / o.pads.filter((pd) => pd.net === pw.net).length;
    const ic = ics.reduce((a, b) => (load(b) < load(a) - 1e-9 || (Math.abs(load(b) - load(a)) < 1e-9 && b.pads.filter((pd) => pd.net === pw.net).length > a.pads.filter((pd) => pd.net === pw.net).length) ? b : a));
    // The IC's power pin: of several, the one with the fewest capacitors on it so far.
    const pins = ic.pads.filter((pd) => pd.net === pw.net);
    const used = (at: Vec2) => tie.filter((t) => t.ic === ic.i && t.icPad === at).length;
    const pin = pins.reduce((a, b) => (used(b.at) < used(a.at) ? b : a));
    tie.push({ cap: q.i, capPad: pw.at, ic: ic.i, icPad: pin.at });
    q.lead = ic.i;
    ic.followers.push(q.i);
    const pinNode = ic.el.children.map((c) => doc.nodes.get(c)).find((n) => {
      const at = n?.type === 'pad' ? vec(engine.get(n.uid, 'position')?.value) : undefined;
      return !!at && n!.props.net === pw.net && Math.hypot(at.x - pin.at.x, at.y - pin.at.y) < 1e-6;
    });
    decoupling.push({ cap: q.el.name, ic: ic.el.name, pin: `${ic.el.name}.${pinNode?.name ?? '?'}` });
  }
  // ---- schematic blocks: group boxes, or sheets when the design has several
  const symOf = new Map<string, DocNode>();
  for (const n of doc.nodes.values()) if (n.type === 'symbol' && !n.props.power) symOf.set(String(n.props.ref ?? n.name), n);
  const sheetOf = (n: DocNode) => {
    for (let p: DocNode | undefined = n; p; p = p.parent ? doc.nodes.get(p.parent) : undefined) if (p.type === 'sheet') return p;
    return undefined;
  };
  const boxes = [...doc.nodes.values()].filter((n) => n.type === 'groupBox');
  const blockOf = new Map<number, string>();
  const sheetsUsed = new Set<string>();
  for (const q of parts) {
    const sym = symOf.get(q.el.name);
    if (!sym) continue;
    const at = vec(engine.get(sym.uid, 'position')?.value);
    const sh = sheetOf(sym);
    const gb = at && boxes.find((b) => b.parent === sh?.uid && (() => {
      const r = vec(engine.get(b.uid, 'position')?.value), z = vec(engine.get(b.uid, 'size')?.value);
      return !!r && !!z && at.x >= r.x && at.x <= r.x + z.x && at.y >= r.y && at.y <= r.y + z.y;
    })());
    if (gb) blockOf.set(q.i, `${gb.name || 'group'}#${gb.uid}`);
    else if (sh) (blockOf.set(q.i, `sheet ${sh.name}#${sh.uid}`), sheetsUsed.add(sh.uid));
  }
  if (sheetsUsed.size < 2) for (const [k, v] of blockOf) if (v.startsWith('sheet ')) blockOf.delete(k);
  const clusterMap = new Map<string, number[]>();
  for (const [k, v] of blockOf) if (parts[k]!.lead === undefined) (clusterMap.get(v) ?? clusterMap.set(v, []).get(v)!).push(k);
  for (const [k, v] of clusterMap) if (v.length < 2) clusterMap.delete(k);
  const clusterList = [...clusterMap.values()];
  const partClusters = parts.map(() => [] as number[]);
  clusterList.forEach((c, ci) => c.forEach((k) => partClusters[k]!.push(ci)));
  // ---- connectors at the edge
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of outline) (bx0 = Math.min(bx0, p.x)), (by0 = Math.min(by0, p.y)), (bx1 = Math.max(bx1, p.x)), (by1 = Math.max(by1, p.y));
  const atEdge: string[] = [];
  for (const q of parts) {
    const sym = symOf.get(q.el.name);
    const flag = q.el.props.placeAtEdge ?? sym?.props.placeAtEdge;
    if (!q.movable || !(flag === true || flag === 'true' || flag === 'yes' || flag === '1')) continue;
    q.edge = true;
    atEdge.push(q.el.name);
    // Facing out: the mating side lies opposite the pads (their centroid off the part's origin).
    const cx = q.pads.reduce((s0, pd) => s0 + pd.at.x, 0) / (q.pads.length || 1), cy = q.pads.reduce((s0, pd) => s0 + pd.at.y, 0) / (q.pads.length || 1);
    const size = Math.max(...q.local.map((c) => Math.hypot(c.x, c.y)));
    if (Math.hypot(cx, cy) > 0.15 * size) q.front = { x: -cx / Math.hypot(cx, cy), y: -cy / Math.hypot(cx, cy) };
  }
  // ---- cost terms
  const boxOf = (q: Part): Box => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of q.local) {
      const w = place(c, q.pos, q.rot);
      if (w.x < x0) x0 = w.x;
      if (w.x > x1) x1 = w.x;
      if (w.y < y0) y0 = w.y;
      if (w.y > y1) y1 = w.y;
    }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  };
  const bxs = parts.map(boxOf);
  // A little more than the spacing (0.05 mm), so the result stays legal once snapped to the 0.05 mm grid.
  const overlap = (a: Box, b: Box) => {
    const w = Math.min(a.maxX, b.maxX) + sp + 0.05 - Math.max(a.minX, b.minX);
    const h = Math.min(a.maxY, b.maxY) + sp + 0.05 - Math.max(a.minY, b.minY);
    return w > 0 && h > 0 ? (w + 0.2) * (h + 0.2) : 0;
  };
  // How far the box's outline reaches past the board edge (less the spacing), on the distance grid.
  const pt = { x: 0, y: 0 };
  const outside = (b: Box) => {
    let o = 0;
    const need = sp + 0.15;
    for (const [x, y] of [[b.minX, b.minY], [(b.minX + b.maxX) / 2, b.minY], [b.maxX, b.minY], [b.maxX, (b.minY + b.maxY) / 2], [b.maxX, b.maxY], [(b.minX + b.maxX) / 2, b.maxY], [b.minX, b.maxY], [b.minX, (b.minY + b.maxY) / 2]] as const) {
      pt.x = x;
      pt.y = y;
      const d = ctx.edgeDist(pt);
      if (d < need) o += need - d;
    }
    return o > 0 ? (o + 0.5) * Math.max(b.maxX - b.minX, b.maxY - b.minY, 1) : 0;
  };
  const edgeCost = (q: Part, b: Box) => {
    if (!q.edge) return 0;
    const d = [b.minX - bx0, bx1 - b.maxX, b.minY - by0, by1 - b.maxY];
    const k = d.indexOf(Math.min(...d));
    let c = Math.max(0, d[k]! - sp);
    if (q.front) {
      const f = place(q.front, { x: 0, y: 0 }, q.rot);
      const n = [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }][k]!;
      c += 4 * (1 - (f.x * n.x + f.y * n.y));
    }
    return 20 * c;
  };
  const tieCost = (t: (typeof tie)[number]) => {
    const a = world(parts[t.cap]!, t.capPad), b = world(parts[t.ic]!, t.icPad);
    return 3 * Math.hypot(a.x - b.x, a.y - b.y);
  };
  const W_CL = 0.5;
  const clusterCost = (ci: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of clusterList[ci]!) {
      const p = parts[k]!.pos;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return W_CL * (x1 - x0 + (y1 - y0));
  };
  let W_OV = 20;
  // Overlap weight: from 0.5 at the start to 60, growing with the cube of the progress (measured on the RGB
  // lamp: a higher start weight packs worse, a lower one leaves overlaps that the last step cannot clear).
  const OV0 = 0.5, OVP = 3;
  const W_OUT = 20;
  // Cost of the terms that involve the parts in `ch` (stamps instead of sets: this runs for every move).
  const netStamp = new Int32Array(netList.length), clStamp = new Int32Array(clusterList.length), inCh = new Int32Array(parts.length);
  let stamp = 0;
  const tiesOf = parts.map((q) => tie.filter((t) => t.cap === q.i || t.ic === q.i));
  const local = (ch: Iterable<number>) => {
    stamp++;
    let c = 0;
    for (const k of ch) inCh[k] = stamp;
    for (const k of ch) {
      for (const n of partNets[k]!) if (netStamp[n] !== stamp) (netStamp[n] = stamp), (c += hpwl(n));
      for (const ci of partClusters[k]!) if (clStamp[ci] !== stamp) (clStamp[ci] = stamp), (c += clusterCost(ci));
      for (const t of tiesOf[k]!) if (!(inCh[t.cap] === stamp && inCh[t.ic] === stamp && t.ic !== k)) c += tieCost(t);
    }
    const m = sp + 0.05;
    for (const k of ch) {
      const b = bxs[k]!;
      c += W_OUT * outside(b) + edgeCost(parts[k]!, b);
      const ax0 = b.minX - m, ax1 = b.maxX + m, ay0 = b.minY - m, ay1 = b.maxY + m;
      for (let j = 0; j < bxs.length; j++) {
        if (j === k || (inCh[j] === stamp && j < k)) continue;
        const o = bxs[j]!;
        if (o.minX >= ax1 || o.maxX <= ax0 || o.minY >= ay1 || o.maxY <= ay0) continue;
        c += W_OV * overlap(b, o);
      }
    }
    return c;
  };
  const total = () => local(parts.map((q) => q.i));
  const greedyHpwl = netList.reduce((s0, _, k) => s0 + hpwl(k), 0);
  // ---- annealing
  const mov = parts.filter((q) => q.movable);
  const leaders = mov.filter((q) => q.lead === undefined);
  if (!mov.length) return undefined;
  const iters = opts.iterations ?? Math.min(1500000, 20000 * mov.length);
  const diag = Math.hypot(bx1 - bx0, by1 - by0);
  type Snap = { k: number; pos: Vec2; rot: number; box: Box }[];
  const save = (ks: number[]): Snap => ks.map((k) => ({ k, pos: parts[k]!.pos, rot: parts[k]!.rot, box: bxs[k]! }));
  const restore = (s0: Snap) => {
    for (const x of s0) (parts[x.k]!.pos = x.pos), (parts[x.k]!.rot = x.rot), (bxs[x.k] = x.box);
  };
  const withFollowers = (k: number) => [k, ...parts[k]!.followers];
  const shiftBy = (k: number, dx: number, dy: number) => {
    for (const j of withFollowers(k)) {
      const q = parts[j]!;
      q.pos = { x: q.pos.x + dx, y: q.pos.y + dy };
      bxs[j] = boxOf(q);
    }
  };
  const turnBy = (k: number, deg: number) => {
    const q = parts[k]!;
    q.rot = (((q.rot + deg) % 360) + 360) % 360;
    bxs[k] = boxOf(q);
    for (const j of q.followers) {
      const f = parts[j]!;
      // A follower turns with its IC, round the IC's origin.
      const off = place({ x: f.pos.x - q.pos.x, y: f.pos.y - q.pos.y }, { x: 0, y: 0 }, deg);
      f.pos = { x: q.pos.x + off.x, y: q.pos.y + off.y };
      f.rot = (((f.rot + deg) % 360) + 360) % 360;
      bxs[j] = boxOf(f);
    }
  };
  const start = save(parts.map((q) => q.i));
  /** One annealing run from the greedy start; returns its final cost (at the full overlap weight). */
  const anneal = (rand: () => number, iters: number) => {
    // Start temperature: a fraction of the spread of the cost change of small moves, so the pass refines
    // the greedy start rather than scrambling it.
    W_OV = OV0;
    let T = 0;
    {
      let sum = 0, n = 0;
      for (let s0 = 0; s0 < 100; s0++) {
        const q = leaders[Math.floor(rand() * leaders.length)] ?? mov[0]!;
        const ks = withFollowers(q.i);
        const ch = ks;
        const before = local(ch);
        const snap = save(ks);
        shiftBy(q.i, (rand() - 0.5) * 4, (rand() - 0.5) * 4);
        sum += Math.abs(local(ch) - before);
        n++;
        restore(snap);
      }
      T = Math.max(1e-3, (0.5 * sum) / Math.max(1, n));
    }
    const T0 = T;
    const alpha = Math.pow(1e-3, 1 / Math.max(1, iters));
    // The overlap weight grows in steps, so parts may pass each other early on and end apart.
    const stages = 40;
    for (let it = 0; it < iters; it++, T *= alpha) {
      if (it % Math.ceil(iters / stages) === 0) {
        W_OV = OV0 + (60 - OV0) * Math.pow(it / iters, OVP);
        tell(it / iters);
      }
      if (it === iters - Math.ceil(iters / 10)) W_OV = 60;
      const r = rand();
      let ks: number[];
      let act: () => void;
      if (r < 0.15 && leaders.length > 1) {
        // Swap two parts (with their followers).
        const a = leaders[Math.floor(rand() * leaders.length)]!, b = leaders[Math.floor(rand() * leaders.length)]!;
        if (a === b) continue;
        ks = [...withFollowers(a.i), ...withFollowers(b.i)];
        act = () => {
          const pa = a.pos, pb = b.pos;
          shiftBy(a.i, pb.x - pa.x, pb.y - pa.y);
          shiftBy(b.i, pa.x - pb.x, pa.y - pb.y);
        };
      } else if (r < 0.3) {
        // Turn a part by 90°, 180° or 270°.
        const q = mov[Math.floor(rand() * mov.length)]!;
        if (!q.turn) continue;
        ks = q.lead === undefined ? withFollowers(q.i) : [q.i];
        const deg = 90 * (1 + Math.floor(rand() * 3));
        act = () => turnBy(q.i, deg);
      } else {
        // Move a part, less far as it cools; a follower only a little round its IC.
        const q = mov[Math.floor(rand() * mov.length)]!;
        const R = q.lead === undefined ? Math.max(0.3, diag * 0.25 * Math.sqrt(T / T0)) : 1.5;
        ks = q.lead === undefined ? withFollowers(q.i) : [q.i];
        const dx = (rand() * 2 - 1) * R, dy = (rand() * 2 - 1) * R;
        act = () => (q.lead === undefined ? shiftBy(q.i, dx, dy) : ((q.pos = { x: q.pos.x + dx, y: q.pos.y + dy }), (bxs[q.i] = boxOf(q))));
      }
      const ch = ks;
      const before = local(ch);
      const snap = save(ks);
      act();
      const d = local(ch) - before;
      if (!(d <= 0 || rand() < Math.exp(-d / T))) restore(snap);
    }
    W_OV = 60;
  };
  // ---- legal positions: on the board, no courtyard overlap (spiral search where needed)
  const step = 0.5;
  const legalize = (): string[] => {
    const legal: Box[] = parts.filter((q) => !q.movable).map((q) => bxs[q.i]!);
    const unplaced: string[] = [];
    const clash = (b: Box) => legal.some((o) => b.minX < o.maxX + sp && b.maxX > o.minX - sp && b.minY < o.maxY + sp && b.maxY > o.minY - sp);
    const area = (q: Part) => (bxs[q.i]!.maxX - bxs[q.i]!.minX) * (bxs[q.i]!.maxY - bxs[q.i]!.minY);
    const order = mov.slice().sort((a, b) => (a.lead === undefined ? 0 : 1) - (b.lead === undefined ? 0 : 1) || area(b) - area(a));
    for (const q of order) {
      const t0 = q.pos;
      const r0 = q.rot;
      let ok = false;
      // Where it is, else the nearest free place (also turned by 90° steps, for a part that may turn).
      for (const turn of q.turn ? [0, 90, 180, 270] : [0]) {
        q.rot = (r0 + turn) % 360;
        for (let ring = 0; ring < Math.ceil(diag / step) + 2 && !ok; ring++) {
          const cands: Vec2[] = [];
          if (ring === 0) cands.push(t0);
          else
            for (let k = -ring; k <= ring; k++)
              cands.push({ x: t0.x + k * step, y: t0.y - ring * step }, { x: t0.x + k * step, y: t0.y + ring * step }, { x: t0.x - ring * step, y: t0.y + k * step }, { x: t0.x + ring * step, y: t0.y + k * step });
          cands.sort((a, b) => Math.hypot(a.x - t0.x, a.y - t0.y) - Math.hypot(b.x - t0.x, b.y - t0.y));
          for (const c of cands) {
            q.pos = { x: Math.round(c.x * 20) / 20, y: Math.round(c.y * 20) / 20 };
            const b = boxOf(q);
            if (!clash(b) && ctx.inside(b)) {
              bxs[q.i] = b;
              legal.push(b);
              ok = true;
              break;
            }
          }
        }
        if (ok) break;
      }
      if (!ok) {
        unplaced.push(q.el.name);
        q.pos = t0;
        q.rot = r0;
        bxs[q.i] = boxOf(q);
      }
    }
    return unplaced;
  };
  // Several runs with their own seeds (the result of one run depends a lot on its moves), each made legal;
  // the one that places the most parts with the shortest ratsnest wins.
  const runs = Math.max(1, opts.restarts ?? 3);
  let bestRun: { unplaced: string[]; hpwl: number; snap: Snap } | undefined;
  let tell = (_done: number) => {};
  for (let k = 0; k < runs; k++) {
    tell = (done) => opts.onProgress?.({ run: k + 1, runs, done });
    restore(start);
    anneal(rng((opts.seed ?? 1) + 7919 * k), iters);
    const un = legalize();
    const h = netList.reduce((s0, _, n) => s0 + hpwl(n), 0);
    if (!bestRun || un.length < bestRun.unplaced.length || (un.length === bestRun.unplaced.length && h < bestRun.hpwl)) bestRun = { unplaced: un, hpwl: h, snap: save(parts.map((q) => q.i)) };
  }
  restore(bestRun!.snap);
  const unplaced = bestRun!.unplaced;
  const improved = netList.reduce((s0, _, k) => s0 + hpwl(k), 0);
  // Better when it places more parts, or as many with a shorter ratsnest.
  if (unplaced.length > ctx.failed.size || (unplaced.length === ctx.failed.size && improved > greedyHpwl + 1e-6)) {
    return undefined;
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    moves: mov.filter((q) => !unplaced.includes(q.el.name)).map((q) => ({ el: q.el, at: q.pos, rot: q.rot })),
    unplaced,
    ratsnest: { greedy: r2(greedyHpwl), improved: r2(improved) },
    decoupling,
    clusters: clusterList.map((c) => ({ block: (blockOf.get(c[0]!) ?? '').split('#')[0]!, parts: c.map((k) => parts[k]!.el.name) })),
    atEdge,
  };
}
