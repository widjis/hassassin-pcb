/**
 * P9 (docs/05-pcb-improvements.md): the shove engine moves other nets' traces out of the way of new
 * copper, keeping clearance and connections, and refuses when they cannot move.
 */
import { describe, expect, it } from 'vitest';
import { computeRatsnest, newUid, planShove, runDrc, type Op, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool, type Project } from '@hassassin/tools';

const traces = (p: Project, net: string) =>
  [...p.doc.nodes.values()]
    .filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net)
    .map((n) => ({ uid: n.uid, a: p.engine.get(n.uid, 'start')!.value as Vec2, b: p.engine.get(n.uid, 'end')!.value as Vec2, layer: String(p.engine.get(n.uid, 'layer')!.value) }));
const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');

/** The routed bus, and a new trace of net B3 laid `off` mm beside the middle of B4's longest segment. */
async function setup(off: number) {
  const p = await fixtureBus();
  await runTool(p, 'autoroute', {});
  const s = traces(p, 'B4').sort((x, y) => Math.hypot(y.b.x - y.a.x, y.b.y - y.a.y) - Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y))[0]!;
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L = Math.hypot(dx, dy);
  const m = { x: (s.a.x + s.b.x) / 2 - (dy / L) * off, y: (s.a.y + s.b.y) / 2 + (dx / L) * off };
  const t = { layer: s.layer, a: { x: m.x - (dx / L) * 2, y: m.y - (dy / L) * 2 }, b: { x: m.x + (dx / L) * 2, y: m.y + (dy / L) * 2 }, width: 0.25 };
  return { p, s, t };
}
const addTrace = (p: Project, net: string, t: { layer: string; a: Vec2; b: Vec2; width: number }): Op => {
  const n = [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === net)!;
  return { op: 'add', parent: n.uid, index: n.children.length, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: t.a }, { name: 'end', value: t.b }, { name: 'layer', value: t.layer }, { name: 'traceWidth', value: t.width }], parent: n.uid, children: [] }] } };
};

describe('shove engine (P9)', () => {
  for (const off of [0.35, 0]) {
    it(`pushes a trace aside for new copper ${off ? 'beside' : 'on top of'} it: clearance and connections kept`, async () => {
      const { p, t } = await setup(off);
      const islands = computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]);
      const r = planShove(p.doc, p.engine, p.copper, { net: 'B3', traces: [t] });
      expect(r.error).toBeUndefined();
      expect(r.nets).toContain('B4');
      // One step: the new trace and the moves.
      p.history.apply('Shove', [addTrace(p, 'B3', t), ...r.ops]);
      expect(errors(p)).toEqual([]);
      // B3's new piece is a stub of its own net (one more island); every other net is unchanged.
      const after = new Map(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]));
      for (const [net, k] of islands) if (net !== 'B3') expect([net, after.get(net as string)]).toEqual([net, k]);
      // Undo puts B4 back.
      p.history.undo();
      expect(errors(p)).toEqual([]);
    });
  }

  it('pushes on: a wide new trace (2.5 mm) moves B4, and B4 moves its neighbour', async () => {
    const { p, t } = await setup(0);
    const wide = { ...t, width: 2.5 };
    const r = planShove(p.doc, p.engine, p.copper, { net: 'B3', traces: [wide] });
    expect(r.error).toBeUndefined();
    expect(r.nets.length).toBeGreaterThanOrEqual(2);
    p.history.apply('Shove', [addTrace(p, 'B3', wide), ...r.ops]);
    expect(errors(p)).toEqual([]);
  });

  it('leaves the board as it was while planning', async () => {
    const { p, t } = await setup(0.35);
    const before = traces(p, 'B4').map((x) => x.uid).sort();
    planShove(p.doc, p.engine, p.copper, { net: 'B3', traces: [t] });
    expect(traces(p, 'B4').map((x) => x.uid).sort()).toEqual(before);
  });

  it('refuses to move a locked trace', async () => {
    const { p, s, t } = await setup(0.35);
    p.history.apply('Lock', [{ op: 'setProp', uid: s.uid, key: 'locked', value: true }]);
    const r = planShove(p.doc, p.engine, p.copper, { net: 'B3', traces: [t] });
    expect(r.error).toMatch(/locked/);
    expect(r.ops).toEqual([]);
  });

  it('refuses when the new copper sits on a pad (nothing there can move)', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const pad = [...p.doc.nodes.values()].find((n) => n.type === 'pad' && n.props.net === 'B5')!;
    const at = p.engine.get(pad.uid, 'position')!.value as Vec2;
    const el = p.engine.get(pad.parent!, 'position')!.value as Vec2;
    const c = { x: el.x + at.x, y: el.y + at.y };
    const r = planShove(p.doc, p.engine, p.copper, { net: 'B3', traces: [{ layer: 'F.Cu', a: { x: c.x - 1, y: c.y }, b: { x: c.x + 1, y: c.y }, width: 0.25 }] });
    expect(r.error).toBeDefined();
    expect(r.ops).toEqual([]);
  });
});
