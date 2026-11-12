/**
 * P8a (docs/05-pcb-improvements.md): synthetic boards for the autorouter.
 *
 * The first block holds today: whatever the router does, it never leaves DRC errors and never claims
 * more than it routed. The second block records known gaps with `it.fails`; when a PM2 item fixes one,
 * that test starts passing, Vitest reports it, and it is moved to the first block in the same commit.
 */
import { describe, expect, it } from 'vitest';
import { planAutoroute, runDrc } from '@hassassin/core';
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

describe('autoroute fixtures: known gaps', { timeout: 60_000 }, () => {
  // P8e: right-angle and acute corners come out of the search. Checked over all fixtures together, so a
  // fixture that happens to route without one does not flip the test.
  it.fails('no corner of 90° or sharper on any fixture (P8e)', async () => {
    let sharp = 0;
    for (const name of Object.keys(ROUTE_FIXTURES) as (keyof typeof ROUTE_FIXTURES)[]) sharp += (await figures(name)).sharpCorners;
    expect(sharp).toBe(0);
  });
});
