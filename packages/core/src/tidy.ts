/**
 * Jog removal (S8, agreement 0.3): make wires straight where a small change allows it.
 *
 * A "chain" is a run of wires joined end to end with nothing else at the joints; it ends at
 * pins, labels, junctions, branches or a wire it rests on. A chain with bends is re-routed
 * between its two ends (which may now end on a same-net wire instead, e.g. sliding a T along
 * a divider), and when that does not help, a small part at one end is moved so the pins line
 * up. Every change is kept only if the netlist is unchanged and the sheet has fewer bends.
 */
import { applyOps, type Op } from './commands.ts';
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { symbolFrame, symToSheet } from './schematic.ts';
import { moveSymbolsOps, netGroups, routeConnection, wirePathOps } from './schematicEdit.ts';
import { runErc } from './erc.ts';

const EPS = 1e-3;
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const onSeg = (p: Vec2, a: Vec2, b: Vec2) =>
  Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS && Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS &&
  Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < EPS;

export interface WireChain {
  wires: string[];
  /** The two ends, and the points in between in order. */
  points: Vec2[];
  bends: number;
  /** Some piece is neither horizontal nor vertical. */
  slanted: boolean;
}

interface Seg {
  uid: string;
  a: Vec2;
  b: Vec2;
}

/** Wires of a sheet split into chains (see the module comment). */
export function wireChains(doc: Doc, engine: StyleEngine, sheetUid: string): WireChain[] {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return [];
  const segs: Seg[] = [];
  const things: Vec2[] = []; // pins, labels, junctions, no-connects
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b && !same(a, b)) segs.push({ uid: n.uid, a, b });
    } else if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) things.push(p);
    } else if (n.type === 'symbol') {
      const f = symbolFrame(engine, n.uid);
      for (const k of n.children) {
        const pn = doc.nodes.get(k);
        if (pn?.type === 'pin') {
          const local = vec(engine.get(pn.uid, 'position')?.value);
          if (local) things.push(symToSheet(f, local));
        } else if (pn?.type === 'label') {
          const p = vec(engine.get(pn.uid, 'position')?.value);
          if (p) things.push(p);
        }
      }
    }
  }
  // A plain joint: exactly two wire ends meet, nothing else there, not resting on a wire.
  const plain = (p: Vec2) =>
    !things.some((q) => same(q, p)) &&
    segs.filter((s) => same(s.a, p) || same(s.b, p)).length === 2 &&
    !segs.some((s) => !same(s.a, p) && !same(s.b, p) && onSeg(p, s.a, s.b));
  const seen = new Set<string>();
  const out: WireChain[] = [];
  for (const s0 of segs) {
    if (seen.has(s0.uid)) continue;
    seen.add(s0.uid);
    const wires = [s0.uid];
    const pts: Vec2[] = [s0.a, s0.b];
    // Walk both ways from the first wire.
    for (const dir of ['back', 'fwd'] as const) {
      for (let guard = 0; guard < 256; guard++) {
        const end = dir === 'fwd' ? pts[pts.length - 1]! : pts[0]!;
        if (!plain(end)) break;
        const next = segs.find((s) => !seen.has(s.uid) && (same(s.a, end) || same(s.b, end)));
        if (!next) break;
        seen.add(next.uid);
        const far = same(next.a, end) ? next.b : next.a;
        if (dir === 'fwd') (wires.push(next.uid), pts.push(far));
        else (wires.unshift(next.uid), pts.unshift(far));
      }
    }
    const slanted = pts.slice(1).some((q, i) => Math.abs(q.x - pts[i]!.x) > EPS && Math.abs(q.y - pts[i]!.y) > EPS);
    out.push({ wires, points: pts, bends: countBends(pts), slanted });
  }
  return out;
}

function countBends(pts: Vec2[]): number {
  let n = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > EPS) n++;
  }
  return n;
}

/** Total bends of all chains on a sheet. */
export function sheetBends(doc: Doc, engine: StyleEngine, sheetUid: string): number {
  return wireChains(doc, engine, sheetUid).reduce((s, c) => s + c.bends, 0);
}

/**
 * Chains that jog: they bend, and their two ends are offset by at most `max` mm on one axis
 * (so moving one end that far would make them straight).
 */
export function shortJogs(doc: Doc, engine: StyleEngine, sheetUid: string, max = 5.08): WireChain[] {
  return wireChains(doc, engine, sheetUid).filter((c) => {
    if (!c.bends) return false;
    const a = c.points[0]!, b = c.points[c.points.length - 1]!;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    return (dx > EPS && dx <= max + EPS) || (dy > EPS && dy <= max + EPS);
  });
}

export interface TidyResult {
  ops: Op[];
  /** Bends on the sheet before / after. */
  before: number;
  after: number;
  rerouted: number;
  moved: string[];
}

