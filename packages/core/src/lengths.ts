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

/**
 * Ops that add `extra` mm to a net by turning its longest straight trace into a
 * serpentine. Amplitude and pitch are kept modest; the caller checks DRC afterwards.
 */
export function planMeander(doc: Doc, engine: StyleEngine, net: string, extra: number, opts: { amplitude?: number; side?: 1 | -1 } = {}): { ops: Op[]; added: number; error?: string } {
  const node = [...doc.nodes.values()].find((n) => n.type === 'net' && n.name === net);
  if (!node) return { ops: [], added: 0, error: `No net ${net}` };
  if (extra <= 0.01) return { ops: [], added: 0, error: 'Nothing to add' };
  const width = Number(engine.get(node.uid, 'traceWidth')?.value ?? 0.25) || 0.25;
  let best: { t: DocNode; a: Vec2; b: Vec2; len: number } | null = null;
  for (const c of node.children) {
    const t = doc.nodes.get(c);
    if (t?.type !== 'trace' || engine.get(t.uid, 'mid')?.value) continue;
    const a = vec(engine.get(t.uid, 'start')?.value);
    const b = vec(engine.get(t.uid, 'end')?.value);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!best || len > best.len) best = { t, a, b, len };
  }
  if (!best) return { ops: [], added: 0, error: 'The net has no straight trace to tune' };
  const pitch = Math.max(4 * width, 0.8); // one bump consumes this much of the segment
  const margin = pitch;
  const room = best.len - 2 * margin;
  const maxBumps = Math.floor(room / pitch);
  if (maxBumps < 1) return { ops: [], added: 0, error: `The longest straight trace (${best.len.toFixed(2)} mm) is too short to tune` };
  const maxAmp = opts.amplitude ?? 1.5;
  let bumps = Math.min(maxBumps, Math.ceil(extra / (2 * maxAmp)));
  let amp = extra / (2 * bumps);
  if (amp > maxAmp) return { ops: [], added: 0, error: `Needs ${extra.toFixed(2)} mm but this segment can add at most ${(2 * maxAmp * maxBumps).toFixed(2)} mm` };
  if (amp < width * 1.5) (bumps = Math.max(1, Math.floor(extra / (3 * width)))), (amp = extra / (2 * bumps));
  const ux = (best.b.x - best.a.x) / best.len;
  const uy = (best.b.y - best.a.y) / best.len;
  const side = opts.side ?? 1;
  const nx = -uy * side;
  const ny = ux * side;
  const at = (s: number, h: number): Vec2 => ({ x: +(best!.a.x + ux * s + nx * h).toFixed(4), y: +(best!.a.y + uy * s + ny * h).toFixed(4) });
  const start = (best.len - bumps * pitch) / 2;
  const pts: Vec2[] = [best.a, at(start, 0)];
  for (let k = 0; k < bumps; k++) {
    const s0 = start + k * pitch;
    pts.push(at(s0 + pitch / 4, 0), at(s0 + pitch / 4, amp), at(s0 + (3 * pitch) / 4, amp), at(s0 + (3 * pitch) / 4, 0));
  }
  pts.push(at(start + bumps * pitch, 0), best.b);
  const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) > 1e-6);
  const layer = engine.get(best.t.uid, 'layer')?.value as string;
  const keep = best.t.rules.filter((r) => !['start', 'end', 'layer'].includes(r.name));
  const ops: Op[] = [{ op: 'remove', uid: best.t.uid }];
  const index = node.children.indexOf(best.t.uid);
  for (let i = 0; i + 1 < clean.length; i++) {
    ops.push({ op: 'add', parent: node.uid, index: index + i, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: { tuned: true }, rules: [{ name: 'start', value: clean[i]! }, { name: 'end', value: clean[i + 1]! }, { name: 'layer', value: layer }, ...keep], parent: node.uid, children: [] }] } });
  }
  return { ops, added: Math.round(2 * amp * bumps * 1000) / 1000 };
}
