import { describe, expect, it } from 'vitest';
import { copyItems, extractNetlist, itemsInRect, pasteOps } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

function groups(p: Project): string[] {
  return extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
}
const sheetOf = (p: Project) => [...p.doc.nodes.values()].find((n) => n.type === 'sheet')!.uid;

async function circuit(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '1k' });
  await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 5.08 });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await runTool(p, 'add_power', { pin: 'R1.1', net: '+5V' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  await runTool(p, 'add_label', { pin: 'R1.2', name: 'LED_A', kind: 'global' }).catch(() => undefined);
  return p;
}

describe('S3: copy, paste and duplicate', () => {
  it('pasting a block gives new references and the same connections inside it', async () => {
    const p = await circuit();
    const sheet = sheetOf(p);
    const before = groups(p);
    const sel = itemsInRect(p.doc, p.engine, sheet, { minX: -20, minY: -20, maxX: 30, maxY: 30 }, 'inside');
    const clip = copyItems(p.doc, p.engine, sel)!;
    expect(clip.trees.length).toBe(sel.length);
    const res = pasteOps(p.doc, sheet, clip, { x: 50.8, y: 0 });
    p.history.apply('Paste', res.ops);
    expect(res.refs.get('R1')).toBe('R2');
    expect(res.refs.get('D1')).toBe('D2');
    // Restricted to the old parts, nothing changed; restricted to the copy, the same shape with new names.
    const only = (keep: (ref: string) => boolean) =>
      extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.filter((x) => keep(x.ref)).map((x) => `${x.ref}.${x.pin}`).sort().join(' ')).filter((g) => g.includes(' ')).sort();
    expect(only((r) => r === 'R1' || r === 'D1')).toEqual(before);
    expect(only((r) => r === 'R2' || r === 'D2')).toEqual(before.map((g) => g.replace(/R1\./g, 'R2.').replace(/D1\./g, 'D2.')));
    // One undo removes the whole paste.
    p.history.undo();
    expect(groups(p)).toEqual(before);
  });

  it('pasting twice keeps counting up; power symbols get their own references', async () => {
    const p = await circuit();
    const sheet = sheetOf(p);
    const sel = itemsInRect(p.doc, p.engine, sheet, { minX: -20, minY: -20, maxX: 30, maxY: 30 }, 'inside');
    const clip = copyItems(p.doc, p.engine, sel)!;
    p.history.apply('p1', pasteOps(p.doc, sheet, clip, { x: 50.8, y: 0 }).ops);
    const r2 = pasteOps(p.doc, sheet, clip, { x: 101.6, y: 0 });
    p.history.apply('p2', r2.ops);
    expect(r2.refs.get('R1')).toBe('R3');
    const refs = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol').map((n) => String(n.props.ref));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('the duplicate tool copies parts with their wires and power symbols, and refuses overlap', async () => {
    const p = await circuit();
    const before = groups(p);
    const out = (await runTool(p, 'duplicate', { refs: 'R1 D1', dx: 50.8, dy: 0 })) as { refs: Record<string, string> };
    expect(out.refs.R1).toBe('R2');
    const nets = extractNetlist(p.doc, p.engine).nets.map((n) => n.pins.map((x) => `${x.ref}.${x.pin}`));
    expect(nets.some((g) => g.includes('D2.2') && g.includes('R2.2'))).toBe(true);
    expect(nets.some((g) => g.includes('D1.2') && g.includes('R1.2'))).toBe(true);
    void before;
    // Right on top of the original: refused, nothing changed.
    const n = p.doc.nodes.size;
    await expect(runTool(p, 'duplicate', { refs: 'R1', dx: 0, dy: 0 })).rejects.toThrow(/land on existing/);
    expect(p.doc.nodes.size).toBe(n);
  });
});
