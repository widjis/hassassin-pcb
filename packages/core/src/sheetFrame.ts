/**
 * Sheet frame, title block, notes and group boxes (S9).
 *
 * - A sheet's frame is stored in its props: `frameSize` (A4…A0, landscape), `frameX` / `frameY`
 *   (top-left corner, mm), and title-block fields `title`, `revision`, `date`, `author`. The sheet
 *   number ("2 / 3") comes from the order of the sheets. Empty fields fall back to project data.
 * - A note is a `note` node on a sheet: its name is the text (may have several lines), `position`
 *   is the top-left corner, prop `size` the text height in mm.
 * - A group box is a `groupBox` node: name = title, `position` = top-left corner, `size` = {x, y}.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { allSheets, sheetItems } from './schematic.ts';
import { symbolBounds, type Rect } from './schematicEdit.ts';

export const FRAME_SIZES: Record<string, Vec2> = {
  A4: { x: 297, y: 210 },
  A3: { x: 420, y: 297 },
  A2: { x: 594, y: 420 },
  A1: { x: 841, y: 594 },
  A0: { x: 1189, y: 841 },
};
/** Border between the paper edge and the drawing area, and the title block size (mm). */
export const FRAME_MARGIN = 10;
export const TITLE_BLOCK = { x: 120, y: 32 };

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export interface SheetFrame {
  size: string;
  /** Paper outline. */
  paper: Rect;
  /** Drawing area inside the border. */
  inner: Rect;
  /** Title block box (bottom-right, inside the border). */
  titleBlock: Rect;
  fields: { title: string; project: string; revision: string; date: string; author: string; sheet: string };
}

/** The frame of a sheet, or null when it has none. */
export function sheetFrame(doc: Doc, sheet: DocNode): SheetFrame | null {
  const size = String(sheet.props.frameSize ?? '');
  const paperSize = FRAME_SIZES[size];
  if (!paperSize) return null;
  const x = Number(sheet.props.frameX ?? 0) || 0;
  const y = Number(sheet.props.frameY ?? 0) || 0;
  const paper = { minX: x, minY: y, maxX: x + paperSize.x, maxY: y + paperSize.y };
  const inner = { minX: x + FRAME_MARGIN, minY: y + FRAME_MARGIN, maxX: paper.maxX - FRAME_MARGIN, maxY: paper.maxY - FRAME_MARGIN };
  const titleBlock = { minX: inner.maxX - TITLE_BLOCK.x, minY: inner.maxY - TITLE_BLOCK.y, maxX: inner.maxX, maxY: inner.maxY };
  const sheets = allSheets(doc);
  const root = doc.nodes.get(doc.rootId);
  const project = typeof doc.meta.projectName === 'string' && doc.meta.projectName ? doc.meta.projectName : root?.name && root.name !== 'Project' ? root.name : '';
  const field = (k: string) => (typeof sheet.props[k] === 'string' ? String(sheet.props[k]) : '');
  return {
    size,
    paper,
    inner,
    titleBlock,
    fields: {
      title: field('title') || (sheet.name && sheet.name !== 'Root' ? sheet.name : project) || 'Untitled',
      project,
      revision: field('revision') || '1',
      date: field('date'),
      author: field('author'),
      sheet: `${sheets.indexOf(sheet) + 1} / ${sheets.length}`,
    },
  };
}

/** Bounding box of what is drawn on a sheet (parts, wires, labels, notes, group boxes). */
export function sheetContentBox(doc: Doc, engine: StyleEngine, sheet: DocNode): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: Vec2) => ((x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y)));
  for (const n of sheetItems(doc, sheet)) {
    if (n.type === 'symbol') {
      const b = symbolBounds(doc, engine, n.uid);
      grow({ x: b.minX, y: b.minY });
      grow({ x: b.maxX, y: b.maxY });
    } else if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(n.uid, k)?.value);
        if (p) grow(p);
      }
    } else if (n.type === 'groupBox' || n.type === 'note') {
      const b = n.type === 'note' ? noteBox(engine, n) : groupBoxRect(engine, n);
      if (b) (grow({ x: b.minX, y: b.minY }), grow({ x: b.maxX, y: b.maxY }));
    } else if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) grow(p);
    }
  }
  return Number.isFinite(x0) ? { minX: x0, minY: y0, maxX: x1, maxY: y1 } : null;
}

/**
 * Ops that give a sheet a frame. `size` 'auto' picks the smallest paper whose drawing area holds
 * the content next to the title block; the frame is centred on the content (on a 2.54 mm step).
 * Fields left undefined keep their current value; '' clears one. size 'none' removes the frame.
 */
