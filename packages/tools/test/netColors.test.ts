/**
 * P17 (docs/05-pcb-improvements.md): copper coloured by net, as KiCad net colours and Pulsonix / Easy-PC
 * "Use Own Colour".
 */
import { describe, expect, it } from 'vitest';
import { netColorMap, netColorMode, NET_PALETTE } from '@hassassin/core';
import { fixtureMcu, runTool } from '@hassassin/tools';

describe('net colours (P17)', () => {
  it('a net colour wins over its class colour; ground and power have class colours by default', async () => {
    const p = await fixtureMcu();
    await runTool(p, 'classify_nets', { apply: true });
    const m = netColorMap(p.doc);
    expect(m.get('GND')).toBe('#8c96a3');
    await runTool(p, 'set_net_color', { net: 'GND', color: '#00ff00' });
    expect(netColorMap(p.doc).get('GND')).toBe('#00ff00');
    await runTool(p, 'set_net_color', { net: 'GND', color: 'none' });
    expect(netColorMap(p.doc).get('GND')).toBe('#8c96a3');
    await runTool(p, 'set_net_color', { class: 'ground', color: '#123456' });
    expect(netColorMap(p.doc).get('GND')).toBe('#123456');
  });

  it('"colour every net" gives each net without a colour a palette colour, the same each time, and shows them', async () => {
    const p = await fixtureMcu();
    expect(netColorMode(p.doc)).toBe('ratsnest');
    const r = (await runTool(p, 'set_net_color', { auto: true, mode: 'net' })) as { mode: string; colours: Record<string, string> };
    expect(r.mode).toBe('net');
    const nets = [...p.doc.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)').map((n) => n.name);
    for (const n of nets) expect(r.colours[n]).toMatch(/^#[0-9a-f]{6}$/i);
    for (const c of Object.values(r.colours)) expect([...NET_PALETTE, '#8c96a3', '#ff7043']).toContain(c);
    const q = await fixtureMcu();
    const r2 = (await runTool(q, 'set_net_color', { auto: true })) as { colours: Record<string, string> };
    expect(r2.colours).toEqual(r.colours);
    await expect(runTool(p, 'set_net_color', { net: 'VCC', color: 'red' })).rejects.toThrow(/#rrggbb/);
  });
});
