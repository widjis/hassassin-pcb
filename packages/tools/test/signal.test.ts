/**
 * P16 (docs/05-pcb-improvements.md): signal classes from pins, guessed from names or set by hand, written
 * onto nets, and the default rulesets that give each class its width, clearance, via cost and corner style.
 */
import { describe, expect, it } from 'vitest';
import { netSignals } from '@hassassin/core';
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
});
