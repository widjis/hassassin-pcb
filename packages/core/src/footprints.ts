/**
 * Footprints as plain data (FootprintSpec), parametric generators for common packages,
 * and conversion into document nodes. Land-pattern dimensions here are our own
 * nominal values (round numbers close to common industry practice), not copied tables.
 * Coordinates are footprint-local millimetres, Y down.
 */
import type { DocNode, RuleDecl, Vec2 } from './model.ts';
import { newUid } from './model.ts';

export type PadShape = 'rect' | 'roundrect' | 'circle' | 'oval' | 'trapezoid' | 'custom';
export type PadKind = 'smd' | 'through' | 'npth' | 'edge';

export interface FpPad {
  number: string;
  at: Vec2;
  rot?: number;
  size: Vec2;
  shape: PadShape;
  type: PadKind;
  /** Layer names; "*.Cu" / "*.Mask" / "*.Paste" are expanded when placed. */
  layers: string[];
  drill?: number | Vec2;
  cornerRatio?: number;
  points?: Vec2[];
}

export type FpGraphic =
  | { kind: 'line'; layer: string; w: number; a: Vec2; b: Vec2 }
  | { kind: 'rect'; layer: string; w: number; a: Vec2; b: Vec2; fill?: boolean }
  | { kind: 'circle'; layer: string; w: number; c: Vec2; r: number; fill?: boolean }
  | { kind: 'arc'; layer: string; w: number; s: Vec2; m: Vec2; e: Vec2 }
  | { kind: 'poly'; layer: string; w: number; pts: Vec2[]; fill?: boolean }
  | { kind: 'text'; layer: string; at: Vec2; text: string; size: number; rot?: number; hidden?: boolean };

export interface FootprintSpec {
  name: string;
  description?: string;
  tags?: string[];
  pads: FpPad[];
  graphics: FpGraphic[];
  /** Where it came from: "generic", "kicad:<lib>", "project". */
  source?: string;
  /** Parameters it was generated from (footprint generator), for editing. */
  generator?: unknown;
}

const SMD_TOP = ['F.Cu', 'F.Paste', 'F.Mask'];
const THT = ['*.Cu', '*.Mask'];
const SILK = 0.12;
const CRT = 0.05;

function bbox(pads: FpPad[], extra: Vec2[] = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const p of pads) {
    const r = ((p.rot ?? 0) % 180) !== 0;
    const w = (r ? p.size.y : p.size.x) / 2;
    const h = (r ? p.size.x : p.size.y) / 2;
    add(p.at.x - w, p.at.y - h);
    add(p.at.x + w, p.at.y + h);
  }
  for (const e of extra) add(e.x, e.y);
  if (!Number.isFinite(minX)) return { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 };
  return { minX, minY, maxX, maxY };
}

const r2 = (n: number) => Math.round(n * 1000) / 1000;

/** Body outline on silk + fab, courtyard around everything, reference text above. */
function finish(name: string, description: string, pads: FpPad[], body: { w: number; h: number }, opts: { pin1?: Vec2; tags?: string[]; courtyard?: number } = {}): FootprintSpec {
  const bw = body.w / 2;
  const bh = body.h / 2;
  const b = bbox(pads, [{ x: -bw, y: -bh }, { x: bw, y: bh }]);
  const m = opts.courtyard ?? 0.25;
  const g: FpGraphic[] = [
    { kind: 'rect', layer: 'F.Fab', w: 0.1, a: { x: -bw, y: -bh }, b: { x: bw, y: bh } },
    { kind: 'rect', layer: 'F.CrtYd', w: CRT, a: { x: r2(b.minX - m), y: r2(b.minY - m) }, b: { x: r2(b.maxX + m), y: r2(b.maxY + m) } },
    { kind: 'text', layer: 'F.SilkS', at: { x: 0, y: r2(b.minY - 1) }, text: '%R', size: 1 },
    { kind: 'text', layer: 'F.Fab', at: { x: 0, y: r2(b.maxY + 1) }, text: '%V', size: 1, hidden: true },
  ];
  // Silk: body edges that do not run through copper.
  const padHit = (x: number, y: number) =>
    pads.some((p) => Math.abs(x - p.at.x) < p.size.x / 2 + 0.2 && Math.abs(y - p.at.y) < p.size.y / 2 + 0.2);
  const edge = (a: Vec2, c: Vec2) => {
    const steps = 40;
    let start: Vec2 | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t };
      const hit = padHit(p.x, p.y);
      if (!hit && !start) start = p;
      if ((hit || i === steps) && start) {
        const end = hit ? { x: a.x + (c.x - a.x) * ((i - 1) / steps), y: a.y + (c.y - a.y) * ((i - 1) / steps) } : p;
        if (Math.hypot(end.x - start.x, end.y - start.y) > 0.2) g.push({ kind: 'line', layer: 'F.SilkS', w: SILK, a: { x: r2(start.x), y: r2(start.y) }, b: { x: r2(end.x), y: r2(end.y) } });
        start = null;
      }
    }
  };
  const sb = { x: bw + 0.1, y: bh + 0.1 };
  edge({ x: -sb.x, y: -sb.y }, { x: sb.x, y: -sb.y });
  edge({ x: sb.x, y: -sb.y }, { x: sb.x, y: sb.y });
  edge({ x: sb.x, y: sb.y }, { x: -sb.x, y: sb.y });
  edge({ x: -sb.x, y: sb.y }, { x: -sb.x, y: -sb.y });
  if (opts.pin1) g.push({ kind: 'circle', layer: 'F.SilkS', w: SILK, c: opts.pin1, r: 0.15, fill: true });
  return { name, description, pads, graphics: g, source: 'generic', tags: opts.tags ?? [] };
}

