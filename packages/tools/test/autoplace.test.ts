/**
 * P11 (docs/05-pcb-improvements.md): the autoplacer's improvement pass. A greedy start, then simulated
 * annealing that shortens the ratsnest, turns parts, keeps blocks together, puts decoupling capacitors at
 * their IC and connectors marked placeAtEdge at the edge; courtyards apart, locked parts kept.
 */
import { describe, expect, it } from 'vitest';
import { boardOutline, componentExtent, padGeom, planAutoplace, pointInPolygon, ratsnestHpwl, type Vec2 } from '@hassassin/core';
import { fixtureMcu, measureAutoroute, runTool, type Project } from '@hassassin/tools';

const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
const boxOf = (p: Project, ref: string) => {
  const e = el(p, ref);
  const x = componentExtent(p.doc, p.engine, e, p.copper);
  const at = p.engine.get(e.uid, 'position')!.value as Vec2;
  return { minX: at.x + x.minX, minY: at.y + x.minY, maxX: at.x + x.maxX, maxY: at.y + x.maxY };
};
const refs = (p: Project) => [...p.doc.nodes.values()].filter((n) => n.type === 'element').map((n) => n.name);
/** Courtyards apart (by the 0.5 mm spacing) and inside the outline. */
function legal(p: Project): string[] {
  const bad: string[] = [];
  const outline = boardOutline(p.doc, p.engine).loops[0]!;
  const rs = refs(p);
  for (const [i, r] of rs.entries()) {
    const b = boxOf(p, r);
    for (const c of [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]) if (!pointInPolygon(c, outline)) bad.push(`${r} off the board`);
    for (const s of rs.slice(i + 1)) {
      const o = boxOf(p, s);
      if (b.minX < o.maxX + 0.5 - 1e-6 && b.maxX > o.minX - 0.5 + 1e-6 && b.minY < o.maxY + 0.5 - 1e-6 && b.maxY > o.minY - 0.5 + 1e-6) bad.push(`${r} on ${s}`);
    }
  }
  return bad;
}
const padAt = (p: Project, ref: string, net: string) => {
  const pad = el(p, ref).children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && n.props.net === net)!;
  return padGeom(p.doc, p.engine, pad, p.copper)!.center;
};
/** The mcu fixture without copper, every part to be placed again. */
async function cleared(): Promise<Project> {
  const p = await fixtureMcu();
  const copper = [...p.doc.nodes.values()].filter((n) => n.type === 'trace' || n.type === 'via');
  if (copper.length) p.history.apply('Rip up', copper.map((n) => ({ op: 'remove' as const, uid: n.uid })));
  return p;
}

describe('autoplacer improvement pass (P11)', () => {
  it('shortens the ratsnest by at least 20 % against the greedy start, legal, and the router finishes it', { timeout: 120_000 }, async () => {
    const g = await cleared();
    await runTool(g, 'auto_place', { all: true, improve: false });
    const greedy = ratsnestHpwl(g.doc, g.engine, g.copper);
    const p = await cleared();
    const r = (await runTool(p, 'auto_place', { all: true })) as { placed: { ref: string; rotation?: number }[]; failed: string[]; ratsnest: { greedy: number; improved: number } };
    expect(r.failed).toEqual([]);
    const after = ratsnestHpwl(p.doc, p.engine, p.copper);
    expect(r.ratsnest.greedy).toBeCloseTo(greedy, 1);
    expect(r.ratsnest.improved).toBeCloseTo(after, 1);
    expect(after).toBeLessThan(0.8 * greedy);
    expect(legal(p)).toEqual([]);
    // Some parts turned by 90° steps.
    expect(r.placed.some((x) => x.rotation !== undefined && x.rotation % 90 === 0)).toBe(true);
    const f = await measureAutoroute(p);
    expect([f.failed, f.drcErrors]).toEqual([0, 0]);
  });

  it('puts each decoupling capacitor next to the supply pin of an IC; ICs on one supply share them', { timeout: 60_000 }, async () => {
    const p = await cleared();
    const r = (await runTool(p, 'auto_place', { all: true })) as { decoupling: { cap: string; ic: string; pin: string }[] };
    // C1 and C2 on VCC / GND: U1 (two VCC pins) and U2 (one) share them, one each.
    expect(r.decoupling.map((d) => d.cap).sort()).toEqual(['C1', 'C2']);
    expect(new Set(r.decoupling.map((d) => d.ic))).toEqual(new Set(['U1', 'U2']));
    for (const d of r.decoupling) {
      const a = padAt(p, d.cap, 'VCC');
      const pin = el(p, d.ic).children.map((c) => p.doc.nodes.get(c)!).find((n) => `${d.ic}.${n.name}` === d.pin)!;
      const b = padGeom(p.doc, p.engine, pin, p.copper)!.center;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(4);
    }
  });

  it('keeps the parts of a schematic group box together', { timeout: 60_000 }, async () => {
    const spread = async (box: boolean) => {
      const p = await cleared();
      if (box) await runTool(p, 'add_group_box', { title: 'LED', refs: 'D1, R3, J2' });
      const r = (await runTool(p, 'auto_place', { all: true })) as { clusters?: { block: string; parts: string[] }[] };
      const bs = ['D1', 'R3', 'J2'].map((x) => boxOf(p, x));
      return { r, size: Math.max(...bs.map((b) => b.maxX)) - Math.min(...bs.map((b) => b.minX)) + Math.max(...bs.map((b) => b.maxY)) - Math.min(...bs.map((b) => b.minY)) };
    };
    const without = await spread(false);
    const withBox = await spread(true);
    expect(without.r.clusters).toBeUndefined();
    expect(withBox.r.clusters).toEqual([{ block: 'LED', parts: expect.arrayContaining(['D1', 'R3', 'J2']) }]);
    expect(withBox.size).toBeLessThanOrEqual(without.size + 1e-6);
  });

  it('puts a connector marked placeAtEdge against the board edge', { timeout: 60_000 }, async () => {
    const p = await cleared();
    await runTool(p, 'set_property', { target: 'J1', key: 'placeAtEdge', value: 'true' });
    const r = (await runTool(p, 'auto_place', { all: true })) as { atEdge?: string[] };
    expect(r.atEdge).toEqual(['J1']);
    const outline = boardOutline(p.doc, p.engine).loops[0]!;
    const xs = outline.map((q) => q.x), ys = outline.map((q) => q.y);
    const b = boxOf(p, 'J1');
    const gap = Math.min(b.minX - Math.min(...xs), Math.max(...xs) - b.maxX, b.minY - Math.min(...ys), Math.max(...ys) - b.maxY);
    expect(gap).toBeLessThan(1.5);
    expect(legal(p)).toEqual([]);
  });

  it('leaves locked parts where they are, and the same seed gives the same placement', { timeout: 60_000 }, async () => {
    const p = await cleared();
    p.history.apply('Lock', [{ op: 'setProp', uid: el(p, 'U1').uid, key: 'locked', value: true }]);
    const at = p.engine.get(el(p, 'U1').uid, 'position')!.value;
    const a = planAutoplace(p.doc, p.engine, p.copper, { all: true, seed: 5, iterations: 50000 });
    const b = planAutoplace(p.doc, p.engine, p.copper, { all: true, seed: 5, iterations: 50000 });
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(b.ops));
    expect(a.report.placed.map((x) => x.ref)).not.toContain('U1');
    p.history.apply('Place', a.ops);
    expect(p.engine.get(el(p, 'U1').uid, 'position')!.value).toEqual(at);
    expect(legal(p)).toEqual([]);
  });
});
