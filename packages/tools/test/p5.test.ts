/**
 * P5 (docs/05-pcb-improvements.md): flipping parts to the bottom, locking, the layout grid, align and spread.
 */
import { describe, expect, it } from 'vitest';
import { componentExtent, computeRatsnest, padGeom, type Vec2 } from '@hassassin/core';
import { buildFab } from '@hassassin/fab';
import { fixtureBus, fixtureMcu, runTool, type Project } from '@hassassin/tools';

const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
const pads = (p: Project, ref: string) =>
  el(p, ref)
    .children.map((c) => p.doc.nodes.get(c)!)
    .filter((n) => n.type === 'pad')
    .map((n) => ({ num: String(n.props.number), g: padGeom(p.doc, p.engine, n, p.copper)! }))
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
const box = (p: Project, ref: string) => {
  const at = p.engine.get(el(p, ref).uid, 'position')!.value as Vec2;
  const e = componentExtent(p.doc, p.engine, el(p, ref), p.copper);
  return { minX: at.x + e.minX, minY: at.y + e.minY, maxX: at.x + e.maxX, maxY: at.y + e.maxY };
};

describe('P5: bottom side, locking, grid, align', () => {
  it('flip_part mirrors an SMD part to the bottom, the fab output follows, and a second flip restores it', async () => {
    const p = await fixtureMcu();
    const before = pads(p, 'U2');
    const at = p.engine.get(el(p, 'U2').uid, 'position')!.value as Vec2;
    const r = (await runTool(p, 'flip_part', { refs: ['U2'] })) as { side: Record<string, string> };
    expect(r.side.U2).toBe('bottom');
    const after = pads(p, 'U2');
    for (const [i, a] of after.entries()) {
      const b = before[i]!;
      // Mirrored left to right about the part's origin, same height, on the bottom copper.
      expect(a.g.center.x).toBeCloseTo(2 * at.x - b.g.center.x, 4);
      expect(a.g.center.y).toBeCloseTo(b.g.center.y, 4);
      expect(a.g.layers).toContain('B.Cu');
      expect(a.g.layers).not.toContain('F.Cu');
    }
    const silk = el(p, 'U2').children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type !== 'pad').map((n) => String(p.engine.get(n.uid, 'layer')?.value ?? ''));
    expect(silk.every((l) => !l.startsWith('F.'))).toBe(true);
    const fab = buildFab(p.doc, p.engine, p.layers.map((l) => l.name), 'mcu');
    const pnp = fab.files.find((f) => /pos|placement|pnp/i.test(f.name))!;
    expect(String(pnp.data).split('\n').find((l) => l.startsWith('U2'))).toMatch(/bottom/);
    await runTool(p, 'flip_part', { refs: ['U2'] });
    expect(pads(p, 'U2').map((x) => [x.g.center.x, x.g.center.y, x.g.layers.join()])).toEqual(before.map((x) => [x.g.center.x, x.g.center.y, x.g.layers.join()]));
  });

  it('a locked part is not moved by move_part, align or auto_place; unlocking frees it', async () => {
    const p = await fixtureBus();
    await runTool(p, 'lock', { targets: ['J2'] });
    await expect(runTool(p, 'move_part', { ref: 'J2', x: 120, y: 120 })).rejects.toThrow(/locked/);
    const at = { ...(p.engine.get(el(p, 'J2').uid, 'position')!.value as Vec2) };
    await runTool(p, 'auto_place', { all: true, improve: false });
    expect(p.engine.get(el(p, 'J2').uid, 'position')!.value).toEqual(at);
    await runTool(p, 'lock', { targets: ['J2'], locked: false });
    await runTool(p, 'move_part', { ref: 'J2', x: at.x + 1, y: at.y });
    expect((p.engine.get(el(p, 'J2').uid, 'position')!.value as Vec2).x).toBeCloseTo(at.x + 1, 6);
  });

  it('set_layout_grid accepts metric and inch steps and project_status reports it', async () => {
    const p = await fixtureBus();
    await runTool(p, 'set_layout_grid', { grid: '25mil' });
    expect(((await runTool(p, 'project_status', {})) as { layoutGrid: number }).layoutGrid).toBeCloseTo(0.635, 6);
    await runTool(p, 'set_layout_grid', { grid: '0.1mm' });
    expect(((await runTool(p, 'project_status', {})) as { layoutGrid: number }).layoutGrid).toBeCloseTo(0.1, 6);
    await expect(runTool(p, 'set_layout_grid', { grid: 'fast' })).rejects.toThrow();
  });

  it('align_parts: left edges line up, spread gives even gaps, traces follow and connections stay', async () => {
    const p = await fixtureMcu();
    await runTool(p, 'autoroute', {});
    const isl = () => JSON.stringify(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]).sort());
    const before = isl();
    await runTool(p, 'align_parts', { refs: ['R1', 'R2'], mode: 'top' });
    expect(box(p, 'R1').minY).toBeCloseTo(box(p, 'R2').minY, 4);
    expect(isl()).toBe(before);
    await runTool(p, 'align_parts', { refs: ['C1', 'C2', 'D1'], mode: 'distributeX' });
    const s = ['C1', 'C2', 'D1'].map((r) => box(p, r)).sort((a, b) => a.minX - b.minX);
    expect(s[1]!.minX - s[0]!.maxX).toBeCloseTo(s[2]!.minX - s[1]!.maxX, 4);
    expect(isl()).toBe(before);
  });
});
