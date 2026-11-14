/**
 * Copy, paste and duplicate on the board, and layout replication (docs/05-pcb-improvements.md, P3).
 *
 * A copy holds parts (with their pads and graphics), traces, vias, pours, keep-outs and board graphics,
 * relative to the centre of what was copied. Traces are copied only when both their ends sit on copied
 * copper (a copied part's pad, a copied via, or the end of another such trace), unless asked for all.
 *
 * On paste each part takes the reference of a schematic part not yet on the board with the same footprint
 * and value (its pads then get that part's nets from the schematic), else a new reference with no nets.
 * Copied traces, vias and pours follow the nets of the pads they belong to: a net that maps to a pasted
 * pad's net is renamed to it, a net of a pad that got no net is left out, and other nets (a ground pour,
 * a supply) stay as they are.
 *
 * Replication: the placement and routing of one schematic block's parts applied to another block made of
 * the same parts (same footprint and value, paired by their place in the schematic).
 */
import type { Op } from './commands.ts';
import { movablePoints, isBoardMovable, mapFills } from './boardSelect.ts';
import { collectCopper, inArea } from './copper.ts';
import { padGeom } from './frames.ts';
import { newUid, type Doc, type DocNode, type Vec2 } from './model.ts';
import { extractNetlist } from './netlist.ts';
import type { StyleEngine } from './style.ts';

export interface BoardClip {
  kind: 'hassassin-board';
  /** Subtrees (root first), each with where it belongs: a part, a net's copper, board graphics, keep-outs. */
  items: { place: 'part' | 'net' | 'board' | 'zones'; net?: string; nodes: DocNode[] }[];
  /** Centre of the copied items (pasted at the cursor). */
  anchor: Vec2;
}

export const isBoardClip = (v: unknown): v is BoardClip => !!v && typeof v === 'object' && (v as BoardClip).kind === 'hassassin-board';

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const POINT_RULES = new Set(['start', 'end', 'mid', 'position', 'center', 'points']);
const eq = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

function subtree(doc: Doc, n: DocNode): DocNode[] {
  const out: DocNode[] = [];
  const walk = (x: DocNode) => {
    out.push(structuredClone(x));
    for (const c of x.children) {
      const k = doc.nodes.get(c);
      if (k) walk(k);
    }
  };
  walk(n);
  return out;
}

/** Copy board items (by uid); traces only when both ends rest on copied copper, unless `allTraces`. */
export function copyBoardItems(doc: Doc, engine: StyleEngine, copper: string[], uids: Iterable<string>, opts: { allTraces?: boolean } = {}): BoardClip | null {
  const picked = [...new Set(uids)].map((u) => doc.nodes.get(u)).filter((n): n is DocNode => !!n && isBoardMovable(doc, n));
  if (!picked.length) return null;
  const parts = picked.filter((n) => n.type === 'element');
  const vias = picked.filter((n) => n.type === 'via');
  let traces = picked.filter((n) => n.type === 'trace');
  if (!opts.allTraces && traces.length) {
    const partSet = new Set(parts.map((p) => p.uid));
    const viaSet = new Set(vias.map((v) => v.uid));
    const anchors = collectCopper(doc, engine, copper).filter((s) => (s.kind === 'via' && viaSet.has(s.uid)) || (s.kind === 'pad' && partSet.has(doc.nodes.get(s.uid)?.parent ?? '')));
    const endsOf = (t: DocNode) => [vec(engine.get(t.uid, 'start')?.value)!, vec(engine.get(t.uid, 'end')?.value)!];
    const layerOf = (t: DocNode) => String(engine.get(t.uid, 'layer')?.value ?? '');
    const onCopper = (p: Vec2, layer: string) => anchors.some((s) => (s.kind === 'via' ? Math.hypot(p.x - s.probe.x, p.y - s.probe.y) <= (s.edges[0]?.[2] ?? 0) + 1e-6 : s.layer === layer && !!s.areas[0] && inArea(p, s.areas[0])));
    // Keep removing traces with an end on nothing copied, until none is left to remove.
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of traces.slice()) {
        const ok = endsOf(t).every((p) => onCopper(p, layerOf(t)) || traces.some((o) => o !== t && layerOf(o) === layerOf(t) && endsOf(o).some((q) => eq(p, q))));
        if (!ok) (traces = traces.filter((x) => x !== t)), (changed = true);
      }
    }
  }
  const keep = new Set([...parts, ...vias, ...traces, ...picked.filter((n) => !['element', 'via', 'trace'].includes(n.type))]);
  // Anchor: centre of the points of what is copied.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of keep)
    for (const v of Object.values(movablePoints(engine, n)))
      for (const p of Array.isArray(v) ? v : [v]) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  if (!Number.isFinite(x0)) return null;
  const netName = (n: DocNode) => (n.parent ? doc.nodes.get(n.parent) : undefined);
  const items: BoardClip['items'] = [];
  for (const n of keep) {
    const parent = netName(n);
    if (n.type === 'element') items.push({ place: 'part', nodes: subtree(doc, n) });
    else if (parent?.type === 'net') items.push({ place: 'net', net: parent.name, nodes: subtree(doc, n) });
    else if (n.type === 'zone') items.push({ place: 'zones', nodes: subtree(doc, n) });
    else items.push({ place: 'board', nodes: subtree(doc, n) });
  }
  return { kind: 'hassassin-board', items, anchor: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
}

