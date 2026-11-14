import { describe, expect, it } from 'vitest';
import { partPinRows, type PartDef } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

type Classified = { nets: { net: string; signal: string; source: string; why: string }[] };
const classOf = async (p: Project, pin: string) => {
  const net = ((await runTool(p, 'netlist', {})) as { name: string; pins: string[] }[]).find((n) => n.pins.includes(pin))!.name;
  return ((await runTool(p, 'classify_nets', {})) as Classified).nets.find((n) => n.net === net || n.net === net.replace(/^\//, ''));
};

describe('P16: signal classes written in the symbol editor and the footprint generator', () => {
  it('a symbol made from a pin list carries each pin\'s class to the board, and back into the editor', async () => {
    const p = newProject('sig');
    const s = (await runTool(p, 'create_symbol', {
      name: 'RFIC',
      footprint: 'soic-8',
      pin_list: [
        { number: '1', name: 'RF_OUT', type: 'output', signal: 'rf' },
        { number: '2', name: 'SW', type: 'output', signal: 'switching' },
        { number: '3', name: 'IO', type: 'bidirectional' },
      ],
    })) as { id: string };
    await runTool(p, 'place_part', { id: s.id, x: 0, y: 0, ref: 'U1' });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 45.72, y: 0 });
    await runTool(p, 'add_label', { pin: 'U1.1', name: 'ANT_FEED' });
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'ANT_FEED' });
    await runTool(p, 'add_label', { pin: 'U1.2', name: 'NODE' });
    await runTool(p, 'add_label', { pin: 'R2.1', name: 'NODE' });
    await runTool(p, 'update_pcb', {});
    const pin = [...p.doc.nodes.values()].find((n) => n.type === 'pin' && n.props.number === '1' && p.doc.nodes.get(n.parent!)?.props.ref === 'U1')!;
    expect(pin.props.signal).toBe('rf');
    expect(await classOf(p, 'U1.1')).toMatchObject({ signal: 'rf', source: 'pin' });
    expect(await classOf(p, 'U1.2')).toMatchObject({ signal: 'switching', source: 'pin' });
    // Edit symbol shows them again.
    const def = p.doc.meta[`part:${s.id}`] as PartDef;
    expect(partPinRows(def).rows.map((r) => [r.number, r.signal ?? ''])).toEqual([['1', 'rf'], ['2', 'switching'], ['3', '']]);
    await expect(runTool(p, 'create_symbol', { name: 'Bad', pin_list: [{ number: '1', name: 'A', type: 'input', signal: 'fast' }] })).rejects.toThrow(/signal must be one of/);
  });

  it('a footprint made by the generator can give a pad its class, which the board pad keeps', async () => {
    const p = newProject('fp');
    await runTool(p, 'add_part', { kind: 'ic', pins: 4, x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    await runTool(p, 'add_label', { pin: 'U1.1', name: 'CLKOUT' });
    await runTool(p, 'add_label', { pin: 'R1.1', name: 'CLKOUT' });
    await runTool(p, 'create_footprint', { ref: 'U1', name: 'SOP-4-test', family: 'two-row', pins: 4, pitch: 1.27, rowSpacing: 5.4, pad: { length: 1.5, width: 0.6 }, padSignals: { '1': 'high-speed' } });
    await runTool(p, 'update_pcb', {});
    const el = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'U1')!;
    const pad1 = el.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === '1')!;
    expect(pad1.props.signal).toBe('high-speed');
    // A class set on a pad wins over the guess from the net name (CLKOUT → clock).
    expect(await classOf(p, 'U1.1')).toMatchObject({ signal: 'high-speed', source: 'pin' });
  });
});
