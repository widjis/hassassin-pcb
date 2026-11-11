import { describe, expect, it } from 'vitest';
import { renameRefOps } from '@hassassin/core';
import { newProject, runTool } from '@hassassin/tools';

describe('S5: edit references and properties', () => {
  it('renaming a part renames every unit and its board component, and refuses duplicates', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0, value: '1k' });
    await runTool(p, 'add_part', { kind: 'resistor', x: 10.16, y: 0, value: '2k2' });
    await runTool(p, 'update_pcb', {});
    p.history.apply('rename', renameRefOps(p.doc, 'R1', 'R10'));
    const refs = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol').map((n) => String(n.props.ref)).sort();
    expect(refs).toEqual(['R10', 'R2']);
    expect([...p.doc.nodes.values()].some((n) => n.type === 'element' && n.name === 'R10')).toBe(true);
    // Update PCB still matches: nothing is added or removed.
    const before = [...p.doc.nodes.values()].filter((n) => n.type === 'element').length;
    await runTool(p, 'update_pcb', {});
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'element').length).toBe(before);
    expect(() => renameRefOps(p.doc, 'R10', 'R2')).toThrow(/already used/);
    expect(() => renameRefOps(p.doc, 'R10', '1R')).toThrow(/not a valid/);
  });

  it('set_part_info sets value / MPN on symbol and board, and renames', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'capacitor', x: 0, y: 0, value: '100n' });
    await runTool(p, 'update_pcb', {});
    await runTool(p, 'set_part_info', { ref: 'C1', value: '1u', mpn: 'GRM188R61E105KA12D', rename: 'C5' });
    const sym = [...p.doc.nodes.values()].find((n) => n.type === 'symbol')!;
    const el = [...p.doc.nodes.values()].find((n) => n.type === 'element')!;
    expect(sym.props.ref).toBe('C5');
    expect(sym.props.Value).toBe('1u');
    expect(el.name).toBe('C5');
    expect(el.props.MPN).toBe('GRM188R61E105KA12D');
  });
});
