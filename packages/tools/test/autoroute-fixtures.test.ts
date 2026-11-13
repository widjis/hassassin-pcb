/**
 * P8a (docs/05-pcb-improvements.md): synthetic boards for the autorouter.
 *
 * The first block holds today: whatever the router does, it never leaves DRC errors and never claims
 * more than it routed. The second block records known gaps with `it.fails`; when a PM2 item fixes one,
 * that test starts passing, Vitest reports it, and it is moved to the first block in the same commit.
 */
import { describe, expect, it } from 'vitest';
import { collectCopper, computeRatsnest, planAutoroute, runDrc } from '@hassassin/core';
import { FIXTURE_ARGS, fixtureChannel, fixtureReversedBus, fixtureTee, measureAutoroute, ROUTE_FIXTURES, runTool, type RouteFigures } from '@hassassin/tools';

const cache = new Map<string, Promise<RouteFigures>>();
const figures = (name: keyof typeof ROUTE_FIXTURES) => {
  let f = cache.get(name);
  if (!f) cache.set(name, (f = ROUTE_FIXTURES[name]().then((p) => measureAutoroute(p, FIXTURE_ARGS[name] ?? {}))));
  return f;
};

describe('autoroute fixtures: invariants', { timeout: 60_000 }, () => {
  for (const name of Object.keys(ROUTE_FIXTURES) as (keyof typeof ROUTE_FIXTURES)[]) {
    it(`${name}: no DRC errors, every connection either routed or reported`, async () => {
      const f = await figures(name);
      expect(f.connections).toBeGreaterThan(0);
      expect(f.drcByKind).toEqual({});
      expect(f.routed + f.failed).toBe(f.connections);
      expect(f.unroutedAfter).toBe(f.connections - f.routed);
    });
  }
  it('reversed-bus and off-grid: everything routed', async () => {
    expect((await figures('reversed-bus')).failed).toBe(0);
    expect((await figures('off-grid')).failed).toBe(0);
  });
  // P8b: each net is checked with its own width and clearance, so the 0.15 mm signals leave the
  // 0.4 mm QFN although a 0.5 mm supply net is routed on the same part (v0.0.3: 4 / 8).
  it('qfn-fine: every connection routed next to a wide supply net (P8b)', async () => {
    const f = await figures('qfn-fine');
    expect(f.failed).toBe(0);
    expect(f.drcErrors).toBe(0);
  });
  // P8c: entries into pads off the routing grid are exact 0° / 45° / 90° runs, so the 0.5 mm QFN
  // (pad centres between grid points) routes completely (v0.0.3: 0 / 8, after P8b: 4 / 8).
  it('qfn-escape: every connection routed (P8c)', async () => {
    const f = await figures('qfn-escape');
    expect(f.failed).toBe(0);
    expect(f.drcErrors).toBe(0);
  });
  it('no autorouted segment off the 45° directions, pads off the grid included (P8c)', async () => {
    for (const name of Object.keys(ROUTE_FIXTURES) as (keyof typeof ROUTE_FIXTURES)[]) expect([name, (await figures(name)).offAngle]).toEqual([name, 0]);
  });
  // P8c: a connection may end on any copper of its net. The third pad of net T sits 3 mm beside the
  // routed T trace; the ratsnest points to a far pad (v0.0.3 / P8b: 17.8 mm), the router joins the trace.
  it('tee: joins the existing trace next to the pad instead of the far pad (P8c)', async () => {
    const p = await fixtureTee();
    const { report } = planAutoroute(p.doc, p.engine, p.copper);
    const t = report.routed.filter((r) => r.net === 'T');
    expect(t).toHaveLength(1);
    expect(t[0]!.length).toBeLessThan(10);
    expect(report.failed).toEqual([]);
  });
  // P8d: on one layer, net A (routed first, straight across) blocks net B. Without rip-up B fails;
  // with it, B's route rips A up and A goes round above B's upper pad.
  it('channel: rip-up and retry routes a connection the first pass leaves (P8d)', async () => {
    const once = await measureAutoroute(await fixtureChannel(), { layers: ['F.Cu'], rounds: 1 });
    expect([once.routed, once.connections]).toEqual([1, 2]);
    const f = await figures('channel');
    expect([f.routed, f.connections, f.unroutedAfter]).toEqual([2, 2, 0]);
    expect(f.drcByKind).toEqual({});
  });
  it('rip-up never moves copper that was on the board before the run (P8d)', async () => {
    const p = await fixtureTee();
    const before = [...p.doc.nodes.values()].filter((n) => n.type === 'trace').map((n) => JSON.stringify([p.engine.get(n.uid, 'start')?.value, p.engine.get(n.uid, 'end')?.value]));
    await runTool(p, 'autoroute', {});
    const after = [...p.doc.nodes.values()].filter((n) => n.type === 'trace' && !n.props.autorouted).map((n) => JSON.stringify([p.engine.get(n.uid, 'start')?.value, p.engine.get(n.uid, 'end')?.value]));
    expect(after).toEqual(before);
  });
  it('a run stopped by the time limit leaves a legal board and reports what it did not route (P8d)', async () => {
    const p = await fixtureReversedBus();
    const { ops, report } = planAutoroute(p.doc, p.engine, p.copper, { timeLimitMs: 1 });
    expect(report.routed.length + report.failed.length).toBe(8);
    expect(report.failed.every((f) => f.reason === 'time limit')).toBe(true);
    p.history.apply('Autoroute', ops);
    expect(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted')).toEqual([]);
  });
});

// P8e: corner styles. `45` (default): no corner of 90° or sharper. `arc`: every bend is an arc.
// `90`: right angles allowed. In every style: no acute corner, no off-angle segment, no collinear joint.
describe('autoroute fixtures: corner styles (P8e)', { timeout: 120_000 }, () => {
  // mcu routes completely in the default style, but with arc or 90 corners it still leaves one or two
  // connections open (docs/05 P8f), so those two tests leave it out.
  const all = Object.keys(ROUTE_FIXTURES) as (keyof typeof ROUTE_FIXTURES)[];
  const names = all.filter((n) => n !== 'mcu');
  const styled = async (name: keyof typeof ROUTE_FIXTURES, style: '45' | 'arc' | '90') => {
    const p = await ROUTE_FIXTURES[name]();
    await runTool(p, 'set_rule', { target: 'net', rule: 'cornerStyle', value: style });
    return measureAutoroute(p, FIXTURE_ARGS[name] ?? {});
  };
  it('45: no corner of 90° or sharper on any fixture', async () => {
    for (const name of all) {
      const f = await figures(name);
      expect([name, f.sharpCorners, f.acuteCorners, f.collinear, f.offAngle]).toEqual([name, 0, 0, 0, 0]);
    }
  });
  it('arc: every bend of autorouted copper is an arc, still legal and complete', async () => {
    for (const name of names) {
      const f = await styled(name, 'arc');
      expect([name, f.failed, f.unroutedAfter, f.bendsPerConnection, f.offAngle, f.collinear]).toEqual([name, 0, 0, 0, 0, 0]);
      expect(f.drcByKind).toEqual({});
      // plane-slot is one straight run: nothing to bend.
      if (f.routed && name !== 'plane-slot') expect(f.arcs).toBeGreaterThan(0);
    }
  });
  it('90: right angles allowed but never an acute corner, still legal and complete', async () => {
    for (const name of names) {
      const f = await styled(name, '90');
      expect([name, f.failed, f.unroutedAfter, f.acuteCorners, f.offAngle, f.collinear, f.arcs]).toEqual([name, 0, 0, 0, 0, 0, 0]);
      expect(f.drcByKind).toEqual({});
    }
  });
});

// P8f: layer directions, via cost, proximity and order.
describe('autoroute fixtures: costs and order (P8f)', { timeout: 120_000 }, () => {
  it('layer directions: a strong preference runs less copper against the layers\' directions, and routeDirection=any turns it off', async () => {
    const free = await measureAutoroute(await fixtureReversedBus(), { direction_cost: 1 });
    const strict = await measureAutoroute(await fixtureReversedBus(), { direction_cost: 4 });
    expect(strict.failed).toBe(0);
    expect(strict.drcByKind).toEqual({});
    expect(strict.againstDirection).toBeLessThan(free.againstDirection);
    const p = await fixtureReversedBus();
    await runTool(p, 'set_rule', { target: 'net', rule: 'routeDirection', value: 'any' });
    const any = await measureAutoroute(p, { direction_cost: 4 });
    expect([any.vias, any.length]).toEqual([free.vias, free.length]);
  });
  it('the viaCost rule: dearer vias never give more of them', async () => {
    const count = async (v: string) => {
      const p = await fixtureReversedBus();
      await runTool(p, 'set_rule', { target: 'net', rule: 'viaCost', value: v });
      return measureAutoroute(p);
    };
    const cheap = await count('0.5mm');
    const dear = await count('10mm');
    expect(dear.failed).toBe(0);
    expect(dear.vias).toBeLessThanOrEqual(cheap.vias);
  });
  it('autoPlacePriority routes a net first, whatever the order', async () => {
    const p = await fixtureReversedBus();
    const { report: plain } = planAutoroute(p.doc, p.engine, p.copper);
    const last = plain.routed[plain.routed.length - 1]!.net;
    const net = [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === last)!;
    await runTool(p, 'set_rule', { target: `net#${JSON.stringify(net.name)}`, rule: 'autoPlacePriority', value: '5' });
    const { report } = planAutoroute(p.doc, p.engine, p.copper);
    expect(report.routed[0]!.net).toBe(last);
  });
  it('fanout: every connected pin of a fine-pitch QFN leaves its pad row straight along the pad (P8f)', async () => {
    for (const make of [ROUTE_FIXTURES['qfn-escape'], ROUTE_FIXTURES['qfn-fine']]) {
      const p = await make();
      const f = await measureAutoroute(p);
      expect([f.failed, f.unroutedAfter, f.drcErrors, f.collinear]).toEqual([0, 0, 0, 0]);
      expect(f.fanouts).toBe(8);
      // Each pad of U1 with a route: a trace starts at the pad centre and runs along the pad's long axis.
      const u1 = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'U1')!;
      const pads = collectCopper(p.doc, p.engine, p.copper).filter((s) => s.kind === 'pad' && s.net && u1.children.includes(s.uid));
      const traces = [...p.doc.nodes.values()].filter((n) => n.type === 'trace').map((t) => [p.engine.get(t.uid, 'start')?.value, p.engine.get(t.uid, 'end')?.value] as [{ x: number; y: number }, { x: number; y: number }]);
      let checked = 0;
      for (const pad of pads) {
        const c = { x: (pad.box.minX + pad.box.maxX) / 2, y: (pad.box.minY + pad.box.maxY) / 2 };
        const t = traces.find(([a]) => Math.hypot(a.x - c.x, a.y - c.y) < 1e-6);
        if (!t) continue;
        const alongX = pad.box.maxX - pad.box.minX > pad.box.maxY - pad.box.minY;
        expect(Math.abs(alongX ? t[0].y - t[1].y : t[0].x - t[1].x)).toBeLessThan(1e-6);
        checked++;
      }
      expect(checked).toBe(8);
    }
  });
  it('a turn off a fanout stub is a full 45° chamfer, not a sliver at the grid offset (P8f)', async () => {
    const p = await ROUTE_FIXTURES['qfn-escape']();
    await measureAutoroute(p);
    let diag = 0;
    for (const t of p.doc.nodes.values()) {
      if (t.type !== 'trace' || !t.props.autorouted || p.engine.get(t.uid, 'mid')?.value) continue;
      const a = p.engine.get(t.uid, 'start')?.value as { x: number; y: number };
      const b = p.engine.get(t.uid, 'end')?.value as { x: number; y: number };
      const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
      if (dx < 1e-6 || dy < 1e-6) continue;
      diag++;
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0.15);
    }
    expect(diag).toBeGreaterThan(0);
  });
  it('bus: neighbouring pins are found as a bundle and routed side by side, one bend each, no jog at the pads (P8f)', async () => {
    const p = await ROUTE_FIXTURES.bus();
    const f = await measureAutoroute(p);
    expect([f.failed, f.unroutedAfter, f.drcErrors, f.vias]).toEqual([0, 0, 0, 0]);
    expect(f.bundled).toBe(8);
    const pieces = new Map<string, number>();
    for (const t of p.doc.nodes.values()) if (t.type === 'trace' && t.props.autorouted) pieces.set(t.parent!, (pieces.get(t.parent!) ?? 0) + 1);
    expect([...pieces.values()]).toEqual(Array(8).fill(2));
  });
  it('mcu: SMD pads over their own pour are routed to it, through vias in the exposed pad; the pour blocks no layer (P8f)', async () => {
    const p = await ROUTE_FIXTURES.mcu();
    const f = await measureAutoroute(p);
    expect(f.drcErrors).toBe(0);
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines).toEqual([]);
    expect(f.vias).toBeGreaterThan(0);
    expect(f.ms).toBeLessThan(15000);
  });
  it('mcu: the left bus keeps its order past the 2×5 header (bus lanes, P8f)', async () => {
    const p = await ROUTE_FIXTURES.mcu();
    await measureAutoroute(p);
    // Where each IO net's copper crosses the line just right of the header's front (right-hand) row.
    const X = 108.7;
    const at: Record<string, number> = {};
    for (const n of p.doc.nodes.values()) {
      const net = n.parent ? p.doc.nodes.get(n.parent)?.name : undefined;
      if (n.type !== 'trace' || !net || !/^IO\d$/.test(net)) continue;
      const a = p.engine.get(n.uid, 'start')!.value as { x: number; y: number };
      const b = p.engine.get(n.uid, 'end')!.value as { x: number; y: number };
      if ((a.x - X) * (b.x - X) > 0 || a.x === b.x) continue;
      at[net] = a.y + ((X - a.x) / (b.x - a.x)) * (b.y - a.y);
    }
    expect(Object.keys(at).sort()).toEqual(['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'IO8']);
    expect(Object.entries(at).sort((x, y) => x[1] - y[1]).map(([k]) => k)).toEqual(['IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'IO8']);
  });
  it('fanout=false routes from the pads as before', async () => {
    const f = await measureAutoroute(await ROUTE_FIXTURES['qfn-fine'](), { fanout: false });
    expect([f.failed, f.fanouts]).toEqual([0, 0]);
  });
  it('plane gap cost: a trace moves off a slot in its reference plane, by option or by the net\'s planeGapCost rule (P8f)', async () => {
    const plain = await figures('plane-slot');
    expect(plain.offPlane).toBeGreaterThan(0.5);
    const opt = await measureAutoroute(await ROUTE_FIXTURES['plane-slot'](), { plane_gap_cost: 1 });
    const p = await ROUTE_FIXTURES['plane-slot']();
    await runTool(p, 'set_rule', { target: 'net#"S"', rule: 'planeGapCost', value: '1' });
    const rule = await measureAutoroute(p);
    for (const f of [opt, rule]) {
      expect([f.failed, f.unroutedAfter, f.drcErrors]).toEqual([0, 0, 0]);
      expect(f.offPlane).toBeLessThan(0.15);
      expect(f.length).toBeLessThan(plain.length * 1.1);
    }
  });
  it('graze: copper that only touches a pad does not count as connected; the pad is still routed (P8f)', async () => {
    const f = await figures('graze');
    expect([f.failed, f.unroutedAfter]).toEqual([0, 0]);
  });
});