/**
 * Ops that remove jogs on a sheet. `moveParts` (default true) allows the second pass that moves
 * small parts (at most `maxPins` pins, default 4) by up to `maxShift` mm (default 5.08).
 */
export function tidyWiresOps(doc: Doc, engine: StyleEngine, sheetUid: string, opts: { moveParts?: boolean; maxPins?: number; maxShift?: number; checkEachStep?: boolean } = {}): TidyResult {
  const res = tidyOnce(doc, engine, sheetUid, opts);
  if (opts.checkEachStep || !res.ops.length) return res;
  // The fast run checks connectivity once at the end; if that ever fails, redo it step by step.
  const key = netGroups(doc, engine);
  const r = applyOps(doc, res.ops);
  engine.recompute();
  const ok = netGroups(doc, engine) === key;
  applyOps(doc, r.inverse);
  engine.recompute();
  return ok ? res : tidyOnce(doc, engine, sheetUid, { ...opts, checkEachStep: true });
}

function tidyOnce(doc: Doc, engine: StyleEngine, sheetUid: string, opts: { moveParts?: boolean; maxPins?: number; maxShift?: number; checkEachStep?: boolean }): TidyResult {
  const key = netGroups(doc, engine);
  const start = sheetBends(doc, engine, sheetUid);
  const applied: Op[] = [];
  const undo: Op[][] = [];
  const loose0 = looseCount(doc, engine, sheetUid);
  const keep = (ops: Op[], ok: () => boolean): boolean => {
    if (!ops.length) return false;
    let r;
    try {
      r = applyOps(doc, ops);
    } catch {
      return false;
    }
    engine.recompute();
    // Never leave a power symbol, label or pin hanging that was attached before.
    if (ok() && looseCount(doc, engine, sheetUid) <= loose0) {
      applied.push(...ops);
      undo.push(r.inverse);
      return true;
    }
    applyOps(doc, r.inverse);
    engine.recompute();
    return false;
  };
  let rerouted = 0;
  const moved: string[] = [];
  // Pass 1: re-route chains with bends between their ends; each kept change lowers the bends.
  const reroutePass = (near?: Vec2[]) => {
    const touches = (c: WireChain) => !near || c.points.some((q) => near.some((n) => same(n, q)));
    // Wires drawn across a part body are re-routed too, even when they are straight.
    const across = new Set(runErc(doc, engine).violations.filter((v) => v.kind === 'wireThroughPart' && v.sheet === sheetUid).map((v) => v.uids[0]!));
    for (const chain of wireChains(doc, engine, sheetUid).filter((c) => (c.bends > 0 || c.slanted || c.wires.some((u) => across.has(u))) && touches(c))) {
      const through = chain.wires.some((u) => across.has(u));
      if (!chain.wires.every((u) => doc.nodes.has(u))) continue;
      const a = chain.points[0]!, b = chain.points[chain.points.length - 1]!;
      // Route with the chain taken away, so it does not block its own replacement.
      const rm: Op[] = chain.wires.map((uid) => ({ op: 'remove', uid }));
      const r = applyOps(doc, rm);
      engine.recompute();
      const path = routeConnection(doc, engine, sheetUid, a, b);
      applyOps(doc, r.inverse);
      engine.recompute();
      if (!path || (!chain.slanted && !through && path.length - 2 >= chain.bends)) continue;
      const ops = [...rm, ...wirePathOps(doc, sheetUid, path)];
      // The router never touches other nets and the new path has fewer bends, so the
      // step-by-step check is only needed in the careful run.
      if (keep(ops, () => !opts.checkEachStep || netGroups(doc, engine) === key)) rerouted++;
    }
  };
  try {
    reroutePass();
    // Pass 2: move a small part at one end of a remaining jog, then re-route; kept only if the
    // sheet ends up with fewer bends and the same connections.
    if (opts.moveParts !== false) {
      const maxPins = opts.maxPins ?? 4;
      const maxShift = opts.maxShift ?? 5.08;
      for (const chain of shortJogs(doc, engine, sheetUid, maxShift)) {
        if (!chain.wires.every((u) => doc.nodes.has(u))) continue;
        const a = chain.points[0]!, b = chain.points[chain.points.length - 1]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const shifts: Vec2[] = [];
        if (Math.abs(dx) > EPS && Math.abs(dx) <= maxShift + EPS) shifts.push({ x: dx, y: 0 });
        if (Math.abs(dy) > EPS && Math.abs(dy) <= maxShift + EPS) shifts.push({ x: 0, y: dy });
        let done = false;
        for (const [end, sign] of [[a, 1], [b, -1]] as const) {
          if (done) break;
          const sym = symbolAtPin(doc, engine, sheetUid, end);
          if (!sym) continue;
          const node = doc.nodes.get(sym)!;
          if (moved.includes(String(node.props.ref ?? sym))) continue;
          const pins = node.children.filter((c) => doc.nodes.get(c)?.type === 'pin').length;
          if (pins > maxPins) continue;
          for (const s of shifts) {
            const at = vec(engine.get(sym, 'position')?.value);
            if (!at) break;
            const bendsBefore = sheetBends(doc, engine, sheetUid);
            const mark = { applied: applied.length, undo: undo.length, rerouted };
            // Ends only (wires may slant for a moment); the re-route pass straightens them.
            const ops = moveSymbolsOps(doc, engine, [{ uid: sym, position: { x: at.x + sign * s.x, y: at.y + sign * s.y } }], { orthogonal: false });
            if (!keep(ops, () => netGroups(doc, engine) === key)) continue;
            // Only wires at the moved part's pins need another look.
            reroutePass(connectionPoints(doc, engine, sym));
            const anySlanted = wireChains(doc, engine, sheetUid).some((c) => c.slanted);
            if (!anySlanted && netGroups(doc, engine) === key && sheetBends(doc, engine, sheetUid) < bendsBefore) {
              moved.push(String(node.props.ref ?? sym));
              done = true;
              break;
            }
            // Not better: take the move and its re-routes back.
            for (const inv of undo.splice(mark.undo).reverse()) applyOps(doc, inv);
            engine.recompute();
            applied.length = mark.applied;
            rerouted = mark.rerouted;
          }
        }
      }
    }
  } finally {
    // Leave the document as it was: the caller applies the ops as one undo step.
    for (const inv of undo.reverse()) applyOps(doc, inv);
    engine.recompute();
  }
  // Recount on the result for the report.
  const r = applyOps(doc, applied);
  engine.recompute();
  const after = sheetBends(doc, engine, sheetUid);
  applyOps(doc, r.inverse);
  engine.recompute();
  return { ops: applied, before: start, after, rerouted, moved };
}