/** Outlines (fab, silk around the pads, courtyard), pin-1 mark and reference / value texts. */
export const finishFootprint = finish;

const smd = (number: string, x: number, y: number, w: number, h: number, shape: PadShape = 'roundrect'): FpPad => ({
  number, at: { x: r2(x), y: r2(y) }, size: { x: w, y: h }, shape, type: 'smd', layers: SMD_TOP, ...(shape === 'roundrect' ? { cornerRatio: 0.25 } : {}),
});
const tht = (number: string, x: number, y: number, d: number, drill: number, square = false): FpPad => ({
  number, at: { x: r2(x), y: r2(y) }, size: { x: d, y: d }, shape: square ? 'rect' : 'circle', type: 'through', layers: THT, drill,
});

/** Two-terminal chip sizes: [body L, body W, pad w, pad h, pad centre x]. */
const CHIP: Record<string, [number, number, number, number, number]> = {
  '0201': [0.6, 0.3, 0.4, 0.4, 0.33],
  '0402': [1.0, 0.5, 0.6, 0.62, 0.5],
  '0603': [1.6, 0.8, 0.9, 0.95, 0.8],
  '0805': [2.0, 1.25, 1.05, 1.4, 0.95],
  '1206': [3.2, 1.6, 1.15, 1.8, 1.5],
  '1210': [3.2, 2.5, 1.15, 2.7, 1.5],
  '2010': [5.0, 2.5, 1.3, 2.6, 2.4],
  '2512': [6.3, 3.2, 1.4, 3.4, 3.0],
};

const DIODE2: Record<string, [number, number, number, number, number]> = {
  'sod-123': [2.7, 1.6, 0.9, 1.2, 1.65],
  'sod-323': [1.7, 1.25, 0.6, 0.5, 1.1],
  'sod-523': [1.2, 0.8, 0.5, 0.4, 0.75],
  'sma': [4.4, 2.6, 1.6, 2.2, 2.0],
  'smb': [4.6, 3.6, 2.1, 2.3, 2.15],
  'smc': [6.9, 5.9, 2.4, 3.3, 3.4],
};

function chip(size: string, polarized = false): FootprintSpec | null {
  const d = CHIP[size];
  if (!d) return null;
  const [L, W, pw, ph, px] = d;
  return finish(`chip-${size}`, `Two-terminal chip, ${size} (inch code)`, [smd('1', -px, 0, pw, ph), smd('2', px, 0, pw, ph)], { w: L, h: W }, { tags: ['chip', 'smd', size, ...(polarized ? ['polarized'] : [])] });
}

function diode2(name: string): FootprintSpec | null {
  const d = DIODE2[name];
  if (!d) return null;
  const [L, W, pw, ph, px] = d;
  const fp = finish(name, `Two-terminal diode package ${name.toUpperCase()} (pad 1 = cathode)`, [smd('1', -px, 0, pw, ph), smd('2', px, 0, pw, ph)], { w: L, h: W }, { tags: ['diode', 'smd'] });
  fp.graphics.push({ kind: 'line', layer: 'F.SilkS', w: SILK, a: { x: r2(-px - pw / 2 - 0.3), y: -W / 2 }, b: { x: r2(-px - pw / 2 - 0.3), y: W / 2 } });
  return fp;
}

