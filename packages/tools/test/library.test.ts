import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { buildBom, extractNetlist, genericFootprint, genericFootprintNames, genericAlias, planSync, StyleEngine, parseOffersCsv, unitPrice, type FootprintSpec } from '@hassassin/core';
import { importKicadPcb, importKicadSchematic, parseKicadFootprint, parseKicadSymbolLib } from '@hassassin/kicad-import';
import { Library, newProject, runTool, type LibrarySource } from '@hassassin/tools';

const MOD = `(footprint "R_TEST" (layer "F.Cu") (descr "test resistor") (tags "resistor")
  (property "Reference" "REF**" (at 0 -1.4 0) (layer "F.SilkS") (effects (font (size 1 1))))
  (fp_line (start -0.2 -0.7) (end 0.2 -0.7) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  (fp_rect (start -1.5 -0.75) (end 1.5 0.75) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25))
  (pad "3" thru_hole circle (at 0 2 90) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask")))`;

const SYM = `(kicad_symbol_lib (version 20231120)
	(symbol "OPAMP2"
		(property "Reference" "U" (at 0 0 0))
		(property "Value" "OPAMP2" (at 0 0 0))
		(property "Footprint" "soic-8" (at 0 0 0))
		(property "Description" "Dual op-amp" (at 0 0 0))
		(property "ki_keywords" "amplifier dual" (at 0 0 0))
		(symbol "OPAMP2_1_1" (pin output line (at 5.08 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
		(symbol "OPAMP2_2_1" (pin output line (at 5.08 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "7" (effects (font (size 1.27 1.27))))))
		(symbol "OPAMP2_3_1" (pin power_in line (at 0 5.08 270) (length 2.54) (name "V+" (effects (font (size 1.27 1.27)))) (number "8" (effects (font (size 1.27 1.27))))) (pin power_in line (at 0 -5.08 90) (length 2.54) (name "V-" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27))))))
	)
	(symbol "OPAMP2B" (extends "OPAMP2") (property "Value" "OPAMP2B" (at 0 0 0)))
	(symbol "GNDX" (power) (property "Reference" "#PWR" (at 0 0 0)) (symbol "GNDX_0_1" (pin power_in line (at 0 0 0) (length 0) (name "GND") (number "1"))))
)`;

describe('footprints', () => {
  it('generates every generic footprint with unique pad numbers and a courtyard', () => {
    for (const n of genericFootprintNames()) {
      const fp = genericFootprint(n)!;
      expect(fp, n).toBeTruthy();
      expect(fp.name).toBe(n);
      const nums = fp.pads.map((p) => p.number).filter(Boolean);
      expect(new Set(nums).size, n).toBe(nums.length);
      expect(fp.graphics.some((g) => g.layer === 'F.CrtYd'), n).toBe(true);
    }
    expect(genericFootprint('soic-8')!.pads[0]!.at.x).toBeLessThan(0); // pin 1 on the left
    expect(genericFootprint('qfn-32-5x5-p0.5-ep3.5')!.pads.length).toBe(33);
    expect(genericAlias('Resistor_SMD:R_0603_1608Metric')).toBe('chip-0603');
    expect(genericAlias('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')).toBe('soic-8');
    expect(genericAlias('Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical')).toBe('header-1x04-p2.54');
  });

  it('reads a KiCad footprint', () => {
    const fp = parseKicadFootprint(MOD, 'Test');
    expect(fp.name).toBe('Test:R_TEST');
    expect(fp.pads.map((p) => [p.number, p.type, p.shape])).toEqual([['1', 'smd', 'roundrect'], ['2', 'smd', 'roundrect'], ['3', 'through', 'circle']]);
    expect(fp.pads[2]!.drill).toBe(1);
    expect(fp.pads[2]!.rot).toBe(90);
    expect(fp.graphics.find((g) => g.kind === 'text')).toMatchObject({ text: '%R', layer: 'F.SilkS' });
  });

  it('reads a KiCad symbol library: units, extends, power symbols skipped', () => {
    const { parts } = parseKicadSymbolLib(SYM, 'T');
    expect(parts.map((p) => p.id)).toEqual(['kicad:T:OPAMP2', 'kicad:T:OPAMP2B']);
    const p = parts[0]!;
    expect(p.units.map((u) => u.pins.map((x) => x.number))).toEqual([['1'], ['7'], ['8', '4']]);
    expect(p).toMatchObject({ prefix: 'U', footprint: 'soic-8', description: 'Dual op-amp' });
    expect(parts[1]!.units.length).toBe(3);
    expect(parts[1]!.value).toBe('OPAMP2B');
  });
});

