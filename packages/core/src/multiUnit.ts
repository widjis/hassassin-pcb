/**
 * Units of multi-unit parts (S12): an op-amp with A, B and a power unit, a quad gate …
 *
 * Every placed unit is its own `symbol` with the part's reference and `unit` = 1, 2 …; the part
 * definition (all units) is stored in the project (`doc.meta['part:<id>']`, also for multi-unit
 * symbols imported from KiCad), found through the symbol's `partId` (or `unitDef` for imports).
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { unitNodes, unitPinNodes, unitWidth, type PartDef, type PartUnit } from './parts.ts';
import { pinGridOrigin, schematicGrid, sheetOf, symbolFrame } from './schematic.ts';
import { symbolBounds } from './schematicEdit.ts';

/** Letter of a unit as KiCad shows it: 1 → A, 2 → B … 27 → AA. */
export function unitLetter(unit: number): string {
  let n = unit;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || '?';
}

const POWER_TYPES = new Set(['power_in', 'power_out']);

/** True when every visible pin of a unit is a power pin (the "power unit" of an op-amp or a gate). */
export function isPowerUnit(u: PartUnit): boolean {
  const pins = u.pins.filter((p) => !p.hidden);
  return pins.length > 0 && pins.every((p) => POWER_TYPES.has(p.type));
}

/** "A", "B", "C (power)". */
export function unitLabel(def: PartDef, unit: number): string {
  const u = def.units[unit - 1];
  return `${unitLetter(unit)}${u && isPowerUnit(u) && def.units.length > 1 ? ' (power)' : ''}`;
}

/** The part definition of a placed symbol, when the project holds it. */
export function partDefOf(doc: Doc, sym: DocNode): PartDef | null {
  // Library parts carry partId; multi-unit symbols imported from KiCad carry unitDef (kept out of
  // partId so Update PCB does not copy it onto imported components).
  const id = sym.props.partId ?? sym.props.unitDef;
  if (typeof id !== 'string' || !id) return null;
  const def = doc.meta[`part:${id}`] as PartDef | undefined;
  return def && Array.isArray(def.units) ? def : null;
}

const refOf = (n: DocNode) => String(n.props.ref ?? n.name);

/** Placed units of a reference: unit number → symbols (normally one each). */
export function placedUnits(doc: Doc, ref: string): Map<number, DocNode[]> {
  const out = new Map<number, DocNode[]>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power || refOf(n) !== ref) continue;
    const u = Number(n.props.unit ?? 1) || 1;
    (out.get(u) ?? out.set(u, []).get(u)!).push(n);
  }
  return out;
}

export interface UnitStatus {
  unit: number;
  label: string;
  placed: boolean;
  power: boolean;
  pins: string[];
}

/** Every unit of the part behind `sym`, with whether it is placed. Null for single-unit parts. */
export function unitsOf(doc: Doc, sym: DocNode): { ref: string; def: PartDef; units: UnitStatus[] } | null {
  const def = partDefOf(doc, sym);
  if (!def || def.units.length < 2) return null;
  const ref = refOf(sym);
  const placed = placedUnits(doc, ref);
  return {
    ref,
    def,
    units: def.units.map((u, i) => ({ unit: i + 1, label: unitLabel(def, i + 1), placed: placed.has(i + 1), power: isPowerUnit(u), pins: u.pins.filter((p) => !p.hidden).map((p) => p.number) })),
  };
}

/**
 * Ops that turn a placed symbol into another unit of its part: new body and pins, same place,
 * rotation and mirror (pins snapped back to the pin grid). Wires stay where they are, as in KiCad.
 * Refused when that unit is already placed.
 */
