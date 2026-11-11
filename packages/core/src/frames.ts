/**
 * Coordinate frames. Children of a component (pads, its graphics and texts) store
 * positions relative to the component; moving or rotating the component moves them.
 * Everything else is in board coordinates.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { padOutline, place } from './geom.ts';

export interface Frame {
  origin: Vec2;
  rot: number;
  /** The component this frame belongs to, if any. */
  elementUid: string | null;
}

export const IDENTITY: Frame = { origin: { x: 0, y: 0 }, rot: 0, elementUid: null };

const asVec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export function elementOf(doc: Doc, node: DocNode): DocNode | null {
  let p = node.parent ? doc.nodes.get(node.parent) : undefined;
  while (p) {
    if (p.type === 'element') return p;
    p = p.parent ? doc.nodes.get(p.parent) : undefined;
  }
  return null;
}

/** The frame a node's own coordinates are expressed in. */
export function frameOf(doc: Doc, engine: StyleEngine, node: DocNode): Frame {
  const el = elementOf(doc, node);
  if (!el) return IDENTITY;
  return {
    origin: asVec(engine.get(el.uid, 'position')?.value) ?? { x: 0, y: 0 },
    rot: Number(engine.get(el.uid, 'rotation')?.value ?? 0) || 0,
    elementUid: el.uid,
  };
}

export const toWorld = (f: Frame, p: Vec2): Vec2 => place(p, f.origin, f.rot);

/** World-space pad description used by rendering, picking and connectivity. */
export interface PadGeom {
  uid: string;
  center: Vec2;
  /** Total rotation (component + pad). */
  rot: number;
  outline: Vec2[];
  layers: string[];
  hole?: Vec2;
}

export function padGeom(doc: Doc, engine: StyleEngine, pad: DocNode, copper: string[]): PadGeom | null {
  const f = frameOf(doc, engine, pad);
  const local = asVec(engine.get(pad.uid, 'position')?.value);
  if (!local) return null;
  const center = toWorld(f, local);
  const rot = f.rot + (Number(engine.get(pad.uid, 'rotation')?.value ?? 0) || 0);
  const sizeV = engine.get(pad.uid, 'size')?.value;
  const size: Vec2 = typeof sizeV === 'number' ? { x: sizeV, y: sizeV } : (asVec(sizeV) ?? { x: 1, y: 1 });
  const shape = String(engine.get(pad.uid, 'padShape')?.value ?? 'rect');
  const ratio = Number(engine.get(pad.uid, 'cornerRatio')?.value ?? 0.25);
  const outline = padOutline(shape === 'custom' ? 'rect' : shape, size, ratio).map((p) => place(p, center, rot));
  const raw = engine.get(pad.uid, 'layers')?.value;
  const layers = (Array.isArray(raw) ? (raw as string[]) : []).flatMap((l) => (l === '*' ? copper : [l]));
  const holeV = engine.get(pad.uid, 'holeSize')?.value;
  const hole = holeV === undefined ? undefined : typeof holeV === 'number' ? { x: holeV, y: holeV } : asVec(holeV);
  return { uid: pad.uid, center, rot, outline, layers, ...(hole ? { hole } : {}) };
}