/** The symbol (uid) whose pin — or, for a power symbol, its connection point — sits at `p`. */
function symbolAtPin(doc: Doc, engine: StyleEngine, sheetUid: string, p: Vec2): string | null {
  for (const c of doc.nodes.get(sheetUid)?.children ?? []) {
    const n = doc.nodes.get(c);
    if (n?.type !== 'symbol') continue;
    if (n.props.power) {
      const lbl = n.children.map((k) => doc.nodes.get(k)).find((k) => k?.type === 'label');
      const at = lbl ? vec(engine.get(lbl.uid, 'position')?.value) : undefined;
      if (at && same(at, p)) return n.uid;
    }
    const f = symbolFrame(engine, n.uid);
    for (const k of n.children) {
      const pn = doc.nodes.get(k);
      const local = pn?.type === 'pin' ? vec(engine.get(pn.uid, 'position')?.value) : undefined;
      if (local && same(symToSheet(f, local), p)) return n.uid;
    }
  }
  return null;
}

/** Sheet points where a symbol connects: its pins, or a power symbol's connection point. */
function connectionPoints(doc: Doc, engine: StyleEngine, symUid: string): Vec2[] {
  const n = doc.nodes.get(symUid);
  if (!n) return [];
  const f = symbolFrame(engine, symUid);
  const out: Vec2[] = [];
  for (const k of n.children) {
    const c = doc.nodes.get(k);
    if (c?.type === 'pin') {
      const local = vec(engine.get(c.uid, 'position')?.value);
      if (local) out.push(symToSheet(f, local));
    } else if (c?.type === 'label') {
      const at = vec(engine.get(c.uid, 'position')?.value);
      if (at) out.push(at);
    }
  }
  return out;
}

/**
 * How many power symbols, net labels and pins on a sheet touch no wire and no other item
 * (unconnected pins with nothing on them included). Tidying must never raise it.
 */
export function looseCount(doc: Doc, engine: StyleEngine, sheetUid: string): number {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return 0;
  const segs: [Vec2, Vec2][] = [];
  const pts: { p: Vec2; owner: string }[] = [];
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) segs.push([a, b]);
    } else if (n.type === 'label') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) pts.push({ p, owner: n.uid });
    } else if (n.type === 'symbol') {
      for (const q of connectionPoints(doc, engine, n.uid)) pts.push({ p: q, owner: n.uid });
    }
  }
  let loose = 0;
  for (const { p, owner } of pts) {
    const onWire = segs.some(([a, b]) => onSeg(p, a, b));
    const onOther = pts.some((o) => o.owner !== owner && same(o.p, p));
    if (!onWire && !onOther) loose++;
  }
  return loose;
}