function sot23(pins: 3 | 5 | 6): FootprintSpec {
  const y = 1.1;
  const pads: FpPad[] =
    pins === 3
      ? [smd('1', -0.95, y, 0.6, 1.0), smd('2', 0.95, y, 0.6, 1.0), smd('3', 0, -y, 0.6, 1.0)]
      : pins === 5
        ? [smd('1', -0.95, y, 0.6, 1.0), smd('2', 0, y, 0.6, 1.0), smd('3', 0.95, y, 0.6, 1.0), smd('4', 0.95, -y, 0.6, 1.0), smd('5', -0.95, -y, 0.6, 1.0)]
        : [smd('1', -0.95, y, 0.6, 1.0), smd('2', 0, y, 0.6, 1.0), smd('3', 0.95, y, 0.6, 1.0), smd('4', 0.95, -y, 0.6, 1.0), smd('5', 0, -y, 0.6, 1.0), smd('6', -0.95, -y, 0.6, 1.0)];
  return finish(pins === 3 ? 'sot-23' : `sot-23-${pins}`, `SOT-23, ${pins} leads, 0.95 mm pitch`, pads, { w: 2.9, h: 1.6 }, { pin1: { x: -1.6, y: 1.5 }, tags: ['sot', 'smd'] });
}

/** Dual-row gull-wing (SOIC, TSSOP, SSOP, MSOP): pins 1..n/2 down the left, then up the right. */
function dualRow(name: string, desc: string, n: number, pitch: number, rowX: number, pw: number, ph: number, body: { w: number; h: number }): FootprintSpec {
  const per = n / 2;
  const pads: FpPad[] = [];
  for (let i = 0; i < n; i++) {
    const left = i < per;
    const k = left ? i : n - 1 - i;
    pads.push(smd(String(i + 1), left ? -rowX : rowX, (k - (per - 1) / 2) * pitch, pw, ph));
  }
  return finish(name, desc, pads, body, { pin1: { x: r2(-rowX - pw / 2 - 0.4), y: r2(-((per - 1) / 2) * pitch) }, tags: ['smd', name.split('-')[0]!] });
}

function qfn(n: number, body: number, pitch: number, ep: number | null): FootprintSpec {
  const per = n / 4;
  const pads: FpPad[] = [];
  const reach = body / 2 - 0.4 + 0.4; // pad centre just inside the body edge
  const pl = 0.8;
  const pw = Math.min(0.3, pitch * 0.55);
  const off = (k: number) => (k - (per - 1) / 2) * pitch;
  for (let i = 0; i < n; i++) {
    const side = Math.floor(i / per);
    const k = i % per;
    const num = String(i + 1);
    if (side === 0) pads.push(smd(num, -reach, off(k), pl, pw));
    else if (side === 1) pads.push(smd(num, off(k), reach, pw, pl));
    else if (side === 2) pads.push(smd(num, reach, -off(k), pl, pw));
    else pads.push(smd(num, -off(k), -reach, pw, pl));
  }
  if (ep) pads.push({ ...smd(String(n + 1), 0, 0, ep, ep, 'rect'), layers: ['F.Cu', 'F.Mask', 'F.Paste'] });
  const name = `qfn-${n}-${body}x${body}-p${pitch}${ep ? `-ep${ep}` : ''}`;
  return finish(name, `QFN, ${n} pins, ${body}×${body} mm, ${pitch} mm pitch${ep ? `, exposed pad ${ep} mm (pad ${n + 1})` : ''}`, pads, { w: body, h: body }, { pin1: { x: r2(-body / 2 - 0.5), y: r2(off(0)) }, tags: ['qfn', 'smd'] });
}

function dip(n: number, wide = false): FootprintSpec {
  const per = n / 2;
  const row = wide ? 15.24 : 7.62;
  const pads: FpPad[] = [];
  for (let i = 0; i < n; i++) {
    const left = i < per;
    const k = left ? i : n - 1 - i;
    pads.push(tht(String(i + 1), left ? -row / 2 : row / 2, (k - (per - 1) / 2) * 2.54, 1.6, 0.8, i === 0));
  }
  return finish(`dip-${n}${wide ? '-w15.24' : ''}`, `DIP, ${n} pins, ${row} mm row spacing`, pads, { w: row - 1.3, h: per * 2.54 + 0.5 }, { tags: ['dip', 'tht'] });
}

