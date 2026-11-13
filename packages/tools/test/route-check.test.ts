/**
 * P8g (docs/05-pcb-improvements.md): an autoroute plan is checked with DRC before it is applied, and a
 * connection whose copper causes an error is taken out and reported, never left on the board.
 */
import { describe, expect, it } from 'vitest';
import { checkAutoroute, collectCopper, planAutoroute, runDrc, stringifyDoc, type Op, type Vec2 } from '@hassassin/core';
import { fixtureBus, runTool } from '@hassassin/tools';

describe('autoroute DRC check (P8g)', () => {
  it('takes a connection with a DRC error out of the plan and leaves the board as it was', async () => {
    const p = await fixtureBus();
    const plan = planAutoroute(p.doc, p.engine, p.copper);
    expect(plan.report.failed).toEqual([]);
    // Spoil the first connection: run its first trace through a pad of another net.
    const victim = plan.report.routed[0]!;
    const other = collectCopper(p.doc, p.engine, p.copper).find((s) => s.kind === 'pad' && s.net && s.net !== victim.net)!;
    const at: Vec2 = { x: (other.box.minX + other.box.maxX) / 2, y: (other.box.minY + other.box.maxY) / 2 };
    const ops = plan.ops.map((op) => {
      if (op.op !== 'add' || op.tree.nodes[0]!.uid !== victim.uids![0]) return op;
      const n = op.tree.nodes[0]!;
      return { ...op, tree: { nodes: [{ ...n, rules: n.rules.map((r) => (r.name === 'end' ? { ...r, value: at } : r)) }] } } as Op;
    });
    const snap = () => stringifyDoc(p.doc).replace(/"savedAt":"[^"]*"/, '');
    const before = snap();
    const checked = checkAutoroute(p.doc, p.engine, p.copper, { ops, report: plan.report });
    expect(snap()).toBe(before);
    expect(checked.removed).toBeGreaterThanOrEqual(1);
    expect(checked.report.failed.some((f) => f.net === victim.net && f.reason.startsWith('DRC:'))).toBe(true);
    expect(checked.report.routed.length + checked.report.failed.length).toBe(plan.report.routed.length);
    // What is left is clean.
    p.history.apply('Autoroute', checked.ops);
    await runTool(p, 'refill_pours', {});
    expect(runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted')).toEqual([]);
  });

  it('the autoroute tool checks by default and reports it', async () => {
    const p = await fixtureBus();
    const r = (await runTool(p, 'autoroute', {})) as { checked: boolean; removedByDrc: number; routed: number; reasons: Record<string, number> };
    expect(r).toMatchObject({ checked: true, removedByDrc: 0, routed: 8, reasons: {} });
    const q = await fixtureBus();
    expect(((await runTool(q, 'autoroute', { check: false })) as { checked: boolean }).checked).toBe(false);
  });
});
