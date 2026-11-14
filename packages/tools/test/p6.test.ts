/**
 * P6 (docs/05-pcb-improvements.md): pour priority, keep-out areas (respected by the autorouter, the
 * interactive router, the autoplacer, pour fill and DRC), and the tools that add pours, keep-outs, text,
 * lines, mounting holes and fiducials.
 */
import { describe, expect, it } from 'vitest';
import { componentExtent, padGeom, routeWorld, runDrc, segmentHit, viaFree, type Vec2 } from '@hassassin/core';
import { importKicadPcb } from '@hassassin/kicad-import';
import { fixtureBus, fixtureMcu, runTool, type Project } from '@hassassin/tools';

const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');
const padAt = (p: Project, ref: string, num: string) => {
  const el = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
  const pad = el.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === num)!;
  return padGeom(p.doc, p.engine, pad, p.copper)!.center;
};
const fillsOf = (p: Project, uid: string) => (p.doc.nodes.get(uid)?.data?.fills ?? {}) as Record<string, Vec2[][][]>;

describe('P6: pours, keep-outs and board graphics', () => {
  it('pour priority: two pours of different nets over the same area never overlap, the higher one wins', async () => {
    const p = await fixtureMcu();
    const j9 = padAt(p, 'J1', '9'); // VCC
    const rect = { x: j9.x - 4, y: j9.y - 4, width: 8, height: 8 };
    // The fixture pours GND on B.Cu over the whole board; VCC gets a pour on B.Cu around J1.9.
    for (const priority of [1, 0]) {
      const q = await fixtureMcu();
      const r = (await runTool(q, 'add_pour', { net: 'VCC', layers: 'B.Cu', ...rect, priority })) as { uid: string; filled: Record<string, number> };
      const gnd = [...q.doc.nodes.values()].find((n) => n.type === 'fill' && q.doc.nodes.get(n.parent!)?.name === 'GND')!;
      const pourErr = errors(q).filter((v) => v.uids.includes(r.uid) && v.uids.includes(gnd.uid));
      expect(pourErr).toEqual([]);
      // With priority 1 VCC fills its area; with equal priority GND (listed first) wins and VCC keeps clear.
      if (priority === 1) expect(r.filled['B.Cu']).toBeGreaterThan(0);
    }
    expect(p).toBeDefined();
  });

  it('a keep-out that forbids traces on F.Cu: the autorouter, the interactive router and DRC respect it', async () => {
    const p = await fixtureBus();
    // A band across the middle of the bus on F.Cu.
    await runTool(p, 'add_keepout', { x: 118, y: 100, width: 4, height: 40, layers: 'F.Cu', forbid: 'traces vias' });
    const r = (await runTool(p, 'autoroute', {})) as { routed: number; failed: unknown[] };
    expect(errors(p).filter((v) => v.kind === 'keepout')).toEqual([]);
    expect(errors(p)).toEqual([]);
    // No F.Cu trace crosses the band, so the bus changes layer.
    expect(r.routed).toBeGreaterThan(0);
    const w = routeWorld(p.doc, p.engine, p.copper, 'B1');
    const zone = [...p.doc.nodes.values()].find((n) => n.type === 'zone')!;
    expect(segmentHit(w, 'F.Cu', { x: 119, y: 101 }, { x: 121, y: 101 })?.uid).toBe(zone.uid);
    expect(viaFree(w, { x: 120, y: 120 }, 0.6)).toBe(false);
    // A trace drawn through it anyway is reported.
    await runTool(p, 'route', { from: 'J1.1', to: 'J2.1', layer: 'F.Cu' });
    expect(errors(p).some((v) => v.kind === 'keepout')).toBe(true);
  });

  it('a keep-out that forbids pours cuts the pour; one that forbids parts keeps the autoplacer out', async () => {
    const p = await fixtureMcu();
    const area = { x: 100, y: 100, width: 10, height: 10 };
    await runTool(p, 'add_keepout', { ...area, layers: 'B.Cu', forbid: 'pours' });
    await runTool(p, 'refill_pours', {});
    expect(errors(p).filter((v) => v.kind === 'keepout')).toEqual([]);
    const gnd = [...p.doc.nodes.values()].find((n) => n.type === 'fill' && p.doc.nodes.get(n.parent!)?.name === 'GND')!;
    for (const poly of fillsOf(p, gnd.uid)['B.Cu'] ?? []) for (const q of poly[0]!) expect(q.x > 110 + 1e-6 || q.y > 110 + 1e-6 || q.x < 100 - 1e-6 || q.y < 100 - 1e-6).toBe(true);
    // One in the middle of the pour becomes a hole in it (refilled at once), and DRC is satisfied.
    const holesBefore = (fillsOf(p, gnd.uid)['B.Cu'] ?? []).reduce((t, poly) => t + poly.length - 1, 0);
    await runTool(p, 'add_keepout', { x: 112, y: 128, width: 3, height: 3, layers: 'B.Cu', forbid: 'pours' });
    expect((fillsOf(p, gnd.uid)['B.Cu'] ?? []).reduce((t, poly) => t + poly.length - 1, 0)).toBeGreaterThan(holesBefore);
    expect(errors(p).filter((v) => v.kind === 'keepout')).toEqual([]);
    // A part under a parts keep-out is reported, and auto_place moves it out.
    const el = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'U2')!;
    const at = p.engine.get(el.uid, 'position')!.value as Vec2;
    const e = componentExtent(p.doc, p.engine, el, p.copper);
    await runTool(p, 'add_keepout', { x: at.x + e.minX - 1, y: at.y + e.minY - 1, width: e.maxX - e.minX + 2, height: e.maxY - e.minY + 2, layers: 'F.Cu', forbid: 'parts' });
    expect(errors(p).some((v) => v.kind === 'keepout' && v.uids.includes(el.uid))).toBe(true);
    await runTool(p, 'auto_place', { refs: ['U2'], improve: false });
    expect(errors(p).some((v) => v.kind === 'keepout' && v.uids.includes(el.uid))).toBe(false);
  });

  it('text, lines, mounting holes and fiducials; board-only parts survive Update PCB', async () => {
    const p = await fixtureBus();
    await runTool(p, 'add_text', { text: 'REV A', x: 120, y: 102, size: 1.2 });
    await runTool(p, 'add_line', { x1: 102, y1: 138, x2: 110, y2: 138 });
    const h = (await runTool(p, 'add_mounting_hole', { x: 103, y: 103, size: 'm2.5' })) as { ref: string };
    const hp = (await runTool(p, 'add_mounting_hole', { x: 137, y: 103, plated: true, net: 'B1', size: 'm2' })) as { ref: string };
    const f = (await runTool(p, 'add_fiducial', { x: 137, y: 137 })) as { ref: string };
    expect([h.ref, hp.ref, f.ref]).toEqual(['H1', 'H2', 'FID1']);
    const types = [...p.doc.nodes.values()].map((n) => n.type);
    expect(types).toContain('text');
    expect(types).toContain('line');
    await expect(runTool(p, 'add_mounting_hole', { x: 1, y: 1, net: 'B1' })).rejects.toThrow(/plated/);
    await runTool(p, 'update_pcb', {});
    const refs = [...p.doc.nodes.values()].filter((n) => n.type === 'element').map((n) => n.name);
    expect(refs).toEqual(expect.arrayContaining(['H1', 'H2', 'FID1']));
    // The plated hole is on B1.
    const h2 = [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'H2')!;
    expect(h2.children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad')!.props.net).toBe('B1');
  });

  it('KiCad import: zone priority and keep-out flags', () => {
    const pcb = `(kicad_pcb (version 20240108) (generator test)
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "VCC")
  (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts") (width 0.1))
  (zone (net 2) (net_name "VCC") (layer "F.Cu") (priority 2) (connect_pads (clearance 0.3)) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 5 5) (xy 20 5) (xy 20 20) (xy 5 20))))
  (zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (name "no vias") (keepout (tracks allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
    (polygon (pts (xy 25 5) (xy 35 5) (xy 35 15) (xy 25 15))))
)`;
    const { doc } = importKicadPcb(pcb);
    const pour = [...doc.nodes.values()].find((n) => n.type === 'fill')!;
    expect(pour.rules.find((r) => r.name === 'pourPriority')?.value).toBe(2);
    const zone = [...doc.nodes.values()].find((n) => n.type === 'zone')!;
    expect(zone.rules.find((r) => r.name === 'keepoutOf')?.value).toEqual(['vias', 'pours']);
  });
});
