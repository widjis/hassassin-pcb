/**
 * P12 (docs/05-pcb-improvements.md): more DRC checks (courtyard overlap, silkscreen over pads, annular ring,
 * hole-to-hole distance, traces with an unconnected end, vias not connected on two layers) and waivers. Each
 * check has a board that fails it; the solar MPPT board (clean in KiCad) passes them all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newUid, padGeom, runDrc, type Vec2 } from '@hassassin/core';
import { fixtureMcu, openProject, runTool, type Project } from '@hassassin/tools';

const drc = (p: Project) => runDrc(p.doc, p.engine, p.copper);
const ofKind = (p: Project, kind: string) => drc(p).violations.filter((v) => v.kind === kind);
const part = (p: Project, ref: string) => [...p.doc.nodes.values()].find((n) => n.type === 'element' && n.name === ref)!;
const padAt = (p: Project, ref: string, num: string): Vec2 => {
  const pad = part(p, ref).children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === num)!;
  return padGeom(p.doc, p.engine, pad, p.copper)!.center;
};
const netUid = (p: Project, name: string) => [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === name)!.uid;
/** An `add` op for a trace or via under a net. */
const addNode = (parent: string, type: 'trace' | 'via', rules: { name: string; value: unknown }[]) => ({
  op: 'add', parent, index: 0, tree: { nodes: [{ uid: newUid(type), type, name: '', parent, children: [], props: {}, rules }] },
});
const P12 = ['courtyardOverlap', 'silkOverPad', 'annularRing', 'holeToHole', 'danglingTrace', 'unusedVia'];

async function routedMcu(): Promise<Project> {
  const p = await fixtureMcu();
  await runTool(p, 'autoroute', {});
  return p;
}

