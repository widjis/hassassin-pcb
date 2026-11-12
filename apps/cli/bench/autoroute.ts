/**
 * Autorouter benchmark (docs/05-pcb-improvements.md, P8).
 *
 *   node apps/cli/bench/autoroute.ts <snapshot.hpcb> [more.hpcb …] [--json]
 *
 * Reads each board (never writes it), rips up the copper of every net that has no pour
 * (traces and vias; pours, pads and poured nets stay), autoroutes, refills pours and runs DRC.
 * Prints one line of figures per board.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { computeRatsnest, runDrc, type Op } from '@hassassin/core';
import { openProject, runTool } from '@hassassin/tools';
import { loadGeometry } from '../src/io.ts';

interface Row {
  board: string;
  connections: number;
  routed: number;
  failed: number;
  vias: number;
  length: number;
  ms: number;
  unroutedAfter: number;
  drcErrors: number;
  drcByKind: Record<string, number>;
  reasons: Record<string, number>;
}

async function bench(path: string): Promise<Row> {
  const p = openProject([{ name: basename(path), text: await readFile(path, 'utf8') }]);
  // Rip up: traces and vias of nets without a pour.
  const poured = new Set<string>();
  for (const n of p.doc.nodes.values()) if (n.type === 'fill' && n.parent) poured.add(n.parent);
  const ops: Op[] = [];
  for (const n of p.doc.nodes.values()) {
    if (n.type !== 'trace' && n.type !== 'via') continue;
    const net = n.parent ? p.doc.nodes.get(n.parent) : undefined;
    if (net?.type === 'net' && poured.has(net.uid)) continue;
    ops.push({ op: 'remove', uid: n.uid });
  }
  if (ops.length) p.history.apply('Rip up', ops);
  await runTool(p, 'refill_pours', {});
  const connections = computeRatsnest(p.doc, p.engine, p.copper).lines.length;
  const r = (await runTool(p, 'autoroute', {})) as { routed: number; failed: { reason: string }[]; vias: number; totalLength: number; ms: number };
  await runTool(p, 'refill_pours', {});
  const drc = runDrc(p.doc, p.engine, p.copper).violations;
  const errors = drc.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');
  const byKind: Record<string, number> = {};
  for (const v of errors) byKind[v.kind] = (byKind[v.kind] ?? 0) + 1;
  return {
    board: basename(dirname(path)),
    connections,
    routed: r.routed,
    failed: r.failed.length,
    vias: r.vias,
    length: r.totalLength,
    ms: r.ms,
    unroutedAfter: computeRatsnest(p.doc, p.engine, p.copper).lines.length,
    drcErrors: errors.length,
    drcByKind: byKind,
    reasons: Object.fromEntries([...new Set(r.failed.map((f) => f.reason))].map((k) => [k, r.failed.filter((f) => f.reason === k).length])),
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
await loadGeometry();
for (const f of args.filter((a) => !a.startsWith('--'))) {
  const row = await bench(f);
  if (json) console.log(JSON.stringify(row));
  else
    console.log(
      `${row.board}: ${row.routed}/${row.connections} routed (${row.failed} failed, ${row.unroutedAfter} unrouted after), ` +
        `${row.vias} vias, ${row.length} mm, ${row.ms} ms, DRC errors ${row.drcErrors} ${JSON.stringify(row.drcByKind)}; failed: ${JSON.stringify(row.reasons)}`,
    );
}
