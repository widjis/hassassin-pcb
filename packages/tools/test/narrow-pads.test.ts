/**
 * Found on the solar MPPT board (P8g acceptance run, 2026-11-14): pads as wide as the minimum trace width, and
 * pads narrower than it, must still be routed (KiCad allows a trace wider than the pad it enters).
 */
import { describe, expect, it } from 'vitest';
import { padGeom } from '@hassassin/core';
import { fixtureQfnEscape, runTool, type Project } from '@hassassin/tools';

/** Narrowest side of the QFN's signal pads (mm, to the micrometre). */
const padWidth = (p: Project) =>
  Math.min(
    ...[...p.doc.nodes.values()]
      .filter((n) => n.type === 'pad' && p.doc.nodes.get(n.parent!)?.name === 'U1')
      .map((n) => {
        const xs = padGeom(p.doc, p.engine, n, p.copper)!.outline;
        return Math.round(Math.min(Math.max(...xs.map((q) => q.x)) - Math.min(...xs.map((q) => q.x)), Math.max(...xs.map((q) => q.y)) - Math.min(...xs.map((q) => q.y))) * 1000) / 1000;
      }),
  );

describe('pads at or under the minimum trace width', () => {
  it('a pad exactly as wide as the minimum trace width is entered (it measured 0.19999… and was refused)', { timeout: 60_000 }, async () => {
    const p = await fixtureQfnEscape();
    const w = padWidth(p);
    // As on the solar board: trace width = minimum = pad width.
    for (const rule of ['traceWidth', 'traceWidthMin']) await runTool(p, 'set_rule', { target: 'net', rule, value: `${w}mm` });
    const r = (await runTool(p, 'autoroute', {})) as { failed: { reason: string }[] };
    expect(r.failed.map((f) => f.reason)).not.toContain('pad is narrower than the minimum trace width');
    expect(r.failed).toEqual([]);
  });

  it('a pad narrower than the minimum trace width is entered at the minimum width, not refused', { timeout: 60_000 }, async () => {
    const p = await fixtureQfnEscape();
    const w = padWidth(p);
    for (const rule of ['traceWidth', 'traceWidthMin']) await runTool(p, 'set_rule', { target: 'net', rule, value: `${Math.round((w + 0.02) * 1000) / 1000}mm` });
    const r = (await runTool(p, 'autoroute', {})) as { routed: number; failed: { reason: string }[] };
    expect(r.failed.map((f) => f.reason)).not.toContain('pad is narrower than the minimum trace width');
    expect(r.routed).toBeGreaterThan(0);
  });
});
