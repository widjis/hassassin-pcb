import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateFootprint, gridRowName, padFromLeads, type FootprintSpec, type FpPad } from '@hassassin/core';
import { parseKicadFootprint } from '@hassassin/kicad-import';
import { newProject, runTool } from '@hassassin/tools';

const pad = (fp: FootprintSpec, n: string) => fp.pads.find((p) => p.number === n)!;
/** Position and size match within 0.01 mm. */
const expectPad = (p: FpPad, x: number, y: number, w: number, h: number) => {
  expect(Math.abs(p.at.x - x), `x of ${p.number}`).toBeLessThanOrEqual(0.01);
  expect(Math.abs(p.at.y - y), `y of ${p.number}`).toBeLessThanOrEqual(0.01);
  expect(Math.abs(p.size.x - w), `w of ${p.number}`).toBeLessThanOrEqual(0.01);
  expect(Math.abs(p.size.y - h), `h of ${p.number}`).toBeLessThanOrEqual(0.01);
};

// Datasheet numbers used below:
//  ESP-12F module: 16 × 24 mm, 22 edge pads at 2.0 mm (8 left, 6 bottom, 8 right), land 1.5 × 0.9 mm
//    centred on the module edge, pad 1 centre 7.5 mm below the top edge.
//  QFN-24 4 × 4 mm, 0.5 mm pitch: land 0.85 × 0.28 mm, pad centres 3.9 mm apart, exposed pad 2.6 mm
//    with 3 × 3 thermal vias (0.3 mm drill, 1.0 mm pitch).
//  2 × 20 pin header, 2.54 mm: 1.0 mm drill, 1.7 mm pads, odd pins in the left row.
const ESP12F = { name: 'esp-12f', family: 'castellated', body: { w: 16, h: 24 }, pitch: 2, left: 8, bottom: 6, right: 8, pad: { length: 1.5, width: 0.9 }, leftStart: 7.5 } as const;
const QFN24 = { name: 'qfn-24-4x4-ep2.6', family: 'four-side', pins: 24, pitch: 0.5, spanX: 3.9, pad: { length: 0.85, width: 0.28 }, body: { w: 4, h: 4 }, ep: { w: 2.6, h: 2.6, vias: { drill: 0.3, rows: 3, cols: 3, pitch: 1 } } } as const;
const HDR = { name: 'header-2x20-gen', family: 'two-row', pins: 40, pitch: 2.54, rowSpacing: 2.54, drill: 1.0, padDiameter: 1.7, numbering: 'zigzag' } as const;

