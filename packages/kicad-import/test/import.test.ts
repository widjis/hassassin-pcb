import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { padGeom, querySelectorAll, StyleEngine } from '@hassassin/core';
import { importKicadPcb, parseSExpr } from '@hassassin/kicad-import';

const SMALL = `(kicad_pcb (version 20240108) (generator "test")
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user "F.Silkscreen") (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "/SIG \\"A\\"")
  (footprint "R:R_0603" (layer "F.Cu") (uuid "fp-1") (at 10 20 90)
    (property "Reference" "R1" (at 0 -1.5 90) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 1.5 90) (layer "F.Fab"))
    (fp_line (start -1 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
    (pad "1" smd roundrect (at -0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 1 "GND"))
    (pad "2" thru_hole circle (at 0.8 0 90) (size 1.2 1.2) (drill 0.6) (layers "*.Cu" "*.Mask") (net 2 "/SIG \\"A\\""))
  )
  (gr_line (start 0 0) (end 30 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
  (segment (start 10 19.2) (end 15 19.2) (width 0.3) (layer "F.Cu") (net 1))
  (via (at 15 19.2) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND"))
  (zone (net 1) (net_name "GND") (layer "B.Cu") (polygon (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30)))
    (filled_polygon (layer "B.Cu") (pts (xy 1 1) (xy 29 1) (xy 29 29))))
)`;

describe('s-expressions', () => {
  it('parses strings with escapes and nested lists', () => {
    const r = parseSExpr('(a "x \\"y\\"" (b 1 2) c)');
    expect(r).toEqual(['a', { s: 'x "y"' }, ['b', '1', '2'], 'c']);
  });
  it('rejects broken input', () => {
    expect(() => parseSExpr('(a (b)')).toThrow();
    expect(() => parseSExpr('(a))')).toThrow();
  });
});

describe('importKicadPcb', () => {
  it('builds the tree with nets, pads, tracks and zones', () => {
    const { doc, stats, layers } = importKicadPcb(SMALL, 'small.kicad_pcb');
    expect(layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']);
    expect(stats).toMatchObject({ footprints: 1, pads: 2, traces: 1, vias: 1, zones: 1 });

    const r1 = querySelectorAll(doc, '#R1')[0]!;
    expect(r1.props.Value).toBe('10k');
    const e = new StyleEngine(doc);
    // pad 1 is stored footprint-local; rotated 90° about (10,20) it lands at (10, 20.8)
    const pad1 = querySelectorAll(doc, '#R1 > pad[number="1"]')[0]!;
    expect(e.get(pad1.uid, 'position')!.value).toEqual({ x: -0.8, y: 0 });
    expect(e.get(pad1.uid, 'rotation')!.value).toBe(0);
    const g = padGeom(doc, e, pad1, ['F.Cu', 'B.Cu'])!;
    expect(g.center.x).toBeCloseTo(10);
    expect(g.center.y).toBeCloseTo(20.8);
    expect(g.rot).toBe(90);
    expect(e.get(pad1.uid, 'padShape')?.value).toBe('roundrect');

    const pad2 = querySelectorAll(doc, '#R1 > pad[number="2"]')[0]!;
    expect(pad2.props.net).toBe('/SIG "A"');
    expect(e.get(pad2.uid, 'layers')?.value).toEqual(['F.Cu', 'B.Cu', 'F.Mask', 'B.Mask']);

    const gnd = querySelectorAll(doc, 'net#GND')[0]!;
    expect(gnd.props.netClass).toBe('ground');
    expect(querySelectorAll(doc, 'net#GND > trace').length).toBe(1);
    expect(querySelectorAll(doc, 'net#GND > via').length).toBe(1);
    const fill = querySelectorAll(doc, 'net#GND > fill')[0]!;
    expect((fill.data!.fills as Record<string, unknown[][]>)['B.Cu']).toHaveLength(1);
    expect((fill.data!.fills as Record<string, unknown[][]>)['B.Cu']![0]).toHaveLength(1);
    // trace keeps its own width; ground default would be 0.5
    const t = querySelectorAll(doc, 'trace')[0]!;
    expect(e.get(t.uid, 'traceWidth')).toMatchObject({ value: 0.3, source: { kind: 'object' } });
  });

  const real = process.env.KICAD_SAMPLE;
  it.runIf(!!real && existsSync(real!))('imports a real board file', () => {
    const t0 = performance.now();
    const { doc, stats, warnings } = importKicadPcb(readFileSync(real!, 'utf8'));
    const t1 = performance.now();
    const e = new StyleEngine(doc);
    const t2 = performance.now();
    console.log({ stats, warnings: warnings.length, nodes: doc.nodes.size, importMs: Math.round(t1 - t0), styleMs: Math.round(t2 - t1) });
    expect(stats.footprints).toBeGreaterThan(0);
    expect(e.rulesetMatches().length).toBeGreaterThan(0);
  });
});
