/**
 * P15 (docs/05-pcb-improvements.md): the board as a `.kicad_pcb` (KiCad 9 / 10) with a `.kicad_pro` for its
 * rules. Read back by our importer it is the same board; read by KiCad (when installed) its DRC agrees with
 * ours.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fracturePolygon, isTeardrop, kicadPcb, padGeom, runDrc, type Vec2 } from '@hassassin/core';
import { importKicadPcb } from '@hassassin/kicad-import';
import { fixtureMcu, openProject, runTool, type Project } from '@hassassin/tools';

const solarText = () => readFileSync(new URL('../../../apps/web/public/samples/solar.kicad_pcb', import.meta.url), 'utf8');
const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error');
const area = (ring: Vec2[]) => Math.abs(ring.reduce((a, p, i) => a + p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y, 0) / 2);
const square = (x: number, y: number, s: number): Vec2[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

/** A board with everything the export has to carry: routed, a part on the bottom, a two-layer pour,
 *  teardrops, stitching vias and a keep-out area. */
async function full(): Promise<Project> {
  const p = await fixtureMcu();
  await runTool(p, 'flip_part', { refs: ['R1'] });
  await runTool(p, 'autoroute', {});
  await runTool(p, 'set_rule', { target: 'net#GND', rule: 'pourLayers', value: 'F.Cu B.Cu' });
  await runTool(p, 'add_keepout', { x: 101, y: 101, width: 3, height: 3, layers: '*', forbid: 'traces vias pours' });
  await runTool(p, 'refill_pours', {});
  await runTool(p, 'set_teardrops', { mode: 'through' });
  await runTool(p, 'stitch_pour', { net: 'GND', pitch: '4mm' });
  return p;
}

const exportOf = (p: Project, project = 'board') => kicadPcb(p.doc, p.engine, { project, layers: p.layers.map((l) => l.name) });
const reopen = (text: string) => openProject([{ name: 'board.kicad_pcb', text }]);

/** Pads by part and number, with their place on the board. */
function pads(p: Project): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  for (const n of p.doc.nodes.values()) {
    if (n.type !== 'pad') continue;
    const g = padGeom(p.doc, p.engine, n, p.copper)!;
    out.set(`${p.doc.nodes.get(n.parent!)!.name}.${n.props.number}`, g.center);
  }
  return out;
}

