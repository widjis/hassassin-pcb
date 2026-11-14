/**
 * Shove (docs/05-pcb-improvements.md, P9): given new copper (traces and vias of one net), move the
 * traces of other nets that are in its way aside, keeping their clearance and their connections, or
 * refuse. Written from the published idea of shove routing (a pushed line walks around the hull of the
 * item that pushes it; what it then hits is pushed in turn), not from another tool's source.
 *
 * How it works here:
 * - the piece that pushes is wrapped in an octagonal hull (sides at 0°, 45° and 90° to the board axes, so a
 *   pushed trace keeps to 45° geometry), grown by the clearance and the pushed trace's half width;
 * - a trace of another net that comes too close is followed along its chain (segments of its net and
 *   layer joined end to end, no branch, no pad or via at the joint) while the joints lie inside the hull;
 *   that stretch is replaced by a walk around the hull on the shorter side;
 * - the way round may not touch the new copper or the other pieces of the net that pushes (they cannot be
 *   pushed back): when it would, those pieces join the hull and the way round is found again;
 * - the new pieces of the pushed trace push in their turn, up to a step limit;
 * - nothing locked is moved (`locked` on the trace or on its net), a joint at a pad or via is never moved,
 *   arcs are not pushed; a via of another net in the way steps aside along one of the 8 directions (along
 *   one of its own traces where it can), its trace ends follow, and those pieces push in turn;
 * - at the end the result is checked on the board for a moment: DRC may not report any new error and the
 *   connectivity of every net must be the same; otherwise the shove is refused.
 * The result is one list of operations (one undo step); the board is left as it was.
 */
import { applyOps, type Op } from './commands.ts';
import { computeRatsnest } from './connectivity.ts';
import { clearanceFor, collectCopper, inArea } from './copper.ts';
import { runDrc } from './drc.ts';
import { distToSegment, pointInPolygon, segSegDist } from './geom.ts';
import { newUid, type Doc, type DocNode, type KeepOut, type RuleDecl, type Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export interface ShoveTrace {
  layer: string;
  a: Vec2;
  b: Vec2;
  width: number;
}
export interface ShoveInput {
  net: string;
  traces?: ShoveTrace[];
  vias?: { at: Vec2; diameter: number }[];
}
export interface ShoveResult {
  /** The operations that move the other nets' traces (the new copper itself is not in them). */
  ops: Op[];
  /** Traces removed or added (uids), and the nets that moved. */
  moved: string[];
  nets: string[];
  error?: string;
}

export interface ShoveSeg {
  uid: string;
  net: string;
  layer: string;
  a: Vec2;
  b: Vec2;
  w: number;
  locked: boolean;
  arc: boolean;
  /** Present on the board before the shove (else added by it). */
  old: boolean;
  node?: DocNode;
  /** The caller's grouping (e.g. the route a segment belongs to); new pieces keep their trace's group. */
  group?: string;
}
export interface ShovePusher {
  net: string;
  layers: string[];
  a: Vec2;
  b: Vec2;
  half: number;
}

const eq = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;

/**
 * The smallest octagon with sides at 0°, 45° and 90° (in board axes) around a set of capsules a–b of
 * radius r: bounded by x, y, x + y and x − y. Every side keeps a pushed trace on 45° geometry.
 */
export function boundOctagon(caps: { a: Vec2; b: Vec2; r: number }[]): Vec2[] {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, smin = Infinity, smax = -Infinity, dmin = Infinity, dmax = -Infinity;
  for (const c of caps)
    for (const q of [c.a, c.b]) {
      const r2 = c.r * Math.SQRT2;
      xmin = Math.min(xmin, q.x - c.r), xmax = Math.max(xmax, q.x + c.r), ymin = Math.min(ymin, q.y - c.r), ymax = Math.max(ymax, q.y + c.r);
      smin = Math.min(smin, q.x + q.y - r2), smax = Math.max(smax, q.x + q.y + r2), dmin = Math.min(dmin, q.x - q.y - r2), dmax = Math.max(dmax, q.x - q.y + r2);
    }
  // The box, cut by the four diagonal half-planes (x + y ≥ smin, x + y ≤ smax, x − y ≥ dmin, x − y ≤ dmax).
  let poly: Vec2[] = [
    { x: xmin, y: ymin },
    { x: xmax, y: ymin },
    { x: xmax, y: ymax },
    { x: xmin, y: ymax },
  ];
  const cut = (f: (q: Vec2) => number) => {
    const out: Vec2[] = [];
    for (let k = 0; k < poly.length; k++) {
      const P = poly[k]!;
      const Q = poly[(k + 1) % poly.length]!;
      const fp = f(P);
      const fq = f(Q);
      if (fp <= 1e-12) out.push(P);
      if ((fp < -1e-12 && fq > 1e-12) || (fp > 1e-12 && fq < -1e-12)) {
        const t = fp / (fp - fq);
        out.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
      }
    }
    poly = out;
  };
  cut((q) => smin - (q.x + q.y));
  cut((q) => q.x + q.y - smax);
  cut((q) => dmin - (q.x - q.y));
  cut((q) => q.x - q.y - dmax);
  return simplify(poly, true);
}

/** Where segment p–q first crosses the polygon's boundary going from p (t along p–q, and the edge index). */
function crossings(p: Vec2, q: Vec2, poly: Vec2[]): { t: number; edge: number; at: Vec2 }[] {
  const out: { t: number; edge: number; at: Vec2 }[] = [];
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / den;
    const u = ((a.x - p.x) * ry - (a.y - p.y) * rx) / den;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) out.push({ t, edge: i, at: { x: p.x + rx * t, y: p.y + ry * t } });
  }
  return out.sort((x, y) => x.t - y.t);
}

