/** Board loading shared by the benches (`autoroute.ts`, `autoplace.ts`). */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { applyOps, parseDoc, stringifyDoc, type Op } from '@hassassin/core';
import { openProject, runTool, type Project } from '@hassassin/tools';
import { readProject } from '../src/io.ts';

/** A `.kicad_pcb`, an `.hpcb`, or a project folder (snapshot plus `log.jsonl`). */
export async function readBoard(path: string): Promise<{ name: string; project: Project; replayed: number }> {
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
export async function applyKicadRules(p: Project, pcbPath: string): Promise<string> {
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


/**
 * The owner's review of a board's signal classes (`classes.json` next to this file, P16): nets whose class
 * was set by hand in the review get it on the net, then the classes are applied (rules written).
 * Returns the nets set, or null when the board has no review.
 */
export async function applyReviewedClasses(name: string, p: Project): Promise<string[] | null> {
  const file = join(dirname(new URL(import.meta.url).pathname), 'classes.json');
  if (!existsSync(file)) return null;
  const all = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string> | string>;
  const key = Object.keys(all).find((k) => !k.startsWith('_') && name.includes(k));
  if (!key) return null;
  const nets = new Set([...p.doc.nodes.values()].filter((n) => n.type === 'net').map((n) => n.name));
  const set: string[] = [];
  for (const [net, signal] of Object.entries(all[key] as Record<string, string>)) {
    if (!nets.has(net)) continue;
    await runTool(p, 'set_pin_signal', { target: net, net: true, signal });
    set.push(`${net}=${signal}`);
  }
  await runTool(p, 'classify_nets', { apply: true });
  return set;
}
