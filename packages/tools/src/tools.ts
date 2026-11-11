/**
 * Tool definitions: one list, used by the CLI, the MCP server and the in-app agent.
 * Every write goes through the project's History (so it is undoable and, when the
 * project is live, shared with collaborators).
 */
import {
  addSymbolOp,
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

export interface ToolContext {
  writeFile?: (path: string, data: Uint8Array | string) => Promise<void> | void;
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
  const byUid = p.doc.nodes.get(t);
  if (byUid) return [byUid];
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
    name: 'connect_pins',
    description: 'Draw a schematic wire between two pins on the same sheet, e.g. from "R1.2" to "D1.2". The wire bends once (L-shape) and avoids passing over other pins when it can. For pins far apart or on different sheets prefer add_label with the same name on both.',
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
    name: 'add_label',
    description: 'Attach a net label to a pin (e.g. pin "U1.3", name "VCC"). Pins with the same local label on one sheet are connected; global=true connects across sheets (use for power nets like GND, 3V3).',
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
    description: 'Push schematic connectivity into the board: pad nets, net renames (routed copper follows), new parts get placeholder footprints next to the board. Board-only parts are kept.',
    mutates: true,
    input: { type: 'object', properties: {} },
    run: (p) => {
      const { ops, report } = planSync(p.doc, p.engine, extractNetlist(p.doc, p.engine));
      apply(p, 'Update PCB from schematic', ops);
      return { changed: ops.length > 0, ...report, netsRenamed: report.netsRenamed.map(([a, b]) => `${a} → ${b}`) };
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
