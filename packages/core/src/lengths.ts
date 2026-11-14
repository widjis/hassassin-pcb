/**
 * Routed length per net, differential pairs (by name), length-match groups, and a simple
 * serpentine (meander) generator for length tuning.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { arcPoints } from './geom.ts';
import { lineGeometry, propagationDelay, type Stackup } from './stackup.ts';

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export interface NetLength {
  net: string;
  length: number;
  segments: number;
  vias: number;
  /** Length-match group (net property `lengthGroup`). */
  group?: string;
  /** Partner of a differential pair set by hand (net property `pairWith`, P16). */
  pairWith?: string;
  /** Delay of the routed copper (ps), each trace with its own layer's propagation delay (P10; needs the stackup). */
  delay?: number;
}

export function traceLength(engine: StyleEngine, t: DocNode): number {
  const a = vec(engine.get(t.uid, 'start')?.value);
  const b = vec(engine.get(t.uid, 'end')?.value);
  if (!a || !b) return 0;
  const m = vec(engine.get(t.uid, 'mid')?.value);
  if (!m) return Math.hypot(b.x - a.x, b.y - a.y);
  const pts = arcPoints(a, m, b);
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return s;
}

/**
 * Routed length per net. With the stackup, also the delay: outer layers are faster than inner ones, so
 * nets that change layer are compared in time as well (P10).
 */
export function netLengths(doc: Doc, engine: StyleEngine, stackup?: Stackup): NetLength[] {
  const out: NetLength[] = [];
  const perMm = new Map<string, number>();
  const delayOf = (layer: string, w: number) => {
    const k = `${layer}|${w}`;
    let d = perMm.get(k);
    if (d === undefined) {
      const g = stackup ? lineGeometry(stackup, layer) : null;
      d = g ? propagationDelay(g, w) : NaN;
      perMm.set(k, d);
    }
    return d;
  };
  for (const n of doc.nodes.values()) {
    if (n.type !== 'net' || n.name === '(no net)') continue;
    let length = 0;
    let delay = 0;
    let segments = 0;
    let vias = 0;
    for (const c of n.children) {
      const k = doc.nodes.get(c);
      if (k?.type === 'trace') {
        const l = traceLength(engine, k);
        length += l;
        segments++;
        if (stackup) delay += l * delayOf(String(engine.get(k.uid, 'layer')?.value ?? ''), Number(engine.get(k.uid, 'traceWidth')?.value ?? 0.25));
      } else if (k?.type === 'via') vias++;
    }
    out.push({
      net: n.name,
      length: Math.round(length * 1000) / 1000,
      segments,
      vias,
      ...(n.props.lengthGroup ? { group: String(n.props.lengthGroup) } : {}),
      ...(typeof n.props.pairWith === 'string' && n.props.pairWith ? { pairWith: n.props.pairWith } : {}),
      ...(stackup && Number.isFinite(delay) ? { delay: Math.round(delay * 10) / 10 } : {}),
    });
  }
  return out.sort((a, b) => a.net.localeCompare(b.net));
}

export interface DiffPair {
  name: string;
  p: string;
  n: string;
  lengthP: number;
  lengthN: number;
  skew: number;
  /** Skew in time (ps), when the lengths carry delays. */
  skewPs?: number;
  /** Length over which the halves run side by side at the pair gap (P10; with `pairCoupling`). */
  coupled?: number;
  /** Longer of the two halves' lengths that do not run beside the partner at the gap. */
  uncoupled?: number;
  /** The pair's `diffUncoupledMax` rule, when set. */
  uncoupledMax?: number;
}

