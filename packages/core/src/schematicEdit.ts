/**
 * Schematic edits that keep connections intact (work agreement S1).
 *
 * Moving, rotating or mirroring symbols drags along what is attached to their pins:
 *   - wire ends sitting on a pin move with it; a wire that was horizontal or vertical is
 *     bent into an L so it stays orthogonal, keeping the segment at the pin in its old
 *     direction;
 *   - short "stubs" that only lead to power symbols or net labels (as add_power and
 *     add_label make them) move as a whole, together with those symbols / labels;
 *   - labels, junctions and no-connect markers placed exactly on a pin move with it.
 * Power symbols keep their own connection label in sheet coordinates; it moves with them.
 */
import { applyOps, type Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { sheetOf, symbolFrame, symToSheet, type Mirror, type SymbolFrame } from './schematic.ts';
import { extractNetlist } from './netlist.ts';

export interface SymbolMove {
  uid: string;
  position?: Vec2;
  rotation?: number;
  mirror?: Mirror;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const EPS = 1e-3;
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const key = (p: Vec2) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 });

/**
 * Toggle a mirror on a frame. `axis` 'h' flips left↔right, 'v' flips top↔bottom.
 * Both flips together equal a 180° rotation, which is how they are stored.
 */
export function toggleMirror(rotation: number, mirror: Mirror, axis: 'h' | 'v'): { rotation: number; mirror: Mirror } {
  let h = mirror === 'y';
  let v = mirror === 'x';
  if (axis === 'h') h = !h;
  else v = !v;
  if (h && v) return { rotation: (rotation + 180) % 360, mirror: 'none' };
  return { rotation, mirror: h ? 'y' : v ? 'x' : 'none' };
}

/**
 * Ops for moving / rotating / mirroring symbols with everything attached to their pins.
 * `orthogonal: false` only moves wire ends (use while dragging, then straightenWiresOps on drop).
 * `skip`: wires, labels and other items the caller moves itself (part of the same selection).
 */
export function moveSymbolsOps(
  doc: Doc,
  engine: StyleEngine,
  moves: SymbolMove[],
  opts: { orthogonal?: boolean; skip?: Set<string>; points?: { from: Vec2; to: Vec2 }[]; sheet?: string; pre?: Op[] } = {},
): Op[] {
  // `pre`: the caller's own edits (selected wires, labels …), applied together with these.
  const ops: Op[] = [...(opts.pre ?? [])];
  const orthogonal = opts.orthogonal !== false;
  const skip = opts.skip ?? new Set<string>();
  const movedSymbols = new Set(moves.map((m) => m.uid));
  // Old → new positions of every connection point that moves (pins, power-symbol points).
  const moved = new Map<string, { from: Vec2; to: Vec2 }>();
  const sheets = new Set<string>();

  for (const m of moves) {
    const sym = doc.nodes.get(m.uid);
    if (!sym || sym.type !== 'symbol') continue;
    const sheet = sheetOf(doc, sym);
    if (sheet) sheets.add(sheet.uid);
    const oldF = symbolFrame(engine, sym.uid);
    const newF: SymbolFrame = { origin: m.position ?? oldF.origin, rot: m.rotation ?? oldF.rot, mirror: m.mirror ?? oldF.mirror };
    if (m.position) ops.push({ op: 'setRule', uid: sym.uid, name: 'position', decl: { name: 'position', value: round(m.position) } });
    if (m.rotation !== undefined) ops.push({ op: 'setRule', uid: sym.uid, name: 'rotation', decl: { name: 'rotation', value: ((m.rotation % 360) + 360) % 360 } });
    if (m.mirror !== undefined) ops.push({ op: 'setRule', uid: sym.uid, name: 'mirror', decl: { name: 'mirror', value: m.mirror } });
    for (const c of sym.children) {
      const n = doc.nodes.get(c);
      if (!n) continue;
      if (n.type === 'pin') {
        const local = vec(engine.get(n.uid, 'position')?.value);
        if (!local) continue;
        const from = symToSheet(oldF, local);
        moved.set(key(from), { from, to: round(symToSheet(newF, local)) });
      } else if (n.type === 'label') {
        // Power symbols: their connection label lives in sheet coordinates.
        const at = vec(engine.get(n.uid, 'position')?.value);
        if (!at) continue;
        const local = inverse(oldF, at);
        const to = round(symToSheet(newF, local));
        ops.push({ op: 'setRule', uid: n.uid, name: 'position', decl: { name: 'position', value: to } });
        moved.set(key(at), { from: at, to });
      }
    }
  }
  // Extra connection points the caller moves itself (ends of selected wires, selected labels …):
  // whatever else sits on them follows too.
  for (const pt of opts.points ?? []) if (!same(pt.from, pt.to) && !moved.has(key(pt.from))) moved.set(key(pt.from), { from: pt.from, to: round(pt.to) });
  if (opts.sheet) sheets.add(opts.sheet);
  if (!moved.size) return ops;

  // Items on the affected sheets.
  const wires: DocNode[] = [];
  const pointItems: DocNode[] = []; // labels, junctions, no-connects (sheet level)
  const powerPorts: DocNode[] = [];
  const otherPins: Vec2[] = [];
  for (const sid of sheets) {
    const sheet = doc.nodes.get(sid)!;
    for (const c of sheet.children) {
      const n = doc.nodes.get(c);
      if (!n) continue;
      if (skip.has(n.uid)) continue;
      if (n.type === 'wire') wires.push(n);
      else if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') pointItems.push(n);
      else if (n.type === 'symbol' && !movedSymbols.has(n.uid)) {
        if (n.props.power) powerPorts.push(n);
        else
          for (const pc of n.children) {
            const pn = doc.nodes.get(pc);
            if (pn?.type !== 'pin') continue;
            const local = vec(engine.get(pn.uid, 'position')?.value);
            if (local) otherPins.push(symToSheet(symbolFrame(engine, n.uid), local));
          }
      }
    }
  }
  const ends = (w: DocNode) => [vec(engine.get(w.uid, 'start')?.value)!, vec(engine.get(w.uid, 'end')?.value)!] as [Vec2, Vec2];
  const portAt = (p: Vec2) => powerPorts.filter((s) => {
    const o = vec(engine.get(s.uid, 'position')?.value);
    return o && same(o, p);
  });
  const labelsAt = (p: Vec2) => pointItems.filter((n) => n.type === 'label' && same(vec(engine.get(n.uid, 'position')?.value) ?? { x: NaN, y: NaN }, p));
  const wiresAt = (p: Vec2, except: Set<string>) => wires.filter((w) => !except.has(w.uid) && ends(w).some((e) => same(e, p)));
  const pinAt = (p: Vec2) => otherPins.some((q) => same(q, p)) || moved.has(key(p));

  const handledWires = new Set<string>();
  const movePoint = (n: DocNode, delta: Vec2) => {
    const at = vec(engine.get(n.uid, 'position')?.value);
    if (at) ops.push({ op: 'setRule', uid: n.uid, name: 'position', decl: { name: 'position', value: round({ x: at.x + delta.x, y: at.y + delta.y }) } });
  };

  for (const { from, to } of moved.values()) {
    const delta = { x: to.x - from.x, y: to.y - from.y };
    if (Math.hypot(delta.x, delta.y) < EPS) continue;

    // Labels / junctions / no-connects right on the pin.
    for (const n of pointItems) {
      const at = vec(engine.get(n.uid, 'position')?.value);
      if (at && same(at, from)) movePoint(n, delta);
    }

    // Stubs: a chain of wires from the pin that ends only at power symbols / labels.
    for (const first of wiresAt(from, handledWires)) {
      const chain: DocNode[] = [first];
      let tip = ends(first).find((e) => !same(e, from))!;
      let ok = true;
      for (let depth = 0; depth < 4; depth++) {
        if (pinAt(tip)) {
          ok = false;
          break;
        }
        const next = wiresAt(tip, new Set(chain.map((w) => w.uid)));
        if (next.length === 0) break;
        if (next.length > 1 || pointItems.some((n) => n.type === 'junction' && same(vec(engine.get(n.uid, 'position')?.value)!, tip))) {
          ok = false;
          break;
        }
        chain.push(next[0]!);
        const [a, b] = ends(next[0]!);
        tip = same(a, tip) ? b : a;
      }
      const attached = [...portAt(tip), ...labelsAt(tip)];
      if (ok && attached.length && !pinAt(tip)) {
        // Translate the whole stub with what hangs on it.
        for (const w of chain) {
          handledWires.add(w.uid);
          const [a, b] = ends(w);
          ops.push({ op: 'setRule', uid: w.uid, name: 'start', decl: { name: 'start', value: round({ x: a.x + delta.x, y: a.y + delta.y }) } });
          ops.push({ op: 'setRule', uid: w.uid, name: 'end', decl: { name: 'end', value: round({ x: b.x + delta.x, y: b.y + delta.y }) } });
        }
        for (const s of portAt(tip)) {
          movePoint(s, delta);
          for (const c of s.children) {
            const l = doc.nodes.get(c);
            if (l?.type === 'label') movePoint(l, delta);
          }
        }
        for (const l of labelsAt(tip)) movePoint(l, delta);
      }
    }
  }

  // Ordinary wires: move the ends that sit on moved points, keep them orthogonal.
  for (const w of wires) {
    if (handledWires.has(w.uid)) continue;
    const [a, b] = ends(w);
    const ma = moved.get(key(a));
    const mb = moved.get(key(b));
    if (!ma && !mb) continue;
    const na = ma ? ma.to : a;
    const nb = mb ? mb.to : b;
    if (ma) ops.push({ op: 'setRule', uid: w.uid, name: 'start', decl: { name: 'start', value: na } });
    if (mb) ops.push({ op: 'setRule', uid: w.uid, name: 'end', decl: { name: 'end', value: nb } });
  }
  if (!orthogonal) return ops;
  // Bend slanted wires back to right angles, checking the result against the moved state:
  // apply the moves for a moment, plan the bends, then put the document back.
  const snap: WiresBefore = new Map<string, WireSnapshot>();
  snap.nets = itemNets(doc, engine);
  for (const sid of sheets) for (const [k, v] of snapshotWires(doc, engine, sid)) snap.set(k, v);
  const beforeKey = netGroups(doc, engine);
  const res = applyOps(doc, ops);
  engine.recompute();
  let bends: Op[] = [];
  try {
    bends = straightenSafelyOps(doc, engine, snap, beforeKey);
  } finally {
    applyOps(doc, res.inverse);
    engine.recompute();
  }
  return [...ops, ...bends];
}

