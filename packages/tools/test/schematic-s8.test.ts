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

  it('texts do not overlap each other, part bodies or wires (owner report: +20V over PWR_FLAG)', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    // A fuse with +20V and a PWR_FLAG on the same pin, and parts packed close together.
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '2A' });
    await runTool(p, 'add_power', { pin: 'R1.1', net: '+20V' });
    await runTool(p, 'add_power', { pin: 'R1.1', flag: true });
    for (const [i, x] of [5.08, 10.16, 15.24].entries()) {
      await runTool(p, 'add_part', { kind: 'capacitor', x, y: 0, value: i === 0 ? '10u 50V' : '100n 50V' });
      await runTool(p, 'add_power', { pin: `C${i + 1}.1`, net: '+20V' });
      await runTool(p, 'add_power', { pin: `C${i + 1}.2`, net: 'GND' });
    }
    const s = sheet(p).uid;
    const naive = core.layoutSheetTexts(p.doc, p.engine, s, { naive: true });
    const laid = core.layoutSheetTexts(p.doc, p.engine, s);
    expect(core.textClashes(p.doc, p.engine, s, naive)).toBeGreaterThan(0);
    expect(core.textClashes(p.doc, p.engine, s, laid)).toBe(0);
    expect(laid.filter((t) => t.crowded)).toEqual([]);
  });

  it('the schematic grid is a project setting that placement follows', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    expect((await runTool(p, 'project_status', {}) as { schematicGrid: unknown }).schematicGrid).toEqual({ pin: 2.54, wire: 1.27 });
    await expect(runTool(p, 'set_schematic_grid', { pin: 1 })).rejects.toThrow(/Pin grid must be/);
    await expect(runTool(p, 'set_schematic_grid', { pin: 2.54, wire: 5.08 })).rejects.toThrow(/Wire grid must be/);
    expect(await runTool(p, 'set_schematic_grid', { pin: 5.08, wire: 2.54 })).toEqual({ pin: 5.08, wire: 2.54 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 3.3, y: 1.9 });
    await runTool(p, 'move_symbol', { ref: 'R1', rotation: 90 });
    const on = (v: Vec2, g: number) => Math.abs(v.x / g - Math.round(v.x / g)) < 1e-6 && Math.abs(v.y / g - Math.round(v.y / g)) < 1e-6;
    // The first pin takes the 5.08 mm step; every pin stays on the 2.54 mm lattice (pins of a
    // resistor are 7.62 mm apart, so not all of them can be on 5.08).
    expect(on(pin(p, 'R1.1'), 5.08) || on(pin(p, 'R1.2'), 5.08)).toBe(true);
    for (const id of ['R1.1', 'R1.2']) expect(on(pin(p, id), 2.54), id).toBe(true);
    // Saved with the project.
    const again = (await import('@hassassin/tools')).openProject([{ name: 't.hpcb', text: (await import('@hassassin/tools')).saveProject(p) }]);
    expect(core.schematicGrid(again.doc)).toEqual({ pin: 5.08, wire: 2.54 });
  });

  it('align and distribute line parts up; wires follow and connections stay', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    for (const [x, y] of [[0, 0], [12.7, 7.62], [33.02, -5.08]] as const) await runTool(p, 'add_part', { kind: 'capacitor', x, y });
    await runTool(p, 'connect_pins', { from: 'C1.1', to: 'C2.1' });
    await runTool(p, 'connect_pins', { from: 'C2.1', to: 'C3.1' });
    const before = groups(p);
    await runTool(p, 'align', { refs: 'C1 C2 C3', mode: 'top' });
    const tops = ['C1', 'C2', 'C3'].map((r) => core.symbolBounds(p.doc, p.engine, [...p.doc.nodes.values()].find((n) => n.props.ref === r)!.uid).minY);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1e-6);
    expect(groups(p)).toEqual(before);
    await runTool(p, 'align', { refs: 'C1 C2 C3', mode: 'distributeX' });
    const xs = ['C1', 'C2', 'C3'].map((r) => core.symbolBounds(p.doc, p.engine, [...p.doc.nodes.values()].find((n) => n.props.ref === r)!.uid)).sort((a, b) => a.minX - b.minX);
    const g1 = xs[1]!.minX - xs[0]!.maxX, g2 = xs[2]!.minX - xs[1]!.maxX;
    expect(Math.abs(g1 - g2)).toBeLessThanOrEqual(2.54 + 1e-6); // within one grid step after snapping
    expect(groups(p)).toEqual(before);
  });

  it('place_relative puts decoupling capacitors in a row below the IC', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', x: 0, y: 0, pins: 8 });
    for (const x of [50, 70, 90]) await runTool(p, 'add_part', { kind: 'capacitor', x, y: 40 });
    await runTool(p, 'place_relative', { anchor: 'U1', refs: 'C1 C2 C3', side: 'below' });
    const u = core.symbolBounds(p.doc, p.engine, [...p.doc.nodes.values()].find((n) => n.props.ref === 'U1')!.uid);
    const cs = ['C1', 'C2', 'C3'].map((r) => core.symbolBounds(p.doc, p.engine, [...p.doc.nodes.values()].find((n) => n.props.ref === r)!.uid));
    for (const c of cs) {
      expect(c.minY).toBeGreaterThan(u.maxY);
      expect(c.minY - u.maxY).toBeLessThan(10);
    }
    // In order, left to right, not overlapping, roughly centred under U1.
    expect(cs[0]!.maxX).toBeLessThanOrEqual(cs[1]!.minX + 1e-6);
    expect(cs[1]!.maxX).toBeLessThanOrEqual(cs[2]!.minX + 1e-6);
    const mid = (cs[0]!.minX + cs[2]!.maxX) / 2;
    expect(Math.abs(mid - (u.minX + u.maxX) / 2)).toBeLessThan(2.6);
  });

  it('compact_blocks packs scattered blocks closer; connections and blocks stay intact', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    // Four little blocks spread far apart, each a resistor + LED wired together, joined by GND / +5V.
    for (const [i, [x, y]] of ([[0, 0], [150, 0], [0, 120], [150, 120]] as const).entries()) {
      await runTool(p, 'add_part', { kind: 'resistor', x, y });
      await runTool(p, 'add_part', { kind: 'led', x: x + 12.7, y: y + 5.08 });
      await runTool(p, 'connect_pins', { from: `R${i + 1}.2`, to: `D${i + 1}.2` });
      await runTool(p, 'add_power', { pin: `R${i + 1}.1`, net: '+5V' });
      await runTool(p, 'add_power', { pin: `D${i + 1}.1`, net: 'GND' });
    }
    const s = sheet(p).uid;
    const before = groups(p);
    const blocks0 = core.sheetBlocks(p.doc, p.engine, s).length;
    const out = (await runTool(p, 'compact_blocks', {})) as { sheets: { areaBefore: number; areaAfter: number; moved: number }[] };
    expect(out.sheets[0]!.moved).toBeGreaterThan(0);
    expect(out.sheets[0]!.areaAfter).toBeLessThan(out.sheets[0]!.areaBefore * 0.5);
    expect(groups(p)).toEqual(before);
    expect(core.sheetBlocks(p.doc, p.engine, s).length).toBe(blocks0);
    expect(core.runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'danglingPower' || v.kind === 'danglingWire')).toEqual([]);
  });

  it('a wire drawn across a part body is flagged by ERC and re-routed by tidy_wires (S8 re-run finding)', async () => {
    const core = await import('@hassassin/core');
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 15.24, y: 0 });
    await runTool(p, 'move_symbol', { ref: 'R2', rotation: 90 });
    // From R1.1 straight down through R1's body to a point just below its outline, then to R2.
    const top = pin(p, 'R1.1');
    const r2 = pin(p, 'R2.1');
    const below = { x: top.x, y: pin(p, 'R1.2').y - 1.27 };
    drawPath(p, [top, below, { x: r2.x, y: below.y }, r2]);
    const across = () => core.runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'wireThroughPart').length;
    expect(across()).toBeGreaterThan(0);
    const before = groups(p);
    await runTool(p, 'tidy_wires', {});
    expect(groups(p)).toEqual(before);
    expect(across()).toBe(0);
    expect(core.runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'wireOverPin')).toEqual([]);
  });
});