/** Where board items go: a layout container by name, created when missing. */
function container(doc: Doc, name: string, ops: Op[]): string {
  const layout = [...doc.nodes.values()].find((n) => n.type === 'layout');
  if (!layout) throw new Error('The project has no board yet.');
  const c = layout.children.map((u) => doc.nodes.get(u)!).find((n) => n?.type === 'container' && n.name === name);
  if (c) return c.uid;
  const uid = newUid('ct');
  ops.push({ op: 'add', parent: layout.uid, index: layout.children.length, tree: { nodes: [{ uid, type: 'container', name, props: {}, rules: [], parent: layout.uid, children: [] }] } });
  return uid;
}

/** A net node by name (created under Nets when missing). */
function netNodeUid(doc: Doc, name: string, ops: Op[], made: Map<string, string>): string {
  const have = [...doc.nodes.values()].find((n) => n.type === 'net' && n.name === name);
  if (have) return have.uid;
  if (made.has(name)) return made.get(name)!;
  const parent = container(doc, 'Nets', ops);
  const uid = newUid('net');
  ops.push({ op: 'add', parent, index: 0, tree: { nodes: [{ uid, type: 'net', name, props: {}, rules: [], parent, children: [] }] } });
  made.set(name, uid);
  return uid;
}

export interface BoardPasteResult {
  ops: Op[];
  /** Uids of the pasted top-level items. */
  uids: string[];
  /** Old reference → new reference, and which were matched to schematic parts. */
  refs: [string, string][];
  matched: string[];
  /** Copied copper left out because its net would have no pads (parts with no schematic part). */
  skipped: number;
}

