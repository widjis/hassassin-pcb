/**
 * KiCad board export (docs/05-pcb-improvements.md, P15): the board as a `.kicad_pcb` file (format
 * 20241229, read by KiCad 9 and 10) plus a `.kicad_pro` with the design rules and net classes, so that
 * KiCad's DRC checks the board against the same numbers as ours.
 *
 * Written from KiCad's public file format documentation and example files; no KiCad code is used.
 *
 * - Parts become footprints with their pads, graphics and texts in the part's own frame (as the importer
 *   reads them); pad and text angles are written as KiCad stores them, the part's angle included.
 * - Traces, arcs and vias are written as they are; vias span from their first to their last copper layer.
 * - Pours become zones with their outline and settings and with our fill as the zone's filled polygons, so
 *   the board opens filled as it is here. KiCad keeps the holes of a filled polygon joined to its outline
 *   by zero-width cuts, so each hole is joined to the outline that way ("fractured").
 * - Keep-out areas become rule areas; teardrops become teardrop zones of their net.
 * - The project file carries one net class per set of rules (clearance, trace width, via) with the nets
 *   that use it, and the board's minimum values (trace width, annular ring, hole to hole, edge clearance).
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { uuidFor } from './kicadNetlist.ts';
import { kicadFootprintFor } from './footprints.ts';
import { boardOutline, clearanceFor, collectCopper, netNameOf, type PolyWithHoles } from './copper.ts';
import { elementOf } from './frames.ts';
import { isTeardrop } from './teardrops.ts';
import { pointInPolygon } from './geom.ts';

export interface KicadPcbOptions {
  /** Project name, used for the file names (default "board"). */
  project?: string;
  /** Every layer of the board, as the project lists them (copper and the others). */
  layers?: string[];
}

export interface KicadPcbResult {
  /** The board file, then the project file. */
  files: { name: string; text: string }[];
  board: string;
  stats: { footprints: number; pads: number; traces: number; vias: number; zones: number; keepouts: number; teardrops: number; graphics: number; texts: number; nets: number; netClasses: number };
  warnings: string[];
}

/** Format version written in the file: KiCad 9.0's, which KiCad 10 also reads. */
export const KICAD_PCB_VERSION = 20241229;

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const n = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) || r === 0 ? '0' : String(r);
};
const xy = (p: Vec2) => `${n(p.x)} ${n(p.y)}`;
const angle = (a: number) => {
  const r = Math.round(((((a % 360) + 360) % 360)) * 1e6) / 1e6;
  return r === 360 ? 0 : r;
};
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v && 'y' in v ? (v as Vec2) : undefined);

/** KiCad 9 layer ids: copper even (F.Cu 0, B.Cu 2, In1.Cu 4 …), the other layers odd. */
const TECH: [string, number, string?][] = [
  ['F.Adhes', 9, 'F.Adhesive'], ['B.Adhes', 11, 'B.Adhesive'], ['F.Paste', 13], ['B.Paste', 15],
  ['F.SilkS', 5, 'F.Silkscreen'], ['B.SilkS', 7, 'B.Silkscreen'], ['F.Mask', 1], ['B.Mask', 3],
  ['Dwgs.User', 17, 'User.Drawings'], ['Cmts.User', 19, 'User.Comments'], ['Eco1.User', 21, 'User.Eco1'], ['Eco2.User', 23, 'User.Eco2'],
  ['Edge.Cuts', 25], ['Margin', 27], ['F.CrtYd', 31, 'F.Courtyard'], ['B.CrtYd', 29, 'B.Courtyard'], ['F.Fab', 35], ['B.Fab', 33],
];

const isCopper = (l: string) => /^(F|B|In\d+)\.Cu$/.test(l);
const copperOrder = (l: string) => (l === 'F.Cu' ? 0 : l === 'B.Cu' ? 1e6 : Number(/^In(\d+)\.Cu$/.exec(l)?.[1] ?? 1e5));

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const s = p[i]!;
    const t = p[(i + 1) % p.length]!;
    a += s.x * t.y - t.x * s.y;
  }
  return a / 2;
}

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const onSeg = (p: Vec2, a: Vec2, b: Vec2) => Math.min(a.x, b.x) - 1e-12 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-12 && Math.min(a.y, b.y) - 1e-12 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-12;
/** Whether segments ab and cd share a point (touching included). */
function meets(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSeg(a, c, d)) || (d2 === 0 && onSeg(b, c, d)) || (d3 === 0 && onSeg(c, a, b)) || (d4 === 0 && onSeg(d, a, b));
}

