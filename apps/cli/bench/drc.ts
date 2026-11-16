/**
 * DRC report for boards (docs/05-pcb-improvements.md, P12).
 *
 *   node apps/cli/bench/drc.ts <board> [more boards …] [--all] [--kicad-rules]
 *
 * A board is read as in `autoroute.ts` (`.hpcb`, `.kicad_pcb`, or a server project folder), never written.
 * Prints the count per severity and kind, then each error (and with `--all` each warning too).
 */
import { runDrc } from '@hassassin/core';
import { loadGeometry } from '../src/io.ts';
import { applyKicadRules, readBoard } from './boards.ts';

const args = process.argv.slice(2);
await loadGeometry();
for (const path of args.filter((a) => !a.startsWith('--'))) {
  const { name, project } = await readBoard(path);
  if (args.includes('--kicad-rules') && path.toLowerCase().endsWith('.kicad_pcb')) console.log(`${name}: ${await applyKicadRules(project, path)}`);
  const r = runDrc(project.doc, project.engine, project.copper);
  const kinds: Record<string, number> = {};
  for (const v of r.violations) kinds[`${v.severity}:${v.kind}`] = (kinds[`${v.severity}:${v.kind}`] ?? 0) + 1;
  console.log(`${name}: ${r.violations.length} violation(s) in ${r.ms.toFixed(0)} ms ${JSON.stringify(kinds)}${r.waived?.length ? `, ${r.waived.length} waived` : ''}`);
  for (const v of r.violations) if (v.severity === 'error' || args.includes('--all')) console.log(`  ${v.severity} ${v.kind}: ${v.message} at (${v.at.x.toFixed(3)}, ${v.at.y.toFixed(3)})${args.includes("--uids") ? ` ${v.uids.join(" ")}` : ""}`);
}