function header(rows: number, cols: number, pitch: number): FootprintSpec {
  const pads: FpPad[] = [];
  const d = pitch >= 2.5 ? 1.7 : pitch >= 2 ? 1.35 : 1.0;
  const drill = pitch >= 2.5 ? 1.0 : pitch >= 2 ? 0.8 : 0.6;
  // Numbered like a ribbon connector: 1,2 across the rows, then down.
  let num = 1;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) pads.push(tht(String(num++), (r - (rows - 1) / 2) * pitch, (c - (cols - 1) / 2) * pitch, d, drill, num === 2));
  const name = `header-${rows}x${String(cols).padStart(2, '0')}-p${pitch}`;
  return finish(name, `Pin header ${rows}×${cols}, ${pitch} mm pitch`, pads, { w: rows * pitch, h: cols * pitch }, { tags: ['header', 'connector', 'tht'] });
}

function terminal(cols: number, pitch: number): FootprintSpec {
  const pads: FpPad[] = [];
  for (let c = 0; c < cols; c++) pads.push(tht(String(c + 1), (c - (cols - 1) / 2) * pitch, 0, 2.4, 1.3, c === 0));
  return finish(`terminal-1x${String(cols).padStart(2, '0')}-p${pitch}`, `Screw terminal, ${cols} positions, ${pitch} mm pitch`, pads, { w: cols * pitch, h: 7 }, { tags: ['terminal', 'connector', 'tht'] });
}

function hole(m: number, plated: boolean): FootprintSpec {
  const drill = r2(m + 0.2);
  const pad: FpPad = plated
    ? { number: '1', at: { x: 0, y: 0 }, size: { x: r2(m * 2), y: r2(m * 2) }, shape: 'circle', type: 'through', layers: THT, drill }
    : { number: '', at: { x: 0, y: 0 }, size: { x: drill, y: drill }, shape: 'circle', type: 'npth', layers: ['*.Cu', '*.Mask'], drill };
  return {
    name: `hole-m${m}${plated ? '-pad' : ''}`,
    description: `Mounting hole for M${m}${plated ? ', plated with pad' : ''}`,
    pads: [pad],
    graphics: [{ kind: 'circle', layer: 'F.CrtYd', w: CRT, c: { x: 0, y: 0 }, r: r2(m * 1.1 + 0.25) }],
    source: 'generic',
    tags: ['hole', 'mechanical'],
  };
}

/** Every generic name with a short description (for browsing). */
export function genericFootprintNames(): string[] {
  const out: string[] = [];
  for (const s of Object.keys(CHIP)) out.push(`chip-${s}`);
  out.push(...Object.keys(DIODE2), 'sot-23', 'sot-23-5', 'sot-23-6');
  for (const n of [8, 14, 16]) out.push(`soic-${n}`);
  for (const n of [8, 14, 16, 20, 24, 28]) out.push(`tssop-${n}`);
  for (const n of [8, 10]) out.push(`msop-${n}`);
  out.push('qfn-16-3x3-p0.5-ep1.7', 'qfn-20-4x4-p0.5-ep2.6', 'qfn-24-4x4-p0.5-ep2.6', 'qfn-32-5x5-p0.5-ep3.5', 'qfn-48-7x7-p0.5-ep5.3');
  for (const n of [8, 14, 16, 20, 28]) out.push(`dip-${n}`);
  for (const n of [1, 2, 3, 4, 5, 6, 8, 10]) out.push(`header-1x${String(n).padStart(2, '0')}-p2.54`);
  for (const n of [3, 5, 10]) out.push(`header-2x${String(n).padStart(2, '0')}-p2.54`);
  for (const n of [2, 3, 4]) out.push(`terminal-1x${String(n).padStart(2, '0')}-p5.08`);
  out.push('hole-m2', 'hole-m2.5', 'hole-m3', 'hole-m3-pad');
  return out;
}

