import { describe, expect, it } from 'vitest';
import {
  addNode,
  applyOps,
  computeRatsnest,
  createDoc,
  History,
  padGeom,
  parseDoc,
  route45,
  snapshot,
  stringifyDoc,
  StyleEngine,
  systemDefaults,
  unplace,
  place,
} from '@hassassin/core';

function board() {
  const doc = createDoc(systemDefaults());
  const layout = addNode(doc, doc.rootId, { type: 'layout', name: 'B' });
  const comps = addNode(doc, layout.uid, { type: 'container', name: 'Components' });
  const nets = addNode(doc, layout.uid, { type: 'container', name: 'Nets' });
  const mkR = (name: string, x: number) => {
    const el = addNode(doc, comps.uid, { type: 'element', name, rules: [{ name: 'position', value: { x, y: 0 } }, { name: 'rotation', value: 0 }] });
    for (const [num, dx, net] of [['1', -1, 'A'], ['2', 1, 'B']] as const) {
      addNode(doc, el.uid, {
        type: 'pad',
        name: num,
        props: { number: num, net },
        rules: [
          { name: 'position', value: { x: dx, y: 0 } },
          { name: 'size', value: { x: 0.8, y: 0.8 } },
          { name: 'layers', value: ['F.Cu'] },
        ],
      });
    }
    return el;
  };
  const r1 = mkR('R1', 0);
  const r2 = mkR('R2', 10);
  const netA = addNode(doc, nets.uid, { type: 'net', name: 'A' });
  const netB = addNode(doc, nets.uid, { type: 'net', name: 'B' });
  return { doc, r1, r2, netA, netB, layout };
}

describe('frames', () => {
  it('place/unplace are inverses', () => {
    const o = { x: 3, y: -2 };
    const p = { x: 1.5, y: 0.25 };
    for (const a of [0, 30, 90, 211]) {
      const w = place(p, o, a);
      const back = unplace(w, o, a);
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
    }
  });
  it('pads follow their component', () => {
    const { doc, r2 } = board();
    const e = new StyleEngine(doc);
    const pad = doc.nodes.get(r2.children[0]!)!;
    expect(padGeom(doc, e, pad, ['F.Cu'])!.center).toEqual({ x: 9, y: 0 });
  });
  it('route45 makes one diagonal and one straight leg', () => {
    const [a, m, b] = route45({ x: 0, y: 0 }, { x: 5, y: 2 }, true);
    expect(m).toEqual({ x: 2, y: 2 });
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b).toEqual({ x: 5, y: 2 });
  });
});

describe('commands and history', () => {
  it('applies and undoes rule changes, adds and removes', () => {
    const { doc, r1, netA } = board();
    const h = new History(doc);
    h.apply('move', [{ op: 'setRule', uid: r1.uid, name: 'position', decl: { name: 'position', value: { x: 5, y: 5 } } }]);
    expect(doc.nodes.get(r1.uid)!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 5, y: 5 });
    h.undo();
    expect(doc.nodes.get(r1.uid)!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 0, y: 0 });
    h.redo();
    expect(doc.nodes.get(r1.uid)!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 5, y: 5 });

    const size = doc.nodes.size;
    const tree = { nodes: [{ uid: 't1', type: 'trace' as const, name: '', props: {}, rules: [], parent: null, children: [] }] };
    h.apply('route', [{ op: 'add', parent: netA.uid, index: 0, tree }]);
    expect(doc.nodes.size).toBe(size + 1);
    expect(doc.nodes.get('t1')!.parent).toBe(netA.uid);
    h.undo();
    expect(doc.nodes.has('t1')).toBe(false);

    const kids = [...doc.nodes.get(r1.parent!)!.children];
    h.apply('delete', [{ op: 'remove', uid: r1.uid }]);
    expect(doc.nodes.has(r1.uid)).toBe(false);
    expect(doc.nodes.size).toBe(size - 3);
    h.undo();
    expect(doc.nodes.get(r1.parent!)!.children).toEqual(kids);
    expect(doc.nodes.get(r1.uid)!.children.length).toBe(2);
  });

  it('merges a drag into one undo step and seals it', () => {
    const { doc, r1 } = board();
    const h = new History(doc);
    for (let i = 1; i <= 5; i++) h.apply('move', [{ op: 'setRule', uid: r1.uid, name: 'position', decl: { name: 'position', value: { x: i, y: 0 } } }], 'drag');
    h.seal();
    h.apply('move', [{ op: 'setRule', uid: r1.uid, name: 'position', decl: { name: 'position', value: { x: 9, y: 0 } } }], 'drag');
    h.undo();
    expect(doc.nodes.get(r1.uid)!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 5, y: 0 });
    h.undo();
    expect(doc.nodes.get(r1.uid)!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 0, y: 0 });
    expect(h.canUndo).toBe(false);
  });

  it('rolls back a failing batch', () => {
    const { doc, r1 } = board();
    const before = JSON.stringify(snapshot(doc, doc.rootId));
    expect(() =>
      applyOps(doc, [
        { op: 'setRule', uid: r1.uid, name: 'rotation', decl: { name: 'rotation', value: 90 } },
        { op: 'remove', uid: 'nope' },
      ]),
    ).toThrow();
    expect(JSON.stringify(snapshot(doc, doc.rootId))).toBe(before);
  });
});

