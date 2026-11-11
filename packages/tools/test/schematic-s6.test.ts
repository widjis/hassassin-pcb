import { describe, expect, it } from 'vitest';
import { annotateOps, computeRatsnest, extractNetlist, runDrc } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const refs = (p: Project) => [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && !n.props.power).map((n) => `${n.props.ref}@${JSON.stringify(p.engine.get(n.uid, 'position')!.value)}`).sort();
const refAt = (p: Project, x: number, y: number) => {
  // Parts snap so their pins sit on the 2.54 mm grid: take the symbol nearest to (x, y).
  let best: { ref: string; d: number } | null = null;
  for (const s of p.doc.nodes.values()) {
    if (s.type !== 'symbol' || s.props.power) continue;
    const v = p.engine.get(s.uid, 'position')!.value as { x: number; y: number };
    const d = Math.hypot(v.x - x, v.y - y);
    if (!best || d < best.d) best = { ref: String(s.props.ref), d };
  }
  return best && best.d < 2.6 ? best.ref : 'none';
};
const groups = (p: Project) =>
  extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();

describe('S6: annotation', () => {
  it('reset renumbers per prefix top-to-bottom, then left-to-right', async () => {
    const p = newProject('t');
    // Placed out of order: R1 bottom-right, R2 top-left, R3 top-right; C1 bottom, C2 top.
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 25.4 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    await runTool(p, 'add_part', { kind: 'capacitor', x: 0, y: 25.4 });
    await runTool(p, 'add_part', { kind: 'capacitor', x: 15.24, y: 0 });
    const out = (await runTool(p, 'annotate', { mode: 'reset' })) as { renamed: number };
    expect(out.renamed).toBeGreaterThan(0);
    expect(refAt(p, 0, 0)).toBe('R1');
    expect(refAt(p, 30.48, 0)).toBe('R2');
    expect(refAt(p, 30.48, 25.4)).toBe('R3');
    expect(refAt(p, 15.24, 0)).toBe('C1');
    expect(refAt(p, 0, 25.4)).toBe('C2');
  });

  it('keep only numbers parts without a number and duplicates', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 }); // R1
    await runTool(p, 'add_part', { kind: 'resistor', x: 10.16, y: 0, ref: 'R5' });
    await runTool(p, 'add_part', { kind: 'resistor', x: 20.32, y: 0, ref: 'R6' });
    // Make a duplicate R5 by hand (the tools refuse to create one).
    const r6 = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === 'R6')!;
    p.history.apply('dup', [{ op: 'setProp', uid: r6.uid, key: 'ref', value: 'R5' }, { op: 'setName', uid: r6.uid, name: 'R5' }]);
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    const r7 = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === 'R2')!;
    p.history.apply('q', [{ op: 'setProp', uid: r7.uid, key: 'ref', value: 'R?' }, { op: 'setName', uid: r7.uid, name: 'R?' }]);
    const before = refs(p);
    p.history.apply('a', annotateOps(p.doc, p.engine, { mode: 'keep' }).ops);
    expect(refAt(p, 0, 0)).toBe('R1');
    expect(refAt(p, 10.16, 0)).toBe('R5');
    const others = [refAt(p, 20.32, 0), refAt(p, 30.48, 0)].sort();
    expect(others).toEqual(['R2', 'R3']);
    p.history.undo();
    expect(refs(p)).toEqual(before);
  });

  it('one sheet only leaves other sheets and their numbers alone', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, ref: 'R9' });
    const res = annotateOps(p.doc, p.engine, { mode: 'reset', sheet: 'no-such-sheet' });
    expect(res.renames).toEqual([]);
  });

  it('a routed board keeps its copper connected after annotate + update_pcb', async () => {
    const p = newProject('t');
    const parts: [string, number, Record<string, unknown>][] = [['connector', 60, { pins: 2 }], ['resistor', 15, { value: '1k' }], ['led', 30, {}], ['resistor', 0, { value: '2k' }]];
    for (const [kind, x, extra] of parts) await runTool(p, 'add_part', { kind, x, y: 0, ...extra });
    await runTool(p, 'add_label', { pin: 'J1.1', name: 'VCC', global: true });
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'VCC', global: true });
    await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
    await runTool(p, 'add_label', { pin: 'D1.1', name: 'GND', global: true });
    await runTool(p, 'add_label', { pin: 'J1.2', name: 'GND', global: true });
    await runTool(p, 'add_label', { pin: 'R2.1', name: 'VCC', global: true });
    await runTool(p, 'add_label', { pin: 'R2.2', name: 'GND', global: true });
    await runTool(p, 'update_pcb', {});
    await runTool(p, 'auto_place', {});
    await runTool(p, 'autoroute', {});
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(0);
    const drcBefore = runDrc(p.doc, p.engine, p.copper).violations.length;
    const shape = groups(p).length;
    const out = (await runTool(p, 'annotate', { mode: 'reset' })) as { renames: Record<string, string> };
    expect(Object.keys(out.renames).length).toBeGreaterThan(0);
    // Board components were renamed with their symbols.
    for (const to of Object.values(out.renames)) expect([...p.doc.nodes.values()].some((n) => n.type === 'element' && n.name === to)).toBe(true);
    await runTool(p, 'update_pcb', {});
    expect(groups(p).length).toBe(shape);
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(0);
    expect(runDrc(p.doc, p.engine, p.copper).violations.length).toBe(drcBefore);
  });
});
