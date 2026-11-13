/**
 * P16 (docs/05-pcb-improvements.md): signal classes from pins, guessed from names or set by hand, written
 * onto nets, and the default rulesets that give each class its width, clearance, via cost and corner style.
 */
import { describe, expect, it } from 'vitest';
import { clearanceForVoltage, impedance, lineGeometry, netSignals, segSegDist, stackupOf, widthForCurrent, type Vec2 } from '@hassassin/core';
import { fixtureBus, measureAutoroute, newProject, runTool, type Project } from '@hassassin/tools';

async function board(): Promise<Project> {
  const p = newProject('signals');
  await runTool(p, 'add_part', { kind: 'ic', pins: 10, x: 0, y: 0, pin_names: ['GPIO1', 'FB', 'SW', 'RF_OUT', 'GPIO5', 'ADC0', 'GPIO7', 'GPIO8', 'VDD', 'GND'] });
  await runTool(p, 'add_part', { kind: 'ic', pins: 2, x: 30, y: 0, value: 'Crystal 16MHz' });
  await runTool(p, 'add_part', { kind: 'connector', pins: 10, x: -30, y: 0 });
  await runTool(p, 'add_part', { kind: 'inductor', x: 30, y: 30 });
  const wire = async (net: string, ...pins: string[]) => {
    for (const pin of pins) await runTool(p, 'add_label', { pin, name: net, global: true });
  };
  await wire('N_X', 'U1.1', 'U2.1');
  await wire('N_FB', 'U1.2', 'J1.1');
  await wire('N_SW', 'U1.3', 'L1.1');
  await wire('ANT1', 'U1.4', 'J1.2');
  await wire('MCLK', 'U1.5', 'J1.3');
  await wire('N_A', 'U1.6', 'J1.4');
  await wire('USB_P', 'U1.7', 'J1.5');
  await wire('USB_N', 'U1.8', 'J1.6');
  await wire('VCC', 'U1.9', 'L1.2', 'J1.7');
  await wire('GND', 'U1.10', 'U2.2', 'J1.8');
  await wire('DATA', 'J1.9', 'J1.10');
  await runTool(p, 'update_pcb', {});
  return p;
}

const netUid = (p: Project, name: string) => [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === name)!.uid;
const rule = (p: Project, net: string, name: string) => p.engine.get(netUid(p, net), name)?.value;

