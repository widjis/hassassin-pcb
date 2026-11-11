/**
 * Fabrication package: Gerbers, drill files, BOM and pick-and-place, bundled as a ZIP.
 */
import { collectCopper, type Doc, type StyleEngine, type Vec2 } from '@hassassin/core';
import { collectHoles, excellon } from './excellon.ts';
import { copperGerber, graphicsGerber, padLayerGerber, type GerberLayerSpec } from './gerber.ts';
import { zip } from './zip.ts';

export { crc32, zip } from './zip.ts';
export { copperGerber, graphicsGerber, padLayerGerber } from './gerber.ts';
export { collectHoles, excellon } from './excellon.ts';

export interface FabFile {
  name: string;
  data: string;
  kind: 'gerber' | 'drill' | 'bom' | 'placement' | 'readme';
}

export interface FabResult {
  files: FabFile[];
  notes: string[];
}

const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((c) => (typeof c === 'number' ? String(c) : /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
const layerFile = (l: string) => l.replace(/[^A-Za-z0-9]+/g, '_');

export function bomCsv(doc: Doc): string {
  const groups = new Map<string, { refs: string[]; value: string; footprint: string; mpn: string; mfr: string }>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'element') continue;
    const value = String(n.props.Value ?? '');
    const footprint = String(n.props.Footprint ?? '');
    const mpn = String(n.props.MPN ?? n.props['Manufacturer Part Number'] ?? n.props.LCSC ?? '');
    const mfr = String(n.props.Manufacturer ?? n.props.MFR ?? '');
    const key = [value, footprint, mpn].join('\u0000');
    const g = groups.get(key) ?? { refs: [], value, footprint, mpn, mfr };
    g.refs.push(n.name);
    groups.set(key, g);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const rows = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(natural) })).sort((a, b) => natural(a.refs[0]!, b.refs[0]!));
  return csv([['Designators', 'Qty', 'Value', 'Footprint', 'MPN', 'Manufacturer'], ...rows.map((g) => [g.refs.join(' '), g.refs.length, g.value, g.footprint, g.mpn, g.mfr])]);
}

export function placementCsv(doc: Doc, engine: StyleEngine): string {
  const rows: (string | number)[][] = [['Designator', 'Value', 'Footprint', 'X (mm)', 'Y (mm)', 'Rotation', 'Side']];
  const els = [...doc.nodes.values()].filter((n) => n.type === 'element').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const n of els) {
    const p = engine.get(n.uid, 'position')?.value as Vec2 | undefined;
    if (!p) continue;
    const rot = Number(engine.get(n.uid, 'rotation')?.value ?? 0);
    const side = String(engine.get(n.uid, 'side')?.value ?? 'top');
    rows.push([n.name, String(n.props.Value ?? ''), String(n.props.Footprint ?? ''), Number(p.x.toFixed(4)), Number((-p.y).toFixed(4)), Number(rot.toFixed(2)), side]);
  }
  return csv(rows);
}

export function buildFab(doc: Doc, engine: StyleEngine, layerNames: string[], title: string): FabResult {
  const copper = layerNames.filter((l) => l.endsWith('.Cu'));
  const shapes = collectCopper(doc, engine, copper);
  const input = { doc, engine, shapes, title };
  const base = safe(title || 'board');
  const files: FabFile[] = [];
  const notes: string[] = [];
  const has = (l: string) => layerNames.includes(l);

  copper.forEach((l, i) => {
    const pos = i === 0 ? 'Top' : i === copper.length - 1 ? 'Bot' : 'Inr';
    const spec: GerberLayerSpec = { layer: l, fileFunction: `Copper,L${i + 1},${pos}` };
    files.push({ name: `${base}-${layerFile(l)}.gbr`, data: copperGerber(input, spec), kind: 'gerber' });
  });
  for (const [l, fn] of [
    ['F.Mask', 'Soldermask,Top'],
    ['B.Mask', 'Soldermask,Bot'],
    ['F.Paste', 'Paste,Top'],
    ['B.Paste', 'Paste,Bot'],
  ] as const) {
    if (has(l)) files.push({ name: `${base}-${layerFile(l)}.gbr`, data: padLayerGerber(input, { layer: l, fileFunction: fn, polarity: l.endsWith('Mask') ? 'Negative' : 'Positive' }, copper), kind: 'gerber' });
  }
  for (const [l, fn] of [
    ['F.SilkS', 'Legend,Top'],
    ['B.SilkS', 'Legend,Bot'],
    ['Edge.Cuts', 'Profile,NP'],
  ] as const) {
    if (has(l)) files.push({ name: `${base}-${layerFile(l)}.gbr`, data: graphicsGerber(input, { layer: l, fileFunction: fn }, l === 'Edge.Cuts' ? 0.1 : 0.15), kind: 'gerber' });
  }

  const holes = collectHoles(shapes);
  files.push({ name: `${base}-PTH.drl`, data: excellon(holes.plated, true, title), kind: 'drill' });
  if (holes.unplated.length) files.push({ name: `${base}-NPTH.drl`, data: excellon(holes.unplated, false, title), kind: 'drill' });
  files.push({ name: `${base}-BOM.csv`, data: bomCsv(doc), kind: 'bom' });
  files.push({ name: `${base}-placement.csv`, data: placementCsv(doc, engine), kind: 'placement' });

  let texts = 0;
  for (const n of doc.nodes.values()) if (n.type === 'text' && engine.get(n.uid, 'visible')?.value !== false) texts++;
  if (texts) notes.push(`${texts} silkscreen text item(s) are not in the legend Gerbers yet (no vector font).`);
  notes.push('Vias are tented (covered by solder mask).');
  files.push({
    name: 'README.txt',
    kind: 'readme',
    data: [
      `${title} — fabrication files from Hassassin PCB`,
      `Generated ${new Date().toISOString()}`,
      'Units: millimetres. Gerber RS-274X with X2 attributes, format 4.6. Drill: Excellon, metric.',
      `Copper layers: ${copper.length}. Plated holes: ${holes.plated.length}. Non-plated holes: ${holes.unplated.length}.`,
      ...notes.map((n) => `Note: ${n}`),
      '',
    ].join('\n'),
  });
  return { files, notes };
}

export function fabZip(r: FabResult): Uint8Array {
  return zip(r.files.map((f) => ({ name: f.name, data: f.data })));
}
