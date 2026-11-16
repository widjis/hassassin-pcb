/**
 * KiCad export check (docs/05-pcb-improvements.md, P15): export each board as `.kicad_pcb` + `.kicad_pro`,
 * run KiCad's own DRC on it (`kicad-cli pcb drc`), and compare with our DRC of the same board.
 *
 *   node apps/cli/bench/kicad.ts <board> [more boards …] --out <folder> [--kicad-rules] [--refill] [--all]
 *
 * A board is read as in `autoroute.ts` (`.hpcb`, `.kicad_pcb`, or a server project folder), never written;
 * the exported files go to `--out`; `--refill` fills the pours again first. KiCad's command line tool is taken from $KICAD_CLI, else from the usual
 * install place on macOS. Also opens the exported file again with our importer and compares the parts,
 * pads (board position), traces, vias and pours with the board it came from.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kicadPcb, padGeom, runDrc, type Vec2 } from '@hassassin/core';
import { openProject, runTool, type Project } from '@hassassin/tools';
import { loadGeometry } from '../src/io.ts';
import { applyKicadRules, readBoard } from './boards.ts';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (!outDir) throw new Error('--out <folder> is required');
const boards = args.filter((a, i) => !a.startsWith('--') && i !== outIdx + 1);
const cli = process.env.KICAD_CLI ?? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';
if (!existsSync(cli)) throw new Error(`kicad-cli not found at ${cli}; set KICAD_CLI`);
await loadGeometry();

interface KiItem { description: string; pos: Vec2 }
interface KiViolation { type: string; severity: string; description: string; items: KiItem[] }

const fmt = (p: Vec2) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`;

/** Where the board's items are, for the round-trip comparison. */
function census(p: Project) {
  const pads = new Map<string, Vec2>();
  for (const n of p.doc.nodes.values()) {
    if (n.type !== 'pad') continue;
    const g = padGeom(p.doc, p.engine, n, p.copper);
    const el = p.doc.nodes.get(n.parent!);
    if (g) pads.set(`${el?.name}.${n.props.number ?? n.name}`, g.center);
  }
  const count = (t: string) => [...p.doc.nodes.values()].filter((n) => n.type === t).length;
  return { pads, parts: count('element'), traces: count('trace'), vias: count('via'), pours: count('fill'), keepouts: count('zone') };
}

for (const path of boards) {
  const { name, project } = await readBoard(path);
  if (args.includes('--kicad-rules') && path.toLowerCase().endsWith('.kicad_pcb')) await applyKicadRules(project, path);
  if (args.includes('--refill')) await runTool(project, 'refill_pours', {});
  const base = name.replace(/\.(kicad_pcb|hpcb)$/i, '').replace(/[^\w.-]+/g, '_');
  const dir = join(outDir, base);
  mkdirSync(dir, { recursive: true });
  const r = kicadPcb(project.doc, project.engine, { project: base, layers: project.layers.map((l) => l.name) });
  for (const f of r.files) writeFileSync(join(dir, f.name), f.text);
  const pcb = join(dir, r.board);
  const report = join(dir, 'kicad-drc.json');
  execFileSync(cli, ['pcb', 'drc', '--severity-all', '--format', 'json', '-o', report, pcb], { stdio: 'pipe' });
  const kd = JSON.parse(readFileSync(report, 'utf8')) as { violations: KiViolation[]; unconnected_items: KiViolation[] };
  const ours = runDrc(project.doc, project.engine, project.copper);

  const tally = (xs: { k: string }[]) => {
    const t: Record<string, number> = {};
    for (const x of xs) t[x.k] = (t[x.k] ?? 0) + 1;
    return t;
  };
  console.log(`\n${name} → ${pcb}`);
  console.log(`  exported: ${JSON.stringify(r.stats)}${r.warnings.length ? `\n  warnings: ${r.warnings.join(' | ')}` : ''}`);
  console.log(`  ours:  ${ours.violations.length} ${JSON.stringify(tally(ours.violations.map((v) => ({ k: `${v.severity}:${v.kind}` }))))}`);
  console.log(`  KiCad: ${kd.violations.length} + ${kd.unconnected_items.length} unconnected ${JSON.stringify(tally([...kd.violations, ...kd.unconnected_items.map((u) => ({ ...u, type: 'unconnected' }))].map((v) => ({ k: `${v.severity}:${v.type}` }))))}`);
  const all = args.includes('--all');
  for (const v of ours.violations) if (v.severity === 'error' || all) console.log(`    ours  ${v.severity} ${v.kind}: ${v.message} at ${fmt(v.at)}`);
  for (const v of [...kd.violations, ...kd.unconnected_items.map((u) => ({ ...u, type: 'unconnected' }))]) {
    if (v.severity !== 'error' && !all) continue;
    console.log(`    KiCad ${v.severity} ${v.type}: ${v.description} — ${v.items.map((i) => `${i.description} ${fmt(i.pos)}`).join(' / ')}`);
  }

  // Round trip: our importer reads the exported file back.
  const back = openProject([{ name: r.board, text: readFileSync(pcb, 'utf8') }]);
  const a = census(project);
  const b = census(back);
  let moved = 0;
  let missing = 0;
  for (const [k, p] of a.pads) {
    const q = b.pads.get(k);
    if (!q) missing++;
    else if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-4) moved++;
  }
  const backDrc = runDrc(back.doc, back.engine, back.copper);
  console.log(
    `  round trip: parts ${a.parts}→${b.parts}, pads ${a.pads.size}→${b.pads.size} (${missing} missing, ${moved} moved), traces ${a.traces}→${b.traces}, vias ${a.vias}→${b.vias}, pours ${a.pours}→${b.pours}, keep-outs ${a.keepouts}→${b.keepouts}; our DRC errors ${ours.violations.filter((v) => v.severity === 'error').length}→${backDrc.violations.filter((v) => v.severity === 'error').length}`,
  );
}
