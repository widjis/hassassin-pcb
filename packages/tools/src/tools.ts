/**
 * Tool definitions: one list, used by the CLI, the MCP server and the in-app agent.
 * Every write goes through the project's History (so it is undoable and, when the
 * project is live, shared with collaborators).
 */
import {
  pinPadCheck,
  ercSettings,
  defaultPinLevel,
  setPinLevelOp,
  setErcSeverityOp,
  setErcOptionOp,
  waiveOp,
  unwaiveOp,
  ERC_PIN_TYPES,
  ERC_LABEL,
  type ErcLevel,
  type PinType,
  type ErcSeverityOverride,
  busMembers,
  addBusOps,
  addBusEntryOp,
  busEntryAt,
  kicadNetlist,
  kicadSchematic,
  describePinPad,
  generateFootprint,
  genericFootprint,
  type FootprintParams,
  parsePinTable,
  pinTypeFrom,
  buildSymbolUnits,
  symbolPart,
  updatePlacedSymbolsOps,
  PIN_SIDES,
  type PinRow,
  type PinSide,
  type PinLayout,
  type PinOrder,
  placedUnits,
  unitsOf,
  unitLetter,
  unitLabel,
  switchUnitOps,
  placeUnitOps,
  SHEET_PIN_SHAPES,
  type SheetPinShape,
  addHierLabelOp,
  addSubSheetOps,
  blockOfSheet,
  sheetOfBlock,
  schematicPdf,
  exportSheets,
  schematicSvgs,
  moveSymbolsOps,
  toggleMirror,
  type Mirror,
  boardOutline,
  parsePoints,
  addPowerPortOp,
  isGroundNet,
  symbolFrame,
  symToSheet,
  defaultStackup,
  diffImpedance,
  diffPairs,
  impedance,
  lengthGroups,
  lineGeometry,
  netLengths,
  netSignals,
  isSignalClass,
  SIGNAL_CLASSES,
  planMeander,
  stackupOf,
  widthForImpedance,
  type Stackup,
  planAutoplace,
  planAutoroute,
  addSymbolOp,
  applyOffersOps,
  buildBom,
  fpKey,
  genericPart,
  parseOffersCsv,
  placePartOps,
  setPartPropsOps,
  storePartOps,
  type FootprintSpec,
  type Offer,
  computeRatsnest,
  dist,
  extractNetlist,
  formatRuleValue,
  makeSymbol,
  newUid,
  padGeom,
  PART_KINDS,
  parseRuleValue,
  pinPoint,
  planPours,
  planSync,
  querySelectorAll,
  refillOps,
  route45,
  RULE_DEFS,
  runDrc,
  runErc,
  sheetOf,
  sheetPath,
  type DocNode,
  type Op,
  type PartKind,
  type RuleDecl,
  type Vec2,
  copyItems,
  pasteOps,
  withJunctionsOps,
  renameRefOps,
  annotateOps,
  routeWirePath,
  routeConnection,
  wirePathOps,
  pinGridOrigin,
  symbolPinLocals,
  tidyWiresOps,
  schematicGrid,
  setSchematicGridOp,
  PIN_GRIDS,
  WIRE_GRIDS,
  alignOps,
  placeRelativeOps,
  type AlignMode,
  type Side,
  compactBlocksOps,
  setSheetFrameOps,
  localDate,
  sheetFrame,
  addNoteOp,
  addGroupBoxOp,
  groupBoxAround,
  sheetBlocks,
} from '@hassassin/core';
import { buildFab, fabZip, zip } from '@hassassin/fab';
import { computeGates, SPEC_FIELDS, type Spec } from './gates.ts';
import type { Project } from './project.ts';
import { Library } from './library.ts';
import { parseKicadFootprint, parseKicadSymbolLib } from '@hassassin/kicad-import';

export interface ToolContext {
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void> | void;
  readFile?: (path: string) => Promise<string>;
  /** Extra part/footprint sources (installed KiCad libraries, team library…). */
  library?: Library;
}

const DEFAULT_LIBRARY = new Library();
const libOf = (ctx: ToolContext) => ctx.library ?? DEFAULT_LIBRARY;

/** Schematic → PCB update with footprints resolved through the library. */
export async function syncPcb(p: Project, ctx: ToolContext) {
  const names = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && !n.props.power && n.props.Footprint).map((n) => String(n.props.Footprint));
  const resolveFootprint = await libOf(ctx).resolver(p.doc, names);
  const { ops, report } = planSync(p.doc, p.engine, extractNetlist(p.doc, p.engine), { resolveFootprint, copper: p.copper });
  // Keep a copy of every library footprint the board now uses, so the project stays self-contained.
  const keep: Op[] = [];
  for (const n of new Set(names)) {
    const fp = resolveFootprint(n);
    if (fp && fp.source !== 'generic' && !p.doc.meta[fpKey(n)]) keep.push({ op: 'setMeta', key: fpKey(n), value: { ...fp, name: n } });
  }
  apply(p, 'Update PCB from schematic', [...keep, ...ops]);
  // Pin ↔ pad check (S20) on what the board now holds.
  const pinPad = pinPadCheck(p.doc, { resolve: resolveFootprint }).flatMap(describePinPad);
  return { changed: ops.length > 0, ...report, netsRenamed: report.netsRenamed.map(([a, b]) => `${a} → ${b}`), ...(pinPad.length ? { pinPad } : {}) };
}

function parsePrices(v: unknown): { qty: number; price: number }[] {
  if (Array.isArray(v)) return v.map((x) => ({ qty: num((x as { qty: unknown }).qty, 'qty'), price: num((x as { price: unknown }).price, 'price') }));
  return String(v ?? '')
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((pair) => {
      const [q, pr] = pair.split(/[:@=]/);
      return { qty: num(q, 'qty'), price: num(pr, 'price') };
    });
}

type Schema = { type: string; description?: string; enum?: readonly string[]; items?: Schema; properties?: Record<string, Schema>; required?: string[] };

export interface ToolDef {
  name: string;
  description: string;
  mutates: boolean;
  input: { type: 'object'; properties: Record<string, Schema>; required?: string[] };
  run: (p: Project, args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
}

export class ToolError extends Error {}

// ---------------------------------------------------------------- helpers

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`"${name}" must be a non-empty string`);
  return v.trim();
};
const num = (v: unknown, name: string): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`"${name}" must be a number`);
  return n;
};
const optNum = (v: unknown, name: string) => (v === undefined || v === null || v === '' ? undefined : num(v, name));
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

function apply(p: Project, label: string, ops: Op[]): void {
  if (!ops.length) return;
  // Schematic edits also add / remove junction dots where wires meet.
  p.history.apply(label, withJunctionsOps(p.doc, p.engine, ops));
}

export function summarize(p: Project, n: DocNode) {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props)) if (v !== '' && k !== 'element') props[k] = v;
  const out: Record<string, unknown> = { uid: n.uid, type: n.type, name: n.name, props };
  if (n.type === 'element' || n.type === 'symbol' || n.type === 'via') {
    const pos = vec(p.engine.get(n.uid, 'position')?.value);
    if (pos) out.position = { x: +pos.x.toFixed(4), y: +pos.y.toFixed(4) };
    const rot = p.engine.get(n.uid, 'rotation')?.value;
    if (typeof rot === 'number') out.rotation = rot;
  }
  if (n.type === 'trace' || n.type === 'via' || n.type === 'fill') {
    const parent = n.parent ? p.doc.nodes.get(n.parent) : undefined;
    if (parent?.type === 'net') out.net = parent.name;
  }
  if (n.type === 'symbol' || n.type === 'label' || n.type === 'wire') {
    const sh = sheetOf(p.doc, n);
    if (sh) out.sheet = sheetPath(p.doc, sh);
  }
  return out;
}

/** "R1" (part), "R1.2" (pin/pad), a uid, or a selector like "net[netClass=power] > trace". */
/** True when a pasted item (uids in `fresh`) lands on a pin, wire end or wire of the rest of the sheet. */
function copyTouches(p: Project, sheetUid: string, fresh: Set<string>): boolean {
  const pts = { old: [] as Vec2[], new: [] as Vec2[] };
  const segs = { old: [] as [Vec2, Vec2][], new: [] as [Vec2, Vec2][] };
  for (const c of p.doc.nodes.get(sheetUid)?.children ?? []) {
    const n = p.doc.nodes.get(c);
    if (!n) continue;
    const side = fresh.has(n.uid) ? 'new' : 'old';
    if (n.type === 'wire') {
      const a = vec(p.engine.get(n.uid, 'start')?.value), b = vec(p.engine.get(n.uid, 'end')?.value);
      if (a && b) (segs[side].push([a, b]), pts[side].push(a, b));
    } else if (n.type === 'symbol') {
      for (const k of n.children) {
        const pn = p.doc.nodes.get(k);
        const local = pn?.type === 'pin' ? vec(p.engine.get(pn.uid, 'position')?.value) : undefined;
        if (local) pts[side].push(symToSheet(symbolFrame(p.engine, n.uid), local));
      }
    } else if (n.type === 'label' || n.type === 'junction') {
      const at = vec(p.engine.get(n.uid, 'position')?.value);
      if (at) pts[side].push(at);
    }
  }
  const onSeg = (q: Vec2, [a, b]: [Vec2, Vec2]) =>
    Math.min(a.x, b.x) - 1e-3 <= q.x && q.x <= Math.max(a.x, b.x) + 1e-3 && Math.min(a.y, b.y) - 1e-3 <= q.y && q.y <= Math.max(a.y, b.y) + 1e-3 &&
    Math.abs((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x)) < 1e-3;
  return pts.new.some((q) => segs.old.some((sg) => onSeg(q, sg)) || pts.old.some((r) => Math.abs(r.x - q.x) < 1e-3 && Math.abs(r.y - q.y) < 1e-3)) || pts.old.some((q) => segs.new.some((sg) => onSeg(q, sg)));
}

/** Symbol uids (first unit of each) for a list of references, in the given order. */
function symbolsByRefs(p: Project, refs: string): string[] {
  const out: string[] = [];
  for (const r of refs.split(/[,\s]+/).filter(Boolean)) {
    const n = [...p.doc.nodes.values()].find((x) => x.type === 'symbol' && (String(x.props.ref ?? x.name) === r || x.uid === r));
    if (!n) throw new ToolError(`No schematic symbol ${r}`);
    if (!out.includes(n.uid)) out.push(n.uid);
  }
  return out;
}

/** Apply a move-type edit only if every connection stays as it was. */
function applyKeepingConnections(p: Project, label: string, ops: Op[]): void {
  if (!ops.length) return;
  const before = groupsOf(p);
  apply(p, label, ops);
  if (JSON.stringify(groupsOf(p)) !== JSON.stringify(before)) {
    p.history.undo();
    throw new ToolError(`${label} would change connections (pins or wires would land on other nets). Make room first, or move the parts one by one with move_symbol.`);
  }
}

/** Connectivity as sorted pin groups ("R1.1 C1.1"), nets with one pin left out. */
function groupsOf(p: Project): string[] {
  return extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g0) => g0.includes(' ')).sort();
}

