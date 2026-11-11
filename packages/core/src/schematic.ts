/**
 * Schematic geometry helpers. Sheets use millimetres with Y pointing down (like the board).
 * A symbol's pins and drawing are stored in symbol-local coordinates and placed by the
 * symbol's position, rotation (counter-clockwise on screen) and mirror.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { place } from './geom.ts';

export type Mirror = 'none' | 'x' | 'y';

export interface SymbolFrame {
  origin: Vec2;
  rot: number;
  mirror: Mirror;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export function symbolFrame(engine: StyleEngine, symbolUid: string): SymbolFrame {
  return {
    origin: vec(engine.get(symbolUid, 'position')?.value) ?? { x: 0, y: 0 },
    rot: Number(engine.get(symbolUid, 'rotation')?.value ?? 0) || 0,
    mirror: (engine.get(symbolUid, 'mirror')?.value as Mirror) ?? 'none',
  };
}

/** Symbol-local point → sheet point. Mirror is applied after rotation. */
export function symToSheet(f: SymbolFrame, p: Vec2): Vec2 {
  const r = place(p, { x: 0, y: 0 }, f.rot);
  const m = f.mirror === 'x' ? { x: r.x, y: -r.y } : f.mirror === 'y' ? { x: -r.x, y: r.y } : r;
  return { x: f.origin.x + m.x, y: f.origin.y + m.y };
}

/** Pins of placed symbols sit on this grid (mm), so wires between parts can run straight. */
export const PIN_GRID = 2.54;

/**
 * The symbol origin nearest to `at` that puts its pins (symbol-local `pins`) on the pin grid,
 * for the given rotation / mirror. Without pins, `at` is snapped to half the pin grid.
 */
export function pinGridOrigin(at: Vec2, pins: Vec2[], rot = 0, mirror: Mirror = 'none', grid = PIN_GRID): Vec2 {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  const pin = pins[0];
  if (!pin) return { x: r4(Math.round(at.x / (grid / 2)) * (grid / 2)), y: r4(Math.round(at.y / (grid / 2)) * (grid / 2)) };
  const q = symToSheet({ origin: at, rot, mirror }, pin);
  const snapped = { x: Math.round(q.x / grid) * grid, y: Math.round(q.y / grid) * grid };
  return { x: r4(at.x + snapped.x - q.x), y: r4(at.y + snapped.y - q.y) };
}

/** Local pin positions of a placed symbol (visible pins first). */
export function symbolPinLocals(doc: Doc, engine: StyleEngine, symbolUid: string): Vec2[] {
  const sym = doc.nodes.get(symbolUid);
  const out: { p: Vec2; hidden: boolean }[] = [];
  for (const c of sym?.children ?? []) {
    const n = doc.nodes.get(c);
    const p = n?.type === 'pin' ? vec(engine.get(n.uid, 'position')?.value) : undefined;
    if (p) out.push({ p, hidden: !!n!.props.hidden });
  }
  return out.sort((a, b) => Number(a.hidden) - Number(b.hidden)).map((x) => x.p);
}

/** Sheet-space connection point of a pin. */
export function pinPoint(doc: Doc, engine: StyleEngine, pin: DocNode): Vec2 | null {
  const sym = pin.parent ? doc.nodes.get(pin.parent) : undefined;
  const local = vec(engine.get(pin.uid, 'position')?.value);
  if (!sym || sym.type !== 'symbol' || !local) return null;
  return symToSheet(symbolFrame(engine, sym.uid), local);
}

/** The sheet a schematic item lives on. */
export function sheetOf(doc: Doc, n: DocNode): DocNode | null {
  let p = n.parent ? doc.nodes.get(n.parent) : undefined;
  while (p) {
    if (p.type === 'sheet') return p;
    p = p.parent ? doc.nodes.get(p.parent) : undefined;
  }
  return null;
}

/** Hierarchical path of a sheet, e.g. "/" for the root or "/Power converter/". */
export function sheetPath(doc: Doc, sheet: DocNode): string {
  const names: string[] = [];
  let s: DocNode | undefined = sheet;
  while (s) {
    const block: DocNode | undefined = s.parent ? doc.nodes.get(s.parent) : undefined;
    if (!block || block.type !== 'block') break;
    names.unshift(block.name);
    s = block.parent ? doc.nodes.get(block.parent) : undefined;
  }
  return names.length ? `/${names.join('/')}/` : '/';
}

export function allSheets(doc: Doc): DocNode[] {
  return [...doc.nodes.values()].filter((n) => n.type === 'sheet');
}

/** Direct schematic items of a sheet (not those inside child sheets). */
export function sheetItems(doc: Doc, sheet: DocNode): DocNode[] {
  const out: DocNode[] = [];
  const visit = (uid: string) => {
    const n = doc.nodes.get(uid);
    if (!n) return;
    if (n.type === 'sheet' && n.uid !== sheet.uid) return; // a child sheet: stop
    out.push(n);
    n.children.forEach(visit);
  };
  sheet.children.forEach(visit);
  return out;
}
