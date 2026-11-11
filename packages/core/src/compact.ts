/**
 * Block compaction (S8): a "block" is a group of parts joined by wires (with its power symbols,
 * labels and junctions). Blocks only meet other blocks through names (power symbols, labels),
 * so a whole block can be moved rigidly without changing any connection. Compaction slides
 * blocks towards the top-left, one after another, until they are `gap` mm apart.
 */
import { applyOps, type Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { schematicGrid, symbolFrame, symToSheet } from './schematic.ts';
import { netGroups, symbolBounds, type Rect } from './schematicEdit.ts';
import { groupBoxRect, noteBox } from './sheetFrame.ts';

const EPS = 1e-3;
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
const onSeg = (p: Vec2, a: Vec2, b: Vec2) =>
  Math.min(a.x, b.x) - EPS <= p.x && p.x <= Math.max(a.x, b.x) + EPS && Math.min(a.y, b.y) - EPS <= p.y && p.y <= Math.max(a.y, b.y) + EPS &&
  Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < EPS;

export interface Block {
  /** Top-level sheet items in the block (symbols, wires, labels, junctions, no-connects). */
  items: string[];
  box: Rect;
  parts: number;
}

interface Item {
  node: DocNode;
  points: Vec2[];
  seg?: [Vec2, Vec2];
  box: Rect;
  /** Group boxes and notes: joined by area, not by connection points. */
  area?: boolean;
}

const inRect = (p: Vec2, r: Rect) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
const centre = (r: Rect): Vec2 => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
const near = (a: Rect, b: Rect, d: number) => a.minX - d < b.maxX && b.minX - d < a.maxX && a.minY - d < b.maxY && b.minY - d < a.maxY;

/** Blocks of a sheet: items joined through wires and shared points. */
export function sheetBlocks(doc: Doc, engine: StyleEngine, sheetUid: string): Block[] {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return [];
  const items: Item[] = [];
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) items.push({ node: n, points: [a, b], seg: [a, b], box: { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) } });
    } else if (n.type === 'symbol') {
      const f = symbolFrame(engine, n.uid);
      const pts: Vec2[] = [];
      for (const k of n.children) {
        const ch = doc.nodes.get(k);
        if (ch?.type === 'pin') {
          const local = vec(engine.get(ch.uid, 'position')?.value);
          if (local) pts.push(symToSheet(f, local));
        } else if (ch?.type === 'label') {
          const at = vec(engine.get(ch.uid, 'position')?.value);
          if (at) pts.push(at);
        }
      }
      items.push({ node: n, points: pts, box: symbolBounds(doc, engine, n.uid) });
    } else if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) items.push({ node: n, points: [p], box: { minX: p.x - 0.5, minY: p.y - 0.5, maxX: p.x + 0.5 + (n.type === 'label' ? n.name.length * 0.75 : 0), maxY: p.y + 0.5 } });
    } else if (n.type === 'groupBox' || n.type === 'note') {
      const b = n.type === 'note' ? noteBox(engine, n) : groupBoxRect(engine, n);
      if (b) items.push({ node: n, points: [], box: b, area: true });
    }
  }
  // Union-find over items that touch.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => (parent[find(a)] = find(b));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!, B = items[j]!;
      // A group box holds what lies inside it; a note belongs to what it sits next to.
      const holds = (X: Item, Y: Item) => X.area && (X.node.type === 'groupBox' ? Y.points.some((q) => inRect(q, X.box)) || (Y.area ? false : inRect(centre(Y.box), X.box)) : near(X.box, Y.box, 2.54));
      const touch =
        holds(A, B) ||
        holds(B, A) ||
        A.points.some((p) => B.points.some((q) => same(p, q))) ||
        (A.seg && B.points.some((q) => onSeg(q, A.seg![0], A.seg![1]))) ||
        (B.seg && A.points.some((q) => onSeg(q, B.seg![0], B.seg![1])));
      if (touch) join(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i));
  const out: Block[] = [];
  for (const idx of groups.values()) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const i of idx) {
      const b = items[i]!.box;
      box.minX = Math.min(box.minX, b.minX);
      box.minY = Math.min(box.minY, b.minY);
      box.maxX = Math.max(box.maxX, b.maxX);
      box.maxY = Math.max(box.maxY, b.maxY);
    }
    out.push({ items: idx.map((i) => items[i]!.node.uid), box, parts: idx.filter((i) => items[i]!.node.type === 'symbol' && !items[i]!.node.props.power).length });
  }
  return out;
}

/** Ops that move a whole block by `d`. */
function moveBlockOps(doc: Doc, engine: StyleEngine, block: Block, d: Vec2): Op[] {
  const ops: Op[] = [];
  const add = (p: Vec2) => ({ x: Math.round((p.x + d.x) * 10000) / 10000, y: Math.round((p.y + d.y) * 10000) / 10000 });
  for (const uid of block.items) {
    const n = doc.nodes.get(uid);
    if (!n) continue;
    if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(uid, k)?.value);
        if (p) ops.push({ op: 'setRule', uid, name: k, decl: { name: k, value: add(p) } });
      }
      continue;
    }
    const p = vec(engine.get(uid, 'position')?.value);
    if (p) ops.push({ op: 'setRule', uid, name: 'position', decl: { name: 'position', value: add(p) } });
    if (n.type === 'symbol') {
      // Power symbols keep their connection label in sheet coordinates.
      for (const k of n.children) {
        const ch = doc.nodes.get(k);
        if (ch?.type !== 'label') continue;
        const q = vec(engine.get(ch.uid, 'position')?.value);
        if (q) ops.push({ op: 'setRule', uid: ch.uid, name: 'position', decl: { name: 'position', value: add(q) } });
      }
    }
  }
  return ops;
}

