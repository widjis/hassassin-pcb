/**
 * Symbol editor (S16): build a part's symbol from a pin table.
 *
 * A pin table is a list of rows (number, name, type, side, unit). It can be pasted as text, for
 * example copied from a datasheet (tab, comma, semicolon or wide-space separated, with or without
 * a header line). Sides and order come from the table, or from a layout rule:
 *   - auto: supplies on top, grounds at the bottom, inputs left, outputs right, the rest split
 *     between left and right in table order;
 *   - package: first half down the left side, second half up the right side (as on a DIP/SOIC);
 *   - table: the side column (rows without one fall back to auto).
 * Units: a unit column (A, B, 1, 2, "power"), and / or `powerUnit` to move every power pin into a
 * unit of its own (like the power unit of an op-amp).
 *
 * The body is a rectangle sized to the pin names, every pin 2.54 mm apart and on the 2.54 mm grid,
 * so wires to it run straight. The table and options are kept in the part (`editor`) for editing.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode } from './model.ts';
import type { StyleEngine } from './style.ts';
import type { PartDef, PartUnit } from './parts.ts';
import { unitPinNodes } from './parts.ts';
import type { PinSpec, SymGraphicSpec } from './symbolGen.ts';
import { pinGridOrigin, schematicGrid, symbolFrame } from './schematic.ts';
import { unitLetter } from './multiUnit.ts';

export const PIN_TYPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect', 'unspecified', 'free'] as const;
export type PinType = (typeof PIN_TYPES)[number];
export const PIN_SIDES = ['left', 'right', 'top', 'bottom'] as const;
export type PinSide = (typeof PIN_SIDES)[number];
export type PinLayout = 'auto' | 'package' | 'table';
export type PinOrder = 'table' | 'number' | 'name';

export interface PinRow {
  number: string;
  name: string;
  type: PinType;
  /** Empty: decided by the layout rule. */
  side?: PinSide;
  /** 1, 2 …; empty: unit 1 (or the power unit with `powerUnit`). */
  unit?: number;
  hidden?: boolean;
  /** Signal class for the layout (P16); empty: guessed from names. */
  signal?: string;
}

export interface SymbolOptions {
  layout?: PinLayout;
  order?: PinOrder;
  /** Put every power pin in a unit of its own (the last unit). */
  powerUnit?: boolean;
}

export interface SymbolEditorData {
  rows: PinRow[];
  options: SymbolOptions;
}

/** Grounds and negative supplies: drawn at the bottom. */
const GROUND = /^(A|D|P|S|C)?GND|^VSS|^0V$|^EP$|^PAD$|^EXP|^V-$|^VEE|^VNEG|^-V/i;
const SUPPLY = /^(A|D|P)?V(CC|DD|IN|BAT|BUS|IO|REF|\+|S\+)|^V\d|^\+\d|^3V3|^5V|^VDD/i;

/** Pin type from a datasheet word (I, O, I/O, P, GND …), or from the pin name when there is none. */
export function pinTypeFrom(word: string, name: string): PinType {
  const w = word.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (w) {
    if ((PIN_TYPES as readonly string[]).includes(w.replace(/ /g, '_'))) return w.replace(/ /g, '_') as PinType;
    if (/^(i\/o|io|bi|bidir|bidirectional|inout|in\/out)$/.test(w)) return 'bidirectional';
    if (/^(i|in|input|di|ai)$/.test(w)) return 'input';
    if (/^(o|out|output|do|ao)$/.test(w)) return 'output';
    if (/^(p|pwr|power|s|supply|power in|g|gnd|ground)$/.test(w)) return 'power_in';
    if (/^(power out|regulator out|po)$/.test(w)) return 'power_out';
    if (/^(od|open drain|oc|open collector)$/.test(w)) return 'open_collector';
    if (/^(nc|n\/c|not connected|dnc)$/.test(w)) return 'no_connect';
    if (/^(a|analog|analogue|passive)$/.test(w)) return 'passive';
    if (/^(z|tri|tristate|tri state|3 state)$/.test(w)) return 'tri_state';
  }
  const n = name.trim();
  if (/^(NC|N\/C|DNC)$/i.test(n)) return 'no_connect';
  if (GROUND.test(n) || SUPPLY.test(n)) return 'power_in';
  return 'passive';
}