/**
 * Which pins are connected to which, independent of net names: a string that is equal
 * exactly when two states have the same connectivity.
 */
export function netGroups(doc: Doc, engine: StyleEngine): string {
  return JSON.stringify(
    extractNetlist(doc, engine)
      .nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' '))
      .filter((g) => g.includes(' '))
      .sort(),
  );
}

/**
 * straightenWiresOps, checked: the bends are only used when the connectivity afterwards is
 * still `beforeKey` (netGroups before the edit). Tries the full clean-up, then bends without
 * re-routing other wires, then no bends at all (wires may stay slanted, but no net changes).
 * Call it with the moved ends already applied.
 */
export function straightenSafelyOps(doc: Doc, engine: StyleEngine, before: WiresBefore, beforeKey: string): Op[] {
  const tries: (() => Op[])[] = [() => straightenWiresOps(doc, engine, before), () => straightenWiresOps(doc, engine, before, { reroute: false })];
  for (const t of tries) {
    const bends = t();
    if (!bends.length) return [];
    const r = applyOps(doc, bends);
    engine.recompute();
    const ok = netGroups(doc, engine) === beforeKey;
    applyOps(doc, r.inverse);
    engine.recompute();
    if (ok) return bends;
  }
  return [];
}

/** Sheet point → symbol-local point (inverse of symToSheet). */
function inverse(f: SymbolFrame, p: Vec2): Vec2 {
  const d = { x: p.x - f.origin.x, y: p.y - f.origin.y };
  const m = f.mirror === 'x' ? { x: d.x, y: -d.y } : f.mirror === 'y' ? { x: -d.x, y: d.y } : d;
  // place() rotates counter-clockwise on screen (Y down); undo it.
  const r = (-f.rot * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: m.x * c + m.y * s, y: -m.x * s + m.y * c };
}

export interface WireSnapshot {
  a: Vec2;
  b: Vec2;
}

/** Wire ends before an edit, plus the net of every item then (wires, pins, labels …). */
export type WiresBefore = Map<string, WireSnapshot> & { nets?: Map<string, string> };

/** Net of every connectable item (uid → net name), from the current state. */
function itemNets(doc: Doc, engine: StyleEngine): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of extractNetlist(doc, engine).nets) {
    for (const p of n.pins) out.set(p.pinUid, n.name);
    for (const u of n.items) out.set(u, n.name);
  }
  return out;
}

/** Wire ends on a sheet, taken before a drag starts (for straightenWiresOps). */
export function snapshotWires(doc: Doc, engine: StyleEngine, sheetUid: string): WiresBefore {
  const out: WiresBefore = new Map<string, WireSnapshot>();
  out.nets = itemNets(doc, engine);
  const sheet = doc.nodes.get(sheetUid);
  for (const c of sheet?.children ?? []) {
    const n = doc.nodes.get(c);
    if (n?.type !== 'wire') continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    if (a && b) out.set(n.uid, { a, b });
  }
  return out;
}

