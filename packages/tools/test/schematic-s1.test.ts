import { describe, expect, it } from 'vitest';
import { applyOps, extractNetlist, moveSymbolsOps, runErc, snapshotWires, straightenWiresOps, toggleMirror, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

/** Nets as sorted lists of pins, independent of net names. */
function groups(p: Project): string[] {
  const nl = extractNetlist(p.doc, p.engine);
  return nl.nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
}
const sym = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === ref)!;
const wires = (p: Project): [Vec2, Vec2][] => [...p.doc.nodes.values()].filter((n) => n.type === 'wire').map((w) => [p.engine.get(w.uid, 'start')!.value as Vec2, p.engine.get(w.uid, 'end')!.value as Vec2]);
const slanted = (p: Project) => wires(p).filter(([a, b]) => Math.abs(a.x - b.x) > 1e-3 && Math.abs(a.y - b.y) > 1e-3).length;

async function circuit(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '1k' });
  await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 5.08 });
  await runTool(p, 'add_part', { kind: 'capacitor', x: 30.48, y: 0 });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await runTool(p, 'connect_pins', { from: 'R1.1', to: 'C1.1' });
  await runTool(p, 'add_power', { pin: 'R1.1', net: '+5V' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  await runTool(p, 'add_power', { pin: 'C1.2', net: 'GND' });
  return p;
}
const move = (p: Project, ops: ReturnType<typeof moveSymbolsOps>) => p.history.apply('move', ops);

describe('S1: wires follow moved symbols', () => {
  it('moving a symbol keeps the netlist identical and the wires orthogonal', async () => {
    const p = await circuit();
    const before = groups(p);
    expect(before.length).toBeGreaterThan(1);
    expect(slanted(p)).toBe(0);
    const r1 = sym(p, 'R1');
    const at = p.engine.get(r1.uid, 'position')!.value as Vec2;
    move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: r1.uid, position: { x: at.x + 7.62, y: at.y - 5.08 } }]));
    expect(groups(p)).toEqual(before);
    expect(slanted(p)).toBe(0);
    expect(runErc(p.doc, p.engine).violations.filter((v) => v.severity === 'error')).toEqual([]);
  });

  it('the +5V stub and its power symbol travel with the pin', async () => {
    const p = await circuit();
    const port = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.power && n.props.Value === '+5V')!;
    const portAt = p.engine.get(port.uid, 'position')!.value as Vec2;
    const r1 = sym(p, 'R1');
    const at = p.engine.get(r1.uid, 'position')!.value as Vec2;
    move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: r1.uid, position: { x: at.x - 10.16, y: at.y } }]));
    const now = p.engine.get(port.uid, 'position')!.value as Vec2;
    expect(now.x).toBeCloseTo(portAt.x - 10.16, 6);
    expect(now.y).toBeCloseTo(portAt.y, 6);
    const lbl = p.doc.nodes.get(port.children[0]!)!;
    expect(p.engine.get(lbl.uid, 'position')!.value).toEqual(now);
  });

  it('rotate and mirror keep the netlist; one undo restores everything', async () => {
    const p = await circuit();
    const before = groups(p);
    const wiresBefore = JSON.stringify(wires(p).map((w) => JSON.stringify(w)).sort());
    const d1 = sym(p, 'D1');
    move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: d1.uid, rotation: 90 }]));
    expect(groups(p)).toEqual(before);
    expect(slanted(p)).toBe(0);
    const m = toggleMirror(90, 'none', 'h');
    move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: d1.uid, rotation: m.rotation, mirror: m.mirror }]));
    expect(groups(p)).toEqual(before);
    expect(slanted(p)).toBe(0);
    p.history.undo();
    p.history.undo();
    expect(JSON.stringify(wires(p).map((w) => JSON.stringify(w)).sort())).toBe(wiresBefore);
  });

  it('every orientation of every part keeps the netlist (mirror swaps pins along a wire)', async () => {
    let worstSlanted = 0;
    for (const ref of ['R1', 'D1', 'C1']) {
      const p = await circuit();
      const before = groups(p);
      const startWires = wires(p).length;
      const s = sym(p, ref);
      let rot = 0;
      let mir: 'none' | 'x' | 'y' = 'none';
      for (const step of ['r', 'h', 'r', 'v', 'r', 'h', 'r', 'v'] as const) {
        if (step === 'r') rot = (rot + 90) % 360;
        else ({ rotation: rot, mirror: mir } = toggleMirror(rot, mir, step) as { rotation: number; mirror: 'none' | 'x' | 'y' });
        move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: s.uid, rotation: rot, mirror: mir }]));
        expect(groups(p), `${ref} after ${step} (rot ${rot}, mirror ${mir})`).toEqual(before);
        worstSlanted = Math.max(worstSlanted, slanted(p));
        // Rebuilt chains and the clean-up keep repeated edits from piling up wire pieces.
        expect(wires(p).length, `${ref} wire count after ${step}`).toBeLessThanOrEqual(startWires + 4);
      }
    }
    console.log('orientation cycle: worst slanted wires', worstSlanted);
  });

  it('moving a power symbol moves its connection point too', async () => {
    const p = await circuit();
    const before = groups(p);
    const gnd = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && n.props.power && n.props.Value === 'GND')[0]!;
    const at = p.engine.get(gnd.uid, 'position')!.value as Vec2;
    move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: gnd.uid, position: { x: at.x + 2.54, y: at.y + 2.54 } }]));
    expect(groups(p)).toEqual(before);
  });

  it('dragging (ends only) then straightening on drop gives the same result as a single move', async () => {
    const p = await circuit();
    const before = groups(p);
    const r1 = sym(p, 'R1');
    const at = p.engine.get(r1.uid, 'position')!.value as Vec2;
    const snap = snapshotWires(p.doc, p.engine, r1.parent!);
    for (let k = 1; k <= 4; k++) move(p, moveSymbolsOps(p.doc, p.engine, [{ uid: r1.uid, position: { x: at.x + 1.27 * k, y: at.y - 1.27 * k } }], { orthogonal: false }));
    applyOps(p.doc, straightenWiresOps(p.doc, p.engine, snap));
    p.engine.recompute();
    expect(groups(p)).toEqual(before);
    expect(slanted(p)).toBe(0);
  });

  it('toggleMirror: two flips cancel, both flips equal a half turn', () => {
    expect(toggleMirror(0, 'none', 'h')).toEqual({ rotation: 0, mirror: 'y' });
    expect(toggleMirror(0, 'y', 'h')).toEqual({ rotation: 0, mirror: 'none' });
    expect(toggleMirror(90, 'y', 'v')).toEqual({ rotation: 270, mirror: 'none' });
  });
});

