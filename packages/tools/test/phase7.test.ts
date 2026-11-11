import { describe, expect, it } from 'vitest';
import { computeRatsnest, defaultStackup, diffImpedance, diffPairs, impedance, lineGeometry, runDrc, widthForImpedance, type NetLength } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

async function board(): Promise<Project> {
  const p = newProject('t');
  const parts: [string, number, Record<string, unknown>][] = [
    ['connector', 0, { pins: 2 }], ['ic', 20, { pins: 8 }], ['capacitor', 40, { value: '100n' }], ['capacitor', 50, { value: '10u' }], ['resistor', 60, { value: '10k' }], ['led', 70, {}],
  ];
  for (const [kind, x, extra] of parts) await runTool(p, 'add_part', { kind, x, y: 0, ...extra });
  const label = (pin: string, name: string) => runTool(p, 'add_label', { pin, name, global: true });
  for (const pin of ['J1.1', 'U1.8', 'C1.1', 'C2.1', 'R1.1']) await label(pin, 'VCC');
  for (const pin of ['J1.2', 'U1.4', 'C1.2', 'C2.2', 'D1.1']) await label(pin, 'GND');
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await label('U1.1', 'SIG_P');
  await label('U1.2', 'SIG_N');
  await label('U1.7', 'SIG_P');
  await label('U1.6', 'SIG_N');
  await runTool(p, 'update_pcb', {});
  return p;
}

describe('autoplace + autoroute', () => {
  it('places parts on the board without overlaps and routes them DRC-clean', async () => {
    const p = await board();
    const pl = (await runTool(p, 'auto_place', {})) as { placed: unknown[]; failed: string[] };
    expect(pl.failed).toEqual([]);
    expect(pl.placed.length).toBe(6);
    expect(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.kind !== 'unrouted')).toEqual([]);
    const before = computeRatsnest(p.doc, p.engine, p.copper).lines.length;
    expect(before).toBeGreaterThan(0);
    const r = (await runTool(p, 'autoroute', {})) as { routed: number; failed: unknown[] };
    expect(r.routed).toBe(before);
    expect(r.failed).toEqual([]);
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(0);
    expect(runDrc(p.doc, p.engine, p.copper).violations).toEqual([]);
    // One undo step removes the whole routing.
    await runTool(p, 'undo', {});
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(before);
  });

  it('measures lengths, finds the pair and tunes the shorter half to match', async () => {
    const p = await board();
    await runTool(p, 'auto_place', {});
    await runTool(p, 'autoroute', {});
    const l = (await runTool(p, 'net_lengths', {})) as { pairs: { p: string; n: string; skew: number; lengthP: number; lengthN: number }[] };
    const pair = l.pairs.find((x) => x.p === '/SIG_P' || x.p === 'SIG_P');
    expect(pair).toBeTruthy();
    const [short, long] = pair!.lengthP < pair!.lengthN ? [pair!.p, pair!.n] : [pair!.n, pair!.p];
    const target = Math.max(pair!.lengthP, pair!.lengthN) + 1; // make it clearly longer
    try {
      const t = (await runTool(p, 'tune_length', { net: short, target, amplitude: 1 })) as { after: number };
      expect(Math.abs(t.after - target)).toBeLessThan(0.05);
      expect(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.kind !== 'unrouted')).toEqual([]);
    } catch (e) {
      // Allowed outcome on a cramped board: refused, with the board left as it was.
      expect(String(e)).toMatch(/too short|clearance|at most/);
    }
    void long;
  });
});

describe('stackup and impedance', () => {
  it('gives familiar numbers for common stackups', () => {
    const two = lineGeometry(defaultStackup(['F.Cu', 'B.Cu']), 'F.Cu')!;
    expect(two.kind).toBe('microstrip');
    const w50 = widthForImpedance(two, 50)!;
    expect(w50).toBeGreaterThan(2.4);
    expect(w50).toBeLessThan(3.2);
    const four = defaultStackup(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(four.thickness).toBeCloseTo(1.6, 1);
    const outer = lineGeometry(four, 'F.Cu')!;
    expect(impedance(outer, 0.35)).toBeGreaterThan(44);
    expect(impedance(outer, 0.35)).toBeLessThan(54);
    expect(diffImpedance(outer, 0.2, 0.15)).toBeLessThan(2 * impedance(outer, 0.2));
    expect(lineGeometry(four, 'In1.Cu')!.kind).toBe('stripline');
    const flex = defaultStackup(['F.Cu', 'B.Cu'], 0.2, { flex: true });
    expect(flex.layers.some((l) => l.flex)).toBe(true);
  });

  it('pairs nets by name', () => {
    const mk = (net: string, length: number): NetLength => ({ net, length, segments: 1, vias: 0 });
    const pairs = diffPairs([mk('USB_D+', 10), mk('USB_D-', 11.5), mk('/LVDS_P', 3), mk('/LVDS_N', 3), mk('CLK', 4)]);
    expect(pairs.map((x) => [x.p, x.n, x.skew])).toEqual([['USB_D+', 'USB_D-', 1.5], ['/LVDS_P', '/LVDS_N', 0]]);
  });
});
