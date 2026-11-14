/**
 * Autoplacer benchmark (docs/05-pcb-improvements.md, P11).
 *
 *   node apps/cli/bench/autoplace.ts <board> [more boards …] [--kicad-rules] [--fixtures] [--no-route]
 *   node apps/cli/bench/autoplace.ts <board> --seed 3 --iterations 50000
 *
 * Every board is read (a `.kicad_pcb`, an `.hpcb` or a project folder), all traces and vias are ripped up
 * (pours stay and are refilled after placing), and every part that is not locked is placed again from scratch twice: by the greedy
 * placer alone (the v0.0.3 autoplacer, `improve: false`) and with the improvement pass. For each the
 * line gives the total ratsnest length (half-perimeter per net), courtyard overlaps, parts that could not
 * be placed and the time, then (unless `--no-route`) the autorouter's figures on the result.
 * `--fixtures` runs the synthetic boards used by the tests instead; `--drc` lists the DRC errors after routing.
 */
import { componentExtent, planAutoplace, ratsnestHpwl, runDrc } from '@hassassin/core';
import { measureAutoroute, ROUTE_FIXTURES, runTool, type Project } from '@hassassin/tools';
import { loadGeometry } from '../src/io.ts';
import { applyKicadRules, readBoard } from './boards.ts';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const seed = opt('--seed');
const iterations = opt('--iterations');
const route = !args.includes('--no-route');

/** Courtyard boxes that overlap (pairs of parts). */
function overlaps(p: Project): number {
  const els = [...p.doc.nodes.values()].filter((n) => n.type === 'element');
  const bs = els.map((e) => {
    const x = componentExtent(p.doc, p.engine, e, p.copper);
    const at = p.engine.get(e.uid, 'position')?.value as { x: number; y: number };
    return { minX: at.x + x.minX, minY: at.y + x.minY, maxX: at.x + x.maxX, maxY: at.y + x.maxY };
  });
  let n = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (bs[i]!.minX < bs[j]!.maxX && bs[i]!.maxX > bs[j]!.minX && bs[i]!.minY < bs[j]!.maxY && bs[i]!.maxY > bs[j]!.minY) n++;
  return n;
}

async function run(name: string, make: () => Promise<Project>): Promise<void> {
  const out: Record<string, number>[] = [];
  for (const improve of [false, true]) {
    const p = await make();
    // All traces and vias go (the parts move, so no copper of the old layout fits); pours stay and are refilled.
    const copper = [...p.doc.nodes.values()].filter((n) => n.type === 'trace' || n.type === 'via');
    if (copper.length) p.history.apply('Rip up', copper.map((n) => ({ op: 'remove' as const, uid: n.uid })));
    const t0 = performance.now();
    const { ops, report } = planAutoplace(p.doc, p.engine, p.copper, { all: true, improve, ...(seed !== undefined ? { seed } : {}), ...(iterations !== undefined ? { iterations } : {}) });
    const ms = Math.round(performance.now() - t0);
    p.history.apply('Auto-place parts', ops);
    const row: Record<string, number> = { ratsnest: ratsnestHpwl(p.doc, p.engine, p.copper), overlaps: overlaps(p), failed: report.failed.length, ms };
    let extra = '';
    if (improve) extra = ` decoupling ${report.decoupling?.length ?? 0}, clusters ${report.clusters?.length ?? 0}, at edge ${report.atEdge?.length ?? 0}, turned ${report.placed.filter((x) => x.rotation !== undefined).length}`;
    if (route) {
      await runTool(p, 'refill_pours', {});
      const f = await measureAutoroute(p);
      Object.assign(row, { routed: f.routed, connections: f.connections, vias: f.vias, length: f.length, drcErrors: f.drcErrors, routeMs: f.ms });
      extra += ` DRC ${JSON.stringify(f.drcByKind)} failed ${JSON.stringify(f.reasons)}`;
    }
    if (route && args.includes('--drc')) for (const v of runDrc(p.doc, p.engine, p.copper).violations) if (v.severity === 'error' && v.kind !== 'unrouted') console.log(`  ${improve ? 'improved' : 'greedy'} ${v.kind}: ${v.message}`);
    out.push(row);
    console.log(`${name} ${improve ? 'improved' : 'greedy  '}: ${JSON.stringify(row)}${extra}`);
  }
  const [g, b] = out as [Record<string, number>, Record<string, number>];
  console.log(`${name}: ratsnest ${g.ratsnest} → ${b.ratsnest} mm (${Math.round((1 - b.ratsnest! / g.ratsnest!) * 1000) / 10} % shorter)`);
}

await loadGeometry();
if (args.includes('--fixtures')) for (const [name, make] of Object.entries(ROUTE_FIXTURES)) await run(name, make);
for (const path of args.filter((a, i) => !a.startsWith('--') && !['--seed', '--iterations'].includes(args[i - 1] ?? ''))) {
  const make = async () => {
    const { project } = await readBoard(path);
    if (args.includes('--kicad-rules') && path.toLowerCase().endsWith('.kicad_pcb')) await applyKicadRules(project, path);
    return project;
  };
  await run(path.split('/').pop()!, make);
}