const plen = (pts: Vec2[]) => pts.reduce((s, q, i) => (i ? s + Math.hypot(q.x - pts[i - 1]!.x, q.y - pts[i - 1]!.y) : 0), 0);

/** Drop repeated and collinear points. */
function simplify(pts: Vec2[], closed = false): Vec2[] {
  const out: Vec2[] = [];
  for (const q of pts) {
    if (out.length && eq(out[out.length - 1]!, q)) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (q.y - b.y) - (b.y - a.y) * (q.x - b.x);
      const dot = (b.x - a.x) * (q.x - b.x) + (b.y - a.y) * (q.y - b.y);
      if (Math.abs(cross) < 1e-9 && dot > 0) out.pop();
      else break;
    }
    out.push(q);
  }
  if (closed) while (out.length > 3 && eq(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

export function planShove(doc: Doc, engine: StyleEngine, copper: string[], input: ShoveInput, opts: { maxSteps?: number } = {}): ShoveResult {
  const fail = (error: string): ShoveResult => ({ ops: [], moved: [], nets: [], error });
  const netNode = new Map<string, DocNode>();
  for (const n of doc.nodes.values()) if (n.type === 'net') netNode.set(n.name, n);
  const netClear = (net: string) => {
    const n = netNode.get(net);
    const k = n ? (engine.get(n.uid, 'keepOut')?.value as KeepOut | undefined) : undefined;
    return k ? clearanceFor(k, 'trace') : 0.2;
  };
  // Traces on the board.
  const segs: ShoveSeg[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' || !n.parent) continue;
    const net = doc.nodes.get(n.parent);
    if (net?.type !== 'net') continue;
    const a = engine.get(n.uid, 'start')?.value as Vec2 | undefined;
    const b = engine.get(n.uid, 'end')?.value as Vec2 | undefined;
    if (!a || !b) continue;
    segs.push({ uid: n.uid, net: net.name, layer: String(engine.get(n.uid, 'layer')?.value ?? ''), a, b, w: Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25), locked: !!n.props.locked || !!net.props.locked, arc: !!engine.get(n.uid, 'mid')?.value, old: true, node: n });
  }
  // Points a pushed trace may not move: on a pad or a via of its net, or the end / branch of a chain.
  const shapes = collectCopper(doc, engine, copper);
  const viaAt = shapes.filter((s) => s.kind === 'via');
  const padAt = shapes.filter((s) => s.kind === 'pad');
  const fixed = (net: string, layer: string, p: Vec2, live: ShoveSeg[]) => {
    if (padAt.some((s) => s.net === net && s.layer === layer && s.areas[0] && inArea(p, s.areas[0]))) return true;
    if (viaAt.some((s) => s.net === net && s.areas[0] && inArea(p, s.areas[0]))) return true;
    return live.filter((s) => s.net === net && s.layer === layer && (eq(s.a, p) || eq(s.b, p))).length !== 2;
  };

  // The pushers: the new copper first, then every piece a pushed trace gets.
  const queue: ShovePusher[] = [];
  const movedVias: string[] = [];
  for (const t of input.traces ?? []) queue.push({ net: input.net, layers: [t.layer], a: t.a, b: t.b, half: t.width / 2 });
  for (const v of input.vias ?? []) queue.push({ net: input.net, layers: [...copper], a: v.at, b: v.at, half: v.diameter / 2 });
  // Vias of other nets in the way move (P9): the shortest step along one of the 8 directions (along one of
  // its own traces preferred, so their angle stays) that clears every pusher of the new copper; the trace
  // ends on it follow, and those pieces push in turn. A locked via, or one with nowhere to go within
  // 3 mm, refuses the shove.
  const viaOps: Op[] = [];
  const preRemoved = new Set<string>();
  const firstPushers = queue.slice();
  const viaNodes = [...doc.nodes.values()].filter((n) => n.type === 'via' && n.parent && doc.nodes.get(n.parent)?.type === 'net');
  for (const vn of viaNodes) {
    const vnet = doc.nodes.get(vn.parent!)!;
    const c = engine.get(vn.uid, 'position')?.value as Vec2 | undefined;
    if (!c) continue;
    const r = Number(engine.get(vn.uid, 'viaDiameter')?.value ?? 0.6) / 2;
    const need = (q: Vec2) => firstPushers.filter((p) => p.net !== vnet.name).map((p) => ({ p, gap: distToSegment(q, p.a, p.b) - r - p.half - Math.max(netClear(p.net), netClear(vnet.name)) }));
    if (!need(c).some((x) => x.gap < -1e-6)) continue;
    if (vn.props.locked || vnet.props.locked) return fail(`a locked via of ${vnet.name} is in the way`);
    // Traces of the via's net that end on it (any layer).
    const onVia = segs.filter((sg) => sg.net === vnet.name && (Math.hypot(sg.a.x - c.x, sg.a.y - c.y) < r || Math.hypot(sg.b.x - c.x, sg.b.y - c.y) < r));
    if (onVia.some((sg) => sg.locked || sg.arc)) return fail(`a via of ${vnet.name} cannot move: a locked trace or an arc ends on it`);
    let best: { d: Vec2; cost: number } | undefined;
    for (let k = 0; k < 8; k++) {
      const u = { x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) };
      const clear = (t: number) => need({ x: c.x + u.x * t, y: c.y + u.y * t }).every((x) => x.gap >= 0.005);
      if (!clear(3)) continue;
      let lo = 0, hi = 3;
      for (let it = 0; it < 30; it++) {
        const mid = (lo + hi) / 2;
        if (clear(mid)) hi = mid;
        else lo = mid;
      }
      // A step along a trace of the via keeps that trace's angle; across, the trace turns.
      const across = onVia.filter((sg) => {
        const o = Math.hypot(sg.a.x - c.x, sg.a.y - c.y) < r ? sg.b : sg.a;
        const ex = o.x - c.x, ey = o.y - c.y, L = Math.hypot(ex, ey);
        return L > 1e-9 && Math.abs(u.x * ey - u.y * ex) / L > 1e-3;
      }).length;
      const cost = hi + 0.5 * across;
      if (!best || cost < best.cost) best = { d: { x: +(u.x * hi).toFixed(4), y: +(u.y * hi).toFixed(4) }, cost };
    }
    if (!best) return fail(`a via of ${vnet.name} is in the way and has no room to move`);
    const at = { x: +(c.x + best.d.x).toFixed(4), y: +(c.y + best.d.y).toFixed(4) };
    viaOps.push({ op: 'setRule', uid: vn.uid, name: 'position', decl: { name: 'position', value: at } });
    queue.push({ net: vnet.name, layers: [...copper], a: at, b: at, half: r });
    for (const sg of onVia) {
      const moveEnd = (q: Vec2) => (Math.hypot(q.x - c.x, q.y - c.y) < r ? { x: +(q.x + best!.d.x).toFixed(4), y: +(q.y + best!.d.y).toFixed(4) } : q);
      const moved: ShoveSeg = { ...sg, uid: newUid('tr'), a: moveEnd(sg.a), b: moveEnd(sg.b), old: false };
      segs.splice(segs.indexOf(sg), 1, moved);
      preRemoved.add(sg.uid);
      queue.push({ net: moved.net, layers: [moved.layer], a: moved.a, b: moved.b, half: moved.w / 2 });
    }
    movedVias.push(vn.uid);
  }
  const res = shoveChains(segs, queue, { clearance: (x, y) => Math.max(netClear(x), netClear(y)), fixed, ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}) });
  if ('error' in res) return fail(res.error);
  const { live } = res;
  const removed = new Set([...preRemoved, ...res.removed]);
  const movedNets = res.nets;
  for (const uid of movedVias) movedNets.add(doc.nodes.get(doc.nodes.get(uid)!.parent!)!.name);
  if (!removed.size && !live.some((s) => !s.old) && !viaOps.length) return { ops: [], moved: [], nets: [] };
  // Operations: move the vias, remove the moved traces, add their new pieces (same net, layer, width and properties).
  const ops: Op[] = [...viaOps];
  for (const uid of removed) ops.push({ op: 'remove', uid });
  const index = new Map<string, number>();
  for (const s of live) {
    if (s.old) continue;
    const net = netNode.get(s.net)!;
    const idx = index.get(net.uid) ?? net.children.length - [...removed].filter((u) => doc.nodes.get(u)?.parent === net.uid).length;
    const rules: RuleDecl[] = [{ name: 'start', value: s.a }, { name: 'end', value: s.b }, { name: 'layer', value: s.layer }];
    const own = s.node?.rules.find((r) => r.name === 'traceWidth');
    if (own) rules.push(own);
    ops.push({ op: 'add', parent: net.uid, index: Math.max(0, idx), tree: { nodes: [{ uid: s.uid, type: 'trace', name: '', props: { ...(s.node?.props ?? {}) }, rules, parent: net.uid, children: [] }] } });
    index.set(net.uid, Math.max(0, idx) + 1);
  }
  // Check on the board for a moment: the new copper and the moves together.
  const item: Op[] = [];
  const net = netNode.get(input.net);
  if (net) {
    let i = net.children.length;
    for (const t of input.traces ?? []) item.push({ op: 'add', parent: net.uid, index: i++, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: t.a }, { name: 'end', value: t.b }, { name: 'layer', value: t.layer }, { name: 'traceWidth', value: t.width }], parent: net.uid, children: [] }] } });
    for (const v of input.vias ?? []) item.push({ op: 'add', parent: net.uid, index: i++, tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', props: {}, rules: [{ name: 'position', value: v.at }, { name: 'viaDiameter', value: v.diameter }, { name: 'layers', value: [...copper] }], parent: net.uid, children: [] }] } });
  }
  const islands = () => new Map(computeRatsnest(doc, engine, copper).nets.map((n) => [n.net, n.islands]));
  const errs = () => new Set(runDrc(doc, engine, copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').map((v) => `${v.kind}|${[...v.uids].sort().join(',')}`));
  const before = { isl: islands(), errs: errs() };
  const undo: Op[][] = [];
  let problem: string | undefined;
  try {
    undo.push(applyOps(doc, item).inverse);
    engine.recompute();
    undo.push(applyOps(doc, ops).inverse);
    engine.recompute();
    // With the new copper in place and the others moved, DRC may report only what it reported before.
    const fresh = [...errs()].filter((e) => !before.errs.has(e));
    if (fresh.length) problem = `the result would break a rule (${fresh[0]!.split('|')[0]})`;
    const isl = islands();
    for (const [n, k] of before.isl) if (n !== input.net && (isl.get(n) ?? k) !== k) problem = `${n} would lose a connection`;
  } finally {
    for (const inv of undo.reverse()) applyOps(doc, inv);
    engine.recompute();
  }
  if (problem) return fail(problem);
  return { ops, moved: [...movedVias, ...removed, ...live.filter((s) => !s.old).map((s) => s.uid)], nets: [...movedNets] };
}

/**
 * The shove itself, on any set of trace segments (the board's traces, or the autorouter's routes): the
 * pushers are the new copper, `env` says the clearance between two nets and which points of a net may not
 * move. Returns the segments afterwards (moved ones replaced by new pieces, `old` false), the removed uids
 * and the nets that moved, or why it cannot be done.
 */
export function shoveChains(
  live0: ShoveSeg[],
  input: ShovePusher[],
  env: { clearance: (a: string, b: string) => number; fixed: (net: string, layer: string, p: Vec2, live: ShoveSeg[]) => boolean; maxSteps?: number },
): { live: ShoveSeg[]; removed: Set<string>; nets: Set<string> } | { error: string } {
  const fail2 = (error: string) => ({ error });
  let live = live0.slice();
  const removed = new Set<string>();
  const movedNets = new Set<string>();
  let steps = 0;
  const maxSteps = env.maxSteps ?? 60;
  const queue: ShovePusher[] = input.slice();
  const inNet = input[0]?.net;
  while (queue.length) {
    const p = queue.shift()!;
    for (;;) {
      const hit = live.find((s) => s.net !== p.net && p.layers.includes(s.layer) && segSegDist(s.a, s.b, p.a, p.b) - s.w / 2 - p.half < env.clearance(s.net, p.net) - 1e-6);
      if (!hit) break;
      if (++steps > maxSteps) return fail2('too many traces would have to move');
      if (hit.locked) return fail2(`a locked trace of ${hit.net} is in the way`);
      if (hit.arc) return fail2(`an arc of ${hit.net} is in the way (arcs are not shoved)`);
      // The obstacles the hit trace must go round: the pusher, and any piece of the pusher's net or of the
      // new copper that the way round would still touch (they cannot be pushed back); the hull grows
      // round all of them.
      const rOf = (o: { net: string; half: number }) => o.half + env.clearance(hit.net, o.net) + hit.w / 2 + 0.005;
      const higher: ShovePusher[] = [...input, ...live.filter((x) => x.net === p.net && x.net !== inNet).map((x) => ({ net: x.net, layers: [x.layer], a: x.a, b: x.b, half: x.w / 2 }))].filter((o) => o.layers.includes(hit.layer));
      const obst: ShovePusher[] = [p];
      let chain: ShoveSeg[] = [];
      let way: Vec2[] | undefined;
      for (let grown = 0; grown < 8; grown++) {
        const hull = boundOctagon(obst.map((o) => ({ a: o.a, b: o.b, r: rOf(o) })));
        const inside = (q: Vec2) => pointInPolygon(q, hull);
        // The chain of the hit trace: from the hit segment outwards while the joints lie inside the hull.
        chain = [hit];
        const grow = (end: 'a' | 'b') => {
          for (;;) {
            const first = end === 'a';
            const s0 = first ? chain[0]! : chain[chain.length - 1]!;
            const sharedEnd = first ? s0.a : s0.b;
            if (!inside(sharedEnd)) return true;
            if (env.fixed(hit.net, hit.layer, sharedEnd, live)) return false;
            const next = live.find((x) => x.uid !== s0.uid && !chain.some((c) => c.uid === x.uid) && x.net === hit.net && x.layer === hit.layer && (eq(x.a, sharedEnd) || eq(x.b, sharedEnd)));
            if (!next || next.locked || next.arc) return false;
            // Orient the neighbour so the chain reads a → b throughout.
            const o = first ? (eq(next.b, sharedEnd) ? next : { ...next, a: next.b, b: next.a }) : eq(next.a, sharedEnd) ? next : { ...next, a: next.b, b: next.a };
            if (first) chain.unshift(o);
            else chain.push(o);
          }
        };
        if (!grow('a') || !grow('b')) return fail2(`a trace of ${hit.net} cannot move: a pad, via or branch of it lies in the way`);
        const pts = [chain[0]!.a, ...chain.map((x) => x.b)];
        const A = pts[0]!;
        const B = pts[pts.length - 1]!;
        // Entry into and exit from the hull along the chain.
        const enter = crossings(pts[0]!, pts[1]!, hull)[0];
        const exitC = crossings(pts[pts.length - 2]!, pts[pts.length - 1]!, hull);
        const exit = exitC[exitC.length - 1];
        if (!enter || !exit) return fail2(`could not find a way round for ${hit.net}`);
        // Walk the hull from the entry edge to the exit edge, both ways.
        const walk = (dir: 1 | -1) => {
          const out: Vec2[] = [enter.at];
          let i = enter.edge;
          for (let n = 0; n < hull.length && i !== exit.edge; n++) {
            out.push(dir === 1 ? hull[(i + 1) % hull.length]! : hull[i]!);
            i = (i + dir + hull.length) % hull.length;
          }
          out.push(exit.at);
          // Where the trace meets the hull at 90° or more, cut the corner with a 45° piece on the outer side
          // (away from the hull), as long as the pieces on either side are long enough for it.
          const P = simplify([A, ...out, B]);
          const soft: Vec2[] = [P[0]!];
          for (let k = 1; k + 1 < P.length; k++) {
            const a = P[k - 1]!, c = P[k]!, b = P[k + 1]!;
            const u = { x: c.x - a.x, y: c.y - a.y }, v = { x: b.x - c.x, y: b.y - c.y };
            const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
            const turnsHard = lu > 1e-9 && lv > 1e-9 && (u.x * v.x + u.y * v.y) / (lu * lv) < 1e-6;
            const atEnd = eq(c, enter.at) || eq(c, exit.at);
            const d = Math.min(2 * hit.w, lu / 2, lv / 2);
            if (turnsHard && atEnd && d > 1e-3) soft.push({ x: c.x - (u.x / lu) * d, y: c.y - (u.y / lu) * d }, { x: c.x + (v.x / lv) * d, y: c.y + (v.y / lv) * d });
            else soft.push(c);
          }
          soft.push(P[P.length - 1]!);
          return simplify(soft);
        };
        const touches = (w: Vec2[]) => higher.filter((o) => !obst.includes(o) && w.some((q, k) => k > 0 && segSegDist(w[k - 1]!, q, o.a, o.b) - o.half - hit.w / 2 < env.clearance(hit.net, o.net) - 1e-6));
        const ways = [walk(1), walk(-1)].sort((x, y) => plen(x) - plen(y));
        const clean = ways.find((w) => !touches(w).length);
        if (clean) {
          way = clean;
          break;
        }
        const more = touches(ways[0]!);
        obst.push(...more);
      }
      if (!way) return fail2(`no way round for ${hit.net} that keeps clear of the new copper`);
      // Replace the chain by the walk-around.
      for (const s of chain) {
        live = live.filter((x) => x.uid !== s.uid);
        if (s.old) removed.add(s.uid);
      }
      const proto = live0.find((x) => x.uid === hit.uid) ?? hit;
      for (let k = 0; k + 1 < way.length; k++) {
        const s: ShoveSeg = { ...proto, uid: newUid('tr'), a: way[k]!, b: way[k + 1]!, old: false, node: proto.node };
        live.push(s);
        queue.push({ net: s.net, layers: [s.layer], a: s.a, b: s.b, half: s.w / 2 });
      }
      movedNets.add(hit.net);
    }
  }
  return { live, removed, nets: movedNets };
}