/** Paste a board copy with its centre at `at`; `transform` (default: a shift) maps old points to new. */
export function pasteBoardOps(doc: Doc, engine: StyleEngine, copper: string[], clip: BoardClip, at: Vec2, opts: { transform?: (p: Vec2) => Vec2; refs?: Map<string, string> } = {}): BoardPasteResult {
  const d = { x: at.x - clip.anchor.x, y: at.y - clip.anchor.y };
  const f = opts.transform ?? ((p: Vec2) => ({ x: Math.round((p.x + d.x) * 1e4) / 1e4, y: Math.round((p.y + d.y) * 1e4) / 1e4 }));
  const ops: Op[] = [];
  const made = new Map<string, string>();
  const onBoard = new Set([...doc.nodes.values()].filter((n) => n.type === 'element').map((n) => n.name));
  const nl = extractNetlist(doc, engine);
  // Schematic parts not on the board yet, by footprint and value.
  const free: { ref: string; key: string }[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power || Number(n.props.unit ?? 1) > 1) continue;
    const ref = String(n.props.ref ?? n.name);
    if (onBoard.has(ref) || ref.endsWith('?') || free.some((x) => x.ref === ref)) continue;
    free.push({ ref, key: `${n.props.Footprint ?? ''}|${n.props.Value ?? ''}` });
  }
  free.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  const used = new Set(onBoard);
  const nextRef = (old: string) => {
    const prefix = old.replace(/\d+$/, '') || 'U';
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  };
  const netMap = new Map<string, string>();
  const refs: [string, string][] = [];
  const matched: string[] = [];
  const uids: string[] = [];
  const partsC = clip.items.some((i) => i.place === 'part') ? container(doc, 'Components', ops) : '';
  // Parts first (their pads decide the nets of the copper).
  for (const it of clip.items.filter((i) => i.place === 'part')) {
    const [root, ...kids] = it.nodes;
    const old = root!.name;
    const key = `${root!.props.Footprint ?? ''}|${root!.props.Value ?? ''}`;
    let ref = opts.refs?.get(old);
    let fromSchematic = !!ref;
    if (!ref) {
      const k = free.findIndex((x) => x.key === key && !used.has(x.ref));
      if (k >= 0) (ref = free[k]!.ref), (fromSchematic = true);
      else ref = nextRef(old);
    }
    used.add(ref);
    refs.push([old, ref]);
    if (fromSchematic) matched.push(ref);
    const ids = new Map<string, string>([[root!.uid, newUid('el')]]);
    for (const k of kids) ids.set(k.uid, newUid(k.type === 'pad' ? 'pad' : 'n'));
    const nodes = it.nodes.map((n) => {
      const c = structuredClone(n);
      c.uid = ids.get(n.uid)!;
      c.parent = n === root ? partsC : ids.get(n.parent!) ?? null;
      c.children = n.children.map((u) => ids.get(u)!).filter(Boolean);
      if (n === root) {
        c.name = ref!;
        c.props = { ...c.props };
        delete c.props.locked;
        const pos = vec(c.rules.find((r) => r.name === 'position')?.value);
        if (pos) c.rules = c.rules.map((r) => (r.name === 'position' ? { name: 'position', value: f(pos) } : r));
        if (opts.transform) {
          // A turned copy: the part turns with it.
          const r0 = Number(c.rules.find((r) => r.name === 'rotation')?.value ?? 0);
          const o = f({ x: 0, y: 0 });
          const e = f({ x: 1, y: 0 });
          const turn = (Math.atan2(-(e.y - o.y), e.x - o.x) * 180) / Math.PI;
          c.rules = c.rules.map((r) => (r.name === 'rotation' ? { name: 'rotation', value: Math.round(((((r0 + turn) % 360) + 360) % 360) * 1e3) / 1e3 } : r));
        }
      } else if (c.type === 'pad') {
        const oldNet = typeof n.props.net === 'string' ? n.props.net : '';
        const newNet = fromSchematic ? nl.byPin.get(`${ref}.${String(n.props.number ?? n.name)}`) ?? '' : '';
        if (oldNet && !netMap.has(oldNet)) netMap.set(oldNet, newNet);
        c.props = { ...c.props, net: newNet };
        if (!newNet) delete c.props.net;
      }
      return c;
    });
    ops.push({ op: 'add', parent: partsC, index: 0, tree: { nodes } });
    uids.push(nodes[0]!.uid);
  }
  // Then copper and graphics, shifted.
  let skipped = 0;
  for (const it of clip.items.filter((i) => i.place !== 'part')) {
    const [root] = it.nodes;
    let parent: string;
    if (it.place === 'net') {
      const net = netMap.has(it.net!) ? netMap.get(it.net!)! : it.net!;
      if (!net) {
        skipped++;
        continue;
      }
      parent = netNodeUid(doc, net, ops, made);
    } else parent = container(doc, it.place === 'zones' ? 'Keep-out zones' : 'Board', ops);
    const c = structuredClone(root!);
    c.uid = newUid(root!.type.slice(0, 2));
    c.parent = parent;
    c.children = [];
    delete c.props.locked;
    // The copy's own point rules move (the copy may come from another board, so read them from the copy).
    for (const r of c.rules) {
      if (!POINT_RULES.has(r.name)) continue;
      if (Array.isArray(r.value)) r.value = (r.value as Vec2[]).map(f);
      else if (vec(r.value)) r.value = f(r.value as Vec2);
    }
    if (c.type === 'fill' && c.data?.fills) c.data = { ...c.data, fills: mapFills(c.data.fills, f) };
    ops.push({ op: 'add', parent, index: 0, tree: { nodes: [c] } });
    uids.push(c.uid);
  }
  return { ops, uids, refs, matched, skipped };
}

// ---------- layout replication ----------

