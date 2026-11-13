/**
 * P10 (docs/05-pcb-improvements.md), first part: a pair's width and gap from its differential impedance,
 * and lengths compared in time with each layer's propagation delay.
 */
import { describe, expect, it } from 'vitest';
import { defaultStackup, diffImpedance, diffPairs, lineGeometry, netLengths, netSignals, newUid, pairGeometry, propagationDelay, stackupOf, type Stackup, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

async function board(): Promise<Project> {
  const p = newProject('pairs');
  await runTool(p, 'add_part', { kind: 'connector', pins: 4, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 4, x: 30, y: 0 });
  for (const [net, pins] of [['USB_P', ['J1.1', 'J2.1']], ['USB_N', ['J1.2', 'J2.2']], ['A', ['J1.3', 'J2.3']], ['B', ['J1.4', 'J2.4']]] as const)
    for (const pin of pins) await runTool(p, 'add_label', { pin, name: net, global: true });
  await runTool(p, 'update_pcb', {});
  return p;
}
const rule = (p: Project, net: string, name: string) => p.engine.get([...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === net)!.uid, name)?.value;
const addTrace = (p: Project, net: string, a: Vec2, b: Vec2, layer: string) => {
  const n = [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === net)!;
  p.history.apply('t', [{ op: 'add', parent: n.uid, index: n.children.length, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: a }, { name: 'end', value: b }, { name: 'layer', value: layer }], parent: n.uid, children: [] }] } }]);
};

describe('differential pairs (P10, first part)', () => {
  it('stripline is slower than microstrip (propagation delay from the stackup)', () => {
    const st: Stackup = defaultStackup(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'], 1.6);
    const outer = propagationDelay(lineGeometry(st, 'F.Cu')!, 0.2);
    const inner = propagationDelay(lineGeometry(st, 'In1.Cu')!, 0.2);
    expect(outer).toBeGreaterThan(5);
    expect(inner).toBeGreaterThan(outer);
    // FR-4 stripline: √4.4 / c ≈ 7.0 ps/mm.
    expect(inner).toBeCloseTo(7.0, 0);
  });

  it('pair width and gap meet the differential impedance', () => {
    const g = lineGeometry(defaultStackup(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'], 1.6), 'F.Cu')!;
    const pg = pairGeometry(g, 90, 0.2)!;
    expect(pg.gap).toBe(0.2);
    expect(Math.abs(diffImpedance(g, pg.width, pg.gap) - 90)).toBeLessThan(1);
  });

  it('an interface preset on one half sizes both halves of the pair (classify_nets)', async () => {
    const p = await board();
    await runTool(p, 'set_stackup', { thickness: 0.8 });
    await runTool(p, 'set_pin_signal', { target: 'USB_P', net: true, interface: 'usb2' });
    const s = Object.fromEntries(netSignals(p.doc).map((x) => [x.net, x]));
    expect(s.USB_N).toMatchObject({ signal: 'diff-pair', interface: 'usb2', diffImpedance: 90, pair: 'USB_P' });
    await runTool(p, 'classify_nets', { apply: true });
    const g = lineGeometry(stackupOf(p.doc, p.copper), 'F.Cu')!;
    for (const net of ['USB_P', 'USB_N']) {
      const w = rule(p, net, 'traceWidth') as number;
      const gap = rule(p, net, 'diffGap') as number;
      expect(gap).toBeGreaterThan(0);
      expect(Math.abs(diffImpedance(g, w, gap) - 90)).toBeLessThan(1);
    }
    // A diffImpedance rule set by hand on the net wins over the preset.
    await runTool(p, 'set_rule', { target: 'net#"USB_P"', rule: 'diffImpedance', value: '100' });
    await runTool(p, 'classify_nets', { apply: true });
    expect(Math.abs(diffImpedance(g, rule(p, 'USB_P', 'traceWidth') as number, rule(p, 'USB_P', 'diffGap') as number) - 100)).toBeLessThan(1);
  });

  it('net lengths carry delays; a pair set by hand is found and its skew given in length and time', async () => {
    const p = await board();
    addTrace(p, 'A', { x: 100, y: 100 }, { x: 110, y: 100 }, 'F.Cu');
    addTrace(p, 'B', { x: 100, y: 102 }, { x: 112, y: 102 }, 'F.Cu');
    await runTool(p, 'set_pin_signal', { target: 'A', net: true, pair: 'B' });
    const st = stackupOf(p.doc, p.copper);
    const lens = netLengths(p.doc, p.engine, st);
    const d = propagationDelay(lineGeometry(st, 'F.Cu')!, 0.25);
    expect(lens.find((l) => l.net === 'A')!.delay).toBeCloseTo(10 * d, 0);
    const pair = diffPairs(lens).find((x) => x.p === 'A' || x.n === 'A')!;
    expect(pair).toMatchObject({ skew: 2 });
    expect(pair.skewPs).toBeCloseTo(2 * d, 0);
    const r = (await runTool(p, 'net_lengths', {})) as { pairs: { skewPs?: number }[] };
    expect(r.pairs.some((x) => x.skewPs !== undefined)).toBe(true);
  });
});
