/**
 * Hierarchical sub-sheets created in the editor (S11).
 *
 * Same model as an imported KiCad hierarchy: a `block` on the parent sheet (position = top-left
 * corner, size) holds `sheetPin` children (absolute sheet positions, on the block edge) and the
 * child `sheet`. A hierarchical label (`label`, kind 'hier') on the child sheet connects to the
 * sheet pin of the same name; the netlist already joins them.
 *
 * Sheet pins follow the labels: a new label name adds a pin (inputs, bidirectional and passive on
 * the left edge, outputs on the right), a pin whose label is gone is removed unless a wire still
 * ends on it (ERC then reports it).
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { sheetItems } from './schematic.ts';
import type { Rect } from './schematicEdit.ts';

export const SHEET_PIN_SHAPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const;
export type SheetPinShape = (typeof SHEET_PIN_SHAPES)[number];

const STEP = 2.54;
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v && 'y' in v ? (v as Vec2) : undefined);
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const snap = (v: number) => r4(Math.round(v / STEP) * STEP);

/** The block that holds a sheet, or null for a top-level sheet. */
export function blockOfSheet(doc: Doc, sheet: DocNode): DocNode | null {
  const b = sheet.parent ? doc.nodes.get(sheet.parent) : undefined;
  return b?.type === 'block' ? b : null;
}

/** The child sheet of a block. */
export function sheetOfBlock(doc: Doc, block: DocNode): DocNode | null {
  for (const c of block.children) {
    const n = doc.nodes.get(c);
    if (n?.type === 'sheet') return n;
  }
  return null;
}

export function blockRect(engine: StyleEngine, block: DocNode): Rect | null {
  const p = vec(engine.get(block.uid, 'position')?.value);
  const s = vec(engine.get(block.uid, 'size')?.value);
  return p && s ? { minX: p.x, minY: p.y, maxX: p.x + s.x, maxY: p.y + s.y } : null;
}

/**
 * Ops that add a sub-sheet: a block on `parent` (top-left at `at`, snapped to the 2.54 mm grid)
 * and an empty child sheet named `name`.
 */
export function addSubSheetOps(doc: Doc, parent: DocNode, name: string, at: Vec2, size: Vec2 = { x: 30.48, y: 20.32 }): { ops: Op[]; block: string; sheet: string } {
  const clean = name.trim();
  if (!clean) throw new Error('A sub-sheet needs a name');
  if (/[/:]/.test(clean)) throw new Error('A sub-sheet name cannot contain "/" or ":"');
  const taken = parent.children.map((c) => doc.nodes.get(c)).some((n) => n?.type === 'block' && n.name === clean);
  if (taken) throw new Error(`This sheet already has a sub-sheet named "${clean}"`);
  const block = newUid('blk');
  const sheet = newUid('sht');
  const w = Math.max(snap(size.x), STEP * 6);
  const h = Math.max(snap(size.y), STEP * 4);
  return {
    block,
    sheet,
    ops: [
      {
        op: 'add',
        parent: parent.uid,
        index: parent.children.length,
        tree: {
          nodes: [
            { uid: block, type: 'block', name: clean, props: {}, rules: [{ name: 'position', value: { x: snap(at.x), y: snap(at.y) } }, { name: 'size', value: { x: w, y: h } }], parent: parent.uid, children: [sheet] },
            { uid: sheet, type: 'sheet', name: clean, props: {}, rules: [], parent: block, children: [] },
          ],
        },
      },
    ],
  };
}

/** Hierarchical labels of a sheet, by name (first one's shape wins; none for imported labels). */
export function hierLabels(doc: Doc, sheet: DocNode): Map<string, { uid: string; shape?: SheetPinShape }> {
  const out = new Map<string, { uid: string; shape?: SheetPinShape }>();
  for (const n of sheetItems(doc, sheet)) {
    if (n.type !== 'label' || n.props.kind !== 'hier' || !n.name || out.has(n.name)) continue;
    if (doc.nodes.get(n.parent ?? '')?.type === 'symbol') continue;
    const shape = String(n.props.shape ?? '');
    out.set(n.name, (SHEET_PIN_SHAPES as readonly string[]).includes(shape) ? { uid: n.uid, shape: shape as SheetPinShape } : { uid: n.uid });
  }
  return out;
}