export interface Obstacles {
  points: Vec2[];
  segs: [Vec2, Vec2][];
  boxes: { minX: number; minY: number; maxX: number; maxY: number }[];
  /** Uid of the item each point / segment belongs to (wire, pin, label …), same order. */
  pointOwners?: string[];
  segOwners?: string[];
}

/** Everything a new wire path must not touch on a sheet (excluding the wire being bent). */
function obstacles(doc: Doc, engine: StyleEngine, sheetUid: string, selfUid: string): Obstacles {
  const o: Obstacles = { points: [], segs: [], boxes: [], pointOwners: [], segOwners: [] };
  const pt = (p: Vec2, owner: string) => (o.points.push(p), o.pointOwners!.push(owner));
  const sheet = doc.nodes.get(sheetUid);
  for (const c of sheet?.children ?? []) {
    const n = doc.nodes.get(c);
    if (!n || n.uid === selfUid) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) o.segs.push([a, b]), o.segOwners!.push(n.uid), pt(a, n.uid), pt(b, n.uid);
    } else if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') {
      const at = vec(engine.get(n.uid, 'position')?.value);
      if (at) pt(at, n.uid);
    } else if (n.type === 'symbol') {
      const f = symbolFrame(engine, n.uid);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const grow = (q: Vec2) => {
        const w = symToSheet(f, q);
        x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y); x1 = Math.max(x1, w.x); y1 = Math.max(y1, w.y);
      };
      for (const g of (n.data?.graphics ?? []) as { t: string; a?: Vec2; b?: Vec2; pts?: Vec2[]; c?: Vec2; r?: number; s?: Vec2; m?: Vec2; e?: Vec2 }[]) {
        if (g.t === 'rect' && g.a && g.b) (grow(g.a), grow(g.b));
        else if (g.t === 'poly' && g.pts) g.pts.forEach(grow);
        else if (g.t === 'circle' && g.c && g.r) (grow({ x: g.c.x - g.r, y: g.c.y - g.r }), grow({ x: g.c.x + g.r, y: g.c.y + g.r }));
        else if (g.t === 'arc' && g.s && g.m && g.e) (grow(g.s), grow(g.m), grow(g.e));
      }
      if (!n.props.power && Number.isFinite(x0) && x1 - x0 > 0.3 && y1 - y0 > 0.3) o.boxes.push({ minX: x0, minY: y0, maxX: x1, maxY: y1 });
      for (const pc of n.children) {
        const k = doc.nodes.get(pc);
        if (k?.type === 'pin') {
          const local = vec(engine.get(k.uid, 'position')?.value);
          if (local) pt(symToSheet(f, local), k.uid);
        } else if (k?.type === 'label') {
          const at = vec(engine.get(k.uid, 'position')?.value);
          if (at) pt(at, k.uid);
        }
      }
    }
  }
  return o;
}

/**
 * Keep only what belongs to other nets than `net`, using the net of every item as it was
 * before the edit (`netOf`). Items whose net is unknown stay as obstacles.
 */
function foreign(o: Obstacles, net: string, netOf: Map<string, string>): Obstacles {
  const keepP = o.points.map((_, i) => netOf.get(o.pointOwners?.[i] ?? '') !== net);
  const keepS = o.segs.map((_, i) => netOf.get(o.segOwners?.[i] ?? '') !== net);
  return {
    points: o.points.filter((_, i) => keepP[i]),
    pointOwners: o.pointOwners?.filter((_, i) => keepP[i]),
    segs: o.segs.filter((_, i) => keepS[i]),
    segOwners: o.segOwners?.filter((_, i) => keepS[i]),
    boxes: o.boxes,
  };
}

/** True when an end of the wire (not just its middle) sits on something of another net. */
function endConflict(a: Vec2, b: Vec2, o: Obstacles): boolean {
  return [a, b].some((e) => o.points.some((p) => same(p, e)) || o.segs.some(([c, d]) => onSeg(e, c, d)));
}

/**
 * Drop the wires and points that already belong to the wire's own net (reachable from its
 * ends through other wires): touching them cannot create a short.
 */
function withoutOwnNet(o: Obstacles, ends: Vec2[]): Obstacles {
  const reach: Vec2[] = [...ends];
  const used = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    o.segs.forEach(([a, b], i) => {
      if (used.has(i)) return;
      if (reach.some((p) => onSeg(p, a, b)) || reach.some((p) => same(p, a) || same(p, b))) {
        used.add(i);
        reach.push(a, b);
        grew = true;
      }
    });
  }
  return {
    segs: o.segs.filter((_, i) => !used.has(i)),
    points: o.points.filter((p) => !reach.some((q) => same(p, q))),
    boxes: o.boxes,
  };
}

const onSeg = (p: Vec2, a: Vec2, b: Vec2) =>
  Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS && Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS &&
  Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < EPS;

/** True when one segment a→b touches nothing except the path's own two ends. */
function segClear(a: Vec2, b: Vec2, o: Obstacles, ends: Vec2[]): boolean {
  if (same(a, b)) return true;
  for (const p of o.points) {
    if (ends.some((e) => same(e, p))) continue;
    if (onSeg(p, a, b)) return false;
  }
  for (const [c, d] of o.segs) {
    // A corner landing on another wire would join it.
    for (const q of [a, b]) if (!ends.some((e) => same(e, q)) && onSeg(q, c, d)) return false;
    const horiz = Math.abs(a.y - b.y) < EPS && Math.abs(c.y - d.y) < EPS && Math.abs(a.y - c.y) < EPS;
    const vert = Math.abs(a.x - b.x) < EPS && Math.abs(c.x - d.x) < EPS && Math.abs(a.x - c.x) < EPS;
    if (horiz && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > EPS) return false;
    if (vert && Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > EPS) return false;
    // Crossing at a right angle is fine (no connection without a junction).
  }
  for (const bx of o.boxes) {
    // A body that already holds one of the wire's ends cannot be avoided; only the rest of the path is checked.
    if (ends.some((e) => e.x > bx.minX - EPS && e.x < bx.maxX + EPS && e.y > bx.minY - EPS && e.y < bx.maxY + EPS)) continue;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (x1 > bx.minX + 0.05 && x0 < bx.maxX - 0.05 && y1 > bx.minY + 0.05 && y0 < bx.maxY - 0.05) return false;
  }
  return true;
}

/** True when an orthogonal path touches nothing but its own two ends. */
function clear(path: Vec2[], o: Obstacles): boolean {
  const ends = [path[0]!, path[path.length - 1]!];
  for (let i = 0; i + 1 < path.length; i++) if (!segClear(path[i]!, path[i + 1]!, o, ends)) return false;
  return true;
}

