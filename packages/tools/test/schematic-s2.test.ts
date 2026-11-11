import { describe, expect, it } from 'vitest';
import { extractNetlist, itemsInRect, transformSelectionOps, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

function groups(p: Project): string[] {
  return extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
}
const sym = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === ref)!;
const sheetOf = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!.uid;
const slanted = (p: Project) =>
  [...p.doc.nodes.values()].filter((n) => n.type === 'wire').filter((w) => {
    const a = p.engine.get(w.uid, 'start')!.value as Vec2, b = p.engine.get(w.uid, 'end')!.value as Vec2;
    return Math.abs(a.x - b.x) > 1e-3 && Math.abs(a.y - b.y) > 1e-3;
  }).length;

async function circuit(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '1k' });
  await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 5.08 });
  await runTool(p, 'add_part', { kind: 'capacitor', x: 60.96, y: 0 });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await runTool(p, 'connect_pins', { from: 'R1.1', to: 'C1.1' });
  await runTool(p, 'add_power', { pin: 'R1.1', net: '+5V' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  return p;
}

describe('S2: box selection and group edits', () => {
  it('left→right takes only what is fully inside; right→left also what it touches', async () => {
    const p = await circuit();
    const sheet = sheetOf(p);
    const r1 = sym(p, 'R1').uid, d1 = sym(p, 'D1').uid, c1 = sym(p, 'C1').uid;
    const inside = itemsInRect(p.doc, p.engine, sheet, { minX: -10, minY: -10, maxX: 25, maxY: 25 }, 'inside');
    expect(inside).toContain(r1);
    expect(inside).toContain(d1);
    expect(inside).not.toContain(c1);
    // The long R1–C1 wire reaches past the box: not inside, but touched.
    const touch = itemsInRect(p.doc, p.engine, sheet, { minX: -10, minY: -10, maxX: 25, maxY: 25 }, 'touch');
    expect(touch.length).toBeGreaterThan(inside.length);
    expect(touch).not.toContain(c1);
  });

  it('rotating and mirroring a group keeps the netlist and right angles, and undoes in one step', async () => {
    const p = await circuit();
    const before = groups(p);
    const sheet = sheetOf(p);
    const sel = itemsInRect(p.doc, p.engine, sheet, { minX: -10, minY: -12, maxX: 25, maxY: 25 }, 'inside');
    const snapshot = JSON.stringify([...p.doc.nodes.values()].filter((n) => n.type === 'wire' || n.type === 'symbol').map((n) => [n.uid, p.engine.get(n.uid, 'position')?.value, p.engine.get(n.uid, 'start')?.value]).sort());
    for (const how of ['rotate', 'mirror-h', 'rotate', 'mirror-v'] as const) {
      p.history.apply(how, transformSelectionOps(p.doc, p.engine, sel, how));
      expect(groups(p), how).toEqual(before);
      expect(slanted(p), how).toBe(0);
    }
    for (let i = 0; i < 4; i++) p.history.undo();
    const now = JSON.stringify([...p.doc.nodes.values()].filter((n) => n.type === 'wire' || n.type === 'symbol').map((n) => [n.uid, p.engine.get(n.uid, 'position')?.value, p.engine.get(n.uid, 'start')?.value]).sort());
    expect(now).toBe(snapshot);
  });

  it('four group rotations bring every symbol back to where it was', async () => {
    const p = await circuit();
    const sheet = sheetOf(p);
    const sel = itemsInRect(p.doc, p.engine, sheet, { minX: -10, minY: -12, maxX: 25, maxY: 25 }, 'inside');
    const at = (ref: string) => JSON.stringify(p.engine.get(sym(p, ref).uid, 'position')!.value);
    const r = at('R1'), d = at('D1');
    for (let i = 0; i < 4; i++) p.history.apply('rot', transformSelectionOps(p.doc, p.engine, sel, 'rotate'));
    expect(at('R1')).toBe(r);
    expect(at('D1')).toBe(d);
  });
});