export function resolveTargets(p: Project, target: string): DocNode[] {
  const t = target.trim();
  const byUid = p.doc.nodes.get(t) ?? (t.startsWith('#') ? p.doc.nodes.get(t.slice(1)) : undefined);
  if (byUid) return [byUid];
  // A list of uids / refs / pins ("tr1, tr2", "R1 R2 C3", "#tr1, #tr2"): the union.
  if (/[,\s]/.test(t) && !/[[\]>:()*=]/.test(t)) {
    const parts = t.split(/[,\s]+/).filter(Boolean);
    const out: DocNode[] = [];
    let all = true;
    for (const part of parts) {
      const one = p.doc.nodes.get(part) ?? (part.startsWith('#') ? p.doc.nodes.get(part.slice(1)) : undefined);
      if (one) out.push(one);
      else if (/^[A-Za-z#_]*[A-Za-z]+\d+[A-Za-z]?(\.[\w+~-]+)?$/.test(part)) {
        const hits = resolveTargets(p, part);
        if (hits.length) out.push(...hits);
        else all = false;
      } else all = false;
    }
    if (all && out.length) return [...new Map(out.map((n) => [n.uid, n])).values()];
  }
  if (/^[A-Za-z#_]*[A-Za-z]+\d+[A-Za-z]?$/.test(t)) {
    const hits = [...p.doc.nodes.values()].filter((n) => (n.type === 'element' || n.type === 'symbol') && (n.name === t || n.props.ref === t));
    if (hits.length) return hits;
  }
  const pin = /^([A-Za-z#_]*[A-Za-z]+\d+[A-Za-z]?)\.([\w+~-]+)$/.exec(t);
  if (pin) {
    const out: DocNode[] = [];
    for (const n of p.doc.nodes.values()) {
      if ((n.type === 'pad' || n.type === 'pin') && String(n.props.number ?? n.name) === pin[2]) {
        const parent = n.parent ? p.doc.nodes.get(n.parent) : undefined;
        if (parent && (parent.name === pin[1] || parent.props.ref === pin[1])) out.push(n);
      }
    }
    return out; // looks like REF.PIN: never fall through to selector parsing
  }
  try {
    return querySelectorAll(p.doc, t);
  } catch (e) {
    const quoted = quoteSelectorIds(t);
    const hint = quoted !== t ? ` Names with ( ) : , or spaces must be quoted: ${quoted}` : '';
    throw new ToolError(`"${t}" is not a part, pin, uid or valid selector: ${(e as Error).message}.${hint}`);
  }
}

/** Quote every #id in a selector that holds characters the bare form does not allow, e.g. net#Net-(U1-SW1) → net#"Net-(U1-SW1)". */
export function quoteSelectorIds(sel: string): string {
  return sel.replace(/#(?!["'])([^\s>,[\]"']+)/g, (m, id: string) => (/[():*=]/.test(id) ? `#"${id}"` : m));
}

function one(p: Project, target: string, type?: DocNode['type']): DocNode {
  const hits = resolveTargets(p, target).filter((n) => !type || n.type === type);
  if (!hits.length) throw new ToolError(`Nothing matches "${target}"${type ? ` (looking for a ${type})` : ''}`);
  return hits[0]!;
}

/** A sheet pin written "Block:PIN" (block name or sub-sheet path, then the pin name). */
function sheetPinOf(p: Project, ref: string): { pin: DocNode; at: Vec2; sheet: DocNode } | null {
  const m = /^(.+):([^:]+)$/.exec(ref.trim());
  if (!m) return null;
  const want = m[1]!.replace(/^\/|\/$/g, '');
  const blocks = [...p.doc.nodes.values()].filter((n) => n.type === 'block' && (n.name === want || sheetPath(p.doc, sheetOfBlock(p.doc, n) ?? n).replace(/^\/|\/$/g, '') === want));
  if (!blocks.length) return null;
  const block = blocks[0]!;
  const pin = block.children.map((c) => p.doc.nodes.get(c)).find((n) => n?.type === 'sheetPin' && n.name === m[2]);
  if (!pin) {
    const names = block.children.map((c) => p.doc.nodes.get(c)).filter((n) => n?.type === 'sheetPin').map((n) => n!.name);
    throw new ToolError(`Block ${block.name} has no sheet pin "${m[2]}"${names.length ? ` (it has ${names.join(', ')})` : ''}. Sheet pins appear when you add hierarchical labels inside the sub-sheet (add_label kind=hier).`);
  }
  const at = vec(p.engine.get(pin.uid, 'position')?.value);
  const sheet = block.parent ? p.doc.nodes.get(block.parent) : undefined;
  if (!at || sheet?.type !== 'sheet') throw new ToolError(`Sheet pin ${ref} has no position`);
  return { pin, at, sheet };
}

function pinOf(p: Project, ref: string): { pin: DocNode; at: Vec2; sheet: DocNode } {
  const sp = sheetPinOf(p, ref);
  if (sp) return sp;
  const pin = one(p, ref, 'pin');
  const at = pinPoint(p.doc, p.engine, pin);
  const sheet = sheetOf(p.doc, pin);
  if (!at || !sheet) throw new ToolError(`Pin ${ref} has no position`);
  return { pin, at, sheet };
}

/** "B" / "b" / "2" → 2, checked against the number of units. */
function parseUnit(v: string, count: number): number {
  const t = v.trim().replace(/\s*\(power\)$/i, '');
  let n = /^\d+$/.test(t) ? Number(t) : 0;
  if (!n && /^[A-Za-z]+$/.test(t)) for (const ch of t.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  if (!(n >= 1 && n <= count)) throw new ToolError(`Unit "${v}" does not exist; this part has ${Array.from({ length: count }, (_, i) => unitLetter(i + 1)).join(', ')}`);
  return n;
}

function unitReport(p: Project, ref: string) {
  const any = [...placedUnits(p.doc, ref).values()][0]?.[0];
  const st = any ? unitsOf(p.doc, any) : null;
  return { ref, units: st?.units.map((u) => ({ unit: u.label, placed: u.placed })) ?? [] };
}

function sheetByName(p: Project, name?: unknown): DocNode {
  const sheets = [...p.doc.nodes.values()].filter((n) => n.type === 'sheet');
  if (!sheets.length) throw new ToolError('The project has no schematic yet (use new_project, or import a .kicad_sch).');
  if (typeof name === 'string' && name.trim()) {
    const s = sheets.find((x) => x.name === name || sheetPath(p.doc, x) === name);
    if (!s) throw new ToolError(`No sheet "${name}". Sheets: ${sheets.map((x) => sheetPath(p.doc, x)).join(', ')}`);
    return s;
  }
  return sheets[0]!;
}

function checks(p: Project) {
  const ratsnest = computeRatsnest(p.doc, p.engine, p.copper);
  const hasSch = [...p.doc.nodes.values()].some((n) => n.type === 'sheet');
  return { ratsnest, erc: hasSch ? runErc(p.doc, p.engine) : null, drc: runDrc(p.doc, p.engine, p.copper, { ratsnest }) };
}

function countBy<T extends { kind: string }>(list: T[]) {
  const by: Record<string, number> = {};
  for (const v of list) by[v.kind] = (by[v.kind] ?? 0) + 1;
  return by;
}

const TARGET: Schema = { type: 'string', description: 'A part ("R1"), a pin/pad ("R1.2"), a uid, or a CSS-like selector (e.g. "net[netClass=power] > trace")' };

// ---------------------------------------------------------------- tools

export const TOOLS: ToolDef[] = [
  {
    name: 'project_status',
    description: 'Overview of the project: counts, layers, sheets, check results and the stage gates (requirements → schematic → components → layout → review → fabrication). Start here.',
    mutates: false,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const nodes = [...p.doc.nodes.values()];
      const count = (t: string) => nodes.filter((n) => n.type === t).length;
      const c = checks(p);
      return {
        name: p.name,
        counts: { parts: count('element'), symbols: nodes.filter((n) => n.type === 'symbol' && !n.props.power).length, pads: count('pad'), nets: count('net'), traces: count('trace'), vias: count('via'), pours: count('fill'), sheets: count('sheet') },
        copperLayers: p.copper,
        schematicGrid: schematicGrid(p.doc),
        board: (() => {
          const loop = boardOutline(p.doc, p.engine).loops[0];
          if (!loop) return 'no outline';
          const xs = loop.map((q) => q.x);
          const ys = loop.map((q) => q.y);
          return { width: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), height: +(Math.max(...ys) - Math.min(...ys)).toFixed(2), minX: +Math.min(...xs).toFixed(2), minY: +Math.min(...ys).toFixed(2), points: loop.length };
        })(),
        sheets: nodes.filter((n) => n.type === 'sheet').map((s) => sheetPath(p.doc, s)),
        checks: {
          erc: c.erc ? countBy(c.erc.violations) : 'no schematic',
          drc: countBy(c.drc.violations),
          unroutedConnections: c.ratsnest.lines.length,
        },
        gates: computeGates({ doc: p.doc, erc: c.erc, drc: c.drc, ratsnest: c.ratsnest }),
        spec: p.doc.meta.spec ?? {},
      };
    },
  },
  {
    name: 'query',
    description: 'Find objects with a CSS-like selector. Types: element (PCB part), pad, trace, via, fill (pour), net, symbol, pin, wire, label, sheet. Examples: "element", "#U1", "net[netClass=ground]", "net#GND > trace", "symbol[Value^=10k]", "pad[net=GND]". Quote names with ( ) : , or spaces, as KiCad net names often have: net#"Net-(U1-SW1)" > trace, pad[net="Net-(R1-Pad2)"].',
    mutates: false,
    input: { type: 'object', properties: { selector: { type: 'string', description: 'Selector' }, limit: { type: 'number', description: 'Max results (default 100)' } }, required: ['selector'] },
    run: (p, a) => {
      const all = resolveTargets(p, str(a.selector, 'selector'));
      const limit = optNum(a.limit, 'limit') ?? 100;
      return { total: all.length, results: all.slice(0, limit).map((n) => summarize(p, n)) };
    },
  },
  {
    name: 'inspect',
    description: 'Everything about one object: properties, children, and every computed layout rule with WHERE the value comes from (object, ruleset, inherited from a parent, or default).',
    mutates: false,
    input: { type: 'object', properties: { target: TARGET }, required: ['target'] },
    run: (p, a) => {
      const n = one(p, str(a.target, 'target'));
      const rules: Record<string, unknown> = {};
      for (const [name, c] of p.engine.of(n.uid)) {
        rules[name] = {
          value: formatRuleValue(name, c.value),
          source: c.source.kind + (c.source.important ? ' !important' : '') + (c.source.rulesetName ? ` (${c.source.rulesetName}: ${c.source.selector})` : '') + (c.source.fromUid ? ` from ${p.doc.nodes.get(c.source.fromUid)?.name || c.source.fromUid}` : ''),
        };
      }
      const children = n.children.map((u) => p.doc.nodes.get(u)!).filter(Boolean);
      return {
        ...summarize(p, n),
        specified: Object.fromEntries(n.rules.map((r) => [r.name, formatRuleValue(r.name, r.value) + (r.important ? ' !important' : '')])),
        computed: rules,
        children: children.length > 40 ? { count: children.length, first: children.slice(0, 40).map((c) => ({ uid: c.uid, type: c.type, name: c.name })) } : children.map((c) => ({ uid: c.uid, type: c.type, name: c.name, ...(c.props.net ? { net: c.props.net } : {}) })),
      };
    },
  },
  {
    name: 'list_parts',
    description: 'All parts with reference, value, footprint, MPN, board position/side, and whether they appear in the schematic and on the board.',
    mutates: false,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const parts = new Map<string, Record<string, unknown>>();
      for (const n of p.doc.nodes.values()) {
        if (n.type === 'symbol' && !n.props.power) {
          const ref = String(n.props.ref ?? n.name);
          const x = parts.get(ref) ?? { ref };
          Object.assign(x, { value: n.props.Value ?? x.value, inSchematic: true, sheet: sheetPath(p.doc, sheetOf(p.doc, n)!) });
          parts.set(ref, x);
        } else if (n.type === 'element') {
          const x = parts.get(n.name) ?? { ref: n.name };
          const pos = vec(p.engine.get(n.uid, 'position')?.value);
          Object.assign(x, {
            value: x.value ?? n.props.Value,
            footprint: n.props.Footprint,
            mpn: n.props.MPN ?? n.props['Manufacturer Part Number'] ?? n.props.LCSC,
            onBoard: true,
            placeholderFootprint: !!n.props.placeholder,
            position: pos && { x: +pos.x.toFixed(3), y: +pos.y.toFixed(3) },
            rotation: p.engine.get(n.uid, 'rotation')?.value,
            side: p.engine.get(n.uid, 'side')?.value,
          });
          parts.set(n.name, x);
        }
      }
      return [...parts.values()].sort((a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true }));
    },
  },
  {
    name: 'netlist',
    description: 'The schematic netlist: every net with its pins (REF.PIN) and how the name was chosen.',
    mutates: false,
    input: { type: 'object', properties: { filter: { type: 'string', description: 'Only nets whose name contains this text' } } },
    run: (p, a) => {
      const nl = extractNetlist(p.doc, p.engine);
      const f = typeof a.filter === 'string' ? a.filter.toLowerCase() : '';
      return nl.nets.filter((n) => !f || n.name.toLowerCase().includes(f)).map((n) => ({ name: n.name, pins: n.pins.map((x) => `${x.ref}.${x.pin}`) }));
    },
  },
  {
    name: 'run_erc',
    description: 'Electrical rule check of the schematic (unconnected pins, pin types that should not meet, undriven power, dangling wires/labels, duplicate references, buses). Uses the project\'s ERC settings (set_erc_rule, set_erc_check, set_erc_option). Each violation has an id; waive_violation accepts one with a reason, and waived ones are listed apart.',
    mutates: false,
    input: { type: 'object', properties: { limit: { type: 'number', description: 'Max violations listed (default 50)' } } },
    run: (p, a) => {
      const r = runErc(p.doc, p.engine);
      const limit = optNum(a.limit, 'limit') ?? 50;
      return {
        errors: r.violations.filter((v) => v.severity === 'error').length,
        warnings: r.violations.filter((v) => v.severity === 'warning').length,
        byKind: countBy(r.violations),
        violations: r.violations.slice(0, limit).map((v) => ({ id: v.id, kind: v.kind, severity: v.severity, message: v.message, at: v.at })),
        ...(r.waived.length ? { waived: r.waived.map((v) => ({ id: v.id, kind: v.kind, message: v.message, reason: v.waiver.reason, ...(v.waiver.by ? { by: v.waiver.by } : {}) })) } : {}),
      };
    },
  },
  {
    name: 'set_erc_rule',
    description: `Change the ERC pin-type matrix of this project: how a pin of type pin_a connected to a pin of type pin_b is reported (ok, warning, error, or default). Types: ${ERC_PIN_TYPES.join(', ')}. The defaults match KiCad's.`,
    mutates: true,
    input: { type: 'object', properties: { pin_a: { type: 'string', enum: [...ERC_PIN_TYPES] }, pin_b: { type: 'string', enum: [...ERC_PIN_TYPES] }, level: { type: 'string', enum: ['ok', 'warning', 'error', 'default'] } }, required: ['pin_a', 'pin_b', 'level'] },
    run: (p, a) => {
      const A = str(a.pin_a, 'pin_a') as PinType;
      const B = str(a.pin_b, 'pin_b') as PinType;
      if (!ERC_PIN_TYPES.includes(A) || !ERC_PIN_TYPES.includes(B)) throw new ToolError(`Pin types are ${ERC_PIN_TYPES.join(', ')}`);
      const level = str(a.level, 'level');
      if (!['ok', 'warning', 'error', 'default'].includes(level)) throw new ToolError('level must be ok, warning, error or default');
      apply(p, `ERC: ${A} + ${B}`, [setPinLevelOp(p.doc, A, B, level === 'default' ? null : (level as ErcLevel))]);
      return { [`${A} + ${B}`]: ercSettings(p.doc).level(A, B), default: defaultPinLevel(A, B) };
    },
  },
  {
    name: 'set_erc_check',
    description: `Change how one ERC check reports in this project: error, warning, ignore (not reported), or default. Checks: ${Object.keys(ERC_LABEL).join(', ')}.`,
    mutates: true,
    input: { type: 'object', properties: { check: { type: 'string', enum: Object.keys(ERC_LABEL) }, level: { type: 'string', enum: ['error', 'warning', 'ignore', 'default'] } }, required: ['check', 'level'] },
    run: (p, a) => {
      const check = str(a.check, 'check');
      if (!(check in ERC_LABEL)) throw new ToolError(`Checks are ${Object.keys(ERC_LABEL).join(', ')}`);
      const level = str(a.level, 'level');
      if (!['error', 'warning', 'ignore', 'default'].includes(level)) throw new ToolError('level must be error, warning, ignore or default');
      apply(p, `ERC: ${check} ${level}`, [setErcSeverityOp(p.doc, check, level === 'default' ? null : (level as ErcSeverityOverride))]);
      return { check, level };
    },
  },
  {
    name: 'set_erc_option',
    description: 'ERC options of this project. power_symbols_need_source: treat every power symbol (GND, +3V3 …) as a power input, so its net needs a power output or a PWR_FLAG, as KiCad does (default off).',
    mutates: true,
    input: { type: 'object', properties: { power_symbols_need_source: { type: 'boolean' } }, required: ['power_symbols_need_source'] },
    run: (p, a) => {
      if (typeof a.power_symbols_need_source !== 'boolean') throw new ToolError('power_symbols_need_source must be true or false');
      apply(p, 'ERC option', [setErcOptionOp(p.doc, 'powerSymbolsNeedSource', a.power_symbols_need_source)]);
      return { power_symbols_need_source: a.power_symbols_need_source };
    },
  },
  {
    name: 'waive_violation',
    description: 'Accept one ERC violation (its id from run_erc) with a reason; it no longer counts as a problem, and Review lists it as waived with the reason. Only waive what is intended, never to hide a mistake.',
    mutates: true,
    input: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] },
    run: (p, a, ctx) => {
      const id = str(a.id, 'id');
      const reason = str(a.reason, 'reason').trim();
      if (!reason) throw new ToolError('A waiver needs a reason');
      const v = runErc(p.doc, p.engine).violations.find((x) => x.id === id);
      if (!v) throw new ToolError(`No current ERC violation with id ${id} (run_erc lists them)`);
      apply(p, `Waive ${v.kind}`, [waiveOp(p.doc, id, reason, undefined, v.message)]);
      return { waived: id, kind: v.kind, message: v.message, reason };
    },
  },
  {
    name: 'unwaive_violation',
    description: 'Remove a waiver, so the violation counts again.',
    mutates: true,
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (p, a) => {
      const id = str(a.id, 'id');
      if (!ercSettings(p.doc).waivers[id]) throw new ToolError(`No waiver for ${id}`);
      apply(p, 'Remove waiver', [unwaiveOp(p.doc, id)]);
      return { unwaived: id };
    },
  },
  {
    name: 'run_drc',
    description: 'Design rule check of the board (shorts, clearance, edge clearance, copper outside the board, trace width, hole size, unrouted connections). Limits come from the layout rules.',
    mutates: false,
    input: { type: 'object', properties: { limit: { type: 'number', description: 'Max violations listed (default 50)' } } },
    run: (p, a) => {
      const r = runDrc(p.doc, p.engine, p.copper);
      const limit = optNum(a.limit, 'limit') ?? 50;
      return { errors: r.violations.filter((v) => v.severity === 'error').length, byKind: countBy(r.violations), violations: r.violations.slice(0, limit).map((v) => ({ kind: v.kind, severity: v.severity, message: v.message, layer: v.layer, at: { x: +v.at.x.toFixed(3), y: +v.at.y.toFixed(3) }, objects: v.uids })) };
    },
  },
  {
    name: 'list_rules',
    description: 'All layout rules that can be set (name, kind, whether it inherits, allowed values), plus the project rulesets and the built-in defaults.',
    mutates: false,
    input: { type: 'object', properties: {} },
    run: (p) => ({
      rules: [...RULE_DEFS.values()].filter((d) => d.kind !== 'points').map((d) => ({ name: d.name, label: d.label, kind: d.kind, inheritable: d.inheritable, ...(d.options ? { options: d.options } : {}), help: d.help })),
      rulesets: p.doc.rulesets.map((r) => ({ id: r.id, name: r.name, selector: r.selector, enabled: r.enabled, rules: r.rules.map((x) => `${x.name}: ${formatRuleValue(x.name, x.value)}${x.important ? ' !important' : ''}`) })),
      defaults: p.doc.defaults.map((r) => ({ name: r.name, selector: r.selector, rules: r.rules.map((x) => `${x.name}: ${formatRuleValue(x.name, x.value)}`) })),
    }),
  },
  // ---------------------------------------------------------------- writes
  {
    name: 'set_rule',
    description: 'Set a layout rule. scope="ruleset" (default) creates/updates a project ruleset whose selector is `target`, so it applies to everything matching now and later; scope="object" sets it directly on each matched object. Values take units, e.g. traceWidth "0.4mm", keepOut "0.2mm fill(0.5mm)", pourLayers "F.Cu B.Cu".',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        target: TARGET,
        rule: { type: 'string', description: 'Rule name, e.g. traceWidth, keepOut, viaDiameter, pourLayers, padShape (see list_rules)' },
        value: { type: 'string', description: 'Value with units' },
        scope: { type: 'string', enum: ['ruleset', 'object'] },
        important: { type: 'boolean', description: 'Mark !important (beats object-specific values)' },
        ruleset_name: { type: 'string', description: 'Name for the ruleset (scope=ruleset)' },
      },
      required: ['target', 'rule', 'value'],
    },
    run: (p, a) => {
      const target = str(a.target, 'target');
      const rule = str(a.rule, 'rule');
      if (!RULE_DEFS.has(rule)) throw new ToolError(`Unknown rule "${rule}". Use list_rules.`);
      let value;
      try {
        value = parseRuleValue(rule, String(a.value));
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const decl: RuleDecl = { name: rule, value, ...(a.important ? { important: true } : {}) };
      if (a.scope === 'object') {
        const nodes = resolveTargets(p, target);
        if (!nodes.length) throw new ToolError(`Nothing matches "${target}"`);
        apply(p, `Set ${rule}`, nodes.map((n) => ({ op: 'setRule', uid: n.uid, name: rule, decl })));
        return { set: rule, value: formatRuleValue(rule, value), objects: nodes.length };
      }
      const selector = /^[A-Za-z]+\d+$/.test(target) ? `#${target}` : target;
      const matched = resolveTargets(p, selector).length;
      const next = structuredClone(p.doc.rulesets);
      const name = typeof a.ruleset_name === 'string' && a.ruleset_name.trim() ? a.ruleset_name.trim() : `Rule: ${selector}`;
      let rs = next.find((r) => r.selector === selector && (r.name === name || !a.ruleset_name));
      if (!rs) next.push((rs = { id: newUid('rs'), name, selector, rules: [], enabled: true, origin: 'project' }));
      const i = rs.rules.findIndex((r) => r.name === rule);
      if (i >= 0) rs.rules[i] = decl;
      else rs.rules.push(decl);
      apply(p, `Set ${rule}`, [{ op: 'setRulesets', rulesets: next }]);
      return {
        ruleset: rs.name,
        selector,
        set: rule,
        value: formatRuleValue(rule, value),
        currentlyMatches: matched,
        ...(matched ? {} : { warning: 'Nothing matches this selector yet; the ruleset will apply to matching objects added later.' }),
      };
    },
  },
  {
    name: 'set_property',
    description: 'Set a property on parts/symbols (e.g. Value, MPN, Manufacturer, Footprint, Datasheet). Applies to the symbol and its board part when given a reference like "R1".',
    mutates: true,
    input: { type: 'object', properties: { target: TARGET, key: { type: 'string' }, value: { type: 'string', description: 'New value; empty string removes it' } }, required: ['target', 'key', 'value'] },
    run: (p, a) => {
      const nodes = resolveTargets(p, str(a.target, 'target'));
      if (!nodes.length) throw new ToolError(`Nothing matches "${a.target}"`);
      const key = str(a.key, 'key');
      const v = String(a.value ?? '');
      apply(p, `Set ${key}`, nodes.map((n) => ({ op: 'setProp', uid: n.uid, key, value: v === '' ? null : v })));
      return { updated: nodes.map((n) => n.name || n.uid), key, value: v };
    },
  },
  {
    name: 'set_spec',
    description: `Fill in the project requirements. Fields: ${SPEC_FIELDS.map((f) => `${f.key} (${f.label}${f.required ? ', required' : ''})`).join('; ')}.`,
    mutates: true,
    input: { type: 'object', properties: Object.fromEntries(SPEC_FIELDS.map((f) => [f.key, { type: 'string', description: f.hint }])) },
    run: (p, a) => {
      const next: Spec = { ...((p.doc.meta.spec ?? {}) as Spec) };
      let n = 0;
      for (const f of SPEC_FIELDS) if (typeof a[f.key] === 'string') ((next[f.key] = String(a[f.key])), n++);
      if (!n) throw new ToolError('Give at least one requirement field.');
      apply(p, 'Edit requirements', [{ op: 'setMeta', key: 'spec', value: next }]);
      return { spec: next };
    },
  },
  {
    name: 'add_part',
    description: `Place a schematic symbol. kind: ${PART_KINDS.map((k) => k.kind).join(', ')}. Positions are in mm on the sheet; the part snaps so its pins land on the pin grid (see project_status, default 2.54 mm). Returns the new reference; then connect it with connect_pins / add_label and call update_pcb.`,
    mutates: true,
    input: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: PART_KINDS.map((k) => k.kind) },
        value: { type: 'string', description: 'e.g. "10k", "100n", "ESP32-C3"' },
        pins: { type: 'number', description: 'Pin count (connector / ic)' },
        pin_names: { type: 'array', items: { type: 'string' }, description: 'Pin names in pin-number order (ic / connector)' },
        x: { type: 'number' },
        y: { type: 'number' },
        sheet: { type: 'string', description: 'Sheet name or path (default: root)' },
        ref: { type: 'string', description: 'Reference to use (default: next free)' },
        mpn: { type: 'string' },
        package: { type: 'string', description: 'Footprint (default per kind, e.g. chip-0603, soic-8; any name search_footprints returns)' },
        pin_layout: { type: 'string', enum: ['package', 'auto', 'table'], description: 'ic: where pins go. package (default): first half down the left, second half up the right, as on the package; auto: supplies on top, grounds at the bottom, inputs left, outputs right; table: the sides in pin_sides' },
        pin_sides: { type: 'array', items: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }, description: 'ic: side of each pin in pin-number order (with pin_layout table)' },
      },
      required: ['kind', 'x', 'y'],
    },
    run: (p, a) => {
      const kind = str(a.kind, 'kind') as PartKind;
      if (!PART_KINDS.some((k) => k.kind === kind)) throw new ToolError(`Unknown kind "${kind}"`);
      const sheet = sheetByName(p, a.sheet);
      const spec = makeSymbol(kind, { ...(a.pins ? { pins: num(a.pins, 'pins') } : {}), ...(typeof a.value === 'string' ? { value: a.value } : {}), ...(Array.isArray(a.pin_names) ? { pinNames: a.pin_names.map(String) } : {}) });
      // Pin sides for an IC (S16): same rules as the symbol editor.
      const layout = typeof a.pin_layout === 'string' ? a.pin_layout : Array.isArray(a.pin_sides) ? 'table' : 'package';
      if (kind === 'ic' && layout !== 'package') {
        if (!['auto', 'table'].includes(layout)) throw new ToolError('pin_layout must be package, auto or table');
        const sides = Array.isArray(a.pin_sides) ? a.pin_sides.map(String) : [];
        const rows: PinRow[] = spec.pins.map((q, i) => {
          const side = sides[i];
          if (side !== undefined && !(PIN_SIDES as readonly string[]).includes(side)) throw new ToolError(`pin_sides[${i}] must be left, right, top or bottom`);
          return { number: q.number, name: q.name, type: pinTypeFrom('', q.name), ...(side ? { side: side as PinSide } : {}) };
        });
        const u = buildSymbolUnits(rows, { layout: layout as PinLayout })[0]!;
        spec.pins = u.pins;
        spec.graphics = u.graphics;
      }
      // Pins land on the 2.54 mm grid, so wires to other parts can run straight.
      const at = pinGridOrigin({ x: num(a.x, 'x'), y: num(a.y, 'y') }, spec.pins.map((q) => q.at), 0, 'none', schematicGrid(p.doc).pin);
      const ref = typeof a.ref === 'string' && a.ref.trim() ? a.ref.trim() : undefined;
      if (ref && resolveTargets(p, ref).length) throw new ToolError(`Reference ${ref} is already used`);
      const { op, uid } = addSymbolOp(p.doc, sheet.uid, spec, at, ref);
      const ops: Op[] = [op];
      if (typeof a.mpn === 'string') ops.push({ op: 'setProp', uid, key: 'MPN', value: a.mpn });
      const gp = genericPart(kind, { ...(a.pins ? { pins: num(a.pins, 'pins') } : {}) });
      ops.push({ op: 'setProp', uid, key: 'Footprint', value: typeof a.package === 'string' && a.package.trim() ? a.package.trim() : gp.footprint! });
      apply(p, `Add ${spec.prefix}`, ops);
      const sym = p.doc.nodes.get(uid)!;
      return {
        ref: sym.name,
        uid,
        sheet: sheetPath(p.doc, sheet),
        pins: sym.children.map((c) => p.doc.nodes.get(c)!).map((pin) => {
          const pt = pinPoint(p.doc, p.engine, pin)!;
          return { pin: `${sym.name}.${pin.props.number}`, name: pin.props.pinName, at: { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2) } };
        }),
      };
    },
  },
  {
    name: 'move_symbol',
    description: 'Move, rotate or mirror a schematic symbol; wires on its pins follow (bent to stay at right angles), and short stubs to power symbols / labels move along with their symbols, so connections never break. Positions in mm; the part is snapped so its pins land on the pin grid of the project (default 2.54 mm) (line up connected pins on the same row / column for straight wires). mirror: "h" flips left↔right, "v" flips top↔bottom (toggles). unit selects one unit of a multi-unit part (default: all units move by the same offset).',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number', description: 'degrees, counter-clockwise' }, mirror: { type: 'string', enum: ['h', 'v'] }, unit: { type: 'number' } }, required: ['ref'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      let syms = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && String(n.props.ref ?? n.name) === ref);
      if (a.unit !== undefined) syms = syms.filter((n) => Number(n.props.unit ?? 1) === num(a.unit, 'unit'));
      if (!syms.length) throw new ToolError(`No schematic symbol ${ref}${a.unit !== undefined ? ` unit ${a.unit}` : ''}`);
      const g = schematicGrid(p.doc).wire;
      const first = vec(p.engine.get(syms[0]!.uid, 'position')?.value)!;
      const tx = optNum(a.x, 'x');
      const ty = optNum(a.y, 'y');
      const dx = tx === undefined ? 0 : Math.round(tx / g) * g - first.x;
      const dy = ty === undefined ? 0 : Math.round(ty / g) * g - first.y;
      const moves = syms.map((s) => {
        const at = vec(p.engine.get(s.uid, 'position')?.value)!;
        let rotation = Number(p.engine.get(s.uid, 'rotation')?.value ?? 0) || 0;
        let mirror = (p.engine.get(s.uid, 'mirror')?.value as Mirror) ?? 'none';
        const rot = optNum(a.rotation, 'rotation');
        if (rot !== undefined) rotation = ((rot % 360) + 360) % 360;
        if (a.mirror === 'h' || a.mirror === 'v') ({ rotation, mirror } = toggleMirror(rotation, mirror, a.mirror));
        return { uid: s.uid, position: { x: at.x + dx, y: at.y + dy }, rotation, mirror };
      });
      // Connections must stay exactly as they were: refuse a spot where pins or wires would land on other nets.
      const partition = () => extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g0) => g0.includes(' ')).sort();
      const before = partition();
      apply(p, `Move ${ref}`, moveSymbolsOps(p.doc, p.engine, moves, { pinGrid: true }));
      const after = partition();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        p.history.undo();
        const joined = after.filter((g0) => !before.includes(g0));
        throw new ToolError(`Moving ${ref} there would change connections (${joined.map((g0) => `[${g0}]`).join(', ') || 'a net would split'}): its pins or wires would land on other wires or pins. Choose a spot with free space around it.`);
      }
      return { ref, units: syms.length, position: { x: +(first.x + dx).toFixed(3), y: +(first.y + dy).toFixed(3) }, connections: 'unchanged' };
    },
  },
  {
    name: 'connect_pins',
    description: 'Draw a schematic wire between two pins on the same sheet, e.g. from "R1.2" to "D1.2" (a sub-sheet block pin is written "Block:NAME"). This is the normal way to connect parts: wires make the schematic easy to read and trace. The wire is routed at right angles around part bodies and never touches pins or wires of other nets (as few bends as practical); if no clean path exists the call fails and suggests labels. Place parts so their connected pins are close and aligned. Use add_label only for long-distance or cross-sheet signals, and add_power for GND/supply rails.',
    mutates: true,
    input: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    run: (p, a) => {
      const A = pinOf(p, str(a.from, 'from'));
      const B = pinOf(p, str(a.to, 'to'));
      if (A.sheet.uid !== B.sheet.uid) throw new ToolError('Pins are on different sheets. Inside a sub-sheet use add_label kind=hier, then wire the block pin ("Block:NAME") on the parent sheet; or use global labels.');
      const path = routeConnection(p.doc, p.engine, A.sheet.uid, A.at, B.at);
      if (!path)
        throw new ToolError(
          `No clean wire path from ${a.from} to ${a.to}: every route would cross a part body or touch another net. Move the parts closer / clear the way (move_symbol), or connect them with net labels instead (add_label with the same name on both pins).`,
        );
      apply(p, 'Connect pins', wirePathOps(p.doc, A.sheet.uid, path));
      const net = extractNetlist(p.doc, p.engine).byPin.get(String(a.from));
      return { connected: [a.from, a.to], net, bends: path.length - 2 };
    },
  },
  {
    name: 'add_power',
    description: 'Connect a pin to a power net with a proper power symbol and a short wire: ground symbol for GND-type nets (hangs below), supply symbol for rails like +3V3, +5V, +20V, VBAT (stands above). Power symbols with the same name are connected everywhere, so use this (not labels) for every power connection. flag=true adds a PWR_FLAG instead, to mark a net that is powered from a connector or other passive pin (clears "power input not driven" in ERC).',
    mutates: true,
    input: { type: 'object', properties: { pin: { type: 'string', description: 'e.g. "U1.8"' }, net: { type: 'string', description: 'e.g. "GND", "+3V3", "+5V"' }, flag: { type: 'boolean' } }, required: ['pin'] },
    run: (p, a) => {
      const P = pinOf(p, str(a.pin, 'pin'));
      const flag = !!a.flag;
      const net = flag ? 'PWR_FLAG' : str(a.net, 'net');
      // Outward direction of the pin (away from the symbol body).
      const sym = p.doc.nodes.get(P.pin.parent!)!;
      const f = symbolFrame(p.engine, sym.uid);
      const local = vec(p.engine.get(P.pin.uid, 'position')?.value)!;
      const ang = ((Number(p.engine.get(P.pin.uid, 'rotation')?.value ?? 0) || 0) * Math.PI) / 180;
      const len = Number(p.engine.get(P.pin.uid, 'pinLength')?.value ?? 2.54) || 2.54;
      const body = symToSheet(f, { x: local.x + Math.cos(ang) * len, y: local.y - Math.sin(ang) * len });
      const ox = P.at.x - body.x;
      const oy = P.at.y - body.y;
      const out = Math.abs(ox) > Math.abs(oy) ? { x: Math.sign(ox), y: 0 } : { x: 0, y: Math.sign(oy) || 1 };
      // A flag points the same way as the rail it marks (down on ground nets, up on supplies).
      const down = isGroundNet(flag ? (extractNetlist(p.doc, p.engine).byPin.get(String(a.pin)) ?? '') : net);
      const g = 2.54;
      // Spots already taken by power symbols on this sheet: step further out instead of stacking.
      const taken: Vec2[] = [];
      for (const c of P.sheet.children) {
        const n = p.doc.nodes.get(c);
        if (n?.type === 'symbol' && n.props.power) {
          const q = vec(p.engine.get(n.uid, 'position')?.value);
          if (q) taken.push(q);
        }
      }
      const free = (q: Vec2) => !taken.some((t) => Math.hypot(t.x - q.x, t.y - q.y) < 1);
      let path: Vec2[] = [];
      let port: Vec2 = P.at;
      for (let k = 1; k <= 8; k++) {
        // A straight stub out of the pin, in the pin's own direction (no jog); if the spot is
        // taken by another power symbol, the stub gets longer instead.
        const p1 = { x: P.at.x + out.x * g * k, y: P.at.y + out.y * g * k };
        path = [P.at, p1];
        port = p1;
        if (free(port)) break;
      }
      const ops: Op[] = [];
      for (let i = 0; i + 1 < path.length; i++) {
        ops.push({ op: 'add', parent: P.sheet.uid, index: P.sheet.children.length + i, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: path[i]! }, { name: 'end', value: path[i + 1]! }], parent: P.sheet.uid, children: [] }] } });
      }
      const { op, ref } = addPowerPortOp(p.doc, P.sheet.uid, net, port, { flag, down });
      ops.push(op);
      apply(p, flag ? 'Add PWR_FLAG' : `Add ${net} symbol`, ops);
      return { pin: a.pin, symbol: ref, net: flag ? extractNetlist(p.doc, p.engine).byPin.get(String(a.pin)) : net };
    },
  },
  {
    name: 'add_bus',
    description: 'Draw a bus and name it: name is a vector such as DATA[0..7] (members DATA0 … DATA7) or a group such as I2C{SDA SCL} (members I2C.SDA, I2C.SCL). points: the corners, e.g. "10,20 60,20" (mm, on the grid). A wire belongs to a member through a net label with the member\'s name, as in KiCad; pins: optional list of pins ("U1.3 U1.4 …") that get those member labels in order. kind: local (default), global (members connect across sheets) or hier (inside a sub-sheet: a bus sheet pin appears on the block; on the parent, a bus touching that pin joins member by member, in order). Add bus entries with add_bus_entry where wires meet the bus.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Bus name, e.g. DATA[0..7] or I2C{SDA SCL}' },
        points: { type: 'string', description: 'Corners: "x,y x,y …" (a list of {x, y} also works)' },
        pins: { type: 'string', description: 'Pins to label with the members, in order: "U1.3 U1.4"' },
        kind: { type: 'string', enum: ['local', 'global', 'hier'] },
        sheet: { type: 'string' },
      },
      required: ['name', 'points'],
    },
    run: (p, a) => {
      const name = str(a.name, 'name');
      const members = busMembers(name);
      if (!members) throw new ToolError(`"${name}" is not a bus name: use a vector such as DATA[0..7] or a group such as I2C{SDA SCL}`);
      const pts: Vec2[] = Array.isArray(a.points)
        ? (a.points as unknown[]).map((q) => vec(q)).filter((q): q is Vec2 => !!q)
        : String(a.points ?? '')
            .trim()
            .split(/[\s;]+/)
            .filter(Boolean)
            .map((t) => t.split(',').map(Number))
            .filter((xy) => xy.length === 2 && xy.every(Number.isFinite))
            .map(([x, y]) => ({ x: x!, y: y! }));
      if (pts.length < 2) throw new ToolError('points needs at least two corners, e.g. "10,20 60,20"');
      const sheet = sheetByName(p, a.sheet);
      const kind = a.kind === undefined ? 'local' : String(a.kind);
      if (!['local', 'global', 'hier'].includes(kind)) throw new ToolError('kind must be local, global or hier');
      const bus = addBusOps(sheet, pts);
      const ops: Op[] = [...bus.ops];
      const at = pts[0]!;
      if (kind === 'hier') {
        if (!blockOfSheet(p.doc, sheet)) throw new ToolError('A hierarchical bus belongs inside a sub-sheet (add_sheet); use kind=global between top-level sheets.');
        const h = addHierLabelOp(sheet, name, at, 'bidirectional');
        ops.push({ ...h.op, index: sheet.children.length + ops.length } as Op);
      } else {
        ops.push({ op: 'add', parent: sheet.uid, index: sheet.children.length + ops.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name, props: { kind }, rules: [{ name: 'position', value: at }, { name: 'rotation', value: 0 }], parent: sheet.uid, children: [] }] } });
      }
      apply(p, `Add bus ${name}`, ops);
      const pinList = Array.isArray(a.pins) ? (a.pins as unknown[]).map(String) : typeof a.pins === 'string' ? a.pins.split(/[\s,]+/).filter(Boolean) : [];
      if (pinList.length > members.length) throw new ToolError(`${pinList.length} pins but ${name} has only ${members.length} members`);
      const labelled: string[] = [];
      for (const [i, pin] of pinList.entries()) {
        const P = pinOf(p, pin);
        apply(p, `Label ${pin} ${members[i]}`, [{ op: 'add', parent: P.sheet.uid, index: P.sheet.children.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name: members[i]!, props: { kind: 'local' }, rules: [{ name: 'position', value: P.at }, { name: 'rotation', value: 0 }], parent: P.sheet.uid, children: [] }] } }]);
        labelled.push(`${pin}=${members[i]}`);
      }
      return { bus: name, members, segments: bus.uids.length, ...(labelled.length ? { labelled } : {}) };
    },
  },
  {
    name: 'add_bus_entry',
    description: 'Add a bus entry next to a bus: x, y is a point beside the bus where the wire should leave (within 2.54 mm of it). Returns the entry\'s wire end; label the wire there with a member name of the bus (add_label on the pin it reaches), as in KiCad.',
    mutates: true,
    input: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, sheet: { type: 'string' } }, required: ['x', 'y'] },
    run: (p, a) => {
      const sheet = sheetByName(p, a.sheet);
      const at = { x: num(a.x, 'x'), y: num(a.y, 'y') };
      const g = busEntryAt(p.doc, p.engine, sheet, at, schematicGrid(p.doc).wire);
      if (!g) throw new ToolError(`No bus within 2.54 mm of ${at.x}, ${at.y} on this sheet`);
      const r = addBusEntryOp(sheet, g.at, g.size);
      apply(p, 'Add bus entry', [r.op]);
      return { entry: r.uid, onBus: g.at, wireEnd: { x: g.at.x + g.size.x, y: g.at.y + g.size.y } };
    },
  },
  {
    name: 'add_label',
    description: 'Attach a net label to a pin (e.g. pin "U1.3", name "SDA"). kind: local (default; same name on one sheet connects), global (connects across all sheets), or hier (hierarchical: inside a sub-sheet; a sheet pin of the same name appears on the sub-sheet block, and you wire that pin on the parent sheet with connect_pins "Block:NAME"). shape (hier only): input, output, bidirectional, tri_state or passive (default). Use labels only for signals that travel far or between sheets/blocks; wire nearby pins with connect_pins, and use add_power (not labels) for GND and supply rails.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        pin: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['local', 'global', 'hier'] },
        shape: { type: 'string', enum: [...SHEET_PIN_SHAPES] },
        global: { type: 'boolean', description: 'Same as kind=global' },
      },
      required: ['pin', 'name'],
    },
    run: (p, a) => {
      const P = pinOf(p, str(a.pin, 'pin'));
      const name = str(a.name, 'name');
      const kind = a.kind === undefined ? (a.global ? 'global' : 'local') : String(a.kind);
      if (!['local', 'global', 'hier'].includes(kind)) throw new ToolError('kind must be local, global or hier');
      if (kind === 'hier') {
        const block = blockOfSheet(p.doc, P.sheet);
        if (!block) throw new ToolError(`Pin ${a.pin} is on a top-level sheet; hierarchical labels belong inside a sub-sheet (add_sheet). Use kind=global to connect across top-level sheets.`);
        const shape = a.shape === undefined ? 'passive' : String(a.shape);
        if (!(SHEET_PIN_SHAPES as readonly string[]).includes(shape)) throw new ToolError(`shape must be one of ${SHEET_PIN_SHAPES.join(', ')}`);
        apply(p, 'Add hierarchical label', [addHierLabelOp(P.sheet, name, P.at, shape as SheetPinShape).op]);
        const sp = block.children.map((c) => p.doc.nodes.get(c)).find((n) => n?.type === 'sheetPin' && n.name === name);
        const at = sp ? vec(p.engine.get(sp.uid, 'position')?.value) : undefined;
        return { pin: a.pin, net: extractNetlist(p.doc, p.engine).byPin.get(String(a.pin)), sheetPin: `${block.name}:${name}`, ...(at ? { sheetPinAt: at } : {}) };
      }
      apply(p, 'Add label', [{ op: 'add', parent: P.sheet.uid, index: P.sheet.children.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name, props: { kind }, rules: [{ name: 'position', value: P.at }, { name: 'rotation', value: 0 }], parent: P.sheet.uid, children: [] }] } }]);
      return { pin: a.pin, net: extractNetlist(p.doc, p.engine).byPin.get(String(a.pin)) };
    },
  },
  {
    name: 'add_sheet',
    description: 'Add a hierarchical sub-sheet: a block on a sheet (top-left x, y in mm; default size 30 x 20 mm, it grows with its pins) with a new empty sheet inside, reached as sheet "/Name/". Place parts there with sheet="Name", connect its signals to the parent with add_label kind=hier inside, then wire the block pins "Name:SIGNAL" on the parent sheet with connect_pins. Use sub-sheets to split a large design into blocks (power, MCU, sensors…).',
    mutates: true,
    input: { type: 'object', properties: { name: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, sheet: { type: 'string', description: 'Parent sheet (default: root)' } }, required: ['name', 'x', 'y'] },
    run: (p, a) => {
      const parent = sheetByName(p, a.sheet);
      let r;
      try {
        r = addSubSheetOps(p.doc, parent, str(a.name, 'name'), { x: num(a.x, 'x'), y: num(a.y, 'y') }, { x: optNum(a.width, 'width') ?? 30.48, y: optNum(a.height, 'height') ?? 20.32 });
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      apply(p, 'Add sub-sheet', r.ops);
      const sheet = p.doc.nodes.get(r.sheet)!;
      return { sheet: sheetPath(p.doc, sheet), block: r.block, parent: sheetPath(p.doc, parent) };
    },
  },
  {
    name: 'update_pcb',
    description: 'Push the schematic into the board: pad nets, net renames (routed copper follows), new parts placed next to the board with their footprint from the library (placeholder if unknown), changed footprints rebuilt in place, part properties (Value, MPN…) copied. Board-only parts are kept.',
    mutates: true,
    input: { type: 'object', properties: {} },
    run: (p, _a, ctx) => syncPcb(p, ctx),
  },
  {
    name: 'set_schematic_grid',
    description: `Set the schematic grid of the project. pin: the step in which parts move (${PIN_GRIDS.join(' / ')} mm; default 2.54). The first pin of a part lands on it; since symbol pins are spaced in 2.54 mm steps, every pin stays on the 2.54 mm lattice either way, so wires can run straight. wire: where wire corners and free points snap (${WIRE_GRIDS.join(' / ')} mm, not coarser than pin). Parts already placed are not moved; run tidy_wires or move_symbol to line them up.`,
    mutates: true,
    input: { type: 'object', properties: { pin: { type: 'number' }, wire: { type: 'number' } }, required: ['pin'] },
    run: (p, a) => {
      let op;
      try {
        op = setSchematicGridOp(num(a.pin, 'pin'), optNum(a.wire, 'wire'));
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      apply(p, 'Schematic grid', [op]);
      return schematicGrid(p.doc);
    },
  },
  {
    name: 'align',
    description: 'Align schematic parts (refs, e.g. "C1 C2 C3") by their outlines: left, right, top, bottom, centerX (same vertical axis), centerY (same row), or spread them evenly: distributeX / distributeY (first and last stay). Wires follow; pins stay on the pin grid; refused if a connection would change.',
    mutates: true,
    input: { type: 'object', properties: { refs: { type: 'string' }, mode: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'centerX', 'centerY', 'distributeX', 'distributeY'] } }, required: ['refs', 'mode'] },
    run: (p, a) => {
      const uids = symbolsByRefs(p, str(a.refs, 'refs'));
      const ops = alignOps(p.doc, p.engine, uids, str(a.mode, 'mode') as AlignMode);
      applyKeepingConnections(p, `Align ${a.mode}`, ops);
      return { aligned: uids.length, mode: a.mode, connections: 'unchanged' };
    },
  },
  {
    name: 'place_relative',
    description: 'Put schematic parts in a row next to an anchor part: side below / above / left / right of the anchor, gap mm from its outline (default 2 pin-grid steps), spacing mm between parts (default 1 step), in the given order, centred on the anchor. Example: decoupling capacitors below U1. Wires follow; refused if a connection would change. Use it to build compact blocks.',
    mutates: true,
    input: { type: 'object', properties: { anchor: { type: 'string' }, refs: { type: 'string' }, side: { type: 'string', enum: ['below', 'above', 'left', 'right'] }, gap: { type: 'number' }, spacing: { type: 'number' } }, required: ['anchor', 'refs', 'side'] },
    run: (p, a) => {
      const anchor = symbolsByRefs(p, str(a.anchor, 'anchor'))[0];
      if (!anchor) throw new ToolError(`No schematic symbol ${a.anchor}`);
      const uids = symbolsByRefs(p, str(a.refs, 'refs')).filter((u) => u !== anchor);
      const gap = optNum(a.gap, 'gap');
      const spacing = optNum(a.spacing, 'spacing');
      const ops = placeRelativeOps(p.doc, p.engine, anchor, uids, str(a.side, 'side') as Side, { ...(gap !== undefined ? { gap } : {}), ...(spacing !== undefined ? { spacing } : {}) });
      applyKeepingConnections(p, `Place next to ${a.anchor}`, ops);
      return { placed: uids.length, anchor: a.anchor, side: a.side, connections: 'unchanged' };
    },
  },
  {
    name: 'compact_blocks',
    description: 'Make the schematic compact: groups of parts joined by wires (with their power symbols and labels, and anything placed right next to them) are moved as a whole and packed into rows in reading order, gap mm apart (default 7.62). Connections never change. Run it when every block is wired and ERC is clean, then run tidy_wires.',
    mutates: true,
    input: { type: 'object', properties: { sheet: { type: 'string', description: 'Sheet name or path (default: every sheet)' }, gap: { type: 'number' } } },
    run: (p, a) => {
      const sheets = [...p.doc.nodes.values()].filter((n) => n.type === 'sheet' && (typeof a.sheet !== 'string' || !a.sheet.trim() || n.name === a.sheet.trim() || sheetPath(p.doc, n) === a.sheet.trim()));
      if (!sheets.length) throw new ToolError(`No sheet ${String(a.sheet)}`);
      const gap = optNum(a.gap, 'gap');
      const report: { sheet: string; groups: number; moved: number; areaBefore: number; areaAfter: number }[] = [];
      for (const sh of sheets) {
        const r = compactBlocksOps(p.doc, p.engine, sh.uid, { ...(gap !== undefined ? { gap } : {}) });
        apply(p, 'Compact blocks', r.ops);
        report.push({ sheet: sheetPath(p.doc, sh), groups: r.blocks, moved: r.moved, areaBefore: Math.round(r.areaBefore), areaAfter: Math.round(r.areaAfter) });
      }
      return { sheets: report, connections: 'unchanged' };
    },
  },
  {
    name: 'set_sheet_frame',
    description: 'Give a schematic sheet a drawing frame with a title block (title, revision, date, author, sheet n / m). size: auto (smallest paper that holds the sheet; default), A4, A3, A2, A1, A0, or none to remove it. The frame is centred on what is drawn. Fields you leave out keep their value; title defaults to the project name.',
    mutates: true,
    input: { type: 'object', properties: { sheet: { type: 'string' }, size: { type: 'string' }, title: { type: 'string' }, project: { type: 'string' }, revision: { type: 'string' }, date: { type: 'string', description: 'e.g. 2026-11-12' }, author: { type: 'string' } } },
    run: (p, a) => {
      const sheet = sheetByName(p, a.sheet);
      const opt = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
      let r;
      try {
        r = setSheetFrameOps(p.doc, p.engine, sheet, {
          ...(opt('size') ? { size: opt('size')! } : {}),
          ...(opt('title') !== undefined ? { title: opt('title')! } : !sheet.props.title ? { title: p.name.replace(/\.hpcb$/i, '') } : {}),
          ...(opt('revision') !== undefined ? { revision: opt('revision')! } : {}),
          ...(opt('date') !== undefined ? { date: opt('date')! } : !sheet.props.date ? { date: localDate() } : {}),
          ...(opt('project') !== undefined ? { project: opt('project')! } : !p.doc.meta.projectName ? { project: p.name.replace(/\.hpcb$/i, '') } : {}),
          ...(opt('author') !== undefined ? { author: opt('author')! } : {}),
        });
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      apply(p, 'Sheet frame', r.ops);
      const f = sheetFrame(p.doc, sheet);
      return { sheet: sheetPath(p.doc, sheet), size: r.size, ...(f ? { fields: f.fields } : {}), ...(r.fits ? {} : { warning: 'The drawing is larger than the biggest paper; consider compact_blocks or more sheets.' }) };
    },
  },
  {
    name: 'add_note',
    description: 'Put a free text note on a schematic sheet (top-left corner at x, y mm; "\\n" for new lines), e.g. design decisions, calculations or assembly hints. size = text height in mm (default 1.5).',
    mutates: true,
    input: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, sheet: { type: 'string' } }, required: ['text', 'x', 'y'] },
    run: (p, a) => {
      const sheet = sheetByName(p, a.sheet);
      const text = str(a.text, 'text').replace(/\\n/g, '\n');
      const { op, uid } = addNoteOp(sheet, text, { x: num(a.x, 'x'), y: num(a.y, 'y') }, optNum(a.size, 'size') ?? 1.5);
      apply(p, 'Add note', [op]);
      return { uid };
    },
  },
  {
    name: 'add_group_box',
    description: 'Draw a titled box around a block on a schematic sheet, e.g. "Power 20 V → 5 V", "MCU", "Sensors". Give refs (the parts of the block; their wires and power symbols are included) to size it automatically, or x, y, width, height in mm.',
    mutates: true,
    input: { type: 'object', properties: { title: { type: 'string' }, refs: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, sheet: { type: 'string' } }, required: ['title'] },
    run: (p, a) => {
      let rect;
      let sheet = sheetByName(p, a.sheet);
      if (typeof a.refs === 'string' && a.refs.trim()) {
        const uids = symbolsByRefs(p, a.refs);
        const first = p.doc.nodes.get(uids[0]!)!;
        sheet = sheetOf(p.doc, first) ?? sheet;
        // The block = these parts plus the wires and power symbols joined to them.
        const block = sheetBlocks(p.doc, p.engine, sheet.uid).filter((b) => b.items.some((u) => uids.includes(u)));
        const items = new Set<string>(uids);
        for (const b of block) for (const u of b.items) {
          const n = p.doc.nodes.get(u);
          if (n && (n.type !== 'symbol' || n.props.power || uids.includes(u))) items.add(u);
        }
        rect = groupBoxAround(p.doc, p.engine, items);
      } else {
        const x = num(a.x, 'x'), y = num(a.y, 'y');
        rect = { minX: x, minY: y, maxX: x + num(a.width, 'width'), maxY: y + num(a.height, 'height') };
      }
      if (!rect) throw new ToolError('Nothing to put a box around');
      const { op, uid } = addGroupBoxOp(sheet, str(a.title, 'title'), rect);
      apply(p, 'Add group box', [op]);
      return { uid, box: { x: rect.minX, y: rect.minY, width: +(rect.maxX - rect.minX).toFixed(2), height: +(rect.maxY - rect.minY).toFixed(2) } };
    },
  },
  {
    name: 'tidy_wires',
    description: 'Straighten schematic wiring: wires that bend between two points are re-routed (for example sliding a T along the wire it joins), and where only a small part is off by a grid step or two (a divider, a pull-up), that part is moved so the pins line up. Connections never change. Run it after wiring a block. move_parts: false only re-routes.',
    mutates: true,
    input: { type: 'object', properties: { sheet: { type: 'string', description: 'Sheet name or path (default: every sheet)' }, move_parts: { type: 'boolean' } } },
    run: (p, a) => {
      const sheets = [...p.doc.nodes.values()].filter((n) => n.type === 'sheet' && (typeof a.sheet !== 'string' || !a.sheet.trim() || n.name === a.sheet.trim() || sheetPath(p.doc, n) === a.sheet.trim()));
      if (!sheets.length) throw new ToolError(`No sheet ${String(a.sheet)}`);
      const report: { sheet: string; bendsBefore: number; bendsAfter: number; rerouted: number; moved: string[] }[] = [];
      for (const sh of sheets) {
        const r = tidyWiresOps(p.doc, p.engine, sh.uid, { ...(a.move_parts === false ? { moveParts: false } : {}) });
        apply(p, 'Tidy wires', r.ops);
        report.push({ sheet: sheetPath(p.doc, sh), bendsBefore: r.before, bendsAfter: r.after, rerouted: r.rerouted, moved: r.moved });
      }
      return { sheets: report, connections: 'unchanged' };
    },
  },
  {
    name: 'annotate',
    description: 'Renumber part references per prefix in reading order (sheet by sheet, top to bottom, then left to right). mode "keep" (default) only numbers parts without a number ("R?") or with a duplicate reference; "reset" renumbers every part in scope from 1. sheet limits it to one sheet (name or path). Board components are renamed with their symbols; run update_pcb afterwards to rename the nets (routed copper follows).',
    mutates: true,
    input: { type: 'object', properties: { mode: { type: 'string', enum: ['keep', 'reset'] }, sheet: { type: 'string' }, power: { type: 'boolean', description: 'Also renumber power symbols (#PWR); default true' } } },
    run: (p, a) => {
      let sheet: string | undefined;
      if (typeof a.sheet === 'string' && a.sheet.trim()) {
        const want = a.sheet.trim();
        const sh = [...p.doc.nodes.values()].find((n) => n.type === 'sheet' && (n.name === want || n.uid === want || sheetPath(p.doc, n) === want));
        if (!sh) throw new ToolError(`No sheet ${want}`);
        sheet = sh.uid;
      }
      const mode = a.mode === 'reset' ? 'reset' : 'keep';
      const res = annotateOps(p.doc, p.engine, { mode, ...(sheet ? { sheet } : {}), ...(a.power === false ? { power: false } : {}) });
      apply(p, `Annotate (${mode})`, res.ops);
      return { mode, renamed: res.renames.length, renames: Object.fromEntries(res.renames), next: res.renames.length ? 'Run update_pcb so the board nets follow the new names.' : 'Nothing to renumber.' };
    },
  },
  {
    name: 'duplicate',
    description: 'Copy schematic parts (by reference, e.g. "R1 C3 U2") with the wires between them and the power symbols / labels on those wires, and place the copy dx, dy mm away. The copy gets the next free references; its internal connections are kept, it does not connect to anything else. Refused if the copy would land on existing pins or wires.',
    mutates: true,
    input: { type: 'object', properties: { refs: { type: 'string', description: 'References or uids, space / comma separated' }, dx: { type: 'number' }, dy: { type: 'number' } }, required: ['refs'] },
    run: (p, a) => {
      const wanted = str(a.refs, 'refs').split(/[,\s]+/).filter(Boolean);
      const syms = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && (wanted.includes(String(n.props.ref ?? n.name)) || wanted.includes(n.uid)));
      if (!syms.length) throw new ToolError(`No schematic symbols ${wanted.join(', ')}`);
      const sheet = sheetOf(p.doc, syms[0]!);
      if (!sheet) throw new ToolError('Symbol is not on a sheet');
      const items = new Set(syms.map((n) => n.uid));
      // Wires reachable from the parts' pins, and power symbols / labels at their ends.
      const pts: Vec2[] = [];
      for (const s0 of syms) for (const c of s0.children) {
        const pn = p.doc.nodes.get(c);
        const local = pn?.type === 'pin' ? vec(p.engine.get(pn.uid, 'position')?.value) : undefined;
        if (local) pts.push(symToSheet(symbolFrame(p.engine, s0.uid), local));
      }
      const near = (q: Vec2) => pts.some((r) => Math.abs(r.x - q.x) < 1e-3 && Math.abs(r.y - q.y) < 1e-3);
      const sheetKids = sheet.children.map((c) => p.doc.nodes.get(c)!).filter(Boolean);
      for (let grew = true; grew; ) {
        grew = false;
        for (const w of sheetKids) {
          if (w.type !== 'wire' || items.has(w.uid)) continue;
          const s1 = vec(p.engine.get(w.uid, 'start')?.value), e1 = vec(p.engine.get(w.uid, 'end')?.value);
          if (s1 && e1 && (near(s1) || near(e1))) (items.add(w.uid), pts.push(s1, e1), (grew = true));
        }
      }
      for (const n of sheetKids) {
        if (items.has(n.uid)) continue;
        if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') {
          const at = vec(p.engine.get(n.uid, 'position')?.value);
          if (at && near(at)) items.add(n.uid);
        } else if (n.type === 'symbol' && n.props.power) {
          const lbl = n.children.map((c) => p.doc.nodes.get(c)).find((k) => k?.type === 'label');
          const at = lbl ? vec(p.engine.get(lbl.uid, 'position')?.value) : undefined;
          if (at && near(at)) items.add(n.uid);
        }
      }
      const clip = copyItems(p.doc, p.engine, items);
      if (!clip) throw new ToolError('Nothing to copy');
      // Whole pin-grid steps, so copied pins stay on the pin grid.
      const g = schematicGrid(p.doc).pin;
      const dx = Math.round((optNum(a.dx, 'dx') ?? 25.4) / g) * g;
      const dy = Math.round((optNum(a.dy, 'dy') ?? 0) / g) * g;
      const before = groupsOf(p);
      const res = pasteOps(p.doc, sheet.uid, clip, { x: dx, y: dy });
      apply(p, `Duplicate ${wanted.join(' ')}`, res.ops);
      // The originals keep exactly their connections, and the copy only meets them through
      // named nets (power symbols, labels), never by touching pins or wires.
      const fresh = new Set(res.refs.values());
      const isNew = (pin: string) => fresh.has(pin.split('.')[0]!);
      const nets = extractNetlist(p.doc, p.engine).nets.map((n) => ({ named: n.named, pins: n.pins.map((x) => `${x.ref}.${x.pin}`).sort() }));
      const touches = nets.some((n) => n.named === 'auto' && n.pins.some(isNew) && !n.pins.every(isNew)) || copyTouches(p, sheet.uid, new Set(res.ops.flatMap((o) => (o.op === 'add' ? o.tree.nodes.map((x) => x.uid) : []))));
      const oldOnly = nets.map((n) => n.pins.filter((x) => !isNew(x)).join(' ')).filter((g0) => g0.includes(' ')).sort();
      if (touches || JSON.stringify(oldOnly) !== JSON.stringify(before)) {
        p.history.undo();
        throw new ToolError(`The copy would land on existing pins or wires at dx ${dx.toFixed(2)}, dy ${dy.toFixed(2)} mm. Choose an offset with free space.`);
      }
      return { refs: Object.fromEntries(res.refs), items: res.uids.length, offset: { dx: +dx.toFixed(3), dy: +dy.toFixed(3) } };
    },
  },
  {
    name: 'move_part',
    description: 'Place a board part: position in mm (board coordinates, Y down) and optional rotation in degrees (counter-clockwise).',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number' } }, required: ['ref', 'x', 'y'] },
    run: (p, a) => {
      const el = one(p, str(a.ref, 'ref'), 'element');
      const ops: Op[] = [{ op: 'setRule', uid: el.uid, name: 'position', decl: { name: 'position', value: { x: num(a.x, 'x'), y: num(a.y, 'y') } } }];
      const rot = optNum(a.rotation, 'rotation');
      if (rot !== undefined) ops.push({ op: 'setRule', uid: el.uid, name: 'rotation', decl: { name: 'rotation', value: ((rot % 360) + 360) % 360 } });
      apply(p, 'Move part', ops);
      return summarize(p, el);
    },
  },
  {
    name: 'route',
    description: 'Lay copper between two pads of the same net (e.g. from "R1.2" to "D1.2") as a 45° path, with optional via waypoints. Width comes from the net rules unless given. Does not avoid obstacles: run_drc afterwards.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        layer: { type: 'string', description: 'Copper layer (default F.Cu)' },
        width: { type: 'string', description: 'Optional width, e.g. "0.4mm"' },
        waypoints: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, description: 'Optional intermediate points (mm)' },
      },
      required: ['from', 'to'],
    },
    run: (p, a) => {
      const pa = one(p, str(a.from, 'from'), 'pad');
      const pb = one(p, str(a.to, 'to'), 'pad');
      const net = pa.props.net;
      if (!net || net !== pb.props.net) throw new ToolError(`${a.from} (${net ?? 'no net'}) and ${a.to} (${pb.props.net ?? 'no net'}) are not on the same net.`);
      const netNode = [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === net);
      if (!netNode) throw new ToolError(`Net ${net} has no net object; run update_pcb first.`);
      const layer = typeof a.layer === 'string' ? a.layer : p.copper[0]!;
      if (!p.copper.includes(layer)) throw new ToolError(`Unknown copper layer ${layer}. Layers: ${p.copper.join(', ')}`);
      const ga = padGeom(p.doc, p.engine, pa, p.copper)!;
      const gb = padGeom(p.doc, p.engine, pb, p.copper)!;
      const pts: Vec2[] = [ga.center, ...((Array.isArray(a.waypoints) ? a.waypoints : []) as Vec2[]).map((w) => ({ x: num(w.x, 'x'), y: num(w.y, 'y') })), gb.center];
      const path: Vec2[] = [pts[0]!];
      for (let i = 0; i + 1 < pts.length; i++) path.push(...route45(pts[i]!, pts[i + 1]!, true).slice(1));
      const extra: RuleDecl[] = [];
      if (typeof a.width === 'string') {
        try {
          extra.push({ name: 'traceWidth', value: parseRuleValue('traceWidth', a.width) });
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
      }
      const ops: Op[] = [];
      for (let i = 0; i + 1 < path.length; i++) {
        if (dist(path[i]!, path[i + 1]!) < 1e-6) continue;
        ops.push({ op: 'add', parent: netNode.uid, index: netNode.children.length + i, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: path[i]! }, { name: 'end', value: path[i + 1]! }, { name: 'layer', value: layer }, ...extra], parent: netNode.uid, children: [] }] } });
      }
      apply(p, 'Route', ops);
      const st = computeRatsnest(p.doc, p.engine, p.copper).nets.find((n) => n.net === net);
      return { net, segments: ops.length, layer, netFullyConnected: st ? st.islands <= 1 : true };
    },
  },
  {
    name: 'get_board_outline',
    description: 'The board shape: bounding box, size, area, and the outline points (simplified to at most max_points, default 64, within 0.05 mm where possible), plus cut-outs and mounting holes. Use it to see where parts fit before placing them.',
    mutates: false,
    input: { type: 'object', properties: { max_points: { type: 'number' } } },
    run: (p, a) => {
      const o = boardOutline(p.doc, p.engine);
      const loop = o.loops[0];
      if (!loop) throw new ToolError('The board has no closed outline yet (use set_board_outline).');
      const max = Math.max(4, Math.min(2000, optNum(a.max_points, 'max_points') ?? 64));
      const simplify = (pts: Vec2[], tol: number): Vec2[] => {
        if (pts.length < 3) return pts;
        const seg = (q: Vec2, s0: Vec2, s1: Vec2) => {
          const dx = s1.x - s0.x;
          const dy = s1.y - s0.y;
          const l = dx * dx + dy * dy || 1e-12;
          const t = Math.max(0, Math.min(1, ((q.x - s0.x) * dx + (q.y - s0.y) * dy) / l));
          return Math.hypot(q.x - (s0.x + t * dx), q.y - (s0.y + t * dy));
        };
        const keep = new Uint8Array(pts.length);
        keep[0] = keep[pts.length - 1] = 1;
        const stack: [number, number][] = [[0, pts.length - 1]];
        while (stack.length) {
          const [i0, i1] = stack.pop()!;
          let best = -1;
          let bd = tol;
          for (let i = i0 + 1; i < i1; i++) {
            const d = seg(pts[i]!, pts[i0]!, pts[i1]!);
            if (d > bd) (bd = d), (best = i);
          }
          if (best >= 0) (keep[best] = 1), stack.push([i0, best], [best, i1]);
        }
        return pts.filter((_, i) => keep[i]);
      };
      // Split the closed loop at its farthest point pair so the simplification keeps both ends.
      const closed = [...loop, loop[0]!];
      let tol = 0.05;
      let pts = simplify(closed, tol).slice(0, -1);
      while (pts.length > max && tol < 50) pts = simplify(closed, (tol *= 1.6)).slice(0, -1);
      const xs = loop.map((q) => q.x);
      const ys = loop.map((q) => q.y);
      let area = 0;
      for (let i = 0; i < loop.length; i++) {
        const q = loop[i]!;
        const r = loop[(i + 1) % loop.length]!;
        area += q.x * r.y - r.x * q.y;
      }
      const holes = [...p.doc.nodes.values()]
        .filter((n) => n.type === 'element' && n.children.some((c) => p.engine.get(c, 'padType')?.value === 'npth' || /^H\d+$/.test(n.name)))
        .map((n) => ({ ref: n.name, at: vec(p.engine.get(n.uid, 'position')?.value) }));
      return {
        bbox: { minX: +Math.min(...xs).toFixed(3), minY: +Math.min(...ys).toFixed(3), maxX: +Math.max(...xs).toFixed(3), maxY: +Math.max(...ys).toFixed(3) },
        width: +(Math.max(...xs) - Math.min(...xs)).toFixed(3),
        height: +(Math.max(...ys) - Math.min(...ys)).toFixed(3),
        areaMm2: +Math.abs(area / 2).toFixed(1),
        pointsInFile: loop.length,
        tolerance: +tol.toFixed(3),
        points: pts.map((q) => [+q.x.toFixed(3), +q.y.toFixed(3)]),
        cutouts: o.loops.length - 1,
        mountingHoles: holes,
      };
    },
  },
  {
    name: 'set_board_outline',
    description: 'Set the board shape (Edge.Cuts): a rectangle of width × height mm (top-left corner at x, y; defaults keep the current top-left), optionally with rounded corners (corner_radius), or any polygon via points ("x y, x y, …" in mm). Replaces the existing outline. Then move parts inside (auto_place) before routing.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'mm' },
        height: { type: 'number', description: 'mm' },
        x: { type: 'number', description: 'Left edge, mm' },
        y: { type: 'number', description: 'Top edge, mm' },
        corner_radius: { type: 'number', description: 'mm (rectangle only)' },
        points: { type: 'string', description: 'Custom polygon, e.g. "100 100, 172 100, 172 179, 100 179"' },
      },
    },
    run: (p, a) => {
      const layout = [...p.doc.nodes.values()].find((n) => n.type === 'layout');
      if (!layout) throw new ToolError('The project has no board yet.');
      const board = layout.children.map((c) => p.doc.nodes.get(c)!).find((n) => n?.type === 'container' && n.name === 'Board') ?? layout;
      const old = boardOutline(p.doc, p.engine).loops[0];
      let x0 = 100;
      let y0 = 100;
      if (old) (x0 = Math.min(...old.map((q) => q.x))), (y0 = Math.min(...old.map((q) => q.y)));
      let pts: Vec2[];
      if (typeof a.points === 'string' && a.points.trim()) {
        const parsed = parsePoints(a.points);
        if (!parsed) throw new ToolError('points: give at least three "x y" pairs in mm, e.g. "100 100, 172 100, 172 179, 100 179".');
        pts = parsed;
      } else {
        const w = num(a.width, 'width');
        const hgt = num(a.height, 'height');
        if (w < 5 || hgt < 5 || w > 1000 || hgt > 1000) throw new ToolError('width and height must be between 5 and 1000 mm');
        const x = optNum(a.x, 'x') ?? x0;
        const y = optNum(a.y, 'y') ?? y0;
        const r = Math.min(optNum(a.corner_radius, 'corner_radius') ?? 0, w / 2, hgt / 2);
        if (r > 0.01) {
          pts = [];
          const corner = (cx: number, cy: number, from: number) => {
            for (let k = 0; k <= 8; k++) {
              const t = ((from + (k / 8) * 90) * Math.PI) / 180;
              pts.push({ x: +(cx + Math.cos(t) * r).toFixed(4), y: +(cy + Math.sin(t) * r).toFixed(4) });
            }
          };
          corner(x + r, y + r, 180);
          corner(x + w - r, y + r, 270);
          corner(x + w - r, y + hgt - r, 0);
          corner(x + r, y + hgt - r, 90);
        } else pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + hgt }, { x, y: y + hgt }];
      }
      // Remove every board-level Edge.Cuts graphic, then draw the new outline.
      const ops: Op[] = [];
      for (const n of p.doc.nodes.values()) {
        if (!['line', 'arc', 'circle', 'polygon', 'rectangle'].includes(n.type)) continue;
        if (p.engine.get(n.uid, 'layer')?.value !== 'Edge.Cuts') continue;
        const parent = n.parent ? p.doc.nodes.get(n.parent) : undefined;
        if (parent?.type === 'element') continue; // cut-outs belonging to parts stay
        ops.push({ op: 'remove', uid: n.uid });
      }
      ops.push({ op: 'add', parent: board.uid, index: board.children.length, tree: { nodes: [{ uid: newUid('gr'), type: 'polygon', name: 'Board outline', props: {}, rules: [{ name: 'layer', value: 'Edge.Cuts' }, { name: 'points', value: pts }, { name: 'strokeWidth', value: 0.1 }], parent: board.uid, children: [] }] } });
      apply(p, 'Set board outline', ops);
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      const outside = [...p.doc.nodes.values()].filter((n) => n.type === 'element').filter((el) => {
        const q = vec(p.engine.get(el.uid, 'position')?.value);
        return q && (q.x < Math.min(...xs) || q.x > Math.max(...xs) || q.y < Math.min(...ys) || q.y > Math.max(...ys));
      }).length;
      return { outline: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), width: +(Math.max(...xs) - Math.min(...xs)).toFixed(3), height: +(Math.max(...ys) - Math.min(...ys)).toFixed(3) }, points: pts.length, partsOutside: outside };
    },
  },
  {
    name: 'auto_place',
    description: 'Move parts onto the board automatically: connected parts end up near each other, courtyards do not overlap. By default only parts that are not on the board yet (e.g. new parts parked beside it); `refs` to choose, `all` to re-place everything not locked. A starting point to refine.',
    mutates: true,
    input: { type: 'object', properties: { refs: { type: 'array', items: { type: 'string' } }, all: { type: 'boolean' }, spacing: { type: 'number', description: 'mm between parts (default 0.5)' } } },
    run: (p, a) => {
      const { ops, report } = planAutoplace(p.doc, p.engine, p.copper, { ...(Array.isArray(a.refs) ? { refs: a.refs.map(String) } : {}), ...(a.all ? { all: true } : {}), ...(a.spacing !== undefined ? { spacing: num(a.spacing, 'spacing') } : {}) });
      apply(p, 'Auto-place parts', ops);
      return report;
    },
  },
  {
    name: 'autoroute',
    description: 'Route unrouted connections automatically (grid maze router, 45° traces, through vias, each net\'s width and clearance kept, rip-up and retry when connections block each other). `nets` limits it to some nets, `layers` to some copper layers, `rounds` sets the rip-up rounds (1 = no rip-up). Layers have a preferred direction (rule routeDirection: top horizontal, next vertical; runs against it cost direction_cost times more, default 1.5), traces keep some air from other nets where there is room (proximity_cost), and connections are routed shortest first (rule autoPlacePriority first; order=difficulty puts fine-pitch pads and long connections first). Dense fine-pitch parts (QFN, QFP, TSSOP) are fanned out first: each pin leaves its pad row with a straight stub and routing starts at the stub\'s end (fanout=false turns it off). With plane_gap_cost (or rule planeGapCost on a net, e.g. high-speed) traces prefer to run over a pour on the neighbouring layer, not over gaps in it or over traces that cut it. Connections it cannot finish are listed with the reason; it never forces a route and never moves copper that was on the board before. Run refill_pours and run_drc afterwards. Tip: route GND/power with pours (pourLayers) and autoroute the rest.',
    mutates: true,
    input: { type: 'object', properties: { nets: { type: 'array', items: { type: 'string' } }, layers: { type: 'array', items: { type: 'string' }, description: 'Copper layers to route on (default: all)' }, grid: { type: 'number', description: 'Grid pitch mm (default from board size)' }, via_cost: { type: 'number', description: 'Via cost in grid steps for every net (default: rule viaCost, else 4 mm of trace)' }, rounds: { type: 'number', description: 'Rip-up and retry rounds (default 30; 1 = route once)' }, directions: { type: 'object', description: 'Preferred direction per copper layer, e.g. {"F.Cu":"horizontal","B.Cu":"vertical"} (default: rule routeDirection)' }, direction_cost: { type: 'number', description: 'Cost factor of a step against a layer direction (default 1.5; 1 = off)' }, proximity_cost: { type: 'number', description: 'Cost per step next to other nets (default 0.3; 0 = off)' }, order: { type: 'string', enum: ['difficulty', 'short'] }, fanout: { type: 'boolean', description: 'Fan out fine-pitch parts first with straight stubs (default true)' }, plane_gap_cost: { type: 'number', description: 'Cost per step over a gap in the pour on a neighbouring layer (default: rule planeGapCost, else 0 = off)' } } },
    run: (p, a) => {
      const { ops, report } = planAutoroute(p.doc, p.engine, p.copper, { ...(Array.isArray(a.nets) ? { nets: a.nets.map(String) } : {}), ...(Array.isArray(a.layers) ? { layers: a.layers.map(String) } : {}), ...(a.grid !== undefined ? { grid: num(a.grid, 'grid') } : {}), ...(a.via_cost !== undefined ? { viaCost: num(a.via_cost, 'via_cost') } : {}), ...(a.rounds !== undefined ? { rounds: Math.max(1, Math.round(num(a.rounds, 'rounds'))) } : {}),
        ...(a.directions && typeof a.directions === 'object' ? { directions: Object.fromEntries(Object.entries(a.directions as Record<string, unknown>).map(([k, v]) => [k, v === 'horizontal' || v === 'vertical' ? v : 'any'] as const)) } : {}),
        ...(a.direction_cost !== undefined ? { directionCost: Math.max(1, num(a.direction_cost, 'direction_cost')) } : {}),
        ...(a.proximity_cost !== undefined ? { proximityCost: Math.max(0, num(a.proximity_cost, 'proximity_cost')) } : {}),
        ...(a.order === 'short' || a.order === 'difficulty' ? { order: a.order } : {}),
        ...(a.fanout === false || a.fanout === 'false' ? { fanout: false } : {}),
        ...(a.plane_gap_cost !== undefined ? { planeGapCost: Math.max(0, num(a.plane_gap_cost, 'plane_gap_cost')) } : {}),
      });
      apply(p, 'Autoroute', ops);
      return { routed: report.routed.length, failed: report.failed, grid: report.grid, ms: report.ms, fanouts: report.fanouts ?? 0, bundled: report.bundled ?? 0, totalLength: +report.routed.reduce((s, r) => s + r.length, 0).toFixed(2), vias: report.routed.reduce((s, r) => s + r.vias, 0) };
    },
  },
  {
    name: 'get_stackup',
    description: 'The board stackup (copper, dielectric and mask layers with thickness, material, Er), and for each copper layer whether traces are microstrip or stripline.',
    mutates: false,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const st = stackupOf(p.doc, p.copper);
      return { ...st, custom: !!p.doc.meta.stackup, traces: p.copper.map((l) => ({ layer: l, ...lineGeometry(st, l) })) };
    },
  },
  {
    name: 'set_stackup',
    description: 'Set the stackup: either a preset (thickness in mm, flex=true for a polyimide flex build) for the current copper layers, or the full `layers` list [{name, kind: copper|dielectric|mask, thickness (mm), material, er, flex}]. Copper names must match the board layers.',
    mutates: true,
    input: { type: 'object', properties: { thickness: { type: 'number' }, flex: { type: 'boolean' }, layers: { type: 'array', items: { type: 'object' } } } },
    run: (p, a) => {
      let st: Stackup;
      if (Array.isArray(a.layers) && a.layers.length) {
        const layers = (a.layers as Record<string, unknown>[]).map((l) => ({ name: String(l.name), kind: (['copper', 'dielectric', 'mask'].includes(String(l.kind)) ? l.kind : 'dielectric') as 'copper', thickness: num(l.thickness, 'thickness'), ...(l.material ? { material: String(l.material) } : {}), ...(l.er !== undefined ? { er: num(l.er, 'er') } : {}), ...(l.flex ? { flex: true } : {}) }));
        const cuNames = layers.filter((l) => l.kind === 'copper').map((l) => l.name);
        const missing = p.copper.filter((c) => !cuNames.includes(c));
        if (missing.length) throw new ToolError(`The stackup is missing copper layers: ${missing.join(', ')}`);
        st = { layers, thickness: +layers.reduce((s, l) => s + l.thickness, 0).toFixed(3) };
      } else st = defaultStackup(p.copper, optNum(a.thickness, 'thickness') ?? 1.6, { flex: !!a.flex });
      apply(p, 'Set stackup', [{ op: 'setMeta', key: 'stackup', value: st }]);
      return st;
    },
  },
  {
    name: 'impedance',
    description: 'Controlled impedance from the stackup: give `width` (and `gap` for a differential pair) to get the impedance, or `target` ohms (and `gap`) to get the width. Closed-form estimates (±5–10 %); confirm with the fabricator for production.',
    mutates: false,
    input: { type: 'object', properties: { layer: { type: 'string', description: 'Copper layer, default F.Cu' }, width: { type: 'number' }, gap: { type: 'number' }, target: { type: 'number' } } },
    run: (p, a) => {
      const layer = typeof a.layer === 'string' && a.layer ? a.layer : p.copper[0]!;
      const g = lineGeometry(stackupOf(p.doc, p.copper), layer);
      if (!g) throw new ToolError(`No copper layer ${layer} in the stackup`);
      const gap = optNum(a.gap, 'gap');
      const target = optNum(a.target, 'target');
      if (target !== undefined) {
        const w = widthForImpedance(g, target, gap);
        return { layer, geometry: g, target, ...(gap !== undefined ? { gap } : {}), width: w, ...(w === null ? { note: 'Target is out of reach on this layer with this stackup' } : {}) };
      }
      const w = optNum(a.width, 'width') ?? 0.25;
      return { layer, geometry: g, width: w, z0: +impedance(g, w).toFixed(1), ...(gap !== undefined ? { gap, zdiff: +diffImpedance(g, w, gap).toFixed(1) } : {}) };
    },
  },
  {
    name: 'net_lengths',
    description: 'Routed length per net, differential pairs found by name (X_P/X_N, X+/X-, DP/DM) with their skew, and length-match groups (net property lengthGroup) with their spread.',
    mutates: false,
    input: { type: 'object', properties: { filter: { type: 'string' } } },
    run: (p, a) => {
      const all = netLengths(p.doc, p.engine);
      const f = typeof a.filter === 'string' ? a.filter.toLowerCase() : '';
      const cls = new Map(netSignals(p.doc).map((s) => [s.net, s.signal]));
      return { nets: all.filter((l) => !f || l.net.toLowerCase().includes(f)).filter((l) => l.segments).map((l) => ({ ...l, signal: cls.get(l.net) ?? 'general' })), pairs: diffPairs(all), groups: lengthGroups(all) };
    },
  },
  {
    name: 'classify_nets',
    description: `Signal class of every net (P16): ${SIGNAL_CLASSES.join(', ')}. A net takes the strictest class of its pins: a pin's \`signal\` property (set_pin_signal) or else a guess from pin, net and part names (CLK, XTAL, FB, SW/LX, RF/ANT, USB/ETH, X_P/X_N pairs, crystals, a converter's inductor). A class set by hand on the net wins. Lists each net with its class, source (net / pin / guess / default) and reason, for review. apply=true writes the classes onto the nets (property signal), so the default rulesets net[signal=…] set width, clearance, via cost, corner style and plane-gap cost for the autorouter; classes set by hand are kept.`,
    mutates: true,
    input: { type: 'object', properties: { apply: { type: 'boolean', description: 'Write the classes onto the nets (default false: only list them)' }, filter: { type: 'string' } } },
    run: (p, a) => {
      const all = netSignals(p.doc);
      const f = typeof a.filter === 'string' ? a.filter.toLowerCase() : '';
      const list = all.filter((s) => !f || s.net.toLowerCase().includes(f));
      if (a.apply === true) {
        const byName = new Map([...p.doc.nodes.values()].filter((n) => n.type === 'net').map((n) => [n.name, n]));
        const ops: Op[] = [];
        for (const s of list) {
          if (s.source === 'net') continue;
          const n = byName.get(s.net)!;
          const want = s.signal === 'general' ? null : s.signal;
          const wantSrc = want ? s.source : null;
          if ((n.props.signal ?? null) !== want) ops.push({ op: 'setProp', uid: n.uid, key: 'signal', value: want });
          if ((n.props.signalSource ?? null) !== wantSrc) ops.push({ op: 'setProp', uid: n.uid, key: 'signalSource', value: wantSrc });
        }
        if (ops.length) apply(p, 'Classify nets', ops);
      }
      const counts: Record<string, number> = {};
      for (const s of list) counts[s.signal] = (counts[s.signal] ?? 0) + 1;
      return { applied: a.apply === true, counts, nets: list };
    },
  },
  {
    name: 'set_pin_signal',
    description: `Set what a pin needs from the layout (P16): signal = ${SIGNAL_CLASSES.join(' | ')}, or "" to remove it. target = a part ("U1", every pin), a pin ("U1.12"), or a net with net=true (the net's class, set by hand, overrides its pins). Sets the board pad and the schematic pin. Then run classify_nets with apply=true.`,
    mutates: true,
    input: { type: 'object', properties: { target: { type: 'string' }, signal: { type: 'string', enum: [...SIGNAL_CLASSES, ''] }, net: { type: 'boolean', description: 'target is a net name' } }, required: ['target', 'signal'] },
    run: (p, a) => {
      const target = str(a.target, 'target');
      const sig = String(a.signal ?? '');
      if (sig && !isSignalClass(sig)) throw new ToolError(`Unknown signal class "${sig}"; use one of ${SIGNAL_CLASSES.join(', ')}`);
      const ops: Op[] = [];
      const hit: string[] = [];
      if (a.net === true) {
        const n = [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === target);
        if (!n) throw new ToolError(`No net ${target}`);
        ops.push({ op: 'setProp', uid: n.uid, key: 'signal', value: sig || null }, { op: 'setProp', uid: n.uid, key: 'signalSource', value: sig ? 'net' : null });
        hit.push(n.name);
      } else {
        const dot = target.lastIndexOf('.');
        const [ref, pin] = dot > 0 ? [target.slice(0, dot), target.slice(dot + 1)] : [target, undefined];
        for (const n of p.doc.nodes.values()) {
          if (n.type !== 'pad' && n.type !== 'pin') continue;
          const parent = n.parent ? p.doc.nodes.get(n.parent) : undefined;
          if (!parent || parent.name !== ref || (parent.type !== 'element' && parent.type !== 'symbol')) continue;
          const num = String(n.props.number ?? n.name);
          if (pin !== undefined && num !== pin) continue;
          ops.push({ op: 'setProp', uid: n.uid, key: 'signal', value: sig || null });
          hit.push(`${ref}.${num}${n.type === 'pin' ? ' (schematic)' : ''}`);
        }
        if (!ops.length) throw new ToolError(`No pin or pad matches "${target}"`);
      }
      apply(p, `Set signal ${target}`, ops);
      return { updated: hit, signal: sig || null, next: 'Run classify_nets with apply=true to update the nets.' };
    },
  },
  {
    name: 'tune_length',
    description: 'Lengthen a net with a serpentine on its longest straight trace: to `target` mm, or to match the net `match` (e.g. the other half of a differential pair). The change is undone automatically if it causes DRC errors.',
    mutates: true,
    input: { type: 'object', properties: { net: { type: 'string' }, target: { type: 'number' }, match: { type: 'string' }, amplitude: { type: 'number', description: 'Max bump height mm (default 1.5)' } }, required: ['net'] },
    run: (p, a) => {
      const net = str(a.net, 'net');
      const lens = netLengths(p.doc, p.engine);
      const cur = lens.find((l) => l.net === net);
      if (!cur) throw new ToolError(`No net ${net}`);
      const target = optNum(a.target, 'target') ?? (typeof a.match === 'string' ? lens.find((l) => l.net === a.match)?.length : undefined);
      if (target === undefined) throw new ToolError('Give `target` (mm) or `match` (a net name).');
      const before = runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
      for (const side of [1, -1] as const) {
        const plan = planMeander(p.doc, p.engine, net, target - cur.length, { side, ...(a.amplitude !== undefined ? { amplitude: num(a.amplitude, 'amplitude') } : {}) });
        if (plan.error) throw new ToolError(plan.error);
        apply(p, `Tune length ${net}`, plan.ops);
        const after = runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
        if (after <= before) return { net, before: cur.length, after: netLengths(p.doc, p.engine).find((l) => l.net === net)!.length, target };
        p.history.undo();
      }
      throw new ToolError('A serpentine here would break clearance on both sides; move nearby copper or tune a different segment by hand.');
    },
  },
  {
    name: 'delete',
    description: 'Delete objects: traces, vias, wires, labels, power symbols, parts (schematic symbols or board components), graphics, pours. `target` is a part ("R3"), a pin/pad is not deletable, a uid, a list of uids/refs separated by commas, or a selector ("net#GND > via", "trace[layer=B.Cu]"). purge_disabled=true removes every object whose `enabled` rule is false (leftovers from earlier edits). Structural objects (board, sheets, nets that still hold copper) are never deleted.',
    mutates: true,
    input: { type: 'object', properties: { target: TARGET, purge_disabled: { type: 'boolean' } } },
    run: (p, a) => {
      const DELETABLE = new Set(['trace', 'via', 'wire', 'label', 'junction', 'noconnect', 'symbol', 'element', 'text', 'line', 'circle', 'arc', 'polygon', 'rectangle', 'fill', 'zone', 'group']);
      let hits: DocNode[] = [];
      if (typeof a.target === 'string' && a.target.trim()) hits.push(...resolveTargets(p, a.target));
      if (a.purge_disabled) for (const n of p.doc.nodes.values()) if (p.engine.get(n.uid, 'enabled')?.value === false) hits.push(n);
      if (!hits.length) throw new ToolError(typeof a.target === 'string' ? `Nothing matches "${a.target}"` : 'Give `target` and/or purge_disabled=true.');
      const refused = hits.filter((n) => !DELETABLE.has(n.type) || (n.type === 'label' && n.parent && p.doc.nodes.get(n.parent)?.type === 'symbol'));
      hits = hits.filter((n) => !refused.includes(n));
      // Remove each subtree once: skip anything inside another selected object.
      const chosen = new Set(hits.map((n) => n.uid));
      const insideChosen = (n: DocNode) => {
        for (let q = n.parent ? p.doc.nodes.get(n.parent) : undefined; q; q = q.parent ? p.doc.nodes.get(q.parent) : undefined) if (chosen.has(q.uid)) return true;
        return false;
      };
      const top = [...new Map(hits.map((n) => [n.uid, n])).values()].filter((n) => !insideChosen(n));
      const byType: Record<string, number> = {};
      for (const n of top) byType[n.type] = (byType[n.type] ?? 0) + 1;
      apply(p, `Delete ${top.length} object(s)`, top.map((n) => ({ op: 'remove', uid: n.uid }) as Op));
      return { deleted: top.length, byType, ...(refused.length ? { notDeleted: [...new Set(refused.map((n) => n.type))].map((t) => `${t} (structural or part of a symbol)`) } : {}) };
    },
  },
  {
    name: 'refill_pours',
    description: 'Create pours requested by net rules (set pourLayers on a net, e.g. set_rule target "net#GND" rule pourLayers value "F.Cu B.Cu") and refill every copper pour.',
    mutates: true,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const plan = planPours(p.doc, p.engine, p.copper);
      apply(p, 'Plan pours', plan);
      const { ops, ms, pours } = refillOps(p.doc, p.engine, p.copper);
      apply(p, 'Refill pours', ops);
      return { pours, ms: Math.round(ms) };
    },
  },
  {
    name: 'export_fab',
    description: 'Generate fabrication files (Gerber RS-274X, Excellon drill, BOM, pick-and-place) as a ZIP at `out`.',
    mutates: false,
    input: { type: 'object', properties: { out: { type: 'string', description: 'Path of the .zip to write' } }, required: ['out'] },
    run: async (p, a, ctx) => {
      const r = buildFab(p.doc, p.engine, p.layers.map((l) => l.name), p.name);
      if (!ctx.writeFile) throw new ToolError('This host cannot write files.');
      const zip = fabZip(r);
      await ctx.writeFile(str(a.out, 'out'), zip);
      return { written: a.out, bytes: zip.length, files: r.files.map((f) => ({ name: f.name, bytes: f.data.length })), notes: r.notes };
    },
  },
  {
    name: 'export_kicad_schematic',
    description: 'Export the schematic as KiCad schematic files (.kicad_sch, KiCad 9 / 10), one per sheet, plus a .kicad_pro. out: path of the root .kicad_sch (the other sheets are written next to it) or of a .zip with all files. Symbols carry their drawing and pins in the file; power ports become power symbols.',
    mutates: false,
    input: { type: 'object', properties: { out: { type: 'string', description: 'Root .kicad_sch path, or a .zip' } }, required: ['out'] },
    run: async (p, a, ctx) => {
      if (!ctx.writeFile) throw new ToolError('This host cannot write files.');
      const out = str(a.out, 'out');
      const zipped = /\.zip$/i.test(out);
      if (!zipped && !/\.kicad_sch$/i.test(out)) throw new ToolError('out must end in .kicad_sch or .zip');
      const name = zipped ? (p.doc.meta.projectName ? String(p.doc.meta.projectName) : p.name.replace(/\.hpcb$/i, '')) : out.split(/[\\/]/).pop()!.replace(/\.kicad_sch$/i, '');
      const r = kicadSchematic(p.doc, p.engine, { project: name || 'design' });
      if (zipped) {
        await ctx.writeFile(out, zip(r.files.map((f) => ({ name: f.name, data: f.text }))));
        return { written: out, files: r.files.map((f) => f.name), symbols: r.symbols, sheets: r.sheets, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
      }
      const dir = out.slice(0, out.length - out.split(/[\\/]/).pop()!.length);
      const written: string[] = [];
      for (const f of r.files) {
        const path = f.name === r.root ? out : dir + f.name;
        await ctx.writeFile(path, f.text);
        written.push(path);
      }
      return { written, symbols: r.symbols, sheets: r.sheets, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
    },
  },
  {
    name: 'export_netlist',
    description: 'Export the schematic as a KiCad netlist (.net, S-expression), for KiCad\'s PCB editor (File → Import → Netlist). Components (all units together, power symbols left out) and nets with their pins. Generic footprints are mapped to KiCad library footprints where clear (map_footprints, default true); the result lists what was mapped and which footprints KiCad will not find by name.',
    mutates: false,
    input: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Path of the .net file to write' },
        map_footprints: { type: 'boolean', description: 'Map generic footprints (chip-0603 …) to KiCad library footprints (default true)' },
      },
      required: ['out'],
    },
    run: async (p, a, ctx) => {
      if (!ctx.writeFile) throw new ToolError('This host cannot write files.');
      const out = str(a.out, 'out');
      if (!/\.net$/i.test(out)) throw new ToolError('out must end in .net');
      const name = (p.doc.meta.projectName ? String(p.doc.meta.projectName) : p.name.replace(/\.hpcb$/i, '')) || 'design';
      const r = kicadNetlist(p.doc, p.engine, { source: `${name.replace(/[^\w.-]+/g, '_')}.kicad_sch`, mapFootprints: a.map_footprints !== false });
      await ctx.writeFile(out, r.text);
      return {
        written: out,
        components: r.components,
        nets: r.nets,
        ...(r.mapped.length ? { mapped: r.mapped } : {}),
        ...(r.unresolved.length ? { unresolved: r.unresolved, note: 'KiCad looks footprints up as Library:Name; these parts need a KiCad footprint before importing the netlist.' } : {}),
      };
    },
  },
  {
    name: 'export_schematic',
    description: 'Export the schematic as vector PDF (one page per sheet) or SVG. out: path ending in .pdf, .svg or .zip (SVG files of several sheets). sheet: one sheet (name or path; default all). theme: light (default, for printing), dark (as on screen) or mono (black and white). paper: auto (default: the sheet frame, or the drawing size) or A4…A0 to scale each sheet to that paper.',
    mutates: false,
    input: {
      type: 'object',
      properties: {
        out: { type: 'string', description: 'Path of the .pdf, .svg or .zip to write' },
        sheet: { type: 'string' },
        theme: { type: 'string', enum: ['light', 'dark', 'mono'] },
        paper: { type: 'string', description: 'auto, A4, A3, A2, A1 or A0' },
      },
      required: ['out'],
    },
    run: async (p, a, ctx) => {
      if (!ctx.writeFile) throw new ToolError('This host cannot write files.');
      const out = str(a.out, 'out');
      const theme = a.theme === undefined ? 'light' : String(a.theme);
      if (!['light', 'dark', 'mono'].includes(theme)) throw new ToolError('theme must be light, dark or mono');
      const opts = { theme: theme as 'light' | 'dark' | 'mono', ...(typeof a.paper === 'string' ? { paper: a.paper } : {}), ...(typeof a.sheet === 'string' ? { sheet: a.sheet } : {}) };
      const title = p.doc.meta.projectName ? String(p.doc.meta.projectName) : p.name.replace(/\.hpcb$/i, '');
      try {
        if (/\.pdf$/i.test(out)) {
          const pdf = schematicPdf(p.doc, p.engine, { ...opts, title });
          await ctx.writeFile(out, pdf);
          return { written: out, bytes: pdf.length, pages: exportSheets(p.doc, opts.sheet).length };
        }
        const svgs = schematicSvgs(p.doc, p.engine, opts);
        const base = (title || 'schematic').replace(/[^\w.-]+/g, '_');
        const fileOf = (_: unknown, i: number) => (svgs.length > 1 ? `${base}-${i + 1}.svg` : `${base}.svg`);
        if (/\.zip$/i.test(out)) {
          const data = zip(svgs.map((s, i) => ({ name: fileOf(s, i), data: s.svg })));
          await ctx.writeFile(out, data);
          return { written: out, bytes: data.length, files: svgs.map(fileOf) };
        }
        if (!/\.svg$/i.test(out)) throw new ToolError('out must end in .pdf, .svg or .zip');
        const written: string[] = [];
        for (const [i, s] of svgs.entries()) {
          const path = svgs.length === 1 ? out : out.replace(/\.svg$/i, `-${i + 1}.svg`);
          await ctx.writeFile(path, s.svg);
          written.push(path);
        }
        return { written };
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError((e as Error).message);
      }
    },
  },
  // ---------------------------------------------------------------- library & parts
  {
    name: 'search_parts',
    description: 'Search the part library: this project\'s parts, generic parametric parts (generic:resistor, generic:ic?pins=16…), and the installed KiCad symbol libraries when available. Returns ids for get_part / place_part.',
    mutates: false,
    input: { type: 'object', properties: { query: { type: 'string', description: 'Words to match, e.g. "ldo 3.3", "esp32-c3", "mosfet n-channel sot-23"' }, limit: { type: 'number' } }, required: ['query'] },
    run: async (p, a, ctx) => libOf(ctx).searchParts(p.doc, String(a.query ?? ''), optNum(a.limit, 'limit') ?? 20),
  },
  {
    name: 'get_part',
    description: 'Details of a part: pins per unit, default footprint, properties (MPN, datasheet) and supplier offers. id: a library id from search_parts, or the reference of a placed component (U1, R3) for the part behind it.',
    mutates: false,
    input: { type: 'object', properties: { id: { type: 'string', description: 'Library id (kicad:Lib:Name, generic:resistor …) or a component reference such as U1' } }, required: ['id'] },
    run: async (p, a, ctx) => {
      const id = str(a.id, 'id').trim();
      const lib = libOf(ctx);
      const pinText = (x: { number: string; name?: string; type: string }) => `${x.number}${x.name && x.name !== '~' ? ` ${x.name}` : ''} (${x.type})`;
      let part = await lib.getPart(p.doc, id);
      let placed: Record<string, unknown> | undefined;
      if (!part) {
        // A component reference: answer with the library part behind it, or with what the placed symbol holds.
        const syms = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && String(n.props.ref ?? '').toUpperCase() === id.toUpperCase());
        const elem = [...p.doc.nodes.values()].find((n) => n.type === 'element' && (n.props.ref === id || n.name === id));
        if (!syms.length && !elem) throw new ToolError(`No part or component "${id}". Use search_parts for library parts, or a component reference such as U1.`);
        const sp = syms[0]?.props ?? {};
        const ref = String(sp.ref ?? elem?.props.ref ?? elem?.name ?? id);
        const libId = typeof sp.libId === 'string' ? sp.libId : '';
        for (const c of [sp.partId, libId && `kicad:${libId}`, libId]) {
          if (typeof c === 'string' && c && !part) part = await lib.getPart(p.doc, c);
        }
        const footprint = String(sp.Footprint ?? elem?.props.Footprint ?? elem?.props.footprint ?? '') || undefined;
        const value = String(sp.Value ?? elem?.props.Value ?? elem?.props.value ?? '') || undefined;
        placed = { ref, ...(value ? { value } : {}), ...(footprint ? { footprint } : {}), ...(libId ? { libId } : {}) };
        if (!part) {
          const skip = new Set(['ref', 'Value', 'Footprint', 'libId', 'partId', 'unit', 'element']);
          const properties: Record<string, string> = {};
          for (const [k, v] of Object.entries(sp)) if (!skip.has(k) && (typeof v === 'string' || typeof v === 'number') && String(v) !== '') properties[k] = String(v);
          const units = [...syms]
            .sort((x, y) => Number(x.props.unit ?? 1) - Number(y.props.unit ?? 1))
            .map((s) => ({
              unit: Number(s.props.unit ?? 1),
              pins: s.children
                .map((c) => p.doc.nodes.get(c))
                .filter((n): n is DocNode => n?.type === 'pin')
                .map((n) => pinText({ number: String(n.props.number ?? n.name), name: String(n.props.pinName ?? ''), type: String(n.props.pinType ?? 'unspecified') })),
            }));
          return {
            placed,
            note: `${ref} has no library part in the available libraries${libId ? ` (its symbol is ${libId})` : ''}; these are the pins and properties of the placed symbol.`,
            name: libId.split(':').pop() || ref, value, footprint, properties, units,
          };
        }
      }
      return {
        ...(placed ? { placed } : {}),
        id: part.id, name: part.name, description: part.description, prefix: part.prefix, value: part.value, footprint: part.footprint, footprints: part.footprints, properties: part.properties, offers: part.offers,
        units: part.units.map((u, i) => ({ unit: i + 1, pins: u.pins.map(pinText) })),
      };
    },
  },
  {
    name: 'create_symbol',
    description: 'Create (or update) a symbol for a part that has no library symbol, from its pin table, e.g. pasted from the datasheet. pins: text with one pin per line ("number name type", tab / comma separated, a header line is fine), or pin_list: a list of {number, name, type, side, unit}. Types: input, output, bidirectional, passive, power_in, power_out, open_collector, no_connect … (datasheet words I, O, I/O, P, G, OD also work; missing types are guessed from the names). layout: auto (default: supplies top, grounds bottom, inputs left, outputs right), package (pin order around the package) or table (the side of each pin). power_unit=true puts the power pins in a unit of their own; a unit column (A, B …) splits gates. The part is stored in the project; place it with place_part using the returned id. Calling again with the same name updates the part and every placed copy.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        pins: { type: 'string', description: 'Pin table text, one pin per line' },
        pin_list: { type: 'array', items: { type: 'object' }, description: 'Instead of pins: a list of {number, name, type, side, unit}' },
        layout: { type: 'string', enum: ['auto', 'package', 'table'] },
        order: { type: 'string', enum: ['table', 'number', 'name'], description: 'Order of pins along a side (default: as in the table)' },
        power_unit: { type: 'boolean' },
        prefix: { type: 'string', description: 'Reference prefix, default U' },
        value: { type: 'string' },
        footprint: { type: 'string' },
        description: { type: 'string' },
        mpn: { type: 'string' },
      },
      required: ['name'],
    },
    run: (p, a) => {
      let rows: PinRow[];
      if (a.pins === undefined && Array.isArray(a.pin_list)) a = { ...a, pins: a.pin_list };
      let skipped: string[] = [];
      if (typeof a.pins === 'string') ({ rows, skipped } = parsePinTable(a.pins));
      else if (Array.isArray(a.pins))
        rows = a.pins.map((x, i) => {
          const o = (x ?? {}) as Record<string, unknown>;
          const number = String(o.number ?? '').trim();
          const name = String(o.name ?? number).trim();
          const side = o.side === undefined ? undefined : String(o.side);
          if (side !== undefined && !(PIN_SIDES as readonly string[]).includes(side)) throw new ToolError(`pins[${i}].side must be left, right, top or bottom`);
          const unit = o.unit === undefined ? undefined : /^(power|pwr)$/i.test(String(o.unit)) ? 0 : parseUnit(String(o.unit), 99);
          return { number, name, type: pinTypeFrom(String(o.type ?? ''), name), ...(side ? { side: side as PinSide } : {}), ...(unit !== undefined ? { unit } : {}) };
        });
      else throw new ToolError('pins must be a pin table (text) or a list of pins');
      const name = str(a.name, 'name');
      const id = `project:${name.trim().toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-+|-+$/g, '') || 'symbol'}`;
      const old = p.doc.meta[`part:${id}`] as ReturnType<typeof symbolPart> | undefined;
      let def: ReturnType<typeof symbolPart>;
      try {
        def = symbolPart({
          id,
          name,
          rows,
          options: { ...(typeof a.layout === 'string' ? { layout: a.layout as PinLayout } : {}), ...(typeof a.order === 'string' ? { order: a.order as PinOrder } : {}), ...(a.power_unit ? { powerUnit: true } : {}) },
          ...(typeof a.prefix === 'string' ? { prefix: a.prefix } : old ? { prefix: old.prefix } : {}),
          ...(typeof a.value === 'string' ? { value: a.value } : {}),
          ...(typeof a.footprint === 'string' ? { footprint: a.footprint } : old?.footprint ? { footprint: old.footprint } : {}),
          ...(typeof a.description === 'string' ? { description: a.description } : {}),
          ...(typeof a.mpn === 'string' ? { properties: { MPN: a.mpn } } : old?.properties ? { properties: old.properties } : {}),
          version: (old?.version ?? 0) + 1,
        });
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const upd = updatePlacedSymbolsOps(p.doc, p.engine, def);
      apply(p, old ? `Update symbol ${name}` : `Create symbol ${name}`, [{ op: 'setMeta', key: `part:${id}`, value: def }, ...upd.ops]);
      return {
        id,
        ...(old ? { updated: true, placedCopiesRedrawn: upd.updated } : {}),
        ...(upd.orphans.length ? { warning: `These placed units no longer exist in the symbol: ${upd.orphans.join(', ')}` } : {}),
        units: def.units.map((u, i) => ({ unit: unitLabel(def, i + 1), pins: u.pins.map((q) => `${q.number} ${q.name} (${q.type})`) })),
        ...(skipped.length ? { skippedLines: skipped.slice(0, 10) } : {}),
      };
    },
  },
  {
    name: 'switch_unit',
    description: 'Change which unit of a multi-unit part a placed symbol shows (e.g. turn U1 unit A into unit B, or into the power unit). The symbol keeps its place; its pins change, wires stay where they are. ref: the part; from: the placed unit to change (needed when several are placed); to: the new unit (letter or number). Units already placed cannot be chosen.',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['ref', 'to'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      const placed = placedUnits(p.doc, ref);
      if (!placed.size) throw new ToolError(`No part ${ref}`);
      const any = [...placed.values()][0]![0]!;
      const st = unitsOf(p.doc, any);
      if (!st) throw new ToolError(`${ref} is not a multi-unit part (or its part definition is not stored in the project)`);
      let sym: DocNode;
      if (a.from !== undefined) {
        const from = parseUnit(String(a.from), st.def.units.length);
        const hit = placed.get(from)?.[0];
        if (!hit) throw new ToolError(`Unit ${unitLetter(from)} of ${ref} is not placed. Placed: ${[...placed.keys()].map(unitLetter).join(', ')}`);
        sym = hit;
      } else {
        if (placed.size > 1) throw new ToolError(`${ref} has units ${[...placed.keys()].map(unitLetter).join(', ')} placed; say which one with from`);
        sym = any;
      }
      const to = parseUnit(String(a.to), st.def.units.length);
      try {
        apply(p, `Switch ${ref} to unit ${unitLetter(to)}`, switchUnitOps(p.doc, p.engine, sym.uid, to));
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      return unitReport(p, ref);
    },
  },
  {
    name: 'place_unit',
    description: 'Place a unit of a multi-unit part that is not placed yet (e.g. the power unit of an op-amp, or a spare gate), next to its other units or at x, y on a sheet. ERC reports units that were never placed.',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, unit: { type: 'string', description: 'Letter or number, e.g. "B" or "3"' }, x: { type: 'number' }, y: { type: 'number' }, sheet: { type: 'string' } }, required: ['ref', 'unit'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      const placed = placedUnits(p.doc, ref);
      const any = [...placed.values()][0]?.[0];
      if (!any) throw new ToolError(`No part ${ref}`);
      const st = unitsOf(p.doc, any);
      if (!st) throw new ToolError(`${ref} is not a multi-unit part (or its part definition is not stored in the project)`);
      const unit = parseUnit(String(a.unit), st.def.units.length);
      const sheet = a.sheet !== undefined ? sheetByName(p, a.sheet) : undefined;
      const x = optNum(a.x, 'x');
      const y = optNum(a.y, 'y');
      let r;
      try {
        r = placeUnitOps(p.doc, p.engine, ref, unit, sheet?.uid, x !== undefined && y !== undefined ? { x, y } : undefined);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      apply(p, `Place unit ${unitLetter(unit)} of ${ref}`, r.ops);
      const pins = p.doc.nodes.get(r.uid)!.children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type === 'pin').map((pin) => {
        const pt = pinPoint(p.doc, p.engine, pin)!;
        return { pin: `${ref}.${pin.props.number}`, name: pin.props.pinName, at: { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2) } };
      });
      return { ...unitReport(p, ref), pins };
    },
  },
  {
    name: 'search_footprints',
    description: 'Search footprints: generic parametric ones (chip-0603, sot-23-5, soic-8, tssop-20, qfn-32-5x5-p0.5-ep3.5, dip-8, header-1x04-p2.54, terminal-1x02-p5.08, hole-m3…), project footprints, and installed KiCad footprint libraries ("Lib:Name").',
    mutates: false,
    input: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    run: async (p, a, ctx) => libOf(ctx).searchFootprints(p.doc, String(a.query ?? ''), optNum(a.limit, 'limit') ?? 30),
  },
  {
    name: 'place_part',
    description: 'Place a library part (id from search_parts) on a schematic sheet. Multi-unit parts get every unit side by side, or only the units you list (units: "A" or "A,C"; place the rest later with place_unit, e.g. on another sheet). The part (and its footprint) is copied into the project. Then wire it and call update_pcb.',
    mutates: true,
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Part id, e.g. "kicad:Regulator_Linear:AMS1117-3.3" or "generic:capacitor?value=10u&package=chip-0805"' },
        x: { type: 'number' },
        y: { type: 'number' },
        value: { type: 'string' },
        ref: { type: 'string' },
        footprint: { type: 'string', description: 'Override the part\'s default footprint' },
        sheet: { type: 'string' },
        units: { type: 'string', description: 'Multi-unit parts: which units to place, e.g. "A" or "A,B" (default: all)' },
      },
      required: ['id', 'x', 'y'],
    },
    run: async (p, a, ctx) => {
      const lib = libOf(ctx);
      const part = await lib.getPart(p.doc, str(a.id, 'id'));
      if (!part) throw new ToolError(`No part "${a.id}". Use search_parts.`);
      const chosen = typeof a.footprint === 'string' && a.footprint.trim() ? a.footprint.trim() : part.footprint;
      const fp = chosen ? await lib.getFootprint(p.doc, chosen) : null;
      const use = chosen ? { ...part, footprint: chosen } : part;
      const ref = typeof a.ref === 'string' && a.ref.trim() ? a.ref.trim() : undefined;
      if (ref && resolveTargets(p, ref).length) throw new ToolError(`Reference ${ref} is already used`);
      const g = schematicGrid(p.doc).wire;
      const sheet = sheetByName(p, a.sheet);
      const placed = placePartOps(p.doc, sheet.uid, use, { x: Math.round(num(a.x, 'x') / g) * g, y: Math.round(num(a.y, 'y') / g) * g }, { ...(ref ? { ref } : {}), ...(typeof a.value === 'string' ? { value: a.value } : {}), ...(typeof a.units === 'string' && a.units.trim() ? { units: a.units.split(/[\s,]+/).filter(Boolean).map((x) => parseUnit(x, part.units.length)) } : {}) });
      apply(p, `Place ${part.name}`, [...storePartOps(p.doc, part, fp ? { ...fp, name: chosen! } : null), ...placed.ops]);
      const pins: { pin: string; name: unknown; at: Vec2 }[] = [];
      for (const uid of placed.uids) {
        for (const c of p.doc.nodes.get(uid)!.children) {
          const pin = p.doc.nodes.get(c)!;
          const pt = pinPoint(p.doc, p.engine, pin)!;
          pins.push({ pin: `${placed.ref}.${pin.props.number}`, name: pin.props.pinName, at: { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2) } });
        }
      }
      const unplaced = part.units.length > 1 ? part.units.map((_, i) => i + 1).filter((u) => !placed.uids.some((x) => Number(p.doc.nodes.get(x)!.props.unit) === u)).map((u) => unitLabel(part, u)) : [];
      return { ref: placed.ref, units: placed.uids.length, ...(unplaced.length ? { notPlacedYet: unplaced } : {}), footprint: chosen ?? null, footprintFound: !!fp, pins };
    },
  },
  {
    name: 'create_footprint',
    description: `Make a footprint from datasheet dimensions when search_footprints has none. family: two-row (SOIC / TSSOP / DIP / headers), four-side (QFP / QFN), grid (BGA / LGA), castellated (module with edge pads, ESP-12F style) or pads (a free list). Give the recommended land pattern (pad: {length, width} with rowSpacing / spanX = pad centre to pad centre across the package), or leads: {span, length, width, type: gullwing | nolead | jlead} from the package drawing and the pads are derived (margins toe / heel / side: gullwing 0.35/0.35/0.05, nolead 0.30/0/0, jlead 0.10/0.60/0.05 mm). drill (+ padDiameter) makes through-hole pins. ep: exposed pad {w, h, vias?}; holes: mounting holes [{x, y, drill, pad?}]; body: {w, h}. Pin 1 is top-left, numbering counter-clockwise (two-row: numbering around or zigzag for headers). The footprint is stored in the project; ref assigns it to a part.`,
    mutates: true,
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. qfn-24-4x4-ep2.6 or esp-12f' },
        family: { type: 'string', enum: ['two-row', 'four-side', 'grid', 'castellated', 'pads'] },
        pins: { type: 'number' },
        pitch: { type: 'number' },
        numbering: { type: 'string', enum: ['around', 'zigzag'] },
        rowSpacing: { type: 'number', description: 'two-row: pad centre to pad centre across the package' },
        spanX: { type: 'number', description: 'four-side: pad centre to pad centre, left to right' },
        spanY: { type: 'number', description: 'four-side: pad centre to pad centre, top to bottom (default spanX)' },
        pinsX: { type: 'number', description: 'four-side: pins on the left (and right) side, when the sides differ' },
        pad: { type: 'object', description: '{length, width, shape?} of one pad (length along the lead)' },
        leads: { type: 'object', description: '{span, length, width, type?} from the package drawing (maximum values)' },
        leadsY: { type: 'object', description: 'four-side: leads of the top / bottom sides when they differ' },
        drill: { type: 'number' },
        padDiameter: { type: 'number' },
        rows: { type: 'number' },
        cols: { type: 'number' },
        ball: { type: 'number', description: 'grid: pad diameter' },
        shape: { type: 'string', enum: ['circle', 'rect'] },
        skip: { type: 'array', items: { type: 'string' }, description: 'grid: positions without a ball, e.g. ["A1"]' },
        left: { type: 'number' },
        right: { type: 'number' },
        bottom: { type: 'number' },
        top: { type: 'number' },
        leftStart: { type: 'number', description: 'castellated: centre of pad 1 below the body top (default: column centred)' },
        bottomStart: { type: 'number', description: 'castellated: centre of the first bottom pad from the body left (default: row centred)' },
        outside: { type: 'number', description: 'castellated: how far each pad reaches beyond the body edge (default half its length)' },
        pads: { type: 'array', items: { type: 'object' }, description: 'pads family: [{number, x, y, w, h, shape?, drill?, rot?}]' },
        body: { type: 'object', description: '{w, h} package body' },
        ep: { type: 'object', description: 'exposed pad {w, h, x?, y?, number?, vias?: {drill, rows, cols, pitch}}' },
        holes: { type: 'array', items: { type: 'object' }, description: 'mounting holes [{x, y, drill, pad?}]' },
        courtyard: { type: 'number' },
        description: { type: 'string' },
        ref: { type: 'string', description: 'Assign the new footprint to this part' },
      },
      required: ['name', 'family'],
    },
    run: async (p, a, ctx) => {
      const { ref, ...params } = a;
      let fp: FootprintSpec;
      try {
        fp = generateFootprint(params as unknown as FootprintParams);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      if (genericFootprint(fp.name)) throw new ToolError(`"${fp.name}" is the name of a generic footprint; choose another name`);
      apply(p, `Footprint ${fp.name}`, [{ op: 'setMeta', key: fpKey(fp.name), value: fp }]);
      const out: Record<string, unknown> = {
        footprint: fp.name,
        description: fp.description,
        pads: fp.pads.filter((q) => q.number !== '').map((q) => `${q.number} @ ${q.at.x},${q.at.y} ${q.size.x}×${q.size.y}${q.drill !== undefined ? ` drill ${typeof q.drill === 'number' ? q.drill : `${q.drill.x}×${q.drill.y}`}` : ''}`),
      };
      if (typeof ref === 'string' && ref.trim()) out.assigned = await runTool(p, 'assign_footprint', { ref: ref.trim(), footprint: fp.name }, ctx);
      return out;
    },
  },
  {
    name: 'assign_footprint',
    description: 'Choose the footprint of a part (generic name like "chip-0805", a project footprint, or an installed KiCad "Lib:Name"). Updates the schematic and, unless update=false, rebuilds the board component in place.',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, footprint: { type: 'string' }, update: { type: 'boolean' } }, required: ['ref', 'footprint'] },
    run: async (p, a, ctx) => {
      const ref = str(a.ref, 'ref');
      const name = str(a.footprint, 'footprint');
      const fp = await libOf(ctx).getFootprint(p.doc, name);
      if (!fp) throw new ToolError(`Footprint "${name}" not found. Use search_footprints.`);
      const ops = setPartPropsOps(p.doc, ref, { Footprint: name });
      if (!ops.length && !resolveTargets(p, ref).length) throw new ToolError(`No part ${ref}`);
      if (fp.source !== 'generic' && !p.doc.meta[fpKey(name)]) ops.unshift({ op: 'setMeta', key: fpKey(name), value: { ...fp, name } });
      const hasSymbol = [...p.doc.nodes.values()].some((n) => n.type === 'symbol' && String(n.props.ref ?? n.name) === ref);
      apply(p, `Footprint ${ref} → ${name}`, ops.filter((o) => !(o.op === 'setProp' && p.doc.nodes.get(o.uid)?.type === 'element' && hasSymbol)));
      const out: Record<string, unknown> = { ref, footprint: name, pads: fp.pads.length };
      // Pin ↔ pad check (S20) right away, so a wrong footprint shows up before routing.
      const check = pinPadCheck(p.doc, { ref, resolve: (n) => (n === name ? fp : null) }).flatMap(describePinPad);
      out.pinPad = check.length ? check : 'every symbol pin has a pad and every pad a pin';
      if (a.update !== false && hasSymbol) out.update = await syncPcb(p, ctx);
      return out;
    },
  },
  {
    name: 'set_part_info',
    description: 'Set sourcing properties of a part on both schematic and board: mpn, manufacturer, datasheet, lcsc, value, dnp (do not populate), mechanical_pads (pads that need no pin, for the pin ↔ pad check). rename gives the part a new reference (schematic units and board component together).',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, mpn: { type: 'string' }, manufacturer: { type: 'string' }, datasheet: { type: 'string' }, lcsc: { type: 'string' }, value: { type: 'string' }, dnp: { type: 'boolean' }, rename: { type: 'string', description: 'New reference, e.g. R12' }, mechanical_pads: { type: 'string', description: 'Footprint pads that need no symbol pin (mounting tabs, unused exposed pad, no-connect pads), e.g. "MP1, MP2, 25"' } }, required: ['ref'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      const map: Record<string, string> = { mpn: 'MPN', manufacturer: 'Manufacturer', datasheet: 'Datasheet', lcsc: 'LCSC', value: 'Value', mechanical_pads: 'MechanicalPads' };
      const props: Record<string, string | null> = {};
      for (const [k, key] of Object.entries(map)) if (typeof a[k] === 'string') props[key] = (a[k] as string).trim() || null;
      const ops = setPartPropsOps(p.doc, ref, props);
      if (typeof a.dnp === 'boolean') for (const n of p.doc.nodes.values()) if ((n.type === 'symbol' && String(n.props.ref ?? n.name) === ref) || (n.type === 'element' && n.name === ref)) ops.push({ op: 'setProp', uid: n.uid, key: 'dnp', value: a.dnp || null });
      if (!resolveTargets(p, ref).length) throw new ToolError(`No part ${ref}`);
      if (typeof a.rename === 'string' && a.rename.trim() && a.rename.trim() !== ref) {
        try {
          ops.push(...renameRefOps(p.doc, ref, a.rename));
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
      }
      apply(p, `Part info ${ref}`, ops);
      return { ref: typeof a.rename === 'string' && a.rename.trim() ? a.rename.trim() : ref, set: props, ...(typeof a.dnp === 'boolean' ? { dnp: a.dnp } : {}) };
    },
  },
  {
    name: 'bom',
    description: 'Bill of materials grouped by MPN/value/footprint, priced for `boards` boards from the supplier offers stored in the project (cheapest offer with enough stock). Lists parts without MPN, without price data, or short on stock.',
    mutates: false,
    input: { type: 'object', properties: { boards: { type: 'number', description: 'How many boards to build (default 1)' } } },
    run: (p, a) => buildBom(p.doc, optNum(a.boards, 'boards') ?? 1),
  },
  {
    name: 'import_offers',
    description: 'Load supplier price/stock data from CSV (columns: MPN, Supplier, SKU, Stock, MOQ, Currency, URL and price columns like "Price@1", "Price@100", or a single "Price"). Matched by MPN to the project\'s parts. Give `file` (path) or `csv` (text).',
    mutates: true,
    input: { type: 'object', properties: { file: { type: 'string' }, csv: { type: 'string' } } },
    run: async (p, a, ctx) => {
      let text = typeof a.csv === 'string' ? a.csv : '';
      if (!text && typeof a.file === 'string') {
        if (!ctx.readFile) throw new ToolError('This host cannot read files; pass the CSV text as `csv`.');
        text = await ctx.readFile(a.file);
      }
      if (!text) throw new ToolError('Give `file` or `csv`.');
      const { ops, matched, unmatched } = applyOffersOps(p.doc, parseOffersCsv(text));
      apply(p, 'Import supplier offers', ops);
      return { matched, unmatched };
    },
  },
  {
    name: 'set_offer',
    description: 'Record one supplier offer for an MPN by hand: supplier, sku, stock, currency, prices as "qty:price" pairs, e.g. "1:0.12 100:0.05 1000:0.021".',
    mutates: true,
    input: { type: 'object', properties: { mpn: { type: 'string' }, supplier: { type: 'string' }, sku: { type: 'string' }, stock: { type: 'number' }, moq: { type: 'number' }, currency: { type: 'string' }, prices: { type: 'string' }, url: { type: 'string' } }, required: ['mpn', 'supplier', 'prices'] },
    run: (p, a) => {
      const offer: Offer = { supplier: str(a.supplier, 'supplier'), currency: typeof a.currency === 'string' && a.currency ? a.currency : 'USD', breaks: parsePrices(a.prices), updatedAt: new Date().toISOString().slice(0, 10) };
      if (typeof a.sku === 'string') offer.sku = a.sku;
      if (a.stock !== undefined) offer.stock = num(a.stock, 'stock');
      if (a.moq !== undefined) offer.moq = num(a.moq, 'moq');
      if (typeof a.url === 'string') offer.url = a.url;
      const mpn = str(a.mpn, 'mpn');
      const { ops, matched } = applyOffersOps(p.doc, new Map([[mpn, [offer]]]));
      if (!matched.length) throw new ToolError(`No part in the project has MPN ${mpn}; set it first with set_part_info.`);
      apply(p, `Offer ${mpn}`, ops);
      return { mpn, offer };
    },
  },
  {
    name: 'import_kicad_library',
    description: 'Copy parts from a KiCad symbol library (.kicad_sym) and/or footprints (.kicad_mod) into this project, so they can be placed with place_part / assign_footprint. `names` limits which symbols are taken.',
    mutates: true,
    input: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, names: { type: 'array', items: { type: 'string' } }, library: { type: 'string', description: 'Library name used in ids (default: file name)' } }, required: ['files'] },
    run: async (p, a, ctx) => {
      if (!ctx.readFile) throw new ToolError('This host cannot read files.');
      const files = (Array.isArray(a.files) ? a.files : [a.files]).map(String);
      const only = Array.isArray(a.names) && a.names.length ? new Set(a.names.map(String)) : undefined;
      const ops: Op[] = [];
      const parts: string[] = [];
      const footprints: string[] = [];
      const warnings: string[] = [];
      for (const f of files) {
        const text = await ctx.readFile(f);
        const base = f.split(/[\\/]/).pop()!;
        if (/\.kicad_sym$/i.test(f)) {
          const lib = typeof a.library === 'string' && a.library ? a.library : base.replace(/\.kicad_sym$/i, '');
          const r = parseKicadSymbolLib(text, lib, only);
          warnings.push(...r.warnings);
          for (const part of r.parts) {
            ops.push({ op: 'setMeta', key: `part:${part.id}`, value: { ...part, source: 'project' } });
            parts.push(part.id);
          }
        } else if (/\.kicad_mod$/i.test(f)) {
          const dir = f.split(/[\\/]/).slice(-2, -1)[0] ?? '';
          const lib = typeof a.library === 'string' && a.library ? a.library : dir.replace(/\.pretty$/i, '');
          const fp: FootprintSpec = parseKicadFootprint(text, lib);
          ops.push({ op: 'setMeta', key: fpKey(fp.name), value: { ...fp, source: 'project' } });
          footprints.push(fp.name);
        } else warnings.push(`Skipped ${base}: not a .kicad_sym or .kicad_mod file`);
      }
      apply(p, 'Import KiCad library', ops);
      return { parts, footprints, warnings };
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change made in this session (MCP/agent sessions; each CLI call is its own session).',
    mutates: true,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const e = p.history.undo();
      if (!e) throw new ToolError('Nothing to undo in this session.');
      return { undid: e.label };
    },
  },
  {
    name: 'redo',
    description: 'Redo the last undone change.',
    mutates: true,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const e = p.history.redo();
      if (!e) throw new ToolError('Nothing to redo.');
      return { redid: e.label };
    },
  },
  {
    name: 'apply_ops',
    description: 'Advanced: apply raw document operations (setRule, setProp, setName, add, remove, setRulesets, setData, setMeta) as one undoable step.',
    mutates: true,
    input: { type: 'object', properties: { label: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } }, required: ['ops'] },
    run: (p, a) => {
      if (!Array.isArray(a.ops) || !a.ops.length) throw new ToolError('"ops" must be a non-empty array');
      apply(p, typeof a.label === 'string' ? a.label : 'Apply ops', a.ops as Op[]);
      return { applied: a.ops.length };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Run a tool by name; errors come back as ToolError with a readable message. */
export async function runTool(p: Project, name: string, args: Record<string, unknown> = {}, ctx: ToolContext = {}): Promise<unknown> {
  const t = TOOL_MAP.get(name);
  if (!t) throw new ToolError(`Unknown tool "${name}". Tools: ${TOOLS.map((x) => x.name).join(', ')}`);
  for (const r of t.input.required ?? []) if (args[r] === undefined) throw new ToolError(`Missing "${r}" for ${name}`);
  try {
    return await t.run(p, args, ctx);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`${name} failed: ${(e as Error).message}`);
  }
}