/** Build a generic footprint from its name ("chip-0603", "soic-8", "header-1x04-p2.54", …). */
export function genericFootprint(name: string): FootprintSpec | null {
  const s = name.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^chip-(\d{4})$/.exec(s))) return chip(m[1]!);
  if (DIODE2[s]) return diode2(s);
  if (s === 'sot-23' || s === 'sot-23-3') return sot23(3);
  if ((m = /^sot-23-(5|6)$/.exec(s))) return sot23(Number(m[1]) as 5 | 6);
  if ((m = /^soic-(\d+)$/.exec(s)) && Number(m[1]) % 2 === 0) return dualRow(`soic-${m[1]}`, `SOIC, ${m[1]} pins, 3.9 mm body, 1.27 mm pitch`, Number(m[1]), 1.27, 2.7, 1.95, 0.6, { w: 3.9, h: (Number(m[1]) / 2) * 1.27 + 0.1 });
  if ((m = /^tssop-(\d+)$/.exec(s)) && Number(m[1]) % 2 === 0) return dualRow(`tssop-${m[1]}`, `TSSOP, ${m[1]} pins, 4.4 mm body, 0.65 mm pitch`, Number(m[1]), 0.65, 2.9, 1.5, 0.4, { w: 4.4, h: (Number(m[1]) / 2) * 0.65 + 0.4 });
  if ((m = /^msop-(\d+)$/.exec(s)) && Number(m[1]) % 2 === 0) return dualRow(`msop-${m[1]}`, `MSOP, ${m[1]} pins, 3 mm body`, Number(m[1]), Number(m[1]) > 8 ? 0.5 : 0.65, 2.2, 1.2, 0.35, { w: 3, h: 3 });
  if ((m = /^qfn-(\d+)-([\d.]+)x\2-p([\d.]+)(?:-ep([\d.]+))?$/.exec(s)) && Number(m[1]) % 4 === 0) return qfn(Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : null);
  if ((m = /^dip-(\d+)(-w15\.24)?$/.exec(s)) && Number(m[1]) % 2 === 0) return dip(Number(m[1]), !!m[2]);
  if ((m = /^header-([12])x(\d+)-p([\d.]+)$/.exec(s))) return header(Number(m[1]), Number(m[2]), Number(m[3]));
  if ((m = /^terminal-1x(\d+)-p([\d.]+)$/.exec(s))) return terminal(Number(m[1]), Number(m[2]));
  if ((m = /^hole-m([\d.]+)(-pad)?$/.exec(s))) return hole(Number(m[1]), !!m[2]);
  return null;
}

/**
 * Best generic stand-in for a footprint name from another tool, e.g.
 * "Resistor_SMD:R_0603_1608Metric" → "chip-0603". Returns null when unsure.
 */
export function genericAlias(name: string): string | null {
  const s = name.split(':').pop() ?? name;
  let m: RegExpExecArray | null;
  if ((m = /^(?:R|C|L|LED|D|Fuse|CP|Ferrite)_?(0201|0402|0603|0805|1206|1210|2010|2512)(?:_|$)/i.exec(s))) return `chip-${m[1]}`;
  if ((m = /^D_?(SOD-123|SOD-323|SOD-523|SMA|SMB|SMC)(?:_|$)/i.exec(s))) return m[1]!.toLowerCase();
  if ((m = /^SOT-23(?:-(5|6))?(?:_|$)/i.exec(s))) return m[1] ? `sot-23-${m[1]}` : 'sot-23';
  if ((m = /^SOIC-(\d+)_3\.9/i.exec(s))) return `soic-${m[1]}`;
  if ((m = /^TSSOP-(\d+)_4\.4/i.exec(s))) return `tssop-${m[1]}`;
  if ((m = /^DIP-(\d+)_W7\.62/i.exec(s))) return `dip-${m[1]}`;
  if ((m = /^PinHeader_([12])x(\d+)_P2\.54mm_Vertical$/i.exec(s))) return `header-${m[1]}x${m[2]!.padStart(2, '0')}-p2.54`;
  if ((m = /^MountingHole_(\d(?:\.\d)?)mm_M(\d(?:\.\d)?)$/i.exec(s))) return `hole-m${m[2]}`;
  return null;
}

/** Expand KiCad-style wildcard layers against the board's copper layers. */
export function expandLayers(names: string[], copper: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n === '*.Cu') copper.forEach((c) => out.add(c));
    else if (n === 'F&B.Cu') ['F.Cu', 'B.Cu'].forEach((c) => out.add(c));
    else if (n.startsWith('*.')) ['F', 'B'].forEach((side) => out.add(`${side}${n.slice(1)}`));
    else out.add(n);
  }
  return [...out];
}

export interface PlaceOptions {
  ref: string;
  value?: string;
  copper?: string[];
  props?: Record<string, string | number | boolean>;
  netOf?: (pad: string) => string | null;
  position?: Vec2;
  rotation?: number;
  uid?: string;
}