/** Pairs found by name: X_P/X_N, X+/X-, XP/XN (case-insensitive, also DP/DM). */
export function diffPairs(lengths: NetLength[]): DiffPair[] {
  const by = new Map(lengths.map((l) => [l.net, l]));
  const out: DiffPair[] = [];
  const pats: [RegExp, (base: string, upper: boolean) => string][] = [
    [/^(.*?)(_?)P$/i, (b) => b],
    [/^(.*)\+$/, (b) => b],
    [/^(.*?)DP$/i, (b) => b],
  ];
  const seen = new Set<string>();
  const pair = (p: NetLength, n: NetLength, name: string): DiffPair => ({
    name,
    p: p.net,
    n: n.net,
    lengthP: p.length,
    lengthN: n.length,
    skew: Math.round(Math.abs(p.length - n.length) * 1000) / 1000,
    ...(p.delay !== undefined && n.delay !== undefined ? { skewPs: Math.round(Math.abs(p.delay - n.delay) * 10) / 10 } : {}),
  });
  // Partners set by hand first.
  for (const l of lengths) {
    const other = l.pairWith ? by.get(l.pairWith) : undefined;
    if (!other || seen.has(l.net) || seen.has(other.net)) continue;
    seen.add(l.net);
    seen.add(other.net);
    const [p, n] = l.net < other.net ? [l, other] : [other, l];
    out.push(pair(p, n, `${p.net}/${n.net}`));
  }
  for (const l of lengths) {
    for (const [re] of pats) {
      const m = re.exec(l.net);
      if (!m) continue;
      const base = m[1]!;
      const cands = l.net.endsWith('+') ? [`${base}-`] : /DP$/i.test(l.net) ? [`${base}DM`, `${base}dm`, `${base}DN`] : [`${base}${m[2] ?? ''}N`, `${base}${m[2] ?? ''}n`];
      const other = cands.map((c) => by.get(c)).find(Boolean);
      if (!other || seen.has(l.net) || seen.has(other.net)) continue;
      seen.add(l.net);
      seen.add(other.net);
      out.push(pair(l, other, (base || l.net).replace(/[_/]+$/, '') || l.net));
      break;
    }
  }
  return out;
}

export interface LengthGroup {
  group: string;
  nets: { net: string; length: number; delay?: number }[];
  longest: number;
  shortest: number;
  spread: number;
  /** Spread in time (ps), when the lengths carry delays. */
  spreadPs?: number;
}

export function lengthGroups(lengths: NetLength[]): LengthGroup[] {
  const groups = new Map<string, NetLength[]>();
  for (const l of lengths) if (l.group) (groups.get(l.group) ?? groups.set(l.group, []).get(l.group)!).push(l);
  return [...groups].map(([group, ls]) => {
    const longest = Math.max(...ls.map((x) => x.length));
    const shortest = Math.min(...ls.map((x) => x.length));
    const ds = ls.map((x) => x.delay).filter((d): d is number => d !== undefined);
    return {
      group,
      nets: ls.map((x) => ({ net: x.net, length: x.length, ...(x.delay !== undefined ? { delay: x.delay } : {}) })),
      longest,
      shortest,
      spread: Math.round((longest - shortest) * 1000) / 1000,
      ...(ds.length === ls.length && ds.length ? { spreadPs: Math.round((Math.max(...ds) - Math.min(...ds)) * 10) / 10 } : {}),
    };
  });
}

export interface TuneCandidate {
  ops: Op[];
  /** Length added (mm). */
  added: number;
  /** The trace turned into the serpentine, and the side its bumps go to (1 = left of start → end). */
  trace: string;
  side: 1 | -1;
}

const SQ2 = Math.SQRT2;
/** Length a bump of height A with 45° chamfers c adds over its base: 2A − (8 − 4√2)·c. */
const bumpGain = (A: number, c: number) => 2 * A - (8 - 4 * SQ2) * c;

/**
 * Ways to add `extra` mm to a net with a serpentine, best first (P10): every straight trace long enough
 * (longest first), on either side, or on the side away from the partner where the trace runs beside it
 * (a differential pair's half, `partner`). Each bump is a rectangle with 45° chamfered corners, so the
 * trace never turns more than 45° at once; its height is at most the rule `tuneAmplitude` (default 1.5
 * mm), and its legs are at least `tuneSpacing` apart edge to edge (default 3 × the width), so the meander
 * does not couple to itself. The bumps sit at the end of the trace that joins another trace of the net
 * (the bend that usually caused the mismatch), else in the middle. The caller checks clearance (DRC) and
 * takes the first candidate that keeps it.
 */
