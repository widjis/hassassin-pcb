import { describe, expect, it } from 'vitest';
import { drawingsToPdf, sheetDrawing, schematicPdf, schematicSvgs, textBox, type SheetDrawing } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const sheet = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!;
const ascii = (b: Uint8Array) => String.fromCharCode(...b);

async function smallProject(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'capacitor', x: 15.24, y: 0 });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'C1.1' });
  await runTool(p, 'set_part_info', { ref: 'R1', value: '10kΩ' });
  return p;
}

/** Checks the cross-reference table: every offset must point at "n 0 obj". */
function checkPdf(bytes: Uint8Array): { pages: number; text: string } {
  const s = ascii(bytes);
  expect(s.startsWith('%PDF-1.4\n')).toBe(true);
  expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  const startxref = Number(/startxref\n(\d+)/.exec(s)![1]);
  expect(s.slice(startxref, startxref + 4)).toBe('xref');
  const rows = s.slice(startxref).split('\n').filter((l) => / 00000 n $/.test(l));
  rows.forEach((row, i) => expect(s.slice(Number(row.slice(0, 10)), Number(row.slice(0, 10)) + 12)).toContain(`${i + 1} 0 obj`));
  // Stream lengths match their content.
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) expect(s.slice(m.index! + m[0].length + Number(m[1]), m.index! + m[0].length + Number(m[1]) + 10)).toBe('\nendstream');
  return { pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]), text: s };
}

describe('S10: PDF and SVG export of the schematic', () => {
  it('writes a valid vector PDF with the parts, values and wires of the sheet', async () => {
    const p = await smallProject();
    const { pages, text } = checkPdf(schematicPdf(p.doc, p.engine));
    expect(pages).toBe(1);
    expect(text).toContain('(R1) Tj');
    expect(text).toContain('(C1) Tj');
    // Ω is not in the standard PDF font encoding: spelled out.
    expect(text).toContain('(10kOhm) Tj');
    expect(text).toMatch(/\/BaseFont \/Courier/);
    // Wires are vector lines (moveto / lineto / stroke), no images.
    expect(text).toMatch(/ m [\d.-]+ [\d.-]+ l S/);
    expect(text).not.toContain('/Image');
  });

  it('one page per sheet, each with its own size', () => {
    const d = (x: number, y: number): SheetDrawing => ({ name: '/', view: { minX: 0, minY: 0, maxX: x, maxY: y }, page: { x, y }, bg: '#ffffff', prims: [{ k: 'text', text: 'A (b) \\ c', at: { x: 1, y: 1 }, size: 2, color: '#000000', align: 'left', base: 'top' }] });
    const { pages, text } = checkPdf(drawingsToPdf([d(297, 210), d(420, 297)]));
    expect(pages).toBe(2);
    expect(text).toContain('/MediaBox [0 0 841.89 595.276]');
    expect(text).toContain('/MediaBox [0 0 1190.551 841.89]');
    // Brackets and backslashes are escaped in PDF strings.
    expect(text).toContain('(A \\(b\\) \\\\ c) Tj');
  });

  it('a framed sheet prints on its frame paper; a paper size scales the sheet to fit it', async () => {
    const p = await smallProject();
    await runTool(p, 'set_sheet_frame', { size: 'A4', author: 'tester' });
    const framed = sheetDrawing(p.doc, p.engine, sheet(p));
    expect(framed.page).toEqual({ x: 297, y: 210 });
    expect(framed.view.maxX - framed.view.minX).toBeCloseTo(297);
    const texts = framed.prims.filter((x) => x.k === 'text').map((x) => (x as { text: string }).text);
    expect(texts).toContain('tester');
    expect(texts).toContain('1 / 1');
    // A3 output of the A4 frame: same picture, larger page.
    expect(sheetDrawing(p.doc, p.engine, sheet(p), { paper: 'A3' }).page).toEqual({ x: 420, y: 297 });
    await runTool(p, 'set_sheet_frame', { size: 'none' });
    // Without a frame the page is the drawing plus a margin, and holds every text.
    const free = sheetDrawing(p.doc, p.engine, sheet(p));
    for (const t of free.prims) if (t.k === 'text') {
      const b = textBox(t);
      expect(b.minX).toBeGreaterThanOrEqual(free.view.minX);
      expect(b.maxX).toBeLessThanOrEqual(free.view.maxX);
    }
    expect(() => sheetDrawing(p.doc, p.engine, sheet(p), { paper: 'B5' })).toThrow(/Paper/);
  });

  it('SVG: light background by default, dark and black-and-white on request, texts escaped', async () => {
    const p = await smallProject();
    await runTool(p, 'add_note', { text: 'Vout < 5 V & I > 1 A', x: 0, y: 20 });
    const [light] = schematicSvgs(p.doc, p.engine);
    expect(light!.svg).toMatch(/^<\?xml/);
    expect(light!.svg).toMatch(/width="[\d.]+mm"/);
    expect(light!.svg).toContain('fill="#ffffff"');
    expect(light!.svg).toContain('Vout &lt; 5 V &amp; I &gt; 1 A');
    expect(light!.svg).toContain('>R1</text>');
    expect(light!.svg).toContain('>10kΩ</text>');
    expect(schematicSvgs(p.doc, p.engine, { theme: 'dark' })[0]!.svg).toContain('fill="#0e1014"');
    const mono = schematicSvgs(p.doc, p.engine, { theme: 'mono' })[0]!.svg;
    const colours = new Set([...mono.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
    for (const c of colours) expect(['#ffffff', '#000000', '#444444']).toContain(c);
  });

  it('export_schematic tool writes .pdf, .svg and .zip files', async () => {
    const p = await smallProject();
    const files = new Map<string, Uint8Array | string>();
    const ctx = { writeFile: (path: string, data: Uint8Array | string) => void files.set(path, data) };
    const pdf = (await runTool(p, 'export_schematic', { out: 'out/s.pdf', theme: 'mono', paper: 'A4' }, ctx)) as { pages: number };
    expect(pdf.pages).toBe(1);
    checkPdf(files.get('out/s.pdf') as Uint8Array);
    await runTool(p, 'export_schematic', { out: 'out/s.svg' }, ctx);
    expect(String(files.get('out/s.svg'))).toContain('<svg');
    const z = (await runTool(p, 'export_schematic', { out: 'out/s.zip' }, ctx)) as { files: string[] };
    expect(z.files).toEqual(['t.svg']);
    expect(ascii((files.get('out/s.zip') as Uint8Array).slice(0, 2))).toBe('PK');
    await expect(runTool(p, 'export_schematic', { out: 'out/s.png' }, ctx)).rejects.toThrow(/\.pdf, \.svg or \.zip/);
    await expect(runTool(p, 'export_schematic', { out: 'out/s.pdf', theme: 'neon' }, ctx)).rejects.toThrow(/theme/);
    await expect(runTool(p, 'export_schematic', { out: 'out/s.pdf', sheet: 'Nope' }, ctx)).rejects.toThrow(/No sheet/);
  });
});
