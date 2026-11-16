/**
 * P14 (docs/05-pcb-improvements.md): teardrops on pad and via entries (rule per net class), filled as copper
 * and checked by DRC; via stitching for a pour (grid pitch, edge distance), avoiding other copper and
 * keep-out areas.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectCopper, computeRatsnest, inArea, isStitchVia, isTeardrop, runDrc, teardropOutline, type Vec2 } from '@hassassin/core';
import { buildFab } from '@hassassin/fab';
import { fixtureMcu, openProject, runTool, type Project } from '@hassassin/tools';

const errors = (p: Project) => runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error');
const teardrops = (p: Project) => [...p.doc.nodes.values()].filter(isTeardrop);
const stitches = (p: Project) => [...p.doc.nodes.values()].filter(isStitchVia);
const solar = () => openProject([{ name: 'solar.kicad_pcb', text: readFileSync(new URL('../../../apps/web/public/samples/solar.kicad_pcb', import.meta.url), 'utf8') }]);

async function routed(): Promise<Project> {
  const p = await fixtureMcu();
  await runTool(p, 'autoroute', {});
  return p;
}

describe('P14: teardrops and via stitching', () => {
  it('a teardrop flares from the pad width down to the trace, past the pad edge', () => {
    // A trace leaving a 1 mm round via to the right, 0.2 mm wide.
    const inside = (p: Vec2) => Math.hypot(p.x, p.y) <= 0.5 + 1e-9;
    const poly = teardropOutline({ x: 0, y: 0 }, { x: 5, y: 0 }, 0.2, 1, 0.5, inside, 1)!;
    expect(poly).not.toBeNull();
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    // Base 0.9 × 1 mm wide at the via centre, tip 0.5 mm past the edge as wide as the trace.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.9, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    const tip = poly.filter((p) => Math.abs(p.x - 1) < 1e-9).map((p) => p.y);
    expect(Math.max(...tip) - Math.min(...tip)).toBeCloseTo(0.2, 6);
    // No room: a trace as wide as the via, or one too short.
    expect(teardropOutline({ x: 0, y: 0 }, { x: 5, y: 0 }, 1, 1, 0.5, inside, 1)).toBeNull();
    expect(teardropOutline({ x: 0, y: 0 }, { x: 0.6, y: 0 }, 0.2, 1, 0.5, inside, 1)).toBeNull();
  });

  it('teardrops per net class: off by default, then on vias, plated pads or all pads; copper that DRC passes', async () => {
    const p = await routed();
    const base = errors(p).length;
    await runTool(p, 'refill_pours', {});
    expect(teardrops(p)).toEqual([]);
    const vias = (await runTool(p, 'set_teardrops', { mode: 'vias' })) as { teardrops: number; skipped: number };
    expect(vias.teardrops).toBeGreaterThan(0);
    expect(teardrops(p).every((t) => p.doc.nodes.get(String(t.props.of))?.type === 'via')).toBe(true);
    const all = (await runTool(p, 'set_teardrops', { mode: 'all' })) as { teardrops: number };
    expect(all.teardrops).toBeGreaterThan(vias.teardrops);
    // Copper of the trace's net: DRC, the ratsnest and the pours take them in; no new error.
    const shapes = collectCopper(p.doc, p.engine, p.copper).filter((s) => isTeardrop(p.doc.nodes.get(s.uid)));
    expect(shapes.length).toBe(teardrops(p).length);
    expect(shapes.every((s) => s.net !== null && s.areas.length === 1)).toBe(true);
    expect(errors(p).length).toBe(base);
    expect(computeRatsnest(p.doc, p.engine, p.copper).lines.length).toBe(0);
    // Only one class: the power nets.
    await runTool(p, 'set_teardrops', { mode: 'off' });
    expect(teardrops(p)).toEqual([]);
    await runTool(p, 'set_teardrops', { mode: 'all', target: 'net#VCC' });
    expect(teardrops(p).length).toBeGreaterThan(0);
    expect(teardrops(p).every((t) => p.doc.nodes.get(t.parent!)?.name === 'VCC')).toBe(true);
  });

  it('teardrops go into the copper Gerbers and come back on every refill; a moved trace drops its own', async () => {
    const p = await routed();
    await runTool(p, 'set_teardrops', { mode: 'vias' });
    const n = teardrops(p).length;
    const fab = buildFab(p.doc, p.engine, p.layers.map((l) => l.name), 'mcu');
    // Each teardrop is a region of its layer's copper Gerber, starting at its first corner.
    for (const t of teardrops(p)) {
      const layer = String(p.engine.get(t.uid, 'layer')!.value).replace('.', '_');
      const g = fab.files.find((f) => f.name.endsWith(`-${layer}.gbr`))!.data;
      const q = (p.engine.get(t.uid, 'points')!.value as Vec2[])[0]!;
      expect(g).toContain(`G36*\nX${Math.round(q.x * 1e6)}Y${Math.round(-q.y * 1e6)}D02*`);
    }
    expect(n).toBeGreaterThan(0);
    // A refill makes the same number again.
    await runTool(p, 'refill_pours', {});
    expect(teardrops(p).length).toBe(n);
    // Unrouting a trace leaves its teardrop out of the copper (and the next refill removes it).
    const t = teardrops(p)[0]!;
    await runTool(p, 'delete', { target: String(t.props.trace) });
    expect(collectCopper(p.doc, p.engine, p.copper).some((s) => s.uid === t.uid)).toBe(false);
    await runTool(p, 'refill_pours', {});
    expect(p.doc.nodes.has(t.uid)).toBe(false);
  });

  it('the solar board takes teardrops on vias and plated pads without a DRC error', async () => {
    const p = solar();
    expect(errors(p)).toEqual([]);
    const r = (await runTool(p, 'set_teardrops', { mode: 'through' })) as { teardrops: number; skipped: number };
    expect(r.teardrops).toBeGreaterThan(20);
    expect(errors(p).map((v) => v.message)).toEqual([]);
  });

  it('via stitching: a grid of vias inside the pour, clear of its edge, other copper and keep-outs', async () => {
    const p = await routed();
    await runTool(p, 'set_rule', { target: 'net#GND', rule: 'pourLayers', value: 'F.Cu B.Cu' });
    await runTool(p, 'refill_pours', {});
    await expect(runTool(p, 'stitch_pour', { net: 'GND' })).rejects.toThrow(/pitch/);
    const before = errors(p).length;
    const r = (await runTool(p, 'stitch_pour', { net: 'GND', pitch: '4mm', edge: '0.5mm' })) as { vias: number; blocked: number };
    expect(r.vias).toBeGreaterThan(3);
    expect(stitches(p).length).toBe(r.vias);
    expect(errors(p).length).toBe(before);
    // Each via on the grid, inside both pours, at least 0.5 mm + its radius from their edges.
    const gnd = [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === 'GND')!;
    const fills = gnd.children.map((c) => p.doc.nodes.get(c)!).filter((n) => n.type === 'fill');
    for (const v of stitches(p)) {
      const at = p.engine.get(v.uid, 'position')!.value as Vec2;
      expect(Math.abs(at.x / 4 - Math.round(at.x / 4))).toBeLessThan(1e-6);
      for (const layer of ['F.Cu', 'B.Cu']) expect(fills.some((f) => ((f.data?.fills as Record<string, Vec2[][][]>)[layer] ?? []).some((poly) => inArea(at, poly)))).toBe(true);
    }
    // Stitching again replaces them; a keep-out that forbids vias keeps them out of its area.
    const first = stitches(p)[0]!;
    const at = p.engine.get(first.uid, 'position')!.value as Vec2;
    await runTool(p, 'add_keepout', { x: at.x - 1, y: at.y - 1, width: 2, height: 2, layers: '*', forbid: 'vias' });
    const again = (await runTool(p, 'stitch_pour', { net: 'GND', pitch: '4mm' })) as { vias: number; replaced: number };
    expect(again.replaced).toBe(r.vias);
    expect(stitches(p).some((v) => {
      const q = p.engine.get(v.uid, 'position')!.value as Vec2;
      return Math.abs(q.x - at.x) < 1e-6 && Math.abs(q.y - at.y) < 1e-6;
    })).toBe(false);
    expect(errors(p).length).toBe(before);
  });
});
