import { describe, expect, it } from 'vitest';
import { planAutoroute, type RouteSnapshot } from '@hassassin/core';
import { newProject, runTool } from '@hassassin/tools';

describe('P4: live preview of the autorouter', () => {
  it('sends snapshots of the routes it holds while routing, and the last one matches the result', async () => {
    const p = newProject('live');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30.48, y: 0 });
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 15.24 });
    await runTool(p, 'add_label', { pin: 'R1.2', name: 'A' });
    await runTool(p, 'add_label', { pin: 'R2.1', name: 'A' });
    await runTool(p, 'add_label', { pin: 'R3.2', name: 'A' });
    await runTool(p, 'update_pcb', {});
    await runTool(p, 'auto_place', {});
    const shots: RouteSnapshot[] = [];
    const before = p.doc.nodes.size;
    const plan = planAutoroute(p.doc, p.engine, p.copper, { onSnapshot: (s) => shots.push(structuredClone(s)), snapshotMs: 0 });
    expect(shots.length).toBeGreaterThan(0);
    // The board itself is untouched while routing.
    expect(p.doc.nodes.size).toBe(before);
    for (const s of shots) for (const t of s.traces) expect(p.copper).toContain(t.layer);
    // The last snapshot holds what the plan adds (the fanout stubs written at the end aside).
    const traces = plan.ops.filter((o) => o.op === 'add' && o.tree.nodes[0]!.type === 'trace').length;
    expect(traces).toBeGreaterThan(0);
    expect(shots.at(-1)!.traces.length).toBe(traces);
  });
});
