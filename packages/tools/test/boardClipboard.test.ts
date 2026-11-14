/**
 * P3 (docs/05-pcb-improvements.md): copy / paste / duplicate on the board, and layout replication.
 */
import { describe, expect, it } from 'vitest';
import { computeRatsnest, copyBoardItems, pasteBoardOps, runDrc, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const el = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref);
const pos = (p: Project, ref: string) => p.engine.get(el(p, ref)!.uid, 'position')!.value as Vec2;
const netOfTraces = (p: Project, net: string) => [...p.doc.nodes.values()].filter((n) => n.type === 'trace' && p.doc.nodes.get(n.parent!)?.name === net).length;

/** Two identical channels (a resistor and an LED to GND), each in its own group box; channel A on the board. */
async function channels() {
  const p = newProject('ch');
  for (const [i, x] of [[1, 0], [2, 60.96]] as const) {
    await runTool(p, 'add_part', { kind: 'resistor', x, y: 0, package: 'chip-0603' });
    await runTool(p, 'add_part', { kind: 'led', x: x + 15.24, y: 0, package: 'chip-0603' });
    await runTool(p, 'add_label', { pin: `R${i}.2`, name: `CH${i}` });
    await runTool(p, 'add_label', { pin: `D${i}.1`, name: `CH${i}` });
    await runTool(p, 'add_label', { pin: `R${i}.1`, name: 'VCC' });
    await runTool(p, 'add_label', { pin: `D${i}.2`, name: 'GND' });
    await runTool(p, 'add_group_box', { title: `Channel ${i}`, refs: `R${i} D${i}` });
  }
  await runTool(p, 'update_pcb', {});
  await runTool(p, 'set_board_outline', { x: 100, y: 100, width: 50, height: 40 });
  await runTool(p, 'move_part', { ref: 'R1', x: 110, y: 110 });
  await runTool(p, 'move_part', { ref: 'D1', x: 116, y: 113, rotation: 90 });
  await runTool(p, 'route', { from: 'R1.2', to: 'D1.1', mode: 'walkaround' });
  return p;
}

describe('board copy, paste and replication (P3)', () => {
  it('a copy of parts and the trace between them; traces leaving the copy stay behind unless asked', async () => {
    const p = await channels();
    const tr = [...p.doc.nodes.values()].filter((n) => n.type === 'trace').map((n) => n.uid);
    // R1 alone with the trace: the trace ends on D1, which is not copied.
    expect(copyBoardItems(p.doc, p.engine, p.copper, [el(p, 'R1')!.uid, ...tr])!.items.filter((i) => i.place === 'net')).toHaveLength(0);
    expect(copyBoardItems(p.doc, p.engine, p.copper, [el(p, 'R1')!.uid, ...tr], { allTraces: true })!.items.filter((i) => i.place === 'net').length).toBe(tr.length);
    // Both parts: the trace comes along.
    const clip = copyBoardItems(p.doc, p.engine, p.copper, [el(p, 'R1')!.uid, el(p, 'D1')!.uid, ...tr])!;
    expect(clip.items.filter((i) => i.place === 'net').length).toBe(tr.length);
  });

  it('paste takes the schematic parts not on the board (R2, D2) and their nets; one undo step; no DRC error', async () => {
    const p = await channels();
    // Park channel 2 off the board first, so "not on the board" means not placed: remove its parts.
    p.history.apply('Remove ch2', [el(p, 'R2')!, el(p, 'D2')!].map((n) => ({ op: 'remove', uid: n.uid })));
    const tr = [...p.doc.nodes.values()].filter((n) => n.type === 'trace').map((n) => n.uid);
    const clip = copyBoardItems(p.doc, p.engine, p.copper, [el(p, 'R1')!.uid, el(p, 'D1')!.uid, ...tr])!;
    const r = pasteBoardOps(p.doc, p.engine, p.copper, clip, { x: clip.anchor.x + 20, y: clip.anchor.y });
    p.history.apply('Paste', r.ops);
    expect(Object.fromEntries(r.refs)).toEqual({ R1: 'R2', D1: 'D2' });
    expect(r.matched.sort()).toEqual(['D2', 'R2']);
    // The pasted trace is on CH2 and joins R2 and D2.
    expect(netOfTraces(p, 'CH2')).toBe(netOfTraces(p, 'CH1'));
    const ch2 = computeRatsnest(p.doc, p.engine, p.copper).nets.find((n) => n.net === 'CH2');
    expect(ch2?.islands ?? 1).toBe(1);
    expect(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted')).toEqual([]);
    p.history.undo();
    expect(el(p, 'R2')).toBeUndefined();
  });

  it('duplicate with no free schematic part: new references, no nets, copper of those nets left out', async () => {
    const p = await channels();
    const r = (await runTool(p, 'duplicate_board_items', { targets: ['R1', 'D1', ...[...p.doc.nodes.values()].filter((n) => n.type === 'trace').map((n) => n.uid)], dx: 20 })) as { refs: Record<string, string>; fromSchematic: string[]; copperLeftOut: number };
    expect(r.fromSchematic).toEqual([]);
    expect(r.refs.R1).toBe('R3');
    expect(r.copperLeftOut).toBeGreaterThan(0);
    const pad = [...p.doc.nodes.values()].find((n) => n.type === 'pad' && p.doc.nodes.get(n.parent!)?.name === 'R3')!;
    expect(pad.props.net).toBeUndefined();
  });

  it('replicate_layout: channel 2 is laid out and routed like channel 1', async () => {
    const p = await channels();
    const before = pos(p, 'R2');
    const r = (await runTool(p, 'replicate_layout', { from: ['R1', 'D1'] })) as { blocks: { pairs: Record<string, string>; traces: number }[] };
    expect(r.blocks[0]!.pairs).toEqual({ R1: 'R2', D1: 'D2' });
    expect(r.blocks[0]!.traces).toBeGreaterThan(0);
    // R2 kept its place; D2 sits where D1 sits relative to R1, turned the same.
    expect(pos(p, 'R2')).toEqual(before);
    const d1 = { x: pos(p, 'D1').x - pos(p, 'R1').x, y: pos(p, 'D1').y - pos(p, 'R1').y };
    expect(pos(p, 'D2').x - pos(p, 'R2').x).toBeCloseTo(d1.x, 4);
    expect(pos(p, 'D2').y - pos(p, 'R2').y).toBeCloseTo(d1.y, 4);
    expect(p.engine.get(el(p, 'D2')!.uid, 'rotation')!.value).toBe(90);
    expect(computeRatsnest(p.doc, p.engine, p.copper).nets.find((n) => n.net === 'CH2')?.islands ?? 1).toBe(1);
  });
});
