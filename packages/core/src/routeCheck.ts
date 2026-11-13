/**
 * Checking an autoroute plan before it is applied (docs/05-pcb-improvements.md, P8g): the plan is put on
 * the board for a moment, pours are refilled where the board has them, DRC runs, and every connection
 * whose new copper takes part in a DRC error is taken out of the plan and reported as not routed. This
 * repeats until DRC finds nothing new. The document and engine are left exactly as they were.
 */
import type { AutorouteReport } from './autoroute.ts';
import { applyOps, type Op } from './commands.ts';
import type { Doc } from './model.ts';
import { planPours, refillOps } from './pour.ts';
import { runDrc, type Violation } from './drc.ts';
import type { StyleEngine } from './style.ts';

export interface CheckedRoute {
  ops: Op[];
  report: AutorouteReport;
  /** Connections taken out because their copper caused DRC errors. */
  removed: number;
  /** Time spent checking (ms). */
  checkMs: number;
}

const addedUid = (op: Op): string | undefined => (op.op === 'add' ? op.tree.nodes[0]?.uid : undefined);

export function checkAutoroute(doc: Doc, engine: StyleEngine, copper: string[], plan: { ops: Op[]; report: AutorouteReport }, opts: { rounds?: number } = {}): CheckedRoute {
  const t0 = performance.now();
  let ops = plan.ops;
  const report: AutorouteReport = { ...plan.report, routed: [...plan.report.routed], failed: [...plan.report.failed] };
  let removed = 0;
  for (let round = 0; round < (opts.rounds ?? 4) && ops.length; round++) {
    const owner = new Map<string, number>();
    report.routed.forEach((r, i) => r.uids?.forEach((u) => owner.set(u, i)));
    for (const op of ops) {
      const u = addedUid(op);
      if (u && !owner.has(u)) owner.set(u, -1);
    }
    // Put the plan on the board, refill the pours, check, and take it all back off.
    const undo: Op[][] = [];
    let found: Violation[] = [];
    try {
      undo.push(applyOps(doc, ops).inverse);
      engine.recompute();
      const pours = planPours(doc, engine, copper);
      if (pours.length) undo.push(applyOps(doc, pours).inverse), engine.recompute();
      const fill = refillOps(doc, engine, copper).ops;
      if (fill.length) undo.push(applyOps(doc, fill).inverse), engine.recompute();
      found = runDrc(doc, engine, copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted' && v.uids.some((u) => owner.has(u)));
    } finally {
      for (const inv of undo.reverse()) applyOps(doc, inv);
      engine.recompute();
    }
    if (!found.length) break;
    const bad = new Map<number, Violation>();
    for (const v of found) for (const u of v.uids) if ((owner.get(u) ?? -1) >= 0 && !bad.has(owner.get(u)!)) bad.set(owner.get(u)!, v);
    if (!bad.size) break;
    // A stub shared with a connection that stays is kept for it (if the stub itself is at fault, the next
    // round finds it again and takes out its other owners as well).
    const kept = new Set<string>();
    report.routed.forEach((r, i) => !bad.has(i) && r.uids?.forEach((u) => kept.add(u)));
    const drop = new Set<string>();
    for (const i of bad.keys()) for (const u of report.routed[i]!.uids ?? []) if (!kept.has(u)) drop.add(u);
    ops = ops.filter((op) => !drop.has(addedUid(op) ?? ''));
    for (const [i, v] of [...bad].sort((a, b) => b[0] - a[0])) {
      const r = report.routed[i]!;
      report.failed.push({ net: r.net, from: r.from, to: r.to, reason: `DRC: ${v.kind}${v.message ? ` (${v.message})` : ''}` });
      report.routed.splice(i, 1);
      removed++;
    }
  }
  return { ops, report, removed, checkMs: Math.round(performance.now() - t0) };
}

export interface AutorouteSummary {
  /** Connections routed (including ones already joined by existing copper). */
  routed: number;
  /** Connections not routed, each with the reason. */
  failed: AutorouteReport['failed'];
  /** Reasons of the failed connections, counted. */
  reasons: Record<string, number>;
  vias: number;
  /** mm of new copper. */
  totalLength: number;
  ms: number;
  grid: number;
  fanouts: number;
  bundled: number;
  /** Connections routed by shoving routes aside instead of ripping them up (P9). */
  shoved: number;
  /** Differential pairs routed together (P10). */
  pairs: number;
}

/** The figures the `autoroute` tool, the CLI bench and the Board panel all report (P8g). */
export function autorouteSummary(report: AutorouteReport): AutorouteSummary {
  const reasons: Record<string, number> = {};
  for (const f of report.failed) {
    const k = f.reason.startsWith('DRC:') ? f.reason.replace(/ \(.*$/, '') : f.reason;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  return {
    routed: report.routed.length,
    failed: report.failed,
    reasons,
    vias: report.routed.reduce((s, r) => s + r.vias, 0),
    totalLength: +report.routed.reduce((s, r) => s + r.length, 0).toFixed(2),
    ms: report.ms,
    grid: report.grid,
    fanouts: report.fanouts ?? 0,
    bundled: report.bundled ?? 0,
    shoved: report.shoved ?? 0,
    pairs: report.pairs ?? 0,
  };
}