/** The schematic block of each part: the group box it lies in, else its sheet. */
export function partBlocks(doc: Doc, engine: StyleEngine): Map<string, string> {
  const out = new Map<string, string>();
  const boxes = [...doc.nodes.values()].filter((n) => n.type === 'groupBox');
  const sheetOf = (n: DocNode) => {
    for (let p: DocNode | undefined = n; p; p = p.parent ? doc.nodes.get(p.parent) : undefined) if (p.type === 'sheet') return p;
    return undefined;
  };
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const ref = String(n.props.ref ?? n.name);
    if (out.has(ref)) continue;
    const at = vec(engine.get(n.uid, 'position')?.value);
    const sh = sheetOf(n);
    const gb = at && boxes.find((b) => {
      if (b.parent !== sh?.uid) return false;
      const r = vec(engine.get(b.uid, 'position')?.value);
      const z = vec(engine.get(b.uid, 'size')?.value);
      return !!r && !!z && at.x >= r.x && at.x <= r.x + z.x && at.y >= r.y && at.y <= r.y + z.y;
    });
    out.set(ref, gb ? `${gb.name || 'group'}#${gb.uid}` : sh ? `sheet ${sh.name}#${sh.uid}` : 'board');
  }
  return out;
}

/** A part's place in its schematic block (its symbol's position less the block's corner). */
function schematicPlaces(doc: Doc, engine: StyleEngine, refs: string[]): Map<string, Vec2> {
  const at = new Map<string, Vec2>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const ref = String(n.props.ref ?? n.name);
    if (!refs.includes(ref) || at.has(ref)) continue;
    const p = vec(engine.get(n.uid, 'position')?.value);
    if (p) at.set(ref, p);
  }
  const xs = [...at.values()].map((p) => p.x);
  const ys = [...at.values()].map((p) => p.y);
  const o = { x: Math.min(...xs), y: Math.min(...ys) };
  for (const [k, p] of at) at.set(k, { x: p.x - o.x, y: p.y - o.y });
  return at;
}

export interface ReplicateResult {
  ops: Op[];
  pairs: [string, string][];
  traces: number;
  error?: string;
}

/**
 * Lay out `target` parts like `source` parts: pairs by footprint, value and place in the schematic block;
 * the target's first part keeps its place and the others take the source's arrangement around it; the
 * source's copper between its own parts (nets of its pads) is copied onto the target's nets, replacing what
 * the target had on those nets.
 */
