/**
 * Unrouting (taking routed copper off the board), after EAGLE's RIPUP (all signals, named signals, all but
 * named signals `RIPUP ! …`, a clicked segment) and KiCad's "Unroute Selected" (the tracks attached to the
 * selected footprints). Traces and vias only; pours stay (they are refilled). Locked copper stays.
 */
import type { Op } from './commands.ts';
import { collectCopper, inArea, type CopperShape } from './copper.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export type UnrouteScope =
  /** These traces and vias; parts among them stand for the copper attached to their pads. */
  | { kind: 'items'; uids: string[] }
  /** Every trace and via of these nets. */
  | { kind: 'nets'; nets: string[] }
  /** Traces and vias touching the rectangle. */
  | { kind: 'area'; rect: { minX: number; minY: number; maxX: number; maxY: number } }
  /** Everything, but the nets in `except`, and (with `keepPoured`) the nets that have a pour. */
  | { kind: 'all'; except?: string[]; keepPoured?: boolean };

export interface UnrouteResult {
  ops: Op[];
  traces: number;
  vias: number;
  nets: string[];
  /** Locked traces and vias left in place. */
  locked: number;
}

/** Whether segment a–b touches the rectangle (an end inside, or crossing it: Liang–Barsky clipping). */
function segmentHitsRect(a: Vec2, b: Vec2, r: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  const inside = (p: Vec2) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
  if (inside(a) || inside(b)) return true;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.minX], [dx, r.maxX - a.x], [-dy, a.y - r.minY], [dy, r.maxY - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const netOf = (doc: Doc, n: DocNode) => {
  const p = n.parent ? doc.nodes.get(n.parent) : undefined;
  return p?.type === 'net' ? p.name : '';
};

/**
 * The traces and vias attached to the pads of the given parts: followed from each pad along its net's copper
 * (trace ends that meet, vias), stopping at the pads of other parts, as KiCad's "Unroute Selected".
 */
export function copperAttachedToParts(doc: Doc, engine: StyleEngine, copper: string[], parts: string[]): Set<string> {
  const partSet = new Set(parts);
  const shapes = collectCopper(doc, engine, copper);
  const pads = shapes.filter((s) => s.kind === 'pad');
  const own = pads.filter((s) => partSet.has(doc.nodes.get(s.uid)?.parent ?? ''));
  const others = pads.filter((s) => !partSet.has(doc.nodes.get(s.uid)?.parent ?? ''));
  const onPad = (list: CopperShape[], p: Vec2, layer: string) => list.some((s) => s.layer === layer && !!s.areas[0] && inArea(p, s.areas[0]));
  const items = [...doc.nodes.values()].filter((n) => n.type === 'trace' || n.type === 'via');
  const ends = (n: DocNode): { p: Vec2; layer: string | null; r: number }[] => {
    if (n.type === 'via') {
      const c = vec(engine.get(n.uid, 'position')?.value);
      return c ? [{ p: c, layer: null, r: Number(engine.get(n.uid, 'viaDiameter')?.value ?? 0.6) / 2 }] : [];
    }
    const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
    return [vec(engine.get(n.uid, 'start')?.value), vec(engine.get(n.uid, 'end')?.value)].filter((x): x is Vec2 => !!x).map((p) => ({ p, layer, r: 0 }));
  };
  const out = new Set<string>();
  // Seeds: traces with an end on one of the parts' pads.
  const queue: DocNode[] = [];
  for (const n of items) if (n.type === 'trace' && ends(n).some((e) => onPad(own, e.p, e.layer!))) (out.add(n.uid), queue.push(n));
  while (queue.length) {
    const cur = queue.pop()!;
    const net = netOf(doc, cur);
    for (const e of ends(cur)) {
      // Do not go on past another part's pad.
      if (e.layer && onPad(others, e.p, e.layer)) continue;
      for (const n of items) {
        if (out.has(n.uid) || netOf(doc, n) !== net) continue;
        const touch = ends(n).some((f) => {
          const r = Math.max(e.r, f.r) + 1e-6;
          if (e.layer && f.layer && e.layer !== f.layer) return false;
          return Math.hypot(e.p.x - f.p.x, e.p.y - f.p.y) <= r;
        });
        if (touch) (out.add(n.uid), queue.push(n));
      }
    }
  }
  return out;
}

export function unrouteOps(doc: Doc, engine: StyleEngine, copper: string[], scope: UnrouteScope): UnrouteResult {
  const pick = new Set<string>();
  const all = [...doc.nodes.values()].filter((n) => (n.type === 'trace' || n.type === 'via') && doc.nodes.get(n.parent ?? '')?.type === 'net');
  if (scope.kind === 'items') {
    const parts = scope.uids.filter((u) => doc.nodes.get(u)?.type === 'element');
    for (const u of scope.uids) {
      const n = doc.nodes.get(u);
      if (n && (n.type === 'trace' || n.type === 'via')) pick.add(u);
    }
    for (const u of copperAttachedToParts(doc, engine, copper, parts)) pick.add(u);
  } else if (scope.kind === 'nets') {
    const nets = new Set(scope.nets);
    for (const n of all) if (nets.has(netOf(doc, n))) pick.add(n.uid);
  } else if (scope.kind === 'area') {
    const r = scope.rect;
    for (const n of all) {
      if (n.type === 'via') {
        const c = vec(engine.get(n.uid, 'position')?.value);
        if (c && c.x >= r.minX && c.x <= r.maxX && c.y >= r.minY && c.y <= r.maxY) pick.add(n.uid);
      } else {
        const a = vec(engine.get(n.uid, 'start')?.value);
        const b = vec(engine.get(n.uid, 'end')?.value);
        if (a && b && segmentHitsRect(a, b, r)) pick.add(n.uid);
      }
    }
  } else {
    const except = new Set(scope.except ?? []);
    // Poured nets: those with a pour, or asking for one (`pourLayers`) before it is made.
    if (scope.keepPoured)
      for (const n of doc.nodes.values()) {
        if (n.type === 'fill' && n.parent) except.add(doc.nodes.get(n.parent)?.name ?? '');
        if (n.type === 'net') {
          const c = engine.get(n.uid, 'pourLayers');
          if (c && c.source.kind !== 'default' && Array.isArray(c.value) && c.value.length) except.add(n.name);
        }
      }
    for (const n of all) if (!except.has(netOf(doc, n))) pick.add(n.uid);
  }
  const ops: Op[] = [];
  let traces = 0;
  let vias = 0;
  let locked = 0;
  const nets = new Set<string>();
  for (const u of pick) {
    const n = doc.nodes.get(u)!;
    const net = doc.nodes.get(n.parent ?? '');
    if (n.props.locked || net?.props.locked) {
      locked++;
      continue;
    }
    ops.push({ op: 'remove', uid: u });
    if (n.type === 'via') vias++;
    else traces++;
    nets.add(netOf(doc, n));
  }
  return { ops, traces, vias, nets: [...nets].sort(), locked };
}