describe('S19: footprint generator', () => {
  it('ESP-12F-style module: 22 edge pads, counter-clockwise from the top of the left side', () => {
    const fp = generateFootprint(ESP12F);
    expect(fp.pads.map((p) => p.number)).toEqual(Array.from({ length: 22 }, (_, i) => String(i + 1)));
    expectPad(pad(fp, '1'), -8, -12 + 7.5, 1.5, 0.9);
    expectPad(pad(fp, '8'), -8, -12 + 7.5 + 14, 1.5, 0.9);
    expectPad(pad(fp, '9'), -5, 12, 0.9, 1.5);
    expectPad(pad(fp, '14'), 5, 12, 0.9, 1.5);
    expectPad(pad(fp, '15'), 8, -12 + 7.5 + 14, 1.5, 0.9);
    expectPad(pad(fp, '22'), 8, -12 + 7.5, 1.5, 0.9);
    // Outlines: fab body, courtyard, silk, pin-1 mark, reference and value.
    const layers = fp.graphics.map((g) => g.layer);
    for (const l of ['F.Fab', 'F.CrtYd', 'F.SilkS']) expect(layers).toContain(l);
    expect(fp.graphics.some((g) => g.kind === 'text' && g.text === '%R')).toBe(true);
    expect(fp.graphics.some((g) => g.kind === 'text' && g.text === '%V')).toBe(true);
    expect(fp.graphics.some((g) => g.kind === 'circle' && g.layer === 'F.SilkS')).toBe(true);
    // Half holes for designing the module itself.
    const castellated = generateFootprint({ ...ESP12F, name: 'esp-12f-holes', drill: 0.6 });
    expect(castellated.pads.every((p) => p.type === 'through' && p.drill === 0.6)).toBe(true);
  });

  it('QFN-24 with an exposed pad and thermal vias', () => {
    const fp = generateFootprint(QFN24);
    expectPad(pad(fp, '1'), -1.95, -1.25, 0.85, 0.28);
    expectPad(pad(fp, '6'), -1.95, 1.25, 0.85, 0.28);
    expectPad(pad(fp, '7'), -1.25, 1.95, 0.28, 0.85);
    expectPad(pad(fp, '13'), 1.95, 1.25, 0.85, 0.28);
    expectPad(pad(fp, '19'), 1.25, -1.95, 0.28, 0.85);
    expectPad(pad(fp, '24'), -1.25, -1.95, 0.28, 0.85);
    const ep = fp.pads.filter((p) => p.number === '25');
    expect(ep).toHaveLength(10); // the pad and nine vias
    expectPad(ep.find((p) => p.type === 'smd')!, 0, 0, 2.6, 2.6);
    expect(ep.filter((p) => p.type === 'through').map((p) => p.drill)).toEqual(Array(9).fill(0.3));
  });

  it('2 × 20 pin header: zigzag numbering, square pad 1, drill', () => {
    const fp = generateFootprint(HDR);
    expect(fp.pads).toHaveLength(40);
    expectPad(pad(fp, '1'), -1.27, -24.13, 1.7, 1.7);
    expectPad(pad(fp, '2'), 1.27, -24.13, 1.7, 1.7);
    expectPad(pad(fp, '39'), -1.27, 24.13, 1.7, 1.7);
    expectPad(pad(fp, '40'), 1.27, 24.13, 1.7, 1.7);
    expect(pad(fp, '1').shape).toBe('rect');
    expect(pad(fp, '2').shape).toBe('circle');
    expect(fp.pads.every((p) => p.drill === 1)).toBe(true);
    // A DIP numbers around the package instead.
    const dip = generateFootprint({ name: 'dip-8-gen', family: 'two-row', pins: 8, pitch: 2.54, rowSpacing: 7.62, drill: 0.8 });
    expect([pad(dip, '4').at, pad(dip, '5').at]).toEqual([{ x: -3.81, y: 3.81 }, { x: 3.81, y: 3.81 }]);
  });

  it('pads derived from lead dimensions use the documented margins', () => {
    // SOIC-8 (JEDEC MS-012 maximums): E 6.2, L 1.27, b 0.51, gull-wing.
    expect(padFromLeads({ span: 6.2, length: 1.27, width: 0.51 }, 1.27)).toEqual({ length: 1.97, width: 0.61, centre: 2.465 });
    // QFN (no-lead): E 4.0, L 0.5, b 0.3 at 0.5 mm pitch → width kept 0.2 mm from the next pad.
    expect(padFromLeads({ span: 4, length: 0.5, width: 0.3, type: 'nolead' }, 0.5)).toEqual({ length: 0.8, width: 0.3, centre: 1.9 });
    expect(gridRowName(7)).toBe('H');
    expect(gridRowName(8)).toBe('J'); // I is skipped
    const bga = generateFootprint({ name: 'bga-test', family: 'grid', rows: 3, cols: 3, pitch: 0.8, ball: 0.4, skip: ['B2'] });
    expect(bga.pads.map((p) => p.number)).toEqual(['A1', 'A2', 'A3', 'B1', 'B3', 'C1', 'C2', 'C3']);
  });

  it('refuses bad input with a readable message', () => {
    expect(() => generateFootprint({ name: 'x', family: 'two-row', pins: 7, pitch: 1.27, rowSpacing: 5, pad: { length: 1.5, width: 0.6 } })).toThrow(/even number/);
    expect(() => generateFootprint({ name: 'x', family: 'two-row', pins: 8, pitch: 0.5, rowSpacing: 5, pad: { length: 1.5, width: 0.6 } })).toThrow(/overlap/);
    expect(() => generateFootprint({ name: 'x', family: 'four-side', pins: 24, pitch: 0.5 } as never)).toThrow(/Give pad/);
    expect(() => generateFootprint({ name: '', family: 'pads', pads: [] })).toThrow(/name/);
  });

  it('create_footprint stores it in the project; a board using all three passes DRC', async () => {
    const p = newProject('t');
    for (const [i, [params, pins]] of ([[ESP12F, 22], [QFN24, 25], [HDR, 40]] as const).entries()) {
      // Apart on the schematic, so their pins do not touch.
      const r = (await runTool(p, 'add_part', { kind: 'ic', pins, x: i * 101.6, y: 0 })) as { ref: string };
      const out = (await runTool(p, 'create_footprint', { ...params, ref: r.ref })) as { footprint: string; pads: string[] };
      expect(out.footprint).toBe(params.name);
      expect(p.doc.meta[`fp:${params.name}`]).toBeTruthy();
    }
    await runTool(p, 'update_pcb', {});
    await runTool(p, 'set_board_outline', { x: 0, y: 0, width: 80, height: 60 });
    const els = [...p.doc.nodes.values()].filter((n) => n.type === 'element');
    expect(els.map((e) => e.props.footprint ?? e.props.Footprint).sort()).toEqual(['esp-12f', 'header-2x20-gen', 'qfn-24-4x4-ep2.6']);
    const spots = [{ x: 15, y: 30 }, { x: 40, y: 30 }, { x: 65, y: 30 }];
    for (const [i, e] of els.entries()) await runTool(p, 'move_part', { ref: e.name, ...spots[i]! });
    const drc = (await runTool(p, 'run_drc', {})) as { errors: number; violations?: { kind: string; message: string }[] };
    expect(drc.errors, JSON.stringify(drc.violations?.slice(0, 5))).toBe(0);
    await expect(runTool(p, 'create_footprint', { name: 'chip-0603', family: 'pads', pads: [{ number: '1', x: 0, y: 0, w: 1, h: 1 }] })).rejects.toThrow(/generic footprint/);
  });
});

