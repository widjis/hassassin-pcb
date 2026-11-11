/**
 * Annotation (S6): renumber part references per prefix, ordered by sheet and then by position
 * (top to bottom, then left to right). Units of one part keep sharing their reference, and the
 * board components are renamed with their symbols so Update PCB keeps matching them (it then
 * renames the nets, and routed copper follows).
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { allSheets, sheetOf } from './schematic.ts';

export interface AnnotateOptions {
  /** Only parts on this sheet (uid); default: the whole design. */
  sheet?: string;
  /** 'keep': only parts without a number or with a duplicate one get a new number; 'reset': renumber all in scope. */
  mode?: 'keep' | 'reset';
  /** Include power symbols / flags (#PWR, #FLG). Default true. */
  power?: boolean;
}

export interface AnnotateResult {
  ops: Op[];
  /** Old reference → new reference, only the ones that change. */
  renames: [string, string][];
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** "R12" → ["R", 12]; "R?" or "R" → ["R", null]. */
function split(ref: string): [string, number | null] | null {
  const m = /^(#?[A-Za-z_]+)(\d+|\?)?$/.exec(ref);
  if (!m) return null;
  return [m[1]!, m[2] && m[2] !== '?' ? Number(m[2]) : null];
}

export function annotateOps(doc: Doc, engine: StyleEngine, opts: AnnotateOptions = {}): AnnotateResult {
  const mode = opts.mode ?? 'keep';
  const sheetOrder = new Map(allSheets(doc).map((s, i) => [s.uid, i]));
  // Parts: units grouped by their current reference.
  const parts = new Map<string, { units: DocNode[]; sheet: number; at: Vec2; inScope: boolean }>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol') continue;
    if (n.props.power && opts.power === false) continue;
    const ref = String(n.props.ref ?? n.name);
    const sh = sheetOf(doc, n);
    const at = vec(engine.get(n.uid, 'position')?.value) ?? { x: 0, y: 0 };
    const order = sh ? (sheetOrder.get(sh.uid) ?? 0) : 0;
    const inScope = !opts.sheet || sh?.uid === opts.sheet;
    // An unnumbered reference ("R?") is a separate part per symbol. Two symbols with the same
    // reference and the same unit are two parts sharing a reference by mistake (a duplicate).
    let keyRef = split(ref)?.[1] === null ? `${ref}\u0000${n.uid}` : ref;
    const unit = Number(n.props.unit ?? 1);
    for (let k = 1; parts.get(keyRef)?.units.some((u) => Number(u.props.unit ?? 1) === unit); k++) keyRef = `${ref}\u0001${k}`;
    const p = parts.get(keyRef);
    if (!p) parts.set(keyRef, { units: [n], sheet: order, at, inScope });
    else {
      p.units.push(n);
      // A part is placed where its first unit is (in reading order).
      if (order < p.sheet || (order === p.sheet && (at.y < p.at.y - 1e-6 || (Math.abs(at.y - p.at.y) < 1e-6 && at.x < p.at.x)))) (p.sheet = order), (p.at = at);
      p.inScope ||= inScope;
    }
  }
  // Numbers per prefix held by parts outside the scope (or kept in 'keep' mode).
  const taken = new Map<string, Set<number>>();
  const take = (prefix: string, n: number) => (taken.get(prefix) ?? taken.set(prefix, new Set()).get(prefix)!).add(n);
  for (const n of doc.nodes.values()) {
    // Board-only components keep their names: their numbers are taken.
    if (n.type === 'element' && ![...parts.keys()].includes(n.name)) {
      const s = split(n.name);
      if (s?.[1] != null) take(s[0], s[1]);
    }
  }
  const todo: { key: string; ref: string; prefix: string }[] = [];
  const ordered = [...parts.entries()].sort(([, a], [, b]) => a.sheet - b.sheet || a.at.y - b.at.y || a.at.x - b.at.x);
  for (const [key, p] of ordered) {
    const ref = key.split(/[\u0000\u0001]/)[0]!;
    const s = split(ref);
    if (!s) continue; // not a reference we understand: left alone
    const [prefix, num] = s;
    const duplicate = key.includes('\u0001');
    const keep = (!p.inScope || mode === 'keep') && num !== null && !duplicate && !taken.get(prefix)?.has(num);
    if (keep && num !== null) take(prefix, num);
    else todo.push({ key, ref, prefix });
  }
  const renames = new Map<string, string>(); // part key → new ref
  for (const t of todo) {
    const set = taken.get(t.prefix) ?? taken.set(t.prefix, new Set()).get(t.prefix)!;
    let i = 1;
    while (set.has(i)) i++;
    set.add(i);
    renames.set(t.key, `${t.prefix}${i}`);
  }
  const ops: Op[] = [];
  const out: [string, string][] = [];
  for (const [key, to] of renames) {
    const from = key.split(/[\u0000\u0001]/)[0]!;
    if (from === to) continue;
    out.push([from, to]);
    for (const u of parts.get(key)!.units) {
      ops.push({ op: 'setProp', uid: u.uid, key: 'ref', value: to });
      if (u.name === from && !u.props.power) ops.push({ op: 'setName', uid: u.uid, name: to });
    }
    // The board component follows (only for a real, numbered reference that it can match).
    if (!/[\u0000\u0001]/.test(key)) for (const n of doc.nodes.values()) if (n.type === 'element' && n.name === from) ops.push({ op: 'setName', uid: n.uid, name: to });
  }
  return { ops, renames: out };
}
