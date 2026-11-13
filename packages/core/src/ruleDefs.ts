/**
 * Registry of every layout rule: its value kind, whether it inherits from the parent,
 * and how to parse/format it. Names, labels and the set of rules are our own design.
 */
import type { KeepOut, RuleValue, Vec2 } from './model.ts';
import { formatAngle, formatLength, parseAngle, parseLength, trimNumber } from './units.ts';

export type RuleKind =
  | 'length'
  | 'angle'
  | 'number'
  | 'bool'
  | 'enum'
  | 'string'
  | 'vec2'
  | 'size'
  | 'points'
  | 'layers'
  | 'keepout'
  | 'lengthList';

export interface RuleDef {
  name: string;
  label: string;
  kind: RuleKind;
  inheritable: boolean;
  options?: readonly string[];
  help: string;
}

const defs: RuleDef[] = [
  { name: 'enabled', label: 'Enabled', kind: 'bool', inheritable: false, help: 'Whether the object takes part in the board.' },
  { name: 'visible', label: 'Visible', kind: 'bool', inheritable: true, help: 'Draw the object on the canvas.' },
  { name: 'displayUnit', label: 'Display unit', kind: 'enum', inheritable: true, options: ['mm', 'mil', 'in', 'um'], help: 'Unit used to show lengths.' },
  { name: 'position', label: 'Position', kind: 'vec2', inheritable: false, help: 'Location of the object origin.' },
  { name: 'rotation', label: 'Rotation', kind: 'angle', inheritable: false, help: 'Rotation around the origin.' },
  { name: 'side', label: 'Side', kind: 'enum', inheritable: true, options: ['top', 'bottom'], help: 'Board side a component sits on.' },
  { name: 'layer', label: 'Layer', kind: 'string', inheritable: false, help: 'Layer the object is drawn on.' },
  { name: 'layers', label: 'Layers', kind: 'layers', inheritable: false, help: 'Layers a pad, via or zone spans.' },
  { name: 'size', label: 'Size', kind: 'size', inheritable: false, help: 'Width and height.' },
  { name: 'start', label: 'Start', kind: 'vec2', inheritable: false, help: 'First end point.' },
  { name: 'end', label: 'End', kind: 'vec2', inheritable: false, help: 'Second end point.' },
  { name: 'mid', label: 'Mid point', kind: 'vec2', inheritable: false, help: 'A point on an arc between start and end.' },
  { name: 'center', label: 'Center', kind: 'vec2', inheritable: false, help: 'Circle center.' },
  { name: 'radius', label: 'Radius', kind: 'length', inheritable: false, help: 'Circle radius.' },
  { name: 'points', label: 'Outline', kind: 'points', inheritable: false, help: 'Polygon outline points.' },
  { name: 'strokeWidth', label: 'Stroke width', kind: 'length', inheritable: true, help: 'Line thickness for graphics.' },
  { name: 'filled', label: 'Filled', kind: 'bool', inheritable: false, help: 'Fill closed graphic shapes.' },
  { name: 'traceWidth', label: 'Trace width', kind: 'length', inheritable: true, help: 'Copper width of traces.' },
  { name: 'traceWidthMin', label: 'Trace width minimum', kind: 'length', inheritable: true, help: 'Narrowest allowed trace.' },
  { name: 'preferredWidths', label: 'Preferred trace widths', kind: 'lengthList', inheritable: true, help: 'Widths offered while routing.' },
  { name: 'keepOut', label: 'Keep out', kind: 'keepout', inheritable: false, help: 'Clearance to other copper; per-type values like "0.2mm fill(0.5mm)".' },
  { name: 'padShape', label: 'Pad shape', kind: 'enum', inheritable: true, options: ['circle', 'rect', 'roundrect', 'oval', 'trapezoid', 'chamfered', 'custom'], help: 'Copper shape of pads.' },
  { name: 'padType', label: 'Pad type', kind: 'enum', inheritable: false, options: ['smd', 'through', 'npth', 'edge'], help: 'Surface mount, plated through hole, or unplated hole.' },
  { name: 'cornerRatio', label: 'Corner ratio', kind: 'number', inheritable: true, help: 'Rounded-rectangle corner radius as a fraction of the short side.' },
  { name: 'holeSize', label: 'Hole size', kind: 'size', inheritable: false, help: 'Drill diameter (or slot size).' },
  { name: 'holeSizeMin', label: 'Hole size minimum', kind: 'length', inheritable: true, help: 'Smallest allowed drill.' },
  { name: 'viaDiameter', label: 'Via diameter', kind: 'length', inheritable: true, help: 'Copper diameter of vias.' },
  { name: 'viaHole', label: 'Via hole', kind: 'length', inheritable: true, help: 'Drill diameter of vias.' },
  { name: 'viaKind', label: 'Via kind', kind: 'enum', inheritable: true, options: ['through', 'blind', 'buried', 'micro'], help: 'Which layers a via may connect.' },
  { name: 'pourLayers', label: 'Pour layers', kind: 'layers', inheritable: false, help: 'Layers where this net gets a copper pour.' },
  { name: 'thermalRelief', label: 'Thermal relief', kind: 'enum', inheritable: true, options: ['spokes', 'solid', 'none'], help: 'How pads join a pour.' },
  { name: 'thermalSpokeWidth', label: 'Thermal spoke width', kind: 'length', inheritable: true, help: 'Width of relief spokes.' },
  { name: 'stitchSpacing', label: 'Stitching via spacing', kind: 'length', inheritable: true, help: 'Grid pitch for stitching vias in a pour (0 = off).' },
  { name: 'text', label: 'Text', kind: 'string', inheritable: false, help: 'Text content.' },
  { name: 'fontSize', label: 'Font size', kind: 'length', inheritable: true, help: 'Text height.' },
  { name: 'boardEdgeClearance', label: 'Board edge clearance', kind: 'length', inheritable: true, help: 'Keep copper this far from the board edge.' },
  { name: 'gridSpacing', label: 'Grid spacing', kind: 'length', inheritable: true, help: 'Canvas grid pitch.' },
  { name: 'mirror', label: 'Mirror', kind: 'enum', inheritable: false, options: ['none', 'x', 'y'], help: 'Mirror a schematic symbol about its X or Y axis.' },
  { name: 'pinLength', label: 'Pin length', kind: 'length', inheritable: false, help: 'Length of a schematic pin line.' },
  { name: 'autoPlacePriority', label: 'Auto-place priority', kind: 'number', inheritable: true, help: 'Higher numbers get placed or routed first.' },
  { name: 'cornerStyle', label: 'Corner style', kind: 'enum', inheritable: true, options: ['45', 'arc', '90'], help: 'How routed traces turn: 45 = two 45° bends instead of a right angle, arc = rounded, 90 = right angles allowed. Never acute.' },
  { name: 'planeGapCost', label: 'Plane gap cost', kind: 'number', inheritable: true, help: 'Autorouter: extra cost per grid step of running where the neighbouring copper layer has no pour under the trace, or the pour is cut by a trace (default 0 = off). Higher for nets that need a solid return path (high-speed, RF).' },
  { name: 'routeDirection', label: 'Route direction', kind: 'enum', inheritable: true, options: ['alternate', 'alternate-v', 'any'], help: 'Autorouter: preferred direction per copper layer. alternate (default) = top layer horizontal, the next vertical, and so on; alternate-v = top vertical; any = no preference. Runs against a layer\'s direction cost more.' },
  { name: 'viaCost', label: 'Via cost', kind: 'length', inheritable: true, help: 'Autorouter: a via costs as much as this length of trace (default 4 mm).' },
  { name: 'cornerSetback', label: 'Corner setback', kind: 'length', inheritable: true, help: 'How far before a corner its 45° piece or arc starts (default: 2 × trace width).' },
  { name: 'classClearance', label: 'Clearance to signal classes', kind: 'keepout', inheritable: true, help: 'Autorouter: clearance from nets of the named signal classes, e.g. "analog(1mm) sensitive(1mm)" on switching nets (write high-speed as highspeed). Counts both ways; the larger value wins.' },
  { name: 'diffImpedance', label: 'Differential impedance', kind: 'number', inheritable: true, help: 'Target differential impedance (ohm) of a pair this net belongs to (P10). classify_nets sizes the pair\'s width and gap from it on the outer layer; an interface preset (set_pin_signal interface) gives one too.' },
  { name: 'diffGap', label: 'Pair gap', kind: 'length', inheritable: true, help: 'Edge-to-edge gap between the two traces of a differential pair (P10).' },
];

