import { describe, expect, it } from 'vitest';
import { dragWireOps, extractNetlist, junctionOps, withJunctionsOps, newUid, type Op, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

function groups(p: Project): string[] {
  return extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
}
const sheet = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!;
const junctions = (p: Project) => [...p.doc.nodes.values()].filter((n) => n.type === 'junction').map((j) => p.engine.get(j.uid, 'position')!.value as Vec2);
const wireOp = (p: Project, a: Vec2, b: Vec2): Op => {
  const s = sheet(p);
  return { op: 'add', parent: s.uid, index: s.children.length, tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: a }, { name: 'end', value: b }], parent: s.uid, children: [] }] } };
};
const draw = (p: Project, a: Vec2, b: Vec2) => p.history.apply('wire', withJunctionsOps(p.doc, p.engine, [wireOp(p, a, b)]));
const wireAt = (p: Project, a: Vec2, b: Vec2) =>
  [...p.doc.nodes.values()].find((n) => {
    if (n.type !== 'wire') return false;
    const s = p.engine.get(n.uid, 'start')!.value as Vec2, e = p.engine.get(n.uid, 'end')!.value as Vec2;
    const eq = (u: Vec2, v: Vec2) => Math.abs(u.x - v.x) < 1e-3 && Math.abs(u.y - v.y) < 1e-3;
    return (eq(s, a) && eq(e, b)) || (eq(s, b) && eq(e, a));
  })!;

describe('S4: junctions and wire editing', () => {
  it('a wire ending on the middle of another connects and gets a junction; a plain crossing does not', () => {
    const p = newProject('t');
    draw(p, { x: 0, y: 0 }, { x: 20.32, y: 0 });
    draw(p, { x: 10.16, y: 0 }, { x: 10.16, y: 10.16 }); // T
    expect(junctions(p)).toEqual([{ x: 10.16, y: 0 }]);
    draw(p, { x: 15.24, y: -5.08 }, { x: 15.24, y: 5.08 }); // crosses the first wire, no end on it
    expect(junctions(p).length).toBe(1);
  });

  it('netlist: T connects, crossing does not', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 20.32, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 10.16, y: 20.32 });
    // R1.2 (0, 3.81) — R2.2 (20.32, 3.81) straight; R3.1 (10.16, 16.51) up to its middle.
    draw(p, { x: 0, y: 3.81 }, { x: 20.32, y: 3.81 });
    draw(p, { x: 10.16, y: 16.51 }, { x: 10.16, y: 3.81 });
    expect(groups(p)).toContain('R1.2 R2.2 R3.1');
    expect(junctions(p).length).toBe(1);
    // Removing the T wire removes the junction too.
    const t = wireAt(p, { x: 10.16, y: 16.51 }, { x: 10.16, y: 3.81 });
    p.history.apply('del', withJunctionsOps(p.doc, p.engine, [{ op: 'remove', uid: t.uid }]));
    expect(junctions(p).length).toBe(0);
    // A wire from R3.1 that crosses the R1–R2 wire without ending on it stays separate.
    draw(p, { x: 10.16, y: 16.51 }, { x: 10.16, y: -5.08 });
    expect(groups(p)).toEqual(['R1.2 R2.2']);
    expect(junctions(p).length).toBe(0);
  });

  it('connect_pins and add_power add junctions where they branch', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 15.24, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    await runTool(p, 'connect_pins', { from: 'R1.1', to: 'R2.1' });
    await runTool(p, 'connect_pins', { from: 'R2.1', to: 'R3.1' });
    // R2.1 now has two wires and a pin: a junction.
    const need = junctionOps(p.doc, p.engine, sheet(p).uid);
    expect(need).toEqual([]);
    expect(junctions(p).length).toBeGreaterThanOrEqual(1);
  });

  it('dragging a wire segment stretches its neighbours and keeps the netlist', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 20.32, y: 0 });
    // U-shaped route from R1.2 (0, 3.81) down, across, up to R2.2 (20.32, 3.81).
    draw(p, { x: 0, y: 3.81 }, { x: 0, y: 8.89 });
    draw(p, { x: 0, y: 8.89 }, { x: 20.32, y: 8.89 });
    draw(p, { x: 20.32, y: 8.89 }, { x: 20.32, y: 3.81 });
    const before = groups(p);
    const mid = wireAt(p, { x: 0, y: 8.89 }, { x: 20.32, y: 8.89 });
    const n0 = [...p.doc.nodes.values()].filter((n) => n.type === 'wire').length;
    // Asked to move diagonally: a horizontal wire only moves down.
    p.history.apply('drag', dragWireOps(p.doc, p.engine, mid.uid, { x: 5.08, y: 5.08 }));
    expect(p.engine.get(mid.uid, 'start')!.value).toEqual({ x: 0, y: 13.97 });
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'wire').length).toBe(n0);
    expect(groups(p)).toEqual(before);
    // The side wires stretched and stay vertical.
    expect(wireAt(p, { x: 0, y: 3.81 }, { x: 0, y: 13.97 })).toBeTruthy();
  });

  it('dragging a wire that ends on a pin adds a short wire so the pin stays connected', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 20.32, y: 0 });
    // Straight horizontal wire between the two pins 2 is impossible (they are vertical); use pins at y 3.81.
    draw(p, { x: 0, y: 3.81 }, { x: 20.32, y: 3.81 });
    const before = groups(p);
    const w = wireAt(p, { x: 0, y: 3.81 }, { x: 20.32, y: 3.81 });
    p.history.apply('drag', dragWireOps(p.doc, p.engine, w.uid, { x: 0, y: 5.08 }));
    expect(groups(p)).toEqual(before);
    expect(wireAt(p, { x: 0, y: 3.81 }, { x: 0, y: 8.89 })).toBeTruthy();
  });
});
