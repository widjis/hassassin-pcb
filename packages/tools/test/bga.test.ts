/**
 * P8f (docs/05-pcb-improvements.md): ball grids fan out with dog-bones. The inner rings of a BGA get a short
 * 45° stub to a via in the gap between four balls; the outer rings escape on the top layer.
 */
import { describe, expect, it } from 'vitest';
import { padGeom, runDrc, type Vec2 } from '@hassassin/core';
import { fixtureBga, runTool, type Project } from '@hassassin/tools';

const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');
const ballAt = (p: Project, n: number) => {
  const pad = [...p.doc.nodes.values()].find((x) => x.type === 'pad' && x.name === String(n) && p.doc.nodes.get(x.parent!)?.name === 'U1')!;
  return padGeom(p.doc, p.engine, pad, p.copper)!.center;
};
const copperOf = (p: Project, net: string, type: 'trace' | 'via') =>
  [...p.doc.nodes.values()].filter((x) => x.type === type && p.doc.nodes.get(x.parent!)?.name === net);

describe('BGA dog-bones (P8f)', () => {
  it('the third ring leaves through dog-bones (only those four balls are fanned out)', { timeout: 120_000 }, async () => {
    const p = await fixtureBga();
    // Direction cost 1: the bottom layer may run either way, so the vias are the way out.
    // A generous time limit: on a busy machine the default 30 s can run out and change the result.
    const r = (await runTool(p, 'autoroute', { direction_cost: 1, time_limit: 300 })) as { routed: number; failed: unknown[]; dogbones?: number; vias: number };
    expect(r.failed).toEqual([]);
    expect(r.routed).toBe(20);
    expect(r.dogbones).toBe(4);
    expect(errors(p)).toEqual([]);
    // Third-ring balls (3,2), (4,2), (3,5), (4,5) of the 8 × 8 grid: a via half a pitch away on both axes,
    // and a stub from the ball centre to it.
    for (const [net, row, col] of [['L9', 3, 2], ['L10', 4, 2], ['R9', 3, 5], ['R10', 4, 5]] as const) {
      const c = ballAt(p, row * 8 + col + 1);
      const vias = copperOf(p, net, 'via').map((v) => p.engine.get(v.uid, 'position')!.value as Vec2);
      const dog = vias.find((v) => Math.abs(Math.abs(v.x - c.x) - 0.5) < 1e-6 && Math.abs(Math.abs(v.y - c.y) - 0.5) < 1e-6);
      expect(dog, net).toBeDefined();
      // Away from the part's centre (120, 115).
      expect(Math.sign(dog!.x - c.x)).toBe(Math.sign(c.x - 120));
      const stub = copperOf(p, net, 'trace').find((t) => {
        const a = p.engine.get(t.uid, 'start')!.value as Vec2, b = p.engine.get(t.uid, 'end')!.value as Vec2;
        const near = (u: Vec2, v: Vec2) => Math.hypot(u.x - v.x, u.y - v.y) < 1e-6;
        return (near(a, c) && near(b, dog!)) || (near(b, c) && near(a, dog!));
      });
      expect(stub, net).toBeDefined();
    }
  });

  it('dog-bones that leave connections open are dropped: the board is routed again without them', { timeout: 120_000 }, async () => {
    const p = await fixtureBga();
    // With the default layer directions the dog-boned routes run down the bottom layer and two
    // second-ring balls are shut in; without dog-bones every connection is routed.
    const r = (await runTool(p, 'autoroute', { time_limit: 300 })) as { routed: number; failed: unknown[]; dogbones?: number; dogbonesDropped?: number };
    expect(r.failed).toEqual([]);
    expect(r.routed).toBe(20);
    expect(r.dogbonesDropped).toBe(4);
    expect(r.dogbones).toBeUndefined();
    expect(errors(p)).toEqual([]);
  });
});