// Reference check against the KiCad libraries installed on this machine (read while the test runs,
// never copied). Pads come from the datasheet's lead dimensions; KiCad used its own land-pattern
// rules, so sizes may differ a little: numbering and positions must agree.
const KICAD_FP = ['/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints', '/usr/share/kicad/footprints', process.env.KICAD9_FOOTPRINT_DIR ?? '', process.env.KICAD8_FOOTPRINT_DIR ?? ''].find((d) => d && existsSync(d));
describe.runIf(!!KICAD_FP)('S19: generated footprints against the installed KiCad libraries', () => {
  const cases = [
    { lib: 'Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod', gen: { name: 'soic-8-gen', family: 'two-row' as const, pins: 8, pitch: 1.27, leads: { span: 6.2, length: 1.27, width: 0.51 } } },
    { lib: 'Package_SO.pretty/TSSOP-20_4.4x6.5mm_P0.65mm.kicad_mod', gen: { name: 'tssop-20-gen', family: 'two-row' as const, pins: 20, pitch: 0.65, leads: { span: 6.4, length: 0.75, width: 0.3 } } },
    { lib: 'Package_DFN_QFN.pretty/QFN-24-1EP_4x4mm_P0.5mm_EP2.6x2.6mm.kicad_mod', gen: { name: 'qfn-24-gen', family: 'four-side' as const, pins: 24, pitch: 0.5, leads: { span: 4.0, length: 0.5, width: 0.25, type: 'nolead' as const }, ep: { w: 2.6, h: 2.6 } } },
  ];
  for (const c of cases) {
    it(c.lib.split('/')[1]!, () => {
      const ref = parseKicadFootprint(readFileSync(`${KICAD_FP}/${c.lib}`, 'utf8'));
      const fp = generateFootprint(c.gen);
      const theirs = ref.pads.filter((p) => p.type === 'smd' && p.number);
      // Same pad numbers (KiCad may split an exposed pad into paste windows: compare copper pads).
      const nums = (pads: FpPad[]) => [...new Set(pads.filter((p) => p.type === 'smd').map((p) => p.number))].sort((a, b) => Number(a) - Number(b));
      expect(nums(fp.pads)).toEqual(nums(theirs));
      for (const t of theirs) {
        const g = fp.pads.find((p) => p.number === t.number && p.type === 'smd')!;
        if (!g || t.size.x < 0.05) continue;
        expect(Math.abs(g.at.x - t.at.x), `pad ${t.number} x`).toBeLessThanOrEqual(0.1);
        expect(Math.abs(g.at.y - t.at.y), `pad ${t.number} y`).toBeLessThanOrEqual(0.1);
        expect(Math.abs(g.size.x - t.size.x), `pad ${t.number} w`).toBeLessThanOrEqual(0.1);
        expect(Math.abs(g.size.y - t.size.y), `pad ${t.number} h`).toBeLessThanOrEqual(0.1);
      }
    });
  }
});
