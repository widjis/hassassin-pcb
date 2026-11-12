import { describe, expect, it } from 'vitest';
import { extractNetlist, runErc, type DocNode, type Vec2 } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const nodes = (p: Project) => [...p.doc.nodes.values()];
const block = (p: Project, name: string) => nodes(p).find((n) => n.type === 'block' && n.name === name)!;
const sheetPins = (p: Project, name: string) =>
  block(p, name).children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type === 'sheetPin');
const at = (p: Project, n: DocNode) => p.engine.get(n.uid, 'position')!.value as Vec2;
const netOf = (p: Project, pin: string) => extractNetlist(p.doc, p.engine).byPin.get(pin);
const hierErc = (p: Project) => runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'hierMismatch');

/** Root: R1 next to a "Filter" block; inside: C1 with a hierarchical label IN on pin 1. */
async function twoLevels(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
  await runTool(p, 'move_symbol', { ref: 'R1', rotation: 90 });
  const s = (await runTool(p, 'add_sheet', { name: 'Filter', x: 20.32, y: -10.16 })) as { sheet: string };
  expect(s.sheet).toBe('/Filter/');
  await runTool(p, 'add_part', { kind: 'capacitor', x: 50.8, y: 50.8, sheet: '/Filter/' });
  return p;
}

describe('S11: hierarchical sub-sheets created in the editor', () => {
  it('a hierarchical label inside adds a matching sheet pin on the block edge', async () => {
    const p = await twoLevels();
    expect(sheetPins(p, 'Filter')).toHaveLength(0);
    const r = (await runTool(p, 'add_label', { pin: 'C1.1', name: 'IN', kind: 'hier', shape: 'input' })) as { sheetPin: string };
    expect(r.sheetPin).toBe('Filter:IN');
    await runTool(p, 'add_label', { pin: 'C1.2', name: 'OUT', kind: 'hier', shape: 'output' });
    const pins = sheetPins(p, 'Filter');
    expect(pins.map((x) => x.name).sort()).toEqual(['IN', 'OUT']);
    const b = block(p, 'Filter');
    const pos = at(p, b);
    const size = p.engine.get(b.uid, 'size')!.value as Vec2;
    const inPin = pins.find((x) => x.name === 'IN')!;
    const outPin = pins.find((x) => x.name === 'OUT')!;
    // Inputs on the left edge, outputs on the right, on the 2.54 mm grid, inside the block's height.
    expect(at(p, inPin).x).toBeCloseTo(pos.x);
    expect(at(p, outPin).x).toBeCloseTo(pos.x + size.x);
    for (const q of [at(p, inPin), at(p, outPin)]) {
      expect(Math.abs(q.y / 2.54 - Math.round(q.y / 2.54))).toBeLessThan(1e-6);
      expect(q.y).toBeGreaterThan(pos.y);
      expect(q.y).toBeLessThan(pos.y + size.y);
    }
    expect(inPin.props.kind).toBe('input');
    expect(outPin.props.kind).toBe('output');
  });

  it('wiring the block pin on the parent joins the nets across the hierarchy; ERC is clean for it', async () => {
    const p = await twoLevels();
    await runTool(p, 'add_label', { pin: 'C1.1', name: 'IN', kind: 'hier' });
    // Before wiring: the sheet pin exists but nothing on the parent touches it.
    expect(netOf(p, 'R1.2')).not.toBe(netOf(p, 'C1.1'));
    const w = (await runTool(p, 'connect_pins', { from: 'R1.2', to: 'Filter:IN' })) as { net: string };
    expect(w.net).toBeTruthy();
    expect(netOf(p, 'R1.2')).toBe(netOf(p, 'C1.1'));
    expect(hierErc(p)).toEqual([]);
    // The wire stays out of the block body.
    const b = block(p, 'Filter');
    const pos = at(p, b);
    for (const n of nodes(p).filter((x) => x.type === 'wire' && x.parent === b.parent)) {
      const a = p.engine.get(n.uid, 'start')!.value as Vec2;
      const e = p.engine.get(n.uid, 'end')!.value as Vec2;
      for (const q of [a, e]) expect(q.x).toBeLessThanOrEqual(pos.x + 1e-6);
      // …and does not run down its edge: it comes in horizontally.
      expect(Math.abs(a.x - pos.x) < 1e-6 && Math.abs(e.x - pos.x) < 1e-6).toBe(false);
    }
  });

  it('removing or renaming the label updates the pins; a wired orphan pin stays and ERC reports it', async () => {
    const p = await twoLevels();
    const r = (await runTool(p, 'add_label', { pin: 'C1.2', name: 'SPARE', kind: 'hier' })) as { sheetPin: string };
    expect(r.sheetPin).toBe('Filter:SPARE');
    const lbl = () => nodes(p).find((n) => n.type === 'label' && n.name === 'SPARE')!;
    // Unwired orphan: deleting the label removes the pin.
    await runTool(p, 'delete', { target: lbl().uid });
    expect(sheetPins(p, 'Filter')).toHaveLength(0);
    // Wired: the pin stays when its label goes, and ERC flags both sides of the mismatch.
    await runTool(p, 'add_label', { pin: 'C1.1', name: 'IN', kind: 'hier' });
    await runTool(p, 'connect_pins', { from: 'R1.2', to: 'Filter:IN' });
    const inLabel = nodes(p).find((n) => n.type === 'label' && n.name === 'IN')!;
    await runTool(p, 'apply_ops', { ops: [{ op: 'setName', uid: inLabel.uid, name: 'VIN' }] });
    expect(sheetPins(p, 'Filter').map((x) => x.name).sort()).toEqual(['IN', 'VIN']);
    const msgs = hierErc(p).map((v) => v.message);
    expect(msgs.some((m) => /Sheet pin IN of block Filter has no hierarchical label/.test(m))).toBe(true);
  });

  it('edits keep imported sheet pins as they are (labels without a direction do not reset the pin kind)', async () => {
    const p = await twoLevels();
    await runTool(p, 'add_label', { pin: 'C1.1', name: 'IO', kind: 'hier' });
    const lbl = nodes(p).find((n) => n.type === 'label' && n.name === 'IO')!;
    const pin = sheetPins(p, 'Filter')[0]!;
    const where = { ...at(p, pin) };
    // As imported from KiCad: the label has no shape, the pin says input.
    await runTool(p, 'apply_ops', { ops: [{ op: 'setProp', uid: lbl.uid, key: 'shape', value: null }, { op: 'setProp', uid: pin.uid, key: 'kind', value: 'input' }] });
    await runTool(p, 'add_part', { kind: 'resistor', x: 76.2, y: 50.8, sheet: '/Filter/' });
    await runTool(p, 'connect_pins', { from: 'R2.1', to: 'C1.2' });
    expect(sheetPins(p, 'Filter')[0]!.props.kind).toBe('input');
    expect(at(p, sheetPins(p, 'Filter')[0]!)).toEqual(where);
  });

  it('a hierarchical label on a top-level sheet is refused by the tool and reported by ERC', async () => {
    const p = await twoLevels();
    await expect(runTool(p, 'add_label', { pin: 'R1.1', name: 'X', kind: 'hier' })).rejects.toThrow(/top-level sheet/);
    const root = nodes(p).find((n) => n.type === 'sheet' && p.doc.nodes.get(n.parent ?? '')?.type !== 'block')!;
    const op = { op: 'add', parent: root.uid, index: root.children.length, tree: { nodes: [{ uid: 'lblX', type: 'label', name: 'X', props: { kind: 'hier' }, rules: [{ name: 'position', value: { x: 0, y: 0 } }], parent: root.uid, children: [] }] } };
    await runTool(p, 'apply_ops', { ops: [op] });
    expect(hierErc(p).map((v) => v.message).join()).toMatch(/Hierarchical label X is on a top-level sheet/);
  });

  it('names: required, unique per sheet, no "/" or ":"; nested sub-sheets work', async () => {
    const p = await twoLevels();
    await expect(runTool(p, 'add_sheet', { name: 'Filter', x: 100, y: 0 })).rejects.toThrow(/already/);
    await expect(runTool(p, 'add_sheet', { name: 'a/b', x: 100, y: 0 })).rejects.toThrow(/cannot contain/);
    const inner = (await runTool(p, 'add_sheet', { name: 'Stage2', x: 0, y: 0, sheet: '/Filter/' })) as { sheet: string };
    expect(inner.sheet).toBe('/Filter/Stage2/');
    await runTool(p, 'add_part', { kind: 'resistor', x: 30, y: 30, sheet: '/Filter/Stage2/' });
    await runTool(p, 'add_label', { pin: 'R2.1', name: 'A', kind: 'hier' });
    // The pin appears on the Stage2 block, which sits on the Filter sheet.
    expect(sheetPins(p, 'Stage2').map((x) => x.name)).toEqual(['A']);
    await runTool(p, 'add_label', { pin: 'C1.1', name: 'A2', kind: 'hier' });
    await runTool(p, 'connect_pins', { from: 'C1.1', to: 'Stage2:A' });
    expect(netOf(p, 'R2.1')).toBe(netOf(p, 'C1.1'));
  });
});
