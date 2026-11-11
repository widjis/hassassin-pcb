/**
 * Align, distribute and place-relative for schematic parts (S8). Parts move through
 * moveSymbolsOps, so wires follow, pins stay on the project's pin grid and power stubs travel
 * along; callers check that connections did not change.
 */
import type { Op } from './commands.ts';
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { schematicGrid } from './schematic.ts';
import { moveSymbolsOps, symbolBounds, type Rect, type SymbolMove } from './schematicEdit.ts';

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY' | 'distributeX' | 'distributeY';

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

interface Part {
  uid: string;
  at: Vec2;
  box: Rect;
}

function parts(doc: Doc, engine: StyleEngine, uids: Iterable<string>): Part[] {
  const out: Part[] = [];
  for (const uid of uids) {
    const n = doc.nodes.get(uid);
    if (n?.type !== 'symbol' || n.props.power) continue;
    const at = vec(engine.get(uid, 'position')?.value);
    if (at) out.push({ uid, at, box: symbolBounds(doc, engine, uid) });
  }
  return out;
}

/** Ops that align or evenly distribute the given parts (power symbols follow their pins). */
export function alignOps(doc: Doc, engine: StyleEngine, uids: Iterable<string>, mode: AlignMode): Op[] {
  const ps = parts(doc, engine, uids);
  if (ps.length < 2) return [];
  const moves: SymbolMove[] = [];
  const to = (p: Part, dx: number, dy: number) => {
    if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) moves.push({ uid: p.uid, position: { x: p.at.x + dx, y: p.at.y + dy } });
  };
  const cx = (b: Rect) => (b.minX + b.maxX) / 2;
  const cy = (b: Rect) => (b.minY + b.maxY) / 2;
  if (mode === 'left') { const t = Math.min(...ps.map((p) => p.box.minX)); for (const p of ps) to(p, t - p.box.minX, 0); }
  else if (mode === 'right') { const t = Math.max(...ps.map((p) => p.box.maxX)); for (const p of ps) to(p, t - p.box.maxX, 0); }
  else if (mode === 'top') { const t = Math.min(...ps.map((p) => p.box.minY)); for (const p of ps) to(p, 0, t - p.box.minY); }
  else if (mode === 'bottom') { const t = Math.max(...ps.map((p) => p.box.maxY)); for (const p of ps) to(p, 0, t - p.box.maxY); }
  else if (mode === 'centerX') { const t = ps.reduce((s, p) => s + cx(p.box), 0) / ps.length; for (const p of ps) to(p, t - cx(p.box), 0); }
  else if (mode === 'centerY') { const t = ps.reduce((s, p) => s + cy(p.box), 0) / ps.length; for (const p of ps) to(p, 0, t - cy(p.box)); }
  else {
    // Even gaps between neighbours, the first and last part stay where they are.
    const horiz = mode === 'distributeX';
    const sorted = ps.slice().sort((a, b) => (horiz ? cx(a.box) - cx(b.box) : cy(a.box) - cy(b.box)));
    if (sorted.length < 3) return [];
    const lo = horiz ? sorted[0]!.box.minX : sorted[0]!.box.minY;
    const hi = horiz ? sorted[sorted.length - 1]!.box.maxX : sorted[sorted.length - 1]!.box.maxY;
    const sizes = sorted.map((p) => (horiz ? p.box.maxX - p.box.minX : p.box.maxY - p.box.minY));
    const gap = (hi - lo - sizes.reduce((s, v) => s + v, 0)) / (sorted.length - 1);
    let pos = lo;
    sorted.forEach((p, i) => {
      const cur = horiz ? p.box.minX : p.box.minY;
      if (i > 0 && i < sorted.length - 1) to(p, horiz ? pos - cur : 0, horiz ? 0 : pos - cur);
      pos += sizes[i]! + gap;
    });
  }
  return moves.length ? moveSymbolsOps(doc, engine, moves, { pinGrid: true }) : [];
}

export type Side = 'below' | 'above' | 'left' | 'right';

/**
 * Ops that put parts in a row next to an anchor part: `side` of the anchor's body, `gap` mm
 * away from it, `spacing` mm between the parts, in the given order and centred on the anchor.
 * Example: decoupling capacitors below U1, 2.54 mm apart.
 */
export function placeRelativeOps(doc: Doc, engine: StyleEngine, anchorUid: string, uids: string[], side: Side, opts: { gap?: number; spacing?: number } = {}): Op[] {
  const anchor = symbolBounds(doc, engine, anchorUid);
  const ps = parts(doc, engine, uids);
  if (!ps.length) return [];
  const grid = schematicGrid(doc).pin;
  const gap = opts.gap ?? grid * 2;
  const spacing = opts.spacing ?? grid;
  const row = side === 'below' || side === 'above';
  const sizes = ps.map((p) => (row ? p.box.maxX - p.box.minX : p.box.maxY - p.box.minY));
  const total = sizes.reduce((s, v) => s + v, 0) + spacing * (ps.length - 1);
  let pos = row ? (anchor.minX + anchor.maxX) / 2 - total / 2 : (anchor.minY + anchor.maxY) / 2 - total / 2;
  const moves: SymbolMove[] = [];
  ps.forEach((p, i) => {
    const w = p.box.maxX - p.box.minX;
    const h = p.box.maxY - p.box.minY;
    // Target top-left corner of this part's box.
    const tx = row ? pos : side === 'right' ? anchor.maxX + gap : anchor.minX - gap - w;
    const ty = row ? (side === 'below' ? anchor.maxY + gap : anchor.minY - gap - h) : pos;
    moves.push({ uid: p.uid, position: { x: p.at.x + tx - p.box.minX, y: p.at.y + ty - p.box.minY } });
    pos += sizes[i]! + spacing;
  });
  return moveSymbolsOps(doc, engine, moves, { pinGrid: true });
}