/**
 * Fallback: shortest right-angle path on the 1.27 mm grid with a penalty per bend (A*),
 * inside the area around both ends plus a margin. Returns null when there is none.
 */
export function gridPath(from: Vec2, to: Vec2, o: Obstacles, margin = 12.7): Vec2[] | null {
  const g = 1.27;
  const dxSteps = (to.x - from.x) / g;
  const dySteps = (to.y - from.y) / g;
  if (Math.abs(dxSteps - Math.round(dxSteps)) > 0.01 || Math.abs(dySteps - Math.round(dySteps)) > 0.01) return null;
  const m = Math.round(margin / g);
  const x0 = Math.min(0, Math.round(dxSteps)) - m;
  const y0 = Math.min(0, Math.round(dySteps)) - m;
  const W = Math.abs(Math.round(dxSteps)) + 2 * m + 1;
  const H = Math.abs(Math.round(dySteps)) + 2 * m + 1;
  const pt = (i: number, j: number): Vec2 => ({ x: from.x + (x0 + i) * g, y: from.y + (y0 + j) * g });
  const si = -x0, sj = -y0, ti = Math.round(dxSteps) - x0, tj = Math.round(dySteps) - y0;
  const ends = [from, to];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  const best = new Map<number, number>();
  const prev = new Map<number, number>();
  const id = (i: number, j: number, d: number) => (j * W + i) * 4 + d;
  // Tiny binary heap of [f, state].
  const heap: [number, number, number][] = [];
  const push = (f: number, st: number, cost: number) => {
    heap.push([f, st, cost]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p]![0] <= heap[k]![0]) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1]![0] < heap[c]![0]) c++;
        if (heap[c]![0] >= heap[k]![0]) break;
        [heap[c], heap[k]] = [heap[k]!, heap[c]!];
        k = c;
      }
    }
    return top;
  };
  const h = (i: number, j: number) => Math.abs(i - ti) + Math.abs(j - tj);
  for (let d = 0; d < 4; d++) {
    const s0 = id(si, sj, d);
    best.set(s0, 0);
    push(h(si, sj), s0, 0);
  }
  let goal = -1;
  let guard = 0;
  while (heap.length && guard++ < 200000) {
    const [, st, cost] = pop();
    if (cost > (best.get(st) ?? Infinity)) continue;
    const d = st % 4;
    const cell = (st - d) / 4;
    const i = cell % W;
    const j = (cell - i) / W;
    if (i === ti && j === tj) {
      goal = st;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      const [di, dj] = DIRS[nd]!;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      if (!segClear(pt(i, j), pt(ni, nj), o, ends)) continue;
      const nc = cost + 1 + (nd !== d && !(i === si && j === sj) ? 6 : 0);
      const ns = id(ni, nj, nd);
      if (nc >= (best.get(ns) ?? Infinity)) continue;
      best.set(ns, nc);
      prev.set(ns, st);
      push(nc + h(ni, nj), ns, nc);
    }
  }
  if (goal < 0) return null;
  const cells: Vec2[] = [];
  for (let st: number | undefined = goal; st !== undefined; st = prev.get(st)) {
    const d = st % 4;
    const cell = (st - d) / 4;
    const i = cell % W;
    cells.push(pt(i, (cell - i) / W));
  }
  cells.reverse();
  // Keep the corners only.
  const out: Vec2[] = [cells[0]!];
  for (let k = 1; k + 1 < cells.length; k++) {
    const a = out[out.length - 1]!, b = cells[k]!, c = cells[k + 1]!;
    const straight = (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS);
    if (!straight) out.push(b);
  }
  out.push(cells[cells.length - 1]!);
  return out.map(round);
}

/** Candidate right-angle paths from `fixed` to `moved`, preferred first. */
function candidates(fixed: Vec2, moved: Vec2, wasH: boolean): Vec2[][] {
  const g = 2.54;
  const out: Vec2[][] = [];
  const lA = [fixed, { x: fixed.x, y: moved.y }, moved]; // vertical then horizontal into `moved`
  const lB = [fixed, { x: moved.x, y: fixed.y }, moved]; // horizontal then vertical into `moved`
  out.push(...(wasH ? [lA, lB] : [lB, lA]));
  const midX = (fixed.x + moved.x) / 2;
  const midY = (fixed.y + moved.y) / 2;
  for (let k = 0; k <= 6; k++) {
    for (const sign of k ? [1, -1] : [1]) {
      const x = Math.round((midX + sign * k * g) / 1.27) * 1.27;
      const y = Math.round((midY + sign * k * g) / 1.27) * 1.27;
      out.push([fixed, { x, y: fixed.y }, { x, y: moved.y }, moved]); // H-V-H
      out.push([fixed, { x: fixed.x, y }, { x: moved.x, y }, moved]); // V-H-V
    }
  }
  return out.map((p) => p.map(round));
}

/**
 * After a drag or move: wires that were horizontal or vertical before and are now slanted
 * are replaced by a right-angle path (an L, or a Z when the L would touch other parts,
 * pins or wires). If no clean path exists the wire is left slanted rather than risk a short.
 */
export function straightenWiresOps(doc: Doc, engine: StyleEngine, before: WiresBefore, opts: { reroute?: boolean } = {}): Op[] {
  const netOf = before.nets;
  const avoid = (uid: string, sheetUid: string, a: Vec2, b: Vec2): Obstacles => {
    const all = obstacles(doc, engine, sheetUid, uid);
    const net = netOf?.get(uid);
    return net !== undefined && netOf ? foreign(all, net, netOf) : withoutOwnNet(all, [a, b]);
  };
  const ops: Op[] = [];
  const sheets = new Set<string>();
  // Where wire ends used to be: pieces left dangling there afterwards are removed (pass 3).
  const seeds: Vec2[] = [];
  for (const [uid, old] of before) {
    const a = vec(engine.get(uid, 'start')?.value);
    const b = vec(engine.get(uid, 'end')?.value);
    if (a && b && !(same(a, old.a) && same(b, old.b))) seeds.push(old.a, old.b);
  }
  // Pass 1: wires whose ends moved are re-routed at right angles. The whole chain of plain
  // wires from the moved pin up to the next branch point / pin / label is rebuilt, so repeated
  // edits do not pile up detours; a straight wire that is still clear is left alone.
  const consumed = new Set<string>();
  for (const [uid, old] of before) {
    if (consumed.has(uid)) continue;
    const w = doc.nodes.get(uid);
    if (!w || w.type !== 'wire' || !w.parent) continue;
    sheets.add(w.parent);
    const a = vec(engine.get(uid, 'start')?.value);
    const b = vec(engine.get(uid, 'end')?.value);
    if (!a || !b) continue;
    if (same(a, old.a) && same(b, old.b)) continue;
    const wasH = Math.abs(old.a.y - old.b.y) < EPS;
    const wasV = Math.abs(old.a.x - old.b.x) < EPS;
    const diag = Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS;
    if (diag && !(wasH || wasV)) continue;
    const aMoved = !same(a, old.a);
    const movedEnd = aMoved ? a : b;
    const fixedEnd0 = aMoved ? b : a;
    const o0 = avoid(uid, w.parent, fixedEnd0, movedEnd);
    if (!diag && clear([a, b], o0)) continue;
    const chain = wireChain(doc, engine, w.parent, uid, fixedEnd0, before);
    const fixedEnd = chain.far;
    const o = avoid(uid, w.parent, fixedEnd, movedEnd);
    const path = candidates(fixedEnd, movedEnd, wasH).find((p) => clear(p, o)) ?? gridPath(fixedEnd, movedEnd, o);
    if (!path) continue;
    for (const c of chain.wires) consumed.add(c);
    consumed.add(uid);
    // Keep the wire's own orientation (start stays at the same end).
    ops.push(...pathOps(doc, uid, aMoved ? path.slice().reverse() : path, netOf));
    for (const c of chain.wires) ops.push({ op: 'remove', uid: c });
  }
  const all = [...ops];
  if (netOf && opts.reroute !== false) all.push(...rerouteConflictsOps(doc, engine, ops, sheets, netOf, avoid));
  all.push(...tidyOps(doc, engine, all, sheets, seeds));
  return all;
}

