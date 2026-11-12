import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { busMembers, extractNetlist, kicadNetlist, kicadSchematic, newUid, runErc, StyleEngine, type DocNode, type Vec2 } from '@hassassin/core';
import { importKicadSchematic } from '@hassassin/kicad-import';
import { newProject, runTool, type Project } from '@hassassin/tools';

const netOf = (p: Project, pin: string) => extractNetlist(p.doc, p.engine).byPin.get(pin);
const sheet = (p: Project, name: string) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet' && n.name === name)!;
const at = (p: Project, n: DocNode) => p.engine.get(n.uid, 'position')!.value as Vec2;

/** Root: R1, R2 on a bus X[0..1] into sheet Sub; inside: R11, R12 on the hierarchical bus D[0..1]. */
async function hierarchy(parentBus = 'X[0..1]'): Promise<Project> {
  const p = newProject('bus');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 20 });
  await runTool(p, 'add_part', { kind: 'resistor', x: 10.16, y: 20 });
  await runTool(p, 'add_sheet', { name: 'Sub', x: 60.96, y: 0 });
  await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 30.48, sheet: '/Sub/' });
  await runTool(p, 'add_part', { kind: 'resistor', x: 40.64, y: 30.48, sheet: '/Sub/' });
  await runTool(p, 'add_bus', { name: 'D[0..1]', points: '10.16,10.16 50.8,10.16', kind: 'hier', sheet: '/Sub/', pins: 'R3.1 R4.1' });
  const block = [...p.doc.nodes.values()].find((n) => n.type === 'block' && n.name === 'Sub')!;
  const pin = block.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'sheetPin' && n.name === 'D[0..1]')!;
  const q = at(p, pin);
  await runTool(p, 'add_bus', { name: parentBus, points: `${q.x - 30.48},${q.y} ${q.x},${q.y}`, pins: 'R1.1 R2.1' });
  return p;
}

