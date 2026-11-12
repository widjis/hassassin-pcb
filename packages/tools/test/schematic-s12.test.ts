import { describe, expect, it } from 'vitest';
import { displayRef, extractNetlist, runErc, unitLetter, type PartDef, type Vec2 } from '@hassassin/core';
import { importKicadSchematic } from '@hassassin/kicad-import';
import { newProject, runTool, wrapProject, type Project } from '@hassassin/tools';

const pin = (number: string, name: string, type: string, x: number, y: number, angle: number) => ({ number, name, type, at: { x, y }, angle, length: 2.54 });
/** A dual op-amp: units A and B (in+, in-, out) and a power unit C (V-, V+). */
const DUAL: PartDef = {
  id: 'test:dual-opamp',
  name: 'DualOpAmp',
  prefix: 'U',
  value: 'DualOpAmp',
  units: [
    { graphics: [{ t: 'rect', a: { x: -5.08, y: -5.08 }, b: { x: 5.08, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('3', '+', 'input', -7.62, -2.54, 0), pin('2', '-', 'input', -7.62, 2.54, 0), pin('1', '~', 'output', 7.62, 0, 180)] },
    { graphics: [{ t: 'rect', a: { x: -5.08, y: -5.08 }, b: { x: 5.08, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('5', '+', 'input', -7.62, -2.54, 0), pin('6', '-', 'input', -7.62, 2.54, 0), pin('7', '~', 'output', 7.62, 0, 180)] },
    { graphics: [{ t: 'rect', a: { x: -2.54, y: -5.08 }, b: { x: 2.54, y: 5.08 }, fill: true, w: 0.254 }], pins: [pin('8', 'V+', 'power_in', 0, -7.62, 270), pin('4', 'V-', 'power_in', 0, 7.62, 90)] },
  ],
};

async function withPart(units?: string): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'apply_ops', { ops: [{ op: 'setMeta', key: `part:${DUAL.id}`, value: DUAL }] });
  await runTool(p, 'place_part', { id: DUAL.id, x: 0, y: 0, ...(units ? { units } : {}) });
  return p;
}
const syms = (p: Project) => [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && n.props.ref === 'U1');
const unitErc = (p: Project) => runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'unitNotPlaced');
const pinsOf = (p: Project, unit: number) =>
  syms(p).find((s) => s.props.unit === unit)!.children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type === 'pin').map((n) => String(n.props.number)).sort();

