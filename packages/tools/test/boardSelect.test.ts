/**
 * P1 (docs/05-pcb-improvements.md): box selection on the board, its filter, and a selection that turns as
 * one group in one undo step.
 */
import { describe, expect, it } from 'vitest';
import { boardItemsInRect, componentExtent, computeRatsnest, rotateSelectionOps, runDrc, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool, type Project } from '@hassassin/tools';

const pos = (p: Project, uid: string) => p.engine.get(uid, 'position')?.value as Vec2;
const typeOf = (p: Project, uids: string[]) => uids.map((u) => p.doc.nodes.get(u)!.type);
const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;

describe('box selection on the board (P1)', () => {
  it('left to right picks what is fully inside; right to left also what it touches; the filter limits kinds and layers', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const j1 = pos(p, el(p, 'J1').uid);
    const ext = componentExtent(p.doc, p.engine, el(p, 'J1'), p.copper);
    // A box around J1 only (the bus traces leave it to the right).
    const r = { minX: j1.x + ext.minX - 0.5, minY: j1.y + ext.minY - 0.5, maxX: j1.x + ext.maxX + 0.5, maxY: j1.y + ext.maxY + 0.5 };
    const inside = boardItemsInRect(p.doc, p.engine, p.copper, r, 'inside');
    expect(inside).toContain(el(p, 'J1').uid);
    expect(inside).not.toContain(el(p, 'J2').uid);
    const touch = boardItemsInRect(p.doc, p.engine, p.copper, r, 'touch');
    expect(touch.length).toBeGreaterThan(inside.length);
    expect(typeOf(p, touch)).toContain('trace');
    // Every trace picked "inside" lies wholly in the box; "touch" also takes the ones that leave it.
    const crossing = touch.filter((u) => !inside.includes(u));
    expect(typeOf(p, crossing).filter((t) => t !== 'trace' && t !== 'via')).toEqual([]);
    // Filter: traces only; and only the bottom layer.
    const tracesOnly = boardItemsInRect(p.doc, p.engine, p.copper, r, 'touch', { kinds: ['traces'] });
    expect(typeOf(p, tracesOnly).every((t) => t === 'trace')).toBe(true);
    const bottom = boardItemsInRect(p.doc, p.engine, p.copper, r, 'touch', { kinds: ['traces'], layer: (l) => l === 'B.Cu' });
    for (const u of bottom) expect(p.engine.get(u, 'layer')?.value).toBe('B.Cu');
    // The board outline is a graphic: a box around the whole board picks it, touching or inside.
    const all = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    expect(typeOf(p, boardItemsInRect(p.doc, p.engine, p.copper, all, 'inside', { kinds: ['graphics'] })).length).toBeGreaterThan(0);
  });

  it('a selection turns as one group, in one undo step, keeping its connections and adding no DRC error', async () => {
    const p = await fixtureBus();
    await runTool(p, 'autoroute', {});
    const everything = boardItemsInRect(p.doc, p.engine, p.copper, { minX: 100, minY: 100, maxX: 140, maxY: 140 }, 'touch', { kinds: ['parts', 'traces', 'vias'] });
    const islands = () => JSON.stringify(computeRatsnest(p.doc, p.engine, p.copper).nets.map((n) => [n.net, n.islands]));
    const errs = () => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'outsideBoard' && v.kind !== 'partOutsideBoard' && v.kind !== 'edgeClearance').length;
    const i0 = islands();
    const e0 = errs();
    const before = { j1: { ...pos(p, el(p, 'J1').uid) }, j2: { ...pos(p, el(p, 'J2').uid) } };
    const ops = rotateSelectionOps(p.doc, p.engine, p.copper, everything, 90);
    p.history.apply('Rotate', ops);
    expect(islands()).toBe(i0);
    expect(errs()).toBe(e0);
    // The two connectors swapped from left / right to above / below each other.
    const j1 = pos(p, el(p, 'J1').uid);
    const j2 = pos(p, el(p, 'J2').uid);
    expect(Math.abs(j2.x - j1.x)).toBeCloseTo(Math.abs(before.j2.y - before.j1.y), 3);
    expect(Math.abs(j2.y - j1.y)).toBeCloseTo(Math.abs(before.j2.x - before.j1.x), 3);
    // One undo puts everything back.
    p.history.undo();
    expect(pos(p, el(p, 'J1').uid)).toEqual(before.j1);
    expect(pos(p, el(p, 'J2').uid)).toEqual(before.j2);
    expect(islands()).toBe(i0);
  });
});
