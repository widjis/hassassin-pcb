import { describe, expect, it } from 'vitest';
import { extractNetlist, newUid, pinPoint, shortJogs, sheetBends, type Op, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const groups = (p: Project) =>
  extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
const sheet = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!;
const pin = (p: Project, id: string) => {
  const [ref, num] = id.split('.');
  const sym = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === ref)!;
  const pn = sym.children.map((c) => p.doc.nodes.get(c)!).find((k) => k.type === 'pin' && k.name === num)!;
  return pinPoint(p.doc, p.engine, pn)!;
};
const onGrid = (v: Vec2) => Math.abs(v.x / 2.54 - Math.round(v.x / 2.54)) < 1e-6 && Math.abs(v.y / 2.54 - Math.round(v.y / 2.54)) < 1e-6;
const drawPath = (p: Project, pts: Vec2[]) => {
  const s = sheet(p);
  const ops: Op[] = pts.slice(1).map((b, i) => ({ op: 'add', parent: s.uid, index: s.children.length + i, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: pts[i]! }, { name: 'end', value: b }], parent: s.uid, children: [] }] } }));
  p.history.apply('draw', ops);
};

describe('S8: pin grid and jog removal', () => {
  it('placed, moved and rotated parts keep their pins on the 2.54 mm grid', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 1.3, y: 0.6 });
    await runTool(p, 'add_part', { kind: 'ic', x: 30.1, y: 7.7, pins: 8 });
    for (const id of ['R1.1', 'R1.2', 'U1.1', 'U1.8']) expect(onGrid(pin(p, id)), id).toBe(true);
    await runTool(p, 'move_symbol', { ref: 'R1', rotation: 90 });
    await runTool(p, 'move_symbol', { ref: 'R1', x: 11.43, y: 3.81 });
    for (const id of ['R1.1', 'R1.2']) expect(onGrid(pin(p, id)), id).toBe(true);
  });

  it('tidy_wires slides a T along the wire it joins (the EN divider case)', async () => {
    const p = newProject('t');
    // Divider: R1 above R2, joined by a vertical wire from R1.2 down to R2.1.
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 15.24 });
    await runTool(p, 'connect_pins', { from: 'R1.2', to: 'R2.1' });
    await runTool(p, 'add_part', { kind: 'ic', x: 30.48, y: 10.16, pins: 8 });
    const top = pin(p, 'R1.2');
    const en = pin(p, 'U1.1');
    // A jogged wire from the divider top to the IC pin, as an agent might leave it.
    const midX = (top.x + en.x) / 2;
    drawPath(p, [top, { x: Math.round(midX / 2.54) * 2.54, y: top.y }, { x: Math.round(midX / 2.54) * 2.54, y: en.y }, en]);
    const before = groups(p);
    expect(sheetBends(p.doc, p.engine, sheet(p).uid)).toBeGreaterThan(0);
    const out = (await runTool(p, 'tidy_wires', {})) as { sheets: { bendsBefore: number; bendsAfter: number }[] };
    expect(out.sheets[0]!.bendsAfter).toBeLessThan(out.sheets[0]!.bendsBefore);
    expect(groups(p)).toEqual(before);
    if (en.y > top.y && en.y < pin(p, 'R2.1').y) expect(sheetBends(p.doc, p.engine, sheet(p).uid)).toBe(0);
  });

  it('tidy_wires moves a small part one grid step so its pin lines up', async () => {
    const p = newProject('t');
    // Two horizontal resistors facing each other: R1 on the left, R2 one grid step lower on the right.
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'move_symbol', { ref: 'R1', rotation: 90 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 25.4, y: 0 });
    await runTool(p, 'move_symbol', { ref: 'R2', rotation: 90 });
    const a0 = pin(p, 'R1.2');
    const b0 = pin(p, 'R2.1');
    const a = a0.x < b0.x ? a0 : pin(p, 'R1.1');
    const r2 = [...p.doc.nodes.values()].find((n) => n.props.ref === 'R2')!;
    const core = await import('@hassassin/core');
    await runTool(p, 'move_symbol', { ref: 'R2', y: core.symbolFrame(p.engine, r2.uid).origin.y + 2.54 });
    const b = pin(p, 'R2.1').x > a.x ? pin(p, 'R2.1') : pin(p, 'R2.2');
    const mx = Math.round((a.x + b.x) / 2 / 2.54) * 2.54;
    drawPath(p, [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
    expect(shortJogs(p.doc, p.engine, sheet(p).uid).length).toBe(1);
    const before = groups(p);
    const out = (await runTool(p, 'tidy_wires', {})) as { sheets: { moved: string[]; bendsAfter: number }[] };
    expect(groups(p)).toEqual(before);
    expect(out.sheets[0]!.moved.length).toBe(1);
    expect(out.sheets[0]!.bendsAfter).toBe(0);
    expect(shortJogs(p.doc, p.engine, sheet(p).uid).length).toBe(0);
  });

  it('tidy_wires never leaves a power symbol hanging (owner report: GND symbols not attached)', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    // R1 with a GND stub that jogs sideways (as an older add_power or a move left it).
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    const a = pin(p, 'R1.2');
    const gndAt = { x: a.x + 2.54, y: a.y + 5.08 };
    drawPath(p, [a, { x: a.x, y: a.y + 2.54 }, { x: gndAt.x, y: a.y + 2.54 }, gndAt]);
    const s = sheet(p);
    p.history.apply('gnd', [core.addPowerPortOp(p.doc, s.uid, 'GND', gndAt, { down: true }).op]);
    // Another GND wire further down, joined to the GND net only by its own GND symbol.
    await runTool(p, 'add_part', { kind: 'resistor', x: 25.4, y: 0 });
    const b = pin(p, 'R2.2');
    const low = a.y + 12.7;
    drawPath(p, [b, { x: b.x, y: low }, { x: a.x - 10.16, y: low }]);
    p.history.apply('gnd2', [core.addPowerPortOp(p.doc, s.uid, 'GND', { x: b.x, y: low }, { down: true }).op]);
    const dangling = () => core.runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'danglingPower').length;
    expect(dangling()).toBe(0);
    const loose = core.looseCount(p.doc, p.engine, s.uid);
    await runTool(p, 'tidy_wires', {});
    expect(dangling()).toBe(0);
    expect(core.looseCount(p.doc, p.engine, s.uid)).toBeLessThanOrEqual(loose);
  });
});