describe('signal classes (P16)', () => {
  it('guesses a class for each net from pin, net and part names', async () => {
    const p = await board();
    const cls = Object.fromEntries(netSignals(p.doc).map((s) => [s.net, s.signal]));
    expect(cls).toMatchObject({
      N_X: 'sensitive',
      N_FB: 'sensitive',
      N_SW: 'switching',
      ANT1: 'rf',
      MCLK: 'clock',
      N_A: 'analog',
      USB_P: 'diff-pair',
      USB_N: 'diff-pair',
      VCC: 'power',
      GND: 'ground',
      DATA: 'general',
    });
    expect(netSignals(p.doc).find((s) => s.net === 'USB_P')!.pair).toBe('USB_N');
  });

  it('applied classes give the default width, via cost and corner style', async () => {
    const p = await board();
    const before = (await runTool(p, 'classify_nets', {})) as { applied: boolean };
    expect(before.applied).toBe(false);
    expect(rule(p, 'ANT1', 'cornerStyle')).toBeUndefined();
    await runTool(p, 'classify_nets', { apply: true });
    expect(rule(p, 'ANT1', 'cornerStyle')).toBe('arc');
    expect(rule(p, 'ANT1', 'viaCost')).toBe(20);
    expect(rule(p, 'N_SW', 'traceWidth')).toBe(0.6);
    expect(rule(p, 'MCLK', 'viaCost')).toBe(8);
    expect(rule(p, 'USB_P', 'planeGapCost')).toBe(2);
    expect(rule(p, 'VCC', 'traceWidth')).toBe(0.5);
    expect(rule(p, 'DATA', 'traceWidth')).toBe(0.25);
    expect(rule(p, 'DATA', 'viaCost')).toBeUndefined();
  });

  it('a pin set by hand beats a guess, and a class set on the net beats its pins', async () => {
    const p = await board();
    await runTool(p, 'set_pin_signal', { target: 'J1.9', signal: 'high-current' });
    await runTool(p, 'set_pin_signal', { target: 'MCLK', signal: 'general', net: true });
    await runTool(p, 'classify_nets', { apply: true });
    const s = Object.fromEntries(netSignals(p.doc).map((x) => [x.net, x]));
    expect(s.DATA).toMatchObject({ signal: 'high-current', source: 'pin' });
    expect(s.MCLK).toMatchObject({ signal: 'general', source: 'net' });
    expect(rule(p, 'DATA', 'traceWidth')).toBe(1);
    expect(rule(p, 'MCLK', 'viaCost')).toBeUndefined();
    // Re-running keeps the hand-set net class.
    await runTool(p, 'classify_nets', { apply: true });
    expect(netSignals(p.doc).find((x) => x.net === 'MCLK')!.source).toBe('net');
  });

  it('changing the class changes what the router does (RF net gets arc corners)', { timeout: 60_000 }, async () => {
    const plain = await measureAutoroute(await fixtureBus());
    expect(plain.arcs).toBe(0);
    const p = await fixtureBus();
    for (const n of ['B1', 'B2']) await runTool(p, 'set_pin_signal', { target: n, signal: 'rf', net: true });
    const f = await measureAutoroute(p);
    expect(f.arcs).toBeGreaterThan(0);
    expect(f.drcByKind).toEqual({});
    expect(f.failed).toBe(0);
  });

  it('width from the current and clearance from the voltage (IPC-2221)', () => {
    expect(widthForCurrent(1)).toBe(0.35);
    expect(widthForCurrent(3)).toBe(1.4);
    expect(widthForCurrent(3, 0.07)).toBe(0.7);
    expect(clearanceForVoltage(12)).toBe(0.1);
    expect(clearanceForVoltage(230)).toBe(1.25);
    expect(clearanceForVoltage(600)).toBe(3);
  });

  it('a current or voltage on a pin raises the class and sets the net width / clearance', async () => {
    const p = await board();
    await runTool(p, 'set_pin_signal', { target: 'J1.9', current: 3 });
    await runTool(p, 'set_pin_signal', { target: 'J1.7', voltage: 230 });
    const r = (await runTool(p, 'classify_nets', { apply: true })) as { rules: { net: string }[] };
    const s = Object.fromEntries(netSignals(p.doc).map((x) => [x.net, x]));
    expect(s.DATA).toMatchObject({ signal: 'high-current', source: 'pin', current: 3 });
    expect(s.VCC).toMatchObject({ signal: 'high-voltage', voltage: 230 });
    expect(rule(p, 'DATA', 'traceWidth')).toBe(1.4);
    expect(JSON.stringify(rule(p, 'VCC', 'keepOut'))).toContain('1.25');
    expect(r.rules.map((x) => x.net).sort()).toEqual(['DATA', 'VCC']);
    // Removing the current removes the computed width; the class falls back to the guess.
    await runTool(p, 'set_pin_signal', { target: 'J1.9', current: 0 });
    await runTool(p, 'classify_nets', { apply: true });
    expect(rule(p, 'DATA', 'traceWidth')).toBe(0.25);
    expect(netSignals(p.doc).find((x) => x.net === 'DATA')!.signal).toBe('general');
  });

  it('a width set by hand on the net is kept and reported', async () => {
    const p = await board();
    await runTool(p, 'set_rule', { target: 'net#"DATA"', rule: 'traceWidth', value: '2mm' });
    await runTool(p, 'set_pin_signal', { target: 'J1.9', current: 3 });
    const r = (await runTool(p, 'classify_nets', { apply: true })) as { rules: { net: string; kept?: string[] }[] };
    expect(rule(p, 'DATA', 'traceWidth')).toBe(2);
    expect(r.rules.find((x) => x.net === 'DATA')!.kept).toEqual(['traceWidth']);
  });

  it('a target impedance sets the width from the stackup and makes the net high-speed', async () => {
    const p = await board();
    await runTool(p, 'set_pin_signal', { target: 'J1.9', impedance: 50 });
    const thick = (await runTool(p, 'classify_nets', { apply: true })) as { rules: { net: string; note?: string }[] };
    expect(netSignals(p.doc).find((x) => x.net === 'DATA')).toMatchObject({ signal: 'high-speed', impedance: 50 });
    const g = lineGeometry(stackupOf(p.doc, p.copper), 'F.Cu')!;
    const w = rule(p, 'DATA', 'traceWidth') as number;
    expect(Math.abs(impedance(g, w) - 50)).toBeLessThan(0.5);
    // On a 1.6 mm two-layer board 50 Ω is a very wide trace, and the tool says so.
    expect(w).toBeGreaterThan(1.5);
    expect(thick.rules.find((x) => x.net === 'DATA')!.note).toMatch(/thinner dielectric/);
    // A 0.4 mm board brings it down to a routable width.
    await runTool(p, 'set_stackup', { thickness: 0.4 });
    await runTool(p, 'classify_nets', { apply: true });
    const w2 = rule(p, 'DATA', 'traceWidth') as number;
    expect(w2).toBeLessThan(w);
    expect(Math.abs(impedance(lineGeometry(stackupOf(p.doc, p.copper), 'F.Cu')!, w2) - 50)).toBeLessThan(0.5);
  });

  it('switching nets keep their classClearance from analog / sensitive traces', { timeout: 60_000 }, async () => {
    // Edge-to-edge distance between the autorouted traces of two nets.
    const gap = (p: Project, a: string, b: string) => {
      const segs = (net: string) =>
        [...p.doc.nodes.values()]
          .filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net)
          .map((t) => ({ a: p.engine.get(t.uid, 'start')!.value as Vec2, b: p.engine.get(t.uid, 'end')!.value as Vec2, w: p.engine.get(t.uid, 'traceWidth')!.value as number, l: p.engine.get(t.uid, 'layer')!.value }));
      let m = Infinity;
      for (const x of segs(a)) for (const y of segs(b)) if (x.l === y.l) m = Math.min(m, segSegDist(x.a, x.b, y.a, y.b) - x.w / 2 - y.w / 2);
      return m;
    };
    const plain = await fixtureBus();
    await measureAutoroute(plain);
    expect(gap(plain, 'B4', 'B5')).toBeLessThan(2);
    expect(gap(plain, 'B4', 'B3')).toBeLessThan(2);
    const p = await fixtureBus();
    await runTool(p, 'set_pin_signal', { target: 'B4', signal: 'switching', net: true });
    await runTool(p, 'set_pin_signal', { target: 'B5', signal: 'sensitive', net: true });
    await runTool(p, 'set_pin_signal', { target: 'B3', signal: 'analog', net: true });
    // The default is 1 mm; this bus already keeps 1.5 mm, so ask for more on the switching net.
    await runTool(p, 'set_rule', { target: 'net#"B4"', rule: 'classClearance', value: 'analog(2mm) sensitive(2mm)' });
    const f = await measureAutoroute(p);
    expect(f.failed).toBe(0);
    expect(f.drcByKind).toEqual({});
    expect(gap(p, 'B4', 'B5')).toBeGreaterThanOrEqual(2 - 1e-3);
    expect(gap(p, 'B4', 'B3')).toBeGreaterThanOrEqual(2 - 1e-3);
  });
});