export const RULE_DEFS: ReadonlyMap<string, RuleDef> = new Map(defs.map((d) => [d.name, d]));

export function ruleDef(name: string): RuleDef | undefined {
  return RULE_DEFS.get(name);
}

const splitTopLevel = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);

function parseVec2(s: string, kind: 'vec2' | 'size'): Vec2 | number | null {
  const parts = splitTopLevel(s);
  if (kind === 'size' && parts.length === 1) return parseLength(parts[0]!);
  if (parts.length !== 2) return null;
  const x = parseLength(parts[0]!);
  const y = parseLength(parts[1]!);
  return x === null || y === null ? null : { x, y };
}

export function parseKeepOut(s: string): KeepOut | null {
  const out: KeepOut = { byType: {} };
  const re = /([a-zA-Z]+)\(([^)]*)\)|([^\s()]+)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(s))) {
    if (m[1]) {
      const v = parseLength(m[2]!.trim());
      if (v === null) return null;
      out.byType[m[1]] = v;
    } else if (m[3]) {
      const v = parseLength(m[3]);
      if (v === null) return null;
      out.all = v;
    }
    any = true;
  }
  return any ? out : null;
}

/** Parse user text into a typed value for the rule. Throws with a readable message. */
export function parseRuleValue(name: string, input: string | RuleValue): RuleValue {
  if (typeof input !== 'string') return input;
  const def = RULE_DEFS.get(name);
  const s = input.trim();
  const fail = (): never => {
    throw new Error(`"${input}" is not a valid value for ${def?.label ?? name}`);
  };
  if (!def) return s;
  switch (def.kind) {
    case 'length':
      return parseLength(s) ?? fail();
    case 'angle':
      return parseAngle(s) ?? fail();
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? n : fail();
    }
    case 'bool':
      if (/^(true|yes|on|1)$/i.test(s)) return true;
      if (/^(false|no|off|0)$/i.test(s)) return false;
      return fail();
    case 'enum':
      return def.options?.includes(s) ? s : fail();
    case 'string':
      return s;
    case 'vec2':
    case 'size':
      return parseVec2(s, def.kind) ?? fail();
    case 'layers':
      return s.toLowerCase() === 'all' ? ['*'] : splitTopLevel(s);
    case 'lengthList': {
      const vals = splitTopLevel(s).map((p) => parseLength(p));
      return vals.every((v): v is number => v !== null) ? (vals.map((v) => ({ x: v, y: 0 })) as Vec2[]) : fail();
    }
    case 'keepout':
      return parseKeepOut(s) ?? fail();
    case 'points':
      return parsePoints(s) ?? fail();
  }
}