describe('S1: move_symbol tool', () => {
  it('moves, rotates and mirrors through the tool without breaking nets', async () => {
    const p = await circuit();
    const before = groups(p);
    await runTool(p, 'move_symbol', { ref: 'D1', x: 25.4, y: 20.32 });
    await runTool(p, 'move_symbol', { ref: 'D1', rotation: 270 });
    await runTool(p, 'move_symbol', { ref: 'C1', mirror: 'v' });
    expect(groups(p)).toEqual(before);
    expect(slanted(p)).toBe(0);
  });
});

describe('S1: random edits never change the netlist', () => {
  it('60 random moves / rotations / mirrors keep every net intact', async () => {
    const p = await circuit();
    await runTool(p, 'add_part', { kind: 'resistor', x: 45.72, y: 0, value: '10k' });
    await runTool(p, 'connect_pins', { from: 'R2.1', to: 'C1.1' });
    await runTool(p, 'add_power', { pin: 'R2.2', net: 'GND' });
    const before = groups(p);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const refs = ['R1', 'D1', 'C1', 'R2'];
    let slantedMax = 0;
    let refused = 0;
    const tool = (args: Record<string, unknown>) => runTool(p, 'move_symbol', args).catch((e) => {
      expect(String(e)).toMatch(/would change connections/);
      refused++;
    });
    for (let k = 0; k < 60; k++) {
      const ref = refs[Math.floor(rnd() * refs.length)]!;
      const r = rnd();
      if (r < 0.5) await tool({ ref, x: Math.round(rnd() * 40) * 1.27, y: Math.round(rnd() * 30 - 10) * 1.27 });
      else if (r < 0.8) await tool({ ref, rotation: [0, 90, 180, 270][Math.floor(rnd() * 4)] });
      else await tool({ ref, mirror: rnd() < 0.5 ? 'h' : 'v' });
      expect(groups(p), `after edit ${k} (${ref})`).toEqual(before);
      slantedMax = Math.max(slantedMax, slanted(p));
    }
    console.log('slanted wires at worst:', slantedMax, '· moves refused:', refused, 'of 60');
    expect(refused).toBeLessThan(45); // most random moves are fine
  });
});
