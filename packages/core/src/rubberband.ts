/**
 * Rubber-banding (docs/05-pcb-improvements.md, P2): when parts (or vias) move or turn, the traces that end
 * on their pads follow. A trace with both ends on moved copper moves with it unchanged; a trace with one
 * end on moved copper keeps its other end and is laid again as a 45° path to the new end (or, while a drag
 * is in progress, simply stretched, and made 45° when the drag ends).
 *
 * Planned once from the board before the move (`rubberbandPlan`), then applied for any transform
 * (`rubberbandOps`), always from the original geometry, so a drag can apply it at every step.
 */
import type { Op } from './commands.ts';
import { collectCopper, inArea } from './copper.ts';
import { place, route45, unplace } from './geom.ts';
import { newUid, type Doc, type RuleDecl, type Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

interface Item {
  uid: string;
  parent: string;
  layer: string;
  start: Vec2;
  end: Vec2;
  mid?: Vec2;
  /** Which ends sit on moved copper. */
  a: boolean;
  b: boolean;
  width?: RuleDecl;
}

export interface RubberbandPlan {
  items: Item[];
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/**
 * The traces that follow when the parts / vias `moved` move. Traces in `skip` (moved themselves, e.g. part
 * of the selection) are left out.
 */
export function rubberbandPlan(doc: Doc, engine: StyleEngine, copper: string[], moved: Iterable<string>, skip: Set<string> = new Set()): RubberbandPlan {
  const set = new Set(moved);
  const anchors = collectCopper(doc, engine, copper).filter((s) => {
    if (s.kind === 'via') return set.has(s.uid);
    if (s.kind !== 'pad') return false;
    const el = doc.nodes.get(s.uid)?.parent;
    return !!el && set.has(el);
  });
  const on = (p: Vec2, layer: string) =>
    anchors.some((s) => (s.kind === 'via' ? Math.hypot(p.x - s.probe.x, p.y - s.probe.y) <= (s.edges[0]?.[2] ?? 0) + 1e-6 : s.layer === layer && !!s.areas[0] && inArea(p, s.areas[0])));
  const items: Item[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' || skip.has(n.uid) || !n.parent || n.props.locked) continue;
    const start = vec(engine.get(n.uid, 'start')?.value);
    const end = vec(engine.get(n.uid, 'end')?.value);
    const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
    if (!start || !end) continue;
    const a = on(start, layer);
    const b = on(end, layer);
    if (!a && !b) continue;
    const mid = vec(engine.get(n.uid, 'mid')?.value);
    const width = n.rules.find((r) => r.name === 'traceWidth');
    items.push({ uid: n.uid, parent: n.parent, layer, start, end, ...(mid ? { mid } : {}), a, b, ...(width ? { width } : {}) });
  }
  return { items };
}

const r4 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/**
 * Operations that make the planned traces follow the transform `f` (old board point → new). With `fix45`
 * a trace with one end moved is laid again as 45° pieces from its fixed end; without, it is stretched.
 */
export function rubberbandOps(plan: RubberbandPlan, f: (p: Vec2) => Vec2, opts: { fix45?: boolean; doc?: Doc } = {}): Op[] {
  const ops: Op[] = [];
  const set = (uid: string, name: string, value: Vec2 | null) => ops.push({ op: 'setRule', uid, name, decl: value ? { name, value } : null });
  const added = new Map<string, number>();
  for (const it of plan.items) {
    if (it.a && it.b) {
      // Both ends on moved copper: the trace moves with it.
      set(it.uid, 'start', r4(f(it.start)));
      set(it.uid, 'end', r4(f(it.end)));
      if (it.mid) set(it.uid, 'mid', r4(f(it.mid)));
      continue;
    }
    const fixed = it.a ? it.end : it.start;
    const moved = r4(f(it.a ? it.start : it.end));
    if (it.mid) set(it.uid, 'mid', null);
    if (!opts.fix45) {
      set(it.uid, it.a ? 'start' : 'end', moved);
      continue;
    }
    // 45° from the fixed end: the posture whose first piece keeps closest to the old direction.
    const old = it.a ? it.start : it.end;
    const dir = { x: old.x - fixed.x, y: old.y - fixed.y };
    const L = Math.hypot(dir.x, dir.y) || 1;
    let best: Vec2[] = [fixed, moved];
    let score = -Infinity;
    for (const d of [true, false]) {
      const p = route45(fixed, moved, d);
      const q = p[1]!;
      const l = Math.hypot(q.x - fixed.x, q.y - fixed.y) || 1;
      const s = ((q.x - fixed.x) * dir.x + (q.y - fixed.y) * dir.y) / (l * L);
      if (s > score) (score = s), (best = p);
    }
    const pts = best.map(r4).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1]!.x, p.y - a[i - 1]!.y) > 1e-6);
    if (pts.length < 2) continue;
    // The trace keeps its orientation (start → end): from the fixed end when that is its end, reversed.
    const seq = it.a ? pts.slice().reverse() : pts;
    set(it.uid, 'start', seq[0]!);
    set(it.uid, 'end', seq[1]!);
    for (let i = 1; i + 1 < seq.length; i++) {
      const parent = opts.doc?.nodes.get(it.parent);
      const index = (added.get(it.parent) ?? parent?.children.length ?? 0);
      added.set(it.parent, index + 1);
      ops.push({ op: 'add', parent: it.parent, index, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: seq[i]! }, { name: 'end', value: seq[i + 1]! }, { name: 'layer', value: it.layer }, ...(it.width ? [it.width] : [])], parent: it.parent, children: [] }] } });
    }
  }
  return ops;
}

/** The transform of a part moved from (p0, r0) to (p1, r1): its points keep their place on the part. */
export function partTransform(p0: Vec2, r0: number, p1: Vec2, r1: number): (p: Vec2) => Vec2 {
  return (p) => place(unplace(p, p0, r0), p1, r1);
}

/** Turning about `c` by `deg` (counter-clockwise, as the `rotation` rule). */
export function rotationAbout(c: Vec2, deg: number): (p: Vec2) => Vec2 {
  return (p) => place({ x: p.x - c.x, y: p.y - c.y }, c, deg);
}
