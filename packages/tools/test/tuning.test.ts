/**
 * P10 (docs/05-pcb-improvements.md): length tuning as a person would do it. Serpentines with 45° corners
 * on the shorter half, away from its partner, legs 3 W apart; pairs over their skew limit are tuned in time.
 */
import { describe, expect, it } from 'vitest';
import { diffPairs, netLengths, newUid, runDrc, segSegDist, stackupOf, type Vec2 } from '@hassassin/core';
import { fixturePairs, measureAutoroute, newProject, runTool, type Project } from '@hassassin/tools';

const netNode = (p: Project, net: string) => [...p.doc.nodes.values()].find((x) => x.type === 'net' && x.name === net)!;
const traces = (p: Project, net: string) =>
  [...p.doc.nodes.values()]
    .filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net)
    .map((n) => ({ a: p.engine.get(n.uid, 'start')!.value as Vec2, b: p.engine.get(n.uid, 'end')!.value as Vec2, layer: String(p.engine.get(n.uid, 'layer')!.value), w: p.engine.get(n.uid, 'traceWidth')!.value as number, tuned: !!n.props.tuned }));
const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');

/** Largest change of direction (degrees) where two traces of the net meet. */
function sharpest(p: Project, net: string): number {
  const ts = traces(p, net);
  let worst = 0;
  const near = (u: Vec2, v: Vec2) => Math.hypot(u.x - v.x, u.y - v.y) < 1e-3;
  for (let i = 0; i < ts.length; i++)
    for (let j = i + 1; j < ts.length; j++) {
      const x = ts[i]!, y = ts[j]!;
      for (const [q, xo] of [[x.a, x.b], [x.b, x.a]] as const)
        for (const [r, yo] of [[y.a, y.b], [y.b, y.a]] as const) {
          if (!near(q, r)) continue;
          const ux = xo.x - q.x, uy = xo.y - q.y, vx = yo.x - r.x, vy = yo.y - r.y;
          const ang = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))))) * 180) / Math.PI;
          worst = Math.max(worst, 180 - ang);
        }
    }
  return worst;
}

/** Smallest edge-to-edge distance between parallel pieces of the net that lie side by side. */
function legSpacing(p: Project, net: string): number {
  const ts = traces(p, net);
  let m = Infinity;
  for (let i = 0; i < ts.length; i++)
    for (let j = i + 1; j < ts.length; j++) {
      const x = ts[i]!, y = ts[j]!;
      const L = Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y);
      const ux = (x.b.x - x.a.x) / L, uy = (x.b.y - x.a.y) / L;
      const ex = y.b.x - y.a.x, ey = y.b.y - y.a.y;
      if (Math.abs(ux * ey - uy * ex) > 1e-6 * Math.hypot(ex, ey)) continue;
      const d = Math.abs((y.a.x - x.a.x) * uy - (y.a.y - x.a.y) * ux);
      if (d < 1e-6) continue;
      const t0 = (y.a.x - x.a.x) * ux + (y.a.y - x.a.y) * uy, t1 = (y.b.x - x.a.x) * ux + (y.b.y - x.a.y) * uy;
      if (Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > 1e-6) m = Math.min(m, d - x.w);
    }
  return m;
}

async function handPair(): Promise<Project> {
  const p = newProject('tune');
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 30, y: 0 });
  for (const [net, pins] of [['D_P', ['J1.1', 'J2.1']], ['D_N', ['J1.2', 'J2.2']]] as const) for (const pin of pins) await runTool(p, 'add_label', { pin, name: net, global: true });
  await runTool(p, 'update_pcb', {});
  await runTool(p, 'set_board_outline', { x: 140, y: 140, width: 50, height: 25 });
  await runTool(p, 'move_part', { ref: 'J1', x: 143, y: 158 });
  await runTool(p, 'move_part', { ref: 'J2', x: 187, y: 158 });
  // Halves 0.65 mm apart edge to edge (0.25 mm wide), away from the parts; D_N 3 mm short.
  const add = (net: string, a: Vec2, b: Vec2) => {
    const n = netNode(p, net);
    p.history.apply('t', [{ op: 'add', parent: n.uid, index: n.children.length, tree: { nodes: [{ uid: newUid('tr'), type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: a }, { name: 'end', value: b }, { name: 'layer', value: 'F.Cu' }, { name: 'traceWidth', value: 0.25 }], parent: n.uid, children: [] }] } }]);
  };
  add('D_P', { x: 150, y: 150 }, { x: 180, y: 150 });
  add('D_N', { x: 150, y: 150.9 }, { x: 177, y: 150.9 });
  await runTool(p, 'set_pin_signal', { target: 'D_P', net: true, pair: 'D_N' });
  for (const net of ['D_P', 'D_N']) await runTool(p, 'set_rule', { target: `net#"${net}"`, rule: 'diffGap', value: '0.65mm' });
  return p;
}