describe('save format', () => {
  it('round-trips a document', () => {
    const { doc } = board();
    doc.rulesets.push({ id: 'x', name: 'X', selector: 'trace', rules: [{ name: 'traceWidth', value: 0.4 }], enabled: true, origin: 'project' });
    const back = parseDoc(stringifyDoc(doc));
    expect(back.nodes.size).toBe(doc.nodes.size);
    expect(back.rulesets).toEqual(doc.rulesets);
    expect(back.defaults.length).toBeGreaterThan(0);
    expect(() => parseDoc('{"format":"other"}')).toThrow();
    expect(() => parseDoc('{"format":"hassassin-pcb","version":99,"nodes":[],"rootId":"r"}')).toThrow(/newer/);
  });
});

describe('ratsnest', () => {
  it('connects islands and disappears once routed', () => {
    const { doc, netA } = board();
    let e = new StyleEngine(doc);
    // Net A: R1.1 at (-1,0) and R2.1 at (9,0) -> one missing connection
    let rn = computeRatsnest(doc, e, ['F.Cu', 'B.Cu']);
    const a = rn.nets.find((n) => n.net === 'A')!;
    expect(a.islands).toBe(2);
    expect(rn.lines.filter((l) => l.net === 'A')).toHaveLength(1);

    // Route half way on the wrong layer: still unrouted
    addNode(doc, netA.uid, { type: 'trace', rules: [{ name: 'start', value: { x: -1, y: 0 } }, { name: 'end', value: { x: 4, y: 0 } }, { name: 'layer', value: 'B.Cu' }] });
    e = new StyleEngine(doc);
    expect(computeRatsnest(doc, e, ['F.Cu', 'B.Cu']).nets.find((n) => n.net === 'A')!.islands).toBe(2);

    // Two segments on F.Cu joined at (4,0) and a via-free path to R2.1
    addNode(doc, netA.uid, { type: 'trace', rules: [{ name: 'start', value: { x: -1, y: 0 } }, { name: 'end', value: { x: 4, y: 0 } }, { name: 'layer', value: 'F.Cu' }] });
    addNode(doc, netA.uid, { type: 'trace', rules: [{ name: 'start', value: { x: 4, y: 0 } }, { name: 'end', value: { x: 9, y: 0 } }, { name: 'layer', value: 'F.Cu' }] });
    e = new StyleEngine(doc);
    rn = computeRatsnest(doc, e, ['F.Cu', 'B.Cu']);
    expect(rn.nets.find((n) => n.net === 'A')!.islands).toBe(1);
    expect(rn.lines.filter((l) => l.net === 'A')).toHaveLength(0);
  });
});
