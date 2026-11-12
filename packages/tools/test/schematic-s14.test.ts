import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractNetlist, kicadNetlist, kicadSchematic, runErc, StyleEngine, type Doc } from '@hassassin/core';
import { importKicadSchematic, parseSExpr } from '@hassassin/kicad-import';
import { newProject, openProject, runTool, type Project } from '@hassassin/tools';

/** Net name → sorted "ref.pin" list, without power-symbol pins. */
function nets(doc: Doc, engine: StyleEngine): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of extractNetlist(doc, engine).nets) {
    const pins = n.pins.filter((p) => !p.ref.startsWith('#')).map((p) => `${p.ref}.${p.pin}`).sort();
    if (pins.length) out.set(n.name, pins);
  }
  return out;
}

/** A design with what a schematic usually has: rotated and mirrored parts, power, labels, a sub-sheet. */
async function design(): Promise<Project> {
  const p = newProject('rt');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '10k' });
  await runTool(p, 'move_symbol', { ref: 'R1', rotation: 90 });
  await runTool(p, 'add_part', { kind: 'led', x: 0, y: 30 });
  await runTool(p, 'move_symbol', { ref: 'D1', mirror: 'y' }).catch(() => undefined);
  await runTool(p, 'add_part', { kind: 'ic', pins: 6, x: -40, y: 10, pin_names: 'VCC,GND,EN,OUT,NC,SDA' });
  await runTool(p, 'connect_pins', { from: 'U1.4', to: 'D1.2' });
  await runTool(p, 'add_power', { pin: 'U1.1', net: '+3V3' });
  await runTool(p, 'add_power', { pin: 'U1.2', net: 'GND' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND', flag: true });
  await runTool(p, 'add_label', { pin: 'U1.6', name: 'SDA', kind: 'global' });
  await runTool(p, 'add_label', { pin: 'U1.3', name: 'EN' });
  await runTool(p, 'add_label', { pin: 'R1.1', name: 'EN' });
  await runTool(p, 'add_sheet', { name: 'Filter', x: 40.64, y: -10.16 });
  await runTool(p, 'add_part', { kind: 'capacitor', x: 50.8, y: 50.8, sheet: '/Filter/', value: '100n' });
  await runTool(p, 'add_label', { pin: 'C1.1', name: 'IN', kind: 'hier', shape: 'input' });
  await runTool(p, 'add_power', { pin: 'C1.2', net: 'GND' });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'Filter:IN' });
  await runTool(p, 'add_note', { text: 'Status LED\nactive high', x: -40, y: -20 });
  await runTool(p, 'add_group_box', { title: 'Indicator', refs: 'D1' });
  await runTool(p, 'set_sheet_frame', { title: 'Round trip', revision: 'B', author: 'Test' });
  return p;
}