export function planTune(doc: Doc, engine: StyleEngine, net: string, extra: number, opts: { amplitude?: number; spacing?: number; side?: 1 | -1; partner?: string; max?: number } = {}): { candidates: TuneCandidate[]; error?: string } {
  const node = [...doc.nodes.values()].find((n) => n.type === 'net' && n.name === net);
  if (!node) return { candidates: [], error: `No net ${net}` };
  if (extra <= 0.01) return { candidates: [], error: 'Nothing to add' };
  const num = (name: string) => {
    const v = engine.get(node.uid, name)?.value;
    return typeof v === 'number' && v > 0 ? v : undefined;
  };
  const traces: { t: DocNode; a: Vec2; b: Vec2; len: number; w: number; layer: string }[] = [];
  const ends: Vec2[] = [];
  for (const c of node.children) {
    const t = doc.nodes.get(c);
    if (t?.type !== 'trace') continue;
    const a = vec(engine.get(t.uid, 'start')?.value);
    const b = vec(engine.get(t.uid, 'end')?.value);
    if (!a || !b) continue;
    ends.push(a, b);
    if (engine.get(t.uid, 'mid')?.value || engine.get(t.uid, 'locked')?.value === true || t.props.locked) continue;
    traces.push({ t, a, b, len: Math.hypot(b.x - a.x, b.y - a.y), w: Number(engine.get(t.uid, 'traceWidth')?.value ?? 0.25) || 0.25, layer: String(engine.get(t.uid, 'layer')?.value ?? '') });
  }
  if (!traces.length) return { candidates: [], error: 'The net has no straight trace to tune' };
  const partner = opts.partner ? piecesOf(doc, engine, opts.partner) : [];
  const gap = num('diffGap') ?? 0;
  const ampMax = opts.amplitude ?? num('tuneAmplitude') ?? 1.5;
  traces.sort((x, y) => y.len - x.len);
  const out: TuneCandidate[] = [];
  let why = '';
  for (const tr of traces) {
    const w = tr.w;
    const L = (opts.spacing ?? num('tuneSpacing') ?? 3 * w) + w; // leg centre to leg centre
    const ux = (tr.b.x - tr.a.x) / tr.len, uy = (tr.b.y - tr.a.y) / tr.len;
    // Chamfer and bump height: the fewest bumps that fit under the height limit.
    const solve = (n: number) => {
      const per = extra / n;
      let c = Math.min(w, L / 3);
      let A = (per + (8 - 4 * SQ2) * c) / 2;
      if (A < 3 * c) (c = per / (6 - (8 - 4 * SQ2))) && (A = 3 * c); // small bump: c = A / 3
      return { c, A };
    };
    const margin = (c: number) => Math.max(w, c) + c;
    const span = (n: number, c: number) => n * 2 * L - L + 2 * c; // along the trace, chamfers included
    let n = 1;
    let sol = solve(1);
    while (sol.A > ampMax + 1e-9 && span(n + 1, solve(n + 1).c) + 2 * margin(solve(n + 1).c) <= tr.len) sol = solve(++n);
    if (sol.A > ampMax + 1e-9) {
      why ||= `Needs ${extra.toFixed(2)} mm; the longest straight trace (${tr.len.toFixed(2)} mm) fits ${n} bump(s) of at most ${ampMax} mm`;
      continue;
    }
    if (sol.A < w) {
      why ||= `${extra.toFixed(3)} mm is too little for a bump on a ${w} mm trace`;
      continue;
    }
    const { c, A } = sol;
    if (span(n, c) + 2 * margin(c) > tr.len) {
      why ||= `The longest straight trace (${tr.len.toFixed(2)} mm) is too short to tune`;
      continue;
    }
    // Next to the bend: the end that meets another trace of the net.
    const joins = (q: Vec2) => ends.filter((e) => Math.hypot(e.x - q.x, e.y - q.y) < 1e-3).length > 1;
    const ja = joins(tr.a), jb = joins(tr.b);
    const u0 = ja && !jb ? margin(c) + c : jb && !ja ? tr.len - margin(c) - span(n, c) + c : (tr.len - span(n, c)) / 2 + c;
    // Away from the partner where this trace runs beside it (a pair's half).
    let sides: (1 | -1)[] = opts.side ? [opts.side] : [1, -1];
    for (const pc of partner) {
      if (pc.layer !== tr.layer) continue;
      const ex = pc.b.x - pc.a.x, ey = pc.b.y - pc.a.y, M = Math.hypot(ex, ey);
      if (M < 1e-9 || Math.abs(ux * ey - uy * ex) / M > 0.01) continue;
      const cross = ux * (pc.a.y - tr.a.y) - uy * (pc.a.x - tr.a.x); // > 0: partner on the left
      if (gap && Math.abs(Math.abs(cross) - w / 2 - pc.w / 2 - gap) > Math.max(0.02, gap * 0.1)) continue;
      const t0 = (pc.a.x - tr.a.x) * ux + (pc.a.y - tr.a.y) * uy, t1 = (pc.b.x - tr.a.x) * ux + (pc.b.y - tr.a.y) * uy;
      if (Math.max(t0, t1) < u0 - c || Math.min(t0, t1) > u0 + span(n, c)) continue;
      const away: 1 | -1 = cross > 0 ? -1 : 1;
      sides = opts.side && opts.side !== away ? [] : [away];
      break;
    }
    for (const side of sides) {
      const nx = -uy * side, ny = ux * side;
      const at = (s0: number, h: number): Vec2 => ({ x: +(tr.a.x + ux * s0 + nx * h).toFixed(4), y: +(tr.a.y + uy * s0 + ny * h).toFixed(4) });
      const pts: Vec2[] = [tr.a];
      for (let k = 0; k < n; k++) {
        const u = u0 + k * 2 * L, v = u + L;
        pts.push(at(u - c, 0), at(u, c), at(u, A - c), at(u + c, A), at(v - c, A), at(v, A - c), at(v, c), at(v + c, 0));
      }
      pts.push(tr.b);
      const clean = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1]!.x, q.y - pts[i - 1]!.y) > 1e-6);
      const keep = tr.t.rules.filter((r) => !['start', 'end', 'layer', 'mid'].includes(r.name));
      const ops: Op[] = [{ op: 'remove', uid: tr.t.uid }];
      const index = node.children.indexOf(tr.t.uid);
      for (let i = 0; i + 1 < clean.length; i++)
        ops.push({ op: 'add', parent: node.uid, index: index + i, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: { ...tr.t.props, tuned: true }, rules: [{ name: 'start', value: clean[i]! }, { name: 'end', value: clean[i + 1]! }, { name: 'layer', value: tr.layer }, ...keep], parent: node.uid, children: [] }] } });
      out.push({ ops, added: Math.round(bumpGain(A, c) * n * 1000) / 1000, trace: tr.t.uid, side });
      if (out.length >= (opts.max ?? 12)) return { candidates: out };
    }
  }
  return out.length ? { candidates: out } : { candidates: [], error: why || 'No trace to tune' };
}

