import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StyleEngine } from '@hassassin/core';
import { importKicadPcb } from '@hassassin/kicad-import';
import { buildFab, crc32, fabZip } from '@hassassin/fab';

/** Structural Gerber check: every apertured draw uses a defined aperture, regions close, file ends with M02. */
function checkGerber(text: string): { draws: number; flashes: number; regions: number } {
  const lines = text.trim().split('\n');
  expect(lines[lines.length - 1]).toBe('M02*');
  const defined = new Set<string>();
  let draws = 0;
  let flashes = 0;
  let regions = 0;
  let inRegion = false;
  let current: string | null = null;
  for (const l of lines) {
    expect(l.endsWith('*') || l.endsWith('%')).toBe(true);
    const ad = /^%ADD(\d+)C,([\d.]+)\*%$/.exec(l);
    if (ad) {
      defined.add(ad[1]!);
      expect(Number(ad[2])).toBeGreaterThan(0);
      continue;
    }
    if (l === 'G36*') {
      expect(inRegion).toBe(false);
      inRegion = true;
      regions++;
      continue;
    }
    if (l === 'G37*') {
      expect(inRegion).toBe(true);
      inRegion = false;
      continue;
    }
    const sel = /^D(\d+)\*$/.exec(l);
    if (sel) {
      expect(defined.has(sel[1]!)).toBe(true);
      current = sel[1]!;
      continue;
    }
    if (/^X-?\d+Y-?\d+D0[13]\*$/.test(l) && !inRegion) {
      expect(current).not.toBeNull();
      if (l.endsWith('D03*')) flashes++;
      else draws++;
    }
  }
  expect(inRegion).toBe(false);
  return { draws, flashes, regions };
}

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

const real = process.env.KICAD_SAMPLE;
describe.runIf(!!real && existsSync(real!))('fabrication output for a real board', () => {
  it('writes well-formed Gerbers, drills, BOM and placement', () => {
    const { doc, layers } = importKicadPcb(readFileSync(real!, 'utf8'));
    const e = new StyleEngine(doc);
    const r = buildFab(doc, e, layers.map((l) => l.name), 'solar');
    const names = r.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['solar-F_Cu.gbr', 'solar-B_Cu.gbr', 'solar-F_Mask.gbr', 'solar-Edge_Cuts.gbr', 'solar-PTH.drl', 'solar-BOM.csv', 'solar-placement.csv']));
    const stats: Record<string, unknown> = {};
    for (const f of r.files) if (f.kind === 'gerber') stats[f.name] = checkGerber(f.data);
    const drill = r.files.find((f) => f.name === 'solar-PTH.drl')!.data;
    const hits = drill.split('\n').filter((l) => /^X-?[\d.]+Y-?[\d.]+/.test(l)).length;
    const tools = drill.split('\n').filter((l) => /^T\d+C/.test(l)).map((l) => l.split('C')[1]);
    const bomLines = r.files.find((f) => f.name === 'solar-BOM.csv')!.data.trim().split('\n').length - 1;
    const z = fabZip(r);
    console.log({ stats, hits, tools, bomLines, zipKB: Math.round(z.length / 1024), notes: r.notes });
    expect(hits).toBeGreaterThan(0);
    expect(bomLines).toBeGreaterThan(0);
  });
});