/**
 * Pass 2: with `ops` applied, any other wire that a moved pin or bend now lands on is
 * re-routed around it, so no two nets touch.
 */
function rerouteConflictsOps(
  doc: Doc,
  engine: StyleEngine,
  ops: Op[],
  sheets: Set<string>,
  netOf: Map<string, string>,
  avoid: (uid: string, sheetUid: string, a: Vec2, b: Vec2) => Obstacles,
): Op[] {
  const res = applyOps(doc, ops);
  engine.recompute();
  const more: Op[] = [];
  try {
    for (const sid of sheets) {
      for (const c of doc.nodes.get(sid)?.children ?? []) {
        const w = doc.nodes.get(c);
        if (w?.type !== 'wire') continue;
        const a = vec(engine.get(w.uid, 'start')?.value);
        const b = vec(engine.get(w.uid, 'end')?.value);
        if (!a || !b || netOf.get(w.uid) === undefined) continue;
        const o = avoid(w.uid, sid, a, b);
        if (clear([a, b], o) || endConflict(a, b, o)) continue;
        const path = gridPath(a, b, o);
        if (path) more.push(...pathOps(doc, w.uid, path, netOf));
      }
    }
  } finally {
    applyOps(doc, res.inverse);
    engine.recompute();
  }
  return more;
}

/**
 * Pass 3, with `ops` applied: remove wire pieces left dangling where wire ends used to be
 * (`seeds`), then join two straight pieces meeting end to end in line with nothing else at
 * the joint. Neither changes which pins are connected.
 */
function tidyOps(doc: Doc, engine: StyleEngine, ops: Op[], sheets: Set<string>, seeds: Vec2[]): Op[] {
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.op === 'setRule') touched.add(op.uid);
    else if (op.op === 'add') for (const n of op.tree.nodes) touched.add(n.uid);
  }
  const res = applyOps(doc, ops);
  engine.recompute();
  const out: Op[] = [];
  try {
    for (const sid of sheets) {
      const segs = new Map<string, { a: Vec2; b: Vec2 }>();
      for (const c of doc.nodes.get(sid)?.children ?? []) {
        const n = doc.nodes.get(c);
        if (n?.type !== 'wire') continue;
        const a = vec(engine.get(n.uid, 'start')?.value);
        const b = vec(engine.get(n.uid, 'end')?.value);
        if (a && b) segs.set(n.uid, { a, b });
      }
      const o = obstacles(doc, engine, sid, '');
      const things = o.points.filter((_, i) => doc.nodes.get(o.pointOwners?.[i] ?? '')?.type !== 'wire');
      const touchers = (p: Vec2, self: string) => [...segs].filter(([u, s]) => u !== self && (same(s.a, p) || same(s.b, p) || onSeg(p, s.a, s.b)));
      const loose = (p: Vec2, self: string) => !things.some((q) => same(q, p)) && touchers(p, self).length === 0;
      const seed = [...seeds];
      // Zero-length pieces and exact duplicates first.
      for (const [u, s] of [...segs]) {
        const dup = [...segs].some(([v, t]) => v < u && ((same(t.a, s.a) && same(t.b, s.b)) || (same(t.a, s.b) && same(t.b, s.a))));
        if (same(s.a, s.b) || dup) (segs.delete(u), out.push({ op: 'remove', uid: u }));
      }
      for (let grew = true; grew; ) {
        grew = false;
        for (const [u, s] of [...segs]) {
          const end = [s.a, s.b].find((p) => seed.some((q) => same(p, q)) && loose(p, u));
          if (!end) continue;
          segs.delete(u);
          out.push({ op: 'remove', uid: u });
          seed.push(same(end, s.a) ? s.b : s.a);
          grew = true;
        }
      }
      // Join in-line pieces at plain joints near the edit.
      for (let grew = true; grew; ) {
        grew = false;
        for (const [u, s] of segs) {
          for (const p of [s.a, s.b]) {
            if (things.some((q) => same(q, p))) continue;
            const t = touchers(p, u);
            if (t.length !== 1) continue;
            const [v, r] = t[0]!;
            // Only joints the edit made: one of the two pieces was moved or added.
            if (!touched.has(u) && !touched.has(v)) continue;
            if (!(same(r.a, p) || same(r.b, p))) continue;
            const far = same(r.a, p) ? r.b : r.a;
            const near = same(s.a, p) ? s.b : s.a;
            const inLine = (Math.abs(near.y - p.y) < EPS && Math.abs(far.y - p.y) < EPS) || (Math.abs(near.x - p.x) < EPS && Math.abs(far.x - p.x) < EPS);
            if (!inLine || (far.x - p.x) * (near.x - p.x) + (far.y - p.y) * (near.y - p.y) > 0) continue;
            const ns = same(s.a, p) ? { a: far, b: s.b } : { a: s.a, b: far };
            out.push({ op: 'setRule', uid: u, name: same(s.a, p) ? 'start' : 'end', decl: { name: same(s.a, p) ? 'start' : 'end', value: far } });
            out.push({ op: 'remove', uid: v });
            segs.set(u, ns);
            segs.delete(v);
            grew = true;
            break;
          }
          if (grew) break;
        }
      }
    }
  } finally {
    applyOps(doc, res.inverse);
    engine.recompute();
  }
  return out;
}