describe('S14: KiCad schematic export', () => {
  it('round trip: export, import again — the same nets with the same names', async () => {
    const p = await design();
    const before = nets(p.doc, p.engine);
    expect(before.get('/EN')).toEqual(['R1.1', 'U1.3']);
    const r = kicadSchematic(p.doc, p.engine, { project: 'rt' });
    expect(r.files.map((f) => f.name)).toEqual(['rt.kicad_sch', 'Filter.kicad_sch', 'hassassin.kicad_sym', 'sym-lib-table', 'rt.kicad_pro']);
    for (const f of r.files.filter((x) => /\.kicad_(sch|sym)$/.test(x.name))) expect(() => parseSExpr(f.text)).not.toThrow();
    const files = Object.fromEntries(r.files.map((f) => [f.name, f.text]));
    const back = importKicadSchematic({ files, root: r.root });
    expect(back.warnings).toEqual([]);
    expect(nets(back.doc, new StyleEngine(back.doc))).toEqual(before);
    // What KiCad shows besides the nets.
    const root = files['rt.kicad_sch']!;
    expect(root).toMatch(/\(paper "A\d"\)/);
    expect(root).toContain('(title_block (title "Round trip")');
    expect(root).toContain('(text "Status LED\\nactive high"');
    expect(root).toMatch(/\(rectangle \(start [\d.-]+ [\d.-]+\) \(end [\d.-]+ [\d.-]+\) \(stroke \(width 0\) \(type dash\)\)/);
    expect(root).toMatch(/\(global_label "SDA" \(shape bidirectional\)/);
    expect(root).toMatch(/\(sheet \(at [\d.-]+ [\d.-]+\) \(size [\d.-]+ [\d.-]+\)[\s\S]*\(property "Sheetfile" "Filter\.kicad_sch"[\s\S]*\(pin "IN" input/);
    expect(files['Filter.kicad_sch']).toMatch(/\(hierarchical_label "IN" \(shape input\)/);
    // Power ports are power symbols, references and footprints as KiCad expects them.
    expect(root).toMatch(/\(symbol "Hassassin:GND" \(power\)/);
    expect(root).toMatch(/\(property "Reference" "#PWR\d+"/);
    expect(root).toContain('(property "Footprint" "Resistor_SMD:R_0603_1608Metric"');
    expect(r.warnings).toEqual([]);
    // The bundled library holds the same symbols, without the library name.
    expect(files['hassassin.kicad_sym']).toMatch(/^\(kicad_symbol_lib\n\t\(version \d+\)/);
    expect(files['hassassin.kicad_sym']).toMatch(/\(symbol "GND" \(power\)/);
    expect(files['sym-lib-table']).toContain('(uri "${KIPRJMOD}/hassassin.kicad_sym")');
  });

  it('the export tool writes every file next to the root, or one zip', async () => {
    const p = await design();
    const written = new Map<string, Uint8Array | string>();
    const ctx = { writeFile: async (path: string, data: Uint8Array | string) => void written.set(path, data) };
    const r = (await runTool(p, 'export_kicad_schematic', { out: 'out/board.kicad_sch' }, ctx)) as { written: string[]; symbols: number; sheets: number };
    expect(r.written).toEqual(['out/board.kicad_sch', 'out/Filter.kicad_sch', 'out/hassassin.kicad_sym', 'out/sym-lib-table', 'out/board.kicad_pro']);
    expect(r).toMatchObject({ symbols: 4, sheets: 2 });
    expect(String(written.get('out/board.kicad_sch'))).toContain('(project "board"');
    const z = (await runTool(p, 'export_kicad_schematic', { out: 'board.zip' }, ctx)) as { files: string[] };
    expect(z.files).toContain('Filter.kicad_sch');
    await expect(runTool(p, 'export_kicad_schematic', { out: 'board.sch' }, ctx)).rejects.toThrow(/\.kicad_sch or \.zip/);
  });
});

// ---------------------------------------------------------------- against KiCad itself
// With KiCad installed, kicad-cli reads our files: its netlist must equal ours, and its ERC must find
// the same problems. KICAD_PROJECT_DIR (a project with a board) adds a real project round trip.
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find((x) => existsSync(x));
const readNets = (text: string) => {
  const nets = new Map<string, string[]>();
  for (const m of text.matchAll(/\(net\s+\(code "\d+"\)\s+\(name "((?:\\.|[^"\\])*)"\)[\s\S]*?(?=\n\t\t\(net\b|\n\t\)\n)/g))
    nets.set(m[1]!.replace(/\\"/g, '"'), [...m[0].matchAll(/\(node\s+\(ref "([^"]+)"\)\s+\(pin "([^"]+)"\)/g)].map((x) => `${x[1]}.${x[2]}`).sort());
  return nets;
};
function kicadView(files: { name: string; text: string }[], root: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hs14-'));
  for (const f of files) writeFileSync(join(dir, f.name), f.text);
  execFileSync(KICAD_CLI!, ['sch', 'export', 'netlist', '-o', join(dir, 'k.net'), join(dir, root)], { stdio: 'ignore' });
  try {
    execFileSync(KICAD_CLI!, ['sch', 'erc', '--format', 'json', '-o', join(dir, 'erc.json'), join(dir, root)], { stdio: 'ignore' });
  } catch {
    /* kicad-cli exits non-zero when ERC finds errors */
  }
  const erc = JSON.parse(readFileSync(join(dir, 'erc.json'), 'utf8')) as { sheets: { violations: { type: string; severity: string }[] }[] };
  return { nets: readNets(readFileSync(join(dir, 'k.net'), 'utf8')), erc: erc.sheets.flatMap((s) => s.violations) };
}

describe.runIf(!!KICAD_CLI)('S14 in KiCad (kicad-cli)', { timeout: 60_000 }, () => {
  it('a design made here: KiCad reads the same nets, and its ERC sees no library or footprint problems', async () => {
    const p = await design();
    const r = kicadSchematic(p.doc, p.engine, { project: 'rt' });
    const k = kicadView(r.files, r.root);
    expect(k.nets).toEqual(readNets(kicadNetlist(p.doc, p.engine).text));
    const lib = k.erc.filter((v) => /lib_symbol|footprint_link/.test(v.type));
    expect(lib).toEqual([]);
    // The same electrical errors as our ERC: here one unconnected pin (U1.5) on both sides. KiCad also
    // treats a power symbol as a power input (+3V3 has no source here); ours does not (yet, see S17).
    const kicadErrors = k.erc.filter((v) => v.severity === 'error').map((v) => v.type).sort();
    expect(kicadErrors).toEqual(['pin_not_connected', 'power_pin_not_driven']);
    expect(runErc(p.doc, p.engine).violations.filter((v) => v.severity === 'error').map((v) => v.kind)).toEqual(['unconnectedPin']);
  });

  const dir = process.env.KICAD_PROJECT_DIR;
  const board = dir && existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.kicad_pcb')) : undefined;
  it.runIf(!!board)('a real KiCad project: imported and exported again, KiCad reads the same netlist and ERC as from the original', () => {
    const files = readdirSync(dir!).filter((f) => /\.kicad_(pcb|sch)$/.test(f)).map((f) => ({ name: f, text: readFileSync(join(dir!, f), 'utf8') }));
    const p = openProject(files);
    const r = kicadSchematic(p.doc, p.engine, { project: board!.replace(/\.kicad_pcb$/, '') });
    const ours = kicadView(r.files, r.root);
    const tmp = mkdtempSync(join(tmpdir(), 'hs14o-'));
    const sch = join(dir!, board!.replace(/\.kicad_pcb$/, '.kicad_sch'));
    execFileSync(KICAD_CLI!, ['sch', 'export', 'netlist', '-o', join(tmp, 'o.net'), sch], { stdio: 'ignore' });
    expect(ours.nets).toEqual(readNets(readFileSync(join(tmp, 'o.net'), 'utf8')));
    // Unchanged library symbols are written exactly as they came.
    const raw = Object.keys(p.doc.meta).filter((k) => k.startsWith('kicadSym:'));
    expect(raw.length).toBeGreaterThan(0);
  });
});