describe('S12: units of multi-unit parts', () => {
  it('unit letters', () => {
    expect([1, 2, 3, 26, 27].map(unitLetter)).toEqual(['A', 'B', 'C', 'Z', 'AA']);
  });

  it('place_part can place only some units and says which are still missing; ERC reports them', async () => {
    const p = await withPart('A');
    expect(syms(p)).toHaveLength(1);
    const v = unitErc(p);
    expect(v.map((x) => [x.severity, x.message])).toEqual([
      ['warning', expect.stringMatching(/U1: unit B is not placed/)],
      ['error', expect.stringMatching(/U1: power unit C is not placed/)],
    ]);
    // Placing them clears the report.
    const r = (await runTool(p, 'place_unit', { ref: 'U1', unit: 'C' })) as { units: { unit: string; placed: boolean }[]; pins: { pin: string }[] };
    expect(r.units).toEqual([{ unit: 'A', placed: true }, { unit: 'B', placed: false }, { unit: 'C (power)', placed: true }]);
    expect(r.pins.map((x) => x.pin).sort()).toEqual(['U1.4', 'U1.8']);
    await runTool(p, 'place_unit', { ref: 'U1', unit: 2 });
    expect(unitErc(p)).toEqual([]);
    await expect(runTool(p, 'place_unit', { ref: 'U1', unit: 'B' })).rejects.toThrow(/already placed/);
  });

  it('a placed unit switches to another unit in place: new pins, same position, value kept', async () => {
    const p = await withPart('A');
    const before = syms(p)[0]!;
    const at = { ...(p.engine.get(before.uid, 'position')!.value as Vec2) };
    await runTool(p, 'set_part_info', { ref: 'U1', value: 'LM358' });
    await runTool(p, 'switch_unit', { ref: 'U1', to: 'B' });
    expect(syms(p)).toHaveLength(1);
    expect(syms(p)[0]!.uid).toBe(before.uid);
    expect(syms(p)[0]!.props.unit).toBe(2);
    expect(syms(p)[0]!.props.Value).toBe('LM358');
    expect(pinsOf(p, 2)).toEqual(['5', '6', '7']);
    // Shown with its unit letter, as in KiCad.
    expect(displayRef(p.doc, syms(p)[0]!)).toBe('U1B');
    expect(p.engine.get(before.uid, 'position')!.value).toEqual(at);
    // The netlist sees the new pins.
    await runTool(p, 'add_part', { kind: 'resistor', x: -25.4, y: 0 });
    await runTool(p, 'add_label', { pin: 'U1.5', name: 'IN' });
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'IN' });
    expect(extractNetlist(p.doc, p.engine).byPin.get('U1.5')).toBe(extractNetlist(p.doc, p.engine).byPin.get('R1.1'));
    // Undo goes back to unit A.
    await runTool(p, 'undo', {});
    await runTool(p, 'undo', {});
    await runTool(p, 'undo', {});
    await runTool(p, 'undo', {});
    expect(pinsOf(p, 1)).toEqual(['1', '2', '3']);
  });

  it('switch_unit refuses a unit already placed, an unknown unit, and an ambiguous source', async () => {
    const p = await withPart();
    expect(syms(p)).toHaveLength(3);
    expect(unitErc(p)).toEqual([]);
    await expect(runTool(p, 'switch_unit', { ref: 'U1', to: 'B' })).rejects.toThrow(/say which one with from/);
    await expect(runTool(p, 'switch_unit', { ref: 'U1', from: 'A', to: 'B' })).rejects.toThrow(/already placed/);
    await expect(runTool(p, 'switch_unit', { ref: 'U1', from: 'A', to: 'D' })).rejects.toThrow(/does not exist; this part has A, B, C/);
    await runTool(p, 'delete', { target: syms(p).find((s) => s.props.unit === 2)!.uid });
    await runTool(p, 'switch_unit', { ref: 'U1', from: 'A', to: 'B' });
    // Now A is the missing one (a warning, not an error: it is not the power unit).
    expect(unitErc(p).map((v) => [v.severity, v.message])).toEqual([['warning', expect.stringMatching(/unit A is not placed/)]]);
    const r1 = (await runTool(p, 'add_part', { kind: 'resistor', x: 50, y: 50 })) as { ref: string };
    await expect(runTool(p, 'switch_unit', { ref: r1.ref, to: 'B' })).rejects.toThrow(/not a multi-unit part/);
  });

  it('multi-unit symbols imported from KiCad keep their units, so a missing unit is found and can be placed', async () => {
    const sch = `(kicad_sch (version 20231120) (generator test)
  (lib_symbols
    (symbol "Amp:Dual" (in_bom yes) (on_board yes)
      (symbol "Dual_1_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254)) (fill (type background)))
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "+" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
        (pin output line (at 7.62 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
      (symbol "Dual_2_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254)) (fill (type background)))
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "+" (effects (font (size 1.27 1.27)))) (number "5" (effects (font (size 1.27 1.27)))))
        (pin output line (at 7.62 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "7" (effects (font (size 1.27 1.27))))))
      (symbol "Dual_3_1"
        (pin power_in line (at 0 7.62 270) (length 2.54) (name "V+" (effects (font (size 1.27 1.27)))) (number "8" (effects (font (size 1.27 1.27)))))
        (pin power_in line (at 0 -7.62 90) (length 2.54) (name "V-" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Amp:Dual") (at 50.8 50.8 0) (unit 1) (uuid "u1a")
    (property "Reference" "U1" (at 0 0 0)) (property "Value" "LM358" (at 0 0 0)))
  (symbol (lib_id "Amp:Dual") (at 76.2 50.8 0) (unit 2) (uuid "u1b")
    (property "Reference" "U1" (at 0 0 0)) (property "Value" "LM358" (at 0 0 0))))`;
    const { doc } = importKicadSchematic({ files: { 'a.kicad_sch': sch }, root: 'a.kicad_sch' });
    const p = wrapProject(doc, [], 't');
    const v = runErc(p.doc, p.engine).violations.filter((x) => x.kind === 'unitNotPlaced');
    expect(v.map((x) => x.message)).toEqual([expect.stringMatching(/U1: power unit C is not placed/)]);
    await runTool(p, 'place_unit', { ref: 'U1', unit: 'C' });
    expect(runErc(p.doc, p.engine).violations.filter((x) => x.kind === 'unitNotPlaced')).toEqual([]);
    // The imported symbols are linked through unitDef, not partId (Update PCB copies partId to the board).
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'symbol').every((n) => n.props.partId === undefined && n.props.unitDef === 'kicad:Amp:Dual')).toBe(true);
  });
});