/**
 * One ring for a polygon with holes: each hole joined to the outline by a zero-width cut from one of its
 * corners to a corner of the outline it can see, as KiCad stores filled zone areas. Holes that cannot be
 * joined (not expected for valid polygons) are counted in `dropped`.
 */
export function fracturePolygon(poly: PolyWithHoles): { ring: Vec2[]; dropped: number } {
  let ring = [...poly[0]!];
  const outerSign = Math.sign(signedArea(ring));
  const holes = poly.slice(1).filter((h) => h.length >= 3).map((h) => (Math.sign(signedArea(h)) === outerSign ? [...h].reverse() : [...h]));
  // Rightmost holes first: their cuts stay short and out of the way of the others.
  holes.sort((a, b) => Math.max(...b.map((p) => p.x)) - Math.max(...a.map((p) => p.x)));
  let dropped = 0;
  const visible = (m: Vec2, v: Vec2, rest: Vec2[][]): boolean => {
    const mid = { x: (m.x + v.x) / 2, y: (m.y + v.y) / 2 };
    const blocks = (loop: Vec2[]) => {
      for (let i = 0; i < loop.length; i++) {
        const c = loop[i]!;
        const d = loop[(i + 1) % loop.length]!;
        if (same(c, v) || same(d, v) || same(c, m) || same(d, m)) continue;
        if (meets(m, v, c, d)) return true;
      }
      return false;
    };
    if (blocks(ring)) return false;
    for (const h of rest) if (blocks(h)) return false;
    return pointInPolygon(mid, ring) && !rest.some((h) => pointInPolygon(mid, h));
  };
  /** Join one hole to the ring if one of its corners sees a ring corner; `rest` = holes not yet joined. */
  const join = (hole: Vec2[], rest: Vec2[][], wide: boolean): boolean => {
    // The hole's rightmost corners first, each with the nearest ring corners first.
    const ms = hole.map((_, i) => i).sort((a, b) => hole[b]!.x - hole[a]!.x).slice(0, wide ? hole.length : 6);
    for (const mi of ms) {
      const m = hole[mi]!;
      const vs = ring.map((_, i) => i).sort((a, b) => (ring[a]!.x - m.x) ** 2 + (ring[a]!.y - m.y) ** 2 - ((ring[b]!.x - m.x) ** 2 + (ring[b]!.y - m.y) ** 2));
      for (const vi of vs.slice(0, wide ? vs.length : 48)) {
        if (!visible(m, ring[vi]!, rest)) continue;
        const loop = [...hole.slice(mi), ...hole.slice(0, mi), m];
        ring = [...ring.slice(0, vi + 1), ...loop, ring[vi]!, ...ring.slice(vi + 1)];
        return true;
      }
    }
    return false;
  };
  // Passes over the holes left: a hole hidden behind others gets its turn once they are joined; a last pass
  // tries every pair of corners.
  let left = holes;
  for (let wide = false; left.length; ) {
    const next: Vec2[][] = [];
    for (let k = 0; k < left.length; k++) if (!join(left[k]!, [...next, ...left.slice(k)], wide)) next.push(left[k]!);
    if (next.length === left.length) {
      if (wide) {
        dropped = next.length;
        break;
      }
      wide = true;
    }
    left = next;
  }
  return { ring, dropped };
}

const pts = (ps: Vec2[]) => `(pts ${ps.map((p) => `(xy ${xy(p)})`).join(' ')})`;