/** The first candidate of `planTune` on the given side (kept for callers of the older generator). */
export function planMeander(doc: Doc, engine: StyleEngine, net: string, extra: number, opts: { amplitude?: number; side?: 1 | -1 } = {}): { ops: Op[]; added: number; error?: string } {
  const r = planTune(doc, engine, net, extra, opts);
  const c = r.candidates[0];
  return c ? { ops: c.ops, added: c.added } : { ops: [], added: 0, error: r.error ?? 'No trace to tune' };
}

type Piece = { layer: string; a: Vec2; b: Vec2; w: number };
const piecesOf = (doc: Doc, engine: StyleEngine, net: string): Piece[] => {
  const n = [...doc.nodes.values()].find((x) => x.type === 'net' && x.name === net);
  const out: Piece[] = [];
  for (const c of n?.children ?? []) {
    const k = doc.nodes.get(c);
    if (k?.type !== 'trace') continue;
    const a = vec(engine.get(k.uid, 'start')?.value);
    const b = vec(engine.get(k.uid, 'end')?.value);
    if (!a || !b) continue;
    const layer = String(engine.get(k.uid, 'layer')?.value ?? '');
    const w = Number(engine.get(k.uid, 'traceWidth')?.value ?? 0.25);
    const m = vec(engine.get(k.uid, 'mid')?.value);
    const pts = m ? arcPoints(a, m, b) : [a, b];
    for (let i = 1; i < pts.length; i++) out.push({ layer, a: pts[i - 1]!, b: pts[i]!, w });
  }
  return out;
};