describe('P15: .kicad_pcb export', () => {
  it('joins the holes of a filled area to its outline with zero-width cuts, keeping its area', () => {
    const poly = [square(0, 0, 10), square(1, 1, 2), square(6, 1, 2), square(4, 6, 3)].map((r, i) => (i ? [...r].reverse() : r));
    const f = fracturePolygon(poly);
    expect(f.dropped).toBe(0);
    for (const h of poly.slice(1)) for (const q of h) expect(f.ring.some((r) => r.x === q.x && r.y === q.y)).toBe(true);
    expect(area(f.ring)).toBeCloseTo(100 - 4 - 4 - 9, 9);
    // Holes wound the same way as the outline are turned round first.
    expect(area(fracturePolygon([square(0, 0, 10), square(1, 1, 2)]).ring)).toBeCloseTo(96, 9);
  });

  it('writes KiCad 9 layers, numbered nets, footprints, tracks, vias, zones and a project with net classes', async () => {
    const p = await full();
    const r = exportOf(p, 'mcu');
    expect(r.files.map((f) => f.name)).toEqual(['mcu.kicad_pcb', 'mcu.kicad_pro']);
    const text = r.files[0]!.text;
    expect(text).toMatch(/^\(kicad_pcb \(version 20241229\) \(generator "hassassin_pcb"\)/);
    expect(text).toContain('(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive")');
    expect(text).toContain('(net 0 "")');
    expect(r.stats).toMatchObject({ footprints: 10, keepouts: 1 });
    expect(r.stats.teardrops).toBe([...p.doc.nodes.values()].filter(isTeardrop).length);
    // The part on the bottom: a B.Cu footprint whose texts read mirrored.
    expect(text).toMatch(/\(footprint "[^"]+" \(layer "B\.Cu"\)[^\n]*\n(?:    [^\n]*\n)*?    \(property "Reference" "R1"[^\n]*\(justify mirror\)/);
    // Pour: filled, with its fill as one ring per area (no stroke added by KiCad).
    expect(text).toMatch(/\(zone \(net \d+\) \(net_name "GND"\) \(layers "F\.Cu" "B\.Cu"\)/);
    expect(text).toContain('(filled_areas_thickness no)');
    expect(text).toContain('(attr (teardrop (type padvia)))');
    expect(text).toMatch(/\(keepout \(tracks not_allowed\) \(vias not_allowed\) \(pads allowed\) \(copperpour not_allowed\) \(footprints allowed\)\)/);
    // Net classes: the power and ground nets get their own (wider traces), matched by name.
    const pro = JSON.parse(r.files[1]!.text) as { net_settings: { classes: { name: string; track_width: number }[]; netclass_patterns: { netclass: string; pattern: string }[] }; board: { design_settings: { rules: Record<string, number> } } };
    expect(pro.net_settings.classes[0]!.name).toBe('Default');
    const gnd = pro.net_settings.netclass_patterns.find((x) => x.pattern === 'GND')!;
    expect(pro.net_settings.classes.find((c) => c.name === gnd.netclass)!.track_width).toBe(0.5);
    expect(pro.board.design_settings.rules).toMatchObject({ min_hole_to_hole: 0.25, min_via_annular_width: 0.1 });
  });

  it('read back by the importer it is the same board: parts, pads in place, traces, vias, pours, keep-outs, DRC', async () => {
    const p = await full();
    const text = exportOf(p).files[0]!.text;
    const back = reopen(text);
    const count = (q: Project, t: string) => [...q.doc.nodes.values()].filter((n) => n.type === t && !isTeardrop(n)).length;
    for (const t of ['element', 'pad', 'trace', 'via', 'fill', 'zone']) expect(count(back, t), t).toBe(count(p, t));
    const a = pads(p);
    const b = pads(back);
    expect(b.size).toBe(a.size);
    for (const [k, q] of a) expect(Math.hypot(q.x - b.get(k)!.x, q.y - b.get(k)!.y), k).toBeLessThan(1e-6);
    // Teardrops are not read back as pours; the importer says so (set the rule to make them again).
    expect(importKicadPcb(text).warnings.map((w) => w.message).join(' ')).toMatch(/Left out \d+ teardrop zones/);
    expect(errors(back)).toEqual([]);
    expect(errors(p)).toEqual([]);
  });

  it('the solar board comes back with every pad, track and pour as it was', () => {
    const p = openProject([{ name: 'solar.kicad_pcb', text: solarText() }]);
    const back = reopen(exportOf(p).files[0]!.text);
    const a = pads(p);
    const b = pads(back);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, q] of a) expect(Math.hypot(q.x - b.get(k)!.x, q.y - b.get(k)!.y), k).toBeLessThan(1e-6);
    const tracks = (q: Project) => [...q.doc.nodes.values()].filter((n) => n.type === 'trace').map((n) => `${JSON.stringify(q.engine.get(n.uid, 'start')!.value)}${JSON.stringify(q.engine.get(n.uid, 'end')!.value)}${q.engine.get(n.uid, 'traceWidth')!.value}`).sort();
    expect(tracks(back)).toEqual(tracks(p));
    expect(errors(back)).toEqual([]);
  });

  it('the export tool writes the board and its project file, or one zip', async () => {
    const p = await fixtureMcu();
    const written = new Map<string, Uint8Array | string>();
    const ctx = { writeFile: async (path: string, data: Uint8Array | string) => void written.set(path, data) };
    const r = (await runTool(p, 'export_kicad_pcb', { out: 'out/lamp.kicad_pcb' }, ctx)) as { written: string[]; footprints: number };
    expect(r.written).toEqual(['out/lamp.kicad_pcb', 'out/lamp.kicad_pro']);
    expect(r.footprints).toBe(10);
    expect(JSON.parse(String(written.get('out/lamp.kicad_pro'))).meta.filename).toBe('lamp.kicad_pro');
    const z = (await runTool(p, 'export_kicad_pcb', { out: 'b.zip' }, ctx)) as { files: string[] };
    expect(z.files).toHaveLength(2);
    await expect(runTool(p, 'export_kicad_pcb', { out: 'b.brd' }, ctx)).rejects.toThrow(/\.kicad_pcb or \.zip/);
  });
});

// ---------------------------------------------------------------- against KiCad itself
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find((x) => existsSync(x));

function kicadDrc(r: ReturnType<typeof kicadPcb>) {
  const dir = mkdtempSync(join(tmpdir(), 'hp15-'));
  for (const f of r.files) writeFileSync(join(dir, f.name), f.text);
  execFileSync(KICAD_CLI!, ['pcb', 'drc', '--severity-all', '--format', 'json', '-o', join(dir, 'drc.json'), join(dir, r.board)], { stdio: 'ignore' });
  const d = JSON.parse(readFileSync(join(dir, 'drc.json'), 'utf8')) as { violations: { type: string; severity: string }[]; unconnected_items: unknown[] };
  return { errors: d.violations.filter((v) => v.severity === 'error').map((v) => v.type), warnings: d.violations.filter((v) => v.severity === 'warning').map((v) => v.type), unconnected: d.unconnected_items.length };
}

describe.runIf(!!KICAD_CLI)('P15 in KiCad (kicad-cli)', { timeout: 120_000 }, () => {
  it('the solar board: KiCad DRC finds nothing, as ours', () => {
    const p = openProject([{ name: 'solar.kicad_pcb', text: solarText() }]);
    expect(kicadDrc(exportOf(p, 'solar'))).toEqual({ errors: [], warnings: [], unconnected: 0 });
  });

  it('a board made here (bottom part, pour, teardrops, stitching, keep-out): KiCad DRC clean, as ours', async () => {
    const p = await full();
    expect(errors(p)).toEqual([]);
    const k = kicadDrc(exportOf(p, 'mcu'));
    expect(k.errors).toEqual([]);
    expect(k.unconnected).toBe(0);
    // Its only remarks: our generated footprints differ from KiCad's library parts of the same name.
    expect(k.warnings.filter((w) => w !== 'lib_footprint_mismatch')).toEqual([]);
  });

  it('a broken board: KiCad finds the same kinds of errors as ours', async () => {
    const p = await full();
    const c1 = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'C1')!;
    const at = p.engine.get(c1.uid, 'position')!.value as Vec2;
    await runTool(p, 'move_part', { ref: 'C1', x: at.x + 2.2, y: at.y + 1.3 });
    const ours = new Set(errors(p).map((v) => v.kind));
    const k = new Set(kicadDrc(exportOf(p, 'broken')).errors);
    expect(ours.size).toBeGreaterThan(0);
    const same: Record<string, string[]> = { short: ['shorting_items', 'clearance'], clearance: ['clearance'], courtyardOverlap: ['courtyards_overlap'], unrouted: ['unconnected_items'] };
    for (const kind of ours) expect(same[kind]?.some((x) => k.has(x)), kind).toBe(true);
  });
});
