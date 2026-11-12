import { describe, expect, it } from 'vitest';
import { newProject, runTool } from '@hassassin/tools';

describe('get_part', () => {
  it('takes a component reference and answers with the library part behind it', async () => {
    const p = newProject('t');
    await runTool(p, 'place_part', { id: 'generic:resistor', x: 0, y: 0, value: '4k7' });
    const r = (await runTool(p, 'get_part', { id: 'r1' })) as { placed: { ref: string; value: string }; id: string; units: { pins: string[] }[] };
    expect(r.placed).toMatchObject({ ref: 'R1', value: '4k7' });
    expect(r.id).toMatch(/^generic:resistor/);
    expect(r.units[0]!.pins).toHaveLength(2);
  });

  it('a component whose symbol is in no library: the pins and properties of the placed symbol', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', pins: 4, x: 0, y: 0 });
    const sym = [...p.doc.nodes.values()].find((n) => n.type === 'symbol' && n.props.ref === 'U1')!;
    // As a KiCad import leaves it: a library symbol name, no part id.
    delete sym.props.partId;
    sym.props.libId = 'Nowhere_Lib:MYSTERY';
    sym.props.Datasheet = 'https://example.com/mystery.pdf';
    const r = (await runTool(p, 'get_part', { id: 'U1' })) as { note: string; name: string; properties: Record<string, string>; units: { unit: number; pins: string[] }[] };
    expect(r.note).toMatch(/U1 has no library part.*Nowhere_Lib:MYSTERY/);
    expect(r.name).toBe('MYSTERY');
    expect(r.properties.Datasheet).toBe('https://example.com/mystery.pdf');
    expect(r.units).toEqual([{ unit: 1, pins: expect.arrayContaining([expect.stringMatching(/^1 /)]) }]);
    expect(r.units[0]!.pins).toHaveLength(4);
  });

  it('neither a part nor a component: says what id is accepted', async () => {
    const p = newProject('t');
    await expect(runTool(p, 'get_part', { id: 'ZZ9' })).rejects.toThrow(/No part or component "ZZ9".*search_parts.*U1/);
  });
});
