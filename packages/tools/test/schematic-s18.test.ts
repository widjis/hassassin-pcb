import { describe, expect, it } from 'vitest';
import { extractNetlist, planBackAnnotation, type DocNode, type PartDef } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const pin = (number: string, name: string, type: string, x: number, y: number, angle: number) => ({ number, name, type, at: { x, y }, angle, length: 2.54 });
/** A dual op-amp: identical units A and B, and a power unit C. */
const DUAL: PartDef = {
  id: 'test:dual-opamp',
  name: 'DualOpAmp',
  prefix: 'U',
  value: 'DualOpAmp',
  footprint: 'soic-8',
  units: [
    { graphics: [{ t: 'rect', a: { x: -5.08, y: -5.08 }, b: { x: 5.08, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('3', '+', 'input', -7.62, -2.54, 0), pin('2', '-', 'input', -7.62, 2.54, 0), pin('1', '~', 'output', 7.62, 0, 180)] },
    { graphics: [{ t: 'rect', a: { x: -5.08, y: -5.08 }, b: { x: 5.08, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('5', '+', 'input', -7.62, -2.54, 0), pin('6', '-', 'input', -7.62, 2.54, 0), pin('7', '~', 'output', 7.62, 0, 180)] },
    { graphics: [{ t: 'rect', a: { x: -2.54, y: -5.08 }, b: { x: 2.54, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('8', 'V+', 'power_in', 0, -7.62, 270), pin('4', 'V-', 'power_in', 0, 7.62, 90)] },
  ],
};

/** R1, a dual op-amp U1 and an MCU U2 whose GPIOs 1–3 may be swapped; every pin labelled; on the board. */
async function design(): Promise<Project> {
  const p = newProject('ba');
  await runTool(p, 'apply_ops', { ops: [{ op: 'setMeta', key: `part:${DUAL.id}`, value: DUAL }] });
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
  await runTool(p, 'place_part', { id: DUAL.id, x: 40.64, y: 0 });
  const mcu = (await runTool(p, 'create_symbol', { name: 'MCU', pins: '1,GP1,bidirectional\n2,GP2,bidirectional\n3,GP3,bidirectional\n4,VCC,power_in', footprint: 'soic-8' })) as { id: string };
  await runTool(p, 'place_part', { id: mcu.id, x: 101.6, y: 0, ref: 'U2' });
  const u2 = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === 'U2')!;
  p.history.apply('Swap groups', [{ op: 'setProp', uid: u2.uid, key: 'swapGroups', value: '1 2 3' }]);
  for (const [pinRef, name] of [['R1.1', 'X'], ['R1.2', 'Y'], ['U1.3', 'A_P'], ['U1.2', 'A_N'], ['U1.1', 'A_O'], ['U1.5', 'B_P'], ['U1.6', 'B_N'], ['U1.7', 'B_O'], ['U2.1', 'S1'], ['U2.2', 'S2'], ['U2.3', 'S3']] as const)
    await runTool(p, 'add_label', { pin: pinRef, name });
  await runTool(p, 'update_pcb', {});
  return p;
}

const element = (p: Project, name: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === name)!;
/** Pads whose board net differs from the schematic's net for the same pin. */
function disagreements(p: Project): string[] {
  const nl = extractNetlist(p.doc, p.engine);
  const out: string[] = [];
  for (const el of p.doc.nodes.values()) {
    if (el.type !== 'element') continue;
    for (const c of el.children) {
      const pad = p.doc.nodes.get(c) as DocNode;
      if (pad?.type !== 'pad' || typeof pad.props.net !== 'string') continue;
      const want = nl.byPin.get(`${el.name}.${pad.props.number}`);
      if (want && want !== pad.props.net) out.push(`${el.name}.${pad.props.number}: board ${pad.props.net}, schematic ${want}`);
    }
  }
  return out;
}

describe('S18: back-annotation from the board', () => {
  it('nothing to do right after Update PCB', async () => {
    const p = await design();
    expect(disagreements(p)).toEqual([]);
    expect(planBackAnnotation(p.doc, p.engine)).toMatchObject({ changes: [], unexplained: [] });
  });

  it('pin swaps within the allowed groups, a gate swap and a renamed reference come back to the schematic', async () => {
    const p = await design();
    await runTool(p, 'swap_pads', { ref: 'R1', a: '1', b: '2' });
    await runTool(p, 'swap_pads', { ref: 'U2', a: '1', b: '3' });
    await runTool(p, 'swap_gates', { ref: 'U1', unit_a: 1, unit_b: 2 });
    p.history.apply('Rename on board', [{ op: 'setName', uid: element(p, 'R1').uid, name: 'R7' }]);
    expect(disagreements(p).length).toBeGreaterThan(0);
    const r = (await runTool(p, 'back_annotate', { apply: false })) as { changes: string[]; applied: boolean };
    expect(r.applied).toBe(false);
    expect(r.changes.sort()).toEqual(['R1 → R7', 'R1: pins 1, 2 now 2, 1', 'U1: units A ↔ B swapped', 'U2: pins 1, 3 now 3, 1']);
    await runTool(p, 'back_annotate', {});
    // Every pad's net is now its pin's net in the schematic, and the labels kept their wires.
    expect(disagreements(p)).toEqual([]);
    const nl = extractNetlist(p.doc, p.engine);
    expect(nl.byPin.get('R7.1')).toBe('/Y');
    expect(nl.byPin.get('U2.3')).toBe('/S1');
    expect(nl.byPin.get('U1.5')).toBe('/A_P');
    expect(nl.byPin.get('U1.1')).toBe('/B_O');
    expect([...p.doc.nodes.values()].some((n) => n.type === 'symbol' && n.props.ref === 'R1')).toBe(false);
    // One undo step takes it all back.
    p.history.undo();
    expect(extractNetlist(p.doc, p.engine).byPin.get('R1.1')).toBe('/X');
  });

  it('swaps outside the allowed groups are refused on the board, and other differences are only reported', async () => {
    const p = await design();
    await expect(runTool(p, 'swap_pads', { ref: 'U2', a: '1', b: '4' })).rejects.toThrow(/does not allow/);
    await expect(runTool(p, 'swap_gates', { ref: 'U1', unit_a: 1, unit_b: 3 })).rejects.toThrow(/not identical/);
    // A pad moved to another net by hand is not a swap.
    const pad = element(p, 'U2').children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === '2')!;
    p.history.apply('Edit pad', [{ op: 'setProp', uid: pad.uid, key: 'net', value: '/S3' }]);
    const r = (await runTool(p, 'back_annotate', {})) as { changes: string[]; unexplained: string[] };
    expect(r.changes).toEqual([]);
    expect(r.unexplained).toEqual(['U2 pad 2 is on /S3 on the board but /S2 in the schematic']);
  });
});