/**
 * From wire `uid`'s end at `from`, follow plain wire-to-wire joints (exactly two wire ends,
 * nothing else there) and return the wires passed and the point where the chain stops
 * (a pin, label, junction, branch, or a wire end resting on another wire). Only wires that
 * did not move (present in `before` with the same ends) are followed.
 */
function wireChain(doc: Doc, engine: StyleEngine, sheetUid: string, uid: string, from: Vec2, before: Map<string, WireSnapshot>): { wires: string[]; far: Vec2 } {
  const segs: { uid: string; a: Vec2; b: Vec2 }[] = [];
  const others: Vec2[] = [];
  for (const c of doc.nodes.get(sheetUid)?.children ?? []) {
    const n = doc.nodes.get(c);
    if (n?.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) segs.push({ uid: n.uid, a, b });
    }
  }
  const o = obstacles(doc, engine, sheetUid, '');
  o.points.forEach((p, i) => {
    const owner = doc.nodes.get(o.pointOwners?.[i] ?? '');
    if (owner && owner.type !== 'wire') others.push(p);
  });
  const wires: string[] = [];
  let cur = uid;
  let at = from;
  for (let guard = 0; guard < 64; guard++) {
    if (others.some((p) => same(p, at))) break;
    const touching = segs.filter((s) => s.uid !== cur && (same(s.a, at) || same(s.b, at)));
    const midOf = segs.some((s) => !same(s.a, at) && !same(s.b, at) && onSeg(at, s.a, s.b));
    if (touching.length !== 1 || midOf) break;
    const next = touching[0]!;
    const snap = before.get(next.uid);
    if (!snap || !((same(snap.a, next.a) && same(snap.b, next.b)) || (same(snap.a, next.b) && same(snap.b, next.a)))) break;
    if (wires.includes(next.uid) || next.uid === uid) break;
    wires.push(next.uid);
    cur = next.uid;
    at = same(next.a, at) ? next.b : next.a;
  }
  return { wires, far: at };
}

/** Ops that turn wire `uid` into the orthogonal path `path` (extra segments become new wires). */
function pathOps(doc: Doc, uid: string, path: Vec2[], netOf?: Map<string, string>): Op[] {
  const seq = path.filter((p, i) => i === 0 || !same(p, path[i - 1]!));
  const ops: Op[] = [];
  ops.push({ op: 'setRule', uid, name: 'start', decl: { name: 'start', value: seq[0]! } });
  ops.push({ op: 'setRule', uid, name: 'end', decl: { name: 'end', value: seq[1]! } });
  const sheet = doc.nodes.get(doc.nodes.get(uid)!.parent!)!;
  for (let i = 1; i + 1 < seq.length; i++) {
    const nu = newUid('w');
    const net = netOf?.get(uid);
    if (net !== undefined) netOf!.set(nu, net);
    ops.push({ op: 'add', parent: sheet.uid, index: sheet.children.length + i, tree: { nodes: [{ uid: nu, type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: seq[i]! }, { name: 'end', value: seq[i + 1]! }], parent: sheet.uid, children: [] }] } });
  }
  return ops;
}

// ---------- selections (S2) ----------

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Sheet-space bounds of a symbol: its drawing plus its pin ends. */
export function symbolBounds(doc: Doc, engine: StyleEngine, uid: string): Rect {
  const sym = doc.nodes.get(uid);
  const f = symbolFrame(engine, uid);
  const pts: Vec2[] = [];
  for (const g of (sym?.data?.graphics ?? []) as { t: string; a?: Vec2; b?: Vec2; pts?: Vec2[]; c?: Vec2; r?: number; s?: Vec2; m?: Vec2; e?: Vec2 }[]) {
    if (g.t === 'poly' && g.pts) pts.push(...g.pts);
    else if (g.t === 'rect' && g.a && g.b) pts.push(g.a, g.b);
    else if (g.t === 'circle' && g.c && g.r) pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r });
    else if (g.t === 'arc' && g.s && g.m && g.e) pts.push(g.s, g.m, g.e);
  }
  for (const c of sym?.children ?? []) {
    const p = doc.nodes.get(c);
    const at = p?.type === 'pin' ? vec(engine.get(p.uid, 'position')?.value) : undefined;
    if (at) pts.push(at);
  }
  if (!pts.length) pts.push({ x: -1, y: -1 }, { x: 1, y: 1 });
  const w = pts.map((p) => symToSheet(f, p));
  return { minX: Math.min(...w.map((p) => p.x)), minY: Math.min(...w.map((p) => p.y)), maxX: Math.max(...w.map((p) => p.x)), maxY: Math.max(...w.map((p) => p.y)) };
}

/** Items a selection box picks: symbols, wires, labels (not a symbol's own), junctions, no-connects, sheet blocks. */
const SELECTABLE = new Set(['symbol', 'wire', 'label', 'junction', 'noconnect', 'block']);

function segTouchesRect(a: Vec2, b: Vec2, r: Rect): boolean {
  const inside = (p: Vec2) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
  if (inside(a) || inside(b)) return true;
  // Liang–Barsky clip.
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.minX], [dx, r.maxX - a.x], [-dy, a.y - r.minY], [dy, r.maxY - a.y]] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Items on a sheet picked by a selection box. `mode` 'inside' takes items fully inside the box
 * (dragged left → right); 'touch' takes items the box touches (dragged right → left).
 */
export function itemsInRect(doc: Doc, engine: StyleEngine, sheetUid: string, r: Rect, mode: 'inside' | 'touch'): string[] {
  const out: string[] = [];
  const sheet = doc.nodes.get(sheetUid);
  const inR = (p: Vec2) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
  const boxIn = (b: Rect) => (mode === 'inside' ? b.minX >= r.minX && b.maxX <= r.maxX && b.minY >= r.minY && b.maxY <= r.maxY : b.maxX >= r.minX && b.minX <= r.maxX && b.maxY >= r.minY && b.minY <= r.maxY);
  for (const c of sheet?.children ?? []) {
    const n = doc.nodes.get(c);
    if (!n || !SELECTABLE.has(n.type)) continue;
    if (n.type === 'symbol') {
      if (boxIn(symbolBounds(doc, engine, n.uid))) out.push(n.uid);
    } else if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b && (mode === 'inside' ? inR(a) && inR(b) : segTouchesRect(a, b, r))) out.push(n.uid);
    } else if (n.type === 'block') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      const s = vec(engine.get(n.uid, 'size')?.value);
      if (p && s && boxIn({ minX: p.x, minY: p.y, maxX: p.x + s.x, maxY: p.y + s.y })) out.push(n.uid);
    } else {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p && inR(p)) out.push(n.uid);
    }
  }
  return out;
}

/**
 * Rotate (90° counter-clockwise on screen) or mirror a selection as one piece around its centre
 * (snapped to `grid`). Selected wires, labels, junctions and no-connects turn with it; wires
 * outside the selection that end on its pins follow as in moveSymbolsOps. A single symbol on
 * its own turns around its own origin.
 */
