/**
 * Autorouter benchmark (docs/05-pcb-improvements.md, P8a).
 *
 *   node apps/cli/bench/autoroute.ts <board> [more boards …] [--json]
 *   node apps/cli/bench/autoroute.ts --fixtures [--json]
 *
 * A board is a `.hpcb` file or a server project folder (`.data/projects/<id>`): for a folder the
 * snapshot is read and the transactions logged after it (`log.jsonl`) are replayed, so the figures are
 * for the board as it is now. Boards are only read, never written: run it on copies.
 *
 * For each board: rip up the copper of every net that has no pour (traces and vias; pours, pads and
 * poured nets stay), autoroute, refill pours, run DRC, and print one line of figures.
 * `--fixtures` measures the synthetic boards used by the tests instead.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { applyOps, parseDoc, stringifyDoc, type Op } from '@hassassin/core';
import { measureAutoroute, openProject, ripUpUnpoured, ROUTE_FIXTURES, type Project, type RouteFigures } from '@hassassin/tools';
import { loadGeometry } from '../src/io.ts';

async function readBoard(path: string): Promise<{ name: string; project: Project; replayed: number }> {
  if (!statSync(path).isDirectory()) {
    return { name: basename(path), project: openProject([{ name: basename(path), text: await readFile(path, 'utf8') }]), replayed: 0 };
  }
  const doc = parseDoc(await readFile(join(path, 'snapshot.hpcb'), 'utf8'));
  const metaPath = join(path, 'meta.json');
  const meta = existsSync(metaPath) ? (JSON.parse(await readFile(metaPath, 'utf8')) as { name?: string; snapshotSeq?: number }) : {};
  let seq = meta.snapshotSeq ?? 0;
  let replayed = 0;
  const logPath = join(path, 'log.jsonl');
  const lines = existsSync(logPath) ? (await readFile(logPath, 'utf8')).split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const e = JSON.parse(line) as { seq: number; ops: Op[] };
    if (e.seq <= seq) continue;
    try {
      applyOps(doc, e.ops);
      replayed++;
    } catch {
      /* the server skips entries that do not apply; do the same */
    }
    seq = e.seq;
  }
  const name = meta.name ? `${meta.name} (${basename(path)})` : basename(path);
  return { name, project: openProject([{ name: `${basename(path)}.hpcb`, text: stringifyDoc(doc) }]), replayed };
}

function line(name: string, f: RouteFigures, extra = ''): string {
  return (
    `${name}: ${f.routed}/${f.connections} routed (${f.failed} failed, ${f.unroutedAfter} unrouted after), ` +
    `${f.vias} vias, ${f.length} mm, ${f.ms} ms, DRC errors ${f.drcErrors} ${JSON.stringify(f.drcByKind)}, ` +
    `sharp corners ${f.sharpCorners}, bends/connection ${f.bendsPerConnection}; failed: ${JSON.stringify(f.reasons)}${extra}`
  );
}

const args = process.argv.slice(2);
const json = args.includes('--json');
await loadGeometry();
if (args.includes('--fixtures')) {
  for (const [name, make] of Object.entries(ROUTE_FIXTURES)) {
    const f = await measureAutoroute(await make());
    console.log(json ? JSON.stringify({ board: name, ...f }) : line(name, f));
  }
}
for (const path of args.filter((a) => !a.startsWith('--'))) {
  const { name, project, replayed } = await readBoard(path);
  const ripped = ripUpUnpoured(project);
  const f = await measureAutoroute(project);
  console.log(json ? JSON.stringify({ board: name, replayed, ripped, ...f }) : line(name, f, ` [log entries replayed: ${replayed}, items ripped up: ${ripped}]`));
}
