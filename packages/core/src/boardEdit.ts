/**
 * Board editing helpers (docs/05-pcb-improvements.md, P5): flipping a part to the other side, locking,
 * the layout grid, and aligning / spreading parts.
 */
import type { Op } from './commands.ts';
import type { AlignMode } from './arrange.ts';
import { componentExtent } from './autoplace.ts';
import type { Doc, DocNode, RuleDecl, RuleValue, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** F.* ↔ B.* (copper, silkscreen, mask, paste, courtyard, fabrication, adhesive). */
export function otherSide(layer: string): string {
  if (layer.startsWith('F.')) return `B.${layer.slice(2)}`;
  if (layer.startsWith('B.')) return `F.${layer.slice(2)}`;
  return layer;
}

const mirrorX = (p: Vec2): Vec2 => ({ x: p.x === 0 ? 0 : -p.x, y: p.y });
const negate = (a: number) => (a === 0 ? 0 : Math.round(((((-a) % 360) + 360) % 360) * 1e6) / 1e6);

/**
 * Flip a part to the other side of the board: its pads, graphics and texts are mirrored left to right about
 * the part's origin and moved to the other side's layers (F.Cu ↔ B.Cu, F.SilkS ↔ B.SilkS …), its
 * rotation turns the other way and its `side` changes. As KiCad does: viewed from the top, the part's
 * outline is mirrored where it stands.
 */
export function flipPartOps(doc: Doc, engine: StyleEngine, uid: string): Op[] {
  const el = doc.nodes.get(uid);
  if (el?.type !== 'element' || el.props.locked) return [];
  const ops: Op[] = [];
  const set = (n: DocNode, name: string, value: RuleValue) => ops.push({ op: 'setRule', uid: n.uid, name, decl: { name, value } as RuleDecl });
  const side = String(engine.get(uid, 'side')?.value ?? 'top');
  set(el, 'side', side === 'bottom' ? 'top' : 'bottom');
  set(el, 'rotation', negate(Number(engine.get(uid, 'rotation')?.value ?? 0)));
  const walk = (n: DocNode) => {
    for (const c of n.children) {
      const k = doc.nodes.get(c);
      if (!k) continue;
      for (const r of k.rules) {
        if (['position', 'start', 'end', 'mid', 'center'].includes(r.name) && vec(r.value)) set(k, r.name, mirrorX(r.value as Vec2));
        else if (r.name === 'points' && Array.isArray(r.value)) set(k, r.name, (r.value as Vec2[]).map(mirrorX));
        else if (r.name === 'rotation' && typeof r.value === 'number') set(k, r.name, negate(r.value));
        else if (r.name === 'layer' && typeof r.value === 'string' && otherSide(r.value) !== r.value) set(k, r.name, otherSide(r.value));
        else if (r.name === 'layers' && Array.isArray(r.value)) set(k, r.name, (r.value as string[]).map(otherSide));
      }
      walk(k);
    }
  };
  walk(el);
  return ops;
}

/** Lock or unlock board items (parts, traces, vias, pours, graphics): locked items are not moved by
 *  dragging, rotating, the autoplacer or a shove. */
export function lockOps(doc: Doc, uids: Iterable<string>, locked: boolean): Op[] {
  const ops: Op[] = [];
  for (const u of uids) {
    const n = doc.nodes.get(u);
    if (!n || !['element', 'trace', 'via', 'fill', 'zone', 'line', 'arc', 'circle', 'polygon', 'rectangle', 'text'].includes(n.type)) continue;
    if (!!n.props.locked === locked) continue;
    ops.push({ op: 'setProp', uid: u, key: 'locked', value: locked ? true : null });
  }
  return ops;
}

/** Grid steps offered for the layout (mm): metric and inch steps. */
export const LAYOUT_GRIDS: { label: string; mm: number }[] = [
  { label: '0.05 mm', mm: 0.05 },
  { label: '0.1 mm', mm: 0.1 },
  { label: '0.25 mm', mm: 0.25 },
  { label: '0.5 mm', mm: 0.5 },
  { label: '1 mm', mm: 1 },
  { label: '5 mil', mm: 0.127 },
  { label: '10 mil', mm: 0.254 },
  { label: '25 mil', mm: 0.635 },
  { label: '50 mil', mm: 1.27 },
  { label: '100 mil', mm: 2.54 },
];

/** The layout grid of the project (the root's `gridSpacing`, default 0.5 mm). */
export function layoutGrid(doc: Doc, engine: StyleEngine): number {
  const v = engine.get(doc.rootId, 'gridSpacing')?.value;
  return typeof v === 'number' && v > 0 ? v : 0.5;
}

export function setLayoutGridOp(doc: Doc, mm: number): Op {
  return { op: 'setRule', uid: doc.rootId, name: 'gridSpacing', decl: { name: 'gridSpacing', value: mm } };
}

/**
 * Where each part goes to align or spread a selection of parts by their outlines (pads and courtyard), as
 * the schematic's Align (S8): to the left / right / top / bottom edge, the centre line, or evenly spread.
 */
export function alignPartsMoves(doc: Doc, engine: StyleEngine, copper: string[], uids: string[], mode: AlignMode): { uid: string; to: Vec2 }[] {
  const parts = uids.map((u) => doc.nodes.get(u)).filter((n): n is DocNode => n?.type === 'element' && !n.props.locked);
  if (parts.length < 2) return [];
  const info = parts.map((n) => {
    const pos = vec(engine.get(n.uid, 'position')?.value) ?? { x: 0, y: 0 };
    const e = componentExtent(doc, engine, n, copper);
    return { n, pos, box: { minX: pos.x + e.minX, minY: pos.y + e.minY, maxX: pos.x + e.maxX, maxY: pos.y + e.maxY } };
  });
  const minX = Math.min(...info.map((i) => i.box.minX));
  const maxX = Math.max(...info.map((i) => i.box.maxX));
  const minY = Math.min(...info.map((i) => i.box.minY));
  const maxY = Math.max(...info.map((i) => i.box.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const out: { uid: string; to: Vec2 }[] = [];
  const shift = (i: (typeof info)[number], dx: number, dy: number) => (dx || dy) && out.push({ uid: i.n.uid, to: { x: r4(i.pos.x + dx), y: r4(i.pos.y + dy) } });
  if (mode === 'distributeX' || mode === 'distributeY') {
    const h = mode === 'distributeX';
    const s = info.slice().sort((a, b) => (h ? a.box.minX - b.box.minX : a.box.minY - b.box.minY));
    if (s.length < 3) return [];
    const total = s.reduce((t, i) => t + (h ? i.box.maxX - i.box.minX : i.box.maxY - i.box.minY), 0);
    const gap = ((h ? maxX - minX : maxY - minY) - total) / (s.length - 1);
    let at = h ? minX : minY;
    for (const i of s) {
      const lo = h ? i.box.minX : i.box.minY;
      if (h) shift(i, at - lo, 0);
      else shift(i, 0, at - lo);
      at += (h ? i.box.maxX - i.box.minX : i.box.maxY - i.box.minY) + gap;
    }
    return out;
  }
  for (const i of info) {
    if (mode === 'left') shift(i, minX - i.box.minX, 0);
    else if (mode === 'right') shift(i, maxX - i.box.maxX, 0);
    else if (mode === 'top') shift(i, 0, minY - i.box.minY);
    else if (mode === 'bottom') shift(i, 0, maxY - i.box.maxY);
    else if (mode === 'centerX') shift(i, cx - (i.box.minX + i.box.maxX) / 2, 0);
    else if (mode === 'centerY') shift(i, 0, cy - (i.box.minY + i.box.maxY) / 2);
  }
  return out;
}
