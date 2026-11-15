/**
 * Unrouting (EAGLE RIPUP, KiCad Unroute Selected): the selection, a part's attached copper, nets, an area,
 * all (but the poured nets); locked copper stays.
 */
import { describe, expect, it } from 'vitest';
import { copperAttachedToParts, unrouteOps, type Vec2 } from '@hassassin/core';
import { fixtureMcu, runTool, type Project } from '@hassassin/tools';

const copperOf = (p: Project, net: string) => [...p.doc.nodes.values()].filter((n) => (n.type === 'trace' || n.type === 'via') && p.doc.nodes.get(n.parent!)?.name === net).length;
const total = (p: Project) => [...p.doc.nodes.values()].filter((n) => n.type === 'trace' || n.type === 'via').length;
const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;

async function routed() {
  const p = await fixtureMcu();
  await runTool(p, 'autoroute', {});
  return p;
}

describe('unroute', () => {
  it('nets: every trace and via of the named nets, nothing else', async () => {
    const p = await routed();
    const before = total(p);
    const sda = copperOf(p, 'SDA');
    expect(sda).toBeGreaterThan(0);
    const r = (await runTool(p, 'unroute', { nets: ['SDA'] })) as { traces: number; vias: number; nets: string[] };
    expect(r.nets).toEqual(['SDA']);
    expect(copperOf(p, 'SDA')).toBe(0);
    expect(total(p)).toBe(before - sda);
    await expect(runTool(p, 'unroute', { nets: ['NOPE'] })).rejects.toThrow(/No such net/);
  });

  it("a part: the copper attached to its pads, stopping at other parts' pads", async () => {
    const p = await routed();
    const attached = copperAttachedToParts(p.doc, p.engine, p.copper, [el(p, 'R1').uid]);
    expect(attached.size).toBeGreaterThan(0);
    // R1 joins SDA and VCC; what is attached lies on those nets only.
    const nets = new Set([...attached].map((u) => p.doc.nodes.get(p.doc.nodes.get(u)!.parent!)!.name));
    for (const n of nets) expect(['SDA', 'VCC']).toContain(n);
    // It does not take all of VCC (VCC goes on to other parts beyond their pads).
    expect([...attached].filter((u) => p.doc.nodes.get(p.doc.nodes.get(u)!.parent!)!.name === 'VCC').length).toBeLessThan(copperOf(p, 'VCC'));
    const traces = [...attached].filter((u) => p.doc.nodes.get(u)!.type === 'trace').length;
    const r = (await runTool(p, 'unroute', { targets: ['R1'] })) as { traces: number };
    expect(r.traces).toBe(traces);
  });

  it('an area takes what touches it; all keeps the poured nets when asked; locked copper stays', async () => {
    const p = await routed();
    const a = p.engine.get(el(p, 'U2').uid, 'position')!.value as Vec2;
    const before = total(p);
    const r = (await runTool(p, 'unroute', { area: { x: a.x - 3, y: a.y - 3, width: 6, height: 6 } })) as { traces: number; vias: number };
    expect(r.traces + r.vias).toBeGreaterThan(0);
    expect(total(p)).toBe(before - r.traces - r.vias);
    // Lock one VCC trace; unroute everything but GND (poured).
    const keep = [...p.doc.nodes.values()].find((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)!.name === 'VCC')!;
    await runTool(p, 'lock', { targets: [keep.uid] });
    const gnd = copperOf(p, 'GND');
    const all = (await runTool(p, 'unroute', { all: true, keep_poured: true })) as { lockedKept: number };
    expect(all.lockedKept).toBe(1);
    expect(p.doc.nodes.has(keep.uid)).toBe(true);
    expect(copperOf(p, 'GND')).toBe(gnd);
    expect(total(p)).toBe(gnd + 1);
    // One more: all of it (but the locked trace).
    const r2 = unrouteOps(p.doc, p.engine, p.copper, { kind: 'all' });
    p.history.apply('Unroute', r2.ops);
    expect(total(p)).toBe(1);
  });
});
