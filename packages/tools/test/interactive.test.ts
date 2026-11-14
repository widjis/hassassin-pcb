/**
 * P4 (docs/05-pcb-improvements.md): the interactive router's geometry. Paths walk around other nets'
 * copper and their clearance, stop at the last legal point when the cursor is in the way, vias are refused
 * on other copper, and a dragged segment keeps its neighbours joined at 45° and stops at other copper.
 */
import { describe, expect, it } from 'vitest';
import { computeRatsnest, newUid, offsetPath, pathFree, pointFree, planDragSegment, routeWorld, runDrc, viaFree, walkaround, type Op, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool, type Project } from '@hassassin/tools';

const traces = (p: Project, net: string) =>
  [...p.doc.nodes.values()]
    .filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net)
    .map((n) => ({ uid: n.uid, a: p.engine.get(n.uid, 'start')!.value as Vec2, b: p.engine.get(n.uid, 'end')!.value as Vec2, layer: String(p.engine.get(n.uid, 'layer')!.value) }));
const errors = (p: Project) => new Set(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').map((v) => `${v.kind}|${[...v.uids].sort().join(',')}`));
const lay = (p: Project, net: string, layer: string, path: Vec2[]): Op[] => {
  const n = [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === net)!;
  return path.slice(1).map((b, i) => ({ op: 'add', parent: n.uid, index: n.children.length + i, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: path[i]! }, { name: 'end', value: b }, { name: 'layer', value: layer }], parent: n.uid, children: [] }] } }) as Op);
};
const longest = (p: Project, net: string) => traces(p, net).sort((x, y) => Math.hypot(y.b.x - y.a.x, y.b.y - y.a.y) - Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y))[0]!;
const is45 = (a: Vec2, b: Vec2) => {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return dx < 1e-3 || dy < 1e-3 || Math.abs(dx - dy) < 1e-3;
};

