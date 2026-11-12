import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractNetlist, kicadNetlist, uuidFor } from '@hassassin/core';
import { parseSExpr, type SExpr, type SList } from '@hassassin/kicad-import';
import { newProject, openProject, runTool, type Project } from '@hassassin/tools';

// ---------------------------------------------------------------- reading a netlist back
const atom = (e: SExpr | undefined): string => (e === undefined ? '' : typeof e === 'string' ? e : Array.isArray(e) ? '' : e.s);
const kids = (l: SList, name: string) => l.filter((c): c is SList => Array.isArray(c) && c[0] === name);
const val = (l: SList, name: string) => atom(kids(l, name)[0]?.[1]);

/** Components (ref → value, footprint) and nets (name → "ref.pin:type" nodes) of a KiCad netlist. */
function readNetlist(text: string) {
  const root = parseSExpr(text);
  const top = (Array.isArray(root[0]) ? root[0] : root) as SList;
  const comps = new Map<string, { value: string; footprint: string; tstamps: string[] }>();
  for (const c of kids(kids(top, 'components')[0]!, 'comp')) comps.set(val(c, 'ref'), { value: val(c, 'value'), footprint: val(c, 'footprint'), tstamps: kids(c, 'tstamps')[0]!.slice(1).map(atom) });
  const nets = new Map<string, string[]>();
  for (const n of kids(kids(top, 'nets')[0]!, 'net')) nets.set(val(n, 'name'), kids(n, 'node').map((x) => `${val(x, 'ref')}.${val(x, 'pin')}:${val(x, 'pintype')}`).sort());
  return { comps, nets };
}

