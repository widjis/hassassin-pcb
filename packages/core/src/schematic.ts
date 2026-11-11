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