describe('interactive router (P4)', () => {
  it('walks around another net\'s trace: the path is legal, 45°, and laying it adds no DRC error', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const s = longest(p, 'B4');
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const n = { x: -(s.b.y - s.a.y) / L, y: (s.b.x - s.a.x) / L };
    // From one side of B4 to the other, straight across it.
    const from = { x: m.x + n.x * 1.2, y: m.y + n.y * 1.2 };
    const to = { x: m.x - n.x * 1.2, y: m.y - n.y * 1.2 };
    const w = routeWorld(p.doc, p.engine, p.copper, 'B3');
    expect(pathFree(w, s.layer, [from, to])).toBe(false);
    const r = walkaround(w, s.layer, from, to);
    expect(pathFree(w, s.layer, r.path)).toBe(true);
    for (let i = 0; i + 1 < r.path.length; i++) expect(is45(r.path[i]!, r.path[i + 1]!)).toBe(true);
    expect(r.path[0]).toEqual(from);
    if (r.reached) expect(r.path.at(-1)).toEqual(to);
    const before = errors(p);
    p.history.apply('Route', lay(p, 'B3', s.layer, r.path));
    const fresh = [...errors(p)].filter((e) => !before.has(e));
    expect(fresh).toEqual([]);
  });

  it('stops at the last legal point when the cursor is on other copper', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const s = longest(p, 'B4');
    const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
    const L = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    const w = routeWorld(p.doc, p.engine, p.copper, 'B3');
    // The first free spot beside B4 (the bus is dense: other nets lie close on both sides).
    let from: Vec2 | undefined;
    for (let k = 0.5; k < 4 && !from; k += 0.05)
      for (const sg of [1, -1]) {
        const q = { x: m.x - ((s.b.y - s.a.y) / L) * k * sg, y: m.y + ((s.b.x - s.a.x) / L) * k * sg };
        if (!from && pointFree(w, s.layer, q)) from = q;
      }
    expect(from).toBeDefined();
    const r = walkaround(w, s.layer, from!, m);
    expect(r.reached).toBe(false);
    expect(pathFree(w, s.layer, r.path)).toBe(true);
    // It got close: within a trace pitch of B4's clearance zone.
    const end = r.path.at(-1)!;
    expect(Math.hypot(end.x - m.x, end.y - m.y)).toBeLessThan(Math.hypot(from!.x - m.x, from!.y - m.y));
    expect(Math.hypot(end.x - m.x, end.y - m.y)).toBeLessThan(1);
    // A via on B4 is refused.
    expect(viaFree(w, m, 0.6)).toBe(false);

  });

  it('drags a segment sideways: neighbours stay joined at 45°, connections kept, the drag stops at other copper', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const islands = () => new Map(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]));
    const before = islands();
    const s = longest(p, 'B4');
    // A small drag, free of everything.
    const small = planDragSegment(p.doc, p.engine, p.copper, s.uid, 0.05);
    expect(small.error).toBeUndefined();
    expect(small.offset).toBeCloseTo(0.05, 4);
    for (const pc of small.pieces) expect(is45(pc.a, pc.b)).toBe(true);
    p.history.apply('Drag', small.ops);
    expect(islands()).toEqual(before);
    p.history.undo();
    // A large drag towards the neighbours: with the world, it stops short and stays legal.
    const w = routeWorld(p.doc, p.engine, p.copper, 'B4', { ignore: new Set(traces(p, 'B4').map((t) => t.uid)) });
    const errs = errors(p);
    let dragged = 0;
    for (const off of [3, -3]) {
      const big = planDragSegment(p.doc, p.engine, p.copper, s.uid, off, { world: w });
      if (big.error) continue;
      expect(Math.abs(big.offset)).toBeLessThan(3);
      p.history.apply('Drag', big.ops);
      expect([...errors(p)].filter((e) => !errs.has(e))).toEqual([]);
      expect(islands()).toEqual(before);
      p.history.undo();
      dragged++;
    }
    expect(dragged).toBeGreaterThan(0);
  });

  it('agents: route with mode walkaround / shove and drag_trace, each leaving no new DRC error', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const islands = () => new Map(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]));
    const clearB3 = async () => {
      const ids = [...p.doc.nodes.values()].filter((n) => (n.type === 'trace' || n.type === 'via') && p.doc.nodes.get(n.parent!)?.name === 'B3').map((n) => n.uid);
      p.history.apply('Clear B3', ids.map((uid) => ({ op: 'remove', uid }) as Op));
    };
    await clearB3();
    const errs = errors(p);
    const before = islands();
    // Walkaround: a straight 45° path between J1.3 and J2.3 runs into B2 / B4; the walk finds a legal way or says where it stops.
    let routed = false;
    for (const layer of p.copper) {
      try {
        const r = (await runTool(p, 'route', { from: 'J1.3', to: 'J2.3', layer, mode: 'walkaround' })) as { netFullyConnected: boolean; points: Vec2[] };
        expect(r.netFullyConnected).toBe(true);
        for (let i = 0; i + 1 < r.points.length; i++) expect(is45(r.points[i]!, r.points[i + 1]!)).toBe(true);
        routed = true;
        break;
      } catch (e) {
        expect(String(e)).toMatch(/No way around on .*stops at/);
      }
    }
    expect(routed).toBe(true);
    expect([...errors(p)].filter((e) => !errs.has(e))).toEqual([]);
    for (const [n, k] of before) if (n !== 'B3') expect(islands().get(n)).toBe(k);
    // Shove: the plain path, with B2 / B4 pushed aside (or a clear refusal).
    await clearB3();
    try {
      const r = (await runTool(p, 'route', { from: 'J1.3', to: 'J2.3', layer: p.copper[0], mode: 'shove' })) as { shoved: string[] };
      expect(Array.isArray(r.shoved)).toBe(true);
      expect([...errors(p)].filter((e) => !errs.has(e))).toEqual([]);
      for (const [n, k] of before) if (n !== 'B3') expect(islands().get(n)).toBe(k);
    } catch (e) {
      expect(String(e)).toMatch(/Cannot shove/);
    }
    // drag_trace: a big drag stops at other copper.
    const s = longest(p, 'B6');
    const d = (await runTool(p, 'drag_trace', { trace: s.uid, offset: 5 })) as { offset: number };
    expect(Math.abs(d.offset)).toBeLessThan(5);
    expect([...errors(p)].filter((e) => !errs.has(e))).toEqual([]);
  });

  it('pairs: the offset of a 45° path keeps the gap on straight runs and at corners', () => {
    const centre = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 8, y: 3 }, { x: 8, y: 9 }];
    for (const d of [0.2, -0.2]) {
      const o = offsetPath(centre, d);
      expect(o.length).toBe(centre.length);
      // Each offset segment runs parallel to its centre segment, |d| away.
      for (let i = 0; i + 1 < o.length; i++) {
        const a = centre[i]!;
        const b = centre[i + 1]!;
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const n = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
        for (const q of [o[i]!, o[i + 1]!]) expect((q.x - a.x) * n.x + (q.y - a.y) * n.y).toBeCloseTo(d, 6);
      }
    }
  });
});