describe('P12: more DRC checks and waivers', () => {
  it('the solar MPPT board (clean in KiCad) gives no error and no warning', () => {
    const text = readFileSync(new URL('../../../apps/web/public/samples/solar.kicad_pcb', import.meta.url), 'utf8');
    const p = openProject([{ name: 'solar.kicad_pcb', text }]);
    const r = drc(p);
    expect(r.violations.map((v) => `${v.kind}: ${v.message}`)).toEqual([]);
  });

  it('a routed test board passes the new checks; footprint silkscreen stays off the pads', async () => {
    const p = await routedMcu();
    const found = drc(p).violations.filter((v) => P12.includes(v.kind));
    expect(found.filter((v) => v.severity === 'error').map((v) => v.message)).toEqual([]);
    // The router leaves no open trace end and no via joined on one layer only.
    expect(found.filter((v) => v.kind === 'danglingTrace' || v.kind === 'unusedVia').map((v) => v.message)).toEqual([]);
    // Footprint graphics (outlines, pin-1 dots) are clear of the pads; only the fixture's reference texts,
    // placed by hand next to the parts, may touch a neighbour's pad.
    expect(found.filter((v) => v.kind === 'silkOverPad' && p.doc.nodes.get(v.uids[0]!)?.type !== 'text').map((v) => v.message)).toEqual([]);
  });

  it('courtyard overlap: a part moved onto another is an error naming both', async () => {
    const p = await fixtureMcu();
    const a = part(p, 'U1');
    const b = part(p, 'U2');
    const at = p.engine.get(a.uid, 'position')!.value as Vec2;
    expect(ofKind(p, 'courtyardOverlap')).toEqual([]);
    await runTool(p, 'move_part', { ref: 'U2', x: at.x + 1, y: at.y + 1 });
    // U2 now overlaps U1 (and may overlap U1's neighbours too).
    const v = ofKind(p, 'courtyardOverlap').filter((x) => x.uids.includes(a.uid) && x.uids.includes(b.uid));
    expect(v.length).toBe(1);
    expect(v[0]!.severity).toBe('error');
    expect(v[0]!.message).toMatch(/courtyards of U\d and U\d overlap on F\.CrtYd/);
    // Put back, the board is clean again.
    await runTool(p, 'undo', {});
    expect(ofKind(p, 'courtyardOverlap')).toEqual([]);
  });

  it('silkscreen over a pad: a text or a line on a pad is a warning; silkClearance asks for room', async () => {
    const p = await fixtureMcu();
    const c = padAt(p, 'U1', '1');
    await runTool(p, 'add_text', { text: 'X', x: c.x, y: c.y, size: 0.8 });
    const v = ofKind(p, 'silkOverPad');
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => x.severity === 'warning')).toBe(true);
    // A line 0.3 mm beside the pad is fine, until the rule asks for 0.5 mm.
    const q = await fixtureMcu();
    const pad = padAt(q, 'J1', '1');
    await runTool(q, 'add_line', { x1: pad.x - 5, y1: pad.y - 1.4, x2: pad.x + 5, y2: pad.y - 1.4, width: 0.15 });
    const before = ofKind(q, 'silkOverPad').length;
    await runTool(q, 'set_rule', { target: 'root', rule: 'silkClearance', value: '0.5mm' });
    expect(ofKind(q, 'silkOverPad').length).toBeGreaterThan(before);
  });

  it('annular ring: a via or pad whose ring is narrower than annularRingMin is an error', async () => {
    const p = await routedMcu();
    expect(ofKind(p, 'annularRing')).toEqual([]);
    // Vias are 0.6 / 0.3 mm (ring 0.15 mm): asking for 0.2 mm flags each via.
    await runTool(p, 'set_rule', { target: 'root', rule: 'annularRingMin', value: '0.2mm' });
    const v = ofKind(p, 'annularRing');
    // Signal vias are 0.6 / 0.3 mm (ring 0.15 mm), power vias 0.8 / 0.4 mm (ring 0.2 mm, enough).
    const narrow = [...p.doc.nodes.values()].filter((n) => n.type === 'via' && Number(p.engine.get(n.uid, 'viaDiameter')!.value) - Number(p.engine.get(n.uid, 'viaHole')!.value) < 0.4 - 1e-9);
    expect(narrow.length).toBeGreaterThan(0);
    expect(new Set(v.filter((x) => p.doc.nodes.get(x.uids[0]!)?.type === 'via').map((x) => x.uids[0]))).toEqual(new Set(narrow.map((n) => n.uid)));
    expect(v.every((x) => x.severity === 'error' && x.required === 0.2)).toBe(true);
    expect(v.find((x) => x.uids[0] === narrow[0]!.uid)!.actual).toBeCloseTo(0.15, 6);
  });

  it('hole to hole: two holes closer than holeToHoleMin, or stacked vias, are an error', async () => {
    const p = await fixtureMcu();
    // M2 holes are drilled 2.2 mm: centres 2.4 mm apart leave 0.2 mm between them.
    await runTool(p, 'add_mounting_hole', { x: 90, y: 90, size: 'm2' });
    await runTool(p, 'add_mounting_hole', { x: 92.4, y: 90, size: 'm2' });
    const v = ofKind(p, 'holeToHole');
    expect(v.length).toBe(1);
    expect(v[0]!.actual).toBeCloseTo(0.2, 6);
    expect(v[0]!.required).toBeCloseTo(0.25, 6);
    // Two vias of one net in the same spot (as an autorouter left on the RGB lamp board).
    const net = netUid(p, 'GND');
    const via = () => addNode(net, 'via', [{ name: 'position', value: { x: 95, y: 95 } }]);
    await runTool(p, 'apply_ops', { ops: [via(), via()] });
    expect(ofKind(p, 'holeToHole').length).toBe(2);
  });

  it('dangling copper: a trace end on nothing and a via joined on one layer only are warnings', async () => {
    const p = await fixtureMcu();
    const s = padAt(p, 'U1', '1');
    const net = String(part(p, 'U1').children.map((c) => p.doc.nodes.get(c)!).find((n) => n.type === 'pad' && String(n.props.number) === '1')!.props.net);
    const end = { x: s.x - 3, y: s.y };
    await runTool(p, 'apply_ops', {
      ops: [
        addNode(netUid(p, net), 'trace', [{ name: 'start', value: s }, { name: 'end', value: end }, { name: 'layer', value: 'F.Cu' }]),
        addNode(netUid(p, net), 'via', [{ name: 'position', value: end }]),
      ],
    });
    // The via joins the trace on F.Cu only; the trace's far end is on the via, so it is not dangling.
    expect(ofKind(p, 'danglingTrace')).toEqual([]);
    const u = ofKind(p, 'unusedVia');
    expect(u.length).toBe(1);
    expect(u[0]!.message).toMatch(/connected on F\.Cu only/);
    // Without the via, the trace end is open.
    await runTool(p, 'delete', { target: u[0]!.uids[0]! });
    const d = ofKind(p, 'danglingTrace');
    expect(d.length).toBe(1);
    expect(d[0]!.severity).toBe('warning');
    expect(d[0]!.at.x).toBeCloseTo(end.x, 6);
  });

  it('waivers: a waived violation leaves the list with its reason, and unwaiving brings it back', async () => {
    const p = await fixtureMcu();
    await runTool(p, 'add_mounting_hole', { x: 90, y: 90, size: 'm2' });
    await runTool(p, 'add_mounting_hole', { x: 92.4, y: 90, size: 'm2' });
    const listed = (await runTool(p, 'run_drc', {})) as { violations: { id: string; kind: string }[] };
    const id = listed.violations.find((v) => v.kind === 'holeToHole')!.id;
    await expect(runTool(p, 'waive_violation', { id, reason: '' })).rejects.toThrow(/reason/);
    const w = (await runTool(p, 'waive_violation', { id, reason: 'Two holes of one slot, milled together' })) as { check: string };
    expect(w.check).toBe('drc');
    const r = drc(p);
    expect(r.violations.some((v) => v.id === id)).toBe(false);
    expect(r.waived.find((v) => v.id === id)?.waiver.reason).toBe('Two holes of one slot, milled together');
    // Kept in the project.
    expect((p.doc.meta.drcWaivers as Record<string, unknown>)[id]).toBeDefined();
    await runTool(p, 'unwaive_violation', { id });
    expect(drc(p).violations.some((v) => v.id === id)).toBe(true);
  });
});
