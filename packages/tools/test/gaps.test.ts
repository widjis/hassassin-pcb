import { describe, expect, it } from 'vitest';
import { computeRatsnest, padGeom, planAutoroute, pointInPolygon, runDrc, applyOps } from '@hassassin/core';
import { newProject, resolveTargets, runTool, type Project } from '@hassassin/tools';

async function routed(): Promise<Project> {
  const p = newProject('t');
  await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'led', x: 15.24, y: 0 });
  await runTool(p, 'connect_pins', { from: 'R1.2', to: 'D1.2' });
  await runTool(p, 'add_power', { pin: 'R1.1', net: '+5V' });
  await runTool(p, 'add_power', { pin: 'D1.1', net: 'GND' });
  // A second part on +5V, so the board has more than one trace to work with.
  await runTool(p, 'add_part', { kind: 'resistor', x: -15.24, y: 0 });
  await runTool(p, 'add_power', { pin: 'R2.1', net: '+5V' });
  await runTool(p, 'add_power', { pin: 'R2.2', net: 'GND' });
  await runTool(p, 'update_pcb', {});
  await runTool(p, 'auto_place', {});
  await runTool(p, 'autoroute', {});
  return p;
}

describe('tool gaps found by the RGB lamp test', () => {
  it('deletes objects by list or selector, and purges disabled leftovers', async () => {
    const p = await routed();
    const traces = [...p.doc.nodes.values()].filter((n) => n.type === 'trace');
    expect(traces.length).toBeGreaterThan(1);
    // Disable two traces the way the agent did, then purge them.
    // A uid list with and without "#" selects both.
    expect(resolveTargets(p, `${traces[0]!.uid}, #${traces[1]!.uid}`).length).toBe(2);
    await runTool(p, 'set_rule', { target: traces[0]!.uid, rule: 'enabled', value: 'false', scope: 'object' });
    const r = (await runTool(p, 'delete', { purge_disabled: true })) as { deleted: number };
    expect(r.deleted).toBe(1);
    expect(p.doc.nodes.has(traces[0]!.uid)).toBe(false);
    // Selector delete; structural objects (nets) are refused, traces go.
    const d = (await runTool(p, 'delete', { target: 'net, trace' })) as { deleted: number; notDeleted?: string[] };
    expect(d.deleted).toBe(traces.length - 1);
    expect(d.notDeleted?.join(' ')).toMatch(/net/);
    await runTool(p, 'undo', {});
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'trace').length).toBe(traces.length - 1);
  });

  it('reads the outline back, simplified, and reports it in project_status', async () => {
    const p = newProject('t');
    await runTool(p, 'set_board_outline', { width: 60, height: 40, corner_radius: 5 });
    const o = (await runTool(p, 'get_board_outline', { max_points: 20 })) as { width: number; height: number; points: number[][]; pointsInFile: number; areaMm2: number };
    expect(o.width).toBeCloseTo(60, 2);
    expect(o.height).toBeCloseTo(40, 2);
    expect(o.points.length).toBeLessThanOrEqual(20);
    expect(o.pointsInFile).toBeGreaterThan(20);
    expect(o.areaMm2).toBeGreaterThan(2350);
    const st = (await runTool(p, 'project_status', {})) as { board: { width: number } };
    expect(st.board.width).toBeCloseTo(60, 1);
  });

  it('warns when a part body sticks out of the board, unless overhang is allowed', async () => {
    const p = await routed();
    await runTool(p, 'move_part', { ref: 'R1', x: 100.2, y: 120 }); // board edge is x = 100
    const warn = runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.kind === 'partOutsideBoard');
    expect(warn.length).toBe(1);
    expect(warn[0]!.severity).toBe('warning');
    await runTool(p, 'set_property', { target: 'R1', key: 'allowOverhang', value: 'true' });
    expect(runDrc(p.doc, p.engine, p.copper).violations.some((v) => v.kind === 'partOutsideBoard' && v.message.startsWith('R1 '))).toBe(false);
  });

  it('never puts an autorouted via on a pad', async () => {
    const p = await routed();
    for (const v of [...p.doc.nodes.values()].filter((n) => n.type === 'via')) applyOps(p.doc, [{ op: 'remove', uid: v.uid }]);
    p.engine.recompute();
    // Force layer changes: block F.Cu between the parts with a big keep-in of other copper is hard to set up, so
    // just check every via the router makes on a fresh dense route avoids pad cells.
    const { ops } = planAutoroute(p.doc, p.engine, p.copper, { viaCost: 0.5 });
    applyOps(p.doc, ops);
    p.engine.recompute();
    const pads = [...p.doc.nodes.values()].filter((n) => n.type === 'pad').map((n) => padGeom(p.doc, p.engine, n, p.copper)!);
    for (const v of [...p.doc.nodes.values()].filter((n) => n.type === 'via')) {
      const at = p.engine.get(v.uid, 'position')!.value as { x: number; y: number };
      expect(pads.some((g) => pointInPolygon(at, g.outline))).toBe(false);
    }
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(0);
  });
});
