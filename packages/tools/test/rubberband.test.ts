/**
 * P2 (docs/05-pcb-improvements.md): traces follow moved and turned parts, connections stay the same, and
 * the pieces that follow are laid at 45°.
 */
import { describe, expect, it } from 'vitest';
import { computeRatsnest, rotationAbout, rubberbandOps, rubberbandPlan, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool, type Project } from '@hassassin/tools';

const islands = (p: Project) => JSON.stringify(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]).sort());
const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
const pos = (p: Project, ref: string) => p.engine.get(el(p, ref).uid, 'position')!.value as Vec2;
const allTraces45 = (p: Project) =>
  [...p.doc.nodes.values()]
    .filter((n) => n.type === 'trace')
    .every((n) => {
      const a = p.engine.get(n.uid, 'start')!.value as Vec2;
      const b = p.engine.get(n.uid, 'end')!.value as Vec2;
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      return dx < 1e-3 || dy < 1e-3 || Math.abs(dx - dy) < 1e-3;
    });

describe('rubber-banding (P2)', () => {
  it('move_part: the traces on the part follow it, connections unchanged, every piece at 45°', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const before = islands(p);
    expect(allTraces45(p)).toBe(true);
    const at = pos(p, 'J2');
    const r = (await runTool(p, 'move_part', { ref: 'J2', x: at.x + 2.3, y: at.y - 3.1 })) as { tracesFollowed: number };
    expect(r.tracesFollowed).toBeGreaterThan(0);
    expect(islands(p)).toBe(before);
    expect(allTraces45(p)).toBe(true);
    // Turned half way round too.
    await runTool(p, 'move_part', { ref: 'J2', x: at.x, y: at.y, rotation: 180 });
    expect(islands(p)).toBe(before);
    expect(allTraces45(p)).toBe(true);
    // keep_traces false leaves them: J2 is no longer connected.
    await runTool(p, 'move_part', { ref: 'J2', x: at.x + 5, y: at.y, keep_traces: false });
    expect(islands(p)).not.toBe(before);
  });

  it('a group turned with its traces: the traces in the group move with it, the others follow; one undo step', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const before = islands(p);
    const j2 = el(p, 'J2');
    const c = pos(p, 'J2');
    const plan = rubberbandPlan(p.doc, p.engine, p.copper, [j2.uid]);
    const f = rotationAbout(c, 90);
    p.history.apply('Rotate', [{ op: 'setRule', uid: j2.uid, name: 'rotation', decl: { name: 'rotation', value: 90 } }, ...rubberbandOps(plan, f, { fix45: true, doc: p.doc })]);
    expect(islands(p)).toBe(before);
    expect(allTraces45(p)).toBe(true);
    p.history.undo();
    expect(islands(p)).toBe(before);
  });
});