export function kicadPcb(doc: Doc, engine: StyleEngine, opts: KicadPcbOptions = {}): KicadPcbResult {
  const project = (opts.project ?? 'board').replace(/[^\w.-]+/g, '_') || 'board';
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (m: string) => warned.has(m) || (warned.add(m), warnings.push(m));
  const stats: KicadPcbResult['stats'] = { footprints: 0, pads: 0, traces: 0, vias: 0, zones: 0, keepouts: 0, teardrops: 0, graphics: 0, texts: 0, nets: 0, netClasses: 0 };
  const get = (uid: string, name: string) => engine.get(uid, name)?.value;
  const numOf = (uid: string, name: string, fallback: number) => {
    const v = Number(get(uid, name));
    return Number.isFinite(v) ? v : fallback;
  };

  // Layers: the project's copper in stack order, then KiCad's other layers.
  const metaLayers = Array.isArray(doc.meta.layers) ? (doc.meta.layers as { name: string }[]).map((l) => l.name) : [];
  const given = opts.layers ?? metaLayers;
  const copper = [...new Set(given.filter(isCopper).concat(['F.Cu', 'B.Cu']))].sort((a, b) => copperOrder(a) - copperOrder(b));
  const layerIds = new Map<string, number>();
  const layerLines: string[] = [];
  for (const c of copper) {
    const id = c === 'F.Cu' ? 0 : c === 'B.Cu' ? 2 : 2 + 2 * Number(/^In(\d+)/.exec(c)![1]);
    layerIds.set(c, id);
    layerLines.push(`(${id} ${q(c)} signal)`);
  }
  for (const [name, id, user] of TECH) (layerIds.set(name, id), layerLines.push(`(${id} ${q(name)} user${user ? ` ${q(user)}` : ''})`));
  const users = [...new Set(given.filter((l) => /^User\.\d+$/.test(l)))].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const u of users) (layerIds.set(u, 39 + 2 * (Number(u.slice(5)) - 1)), layerLines.push(`(${layerIds.get(u)} ${q(u)} user)`));
  const known = (l: string, what: string) => {
    if (layerIds.has(l)) return true;
    warn(`Left out ${what} on layer ${l}, which KiCad does not have.`);
    return false;
  };
  const expand = (raw: unknown): string[] => (Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : []).flatMap((l) => (l === '*' || l === '*.Cu' ? copper : [l]));

  // Nets: numbered from 1 (0 is "no net"), in document order, pads' nets included.
  const netIds = new Map<string, number>();
  const addNet = (name: string | null | undefined) => {
    if (name && name !== '(no net)' && !netIds.has(name)) netIds.set(name, netIds.size + 1);
  };
  for (const node of doc.nodes.values()) {
    if (node.type === 'net') addNet(node.name);
    else if (node.type === 'pad' && typeof node.props.net === 'string') addNet(node.props.net);
  }
  stats.nets = netIds.size;
  const netRef = (name: string | null) => (name && netIds.has(name) ? ` (net ${netIds.get(name)})` : '');

  const out: string[] = [];
  const layout = [...doc.nodes.values()].find((x) => x.type === 'layout');
  const thickness = Number(layout?.props.Thickness ?? 1.6) || 1.6;
  out.push(`(kicad_pcb (version ${KICAD_PCB_VERSION}) (generator "hassassin_pcb") (generator_version "0.3")`);
  out.push(`  (general (thickness ${n(thickness)}) (legacy_teardrops no))`);
  out.push('  (paper "A4")');
  if (layout?.name) out.push(`  (title_block (title ${q(layout.name)}))`);
  out.push(`  (layers ${layerLines.join(' ')})`);
  out.push('  (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no))');
  out.push(`  (net 0 "")`);
  for (const [name, id] of netIds) out.push(`  (net ${id} ${q(name)})`);

  const stroke = (uid: string, fallback: number) => `(stroke (width ${n(numOf(uid, 'strokeWidth', fallback))}) (type solid))`;

  /** A graphic (line, arc, circle, polygon, rectangle) in `fp` (part frame) or `gr` (board) form. */
  const graphic = (g: DocNode, kind: 'fp' | 'gr'): string | null => {
    const layer = String(get(g.uid, 'layer') ?? '');
    if (!layer || !known(layer, `a ${g.type}`)) return null;
    const tail = `(layer ${q(layer)}) (uuid ${q(uuidFor(g.uid))})`;
    const filled = get(g.uid, 'filled') === true;
    const fill = filled ? ' (fill yes)' : ' (fill no)';
    const P = (k: string) => vec(get(g.uid, k));
    switch (g.type) {
      case 'line': {
        const a = P('start');
        const b = P('end');
        return a && b ? `(${kind}_line (start ${xy(a)}) (end ${xy(b)}) ${stroke(g.uid, 0.12)} ${tail})` : null;
      }
      case 'arc': {
        const a = P('start');
        const m = P('mid');
        const b = P('end');
        return a && m && b ? `(${kind}_arc (start ${xy(a)}) (mid ${xy(m)}) (end ${xy(b)}) ${stroke(g.uid, 0.12)} ${tail})` : null;
      }
      case 'circle': {
        const c = P('center');
        const r = numOf(g.uid, 'radius', 0);
        return c && r > 0 ? `(${kind}_circle (center ${xy(c)}) (end ${xy({ x: c.x + r, y: c.y })}) ${stroke(g.uid, 0.12)}${fill} ${tail})` : null;
      }
      case 'rectangle':
      case 'polygon': {
        const ps = (get(g.uid, 'points') as Vec2[] | undefined) ?? [];
        if (ps.length < 2) return null;
        if (g.type === 'rectangle' && ps.length === 4) {
          const xs = new Set(ps.map((p) => n(p.x)));
          const ys = new Set(ps.map((p) => n(p.y)));
          if (xs.size === 2 && ys.size === 2) {
            const minX = Math.min(...ps.map((p) => p.x));
            const minY = Math.min(...ps.map((p) => p.y));
            const maxX = Math.max(...ps.map((p) => p.x));
            const maxY = Math.max(...ps.map((p) => p.y));
            return `(${kind}_rect (start ${n(minX)} ${n(minY)}) (end ${n(maxX)} ${n(maxY)}) ${stroke(g.uid, 0.12)}${fill} ${tail})`;
          }
        }
        if (ps.length === 2) return `(${kind}_line (start ${xy(ps[0]!)}) (end ${xy(ps[1]!)}) ${stroke(g.uid, 0.12)} ${tail})`;
        return `(${kind}_poly ${pts(ps)} ${stroke(g.uid, 0.12)}${fill} ${tail})`;
      }
    }
    return null;
  };

  /** Text effects: size, stroke width, alignment; texts on the bottom read mirrored. */
  const effects = (t: DocNode, layer: string) => {
    const size = numOf(t.uid, 'fontSize', 1) || 1;
    const width = numOf(t.uid, 'strokeWidth', 0) || size * 0.15;
    const j = String(get(t.uid, 'justify') ?? 'center');
    const just = [j === 'left' || j === 'right' ? j : '', layer.startsWith('B.') ? 'mirror' : ''].filter(Boolean);
    return `(effects (font (size ${n(size)} ${n(size)}) (thickness ${n(width)}))${just.length ? ` (justify ${just.join(' ')})` : ''})`;
  };

  // Footprints.
  for (const el of doc.nodes.values()) {
    if (el.type !== 'element') continue;
    const at = vec(get(el.uid, 'position'));
    if (!at) continue;
    stats.footprints++;
    const rot = numOf(el.uid, 'rotation', 0);
    const bottom = String(get(el.uid, 'side') ?? 'top') === 'bottom';
    const fpName = String(el.props.Footprint ?? '');
    const prefix = /^[A-Za-z]+/.exec(el.name)?.[0] ?? '';
    const lib = fpName.includes(':') ? fpName : (fpName && kicadFootprintFor(fpName, prefix)) || fpName || `Hassassin:${el.name || 'part'}`;
    const lines: string[] = [];
    lines.push(`  (footprint ${q(lib)} (layer ${bottom ? '"B.Cu"' : '"F.Cu"'}) (uuid ${q(uuidFor(el.uid))}) (at ${xy(at)}${angle(rot) ? ` ${n(angle(rot))}` : ''})${el.props.locked ? ' (locked yes)' : ''}`);
    if (typeof el.props.Description === 'string' && el.props.Description) lines.push(`    (descr ${q(el.props.Description)})`);
    const fab = bottom ? 'B.Fab' : 'F.Fab';
    let refDone = false;
    const body: string[] = [];
    let through = false;
    let anyPad = false;
    const walk = (parent: DocNode) => {
      for (const c of parent.children) {
        const k = doc.nodes.get(c);
        if (!k) continue;
        if (k.type === 'pad') {
          anyPad = true;
          const s = pad(k, rot);
          if (s) body.push(`    ${s}`);
          if (['through', 'npth'].includes(String(get(k.uid, 'padType') ?? 'smd'))) through = true;
        } else if (k.type === 'text') {
          const text = String(get(k.uid, 'text') ?? k.name ?? '');
          const layer = String(get(k.uid, 'layer') ?? (bottom ? 'B.SilkS' : 'F.SilkS'));
          const p = vec(get(k.uid, 'position'));
          if (!p || !text || !known(layer, 'a text')) continue;
          stats.texts++;
          const a = angle(numOf(k.uid, 'rotation', 0) + rot);
          const hide = get(k.uid, 'visible') === false ? ' (hide yes)' : '';
          const tail = `(at ${xy(p)} ${n(a)}) (layer ${q(layer)})${hide} (uuid ${q(uuidFor(k.uid))}) ${effects(k, layer)}`;
          if (!refDone && text === el.name) {
            refDone = true;
            lines.push(`    (property "Reference" ${q(text)} ${tail})`);
          } else body.push(`    (fp_text user ${q(text)} ${tail})`);
        } else if (['line', 'arc', 'circle', 'polygon', 'rectangle'].includes(k.type)) {
          const s = graphic(k, 'fp');
          if (s) (body.push(`    ${s}`), stats.graphics++);
        }
        walk(k);
      }
    };
    walk(el);
    if (!refDone) lines.push(`    (property "Reference" ${q(el.name)} (at 0 0 ${n(angle(rot))}) (layer ${q(fab)}) (hide yes) (uuid ${q(uuidFor(`${el.uid}#ref`))}) (effects (font (size 1 1) (thickness 0.15))${bottom ? ' (justify mirror)' : ''}))`);
    let i = 0;
    for (const [k, v] of Object.entries(el.props)) {
      if (['Footprint', 'Description', 'locked', 'ref', 'partId', 'number'].includes(k) || typeof v !== 'string' && typeof v !== 'number') continue;
      if (!/^[\w .-]+$/.test(k) || k === 'Reference') continue;
      lines.push(`    (property ${q(k)} ${q(String(v))} (at 0 0 ${n(angle(rot))}) (layer ${q(fab)}) (hide yes) (uuid ${q(uuidFor(`${el.uid}#${i++}`))}) (effects (font (size 1 1) (thickness 0.15))${bottom ? ' (justify mirror)' : ''}))`);
    }
    if (anyPad) lines.push(`    (attr ${through ? 'through_hole' : 'smd'})`);
    out.push(...lines, ...body, '  )');
  }

  function pad(k: DocNode, rot: number): string | null {
    const p = vec(get(k.uid, 'position'));
    if (!p) return null;
    stats.pads++;
    const type = String(get(k.uid, 'padType') ?? 'smd');
    const kType = ({ through: 'thru_hole', npth: 'np_thru_hole', edge: 'connect', smd: 'smd' } as Record<string, string>)[type] ?? 'smd';
    let shape = String(get(k.uid, 'padShape') ?? 'rect');
    if (!['circle', 'rect', 'roundrect', 'oval', 'custom'].includes(shape)) {
      warn(`Pads of shape ${shape} were written as rectangles.`);
      shape = 'rect';
    }
    const sv = get(k.uid, 'size');
    const size = typeof sv === 'number' ? { x: sv, y: sv } : (vec(sv) ?? { x: 1, y: 1 });
    const a = angle(numOf(k.uid, 'rotation', 0) + rot);
    const parts = [`(pad ${q(String(k.props.number ?? k.name ?? ''))} ${kType} ${shape} (at ${xy(p)}${a ? ` ${n(a)}` : ''}) (size ${xy(size)})`];
    const hv = get(k.uid, 'holeSize');
    const hole = typeof hv === 'number' ? { x: hv, y: hv } : vec(hv);
    if (hole && (type === 'through' || type === 'npth')) parts.push(Math.abs(hole.x - hole.y) < 1e-9 ? `(drill ${n(hole.x)})` : `(drill oval ${n(hole.x)} ${n(hole.y)})`);
    let layers = expand(get(k.uid, 'layers'));
    if (copper.every((c) => layers.includes(c)) && copper.length > 1) layers = ['*.Cu', ...layers.filter((l) => !isCopper(l))];
    if (type === 'npth' && !layers.length) layers = ['*.Cu', '*.Mask'];
    parts.push(`(layers ${layers.map(q).join(' ')})`);
    if (shape === 'roundrect') parts.push(`(roundrect_rratio ${n(numOf(k.uid, 'cornerRatio', 0.25))})`);
    if (shape === 'custom') {
      const ps = (get(k.uid, 'points') as Vec2[] | undefined) ?? [];
      parts.push('(options (clearance outline) (anchor rect))');
      if (ps.length >= 3) parts.push(`(primitives (gr_poly ${pts(ps)} (width 0) (fill yes)))`);
    }
    const net = typeof k.props.net === 'string' && type !== 'npth' ? k.props.net : null;
    if (net && netIds.has(net)) parts.push(`(net ${netIds.get(net)} ${q(net)})`);
    parts.push(`(uuid ${q(uuidFor(k.uid))})`);
    return parts.join(' ') + ')';
  }

  // Board graphics and texts (not in a part, not a teardrop).
  for (const g of doc.nodes.values()) {
    if (!['line', 'arc', 'circle', 'polygon', 'rectangle', 'text'].includes(g.type) || elementOf(doc, g) || isTeardrop(g)) continue;
    const parent = g.parent ? doc.nodes.get(g.parent) : undefined;
    if (parent?.type === 'net') continue;
    if (g.type === 'text') {
      const layer = String(get(g.uid, 'layer') ?? '');
      const p = vec(get(g.uid, 'position'));
      const text = String(get(g.uid, 'text') ?? g.name ?? '');
      if (!p || !text || !layer || !known(layer, 'a text') || get(g.uid, 'visible') === false) continue;
      stats.texts++;
      out.push(`  (gr_text ${q(text)} (at ${xy(p)} ${n(angle(numOf(g.uid, 'rotation', 0)))}) (layer ${q(layer)}) (uuid ${q(uuidFor(g.uid))}) ${effects(g, layer)})`);
      continue;
    }
    const s = graphic(g, 'gr');
    if (s) (out.push(`  ${s}`), stats.graphics++);
  }

  // Traces, arcs and vias.
  for (const t of doc.nodes.values()) {
    if (t.type === 'trace') {
      const a = vec(get(t.uid, 'start'));
      const b = vec(get(t.uid, 'end'));
      const layer = String(get(t.uid, 'layer') ?? 'F.Cu');
      if (!a || !b || !known(layer, 'a trace')) continue;
      stats.traces++;
      const m = vec(get(t.uid, 'mid'));
      const w = numOf(t.uid, 'traceWidth', 0.25);
      const lock = t.props.locked ? ' (locked yes)' : '';
      out.push(`  (${m ? 'arc' : 'segment'} (start ${xy(a)})${m ? ` (mid ${xy(m)})` : ''} (end ${xy(b)}) (width ${n(w)}) (layer ${q(layer)})${lock}${netRef(netNameOf(doc, t))} (uuid ${q(uuidFor(t.uid))}))`);
    } else if (t.type === 'via') {
      const p = vec(get(t.uid, 'position'));
      if (!p) continue;
      stats.vias++;
      const ls = expand(get(t.uid, 'layers')).filter((l) => copper.includes(l)).sort((x, y) => copperOrder(x) - copperOrder(y));
      const span = ls.length >= 2 ? [ls[0]!, ls[ls.length - 1]!] : ['F.Cu', 'B.Cu'];
      const kind = String(get(t.uid, 'viaKind') ?? 'through');
      const k = kind === 'blind' || kind === 'micro' ? ` ${kind}` : '';
      const lock = t.props.locked ? ' (locked yes)' : '';
      out.push(`  (via${k} (at ${xy(p)}) (size ${n(numOf(t.uid, 'viaDiameter', 0.6))}) (drill ${n(numOf(t.uid, 'viaHole', 0.3))}) (layers ${span.map(q).join(' ')})${lock}${netRef(netNameOf(doc, t))} (uuid ${q(uuidFor(t.uid))}))`);
    }
  }

  // Pours, keep-out areas and teardrops.
  const outline = boardOutline(doc, engine).loops[0];
  let dropped = 0;
  const filledPolys = (fills: Record<string, PolyWithHoles[]>, layers: string[]) => {
    const parts: string[] = [];
    for (const layer of layers) {
      for (const poly of fills[layer] ?? []) {
        if (!poly[0] || poly[0].length < 3) continue;
        const f = fracturePolygon(poly);
        dropped += f.dropped;
        parts.push(`    (filled_polygon (layer ${q(layer)}) ${pts(f.ring)})`);
      }
    }
    return parts;
  };
  let topPriority = 0;
  for (const z of doc.nodes.values()) if (z.type === 'fill') topPriority = Math.max(topPriority, numOf(z.uid, 'pourPriority', 0));
  for (const z of doc.nodes.values()) {
    if (z.type !== 'fill' && z.type !== 'zone') continue;
    const layers = expand(get(z.uid, 'layers')).filter((l) => known(l, `a ${z.type === 'fill' ? 'pour' : 'keep-out'}`));
    if (!layers.length) continue;
    const own = (get(z.uid, 'points') as Vec2[] | undefined) ?? [];
    const ring = own.length >= 3 ? own : outline;
    if (!ring || ring.length < 3) {
      warn('Left out a pour without an outline on a board without a closed outline.');
      continue;
    }
    const layerExpr = layers.length === 1 ? `(layer ${q(layers[0]!)})` : `(layers ${layers.map(q).join(' ')})`;
    const name = z.name ? ` (name ${q(z.name)})` : '';
    if (z.type === 'zone') {
      stats.keepouts++;
      const raw = get(z.uid, 'keepoutOf');
      const forbid = new Set(Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? raw.split(/[\s,]+/) : ['traces', 'vias', 'pours']);
      const a = (k: string) => (forbid.has(k) ? 'not_allowed' : 'allowed');
      out.push(`  (zone (net 0) (net_name "") ${layerExpr} (uuid ${q(uuidFor(z.uid))})${name} (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks ${a('traces')}) (vias ${a('vias')}) (pads allowed) (copperpour ${a('pours')}) (footprints ${a('parts')})) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon ${pts(ring)}))`);
      continue;
    }
    stats.zones++;
    const net = netNameOf(doc, z);
    const keep = (get(z.uid, 'keepOut') as { all?: number; byType: Record<string, number> } | undefined) ?? { byType: {} };
    const clearance = clearanceFor(keep, 'pad');
    const relief = String(get(z.uid, 'thermalRelief') ?? 'spokes');
    const connect = relief === 'solid' ? 'yes ' : relief === 'none' ? 'no ' : '';
    const prio = numOf(z.uid, 'pourPriority', 0);
    const fills = ((z.data?.fills ?? {}) as Record<string, PolyWithHoles[]>);
    out.push(
      `  (zone${net && netIds.has(net) ? ` (net ${netIds.get(net)}) (net_name ${q(net)})` : ' (net 0) (net_name "")'} ${layerExpr} (uuid ${q(uuidFor(z.uid))})${name} (hatch edge 0.5)${prio ? ` (priority ${Math.max(0, Math.round(prio))})` : ''}`,
      `    (connect_pads ${connect}(clearance ${n(clearance)})) (min_thickness ${n(numOf(z.uid, 'traceWidthMin', 0.15))}) (filled_areas_thickness no)`,
      `    (fill yes (thermal_gap ${n(clearance)}) (thermal_bridge_width ${n(numOf(z.uid, 'thermalSpokeWidth', 0.3))}) (island_removal_mode 0))`,
      `    (polygon ${pts(ring)})`,
      ...filledPolys(fills, layers),
      '  )',
    );
  }
  // Teardrops that are part of the copper (their trace and pad / via still there).
  const live = new Set(collectCopper(doc, engine, copper).filter((s) => s.kind === 'trace' && s.areas.length).map((s) => s.uid));
  for (const t of doc.nodes.values()) {
    if (!isTeardrop(t) || !live.has(t.uid)) continue;
    const layer = String(get(t.uid, 'layer') ?? '');
    const ps = (get(t.uid, 'points') as Vec2[] | undefined) ?? [];
    const net = netNameOf(doc, t);
    if (!known(layer, 'a teardrop') || ps.length < 3 || !net || !netIds.has(net)) continue;
    stats.teardrops++;
    out.push(
      `  (zone (net ${netIds.get(net)}) (net_name ${q(net)}) (layer ${q(layer)}) (uuid ${q(uuidFor(t.uid))}) (name "$teardrop_padvia$") (hatch full 0.1) (priority ${Math.round(topPriority) + 30000})`,
      '    (attr (teardrop (type padvia))) (connect_pads yes (clearance 0)) (min_thickness 0.0254) (filled_areas_thickness no)',
      '    (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5) (island_removal_mode 1) (island_area_min 10))',
      `    (polygon ${pts(ps)})`,
      `    (filled_polygon (layer ${q(layer)}) ${pts(ps)})`,
      '  )',
    );
  }
  if (dropped) warn(`${dropped} hole${dropped === 1 ? '' : 's'} of the pours could not be joined to their outline and were left out; refill the zones in KiCad (B).`);
  out.push(')', '');

  const pro = projectFile(doc, engine, project, netIds, layout, copper);
  stats.netClasses = pro.classes;
  const board = `${project}.kicad_pcb`;
  return { files: [{ name: board, text: out.join('\n') }, { name: `${project}.kicad_pro`, text: pro.text }], board, stats, warnings };
}

/** The project file: design rules (board minimums) and one net class per set of net rules. */
function projectFile(doc: Doc, engine: StyleEngine, project: string, netIds: Map<string, number>, layout: DocNode | undefined, copper: string[]) {
  const num = (uid: string, name: string, fallback: number) => {
    const v = Number(engine.get(uid, name)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  interface Cls { name: string; clearance: number; track: number; viaD: number; viaH: number; nets: string[] }
  const classes = new Map<string, Cls>();
  for (const net of doc.nodes.values()) {
    if (net.type !== 'net' || !netIds.has(net.name)) continue;
    // The clearance of the net's traces (or of the net itself when it has none).
    const item = net.children.map((c) => doc.nodes.get(c)).find((c) => c?.type === 'trace' || c?.type === 'via') ?? net;
    const keep = (engine.get(item.uid, 'keepOut')?.value as { all?: number; byType: Record<string, number> } | undefined) ?? { byType: {} };
    const c: Omit<Cls, 'name' | 'nets'> = {
      clearance: clearanceFor(keep, 'trace'),
      track: num(net.uid, 'traceWidth', 0.25),
      viaD: num(net.uid, 'viaDiameter', 0.6),
      viaH: num(net.uid, 'viaHole', 0.3),
    };
    const key = [c.clearance, c.track, c.viaD, c.viaH].map((v) => v.toFixed(4)).join('/');
    const label = String(net.props.netClass ?? net.props.signal ?? '');
    const cur = classes.get(key) ?? { ...c, name: label, nets: [] };
    if (cur.name !== label) cur.name = '';
    cur.nets.push(net.name);
    classes.set(key, cur);
  }
  const list = [...classes.values()].sort((a, b) => b.nets.length - a.nets.length);
  const used = new Set<string>();
  list.forEach((c, i) => {
    let name = i === 0 ? 'Default' : c.name ? c.name[0]!.toUpperCase() + c.name.slice(1) : `Class ${i}`;
    while (used.has(name)) name += '_';
    used.add(name);
    c.name = name;
  });
  const dflt = list[0] ?? { clearance: 0.2, track: 0.25, viaD: 0.6, viaH: 0.3 };
  const cls = (c: { name?: string; clearance: number; track: number; viaD: number; viaH: number }, name: string, priority: number) => ({
    bus_width: 12, clearance: c.clearance, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: c.track,
    line_style: 0, microvia_diameter: 0.3, microvia_drill: 0.1, name, pcb_color: 'rgba(0, 0, 0, 0.000)', priority,
    schematic_color: 'rgba(0, 0, 0, 0.000)', track_width: c.track, via_diameter: c.viaD, via_drill: c.viaH, wire_width: 6,
  });
  const at = layout?.uid ?? doc.rootId;
  const allVia = [...doc.nodes.values()].filter((x) => x.type === 'via');
  const minVia = Math.min(...allVia.map((v) => num(v.uid, 'viaDiameter', 0.6)), ...list.map((c) => c.viaD), 0.6);
  const minDrill = Math.min(...allVia.map((v) => num(v.uid, 'viaHole', 0.3)), ...list.map((c) => c.viaH), num(at, 'holeSizeMin', 0.3));
  const pro = {
    board: {
      design_settings: {
        defaults: { board_outline_line_width: 0.05, copper_line_width: 0.2, silk_line_width: 0.12 },
        meta: { version: 2 },
        rules: {
          min_clearance: Math.min(...list.map((c) => c.clearance), dflt.clearance),
          min_copper_edge_clearance: num(at, 'boardEdgeClearance', 0.3),
          min_hole_to_hole: num(at, 'holeToHoleMin', 0.25),
          min_silk_clearance: num(at, 'silkClearance', 0),
          min_through_hole_diameter: minDrill,
          min_track_width: num(at, 'traceWidthMin', 0.15),
          min_via_annular_width: num(at, 'annularRingMin', 0.1),
          min_via_diameter: minVia,
        },
        // Checks that are errors in our DRC too (P12): holes too close or on top of each other.
        rule_severities: { hole_to_hole: 'error', holes_co_located: 'error', hole_clearance: 'error' },
      },
      layer_count: copper.length,
    },
    meta: { filename: `${project}.kicad_pro`, version: 3 },
    net_settings: {
      classes: list.map((c, i) => cls(c, c.name, i === 0 ? 2147483647 : i - 1)),
      meta: { version: 4 },
      netclass_patterns: list.slice(1).flatMap((c) => c.nets.map((pattern) => ({ netclass: c.name, pattern: pattern.replace(/([*?])/g, '?') }))),
    },
  };
  if (!list.length) pro.net_settings.classes = [cls(dflt, 'Default', 2147483647)];
  return { text: JSON.stringify(pro, null, 2) + '\n', classes: Math.max(1, list.length) };
}