describe('length tuning (P10)', () => {
  it('tunes the shorter half of a pair in time, away from its partner, with 45° corners and legs 3 W apart', async () => {
    const p = await handPair();
    await runTool(p, 'set_rule', { target: 'net#"D_N"', rule: 'diffSkewMax', value: '0.5mm' });
    const errs = errors(p).length;
    const r = (await runTool(p, 'tune_pairs', {})) as { pairs: { tuned?: string; status: string; skew: number; after?: number; afterPs?: number }[] };
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]).toMatchObject({ tuned: 'D_N', status: 'tuned', skew: 3 });
    const d = diffPairs(netLengths(p.doc, p.engine, stackupOf(p.doc, p.copper)))[0]!;
    expect(d.skew).toBeLessThan(0.02);
    expect(d.skewPs!).toBeLessThan(0.2);
    expect(sharpest(p, 'D_N')).toBeLessThan(45.1);
    // Every leg at least 3 × 0.25 mm from its neighbour, edge to edge.
    expect(legSpacing(p, 'D_N')).toBeGreaterThan(0.75 - 1e-3);
    // Away from D_P (above, at y = 150): nothing of D_N comes above its own line.
    for (const t of traces(p, 'D_N')) expect(Math.min(t.a.y, t.b.y)).toBeGreaterThan(150.9 - 1e-6);
    // Bump height within the default 1.5 mm.
    for (const t of traces(p, 'D_N')) expect(Math.max(t.a.y, t.b.y)).toBeLessThan(150.9 + 1.5 + 1e-6);
    expect(errors(p).length).toBeLessThanOrEqual(errs);
    // Within the limit now: a second run leaves it.
    const again = (await runTool(p, 'tune_pairs', {})) as { pairs: { status: string }[] };
    expect(again.pairs[0]!.status).toBe('within the limit');
  });

  it('a bump height limit (tuneAmplitude) spreads the length over more bumps', async () => {
    const p = await handPair();
    await runTool(p, 'set_rule', { target: 'net#"D_N"', rule: 'tuneAmplitude', value: '0.6mm' });
    await runTool(p, 'tune_length', { net: 'D_N', match: 'D_P' });
    for (const t of traces(p, 'D_N')) expect(Math.max(t.a.y, t.b.y)).toBeLessThan(150.9 + 0.6 + 1e-6);
    expect(traces(p, 'D_N').filter((t) => t.tuned).length).toBeGreaterThan(16);
    expect(sharpest(p, 'D_N')).toBeLessThan(45.1);
  });

  it('a routed pair: the USB 2.0 preset sets the skew limit; tuning one half keeps DRC clean', { timeout: 60_000 }, async () => {
    const p = await fixturePairs();
    expect(p.engine.get(netNode(p, 'USB_N').uid, 'diffSkewMax')?.value).toBeCloseTo(1.27, 3);
    const r = (await runTool(p, 'autoroute', {})) as { tuned?: unknown[] };
    // Routed together, the skew is far inside 1.27 mm: nothing to tune.
    expect(r.tuned).toBeUndefined();
    const before = traces(p, 'USB_N').reduce((s, t) => s + Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y), 0);
    const t = (await runTool(p, 'tune_length', { net: 'USB_N', target: before + 2 })) as { after: number };
    expect(Math.abs(t.after - before - 2)).toBeLessThan(0.02);
    expect(errors(p)).toEqual([]);
    expect(sharpest(p, 'USB_N')).toBeLessThan(45.1);
    expect(legSpacing(p, 'USB_N')).toBeGreaterThan(3 * (p.engine.get(netNode(p, 'USB_N').uid, 'traceWidth')!.value as number) - 1e-3);
    // The bumps go away from USB_P: no tuned piece comes closer to it than the pair gap.
    const gap = p.engine.get(netNode(p, 'USB_N').uid, 'diffGap')!.value as number;
    for (const x of traces(p, 'USB_N').filter((t) => t.tuned))
      for (const y of traces(p, 'USB_P')) if (x.layer === y.layer) expect(segSegDist(x.a, x.b, y.a, y.b) - x.w / 2 - y.w / 2).toBeGreaterThan(gap - 0.02);
    void measureAutoroute;
  });
});
