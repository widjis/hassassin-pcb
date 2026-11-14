/** P8g (docs/05-pcb-improvements.md): long tools report their progress to the caller (the CLI prints it on stderr). */
import { describe, expect, it } from 'vitest';
import { fixtureMcu, runTool } from '@hassassin/tools';

describe('autoroute progress (P8g)', () => {
  it('reports routing rounds and the DRC check through ToolContext.onProgress', { timeout: 60_000 }, async () => {
    const p = await fixtureMcu();
    const lines: string[] = [];
    const r = (await runTool(p, 'autoroute', {}, { onProgress: (l) => lines.push(l) })) as { routed: number };
    expect(lines.some((l) => /^Routing: \d+\/\d+ connections, round 1 · \d+ s$/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe('Checking the result with DRC…');
    expect(r.routed).toBeGreaterThan(0);
  });

  it('auto_place reports its improvement runs', { timeout: 60_000 }, async () => {
    const p = await fixtureMcu();
    const lines: string[] = [];
    await runTool(p, 'auto_place', { all: true, iterations: 20000 }, { onProgress: (l) => lines.push(l) });
    expect(lines[0]).toBe('Placing: run 1/3, 0 %');
    expect(lines).toContain('Placing: run 3/3, 90 %');
  });
});
