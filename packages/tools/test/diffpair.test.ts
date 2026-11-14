/**
 * P10 (docs/05-pcb-improvements.md), first part: a pair's width and gap from its differential impedance,
 * and lengths compared in time with each layer's propagation delay.
 */
import { describe, expect, it } from 'vitest';
import { defaultStackup, diffImpedance, diffPairs, withCoupling, lineGeometry, netLengths, netSignals, newUid, pairGeometry, propagationDelay, segSegDist, stackupOf, type Stackup, type Vec2 } from '@hassassin/core';
import { fixturePairs, measureAutoroute, newProject, runTool, type Project } from '@hassassin/tools';

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

  const traces = (p: Project, net: string) =>
    [...p.doc.nodes.values()]
      .filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net)
      .map((n) => ({ a: p.engine.get(n.uid, 'start')!.value as Vec2, b: p.engine.get(n.uid, 'end')!.value as Vec2, layer: String(p.engine.get(n.uid, 'layer')!.value), w: p.engine.get(n.uid, 'traceWidth')!.value as number }));
  const vias = (p: Project, net: string) => [...p.doc.nodes.values()].filter((n) => n.type === 'via' && p.doc.nodes.get(n.parent!)?.name === net).map((n) => p.engine.get(n.uid, 'position')!.value as Vec2);
  /** Length over which the two halves run side by side at the pair's gap (within 0.02 mm). */
  const coupled = (p: Project, a: string, b: string, gap: number) => {
    let len = 0;
    for (const x of traces(p, a))
      for (const y of traces(p, b))
        if (x.layer === y.layer && Math.abs(segSegDist(x.a, x.b, y.a, y.b) - x.w / 2 - y.w / 2 - gap) < 0.02) {
          const dx = x.b.x - x.a.x, dy = x.b.y - x.a.y, ex = y.b.x - y.a.x, ey = y.b.y - y.a.y;
          if (Math.abs(dx * ey - dy * ex) < 1e-6 * Math.hypot(dx, dy) * Math.hypot(ex, ey) + 1e-9) len += Math.min(Math.hypot(dx, dy), Math.hypot(ex, ey));
        }
    return len;
  };

  it('routes both pairs together: coupled at their gap, mirrored breakouts, tiny skew, no sharp corner', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    const f = await measureAutoroute(p);
    expect([f.failed, f.unroutedAfter, f.drcErrors, f.sharpCorners, f.acuteCorners]).toEqual([0, 0, 0, 0, 0]);
    expect(f.pairs).toBe(2);
    for (const [a, b] of [['USB_P', 'USB_N'], ['LV_P', 'LV_N']] as const) {
      const gap = rule(p, a, 'diffGap') as number;
      // Most of the way (about 30 mm between the headers) side by side at the gap.
      expect(coupled(p, a, b, gap)).toBeGreaterThan(20);
    }
    const lens = diffPairs(netLengths(p.doc, p.engine, stackupOf(p.doc, p.copper)));
    // USB 2.0 allows 1.27 mm; together they come out far inside it.
    for (const d of lens) expect(d.skew).toBeLessThan(0.2);
  });

  it('coupled and uncoupled length of a routed pair, against diffUncoupledMax', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    await measureAutoroute(p);
    const r = (await runTool(p, 'net_lengths', {})) as { pairs: { p: string; coupled?: number; uncoupled?: number; uncoupledMax?: number }[] };
    for (const d of r.pairs) {
      // Only the breakouts at the two headers run apart; the default diff-pair ruleset allows 6 mm.
      expect(d.coupled).toBeGreaterThan(20);
      expect(d.uncoupled).toBeLessThan(d.uncoupledMax!);
      expect(d.uncoupledMax).toBe(6);
    }
    expect(r.pairs.length).toBe(2);
    // Taking one trace of a half out leaves that much more of the pair apart.
    const before = r.pairs.find((d) => d.p === 'USB_P')!;
    const t = [...p.doc.nodes.values()].filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === 'USB_N').sort((a, b) => {
      const len = (n: typeof a) => { const x = p.engine.get(n.uid, 'start')!.value as Vec2, y = p.engine.get(n.uid, 'end')!.value as Vec2; return Math.hypot(y.x - x.x, y.y - x.y); };
      return len(b) - len(a);
    })[0]!;
    p.history.apply('cut', [{ op: 'remove', uid: t.uid }]);
    const after = ((await runTool(p, 'net_lengths', {})) as typeof r).pairs.find((d) => d.p === 'USB_P')!;
    expect(after.coupled!).toBeLessThan(before.coupled! - 1);
    expect(after.uncoupled!).toBeGreaterThan(before.uncoupled! + 1);
  });

  it('autoroute lists pairs whose halves run apart longer than diffUncoupledMax', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    const ok = (await runTool(p, 'autoroute', {})) as { uncoupledOver?: unknown[] };
    // Within the default 6 mm: nothing listed.
    expect(ok.uncoupledOver).toBeUndefined();
    const q = await fixturePairs();
    for (const net of ['USB_P', 'USB_N']) await runTool(q, 'set_rule', { target: `net#"${net}"`, rule: 'diffUncoupledMax', value: '0.1mm' });
    const r = (await runTool(q, 'autoroute', {})) as { uncoupledOver?: { pair: string; uncoupled: number; max: number }[] };
    expect(r.uncoupledOver?.map((x) => x.pair)).toEqual(['USB']);
    expect(r.uncoupledOver![0]!.uncoupled).toBeGreaterThan(0.1);
    expect(r.uncoupledOver![0]!.max).toBeCloseTo(0.1, 6);
  });

  it('other nets keep the pair clearance (3 W) from a pair; its partner keeps only the gap', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    const dpc = rule(p, 'USB_P', 'diffPairClearance') as number;
    // classify_nets: 2 × the width edge to edge (3 W centre to centre).
    expect(dpc).toBeCloseTo(2 * (rule(p, 'USB_P', 'traceWidth') as number), 1);
    expect(dpc).toBeGreaterThan(rule(p, 'USB_P', 'diffGap') as number);
    const f = await measureAutoroute(p);
    expect([f.failed, f.drcErrors]).toEqual([0, 0]);
    const nets = ['USB_P', 'USB_N', 'S1', 'LV_P', 'LV_N', 'S2'];
    const partner: Record<string, string> = { USB_P: 'USB_N', USB_N: 'USB_P', LV_P: 'LV_N', LV_N: 'LV_P' };
    // Pads are exempt, so only away from the headers (x 108 – 132).
    const inside = (t: { a: Vec2; b: Vec2 }) => Math.min(t.a.x, t.b.x) > 108 && Math.max(t.a.x, t.b.x) < 132;
    for (const a of ['USB_P', 'USB_N', 'LV_P', 'LV_N'])
      for (const b of nets) {
        if (b === a || b === partner[a]) continue;
        const need = Math.max(dpc, rule(p, b, 'diffPairClearance') as number ?? 0);
        for (const x of traces(p, a).filter(inside))
          for (const y of traces(p, b).filter(inside))
            if (x.layer === y.layer) expect(segSegDist(x.a, x.b, y.a, y.b) - x.w / 2 - y.w / 2).toBeGreaterThan(need - 0.01);
      }
  });

  it('a pair that must change layer gets two vias side by side', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    // Copper of S1 across the board: on B.Cu at x = 115, on F.Cu at x = 125, so the pairs change layer between.
    const n = [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === 'S1')!;
    const wall = (x: number, layer: string) => ({ op: 'add' as const, parent: n.uid, index: n.children.length, tree: { nodes: [{ uid: newUid('tr'), type: 'trace' as const, name: '', props: {}, rules: [{ name: 'start', value: { x, y: 100.6 } }, { name: 'end', value: { x, y: 133.4 } }, { name: 'layer', value: layer }], parent: n.uid, children: [] }] } });
    p.history.apply('walls', [wall(115, 'B.Cu'), wall(125, 'F.Cu')]);
    const f = await measureAutoroute(p);
    expect([f.failed, f.drcErrors, f.sharpCorners]).toEqual([0, 0, 0]);
    expect(f.pairs).toBe(2);
    for (const [a, b] of [['USB_P', 'USB_N'], ['LV_P', 'LV_N']] as const) {
      const va = vias(p, a), vb = vias(p, b);
      expect([va.length, vb.length]).toEqual([1, 1]);
      // Side by side: across the direction of travel, between 115 and 125.
      const d = Math.hypot(va[0]!.x - vb[0]!.x, va[0]!.y - vb[0]!.y);
      expect(d).toBeGreaterThan(0.6);
      expect(d).toBeLessThan(1.2);
      for (const v of [...va, ...vb]) expect(v.x > 115 && v.x < 125).toBe(true);
    }
    // P10 acceptance: coupled at the computed gap across the layer change, skew within the USB 2.0 preset.
    const pairs = withCoupling(p.doc, p.engine, diffPairs(netLengths(p.doc, p.engine, stackupOf(p.doc, p.copper))));
    expect(pairs).toHaveLength(2);
    for (const d of pairs) {
      expect(d.coupled!).toBeGreaterThan(20);
      expect(d.skew).toBeLessThan(1.27);
    }
  });
});
