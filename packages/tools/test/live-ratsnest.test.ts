/**
 * The live ratsnest while routing (KiCad, EAGLE): the islands of a net, and which one a point (the route's
 * head) touches, so the line can run to the nearest copper not yet joined.
 */
import { describe, expect, it } from 'vitest';
import { netIslands, type Vec2 } from '@hassassin/core';
import { fixtureMcu } from '@hassassin/tools';

describe('netIslands', () => {
  it('unrouted: one island per pad; a probe on a pad joins its island only', async () => {
    const p = await fixtureMcu();
    const pads = [...p.doc.nodes.values()].filter((n) => n.type === 'pad' && n.props.net === 'SDA');
    expect(pads.length).toBeGreaterThan(1);
    const all = netIslands(p.doc, p.engine, p.copper, 'SDA');
    expect(all.groups).toHaveLength(pads.length);
    expect(all.probe).toBe(-1);
    const at = all.groups[0]![0]!;
    const r = netIslands(p.doc, p.engine, p.copper, 'SDA', { p: at, layer: 'F.Cu' });
    expect(r.groups).toHaveLength(pads.length);
    expect(r.groups[r.probe]).toContainEqual(at);
    // A probe off the copper is an island of its own.
    const off: Vec2 = { x: at.x + 50, y: at.y + 50 };
    const o = netIslands(p.doc, p.engine, p.copper, 'SDA', { p: off, layer: 'F.Cu' });
    expect(o.groups).toHaveLength(pads.length + 1);
    expect(o.groups[o.probe]).toEqual([off]);
  });
});
