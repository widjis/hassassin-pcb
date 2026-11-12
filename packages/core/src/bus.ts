/**
 * Buses (S15). A bus is drawn with `bus` segments (rules `start` / `end`) and named by a label on it:
 *   - a vector `DATA[0..7]` has the members DATA0 … DATA7 (a range may run down: `A[3..0]`);
 *   - a group `I2C{SDA SCL}` has I2C.SDA and I2C.SCL; without a prefix (`{SDA SCL}`) just SDA and SCL;
 *     a group may hold vectors (`{D[0..1] CLK}`).
 * Wires reach a bus through `busEntry` nodes (rules `position` on the bus and `size`, the offset to the
 * wire end); a wire belongs to a member through a net label with the member's name, as in KiCad.
 * Members connect across the design where a bus does (a sheet pin, by position in the member list) and
 * by name where the bus has a global label.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { Op } from './commands.ts';
import type { StyleEngine } from './style.ts';
import { distToSegment, dist } from './geom.ts';
import { sheetItems } from './schematic.ts';

const VECTOR = /^(.*?)\[(\d+)\.\.(\d+)\]$/;
const GROUP = /^([^{}]*)\{([^{}]+)\}$/;

/** Members of a bus name, or null when the name is not a bus. */
export function busMembers(name: string): string[] | null {
  const v = VECTOR.exec(name.trim());
  if (v) {
    const a = Number(v[2]);
    const b = Number(v[3]);
    if (Math.abs(a - b) > 1024) return null;
    const out: string[] = [];
    for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(`${v[1]}${i}`);
    return out;
  }
  const g = GROUP.exec(name.trim());
  if (g) {
    const prefix = g[1]!.trim();
    const out: string[] = [];
    for (const item of g[2]!.split(/[\s,]+/).filter(Boolean)) {
      const inner = busMembers(item) ?? [item];
      for (const m of inner) out.push(prefix ? `${prefix}.${m}` : m);
    }
    return out.length ? out : null;
  }
  return null;
}

export const isBusName = (name: string) => busMembers(name) !== null;

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const EPS = 1e-3;

export interface SheetBus {
  /** Uids of the bus segments drawn together. */
  segments: string[];
  /** Bus labels on it (bus names only). */
  labels: DocNode[];
  /** Members, from the first label (global first, then local, then hierarchical). */
  members: string[];
  global: boolean;
}

/** The buses of one sheet: touching segments joined, with the labels that name them. */
export function sheetBuses(doc: Doc, engine: StyleEngine, sheet: DocNode): { buses: SheetBus[]; at: (p: Vec2) => SheetBus | null } {
  const its = sheetItems(doc, sheet);
  const segs = its
    .filter((n) => n.type === 'bus')
    .map((n) => ({ n, a: vec(engine.get(n.uid, 'start')?.value), b: vec(engine.get(n.uid, 'end')?.value) }))
    .filter((s): s is { n: DocNode; a: Vec2; b: Vec2 } => !!s.a && !!s.b);
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const on = (p: Vec2, s: { a: Vec2; b: Vec2 }) => distToSegment(p, s.a, s.b) < EPS;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (on(t.a, s) || on(t.b, s) || on(s.a, t) || on(s.b, t)) parent[find(i)] = find(j);
    }
  const groups = new Map<number, number[]>();
  segs.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const labels = its.filter((n) => n.type === 'label' && isBusName(n.name) && (n.parent ? doc.nodes.get(n.parent)?.type !== 'symbol' : true));
  const rank = (l: DocNode) => (l.props.kind === 'global' ? 0 : (l.props.kind ?? 'local') === 'local' ? 1 : 2);
  const buses: SheetBus[] = [];
  const bySeg = new Map<number, SheetBus>();
  for (const idx of groups.values()) {
    const mine = labels
      .filter((l) => {
        const p = vec(engine.get(l.uid, 'position')?.value);
        return !!p && idx.some((i) => on(p, segs[i]!));
      })
      .sort((a, b) => rank(a) - rank(b));
    const bus: SheetBus = { segments: idx.map((i) => segs[i]!.n.uid), labels: mine, members: mine.length ? busMembers(mine[0]!.name)! : [], global: mine.some((l) => l.props.kind === 'global') };
    buses.push(bus);
    for (const i of idx) bySeg.set(i, bus);
  }
  const at = (p: Vec2): SheetBus | null => {
    for (let i = 0; i < segs.length; i++) if (on(p, segs[i]!) || dist(p, segs[i]!.a) < EPS || dist(p, segs[i]!.b) < EPS) return bySeg.get(i) ?? null;
    return null;
  };
  return { buses, at };
}

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const rp = (p: Vec2) => ({ x: r4(p.x), y: r4(p.y) });

/** Ops that draw a bus through `pts` (one segment per pair of points). */
export function addBusOps(sheet: DocNode, pts: Vec2[]): { ops: Op[]; uids: string[] } {
  const ops: Op[] = [];
  const uids: string[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = rp(pts[i]!);
    const b = rp(pts[i + 1]!);
    if (dist(a, b) < EPS) continue;
    const uid = newUid('bus');
    uids.push(uid);
    ops.push({ op: 'add', parent: sheet.uid, index: sheet.children.length + ops.length, tree: { nodes: [{ uid, type: 'bus', name: '', props: {}, rules: [{ name: 'start', value: a }, { name: 'end', value: b }], parent: sheet.uid, children: [] }] } });
  }
  return { ops, uids };
}

/** Op that adds a bus entry: `at` on the bus, `size` the offset to where a wire joins it. */
export function addBusEntryOp(sheet: DocNode, at: Vec2, size: Vec2): { op: Op; uid: string } {
  const uid = newUid('bent');
  return { uid, op: { op: 'add', parent: sheet.uid, index: sheet.children.length, tree: { nodes: [{ uid, type: 'busEntry', name: '', props: {}, rules: [{ name: 'position', value: rp(at) }, { name: 'size', value: rp(size) }], parent: sheet.uid, children: [] }] } } };
}

/**
 * Where a bus entry clicked at `p` goes: on the nearest bus segment (within 2.54 mm), at the grid point
 * closest to the click, leaning towards the side of the click (2.54 mm each way, as usual).
 */
export function busEntryAt(doc: Doc, engine: StyleEngine, sheet: DocNode, p: Vec2, grid = 1.27): { at: Vec2; size: Vec2 } | null {
  let best: { at: Vec2; d: number; horizontal: boolean } | null = null;
  for (const n of sheetItems(doc, sheet)) {
    if (n.type !== 'bus') continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    if (!a || !b) continue;
    const d = distToSegment(p, a, b);
    if (d > 2.54 || (best && d >= best.d)) continue;
    const horizontal = Math.abs(a.y - b.y) < EPS;
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const along = Math.min(hi, Math.max(lo, Math.round((horizontal ? p.x : p.y) / grid) * grid));
    best = { at: horizontal ? { x: along, y: a.y } : { x: a.x, y: along }, d, horizontal };
  }
  if (!best) return null;
  const s = 2.54;
  const size = best.horizontal ? { x: s, y: p.y >= best.at.y ? s : -s } : { x: p.x >= best.at.x ? s : -s, y: s };
  return { at: best.at, size };
}