describe('parts in a project', () => {
  const extra: FootprintSpec = parseKicadFootprint(MOD, 'Test');
  const source: LibrarySource = {
    name: 'test',
    searchParts: async () => [],
    searchFootprints: async () => [{ name: extra.name, source: 'test' }],
    getPart: async (id) => parseKicadSymbolLib(SYM, 'T').parts.find((p) => p.id === id) ?? null,
    getFootprint: async (n) => (n === extra.name ? extra : null),
  };
  const ctx = { library: new Library([source]) };

  it('places a multi-unit part, builds real footprints on the board, swaps footprints in place', async () => {
    const p = newProject('t');
    const r = (await runTool(p, 'place_part', { id: 'kicad:T:OPAMP2', x: 50, y: 50 }, ctx)) as { ref: string; units: number; footprintFound: boolean };
    expect(r).toMatchObject({ ref: 'U1', units: 3, footprintFound: true });
    await runTool(p, 'add_part', { kind: 'resistor', x: 20, y: 50, value: '10k' }, ctx);
    await runTool(p, 'add_label', { pin: 'U1.1', name: 'OUT' }, ctx);
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'OUT' }, ctx);
    const up = (await runTool(p, 'update_pcb', {}, ctx)) as { componentsAdded: string[]; missingPads: string[]; footprintsMissing: string[] };
    expect(up.componentsAdded.sort()).toEqual(['R1', 'U1']);
    expect(up.missingPads).toEqual([]);
    const u1 = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'U1')!;
    expect(u1.props.placeholder).toBeUndefined();
    expect(u1.children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type === 'pad').length).toBe(8);
    // The project keeps a copy of the part.
    expect(p.doc.meta['part:kicad:T:OPAMP2']).toBeTruthy();

    await runTool(p, 'move_part', { ref: 'R1', x: 110, y: 120, rotation: 90 }, ctx);
    const sw = (await runTool(p, 'assign_footprint', { ref: 'R1', footprint: 'Test:R_TEST' }, ctx)) as { update: { footprintsChanged: string[] } };
    expect(sw.update.footprintsChanged).toEqual(['R1']);
    const r1 = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'R1')!;
    expect(r1.props.Footprint).toBe('Test:R_TEST');
    expect(p.engine.get(r1.uid, 'position')?.value).toEqual({ x: 110, y: 120 });
    expect(p.engine.get(r1.uid, 'rotation')?.value).toBe(90);
    const pad1 = r1.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && n.name === '1')!;
    expect(pad1.props.net).toBe('/OUT');
    expect(p.doc.meta['fp:Test:R_TEST']).toBeTruthy();
    // Undo restores the old footprint in one step.
    await runTool(p, 'undo', {}, ctx);
    expect([...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'R1')!.props.Footprint).toBe('chip-0603');
  });

  it('prices the BOM from offers and drives the components gate', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '1k' }, ctx);
    await runTool(p, 'add_part', { kind: 'resistor', x: 10, y: 0, value: '1k' }, ctx);
    await runTool(p, 'update_pcb', {}, ctx);
    for (const ref of ['R1', 'R2']) await runTool(p, 'set_part_info', { ref, mpn: 'RC0603-1K' }, ctx);
    const csv = 'MPN,Supplier,SKU,Stock,Currency,Price@1,Price@100\nRC0603-1K,ShopA,A1,150,USD,0.10,0.01\nRC0603-1K,ShopB,B1,1000000,USD,0.05,0.02\nUNUSED,ShopA,X,1,USD,1,1\n';
    const imp = (await runTool(p, 'import_offers', { csv }, ctx)) as { matched: string[]; unmatched: string[] };
    expect(imp).toEqual({ matched: ['RC0603-1K'], unmatched: ['UNUSED'] });
    const bom50 = buildBom(p.doc, 50); // 100 needed: ShopA 0.01 × 100 = 1.00
    expect(bom50.lines).toHaveLength(1);
    expect(bom50.lines[0]!.best).toMatchObject({ supplier: 'ShopA', total: 1 });
    const bom100 = buildBom(p.doc, 100); // 200 needed: ShopA short on stock → ShopB 0.02 × 200
    expect(bom100.lines[0]!.best).toMatchObject({ supplier: 'ShopB', total: 4 });
    const status = (await runTool(p, 'project_status', {}, ctx)) as { gates: { id: string; state: string }[] };
    expect(status.gates.find((g) => g.id === 'components')!.state).toBe('ok');
    expect(unitPrice({ supplier: 'x', currency: 'USD', breaks: [{ qty: 10, price: 2 }, { qty: 1, price: 3 }] }, 5)).toBe(3);
    expect(parseOffersCsv('mpn;price\n"A,1";"1.5"\n').get('A,1')![0]!.breaks).toEqual([{ qty: 1, price: 1.5 }]);
  });
});

const dir = process.env.KICAD_PROJECT_DIR;
describe.runIf(!!dir && existsSync(dir!))('real project with library sync', () => {
  it('update_pcb on an imported, consistent project changes nothing', () => {
    const files: Record<string, string> = {};
    let pcb = '';
    let root = '';
    for (const f of readdirSync(dir!)) {
      if (f.endsWith('.kicad_sch')) files[f] = readFileSync(`${dir}/${f}`, 'utf8');
      if (f.endsWith('.kicad_pcb')) (pcb = readFileSync(`${dir}/${f}`, 'utf8')), (root = f.replace('.kicad_pcb', '.kicad_sch'));
    }
    const { doc } = importKicadPcb(pcb);
    importKicadSchematic({ files, root }, doc);
    const engine = new StyleEngine(doc);
    const { report } = planSync(doc, engine, extractNetlist(doc, engine), { resolveFootprint: () => null });
    console.log({ props: report.propChanges, swaps: report.footprintsChanged, pads: report.padChanges });
    expect(report.footprintsChanged).toEqual([]);
    expect(report.componentsAdded).toEqual([]);
  });
});