export interface CompactResult {
  ops: Op[];
  blocks: number;
  moved: number;
  /** Bounding-box area of the sheet before / after (mm²). */
  areaBefore: number;
  areaAfter: number;
}

const area = (bs: Block[]) => {
  if (!bs.length) return 0;
  const x0 = Math.min(...bs.map((b) => b.box.minX)), x1 = Math.max(...bs.map((b) => b.box.maxX));
  const y0 = Math.min(...bs.map((b) => b.box.minY)), y1 = Math.max(...bs.map((b) => b.box.maxY));
  return (x1 - x0) * (y1 - y0);
};

/**
 * Re-pack the blocks of a sheet into rows (reading order kept: top to bottom, then left to
 * right), `gap` mm apart (default 7.62), choosing the row width that gives the smallest
 * bounding box with a landscape-ish shape (width / height between 1 and 1.8). Blocks move as a
 * whole in pin-grid steps, so connections never change (verified).
 */
export function compactBlocksOps(doc: Doc, engine: StyleEngine, sheetUid: string, opts: { gap?: number; together?: number } = {}): CompactResult {
  const gap = opts.gap ?? 7.62;
  const step = schematicGrid(doc).pin;
  const blocks = clusters(sheetBlocks(doc, engine, sheetUid), opts.together ?? 2.54);
  const before = area(blocks);
  const none = { ops: [], blocks: blocks.length, moved: 0, areaBefore: before, areaAfter: before };
  if (blocks.length < 2) return none;
  const x0 = Math.min(...blocks.map((b) => b.box.minX));
  const y0 = Math.min(...blocks.map((b) => b.box.minY));
  // Reading order, with blocks whose tops are within a few mm counted as one row.
  const order = blocks
    .map((b, i) => ({ b, i }))
    .sort((a, c) => (Math.abs(a.b.box.minY - c.b.box.minY) > 12 ? a.b.box.minY - c.b.box.minY : a.b.box.minX - c.b.box.minX));
  const w = (b: Block) => b.box.maxX - b.box.minX;
  const h = (b: Block) => b.box.maxY - b.box.minY;
  const pack = (width: number) => {
    const at: Vec2[] = [];
    let x = 0, y = 0, rowH = 0, maxX = 0;
    for (const { b } of order) {
      if (x > 0 && x + w(b) > width) (x = 0, (y += rowH + gap), (rowH = 0));
      at.push({ x, y });
      x += w(b) + gap;
      rowH = Math.max(rowH, h(b));
      maxX = Math.max(maxX, x - gap);
    }
    return { at, W: maxX, H: y + rowH };
  };
  const widest = Math.max(...blocks.map(w));
  const sum = blocks.reduce((s, b) => s + w(b) + gap, 0);
  let best: ReturnType<typeof pack> | null = null;
  for (let width = widest; width <= sum + 1; width += 5) {
    const r = pack(width);
    const aspect = r.W / Math.max(1, r.H);
    if (aspect < 1 || aspect > 1.8) continue;
    if (!best || r.W * r.H < best.W * best.H) best = r;
  }
  if (!best || best.W * best.H >= before - 1) return none;
  const snap = (v: number) => Math.round(v / step) * step;
  const ops: Op[] = [];
  let moved = 0;
  order.forEach(({ b }, k) => {
    const t = best!.at[k]!;
    const d = { x: snap(x0 + t.x - b.box.minX), y: snap(y0 + t.y - b.box.minY) };
    if (Math.abs(d.x) < EPS && Math.abs(d.y) < EPS) return;
    ops.push(...moveBlockOps(doc, engine, b, d));
    moved++;
  });
  if (!ops.length) return none;
  // Verify: same connections, and blocks still apart.
  const key = netGroups(doc, engine);
  const r = applyOps(doc, ops);
  engine.recompute();
  const ok = netGroups(doc, engine) === key;
  const after = clusters(sheetBlocks(doc, engine, sheetUid), opts.together ?? 2.54);
  const apart = after.every((a, i) => after.every((c, j) => j <= i || a.box.maxX + gap / 2 <= c.box.minX || c.box.maxX + gap / 2 <= a.box.minX || a.box.maxY + gap / 2 <= c.box.minY || c.box.maxY + gap / 2 <= a.box.minY));
  const areaAfter = area(after);
  applyOps(doc, r.inverse);
  engine.recompute();
  if (!ok || !apart || after.length !== blocks.length) return none;
  return { ops, blocks: blocks.length, moved, areaBefore: before, areaAfter };
}

/**
 * Blocks that sit within `near` mm of each other (for example decoupling capacitors placed next
 * to their IC, joined only by power symbols) are kept together as one group.
 */
function clusters(blocks: Block[], near: number): Block[] {
  const parent = blocks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const close = (a: Rect, b: Rect) => a.minX - near < b.maxX && b.minX - near < a.maxX && a.minY - near < b.maxY && b.minY - near < a.maxY;
  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) if (close(blocks[i]!.box, blocks[j]!.box)) parent[find(i)] = find(j);
  const groups = new Map<number, Block[]>();
  blocks.forEach((b, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(b));
  return [...groups.values()].map((g) => ({
    items: g.flatMap((b) => b.items),
    parts: g.reduce((s, b) => s + b.parts, 0),
    box: { minX: Math.min(...g.map((b) => b.box.minX)), minY: Math.min(...g.map((b) => b.box.minY)), maxX: Math.max(...g.map((b) => b.box.maxX)), maxY: Math.max(...g.map((b) => b.box.maxY)) },
  }));
}
