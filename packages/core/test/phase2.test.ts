import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  applyOps,
  boardOutline,
  computeRatsnest,
  createDoc,
  inArea,
  planPours,
  refillOps,
  runDrc,
  StyleEngine,
  systemDefaults,
  type PolyWithHoles,
} from '@hassassin/core';
import { importKicadPcb } from '@hassassin/kicad-import';

const CU = ['F.Cu', 'B.Cu'];

/** 20×10 mm board, two resistors, nets A (left pads) and B (right pads). */
function board() {
  const doc = createDoc(systemDefaults());
  const layout = addNode(doc, doc.rootId, { type: 'layout', name: 'B' });
  const outline = addNode(doc, layout.uid, { type: 'container', name: 'Board' });
  addNode(doc, outline.uid, {
    type: 'rectangle',
    rules: [
      { name: 'layer', value: 'Edge.Cuts' },
      { name: 'points', value: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }] },
    ],
  });
  const comps = addNode(doc, layout.uid, { type: 'container', name: 'Components' });
  const nets = addNode(doc, layout.uid, { type: 'container', name: 'Nets' });
  const mk = (name: string, x: number) => {
    const el = addNode(doc, comps.uid, { type: 'element', name, rules: [{ name: 'position', value: { x, y: 5 } }] });
    for (const [n, dx, net] of [['1', -1, 'A'], ['2', 1, 'B']] as const) {
      addNode(doc, el.uid, {
        type: 'pad', name: n, props: { number: n, net },
        rules: [{ name: 'position', value: { x: dx, y: 0 } }, { name: 'size', value: { x: 1, y: 1 } }, { name: 'layers', value: ['F.Cu'] }],
      });
    }
  };
  mk('R1', 5);
  mk('R2', 15);
  const A = addNode(doc, nets.uid, { type: 'net', name: 'A' });
  const B = addNode(doc, nets.uid, { type: 'net', name: 'B' });
  const trace = (net: string, x1: number, y1: number, x2: number, y2: number, w?: number) =>
    addNode(doc, net === 'A' ? A.uid : B.uid, {
      type: 'trace',
      rules: [
        { name: 'start', value: { x: x1, y: y1 } },
        { name: 'end', value: { x: x2, y: y2 } },
        { name: 'layer', value: 'F.Cu' },
        ...(w ? [{ name: 'traceWidth', value: w }] : []),
      ],
    });
  return { doc, A, B, trace };
}

const kinds = (doc: ReturnType<typeof board>['doc']) => {
  const r = runDrc(doc, new StyleEngine(doc), CU);
  const by: Record<string, number> = {};
  for (const v of r.violations) by[v.kind] = (by[v.kind] ?? 0) + 1;
  return { by, r };
};

describe('board outline', () => {
  it('finds the closed outline', () => {
    const { doc } = board();
    const o = boardOutline(doc, new StyleEngine(doc));
    expect(o.loops).toHaveLength(1);
    expect(o.loops[0]).toHaveLength(4);
  });
});

describe('DRC', () => {
  it('reports unrouted connections, then nothing once routed', () => {
    const { doc, trace } = board();
    expect(kinds(doc).by).toEqual({ unrouted: 2 });
    trace('A', 4, 5, 14, 5); // R1.1 (4,5) -> R2.1 (14,5): passes over R1.2 at (6,5)!
    const { by } = kinds(doc);
    expect(by.short).toBeGreaterThanOrEqual(1);
  });

  it('flags shorts, clearance, narrow traces and edge clearance', () => {
    const { doc, trace } = board();
    // A clean route for A below the parts, B above.
    trace('A', 4, 5, 4, 8);
    trace('A', 4, 8, 14, 8);
    trace('A', 14, 8, 14, 5);
    trace('B', 6, 5, 6, 2);
    trace('B', 6, 2, 16, 2);
    trace('B', 16, 2, 16, 5);
    expect(kinds(doc).by).toEqual({});

    // 0.1 mm gap between a B trace and the A trace (needs 0.2 mm): clearance.
    trace('B', 8, 7.65, 10, 7.65); // A trace at y=8 is 0.25 wide -> edge at 7.875; this one edge at 7.775
    let { by } = kinds(doc);
    expect(by.clearance).toBe(1);

    // Narrow trace.
    trace('A', 10, 9, 11, 9, 0.1);
    ({ by } = kinds(doc));
    expect(by.traceWidth).toBe(1);
    // ...that is also too close to the board edge (y=10, needs 0.3 from the edge).
    trace('A', 2, 9.85, 3, 9.85);
    ({ by } = kinds(doc));
    expect(by.edgeClearance).toBeGreaterThanOrEqual(1);
  });
});