export function setSheetFrameOps(
  doc: Doc,
  engine: StyleEngine,
  sheet: DocNode,
  opts: { size?: string; title?: string; revision?: string; date?: string; author?: string; project?: string },
): { ops: Op[]; size: string; fits: boolean } {
  const ops: Op[] = [];
  if (opts.project !== undefined && (doc.meta.projectName ?? '') !== opts.project.trim()) ops.push({ op: 'setMeta', key: 'projectName', value: opts.project.trim() || null });
  const set = (key: string, value: string | number | null) => {
    if ((sheet.props[key] ?? null) !== value) ops.push({ op: 'setProp', uid: sheet.uid, key, value });
  };
  for (const k of ['title', 'revision', 'date', 'author'] as const) if (opts[k] !== undefined) set(k, opts[k]!.trim() || null);
  if (opts.size === 'none') {
    set('frameSize', null);
    set('frameX', null);
    set('frameY', null);
    return { ops, size: 'none', fits: true };
  }
  const box = sheetContentBox(doc, engine, sheet) ?? { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  // The content must fit the drawing area, keeping clear of the title block corner.
  const fitsIn = (s: Vec2) => w + 10 <= s.x - 2 * FRAME_MARGIN && h + TITLE_BLOCK.y + 10 <= s.y - 2 * FRAME_MARGIN;
  const wanted = opts.size && opts.size !== 'auto' ? opts.size.toUpperCase() : Object.keys(FRAME_SIZES).find((k) => fitsIn(FRAME_SIZES[k]!)) ?? 'A0';
  const paper = FRAME_SIZES[wanted];
  if (!paper) throw new Error(`Frame size must be auto, none or one of ${Object.keys(FRAME_SIZES).join(', ')}`);
  // Centre the content in the drawing area above the title block.
  const usableH = paper.y - 2 * FRAME_MARGIN - TITLE_BLOCK.y;
  const snap = (v: number) => Math.round(v / 2.54) * 2.54;
  const fx = snap((box.minX + box.maxX) / 2 - paper.x / 2);
  const fy = snap((box.minY + box.maxY) / 2 - (FRAME_MARGIN + usableH / 2));
  set('frameSize', wanted);
  set('frameX', Math.round(fx * 10000) / 10000);
  set('frameY', Math.round(fy * 10000) / 10000);
  return { ops, size: wanted, fits: fitsIn(paper) };
}

// ---------- notes ----------

/** Area a note's text covers. */
export function noteBox(engine: StyleEngine, n: DocNode): Rect | null {
  const at = vec(engine.get(n.uid, 'position')?.value);
  if (!at) return null;
  const size = Number(n.props.size ?? 1.5) || 1.5;
  const lines = n.name.split('\n');
  const w = Math.max(...lines.map((l) => l.length), 1) * size * 0.6;
  return { minX: at.x, minY: at.y, maxX: at.x + w, maxY: at.y + lines.length * size * 1.4 };
}

/** Op that adds a note to a sheet. */
export function addNoteOp(sheet: DocNode, text: string, at: Vec2, size = 1.5): { op: Op; uid: string } {
  const uid = newUid('note');
  return {
    uid,
    op: { op: 'add', parent: sheet.uid, index: sheet.children.length, tree: { nodes: [{ uid, type: 'note', name: text, props: { size }, rules: [{ name: 'position', value: at }], parent: sheet.uid, children: [] }] } },
  };
}

// ---------- group boxes ----------

export function groupBoxRect(engine: StyleEngine, n: DocNode): Rect | null {
  const at = vec(engine.get(n.uid, 'position')?.value);
  const size = vec(engine.get(n.uid, 'size')?.value);
  if (!at || !size) return null;
  return { minX: at.x, minY: at.y, maxX: at.x + size.x, maxY: at.y + size.y };
}

/** Op that adds a titled box; `rect` in sheet mm. */
export function addGroupBoxOp(sheet: DocNode, title: string, rect: Rect): { op: Op; uid: string } {
  const uid = newUid('grp');
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    uid,
    op: {
      op: 'add',
      parent: sheet.uid,
      index: sheet.children.length,
      tree: {
        nodes: [
          {
            uid,
            type: 'groupBox',
            name: title,
            props: {},
            rules: [
              { name: 'position', value: { x: r4(rect.minX), y: r4(rect.minY) } },
              { name: 'size', value: { x: r4(rect.maxX - rect.minX), y: r4(rect.maxY - rect.minY) } },
            ],
            parent: sheet.uid,
            children: [],
          },
        ],
      },
    },
  };
}

/**
 * The rectangle a group box around these items should have: their outline (parts with pins,
 * wires, power symbols), plus `margin` mm, with room for the title on top, on a 2.54 mm step.
 */
export function groupBoxAround(doc: Doc, engine: StyleEngine, uids: Iterable<string>, margin = 3.81): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: Vec2) => ((x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y)));
  for (const uid of uids) {
    const n = doc.nodes.get(uid);
    if (!n) continue;
    if (n.type === 'symbol') {
      const b = symbolBounds(doc, engine, uid);
      grow({ x: b.minX - 0.5, y: b.minY - 0.5 });
      // Room for the reference / value texts next to the part.
      grow({ x: b.maxX + 8, y: b.maxY + 0.5 });
    } else if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(uid, k)?.value);
        if (p) grow(p);
      }
    } else {
      const p = vec(engine.get(uid, 'position')?.value);
      if (p) grow(p);
    }
  }
  if (!Number.isFinite(x0)) return null;
  const s = 2.54;
  return { minX: Math.floor((x0 - margin) / s) * s, minY: Math.floor((y0 - margin - 3) / s) * s, maxX: Math.ceil((x1 + margin) / s) * s, maxY: Math.ceil((y1 + margin) / s) * s };
}

/** Today's date in the local time zone, as YYYY-MM-DD (for title blocks). */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
