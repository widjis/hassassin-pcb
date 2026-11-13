/**
 * Autorouter benchmark (docs/05-pcb-improvements.md, P8a).
 *
 *   node apps/cli/bench/autoroute.ts <board> [more boards …] [--json]
 *   node apps/cli/bench/autoroute.ts --fixtures [--json]
 *
 * A board is a `.hpcb` file, a `.kicad_pcb` (its `.kicad_sch` files next to it are read too), or a
 * server project folder (`.data/projects/<id>`): for a folder the
 * snapshot is read and the transactions logged after it (`log.jsonl`) are replayed, so the figures are
 * for the board as it is now. Boards are only read, never written: run it on copies.
 *
 * For each board: rip up the copper of every net that has no pour (traces and vias; pours, pads and
 * poured nets stay), autoroute, refill pours, run DRC, and print one line of figures.
 * `--fixtures` measures the synthetic boards used by the tests instead.
 * `--kicad-rules`: for a `.kicad_pcb`, apply the net classes and board rules of the `.kicad_pro` next to it
 * (track width, clearance, via size, minimum track, copper-to-edge clearance), which the importer does not
 * bring over yet, so the router works to the same rules as the original design.
 * `--opt key=value` (repeatable): an `autoroute` tool argument for the boards, e.g. `--opt direction_cost=1`
 * `--opt order=short` (numbers are read as numbers, `{…}` as JSON), to compare weights (P8f).
 * `--drc`: list the DRC errors left after routing.
 * `--classify`: apply the signal classes of the nets first (P16, `classify_nets` with apply=true), so the
 * per-class default rules (via cost, corner style, width, clearance) take part.
 * `--save <dir>`: also write `<board>.original.hpcb` (as read, rules applied) and `<board>.routed.hpcb`
 * (after the run) into that folder, to look at in the editor.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { applyOps, computeRatsnest, parseDoc, runDrc, stringifyDoc, type Op } from '@hassassin/core';
import { FIXTURE_ARGS, measureAutoroute, openProject, ripUpUnpoured, ROUTE_FIXTURES, runTool, saveProject, type Project, type RouteFigures } from '@hassassin/tools';
import { loadGeometry, readProject } from '../src/io.ts';

async function readBoard(path: string): Promise<{ name: string; project: Project; replayed: number }> {
  if (path.toLowerCase().endsWith('.kicad_pcb')) return { name: basename(path), project: await readProject([path]), replayed: 0 };
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

/** Apply a KiCad project's net classes and board rules to the project (see `--kicad-rules`). Returns a summary. */
async function applyKicadRules(p: Project, pcbPath: string): Promise<string> {
  const pro = join(dirname(pcbPath), basename(pcbPath).replace(/\.kicad_pcb$/i, '.kicad_pro'));
  if (!existsSync(pro)) return 'no .kicad_pro';
  const d = JSON.parse(await readFile(pro, 'utf8')) as {
    net_settings?: { classes?: { name: string; track_width?: number; clearance?: number; via_diameter?: number; via_drill?: number }[]; netclass_patterns?: { netclass: string; pattern: string }[] };
    board?: { design_settings?: { rules?: { min_track_width?: number; min_copper_edge_clearance?: number } } };
  };
  const classes = new Map((d.net_settings?.classes ?? []).map((c) => [c.name, c]));
  const patterns = (d.net_settings?.netclass_patterns ?? []).map((x) => ({ cls: x.netclass, re: new RegExp(`^${x.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) }));
  const rules = d.board?.design_settings?.rules ?? {};
  if (rules.min_copper_edge_clearance) await runTool(p, 'set_rule', { target: 'layout', rule: 'boardEdgeClearance', value: `${rules.min_copper_edge_clearance}mm` });
  const used = new Map<string, number>();
  for (const n of [...p.doc.nodes.values()].filter((x) => x.type === 'net' && x.name !== '(no net)')) {
    const bare = n.name.replace(/^\//, '');
    const name = patterns.find((x) => x.re.test(n.name) || x.re.test(bare))?.cls ?? 'Default';
    const c = classes.get(name) ?? classes.get('Default');
    if (!c) continue;
    used.set(name, (used.get(name) ?? 0) + 1);
    const target = `net#${JSON.stringify(n.name)}`;
    const set = (rule: string, v: number | undefined) => (v ? runTool(p, 'set_rule', { target, rule, value: `${v}mm` }) : undefined);
    await set('traceWidth', c.track_width);
    await set('keepOut', c.clearance);
    await set('viaDiameter', c.via_diameter);
    await set('viaHole', c.via_drill);
    await set('traceWidthMin', rules.min_track_width);
  }
  return `net classes ${JSON.stringify([...used])}, edge ${rules.min_copper_edge_clearance ?? '-'} mm`;
}

function line(name: string, f: RouteFigures, extra = ''): string {
  return (
    `${name}: ${f.routed}/${f.connections} routed (${f.failed} failed, ${f.unroutedAfter} unrouted after), ` +
    `${f.vias} vias, ${f.length} mm, ${f.ms} ms (+ check ${f.checkMs} ms, ${f.removedByDrc} taken out), DRC errors ${f.drcErrors} ${JSON.stringify(f.drcByKind)}, ` +
    `sharp corners ${f.sharpCorners}, off-angle ${f.offAngle}, bends/connection ${f.bendsPerConnection}, against direction ${f.againstDirection}, fanouts ${f.fanouts}, bundled ${f.bundled}, off plane ${f.offPlane}, grid ${f.grid}; failed: ${JSON.stringify(f.reasons)}${extra}`
  );
}

const args = process.argv.slice(2);
const json = args.includes('--json');
/** `--before`: only report the board as read (DRC, ratsnest, copper), without ripping up or routing. */
const before = args.includes('--before');
const kicadRules = args.includes('--kicad-rules');
const saveAt = args.indexOf('--save');
const saveDir = saveAt >= 0 ? args[saveAt + 1] : undefined;
const routeArgs: Record<string, unknown> = {};
for (const [i, a] of args.entries()) {
  if (a !== '--opt') continue;
  const [k, ...rest] = (args[i + 1] ?? '').split('=');
  const v = rest.join('=');
  routeArgs[k!] = v.startsWith('{') ? JSON.parse(v) : v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
}
const save = async (name: string, tag: string, p: Project) => {
  if (!saveDir) return;
  await mkdir(saveDir, { recursive: true });
  const file = join(saveDir, `${name.replace(/\.(kicad_pcb|hpcb)$/i, '')}.${tag}.hpcb`);
  await writeFile(file, saveProject(p));
  console.log(`saved ${file}`);
};
await loadGeometry();
if (args.includes('--fixtures')) {
  for (const [name, make] of Object.entries(ROUTE_FIXTURES)) {
    const f = await measureAutoroute(await make(), { ...(FIXTURE_ARGS[name] ?? {}), ...routeArgs });
    console.log(json ? JSON.stringify({ board: name, ...f }) : line(name, f));
  }
}
for (const path of args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--save' && args[i - 1] !== '--opt')) {
  const { name, project, replayed } = await readBoard(path);
  if (kicadRules && path.toLowerCase().endsWith('.kicad_pcb')) console.log(`${name}: ${await applyKicadRules(project, path)}`);
  if (args.includes('--classify')) console.log(`${name}: classes ${JSON.stringify(((await runTool(project, 'classify_nets', { apply: true })) as { counts: unknown }).counts)}`);
  if (before) {
    const drc = runDrc(project.doc, project.engine, project.copper).violations;
    const kinds: Record<string, number> = {};
    for (const v of drc) kinds[`${v.severity}:${v.kind}`] = (kinds[`${v.severity}:${v.kind}`] ?? 0) + 1;
    const count = (t: string) => [...project.doc.nodes.values()].filter((n) => n.type === t).length;
    console.log(`${name} as read: ${count('element')} parts, ${count('net')} nets, ${count('trace')} traces, ${count('via')} vias, ${count('fill')} pours, ratsnest ${computeRatsnest(project.doc, project.engine, project.copper).lines.length}, DRC ${JSON.stringify(kinds)}`);
    continue;
  }
  await save(basename(path), 'original', project);
  const ripped = ripUpUnpoured(project);
  const f = await measureAutoroute(project, routeArgs);
  await save(basename(path), 'routed', project);
  // `--drc`: list the DRC errors left after routing.
  if (args.includes('--drc')) for (const v of runDrc(project.doc, project.engine, project.copper).violations) if (v.severity === 'error') console.log(`  ${v.kind}: ${v.message}`);
  console.log(json ? JSON.stringify({ board: name, replayed, ripped, ...f }) : line(name, f, ` [log entries replayed: ${replayed}, items ripped up: ${ripped}]`));
}
