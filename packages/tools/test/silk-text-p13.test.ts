/**
 * P13 (docs/05-pcb-improvements.md): board texts drawn with the project's stroke font, the same strokes in
 * the legend Gerbers, in the editor and in DRC.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boardTextStrokes, glyph, hasGlyph, textStrokes, type Vec2 } from '@hassassin/core';
import { buildFab } from '@hassassin/fab';
import { fixtureMcu, openProject, runTool } from '@hassassin/tools';

const box = (strokes: Vec2[][]) => {
  const pts = strokes.flat();
  return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
};
/** The drawn points of a Gerber file, in board coordinates (Y back down). */
const gerberPoints = (g: string): Vec2[] => [...g.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map((m) => ({ x: Number(m[1]) / 1e6, y: -Number(m[2]) / 1e6 }));
const solar = () => openProject([{ name: 'solar.kicad_pcb', text: readFileSync(new URL('../../../apps/web/public/samples/solar.kicad_pcb', import.meta.url), 'utf8') }]);

describe('P13: silkscreen text from a vector font', () => {
  it('has a glyph for every printable ASCII character and a few value signs, on its grid', () => {
    const chars = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), 'Ω', 'µ', '°', '±'];
    for (const ch of chars) {
      expect(hasGlyph(ch), ch).toBe(true);
      for (const s of glyph(ch)) {
        expect(s.length, ch).toBeGreaterThanOrEqual(2);
        for (const p of s) {
          expect(p.x, ch).toBeGreaterThanOrEqual(0);
          expect(p.x, ch).toBeLessThanOrEqual(4);
          expect(p.y, ch).toBeGreaterThanOrEqual(-2);
          expect(p.y, ch).toBeLessThanOrEqual(7);
        }
      }
    }
    expect(glyph(' ')).toEqual([]);
    // An unknown character shows as a box.
    expect(glyph('☃').length).toBe(1);
  });

  it('places text by size, justify, rotation, mirror and keep-upright', () => {
    const at = { pos: { x: 10, y: 20 }, size: 1.2, rot: 0 };
    const h = box(textStrokes('H', at));
    // Capitals as tall as the size, centred on the position.
    expect(h.maxY - h.minY).toBeCloseTo(1.2, 9);
    expect((h.minY + h.maxY) / 2).toBeCloseTo(20, 9);
    expect((h.minX + h.maxX) / 2).toBeCloseTo(10, 9);
    expect(h.maxX - h.minX).toBeCloseTo(0.8, 9);
    // Left: starts at the position; right: ends there.
    expect(box(textStrokes('HH', { ...at, justify: 'left' })).minX).toBeCloseTo(10, 9);
    expect(box(textStrokes('HH', { ...at, justify: 'right' })).maxX).toBeCloseTo(10, 9);
    // Turned 90° counter-clockwise: a text reading upwards, as tall as it was wide.
    const r = box(textStrokes('HHH', { ...at, rot: 90 }));
    expect(r.maxY - r.minY).toBeGreaterThan(r.maxX - r.minX);
    // Mirrored: "L" has its foot to the left.
    const l = textStrokes('L', at);
    const lm = textStrokes('L', { ...at, mirror: true });
    expect(l[0]![2]!.x).toBeGreaterThan(l[0]![1]!.x);
    expect(lm[0]![2]!.x).toBeLessThan(lm[0]![1]!.x);
    // Upside down (180°) with keep-upright: the same strokes as 0°.
    expect(textStrokes('L', { ...at, rot: 180, upright: true })[0]![2]!.x).toBeCloseTo(l[0]![2]!.x, 9);
    // Two lines: one above the other, centred together.
    const two = box(textStrokes('A\nB', at));
    expect(two.maxY - two.minY).toBeCloseTo(1.2 * 2.6, 9);
  });

  it('a part flipped to the bottom has its reference mirrored on B.SilkS', async () => {
    const p = await fixtureMcu();
    const el = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'R1')!;
    const ref = () => el.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'text' && p.engine.get(n.uid, 'text')?.value === 'R1')!;
    const before = boardTextStrokes(p.doc, p.engine, ref())!;
    expect(before.layer).toBe('F.SilkS');
    await runTool(p, 'flip_part', { refs: ['R1'] });
    const after = boardTextStrokes(p.doc, p.engine, ref())!;
    expect(after.layer).toBe('B.SilkS');
    // "R" comes first: left of "1" on the top, right of it on the bottom (read from below).
    const first = (t: typeof before) => (t.strokes[0]![0]!.x);
    const last = (t: typeof before) => t.strokes[t.strokes.length - 1]![0]!.x;
    const rot = Number(p.engine.get(el.uid, 'rotation')?.value ?? 0);
    if (Math.abs(rot % 180) < 1e-6) {
      expect(first(before)).toBeLessThan(last(before));
      expect(first(after)).toBeGreaterThan(last(after));
    }
  });

  it('the legend Gerbers carry the texts of the solar board, at their place', () => {
    const p = solar();
    const fab = buildFab(p.doc, p.engine, p.layers.map((l) => l.name), 'solar');
    expect(fab.notes.join(' ')).not.toMatch(/not in the legend/);
    const top = fab.files.find((f) => f.name.endsWith('-F_SilkS.gbr'))!;
    expect(top).toBeDefined();
    const pts = gerberPoints(top.data);
    // Every visible top text has its strokes in the file.
    const texts = [...p.doc.nodes.values()].map((n) => boardTextStrokes(p.doc, p.engine, n)).filter((t) => t && t.layer === 'F.SilkS');
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) {
      const s = t!.strokes[0]!;
      expect(pts.some((q) => Math.abs(q.x - s[0]!.x) < 2e-6 && Math.abs(q.y - s[0]!.y) < 2e-6)).toBe(true);
    }
  });
});