/**
 * How much of a pair runs coupled (P10): per half, the length of its pieces that run parallel to a piece
 * of the partner on the same layer at the pair gap (`diffGap`, edge to edge, within 10 % or 0.02 mm), the
 * overlap of the two measured along the piece. `uncoupled` is the longer remainder of the two halves;
 * mostly the breakouts at the pads. Undefined without a `diffGap` on either net.
 */
export function pairCoupling(doc: Doc, engine: StyleEngine, pNet: string, nNet: string): { coupled: number; uncoupled: number; uncoupledMax?: number } | undefined {
  const nets = [...doc.nodes.values()].filter((x) => x.type === 'net' && (x.name === pNet || x.name === nNet));
  const rule = (name: string) => {
    let v = 0;
    for (const n of nets) {
      const r = engine.get(n.uid, name)?.value;
      if (typeof r === 'number' && r > 0) v = Math.max(v, r);
    }
    return v;
  };
  const gap = rule('diffGap');
  if (!gap) return undefined;
  const P = piecesOf(doc, engine, pNet);
  const N = piecesOf(doc, engine, nNet);
  const tol = Math.max(0.02, gap * 0.1);
  const side = (A: Piece[], B: Piece[]) => {
    let total = 0;
    let coupled = 0;
    for (const x of A) {
      const dx = x.b.x - x.a.x, dy = x.b.y - x.a.y;
      const L = Math.hypot(dx, dy);
      total += L;
      if (L < 1e-9) continue;
      const ux = dx / L, uy = dy / L;
      const spans: [number, number][] = [];
      for (const y of B) {
        if (y.layer !== x.layer) continue;
        const ex = y.b.x - y.a.x, ey = y.b.y - y.a.y;
        const M = Math.hypot(ex, ey);
        if (M < 1e-9 || Math.abs(ux * ey - uy * ex) / M > 0.01) continue;
        // Distance between the two parallel lines, edge to edge.
        const d = Math.abs((y.a.x - x.a.x) * uy - (y.a.y - x.a.y) * ux) - x.w / 2 - y.w / 2;
        if (Math.abs(d - gap) > tol) continue;
        const t0 = (y.a.x - x.a.x) * ux + (y.a.y - x.a.y) * uy;
        const t1 = (y.b.x - x.a.x) * ux + (y.b.y - x.a.y) * uy;
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
        if (hi > lo) spans.push([lo, hi]);
      }
      spans.sort((s, t) => s[0] - t[0]);
      let end = -Infinity;
      for (const [lo, hi] of spans) {
        if (hi <= end) continue;
        coupled += hi - Math.max(lo, end);
        end = hi;
      }
    }
    return { total, coupled };
  };
  const sp = side(P, N);
  const sn = side(N, P);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const max = rule('diffUncoupledMax');
  return { coupled: r3(Math.min(sp.coupled, sn.coupled)), uncoupled: r3(Math.max(sp.total - sp.coupled, sn.total - sn.coupled)), ...(max ? { uncoupledMax: max } : {}) };
}

/** The pairs with their coupled and uncoupled lengths (`pairCoupling`) where the nets have a pair gap. */
export function withCoupling(doc: Doc, engine: StyleEngine, pairs: DiffPair[]): DiffPair[] {
  return pairs.map((d) => ({ ...d, ...(pairCoupling(doc, engine, d.p, d.n) ?? {}) }));
}
