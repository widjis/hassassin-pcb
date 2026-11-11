import { describe, expect, it } from 'vitest';
import { extractNetlist, runErc } from '@hassassin/core';
import { newProject, runTool } from '@hassassin/tools';

describe('power symbols', () => {
  it('connects pins to rails through power symbols and wires, across parts', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'capacitor', x: 20, y: 20, value: '100n' });
    await runTool(p, 'add_part', { kind: 'capacitor', x: 40, y: 20, value: '10u' });
    await runTool(p, 'add_part', { kind: 'connector', x: 0, y: 20, pins: 2 });
    for (const pin of ['C1.1', 'C2.1', 'J1.1']) await runTool(p, 'add_power', { pin, net: '+5V' });
    for (const pin of ['C1.2', 'C2.2', 'J1.2']) await runTool(p, 'add_power', { pin, net: 'GND' });
    await runTool(p, 'add_power', { pin: 'J1.1', flag: true });
    await runTool(p, 'add_power', { pin: 'J1.2', flag: true });
    const nl = extractNetlist(p.doc, p.engine);
    expect(nl.byPin.get('C1.1')).toBe('+5V');
    expect(nl.byPin.get('C2.1')).toBe('+5V');
    expect(nl.byPin.get('J1.1')).toBe('+5V');
    expect(nl.byPin.get('C2.2')).toBe('GND');
    expect(nl.byPin.get('J1.2')).toBe('GND');
    expect(runErc(p.doc, p.engine).violations.filter((v) => v.severity === 'error')).toEqual([]);
    // Real symbols with drawings, plus wires; no plain labels were needed.
    const syms = [...p.doc.nodes.values()].filter((n) => n.type === 'symbol' && n.props.power);
    expect(syms.length).toBe(8);
    expect(syms.every((s) => Array.isArray(s.data?.graphics) && (s.data!.graphics as unknown[]).length > 0)).toBe(true);
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'wire').length).toBeGreaterThanOrEqual(8);
    expect([...p.doc.nodes.values()].some((n) => n.type === 'label' && (n.props.kind === 'local' || n.props.kind === 'global'))).toBe(false);
    // Board side: the rails become ordinary nets.
    await runTool(p, 'update_pcb', {});
    const pad = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'C2')!.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && n.name === '1')!;
    expect(pad.props.net).toBe('+5V');
  });
});
