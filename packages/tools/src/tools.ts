/**
 * Tool definitions: one list, used by the CLI, the MCP server and the in-app agent.
 * Every write goes through the project's History (so it is undoable and, when the
 * project is live, shared with collaborators).
 */
import {
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
} from '@hassassin/core';
import { buildFab, fabZip } from '@hassassin/fab';
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
  return { changed: ops.length > 0, ...report, netsRenamed: report.netsRenamed.map(([a, b]) => `${a} → ${b}`) };
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
  p.history.apply(label, ops);
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
    throw new ToolError(`"${t}" is not a part, pin, uid or valid selector: ${(e as Error).message}`);
  }
}

function one(p: Project, target: string, type?: DocNode['type']): DocNode {
  const hits = resolveTargets(p, target).filter((n) => !type || n.type === type);
  if (!hits.length) throw new ToolError(`Nothing matches "${target}"${type ? ` (looking for a ${type})` : ''}`);
  return hits[0]!;
}

function pinOf(p: Project, ref: string): { pin: DocNode; at: Vec2; sheet: DocNode } {
  const pin = one(p, ref, 'pin');
  const at = pinPoint(p.doc, p.engine, pin);
  const sheet = sheetOf(p.doc, pin);
  if (!at || !sheet) throw new ToolError(`Pin ${ref} has no position`);
  return { pin, at, sheet };
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
    description: 'Find objects with a CSS-like selector. Types: element (PCB part), pad, trace, via, fill (pour), net, symbol, pin, wire, label, sheet. Examples: "element", "#U1", "net[netClass=ground]", "net#GND > trace", "symbol[Value^=10k]", "pad[net=GND]".',
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
    description: 'Electrical rule check of the schematic (unconnected pins, driver conflicts, undriven power, dangling wires/labels, duplicate references).',
    mutates: false,
    input: { type: 'object', properties: { limit: { type: 'number', description: 'Max violations listed (default 50)' } } },
    run: (p, a) => {
      const r = runErc(p.doc, p.engine);
      const limit = optNum(a.limit, 'limit') ?? 50;
      return { errors: r.violations.filter((v) => v.severity === 'error').length, warnings: r.violations.filter((v) => v.severity === 'warning').length, byKind: countBy(r.violations), violations: r.violations.slice(0, limit).map((v) => ({ kind: v.kind, severity: v.severity, message: v.message, at: v.at })) };
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
    description: `Place a schematic symbol. kind: ${PART_KINDS.map((k) => k.kind).join(', ')}. Positions are in mm on the sheet (grid 1.27 mm). Returns the new reference; then connect it with connect_pins / add_label and call update_pcb.`,
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
      },
      required: ['kind', 'x', 'y'],
    },
    run: (p, a) => {
      const kind = str(a.kind, 'kind') as PartKind;
      if (!PART_KINDS.some((k) => k.kind === kind)) throw new ToolError(`Unknown kind "${kind}"`);
      const sheet = sheetByName(p, a.sheet);
      const g = 1.27;
      const at = { x: Math.round(num(a.x, 'x') / g) * g, y: Math.round(num(a.y, 'y') / g) * g };
      const spec = makeSymbol(kind, { ...(a.pins ? { pins: num(a.pins, 'pins') } : {}), ...(typeof a.value === 'string' ? { value: a.value } : {}), ...(Array.isArray(a.pin_names) ? { pinNames: a.pin_names.map(String) } : {}) });
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
    description: 'Move, rotate or mirror a schematic symbol; wires on its pins follow (bent to stay at right angles), and short stubs to power symbols / labels move along with their symbols, so connections never break. Positions in mm on the 1.27 mm grid. mirror: "h" flips left↔right, "v" flips top↔bottom (toggles). unit selects one unit of a multi-unit part (default: all units move by the same offset).',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rotation: { type: 'number', description: 'degrees, counter-clockwise' }, mirror: { type: 'string', enum: ['h', 'v'] }, unit: { type: 'number' } }, required: ['ref'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      let syms = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && String(n.props.ref ?? n.name) === ref);
      if (a.unit !== undefined) syms = syms.filter((n) => Number(n.props.unit ?? 1) === num(a.unit, 'unit'));
      if (!syms.length) throw new ToolError(`No schematic symbol ${ref}${a.unit !== undefined ? ` unit ${a.unit}` : ''}`);
      const g = 1.27;
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
      apply(p, `Move ${ref}`, moveSymbolsOps(p.doc, p.engine, moves));
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
    description: 'Draw a schematic wire between two pins on the same sheet, e.g. from "R1.2" to "D1.2". This is the normal way to connect parts: wires make the schematic easy to read and trace. The wire bends once (L-shape) and avoids passing over other pins when it can; place parts so their connected pins are close and aligned. Use add_label only for long-distance or cross-sheet signals, and add_power for GND/supply rails.',
    mutates: true,
    input: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
    run: (p, a) => {
      const A = pinOf(p, str(a.from, 'from'));
      const B = pinOf(p, str(a.to, 'to'));
      if (A.sheet.uid !== B.sheet.uid) throw new ToolError('Pins are on different sheets; use add_label with the same net name on both.');
      const others: Vec2[] = [];
      for (const n of p.doc.nodes.values()) {
        if (n.type !== 'pin' || n.uid === A.pin.uid || n.uid === B.pin.uid || sheetOf(p.doc, n)?.uid !== A.sheet.uid) continue;
        const q = pinPoint(p.doc, p.engine, n);
        if (q) others.push(q);
      }
      const onSeg = (q: Vec2, s: Vec2, t: Vec2) => Math.abs(dist(s, q) + dist(q, t) - dist(s, t)) < 1e-3;
      const paths = [
        [A.at, { x: B.at.x, y: A.at.y }, B.at],
        [A.at, { x: A.at.x, y: B.at.y }, B.at],
      ];
      const collisions = (path: Vec2[]) => others.filter((q) => path.slice(1).some((t, i) => onSeg(q, path[i]!, t))).length;
      const path = paths.sort((x, y) => collisions(x) - collisions(y))[0]!;
      const hits = collisions(path);
      const ops: Op[] = [];
      for (let i = 0; i + 1 < path.length; i++) {
        if (dist(path[i]!, path[i + 1]!) < 1e-6) continue;
        ops.push({ op: 'add', parent: A.sheet.uid, index: A.sheet.children.length + i, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: path[i]! }, { name: 'end', value: path[i + 1]! }], parent: A.sheet.uid, children: [] }] } });
      }
      apply(p, 'Connect pins', ops);
      const net = extractNetlist(p.doc, p.engine).byPin.get(String(a.from));
      return { connected: [a.from, a.to], net, ...(hits ? { warning: `The wire passes over ${hits} other pin(s) and connects them too; consider labels instead.` } : {}) };
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
        if (out.y !== 0) {
          // Vertical pin: straight stub; if taken, jog sideways.
          const p1 = { x: P.at.x, y: P.at.y + out.y * g };
          path = k === 1 ? [P.at, p1] : [P.at, p1, { x: p1.x + (k - 1) * g, y: p1.y }];
        } else {
          // Horizontal pin: step out, then down (ground) or up (supply).
          const p1 = { x: P.at.x + out.x * g * k, y: P.at.y };
          path = [P.at, p1, { x: p1.x, y: p1.y + (down ? g : -g) }];
        }
        port = path[path.length - 1]!;
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
    name: 'add_label',
    description: 'Attach a net label to a pin (e.g. pin "U1.3", name "SDA"). Pins with the same local label on one sheet are connected; global=true connects across sheets. Use labels only for signals that travel far or between sheets/blocks; wire nearby pins with connect_pins, and use add_power (not labels) for GND and supply rails.',
    mutates: true,
    input: { type: 'object', properties: { pin: { type: 'string' }, name: { type: 'string' }, global: { type: 'boolean' } }, required: ['pin', 'name'] },
    run: (p, a) => {
      const P = pinOf(p, str(a.pin, 'pin'));
      const name = str(a.name, 'name');
      apply(p, 'Add label', [{ op: 'add', parent: P.sheet.uid, index: P.sheet.children.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name, props: { kind: a.global ? 'global' : 'local' }, rules: [{ name: 'position', value: P.at }, { name: 'rotation', value: 0 }], parent: P.sheet.uid, children: [] }] } }]);
      return { pin: a.pin, net: extractNetlist(p.doc, p.engine).byPin.get(String(a.pin)) };
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
    description: 'Route unrouted connections automatically (grid maze router, 45° traces, through vias, net clearances kept). `nets` limits it to some nets. Connections it cannot finish are listed; it never forces a route. Run refill_pours and run_drc afterwards. Tip: route GND/power with pours (pourLayers) and autoroute the rest.',
    mutates: true,
    input: { type: 'object', properties: { nets: { type: 'array', items: { type: 'string' } }, grid: { type: 'number', description: 'Grid pitch mm (default from board size)' }, via_cost: { type: 'number' } } },
    run: (p, a) => {
      const { ops, report } = planAutoroute(p.doc, p.engine, p.copper, { ...(Array.isArray(a.nets) ? { nets: a.nets.map(String) } : {}), ...(a.grid !== undefined ? { grid: num(a.grid, 'grid') } : {}), ...(a.via_cost !== undefined ? { viaCost: num(a.via_cost, 'via_cost') } : {}) });
      apply(p, 'Autoroute', ops);
      return { routed: report.routed.length, failed: report.failed, grid: report.grid, ms: report.ms, totalLength: +report.routed.reduce((s, r) => s + r.length, 0).toFixed(2), vias: report.routed.reduce((s, r) => s + r.vias, 0) };
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
      return { nets: all.filter((l) => !f || l.net.toLowerCase().includes(f)).filter((l) => l.segments), pairs: diffPairs(all), groups: lengthGroups(all) };
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
    description: 'Details of a library part: pins per unit, default footprint, properties (MPN, datasheet) and supplier offers.',
    mutates: false,
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (p, a, ctx) => {
      const part = await libOf(ctx).getPart(p.doc, str(a.id, 'id'));
      if (!part) throw new ToolError(`No part "${a.id}". Use search_parts.`);
      return {
        id: part.id, name: part.name, description: part.description, prefix: part.prefix, value: part.value, footprint: part.footprint, footprints: part.footprints, properties: part.properties, offers: part.offers,
        units: part.units.map((u, i) => ({ unit: i + 1, pins: u.pins.map((x) => `${x.number}${x.name && x.name !== '~' ? ` ${x.name}` : ''} (${x.type})`) })),
      };
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
    description: 'Place a library part (id from search_parts) on a schematic sheet. Multi-unit parts get every unit, side by side. The part (and its footprint) is copied into the project. Then wire it and call update_pcb.',
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
      const g = 1.27;
      const sheet = sheetByName(p, a.sheet);
      const placed = placePartOps(p.doc, sheet.uid, use, { x: Math.round(num(a.x, 'x') / g) * g, y: Math.round(num(a.y, 'y') / g) * g }, { ...(ref ? { ref } : {}), ...(typeof a.value === 'string' ? { value: a.value } : {}) });
      apply(p, `Place ${part.name}`, [...storePartOps(p.doc, part, fp ? { ...fp, name: chosen! } : null), ...placed.ops]);
      const pins: { pin: string; name: unknown; at: Vec2 }[] = [];
      for (const uid of placed.uids) {
        for (const c of p.doc.nodes.get(uid)!.children) {
          const pin = p.doc.nodes.get(c)!;
          const pt = pinPoint(p.doc, p.engine, pin)!;
          pins.push({ pin: `${placed.ref}.${pin.props.number}`, name: pin.props.pinName, at: { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2) } });
        }
      }
      return { ref: placed.ref, units: placed.uids.length, footprint: chosen ?? null, footprintFound: !!fp, pins };
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
      if (a.update !== false && hasSymbol) out.update = await syncPcb(p, ctx);
      return out;
    },
  },
  {
    name: 'set_part_info',
    description: 'Set sourcing properties of a part on both schematic and board: mpn, manufacturer, datasheet, lcsc, value, dnp (do not populate).',
    mutates: true,
    input: { type: 'object', properties: { ref: { type: 'string' }, mpn: { type: 'string' }, manufacturer: { type: 'string' }, datasheet: { type: 'string' }, lcsc: { type: 'string' }, value: { type: 'string' }, dnp: { type: 'boolean' } }, required: ['ref'] },
    run: (p, a) => {
      const ref = str(a.ref, 'ref');
      const map: Record<string, string> = { mpn: 'MPN', manufacturer: 'Manufacturer', datasheet: 'Datasheet', lcsc: 'LCSC', value: 'Value' };
      const props: Record<string, string | null> = {};
      for (const [k, key] of Object.entries(map)) if (typeof a[k] === 'string') props[key] = (a[k] as string).trim() || null;
      const ops = setPartPropsOps(p.doc, ref, props);
      if (typeof a.dnp === 'boolean') for (const n of p.doc.nodes.values()) if ((n.type === 'symbol' && String(n.props.ref ?? n.name) === ref) || (n.type === 'element' && n.name === ref)) ops.push({ op: 'setProp', uid: n.uid, key: 'dnp', value: a.dnp || null });
      if (!resolveTargets(p, ref).length) throw new ToolError(`No part ${ref}`);
      apply(p, `Part info ${ref}`, ops);
      return { ref, set: props, ...(typeof a.dnp === 'boolean' ? { dnp: a.dnp } : {}) };
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
