/**
 * Placing a library part from the Parts panel: the new symbol goes to the nearest free place, so none of
 * its pins lands on existing wires or labels and connects by accident (bug: an ESP32 module placed between
 * two sub-sheet blocks joined the SYS / GND / SCL / SDA … wires running between them).
 */
import { describe, expect, it } from 'vitest';
import { extractNetlist, freeSymbolSpot, genericPart, itemsInRect, newUid, placePartOps, type Op, type PartDef, type Vec2 } from '@hassassin/core';
import { newProject, type Project } from '@hassassin/tools';

const sheetOf = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!;
const wire = (sheet: string, a: Vec2, b: Vec2, i: number): Op => ({ op: 'add', parent: sheet, index: i, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: a }, { name: 'end', value: b }], parent: sheet, children: [] }] } });

/** A module with pins down both sides, every 2.54 mm (like an ESP32 module). */
function module(): PartDef {
  const pins = Array.from({ length: 20 }, (_, i) => ({ number: String(i + 1), name: `P${i + 1}`, type: 'passive' as const, at: { x: i < 10 ? -12.7 : 12.7, y: -12.7 + (i % 10) * 2.54 }, angle: i < 10 ? 0 : 180, length: 2.54 }));
  const base = genericPart('ic', { pins: 4 });
  return { ...base, id: 'test:module', name: 'MODULE', prefix: 'U', units: [{ pins, graphics: [{ t: 'rect', a: { x: -10.16, y: -15.24 }, b: { x: 10.16, y: 12.7 } }] }] } as PartDef;
}

const extOf = (part: PartDef) => {
  const u = part.units[0]!;
  const xs = [...u.pins.map((q) => q.at.x), -10.16, 10.16];
  const ys = [...u.pins.map((q) => q.at.y), -15.24, 12.7];
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs) + 8, maxY: Math.max(...ys) };
};

describe('placing a part on a sheet with wiring', () => {
  it('finds the nearest place clear of wires, so no pin joins a net', () => {
    const p = newProject('t');
    const sheet = sheetOf(p);
    // Seven horizontal wires 11.7 mm apart across the middle of the sheet (between two blocks).
    p.history.apply('wires', Array.from({ length: 7 }, (_, i) => wire(sheet.uid, { x: 20, y: 40 + i * 11.68 }, { x: 160, y: 40 + i * 11.68 }, sheet.children.length + i)));
    const part = module();
    const ext = extOf(part);
    const start = { x: 91.44, y: 76.2 };
    // At the view centre the module would sit on the wires.
    expect(itemsInRect(p.doc, p.engine, sheet.uid, { minX: start.x + ext.minX, minY: start.y + ext.minY, maxX: start.x + ext.maxX, maxY: start.y + ext.maxY }, 'touch').length).toBeGreaterThan(0);
    const at = freeSymbolSpot(p.doc, p.engine, sheet.uid, ext, start);
    expect(itemsInRect(p.doc, p.engine, sheet.uid, { minX: at.x + ext.minX - 2.54, minY: at.y + ext.minY - 2.54, maxX: at.x + ext.maxX + 2.54, maxY: at.y + ext.maxY + 2.54 }, 'touch')).toEqual([]);
    // Placed there, no pin end of the module touches a wire.
    p.history.apply('place', placePartOps(p.doc, sheet.uid, part, at).ops);
    const u1 = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === 'U1')!;
    const ends = extractNetlist(p.doc, p.engine).nets.filter((n) => n.pins.some((x) => x.ref === 'U1'));
    expect(ends.every((n) => n.pins.length === 1)).toBe(true);
    expect(u1.children.length).toBeGreaterThanOrEqual(20);
  });

  it('keeps the view centre when it is free, and steps past other symbols', () => {
    const p = newProject('t');
    const sheet = sheetOf(p);
    const part = module();
    const ext = extOf(part);
    const start = { x: 50.8, y: 50.8 };
    expect(freeSymbolSpot(p.doc, p.engine, sheet.uid, ext, start)).toEqual(start);
    p.history.apply('place', placePartOps(p.doc, sheet.uid, part, start).ops);
    const next = freeSymbolSpot(p.doc, p.engine, sheet.uid, ext, start);
    expect(next).not.toEqual(start);
    expect(itemsInRect(p.doc, p.engine, sheet.uid, { minX: next.x + ext.minX - 2.54, minY: next.y + ext.minY - 2.54, maxX: next.x + ext.maxX + 2.54, maxY: next.y + ext.maxY + 2.54 }, 'touch')).toEqual([]);
  });
});