/** Ops that bring a block's sheet pins in line with the hierarchical labels of its sheet. */
export function syncSheetPinsOps(doc: Doc, engine: StyleEngine, block: DocNode): Op[] {
  const child = sheetOfBlock(doc, block);
  const rect = blockRect(engine, block);
  const parentSheet = block.parent ? doc.nodes.get(block.parent) : undefined;
  if (!child || !rect || !parentSheet) return [];
  const labels = hierLabels(doc, child);
  const pins = block.children.map((c) => doc.nodes.get(c)).filter((n): n is DocNode => n?.type === 'sheetPin');
  const ops: Op[] = [];

  // Pins without a label: drop them unless a wire on the parent sheet still ends there.
  const wireEnds: Vec2[] = [];
  for (const n of sheetItems(doc, parentSheet)) {
    if (n.type !== 'wire') continue;
    for (const k of ['start', 'end']) {
      const p = vec(engine.get(n.uid, k)?.value);
      if (p) wireEnds.push(p);
    }
  }
  const wired = (p: Vec2) => wireEnds.some((q) => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.y - p.y) < 1e-3);
  const kept: DocNode[] = [];
  for (const pin of pins) {
    const at = vec(engine.get(pin.uid, 'position')?.value);
    if (!labels.has(pin.name) && !(at && wired(at))) ops.push({ op: 'remove', uid: pin.uid });
    else kept.push(pin);
  }
  // Shape changes of existing pins.
  for (const pin of kept) {
    const l = labels.get(pin.name);
    if (l?.shape && pin.props.kind !== l.shape) ops.push({ op: 'setProp', uid: pin.uid, key: 'kind', value: l.shape });
  }

  // New pins: next free 2.54 mm slot on their edge, growing the block when it is full.
  const used = new Set<string>();
  for (const pin of kept) {
    const at = vec(engine.get(pin.uid, 'position')?.value);
    if (at) used.add(`${Math.abs(at.x - rect.minX) < Math.abs(at.x - rect.maxX) ? 'L' : 'R'}${Math.round((at.y - rect.minY) / STEP)}`);
  }
  let maxY = rect.maxY;
  let index = block.children.length;
  const have = new Set(kept.map((p) => p.name));
  for (const [name, l] of [...labels].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (have.has(name)) continue;
    const side = l.shape === 'output' ? 'R' : 'L';
    let slot = 2;
    while (used.has(`${side}${slot}`)) slot++;
    used.add(`${side}${slot}`);
    const y = r4(rect.minY + slot * STEP);
    if (y + 2 * STEP > maxY) maxY = r4(y + 2 * STEP);
    ops.push({
      op: 'add',
      parent: block.uid,
      index: index++,
      tree: { nodes: [{ uid: newUid('spin'), type: 'sheetPin', name, props: { kind: l.shape ?? 'passive' }, rules: [{ name: 'position', value: { x: side === 'L' ? rect.minX : rect.maxX, y } }], parent: block.uid, children: [] }] },
    });
  }
  if (maxY > rect.maxY) ops.push({ op: 'setRule', uid: block.uid, name: 'size', decl: { name: 'size', value: { x: r4(rect.maxX - rect.minX), y: r4(maxY - rect.minY) } } });
  return ops;
}

/** Sync ops for every block whose sheet is one of `sheetUids`. */
export function syncSheetPinsForSheets(doc: Doc, engine: StyleEngine, sheetUids: Iterable<string>): Op[] {
  const ops: Op[] = [];
  for (const sid of sheetUids) {
    const s = doc.nodes.get(sid);
    const b = s ? blockOfSheet(doc, s) : null;
    if (b) ops.push(...syncSheetPinsOps(doc, engine, b));
  }
  return ops;
}

/** Op that adds a hierarchical label at `at` on a sheet. */
export function addHierLabelOp(sheet: DocNode, name: string, at: Vec2, shape: SheetPinShape = 'passive', rotation = 0): { op: Op; uid: string } {
  const uid = newUid('lbl');
  return {
    uid,
    op: { op: 'add', parent: sheet.uid, index: sheet.children.length, tree: { nodes: [{ uid, type: 'label', name, props: { kind: 'hier', shape }, rules: [{ name: 'position', value: at }, { name: 'rotation', value: rotation }], parent: sheet.uid, children: [] }] } },
  };
}