/** Children (pads, graphics, texts) of a component built from a footprint; parent = elUid. */
export function footprintChildren(fp: FootprintSpec, elUid: string, o: Pick<PlaceOptions, 'ref' | 'value' | 'copper' | 'netOf'>): DocNode[] {
  const copper = o.copper ?? ['F.Cu', 'B.Cu'];
  const nodes: DocNode[] = [];
  const node = (type: DocNode['type'], name: string, rules: RuleDecl[], props: DocNode['props'] = {}): DocNode => {
    const n: DocNode = { uid: newUid(type === 'pad' ? 'pad' : type === 'text' ? 'tx' : 'gr'), type, name, props, rules, parent: elUid, children: [] };
    nodes.push(n);
    return n;
  };
  for (const p of fp.pads) {
    const rules: RuleDecl[] = [
      { name: 'position', value: p.at },
      { name: 'rotation', value: p.rot ?? 0 },
      { name: 'size', value: p.size },
      { name: 'padShape', value: p.shape },
      { name: 'padType', value: p.type },
      { name: 'layers', value: expandLayers(p.layers, copper) },
    ];
    if (p.cornerRatio !== undefined) rules.push({ name: 'cornerRatio', value: p.cornerRatio });
    if (p.drill !== undefined) rules.push({ name: 'holeSize', value: p.drill });
    if (p.points?.length) rules.push({ name: 'points', value: p.points });
    const net = p.number ? o.netOf?.(p.number) ?? null : null;
    node('pad', p.number, rules, { number: p.number, ...(net ? { net } : {}) });
  }
  for (const g of fp.graphics) {
    const common: RuleDecl[] = [{ name: 'layer', value: g.layer }];
    if (g.kind !== 'text') common.push({ name: 'strokeWidth', value: g.w });
    if ('fill' in g && g.fill) common.push({ name: 'filled', value: true });
    switch (g.kind) {
      case 'line':
        node('line', '', [...common, { name: 'start', value: g.a }, { name: 'end', value: g.b }]);
        break;
      case 'rect':
        node('rectangle', '', [...common, { name: 'points', value: [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }] }]);
        break;
      case 'circle':
        node('circle', '', [...common, { name: 'center', value: g.c }, { name: 'radius', value: g.r }]);
        break;
      case 'arc':
        node('arc', '', [...common, { name: 'start', value: g.s }, { name: 'mid', value: g.m }, { name: 'end', value: g.e }]);
        break;
      case 'poly':
        node('polygon', '', [...common, { name: 'points', value: g.pts }]);
        break;
      case 'text': {
        const text = g.text.replace(/%R|\$\{REFERENCE\}|REF\*\*/g, o.ref).replace(/%V|\$\{VALUE\}/g, o.value ?? '');
        if (!text) break;
        const rules: RuleDecl[] = [...common, { name: 'position', value: g.at }, { name: 'rotation', value: g.rot ?? 0 }, { name: 'text', value: text }, { name: 'fontSize', value: g.size }];
        if (g.hidden) rules.push({ name: 'visible', value: false });
        node('text', text, rules);
        break;
      }
    }
  }
  return nodes;
}

/** A complete component (element + children) from a footprint. nodes[0] is the element (parent unset). */
export function footprintNodes(fp: FootprintSpec, o: PlaceOptions): DocNode[] {
  const uid = o.uid ?? newUid('el');
  const kids = footprintChildren(fp, uid, o);
  const el: DocNode = {
    uid,
    type: 'element',
    name: o.ref,
    props: { ...(o.value !== undefined ? { Value: o.value } : {}), ...(o.props ?? {}), Footprint: fp.name },
    rules: [
      { name: 'position', value: o.position ?? { x: 0, y: 0 } },
      { name: 'rotation', value: o.rotation ?? 0 },
      { name: 'side', value: 'top' },
    ],
    parent: null,
    children: kids.map((k) => k.uid),
  };
  return [el, ...kids];
}

/** Courtyard-ish extent of a footprint (for previews and parking). */
export function footprintBox(fp: FootprintSpec) {
  const pts: Vec2[] = [];
  for (const g of fp.graphics) {
    if (g.kind === 'rect') pts.push(g.a, g.b);
    else if (g.kind === 'line') pts.push(g.a, g.b);
    else if (g.kind === 'circle') pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r });
    else if (g.kind === 'poly') pts.push(...g.pts);
  }
  return bbox(fp.pads, pts);
}
