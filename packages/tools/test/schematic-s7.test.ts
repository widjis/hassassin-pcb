import { describe, expect, it } from 'vitest';
import { extractNetlist, newUid, symbolBounds, type Op, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const groups = (p: Project) =>
  extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
const wires = (p: Project): [Vec2, Vec2][] => [...p.doc.nodes.values()].filter((n) => n.type === 'wire').map((w) => [p.engine.get(w.uid, 'start')!.value as Vec2, p.engine.get(w.uid, 'end')!.value as Vec2]);
const sym = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === ref)!;
const crossesBox = ([a, b]: [Vec2, Vec2], r: { minX: number; minY: number; maxX: number; maxY: number }) => {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x1 > r.minX + 0.05 && x0 < r.maxX - 0.05 && y1 > r.minY + 0.05 && y0 < r.maxY - 0.05;
};

describe('S7: wires that avoid symbols and pins', () => {
  it('connect_pins goes around a part in the way instead of through its body or pins', async () => {
    const p = newProject('t');
    // Three resistors side by side on a row, horizontal (rotated): R1 … R2 … R3.
    for (const x of [0, 15.24, 30.48]) await runTool(p, 'add_part', { kind: 'resistor', x, y: 0, rotation: 90 });
    for (const r of ['R1', 'R2', 'R3']) await runTool(p, 'move_symbol', { ref: r, rotation: 90 });
    // R1's right pin to R3's left pin: the straight line would run through R2.
    await runTool(p, 'connect_pins', { from: 'R1.2', to: 'R3.1' });
    const g = groups(p);
    expect(g.some((x) => x.includes('R1.2') && x.includes('R3.1'))).toBe(true);
    expect(g.some((x) => x.includes('R2.'))).toBe(false);
    const body = symbolBounds(p.doc, p.engine, sym(p, 'R2').uid);
    // The symbol bounds include R2's pin ends; the wire stays outside that box.
    for (const w of wires(p)) expect(crossesBox(w, body)).toBe(false);
  });

  it('when every route is blocked, connect_pins fails and suggests labels', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 50.8, y: 0 });
    // Labels of another net on all four grid points next to R2.2: every approach would touch one.
    const sheet = [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!;
    const tip = { x: 50.8, y: 3.81 };
    const ops: Op[] = [[1.27, 0], [-1.27, 0], [0, 1.27], [0, -1.27]].map(([dx, dy], i) => ({
      op: 'add',
      parent: sheet.uid,
      index: sheet.children.length + i,
      tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name: 'OTHER', props: { kind: 'local' }, rules: [{ name: 'position', value: { x: tip.x + dx!, y: tip.y + dy! } }, { name: 'rotation', value: 0 }], parent: sheet.uid, children: [] }] },
    }));
    p.history.apply('fence', ops);
    const before = wires(p).length;
    await expect(runTool(p, 'connect_pins', { from: 'R1.2', to: 'R2.2' })).rejects.toThrow(/add_label/);
    expect(wires(p).length).toBe(before);
  });

  it('a simple connection needs at most two bends and stays out of part bodies', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 5.08 });
    const out = (await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' })) as { bends: number };
    expect(out.bends).toBeLessThanOrEqual(2);
    for (const ref of ['R1', 'D1']) {
      const b = symbolBounds(p.doc, p.engine, sym(p, ref).uid);
      // Only the pin ends touch the part's own bounds; nothing runs through its middle.
      const mid = { minX: b.minX + 0.6, minY: b.minY + 1.3, maxX: b.maxX - 0.6, maxY: b.maxY - 1.3 };
      for (const w of wires(p)) expect(crossesBox(w, mid)).toBe(false);
    }
  });
});