describe('pours', () => {
  it('fills a net pour around other-net copper and connects through thermal spokes', () => {
    const { doc, A, trace } = board();
    // join both B pads with a trace that goes around above the parts
    trace('B', 6, 5, 6, 2);
    trace('B', 6, 2, 16, 2);
    trace('B', 16, 2, 16, 5);
    let e = new StyleEngine(doc);
    // Ask for an A pour on F.Cu through the rule system.
    doc.nodes.get(A.uid)!.rules.push({ name: 'pourLayers', value: ['F.Cu'] });
    e = new StyleEngine(doc);
    applyOps(doc, planPours(doc, e, CU));
    e.recompute();
    const pour = doc.nodes.get(A.uid)!.children.map((c) => doc.nodes.get(c)!).find((n) => n.type === 'fill')!;
    expect(pour.props.auto).toBe(true);
    applyOps(doc, refillOps(doc, e, CU).ops);
    e.recompute();
    const polys = (pour.data!.fills as Record<string, PolyWithHoles[]>)['F.Cu']!;
    expect(polys.length).toBeGreaterThan(0);
    const covered = (x: number, y: number) => polys.some((p) => inArea({ x, y }, p));
    expect(covered(10, 8)).toBe(true); // open board area
    expect(covered(10, 2)).toBe(false); // the B trace
    expect(covered(10, 2.3)).toBe(false); // within B trace + clearance
    expect(covered(14, 5)).toBe(true); // the A pad is part of its own pour
    expect(covered(14, 5.65)).toBe(true); // ...joined by the vertical thermal spoke
    expect(covered(14.4, 5.62)).toBe(false); // but the gap between spokes stays open
    expect(covered(0.1, 5)).toBe(false); // board edge clearance
    // Both A pads are joined by the pour: no ratsnest for A, and DRC is clean.
    expect(computeRatsnest(doc, e, CU).nets.find((n) => n.net === 'A')!.islands).toBe(1);
    const d = runDrc(doc, e, CU);
    expect(d.violations.filter((v) => v.kind !== 'unrouted')).toEqual([]);

    // Removing the rule removes the automatic pour.
    doc.nodes.get(A.uid)!.rules = [];
    e.recompute();
    applyOps(doc, planPours(doc, e, CU));
    expect(doc.nodes.has(pour.uid)).toBe(false);
  });

  const real = process.env.KICAD_SAMPLE;
  it.runIf(!!real && existsSync(real!))('refilled pours on a real routed board stay DRC-clean and connected', () => {
    const { doc, layers } = importKicadPcb(readFileSync(real!, 'utf8'));
    const copper = layers.filter((l) => l.kind === 'copper').map((l) => l.name);
    const e = new StyleEngine(doc);
    const before = runDrc(doc, e, copper).violations.length;
    const { ops, ms } = refillOps(doc, e, copper);
    applyOps(doc, ops);
    e.recompute();
    const after = runDrc(doc, e, copper);
    console.log({ refillMs: Math.round(ms), drcMs: Math.round(after.ms), before, after: after.violations.length });
    expect(after.violations.length).toBeLessThanOrEqual(before);
    expect(computeRatsnest(doc, e, copper).lines).toHaveLength(computeRatsnest(doc, new StyleEngine(importKicadPcb(readFileSync(real!, 'utf8')).doc), copper).lines.length);
  });
});