const sideFrom = (s: string): PinSide | undefined => {
  const w = s.trim().toLowerCase();
  if (/^(l|left|w|west)$/.test(w)) return 'left';
  if (/^(r|right|e|east)$/.test(w)) return 'right';
  if (/^(t|top|n|north|up)$/.test(w)) return 'top';
  if (/^(b|bottom|s|south|down)$/.test(w)) return 'bottom';
  return undefined;
};

/** "A" → 1, "b" → 2, "3" → 3, "power" / "pwr" → 0 (meaning: the power unit). */
const unitFrom = (s: string): number | undefined => {
  const w = s.trim();
  if (!w) return undefined;
  if (/^(power|pwr|p)$/i.test(w)) return 0;
  if (/^\d+$/.test(w)) return Number(w) || undefined;
  if (/^[A-Za-z]{1,2}$/.test(w)) {
    let n = 0;
    for (const ch of w.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  return undefined;
};

/**
 * Rows from pasted text. Column meaning comes from a header line when there is one (pin / number,
 * name / signal / function, type / direction / I/O, side, unit); otherwise number, name, type,
 * side, unit in that order. Lines that do not start with a pin number are skipped.
 */
export function parsePinTable(text: string): { rows: PinRow[]; skipped: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const split = (l: string): string[] => {
    if (l.includes('\t')) return l.split('\t').map((c) => c.trim());
    if (l.includes(';')) return l.split(';').map((c) => c.trim());
    if (l.includes(',')) return l.split(',').map((c) => c.trim());
    if (l.includes('|')) return l.split('|').map((c) => c.trim()).filter((c, i, a) => c || (i > 0 && i < a.length - 1));
    return l.split(/\s{2,}|\s+(?=\S)/).map((c) => c.trim());
  };
  let cols = { number: 0, name: 1, type: 2, side: 3, unit: 4 } as Record<'number' | 'name' | 'type' | 'side' | 'unit', number>;
  let start = 0;
  const head = split(lines[0] ?? '').map((c) => c.toLowerCase());
  const find = (re: RegExp) => head.findIndex((c) => re.test(c));
  if (head.some((c) => /^(pin|no\.?|#|number|pin ?(no|#|number)|name|signal|function|type|direction|i\/o|dir)$/.test(c))) {
    const number = find(/^(pin ?(no\.?|#|number)?|no\.?|#|number|pad)$/);
    const name = find(/^(name|pin ?name|signal|function|symbol|net)$/);
    cols = {
      number: number >= 0 ? number : 0,
      name: name >= 0 ? name : number === 0 ? 1 : 0,
      type: find(/^(type|pin ?type|direction|dir|i\/o|io|kind)$/),
      side: find(/^(side|position|placement)$/),
      unit: find(/^(unit|gate|part)$/),
    };
    start = 1;
  }
  const rows: PinRow[] = [];
  const skipped: string[] = [];
  for (const l of lines.slice(start)) {
    const c = split(l);
    const number = (c[cols.number] ?? '').replace(/^pin\s*/i, '');
    if (!/^[A-Za-z]{0,2}\d+[A-Za-z]?$|^EP$|^PAD$/i.test(number)) {
      skipped.push(l);
      continue;
    }
    // Without a header, a single word after the number is the name; a known type word may follow.
    const name = (c[cols.name] ?? '').trim() || number;
    const typeWord = cols.type >= 0 ? (c[cols.type] ?? '') : '';
    const row: PinRow = { number, name, type: pinTypeFrom(typeWord, name) };
    const side = cols.side >= 0 ? sideFrom(c[cols.side] ?? '') : undefined;
    if (side) row.side = side;
    const unit = cols.unit >= 0 ? unitFrom(c[cols.unit] ?? '') : undefined;
    if (unit !== undefined) row.unit = unit;
    rows.push(row);
  }
  return { rows, skipped };
}

const isPower = (r: PinRow) => r.type === 'power_in' || r.type === 'power_out';
const numKey = (s: string) => {
  const m = /^([A-Za-z]*)(\d+)/.exec(s);
  return m ? [m[1]!.toUpperCase(), Number(m[2])] as const : [s, 0] as const;
};

/** Which unit each row goes to (1-based), and the number of units. */
function assignUnits(rows: PinRow[], opts: SymbolOptions): { unitOf: number[]; count: number } {
  const explicit = rows.map((r) => r.unit ?? 1).filter((u) => u > 0);
  let count = Math.max(1, ...explicit);
  const powerUnit = opts.powerUnit || rows.some((r) => r.unit === 0);
  const pu = powerUnit ? count + 1 : 0;
  if (powerUnit) count++;
  const unitOf = rows.map((r) => (r.unit === 0 || (opts.powerUnit && isPower(r) && r.unit === undefined) ? pu : Math.max(1, r.unit ?? 1)));
  return { unitOf, count };
}

/** Side of every row of one unit. */
function assignSides(rows: PinRow[], layout: PinLayout): PinSide[] {
  if (layout === 'package') {
    const half = Math.ceil(rows.length / 2);
    return rows.map((_, i) => (i < half ? 'left' : 'right'));
  }
  const sides: (PinSide | undefined)[] = rows.map((r) => (layout === 'table' ? r.side : undefined));
  const free: number[] = [];
  rows.forEach((r, i) => {
    if (sides[i]) return;
    if (r.type === 'power_in' && GROUND.test(r.name)) sides[i] = 'bottom';
    else if (isPower(r)) sides[i] = 'top';
    else if (r.type === 'input') sides[i] = 'left';
    else if (r.type === 'output' || r.type === 'open_collector' || r.type === 'open_emitter' || r.type === 'tri_state') sides[i] = 'right';
    else free.push(i);
  });
  // The rest: balance left and right; the first ones go left, keeping the table order.
  const left = sides.filter((x) => x === 'left').length;
  const right = sides.filter((x) => x === 'right').length;
  const toLeft = Math.max(0, Math.min(free.length, Math.ceil((left + right + free.length) / 2) - left));
  free.forEach((i, k) => (sides[i] = k < toLeft ? 'left' : 'right'));
  return sides.map((s) => s ?? 'left');
}

const P = 2.54;
const NAME_CHAR = 1.05 * 0.6; // pin name text: 1.05 mm, monospaced

/** One unit's body and pins from its rows. */
function buildUnit(rows: PinRow[], sides: PinSide[], order: PinOrder, packageLayout: boolean): PartUnit {
  const bySide: Record<PinSide, PinRow[]> = { left: [], right: [], top: [], bottom: [] };
  rows.forEach((r, i) => bySide[sides[i]!].push(r));
  const sortRows = (list: PinRow[]) => {
    if (order === 'number') list.sort((a, b) => { const x = numKey(a.number); const y = numKey(b.number); return x[0].localeCompare(y[0]) || x[1] - y[1]; });
    else if (order === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  };
  for (const s of PIN_SIDES) sortRows(bySide[s]);
  // On a package layout the right side runs bottom → top, like the pins around the package.
  if (packageLayout) bySide.right.reverse();
  const label = (r: PinRow) => (r.name && r.name !== r.number && r.name !== '~' ? r.name : '');
  const nameW = (list: PinRow[]) => Math.max(0, ...list.map((r) => label(r).length)) * NAME_CHAR;
  const vRows = Math.max(bySide.left.length, bySide.right.length, 1);
  const hCols = Math.max(bySide.top.length, bySide.bottom.length);
  // Top / bottom pins: wide enough apart for their names, which run sideways from the pin.
  const hStep = Math.max(P, Math.ceil((Math.max(nameW(bySide.top), nameW(bySide.bottom)) + 0.8) / P) * P);
  // Half sizes, multiples of 2.54 so every pin lands on the grid.
  const halfW = Math.max(2, Math.ceil((nameW(bySide.left) + nameW(bySide.right) + 2.5) / 2 / P), Math.ceil(((hCols + 1) * hStep) / 2 / P)) * P;
  const halfH = (Math.max(2, Math.ceil(((vRows + 1) * P) / 2 / P)) + (hCols ? 1 : 0)) * P;
  const pins: PinSpec[] = [];
  const column = (n: number, step = P) => Array.from({ length: n }, (_, i) => (i - Math.floor((n - 1) / 2)) * step);
  const pin = (r: PinRow, at: { x: number; y: number }, angle: number): PinSpec => ({ number: r.number, name: r.name || '~', type: r.type, at, angle, length: P, ...(r.hidden ? { hidden: true } : {}), ...(r.signal ? { signal: r.signal } : {}) });
  // Left and right columns start at the same height, so the sides line up from the top.
  const top = -Math.floor((vRows - 1) / 2) * P;
  bySide.left.forEach((r, i) => pins.push(pin(r, { x: -halfW - P, y: top + i * P }, 0)));
  bySide.right.forEach((r, i) => pins.push(pin(r, { x: halfW + P, y: top + i * P }, 180)));
  column(bySide.top.length, hStep).forEach((x, i) => pins.push(pin(bySide.top[i]!, { x, y: -halfH - P }, 270)));
  column(bySide.bottom.length, hStep).forEach((x, i) => pins.push(pin(bySide.bottom[i]!, { x, y: halfH + P }, 90)));
  const graphics: SymGraphicSpec[] = [{ t: 'rect', a: { x: -halfW, y: -halfH }, b: { x: halfW, y: halfH }, fill: true, w: 0.254 }];
  return { graphics, pins };
}

/** Check a pin table: numbers present and unique. Returns problems (empty when fine). */
export function checkPinRows(rows: PinRow[]): string[] {
  const out: string[] = [];
  if (!rows.length) out.push('The pin table is empty');
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.number.trim()) out.push(`A pin without a number (${r.name || 'no name'})`);
    seen.set(r.number, (seen.get(r.number) ?? 0) + 1);
  }
  for (const [n, c] of seen) if (c > 1 && n) out.push(`Pin number ${n} is used ${c} times`);
  return out;
}

/** The units of a symbol built from a pin table. */
export function buildSymbolUnits(rows: PinRow[], opts: SymbolOptions = {}): PartUnit[] {
  const problems = checkPinRows(rows);
  if (problems.length) throw new Error(problems.join('; '));
  const layout = opts.layout ?? 'auto';
  const order = opts.order ?? 'table';
  const { unitOf, count } = assignUnits(rows, opts);
  const units: PartUnit[] = [];
  for (let u = 1; u <= count; u++) {
    const mine = rows.filter((_, i) => unitOf[i] === u);
    if (!mine.length) throw new Error(`Unit ${unitLetter(u)} has no pins; number the units without gaps`);
    // A power unit always uses the automatic sides (supplies top, grounds bottom).
    const allPower = mine.every(isPower);
    units.push(buildUnit(mine, assignSides(mine, allPower ? 'auto' : layout), order, layout === 'package' && !allPower));
  }
  return units;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-+|-+$/g, '') || 'symbol';

/** A part definition from the symbol editor (stored in the project as `part:<id>`). */
export function symbolPart(input: { id?: string; name: string; prefix?: string; value?: string; footprint?: string; description?: string; properties?: Record<string, string>; rows: PinRow[]; options?: SymbolOptions; version?: number }): PartDef {
  const name = input.name.trim();
  if (!name) throw new Error('The symbol needs a name');
  const options = input.options ?? {};
  const units = buildSymbolUnits(input.rows, options);
  const def: PartDef & { editor: SymbolEditorData } = {
    id: input.id ?? `project:${slug(name)}`,
    name,
    prefix: (input.prefix ?? 'U').trim() || 'U',
    value: (input.value ?? name).trim() || name,
    units,
    source: 'project',
    version: input.version ?? 1,
    editor: { rows: input.rows.map((r) => ({ ...r })), options: { ...options } },
    ...(input.footprint?.trim() ? { footprint: input.footprint.trim() } : {}),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.properties && Object.keys(input.properties).length ? { properties: input.properties } : {}),
  };
  return def;
}

/** The pin table of a stored part: its editor data, or rows read back from its pins. */
export function partPinRows(def: PartDef): SymbolEditorData {
  const ed = (def as PartDef & { editor?: SymbolEditorData }).editor;
  if (ed?.rows?.length) return { rows: ed.rows.map((r) => ({ ...r })), options: { ...ed.options } };
  const seen = new Set<string>();
  const rows: PinRow[] = [];
  def.units.forEach((u, i) => {
    for (const p of u.pins) {
      if (seen.has(p.number)) continue; // shared pins are listed once
      seen.add(p.number);
      // Side from the pin direction: angle 0 points right into the body, so the pin is on the left.
      const side: PinSide = p.angle === 0 ? 'left' : p.angle === 180 ? 'right' : p.angle === 270 ? 'top' : 'bottom';
      rows.push({ number: p.number, name: p.name, type: (PIN_TYPES as readonly string[]).includes(p.type) ? (p.type as PinType) : 'unspecified', side, ...(def.units.length > 1 ? { unit: i + 1 } : {}), ...(p.hidden ? { hidden: true } : {}), ...(p.signal ? { signal: p.signal } : {}) });
    }
  });
  return { rows, options: { layout: 'table' } };
}

/**
 * Ops that redraw every placed symbol of a part after its definition changed: body and pins of
 * its unit (pins snapped back to the grid). Wires stay where they are, as in KiCad's "update
 * symbols from library". Symbols whose unit no longer exists are reported, not changed.
 */
export function updatePlacedSymbolsOps(doc: Doc, engine: StyleEngine, def: PartDef): { ops: Op[]; updated: number; orphans: string[] } {
  const ops: Op[] = [];
  const orphans: string[] = [];
  let updated = 0;
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.partId !== def.id) continue;
    const unit = Number(n.props.unit ?? 1) || 1;
    const u = def.units[unit - 1];
    if (!u) {
      orphans.push(`${n.props.ref ?? n.name}${unitLetter(unit)}`);
      continue;
    }
    for (const c of n.children) if (doc.nodes.get(c)?.type === 'pin') ops.push({ op: 'remove', uid: c });
    const pins: DocNode[] = unitPinNodes(u, n.uid);
    pins.forEach((p, i) => ops.push({ op: 'add', parent: n.uid, index: n.children.length + i, tree: { nodes: [p] } }));
    ops.push({ op: 'setData', uid: n.uid, key: 'graphics', value: u.graphics });
    const f = symbolFrame(engine, n.uid);
    const origin = pinGridOrigin(f.origin, u.pins.map((p) => p.at), f.rot, f.mirror, schematicGrid(doc).pin);
    if (Math.abs(origin.x - f.origin.x) > 1e-6 || Math.abs(origin.y - f.origin.y) > 1e-6) ops.push({ op: 'setRule', uid: n.uid, name: 'position', decl: { name: 'position', value: origin } });
    updated++;
  }
  return { ops, updated, orphans };
}