async function smallDesign(): Promise<Project> {
  const p = newProject('led-board');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '330' });
  await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 0 });
  await runTool(p, 'add_part', { kind: 'ic', pins: 4, x: 40, y: 0, package: 'soic-8' });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await runTool(p, 'connect_pins', { from: 'U1.1', to: 'R1.1' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  await runTool(p, 'add_power', { pin: 'U1.4', net: 'GND' });
  await runTool(p, 'add_power', { pin: 'U1.2', net: '+3V3' });
  return p;
}

describe('S13: KiCad netlist export', () => {
  it('a design made here: every part and net, power symbols left out, generic footprints mapped', async () => {
    const p = await smallDesign();
    const r = kicadNetlist(p.doc, p.engine, { date: '2026-11-12T12:00:00' });
    const { comps, nets } = readNetlist(r.text);
    expect([...comps.keys()]).toEqual(['D1', 'R1', 'U1']);
    expect(comps.get('R1')).toMatchObject({ value: '330', footprint: 'Resistor_SMD:R_0603_1608Metric' });
    expect(comps.get('D1')!.footprint).toMatch(/^LED_SMD:LED_\d{4}_\d{4}Metric$/);
    expect(comps.get('U1')!.footprint).toBe('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
    expect(r.mapped.map((m) => m.ref).sort()).toEqual(['D1', 'R1', 'U1']);
    expect(r.unresolved).toEqual([]);
    // Same nets as the schematic, with the power symbol pins left out.
    const nl = extractNetlist(p.doc, p.engine);
    const expected = new Map(
      nl.nets
        .map((n) => [n.name, n.pins.filter((x) => !x.ref.startsWith('#')).map((x) => `${x.ref}.${x.pin}`).sort()] as const)
        .filter(([, pins]) => pins.length),
    );
    expect(new Map([...nets].map(([k, v]) => [k, v.map((x) => x.split(':')[0]!)]))).toEqual(expected);
    expect(nets.get('GND')).toEqual(expect.arrayContaining([expect.stringMatching(/^D1\.1:/), expect.stringMatching(/^U1\.4:/)]));
    // Every component carries a valid UUID (KiCad links footprints to symbols by it).
    for (const c of comps.values()) for (const t of c.tstamps) expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidFor('sym21hn7')).toBe(uuidFor('sym21hn7'));
    expect(uuidFor('e4faea59-207e-45a6-870a-f47ec767a0dd')).toBe('e4faea59-207e-45a6-870a-f47ec767a0dd');
  });

  it('names unnamed nets as KiCad does: a named pin first, then the first reference; "/" as {slash}', async () => {
    const p = newProject('t');
    const sym = (await runTool(p, 'create_symbol', { name: 'MCU', pins: '1,GP8/SDA,bidirectional\n2,EN,input\n3,OUT,output' })) as { id: string };
    await runTool(p, 'place_part', { id: sym.id, x: 40, y: 0, ref: 'U2' });
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'led', x: 0, y: 20 });
    await runTool(p, 'connect_pins', { from: 'U2.3', to: 'R1.1' }); // OUT (output) vs an unnamed passive pin
    await runTool(p, 'connect_pins', { from: 'U2.2', to: 'D1.1' }); // EN (input) vs LED K (passive, named)
    const nl = extractNetlist(p.doc, p.engine);
    expect(nl.byPin.get('U2.3')).toBe('Net-(U2-OUT)'); // the only named pin wins over R1-Pad1
    expect(nl.byPin.get('U2.2')).toMatch(/^Net-\(D1-/); // both named: the first reference, not the active pin
    expect(nl.byPin.get('U2.1')).toBe('unconnected-(U2-GP8{slash}SDA-Pad1)');
  });

  it('the export_netlist tool writes the file and reports footprints KiCad cannot find', async () => {
    const p = await smallDesign();
    await runTool(p, 'assign_footprint', { ref: 'U1', footprint: 'my-odd-package', update: false }).catch(() => undefined);
    const files = new Map<string, Uint8Array | string>();
    const ctx = { writeFile: async (path: string, data: Uint8Array | string) => void files.set(path, data) };
    const r = (await runTool(p, 'export_netlist', { out: 'board.net' }, ctx)) as { components: number; nets: number; unresolved?: { ref: string }[] };
    expect(r.components).toBe(3);
    expect(String(files.get('board.net'))).toMatch(/^\(export\n\t\(version "E"\)/);
    await expect(runTool(p, 'export_netlist', { out: 'board.txt' }, ctx)).rejects.toThrow(/\.net/);
    const raw = (await runTool(p, 'export_netlist', { out: 'raw.net', map_footprints: false }, ctx)) as { unresolved: { ref: string; footprint: string }[] };
    expect(raw.unresolved.map((u) => u.ref).sort()).toEqual(['D1', 'R1', 'U1']);
    expect(r.unresolved?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- against KiCad itself
// Runs when KiCad is installed and KICAD_PROJECT_DIR names a project folder with a board and its
// schematics: KiCad's own netlist (kicad-cli) and ours must agree on every component and net.
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find((x) => existsSync(x));
const dir = process.env.KICAD_PROJECT_DIR;
const board = dir && existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.kicad_pcb')) : undefined;

describe.runIf(!!KICAD_CLI && !!board)('S13 against KiCad (kicad-cli)', { timeout: 60_000 }, () => {
  it('components, net names, pins and pin types match KiCad\'s own netlist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hs13-'));
    const sch = join(dir!, board!.replace(/\.kicad_pcb$/, '.kicad_sch'));
    execFileSync(KICAD_CLI!, ['sch', 'export', 'netlist', '-o', join(tmp, 'kicad.net'), sch], { stdio: 'ignore' });
    const files = readdirSync(dir!).filter((f) => /\.kicad_(pcb|sch)$/.test(f)).map((f) => ({ name: f, text: readFileSync(join(dir!, f), 'utf8') }));
    const p = openProject(files);
    const ours = readNetlist(kicadNetlist(p.doc, p.engine, { mapFootprints: false }).text);
    const theirs = readNetlist(readFileSync(join(tmp, 'kicad.net'), 'utf8'));
    expect(new Map([...ours.comps].map(([k, v]) => [k, [v.value, v.footprint]]))).toEqual(new Map([...theirs.comps].map(([k, v]) => [k, [v.value, v.footprint]])));
    expect(ours.nets).toEqual(theirs.nets);
  });
});
