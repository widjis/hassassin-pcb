import { describe, expect, it } from 'vitest';
import { buildSymbolUnits, extractNetlist, parsePinTable, partPinRows, pinPoint, type PartDef, type PinSpec } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const BUCK = `Pin No.\tName\tType\tDescription
1\tVIN\tP\tInput supply
2\tGND\tG\tGround
3\tEN\tI\tEnable
4\tBST\tO\tBootstrap
5\tFB\tI\tFeedback
6\tSW\tO\tSwitch node
7\tPG\tOD\tPower good
8\tSS\tI\tSoft start`;

const side = (p: PinSpec) => (p.angle === 0 ? 'left' : p.angle === 180 ? 'right' : p.angle === 270 ? 'top' : 'bottom');
const onGrid = (v: number) => Math.abs(v / 2.54 - Math.round(v / 2.54)) < 1e-9;
const byNumber = (pins: PinSpec[]) => Object.fromEntries(pins.map((p) => [p.number, side(p)]));
const syms = (p: Project, ref: string) => [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && n.props.ref === ref);

describe('S16: symbol editor', () => {
  it('reads a pasted datasheet table: header, columns and datasheet type words', () => {
    const { rows, skipped } = parsePinTable(BUCK);
    expect(skipped).toEqual([]);
    expect(rows.map((r) => [r.number, r.name, r.type])).toEqual([
      ['1', 'VIN', 'power_in'], ['2', 'GND', 'power_in'], ['3', 'EN', 'input'], ['4', 'BST', 'output'],
      ['5', 'FB', 'input'], ['6', 'SW', 'output'], ['7', 'PG', 'open_collector'], ['8', 'SS', 'input'],
    ]);
    // Without a header and types: guessed from names; comma separated; side and unit columns by header.
    expect(parsePinTable('1 NC\n2 VDD\n3 OUT').rows.map((r) => r.type)).toEqual(['no_connect', 'power_in', 'passive']);
    const t = parsePinTable('pin,name,side,unit\n1,A,left,A\n2,B,right,b\n3,VCC,top,power').rows;
    expect(t.map((r) => [r.side, r.unit])).toEqual([['left', 1], ['right', 2], ['top', 0]]);
    // Junk lines (titles, notes) are skipped, not turned into pins.
    expect(parsePinTable('Table 5-1. Pin functions\n1\tA\n— see note').skipped).toHaveLength(2);
  });

  it('layouts: by function, as on the package, from the table; every pin on the 2.54 mm grid', () => {
    const { rows } = parsePinTable(BUCK);
    const auto = buildSymbolUnits(rows, { layout: 'auto' })[0]!;
    expect(byNumber(auto.pins)).toEqual({ 1: 'top', 2: 'bottom', 3: 'left', 5: 'left', 8: 'left', 4: 'right', 6: 'right', 7: 'right' });
    const pkg = buildSymbolUnits(rows, { layout: 'package' })[0]!;
    expect(byNumber(pkg.pins)).toEqual({ 1: 'left', 2: 'left', 3: 'left', 4: 'left', 5: 'right', 6: 'right', 7: 'right', 8: 'right' });
    // Package order: left side top → bottom 1..4, right side bottom → top 5..8 (8 at the top).
    const right = pkg.pins.filter((p) => side(p) === 'right').sort((a, b) => a.at.y - b.at.y).map((p) => p.number);
    expect(right).toEqual(['8', '7', '6', '5']);
    const table = buildSymbolUnits(rows.map((r) => ({ ...r, side: 'bottom' as const })), { layout: 'table' })[0]!;
    expect(new Set(table.pins.map(side))).toEqual(new Set(['bottom']));
    for (const u of [auto, pkg, table]) {
      for (const p of u.pins) expect(onGrid(p.at.x) && onGrid(p.at.y), `${p.number} ${p.at.x},${p.at.y}`).toBe(true);
      // Pins sit outside the body and point into it.
      const r = u.graphics[0] as { a: { x: number; y: number }; b: { x: number; y: number } };
      for (const p of u.pins) expect(p.at.x <= r.a.x || p.at.x >= r.b.x || p.at.y <= r.a.y || p.at.y >= r.b.y).toBe(true);
    }
    // Order by name.
    const named = buildSymbolUnits(rows, { layout: 'auto', order: 'name' })[0]!;
    expect(named.pins.filter((p) => side(p) === 'left').map((p) => p.name)).toEqual(['EN', 'FB', 'SS']);
  });

  it('splits units: a unit column and a separate power unit', () => {
    const { rows } = parsePinTable('1 OUTA\n2 -INA\n3 +INA\n4 V-\n5 +INB\n6 -INB\n7 OUTB\n8 V+');
    const units = buildSymbolUnits(rows.map((r, i) => ({ ...r, ...([1, 1, 1, undefined, 2, 2, 2, undefined][i] ? { unit: [1, 1, 1, 0, 2, 2, 2, 0][i]! } : {}) })), { powerUnit: true });
    expect(units.map((u) => u.pins.map((p) => p.number).sort())).toEqual([['1', '2', '3'], ['5', '6', '7'], ['4', '8']]);
    expect(byNumber(units[2]!.pins)).toEqual({ 8: 'top', 4: 'bottom' });
    expect(() => buildSymbolUnits([{ number: '1', name: 'A', type: 'passive' }, { number: '1', name: 'B', type: 'passive' }])).toThrow(/Pin number 1 is used 2 times/);
    expect(() => buildSymbolUnits([{ number: '1', name: 'A', type: 'passive', unit: 3 }])).toThrow(/Unit A has no pins/);
  });

  it('create_symbol stores the part; place_part places it; calling again updates placed copies', async () => {
    const p = newProject('t');
    const r = (await runTool(p, 'create_symbol', { name: 'TPS54302X', pins: BUCK, footprint: 'sot-23-6' })) as { id: string; units: { pins: string[] }[] };
    expect(r.id).toBe('project:tps54302x');
    const def = p.doc.meta['part:project:tps54302x'] as PartDef;
    expect(def.units).toHaveLength(1);
    expect(def.footprint).toBe('sot-23-6');
    await runTool(p, 'place_part', { id: r.id, x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: -30, y: 0 });
    await runTool(p, 'add_label', { pin: 'U1.3', name: 'EN' });
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'EN' });
    expect(extractNetlist(p.doc, p.engine).byPin.get('U1.3')).toBe(extractNetlist(p.doc, p.engine).byPin.get('R1.1'));
    // Edit: package layout. The placed copy is redrawn (EN now on the left, third from the top).
    const u = (await runTool(p, 'create_symbol', { name: 'TPS54302X', pins: BUCK, layout: 'package' })) as { updated: boolean; placedCopiesRedrawn: number };
    expect(u.updated).toBe(true);
    expect(u.placedCopiesRedrawn).toBe(1);
    expect((p.doc.meta['part:project:tps54302x'] as PartDef).footprint).toBe('sot-23-6');
    const pins = syms(p, 'U1')[0]!.children.map((c) => p.doc.nodes.get(c)!);
    const pt = (n: string) => pinPoint(p.doc, p.engine, pins.find((x) => x.props.number === n)!)!;
    expect(pt('1').x).toBe(pt('3').x);
    expect(pt('1').y).toBeLessThan(pt('3').y);
    for (const k of ['1', '5', '8']) expect(onGrid(pt(k).x) && onGrid(pt(k).y)).toBe(true);
    // The table can be read back for editing.
    expect(partPinRows(p.doc.meta['part:project:tps54302x'] as PartDef).options.layout).toBe('package');
    await expect(runTool(p, 'create_symbol', { name: 'Bad', pins: 'Nothing here' })).rejects.toThrow(/pin table is empty/);
  });

  it('create_symbol with a power unit gives a multi-unit part; add_part ic takes pin sides', async () => {
    const p = newProject('t');
    const r = (await runTool(p, 'create_symbol', { name: 'Dual', pin_list: [
      { number: '1', name: 'OUTA', type: 'O', unit: 'A' }, { number: '2', name: '-INA', type: 'I', unit: 'A' }, { number: '3', name: '+INA', type: 'I', unit: 'A' },
      { number: '5', name: '+INB', type: 'I', unit: 'B' }, { number: '6', name: '-INB', type: 'I', unit: 'B' }, { number: '7', name: 'OUTB', type: 'O', unit: 'B' },
      { number: '4', name: 'V-', type: 'P' }, { number: '8', name: 'V+', type: 'P' },
    ], power_unit: true })) as { units: { unit: string }[] };
    expect(r.units.map((u) => u.unit)).toEqual(['A', 'B', 'C (power)']);
    const a = (await runTool(p, 'add_part', { kind: 'ic', x: 0, y: 0, pins: 4, pin_names: ['VCC', 'IN', 'OUT', 'GND'], pin_layout: 'auto' })) as { ref: string };
    const sym = syms(p, a.ref)[0]!;
    const pinAngle = (n: string) => p.engine.get(sym.children.map((c) => p.doc.nodes.get(c)!).find((x) => x.props.number === n)!.uid, 'rotation')!.value;
    expect([pinAngle('1'), pinAngle('4')]).toEqual([270, 90]);
    const b = (await runTool(p, 'add_part', { kind: 'ic', x: 50, y: 0, pins: 3, pin_sides: ['top', 'left', 'right'] })) as { ref: string };
    const s2 = syms(p, b.ref)[0]!;
    const rot = Object.fromEntries(s2.children.map((c) => [String(p.doc.nodes.get(c)!.props.number), p.engine.get(c, 'rotation')!.value]));
    expect(rot).toEqual({ 1: 270, 2: 0, 3: 180 });
    await expect(runTool(p, 'add_part', { kind: 'ic', x: 0, y: 50, pins: 2, pin_sides: ['up', 'left'] })).rejects.toThrow(/left, right, top or bottom/);
  });
});
