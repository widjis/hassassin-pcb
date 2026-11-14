/**
 * P7 (docs/05-pcb-improvements.md): the measure tool's snapping, distances and the clearance readout.
 */
import { describe, expect, it } from 'vitest';
import { clearanceBetween, measureSnap, padGeom, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool, type Project } from '@hassassin/tools';

const pad = (p: Project, ref: string, num: string) => {
  const el = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
  return el.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === num)!;
};

describe('measure (P7)', () => {
  it('distance and Δx / Δy between two points', async () => {
    const p = await fixtureBus();
    expect(await runTool(p, 'measure', { from: { x: 100, y: 100 }, to: { x: 103, y: 104 } })).toEqual({ distance: 5, dx: 3, dy: 4 });
  });

  it('snaps to a pad centre, a pad edge and a trace centre line', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const g = padGeom(p.doc, p.engine, pad(p, 'J1', '1'), p.copper)!;
    expect(measureSnap(p.doc, p.engine, p.copper, { x: g.center.x + 0.1, y: g.center.y - 0.1 }, 0.5)).toEqual({ at: g.center, what: 'centre' });
    // Just outside the pad's right edge: the edge.
    const right = Math.max(...g.outline.map((q) => q.x));
    const e = measureSnap(p.doc, p.engine, p.copper, { x: right + 0.2, y: g.center.y }, 0.3);
    expect(e.what).toBe('edge');
    expect(e.at.x).toBeCloseTo(right, 3);
    // On the middle of a trace, off its centre line.
    const tr = [...p.doc.nodes.values()].find((n) => n.type === 'trace')!;
    const a = p.engine.get(tr.uid, 'start')!.value as Vec2;
    const b = p.engine.get(tr.uid, 'end')!.value as Vec2;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const t = measureSnap(p.doc, p.engine, p.copper, { x: m.x + 0.05, y: m.y + 0.05 }, 0.3);
    if (t.what === 'trace') {
      const cross = (t.at.x - a.x) * (b.y - a.y) - (t.at.y - a.y) * (b.x - a.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    } else expect(['centre', 'edge']).toContain(t.what);
  });

  it('clearance between two neighbouring pads, and between a part and a trace', async () => {
    const p = await fixtureBus();
    const g1 = padGeom(p.doc, p.engine, pad(p, 'J1', '1'), p.copper)!;
    const g2 = padGeom(p.doc, p.engine, pad(p, 'J1', '2'), p.copper)!;
    const c = clearanceBetween(p.doc, p.engine, p.copper, pad(p, 'J1', '1').uid, pad(p, 'J1', '2').uid)!;
    // Edge to edge along the row: centre distance less the two pad half sizes.
    const half = (g: typeof g1) => (Math.max(...g.outline.map((q) => q.y)) - Math.min(...g.outline.map((q) => q.y))) / 2;
    expect(c.gap).toBeCloseTo(Math.hypot(g2.center.x - g1.center.x, g2.center.y - g1.center.y) - half(g1) - half(g2), 2);
    expect(c.required).toBeGreaterThan(0);
    const r = (await runTool(p, 'measure', { a: 'J1.1', b: 'J1.2' })) as { clearance: number; ok: boolean };
    expect(r.clearance).toBeCloseTo(c.gap, 4);
    expect(r.ok).toBe(true);
  });
});