export function transformSelectionOps(doc: Doc, engine: StyleEngine, uids: string[], how: 'rotate' | 'mirror-h' | 'mirror-v', grid = 1.27): Op[] {
  const nodes = uids.map((u) => doc.nodes.get(u)).filter((n): n is DocNode => !!n && SELECTABLE.has(n.type) && n.type !== 'block' && !(n.type === 'label' && doc.nodes.get(n.parent ?? '')?.type === 'symbol'));
  if (!nodes.length) return [];
  const rot = (n: DocNode) => Number(engine.get(n.uid, 'rotation')?.value ?? 0);
  const mir = (n: DocNode) => ((engine.get(n.uid, 'mirror')?.value as Mirror | undefined) ?? 'none');
  const turn = (r: number, m: Mirror) =>
    // A mirrored frame turns the other way on screen for the same change of rotation.
    how === 'rotate' ? { rotation: (r + (m === 'none' ? 90 : 270)) % 360, mirror: m } : toggleMirror(r, m, how === 'mirror-h' ? 'h' : 'v');
  if (nodes.length === 1 && nodes[0]!.type === 'symbol') {
    const n = nodes[0]!;
    return moveSymbolsOps(doc, engine, [{ uid: n.uid, ...turn(rot(n), mir(n)) }], { skip: new Set(uids) });
  }
  // Centre of everything selected, on the grid so turned items stay on it.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: Vec2) => ((x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y)));
  for (const n of nodes) {
    if (n.type === 'symbol') {
      const b = symbolBounds(doc, engine, n.uid);
      grow({ x: b.minX, y: b.minY });
      grow({ x: b.maxX, y: b.maxY });
    } else if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(n.uid, k)?.value);
        if (p) grow(p);
      }
    } else {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) grow(p);
    }
  }
  const c = { x: Math.round((x0 + x1) / 2 / grid) * grid, y: Math.round((y0 + y1) / 2 / grid) * grid };
  const T = (p: Vec2): Vec2 =>
    round(how === 'rotate' ? { x: c.x + (p.y - c.y), y: c.y - (p.x - c.x) } : how === 'mirror-h' ? { x: 2 * c.x - p.x, y: p.y } : { x: p.x, y: 2 * c.y - p.y });
  const ops: Op[] = [];
  const moves: SymbolMove[] = [];
  const points: { from: Vec2; to: Vec2 }[] = [];
  for (const n of nodes) {
    if (n.type === 'symbol') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) moves.push({ uid: n.uid, position: T(p), ...turn(rot(n), mir(n)) });
    } else if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(n.uid, k)?.value);
        if (p) ops.push({ op: 'setRule', uid: n.uid, name: k, decl: { name: k, value: T(p) } }), points.push({ from: p, to: T(p) });
      }
    } else {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) ops.push({ op: 'setRule', uid: n.uid, name: 'position', decl: { name: 'position', value: T(p) } }), points.push({ from: p, to: T(p) });
      if (n.type === 'label') {
        const r = rot(n);
        const nr = how === 'rotate' ? (r + 90) % 360 : (how === 'mirror-h') === (r % 180 === 0) ? (r + 180) % 360 : r;
        if (nr !== r) ops.push({ op: 'setRule', uid: n.uid, name: 'rotation', decl: { name: 'rotation', value: nr } });
      }
    }
  }
  const sheet = sheetOf(doc, nodes[0]!);
  return moveSymbolsOps(doc, engine, moves, { skip: new Set(uids), points, pre: ops, ...(sheet ? { sheet: sheet.uid } : {}) });
}

// ---------- junctions and wire dragging (S4) ----------

/**
 * Junction upkeep on a sheet: a dot wherever three or more connections meet (wire ends,
 * pins, a wire passing through counts twice), none anywhere else. Two wires that only cross
 * stay unconnected; a junction already placed on a crossing is kept (it connects them).
 */
export function junctionOps(doc: Doc, engine: StyleEngine, sheetUid: string): Op[] {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return [];
  const segs: [Vec2, Vec2][] = [];
  const ends: Vec2[] = [];
  const pins: Vec2[] = [];
  const junctions: { uid: string; at: Vec2 }[] = [];
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b && !same(a, b)) (segs.push([a, b]), ends.push(a, b));
    } else if (n.type === 'junction') {
      const at = vec(engine.get(n.uid, 'position')?.value);
      if (at) junctions.push({ uid: n.uid, at });
    } else if (n.type === 'symbol') {
      const f = symbolFrame(engine, n.uid);
      for (const pc of n.children) {
        const k = doc.nodes.get(pc);
        const local = k?.type === 'pin' ? vec(engine.get(k.uid, 'position')?.value) : undefined;
        if (local) pins.push(symToSheet(f, local));
      }
    }
  }
  const degree = (p: Vec2) =>
    ends.filter((e) => same(e, p)).length +
    pins.filter((q) => same(q, p)).length +
    2 * segs.filter(([a, b]) => !same(a, p) && !same(b, p) && onSeg(p, a, b)).length;
  const need = new Map<string, Vec2>();
  for (const p of [...ends, ...pins]) if (!need.has(key(p)) && degree(p) >= 3) need.set(key(p), p);
  const ops: Op[] = [];
  const have = new Set<string>();
  for (const j of junctions) {
    const k = key(j.at);
    const crossingKept = degree(j.at) >= 4 && !ends.some((e) => same(e, j.at)) && !pins.some((q) => same(q, j.at));
    if ((need.has(k) || crossingKept) && !have.has(k)) have.add(k);
    else ops.push({ op: 'remove', uid: j.uid });
  }
  let i = 0;
  for (const [k, p] of need) {
    if (have.has(k)) continue;
    ops.push({ op: 'add', parent: sheetUid, index: sheet.children.length + i++, tree: { nodes: [{ uid: newUid('jct'), type: 'junction', name: '', props: {}, rules: [{ name: 'position', value: round(p) }], parent: sheetUid, children: [] }] } });
  }
  return ops;
}

/** Sheets an op list touches (looked up before the ops are applied). */
function sheetsOfOps(doc: Doc, ops: Op[]): Set<string> {
  const out = new Set<string>();
  const add = (uid: string) => {
    const n = doc.nodes.get(uid);
    if (!n) return;
    if (n.type === 'sheet') return void out.add(n.uid);
    const s = sheetOf(doc, n);
    if (s) out.add(s.uid);
  };
  for (const op of ops) {
    if (op.op === 'add') add(op.parent);
    else if ('uid' in op && typeof op.uid === 'string') add(op.uid);
  }
  return out;
}