/**
 * A point list: JSON ([{"x":1,"y":2},…] or [[1,2],…]) or plain text such as
 * "89 80.5, 161 80.5, 161 159.5" / "(89,80.5) (161,80.5) …" / "89mm 80.5mm; …".
 * Coordinates take units (default mm). At least three points.
 */
export function parsePoints(s: string): Vec2[] | null {
  let pts: Vec2[] | null = null;
  if (/^\s*\[/.test(s)) {
    try {
      const j = JSON.parse(s) as unknown[];
      pts = j.map((q) => (Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]) } : { x: Number((q as Vec2).x), y: Number((q as Vec2).y) }));
    } catch {
      pts = null;
    }
  } else {
    const toks = [...s.matchAll(/-?\d+(?:\.\d+)?\s*(?:mm|mil|in|um|cm)?/gi)].map((m) => parseLength(m[0].replace(/\s+/g, '')));
    if (toks.length % 2 === 0 && toks.every((t) => t !== null)) {
      pts = [];
      for (let i = 0; i < toks.length; i += 2) pts.push({ x: toks[i]!, y: toks[i + 1]! });
    }
  }
  return pts && pts.length >= 3 && pts.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) ? pts : null;
}

const isVec2 = (v: unknown): v is Vec2 => typeof v === 'object' && v !== null && 'x' in v && 'y' in v;

export function formatRuleValue(name: string, value: RuleValue, unit = 'mm'): string {
  const def = RULE_DEFS.get(name);
  const L = (n: number) => formatLength(n, unit);
  if (!def) return typeof value === 'object' ? JSON.stringify(value) : String(value);
  switch (def.kind) {
    case 'length':
      return typeof value === 'number' ? L(value) : String(value);
    case 'angle':
      return typeof value === 'number' ? formatAngle(value) : String(value);
    case 'number':
      return typeof value === 'number' ? trimNumber(value) : String(value);
    case 'vec2':
    case 'size':
      if (typeof value === 'number') return L(value);
      return isVec2(value) ? `${L(value.x)} ${L(value.y)}` : String(value);
    case 'layers':
      return Array.isArray(value) ? ((value as string[])[0] === '*' ? 'All' : (value as string[]).join(', ')) : String(value);
    case 'lengthList':
      return Array.isArray(value) ? (value as Vec2[]).map((v) => L(v.x)).join(', ') : String(value);
    case 'points':
      return Array.isArray(value) ? `${value.length} points` : String(value);
    case 'keepout': {
      const k = value as KeepOut;
      const parts: string[] = [];
      if (k.all !== undefined) parts.push(L(k.all));
      for (const [t, v] of Object.entries(k.byType ?? {})) parts.push(`${t}(${L(v)})`);
      return parts.join(' ');
    }
    default:
      return String(value);
  }
}
