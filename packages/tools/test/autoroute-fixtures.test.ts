/**
 * P8a (docs/05-pcb-improvements.md): synthetic boards for the autorouter.
 *
 * The first block holds today: whatever the router does, it never leaves DRC errors and never claims
 * more than it routed. The second block records known gaps with `it.fails`; when a PM2 item fixes one,
 * that test starts passing, Vitest reports it, and it is moved to the first block in the same commit.
 */
import { describe, expect, it } from 'vitest';
import { measureAutoroute, ROUTE_FIXTURES, type RouteFigures } from '@hassassin/tools';

const cache = new Map<string, Promise<RouteFigures>>();
const figures = (name: keyof typeof ROUTE_FIXTURES) => {
  let f = cache.get(name);
  if (!f) cache.set(name, (f = ROUTE_FIXTURES[name]().then((p) => measureAutoroute(p))));
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
});

describe('autoroute fixtures: known gaps (v0.0.3)', { timeout: 60_000 }, () => {
  // P8b: the clearance zone sized for the 0.5 mm supply net closes the 0.5 mm pitch QFN.
  it.fails('qfn-escape: every connection routed (P8b)', async () => {
    expect((await figures('qfn-escape')).failed).toBe(0);
  });
  // P8e: right-angle and acute corners come out of the search.
  it.fails('reversed-bus: no corner of 90° or sharper (P8e)', async () => {
    expect((await figures('reversed-bus')).sharpCorners).toBe(0);
  });
  it.fails('off-grid: no corner of 90° or sharper (P8e)', async () => {
    expect((await figures('off-grid')).sharpCorners).toBe(0);
  });
});