/** `ops` plus the junction changes they make necessary on the sheets they touch. */
export function withJunctionsOps(doc: Doc, engine: StyleEngine, ops: Op[]): Op[] {
  if (!ops.length) return ops;
  const sheets = sheetsOfOps(doc, ops);
  if (!sheets.size) return ops;
  const res = applyOps(doc, ops);
  engine.recompute();
  try {
    const more: Op[] = [];
    for (const sid of sheets) if (doc.nodes.has(sid)) more.push(...junctionOps(doc, engine, sid));
    return more.length ? [...ops, ...more] : ops;
  } finally {
    applyOps(doc, res.inverse);
    engine.recompute();
  }
}

/**
 * Drag one wire segment by `d` (sheet mm). A horizontal wire only moves up / down and a vertical
 * one only left / right. At each end, wires running along the drag stretch; anything else there
 * (a pin, label, junction, a wire in line or a wire the end rests on) stays put and a new short
 * wire keeps it connected.
 */
export function dragWireOps(doc: Doc, engine: StyleEngine, uid: string, d: Vec2): Op[] {
  const w = doc.nodes.get(uid);
  if (!w || w.type !== 'wire' || !w.parent) return [];
  const a = vec(engine.get(uid, 'start')?.value);
  const b = vec(engine.get(uid, 'end')?.value);
  if (!a || !b) return [];
  const horiz = Math.abs(a.y - b.y) < EPS;
  const vert = Math.abs(a.x - b.x) < EPS;
  const dd = horiz && !vert ? { x: 0, y: d.y } : vert && !horiz ? { x: d.x, y: 0 } : d;
  if (Math.abs(dd.x) < EPS && Math.abs(dd.y) < EPS) return [];
  const sheet = doc.nodes.get(w.parent)!;
  const o = obstacles(doc, engine, sheet.uid, uid);
  const ops: Op[] = [];
  const mv = (p: Vec2) => round({ x: p.x + dd.x, y: p.y + dd.y });
  ops.push({ op: 'setRule', uid, name: 'start', decl: { name: 'start', value: mv(a) } });
  ops.push({ op: 'setRule', uid, name: 'end', decl: { name: 'end', value: mv(b) } });
  const alongDrag = (p: Vec2, q: Vec2) => (Math.abs(dd.x) < EPS ? Math.abs(p.x - q.x) < EPS : Math.abs(p.y - q.y) < EPS);
  let n = 0;
  for (const e of [a, b]) {
    let fixed = false;
    // Other wires with an end here.
    for (const c of sheet.children) {
      const v = doc.nodes.get(c);
      if (!v || v.type !== 'wire' || v.uid === uid) continue;
      const s = vec(engine.get(v.uid, 'start')?.value);
      const t = vec(engine.get(v.uid, 'end')?.value);
      if (!s || !t) continue;
      const atS = same(s, e), atT = same(t, e);
      if (!atS && !atT) {
        if (onSeg(e, s, t)) fixed = true; // our end rests on that wire's middle
        continue;
      }
      if (alongDrag(s, t) && !(Math.abs(dd.x) > EPS && Math.abs(dd.y) > EPS)) ops.push({ op: 'setRule', uid: v.uid, name: atS ? 'start' : 'end', decl: { name: atS ? 'start' : 'end', value: mv(e) } });
      else fixed = true;
    }
    // Pins, labels, junctions, no-connects sitting on this end stay where they are.
    o.points.forEach((p, i) => {
      const owner = doc.nodes.get(o.pointOwners?.[i] ?? '');
      if (owner && owner.type !== 'wire' && same(p, e)) fixed = true;
    });
    if (fixed) {
      ops.push({ op: 'add', parent: sheet.uid, index: sheet.children.length + n++, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: round(e) }, { name: 'end', value: mv(e) }], parent: sheet.uid, children: [] }] } });
    }
  }
  return ops;
}

// ---------- clean wire paths (S7) ----------

/**
 * A right-angle path for a new wire from `from` to `to` that does not pass through symbol
 * bodies or over pins, wires or labels of other nets (items already on the nets at either end
 * may be touched: that connects nothing new). Tries a straight line or one bend first, then
 * two bends, then a grid search with as few bends as practical. Returns null when there is no
 * clean path nearby; the caller should then suggest net labels.
 */
export function routeWirePath(doc: Doc, engine: StyleEngine, sheetUid: string, from: Vec2, to: Vec2, opts: { horizontalFirst?: boolean } = {}): Vec2[] | null {
  if (same(from, to)) return null;
  const netOf = itemNets(doc, engine);
  const all = obstacles(doc, engine, sheetUid, '');
  // Nets already present at the two ends.
  const own = new Set<string>();
  all.points.forEach((p, i) => {
    if (same(p, from) || same(p, to)) {
      const n = netOf.get(all.pointOwners?.[i] ?? '');
      if (n !== undefined) own.add(n);
    }
  });
  all.segs.forEach(([a, b], i) => {
    if (onSeg(from, a, b) || onSeg(to, a, b)) {
      const n = netOf.get(all.segOwners?.[i] ?? '');
      if (n !== undefined) own.add(n);
    }
  });
  const keepP = all.points.map((_, i) => !own.has(netOf.get(all.pointOwners?.[i] ?? '') ?? '\u0000'));
  const keepS = all.segs.map((_, i) => !own.has(netOf.get(all.segOwners?.[i] ?? '') ?? '\u0000'));
  const o: Obstacles = {
    points: all.points.filter((_, i) => keepP[i]),
    pointOwners: all.pointOwners?.filter((_, i) => keepP[i]),
    segs: all.segs.filter((_, i) => keepS[i]),
    segOwners: all.segOwners?.filter((_, i) => keepS[i]),
    boxes: all.boxes,
  };
  const tidy = (path: Vec2[]) => path.filter((p, i) => i === 0 || !same(p, path[i - 1]!));
  // Straight or one bend, in both orders, then two bends.
  // candidates(…, wasH=false) starts with horizontal-then-vertical.
  for (const path of candidates(from, to, opts.horizontalFirst === false).slice(0, 2)) if (clear(tidy(path), o)) return tidy(path);
  for (const path of candidates(from, to, true).slice(2)) if (clear(tidy(path), o)) return tidy(path);
  for (const margin of [12.7, 38.1]) {
    const path = gridPath(from, to, o, margin);
    if (path) return tidy(path);
  }
  return null;
}

/** Ops for a wire along `path` (one wire per straight piece) on a sheet. */
export function wirePathOps(doc: Doc, sheetUid: string, path: Vec2[]): Op[] {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return [];
  const ops: Op[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    if (same(path[i]!, path[i + 1]!)) continue;
    ops.push({ op: 'add', parent: sheetUid, index: sheet.children.length + i, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: round(path[i]!) }, { name: 'end', value: round(path[i + 1]!) }], parent: sheetUid, children: [] }] } });
  }
  return ops;
}