describe('S15: buses', () => {
  it('reads bus names: vectors (up or down), groups with and without a prefix, vectors inside groups', () => {
    expect(busMembers('DATA[0..3]')).toEqual(['DATA0', 'DATA1', 'DATA2', 'DATA3']);
    expect(busMembers('A[2..0]')).toEqual(['A2', 'A1', 'A0']);
    expect(busMembers('I2C{SDA SCL}')).toEqual(['I2C.SDA', 'I2C.SCL']);
    expect(busMembers('{SDA SCL}')).toEqual(['SDA', 'SCL']);
    expect(busMembers('{D[0..1] CLK}')).toEqual(['D0', 'D1', 'CLK']);
    expect(busMembers('GND')).toBeNull();
    expect(busMembers('NET[x]')).toBeNull();
  });

  it('a bus through a sheet pin joins its members in order, named from the parent (as KiCad does)', async () => {
    const p = await hierarchy();
    expect(netOf(p, 'R1.1')).toBe('/X0');
    expect(netOf(p, 'R3.1')).toBe('/X0');
    expect(netOf(p, 'R2.1')).toBe('/X1');
    expect(netOf(p, 'R4.1')).toBe('/X1');
    // Bus labels are not nets.
    expect(extractNetlist(p.doc, p.engine).nets.some((n) => n.name.includes('['))).toBe(false);
    // ERC: bus labels are attached to their bus.
    expect(runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'danglingLabel')).toEqual([]);
  });

  it('a global bus label joins the members of every bus that has it', async () => {
    const p = newProject('g');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 20 });
    await runTool(p, 'add_sheet', { name: 'Sub', x: 60.96, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 30.48, sheet: '/Sub/' });
    await runTool(p, 'add_bus', { name: 'G[0..1]', points: '0,5.08 30.48,5.08', kind: 'global', pins: 'R1.1' });
    await runTool(p, 'add_bus', { name: 'G[0..1]', points: '10.16,10.16 50.8,10.16', kind: 'global', sheet: '/Sub/', pins: 'R2.1' });
    expect(netOf(p, 'R1.1')).toBe('G0');
    expect(netOf(p, 'R2.1')).toBe('G0');
    await expect(runTool(p, 'add_bus', { name: 'GND', points: '0,0 10,0' })).rejects.toThrow(/not a bus name/);
  });

  it('a wire on a bus entry must be a member: ERC says so otherwise', async () => {
    const p = newProject('e');
    await runTool(p, 'add_part', { kind: 'resistor', x: 10.16, y: 20.32 });
    await runTool(p, 'add_bus', { name: 'D[0..1]', points: '0,7.62 30.48,7.62' });
    // Clicked just below the bus at x 7.62: the entry leans down and right, ending above R1 pin 1.
    const e = (await runTool(p, 'add_bus_entry', { x: 7.62, y: 9 })) as { wireEnd: Vec2; onBus: Vec2 };
    expect(e.onBus).toEqual({ x: 7.62, y: 7.62 });
    expect(e.wireEnd).toEqual({ x: 10.16, y: 10.16 });
    // A wire from the entry down to R1 pin 1 (R1 lands on the pin grid at y 21.59, so pin 1 is at 17.78).
    const s = sheet(p, 'Root');
    p.history.apply('Wire', [{ op: 'add', parent: s.uid, index: s.children.length, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: e.wireEnd }, { name: 'end', value: { x: 10.16, y: 17.78 } }], parent: s.uid, children: [] }] } }]);
    const kinds = () => runErc(p.doc, p.engine).violations.map((v) => v.kind);
    expect(kinds()).toContain('netNotBusMember');
    expect(kinds()).not.toContain('danglingWire');
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'D1' });
    expect(kinds()).not.toContain('netNotBusMember');
  });

  it('buses and entries go to KiCad and come back', async () => {
    const p = await hierarchy();
    const rootBus = [...p.doc.nodes.values()].find((n) => n.type === 'bus' && p.doc.nodes.get(n.parent!)?.name === 'Root')!;
    const a = p.engine.get(rootBus.uid, 'start')!.value as Vec2;
    await runTool(p, 'add_bus_entry', { x: a.x + 5.08, y: a.y + 1 });
    const r = kicadSchematic(p.doc, p.engine, { project: 'bus' });
    const files = Object.fromEntries(r.files.map((f) => [f.name, f.text]));
    expect(files['bus.kicad_sch']).toMatch(/\(bus \(pts \(xy [\d.-]+ [\d.-]+\) \(xy [\d.-]+ [\d.-]+\)\)/);
    expect(files['bus.kicad_sch']).toMatch(/\(bus_entry \(at [\d.-]+ [\d.-]+\) \(size 2\.54 -?2\.54\)/);
    expect(files['Sub.kicad_sch']).toContain('(hierarchical_label "D[0..1]"');
    const back = importKicadSchematic({ files, root: r.root });
    const types = [...back.doc.nodes.values()].map((n) => n.type);
    expect(types.filter((t) => t === 'bus').length).toBe(2);
    expect(types.filter((t) => t === 'busEntry').length).toBe(1);
    const net = (pin: string) => extractNetlist(back.doc, new StyleEngine(back.doc)).byPin.get(pin);
    expect([net('R1.1'), net('R3.1'), net('R2.1'), net('R4.1')]).toEqual(['/X0', '/X0', '/X1', '/X1']);
  });
});

// KiCad as the judge of what a bus connects: its netlist of our export must equal ours.
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find((x) => existsSync(x));
describe.runIf(!!KICAD_CLI)('S15 in KiCad (kicad-cli)', { timeout: 60_000 }, () => {
  const nets = (text: string) =>
    new Map(
      [...text.matchAll(/\(net\s+\(code "\d+"\)\s+\(name "((?:\\.|[^"\\])*)"\)([\s\S]*?)(?=\n\t\t\(net\b|\n\t\)\n)/g)].map((m) => [m[1]!, [...m[2]!.matchAll(/\(ref "([^"]+)"\)\s+\(pin "([^"]+)"\)/g)].map((x) => `${x[1]}.${x[2]}`).sort()] as const),
    );
  it('a hierarchical bus with another name on the parent, and a global bus: the same nets in KiCad', async () => {
    for (const p of [await hierarchy('X[0..1]'), await hierarchy('D[0..1]')]) {
      const r = kicadSchematic(p.doc, p.engine, { project: 'bus' });
      const dir = mkdtempSync(join(tmpdir(), 'hs15-'));
      for (const f of r.files) writeFileSync(join(dir, f.name), f.text);
      execFileSync(KICAD_CLI!, ['sch', 'export', 'netlist', '-o', join(dir, 'k.net'), join(dir, r.root)], { stdio: 'ignore' });
      expect(nets(readFileSync(join(dir, 'k.net'), 'utf8'))).toEqual(nets(kicadNetlist(p.doc, p.engine).text));
    }
  });
});