export function switchUnitOps(doc: Doc, engine: StyleEngine, symUid: string, unit: number): Op[] {
  const sym = doc.nodes.get(symUid);
  if (!sym || sym.type !== 'symbol') throw new Error('Not a symbol');
  const def = partDefOf(doc, sym);
  if (!def) throw new Error(`${refOf(sym)} has no stored part definition, so its units are unknown`);
  const u = def.units[unit - 1];
  if (!u) throw new Error(`${def.name} has units ${def.units.map((_, i) => unitLetter(i + 1)).join(', ')}; there is no unit ${unit}`);
  const current = Number(sym.props.unit ?? 1) || 1;
  if (current === unit) return [];
  if (placedUnits(doc, refOf(sym)).has(unit)) throw new Error(`Unit ${unitLetter(unit)} of ${refOf(sym)} is already placed; switch or delete that one first`);
  const ops: Op[] = [];
  for (const c of sym.children) {
    const k = doc.nodes.get(c);
    if (k?.type === 'pin') ops.push({ op: 'remove', uid: c });
  }
  const pins = unitPinNodes(u, sym.uid);
  pins.forEach((p, i) => ops.push({ op: 'add', parent: sym.uid, index: sym.children.length + i, tree: { nodes: [p] } }));
  ops.push({ op: 'setData', uid: sym.uid, key: 'graphics', value: u.graphics });
  ops.push({ op: 'setProp', uid: sym.uid, key: 'unit', value: unit });
  const f = symbolFrame(engine, sym.uid);
  const origin = pinGridOrigin(f.origin, u.pins.map((p) => p.at), f.rot, f.mirror, schematicGrid(doc).pin);
  if (Math.abs(origin.x - f.origin.x) > 1e-6 || Math.abs(origin.y - f.origin.y) > 1e-6) ops.push({ op: 'setRule', uid: sym.uid, name: 'position', decl: { name: 'position', value: origin } });
  return ops;
}

/**
 * Ops that place a unit of `ref` that is not placed yet, on `sheetUid` at `at` (default: right of
 * the placed units on that sheet). Properties come from a placed unit, so all units agree.
 */
export function placeUnitOps(doc: Doc, engine: StyleEngine, ref: string, unit: number, sheetUid?: string, at?: Vec2): { ops: Op[]; uid: string } {
  const placed = placedUnits(doc, ref);
  const any = [...placed.values()][0]?.[0];
  if (!any) throw new Error(`No part ${ref}`);
  const def = partDefOf(doc, any);
  if (!def) throw new Error(`${ref} has no stored part definition, so its units are unknown`);
  const u = def.units[unit - 1];
  if (!u) throw new Error(`${def.name} has units ${def.units.map((_, i) => unitLetter(i + 1)).join(', ')}; there is no unit ${unit}`);
  if (placed.has(unit)) throw new Error(`Unit ${unitLetter(unit)} of ${ref} is already placed`);
  const sheet = sheetUid ? doc.nodes.get(sheetUid) : sheetOf(doc, any);
  if (!sheet || sheet.type !== 'sheet') throw new Error('No such sheet');
  let pos = at;
  if (!pos) {
    // Right of the units already on this sheet, at the height of the first one.
    let maxX = -Infinity;
    let y = 0;
    for (const syms of placed.values())
      for (const s of syms) {
        if (sheetOf(doc, s)?.uid !== sheet.uid) continue;
        const b = symbolBounds(doc, engine, s.uid);
        if (b.maxX > maxX) ((maxX = b.maxX), (y = symbolFrame(engine, s.uid).origin.y));
      }
    pos = Number.isFinite(maxX) ? { x: maxX + unitWidth(u) / 2 + 2.54, y } : { x: 0, y: 0 };
  }
  const props: DocNode['props'] = { ...any.props, unit };
  delete props.element;
  const { nodes, uid } = unitNodes(doc, sheet.uid, u, props, pos);
  return { ops: [{ op: 'add', parent: sheet.uid, index: sheet.children.length, tree: { nodes } }], uid };
}

/** References with units that are not placed: [{ ref, missing units, which of them matter }]. */
export function missingUnits(doc: Doc): { ref: string; symbol: DocNode; def: PartDef; missing: { unit: number; label: string; power: boolean }[] }[] {
  const seen = new Set<string>();
  const out: { ref: string; symbol: DocNode; def: PartDef; missing: { unit: number; label: string; power: boolean }[] }[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const ref = refOf(n);
    if (seen.has(ref)) continue;
    seen.add(ref);
    const st = unitsOf(doc, n);
    if (!st) continue;
    // Pins a unit shares with a placed unit (KiCad "common" pins) are already on the sheet.
    const placedPins = new Set(st.units.filter((u) => u.placed).flatMap((u) => u.pins));
    const missing = st.units.filter((u) => !u.placed && u.pins.some((p) => !placedPins.has(p))).map((u) => ({ unit: u.unit, label: u.label, power: u.power }));
    if (missing.length) out.push({ ref, symbol: n, def: st.def, missing });
  }
  return out;
}