export function replicateLayoutOps(doc: Doc, engine: StyleEngine, copper: string[], source: string[], target: string[]): ReplicateResult {
  const fail = (error: string): ReplicateResult => ({ ops: [], pairs: [], traces: 0, error });
  const el = new Map([...doc.nodes.values()].filter((n) => n.type === 'element').map((n) => [n.name, n] as const));
  const missing = [...source, ...target].filter((r) => !el.has(r));
  if (missing.length) return fail(`not on the board: ${missing.join(', ')}`);
  if (source.length !== target.length) return fail(`the blocks differ in size (${source.length} and ${target.length} parts)`);
  const key = (r: string) => `${el.get(r)!.props.Footprint ?? ''}|${el.get(r)!.props.Value ?? ''}`;
  const sp = schematicPlaces(doc, engine, source);
  const tp = schematicPlaces(doc, engine, target);
  const pairs: [string, string][] = [];
  const left = new Set(target);
  for (const s of source) {
    const cands = [...left].filter((t) => key(t) === key(s));
    if (!cands.length) return fail(`no part like ${s} (${key(s).replace('|', ', ')}) in the target`);
    const a = sp.get(s) ?? { x: 0, y: 0 };
    cands.sort((x, y) => {
      const p = tp.get(x) ?? { x: 0, y: 0 };
      const q = tp.get(y) ?? { x: 0, y: 0 };
      return Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y);
    });
    pairs.push([s, cands[0]!]);
    left.delete(cands[0]!);
  }
  const pos = (r: string) => vec(engine.get(el.get(r)!.uid, 'position')?.value) ?? { x: 0, y: 0 };
  const rot = (r: string) => Number(engine.get(el.get(r)!.uid, 'rotation')?.value ?? 0);
  // The target's first part stays: everything else is the source shifted by the same amount.
  const [s0, t0] = pairs[0]!;
  const d = { x: pos(t0).x - pos(s0).x, y: pos(t0).y - pos(s0).y };
  const f = (p: Vec2) => ({ x: Math.round((p.x + d.x) * 1e4) / 1e4, y: Math.round((p.y + d.y) * 1e4) / 1e4 });
  const ops: Op[] = [];
  for (const [s, t] of pairs) {
    const tu = el.get(t)!.uid;
    ops.push({ op: 'setRule', uid: tu, name: 'position', decl: { name: 'position', value: f(pos(s)) } }, { op: 'setRule', uid: tu, name: 'rotation', decl: { name: 'rotation', value: rot(s) } });
  }
  // Nets: a source pad's net → the paired target pad's net.
  const netMap = new Map<string, string>();
  const padNets = (r: string) => new Map(el.get(r)!.children.map((c) => doc.nodes.get(c)!).filter((n) => n.type === 'pad').map((n) => [String(n.props.number ?? n.name), typeof n.props.net === 'string' ? n.props.net : ''] as const));
  for (const [s, t] of pairs) {
    const a = padNets(s);
    const b = padNets(t);
    for (const [num, net] of a) if (net && b.get(num) && !netMap.has(net)) netMap.set(net, b.get(num)!);
  }
  // Source copper on nets whose pads are all in the source block (or, for shared nets such as ground, lying
  // within the block's area), copied; the target's copper on the mapped nets replaced.
  const srcSet = new Set(source);
  const netPads = new Map<string, string[]>();
  for (const n of doc.nodes.values()) if (n.type === 'pad' && typeof n.props.net === 'string' && n.props.net) (netPads.get(n.props.net) ?? netPads.set(n.props.net, []).get(n.props.net)!).push(doc.nodes.get(n.parent!)!.name);
  const internal = (net: string) => (netPads.get(net) ?? []).every((r) => srcSet.has(r));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of source)
    for (const c of el.get(s)!.children) {
      const g = doc.nodes.get(c)?.type === 'pad' ? padGeom(doc, engine, doc.nodes.get(c)!, copper) : null;
      if (g) (x0 = Math.min(x0, g.center.x)), (y0 = Math.min(y0, g.center.y)), (x1 = Math.max(x1, g.center.x)), (y1 = Math.max(y1, g.center.y));
    }
  const inBlock = (p: Vec2) => p.x >= x0 - 1 && p.x <= x1 + 1 && p.y >= y0 - 1 && p.y <= y1 + 1;
  const copy: DocNode[] = [];
  const replaced = new Set<string>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' && n.type !== 'via') continue;
    const net = doc.nodes.get(n.parent!)?.name ?? '';
    if (!netMap.has(net)) continue;
    const pts = Object.values(movablePoints(engine, n)).flatMap((v) => (Array.isArray(v) ? v : [v]));
    if (internal(net) || pts.every(inBlock)) copy.push(n);
  }
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' && n.type !== 'via') continue;
    const net = doc.nodes.get(n.parent!)?.name ?? '';
    const tgtNets = new Set([...netMap.entries()].filter(([s]) => internal(s)).map(([, t]) => t));
    if (tgtNets.has(net) && !copy.includes(n)) replaced.add(n.uid);
  }
  for (const u of replaced) ops.push({ op: 'remove', uid: u });
  const made = new Map<string, string>();
  for (const n of copy) {
    const net = netMap.get(doc.nodes.get(n.parent!)!.name)!;
    const parent = netNodeUid(doc, net, ops, made);
    const c = structuredClone(n);
    c.uid = newUid(n.type === 'via' ? 'via' : 'tr');
    c.parent = parent;
    c.children = [];
    for (const [k, v] of Object.entries(movablePoints(engine, n))) {
      const own = c.rules.find((r) => r.name === k);
      if (own) own.value = Array.isArray(v) ? v.map(f) : f(v);
      else c.rules.push({ name: k, value: Array.isArray(v) ? v.map(f) : f(v) });
    }
    ops.push({ op: 'add', parent, index: 0, tree: { nodes: [c] } });
  }
  return { ops, pairs, traces: copy.length };
}

/** Other blocks made of the same parts as `source` (footprint and value), for replication. */
export function matchingBlocks(doc: Doc, engine: StyleEngine, source: string[]): { block: string; refs: string[] }[] {
  const blocks = partBlocks(doc, engine);
  const el = new Map([...doc.nodes.values()].filter((n) => n.type === 'element').map((n) => [n.name, n] as const));
  const key = (r: string) => `${el.get(r)?.props.Footprint ?? ''}|${el.get(r)?.props.Value ?? ''}`;
  const want = source.map(key).sort().join('\n');
  const by = new Map<string, string[]>();
  for (const [ref, b] of blocks) if (el.has(ref) && !source.includes(ref)) (by.get(b) ?? by.set(b, []).get(b)!).push(ref);
  return [...by.entries()].filter(([, refs]) => refs.map(key).sort().join('\n') === want).map(([block, refs]) => ({ block: block.split('#')[0]!, refs }));
}
