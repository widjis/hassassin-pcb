import { describe, expect, it } from 'vitest';
import {
  addNode,
  createDoc,
  formatRuleValue,
  parseKeepOut,
  parseLength,
  parseRuleValue,
  parseSelector,
  querySelectorAll,
  StyleEngine,
  systemDefaults,
  type Doc,
} from '@hassassin/core';

describe('units', () => {
  it('parses lengths in many units to mm', () => {
    expect(parseLength('10mil')).toBeCloseTo(0.254);
    expect(parseLength('500um')).toBeCloseTo(0.5);
    expect(parseLength('0.1 in')).toBeCloseTo(2.54);
    expect(parseLength('1.6')).toBe(1.6);
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('3furlong')).toBeNull();
  });
  it('parses per-type keep-outs', () => {
    expect(parseKeepOut('0.2mm fill(0.5mm) net(10mil)')).toEqual({ all: 0.2, byType: { fill: 0.5, net: 0.254 } });
    expect(formatRuleValue('keepOut', parseRuleValue('keepOut', 'fill(1mm)'))).toBe('fill(1mm)');
  });
});

function sampleDoc() {
  const doc = createDoc(systemDefaults());
  const layout = addNode(doc, doc.rootId, { type: 'layout', name: 'Board' });
  const comps = addNode(doc, layout.uid, { type: 'container', name: 'Components' });
  const r1 = addNode(doc, comps.uid, { type: 'element', name: 'R1', props: { Value: '10k', 'Part Type': 'resistor' } });
  const r2 = addNode(doc, comps.uid, { type: 'element', name: 'R2', props: { Value: '4k7', 'Part Type': 'resistor' } });
  const u1 = addNode(doc, comps.uid, { type: 'element', name: 'U1', props: { MPN: 'ATmega328P' } });
  const p1 = addNode(doc, r1.uid, { type: 'pad', name: '1' });
  const p2 = addNode(doc, u1.uid, { type: 'pad', name: '1' });
  const nets = addNode(doc, layout.uid, { type: 'container', name: 'Nets' });
  const gnd = addNode(doc, nets.uid, { type: 'net', name: 'GND', props: { netClass: 'ground' } });
  const sig = addNode(doc, nets.uid, { type: 'net', name: 'SPI_CLK' });
  const t1 = addNode(doc, gnd.uid, { type: 'trace' });
  const t2 = addNode(doc, sig.uid, { type: 'trace' });
  return { doc, ids: { layout: layout.uid, r1: r1.uid, r2: r2.uid, u1: u1.uid, p1: p1.uid, p2: p2.uid, gnd: gnd.uid, sig: sig.uid, t1: t1.uid, t2: t2.uid } };
}

describe('selectors', () => {
  const { doc, ids } = sampleDoc();
  const q = (s: string) => querySelectorAll(doc, s).map((n) => n.uid).sort();

  it('matches by type, designator and property', () => {
    expect(q('element')).toEqual([ids.r1, ids.r2, ids.u1].sort());
    expect(q('#R2')).toEqual([ids.r2]);
    expect(q('[MPN]')).toEqual([ids.u1]);
    expect(q('[Value="10k"]')).toEqual([ids.r1]);
    expect(q('[PartType=resistor]')).toEqual([ids.r1, ids.r2].sort());
    expect(q('net[name^=SPI]')).toEqual([ids.sig]);
    expect(q('net[name*=clk i]')).toEqual([ids.sig]);
  });
  it('supports combinators, :not and lists', () => {
    expect(q('#R1 > pad')).toEqual([ids.p1]);
    expect(q('layout pad')).toEqual([ids.p1, ids.p2].sort());
    expect(q('element:not(#U1)')).toEqual([ids.r1, ids.r2].sort());
    expect(q('#R1, #U1')).toEqual([ids.r1, ids.u1].sort());
  });
  it('reports parse errors', () => {
    expect(() => parseSelector('pad[')).toThrow();
    expect(() => parseSelector('>')).toThrow();
  });
});

describe('cascade', () => {
  it('uses defaults, then rulesets by specificity and order, then object rules', () => {
    const { doc, ids } = sampleDoc();
    let e = new StyleEngine(doc);
    expect(e.get(ids.t2, 'traceWidth')).toMatchObject({ value: 0.25, source: { kind: 'inherited', fromUid: ids.sig, rulesetName: 'Net' } });

    doc.rulesets.push(
      { id: 'a', name: 'All traces', selector: 'trace', rules: [{ name: 'traceWidth', value: 0.3 }], enabled: true, origin: 'project' },
      { id: 'b', name: 'All traces later', selector: 'trace', rules: [{ name: 'traceWidth', value: 0.35 }], enabled: true, origin: 'project' },
      { id: 'c', name: 'SPI', selector: 'net[name^=SPI] > trace', rules: [{ name: 'traceWidth', value: 0.2 }], enabled: true, origin: 'project' },
    );
    e = new StyleEngine(doc);
    expect(e.get(ids.t1, 'traceWidth')).toMatchObject({ value: 0.35, source: { kind: 'ruleset', rulesetId: 'b' } });
    expect(e.get(ids.t2, 'traceWidth')).toMatchObject({ value: 0.2, source: { rulesetId: 'c' } });

    doc.nodes.get(ids.t2)!.rules.push({ name: 'traceWidth', value: 0.5 });
    e = new StyleEngine(doc);
    expect(e.get(ids.t2, 'traceWidth')).toMatchObject({ value: 0.5, source: { kind: 'object' } });

    doc.rulesets.push({ id: 'd', name: 'Force', selector: 'trace', rules: [{ name: 'traceWidth', value: 0.1, important: true }], enabled: true, origin: 'project' });
    e = new StyleEngine(doc);
    expect(e.get(ids.t2, 'traceWidth')).toMatchObject({ value: 0.1, source: { important: true, rulesetId: 'd' } });
  });

  it('inherits net values (including net-class defaults) into traces', () => {
    const { doc, ids } = sampleDoc();
    // The ground net's default width reaches its traces.
    let e = new StyleEngine(doc);
    expect(e.get(ids.t1, 'traceWidth')).toMatchObject({ value: 0.5, source: { kind: 'inherited', rulesetName: 'Ground net' } });

    doc.nodes.get(ids.gnd)!.rules.push({ name: 'traceWidth', value: 0.7 });
    e = new StyleEngine(doc);
    expect(e.get(ids.t1, 'traceWidth')).toMatchObject({ value: 0.7, source: { kind: 'inherited', fromUid: ids.gnd } });
    // Non-inheritable rules do not flow down.
    doc.nodes.get(ids.gnd)!.rules.push({ name: 'keepOut', value: { all: 1, byType: {} } });
    e = new StyleEngine(doc);
    expect(e.get(ids.t1, 'keepOut')?.source.kind).toBe('default');
  });

  it('counts ruleset matches and survives bad selectors', () => {
    const { doc } = sampleDoc();
    doc.rulesets.push({ id: 'bad', name: 'Broken', selector: 'pad[', rules: [], enabled: true, origin: 'project' });
    const e = new StyleEngine(doc);
    const m = e.rulesetMatches();
    expect(m.find((x) => x.ruleset.id === 'default:Pad')?.count).toBe(2);
    expect(m.find((x) => x.ruleset.id === 'bad')?.error).toBeTruthy();
  });
});
