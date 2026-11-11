/**
 * Text placement on a schematic sheet (S8, agreement 0.3): references, values, power-symbol
 * names and net-label texts are put where they do not overlap each other, symbol bodies or
 * wires. Each text tries a few natural spots next to its owner (the usual one first); when all
 * of them collide it takes the nearest free spot. The layout is computed, not stored, so the
 * editor, exports and checks all see the same result.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { isGroundNet } from './symbolGen.ts';
import { symbolFrame, symToSheet } from './schematic.ts';
import { symbolBounds, type Rect } from './schematicEdit.ts';

export type TextField = 'ref' | 'value' | 'power' | 'label';

export interface PlacedText {
  owner: string;
  field: TextField;
  text: string;
  /** Anchor and alignment, as drawn. */
  at: Vec2;
  size: number;
  align: 'left' | 'right' | 'center';
  base: 'top' | 'middle' | 'bottom';
  /** Area the text covers (sheet mm). */
  box: Rect;
  /** True when no spot without overlaps was found (drawn at its usual spot). */
  crowded?: boolean;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
/** Width of one monospace character as a share of the text size. */
const CHAR = 0.6;

function boxOf(text: string, at: Vec2, size: number, align: PlacedText['align'], base: PlacedText['base']): Rect {
  const w = Math.max(1, text.length) * size * CHAR;
  const h = size * 1.1;
  const x0 = align === 'left' ? at.x : align === 'right' ? at.x - w : at.x - w / 2;
  const y0 = base === 'top' ? at.y : base === 'bottom' ? at.y - h : at.y - h / 2;
  return { minX: x0, minY: y0, maxX: x0 + w, maxY: y0 + h };
}

const hit = (a: Rect, b: Rect, m = 0.05) => a.minX < b.maxX - m && b.minX < a.maxX - m && a.minY < b.maxY - m && b.minY < a.maxY - m;

function segBox(a: Vec2, b: Vec2): Rect {
  const t = 0.15;
  return { minX: Math.min(a.x, b.x) - t, minY: Math.min(a.y, b.y) - t, maxX: Math.max(a.x, b.x) + t, maxY: Math.max(a.y, b.y) + t };
}

/** Body of a symbol from its drawing only (no pins), sheet coordinates. */
function bodyBox(n: DocNode, engine: StyleEngine): Rect | null {
  const f = symbolFrame(engine, n.uid);
  const pts: Vec2[] = [];
  for (const g of (n.data?.graphics ?? []) as { t: string; a?: Vec2; b?: Vec2; pts?: Vec2[]; c?: Vec2; r?: number; s?: Vec2; m?: Vec2; e?: Vec2 }[]) {
    if (g.t === 'rect' && g.a && g.b) pts.push(g.a, g.b);
    else if (g.t === 'poly' && g.pts) pts.push(...g.pts);
    else if (g.t === 'circle' && g.c && g.r) pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r });
    else if (g.t === 'arc' && g.s && g.m && g.e) pts.push(g.s, g.m, g.e);
  }
  if (!pts.length) return null;
  const w = pts.map((p) => symToSheet(f, p));
  return { minX: Math.min(...w.map((p) => p.x)), minY: Math.min(...w.map((p) => p.y)), maxX: Math.max(...w.map((p) => p.x)), maxY: Math.max(...w.map((p) => p.y)) };
}

interface Want {
  owner: string;
  fields: { field: TextField; text: string; size: number }[];
  /** Spots to try, in order: anchor + alignment for the first line; further lines go below. */
  spots: { at: Vec2; align: PlacedText['align']; base: PlacedText['base'] }[];
  /** Box of the owner (texts may not cover it). */
  near: Rect;
  priority: number;
}

/** Lay out the texts of one sheet. */
export function layoutSheetTexts(doc: Doc, engine: StyleEngine, sheetUid: string, opts: { naive?: boolean } = {}): PlacedText[] {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return [];
  const fixed: Rect[] = [];
  const wants: Want[] = [];
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (!n) continue;
    if (n.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) fixed.push(segBox(a, b));
    } else if (n.type === 'junction') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) fixed.push({ minX: p.x - 0.5, minY: p.y - 0.5, maxX: p.x + 0.5, maxY: p.y + 0.5 });
    } else if (n.type === 'symbol') {
      const body = bodyBox(n, engine) ?? symbolBounds(doc, engine, n.uid);
      fixed.push(body);
      const b = symbolBounds(doc, engine, n.uid);
      if (n.props.power) {
        const lbl = n.children.map((k) => doc.nodes.get(k)).find((k) => k?.type === 'label');
        if (!lbl) continue;
        const cx = (body.minX + body.maxX) / 2;
        const cy = (body.minY + body.maxY) / 2;
        const ground = isGroundNet(lbl.name);
        const below = { at: { x: cx, y: body.maxY + 0.4 }, align: 'center' as const, base: 'top' as const };
        const above = { at: { x: cx, y: body.minY - 0.4 }, align: 'center' as const, base: 'bottom' as const };
        const right = { at: { x: body.maxX + 0.5, y: cy }, align: 'left' as const, base: 'middle' as const };
        const left = { at: { x: body.minX - 0.5, y: cy }, align: 'right' as const, base: 'middle' as const };
        wants.push({ owner: n.uid, fields: [{ field: 'power', text: lbl.name, size: 1.2 }], spots: ground ? [below, right, left, above] : [above, right, left, below], near: body, priority: 1 });
      } else {
        const ref = String(n.props.ref ?? n.name);
        const v = String(n.props.Value ?? '');
        const val = v.length > 28 ? `${v.slice(0, 27)}…` : v;
        const fields: Want['fields'] = [{ field: 'ref', text: ref, size: 1.3 }];
        if (val) fields.push({ field: 'value', text: val, size: 1.1 });
        const h = fields.length * 1.8;
        const midY = (b.minY + b.maxY) / 2 - h / 2;
        const spots: Want['spots'] = [
          { at: { x: b.maxX + 0.8, y: b.minY + 0.15 }, align: 'left', base: 'top' }, // right of the body, top (the usual)
          { at: { x: b.maxX + 0.8, y: midY }, align: 'left', base: 'top' }, // right, centred
          { at: { x: b.minX - 0.8, y: b.minY + 0.15 }, align: 'right', base: 'top' }, // left, top
          { at: { x: b.minX - 0.8, y: midY }, align: 'right', base: 'top' }, // left, centred
          { at: { x: (b.minX + b.maxX) / 2, y: b.minY - 0.4 - h }, align: 'center', base: 'top' }, // above
          { at: { x: (b.minX + b.maxX) / 2, y: b.maxY + 0.4 }, align: 'center', base: 'top' }, // below
        ];
        wants.push({ owner: n.uid, fields, spots, near: b, priority: 3 - Math.min(2, (b.maxX - b.minX) * (b.maxY - b.minY) / 400) });
      }
    } else if (n.type === 'label') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (!p) continue;
      const kind = String(n.props.kind ?? 'local');
      const rot = Number(engine.get(n.uid, 'rotation')?.value ?? 0);
      const right = rot === 180;
      // Global / hierarchical labels sit on the wire end in a frame; local ones above it.
      const spots: Want['spots'] =
        kind === 'local'
          ? [
              { at: { x: p.x + (right ? -0.4 : 0.4), y: p.y - 0.4 }, align: right ? 'right' : 'left', base: 'bottom' },
              { at: { x: p.x + (right ? -0.4 : 0.4), y: p.y + 0.4 }, align: right ? 'right' : 'left', base: 'top' },
            ]
          : [{ at: { x: p.x + (right ? -0.8 : 0.8), y: p.y }, align: right ? 'right' : 'left', base: 'middle' }];
      wants.push({ owner: n.uid, fields: [{ field: 'label', text: n.name, size: 1.2 }], spots, near: { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }, priority: 0 });
    }
  }

  const placed: PlacedText[] = [];
  const free = (boxes: Rect[], own: Rect) =>
    boxes.every((bx) => !fixed.some((f) => f !== own && hit(bx, f)) && !placed.some((t) => hit(bx, t.box)) && !hit(bx, own));
  const linesAt = (w: Want, spot: Want['spots'][number]) => {
    let y = spot.at.y;
    return w.fields.map((f) => {
      const at = { x: spot.at.x, y };
      const out = { ...f, at, align: spot.align, base: spot.base, box: boxOf(f.text, at, f.size, spot.align, spot.base) };
      y += f.size * 1.4;
      return out;
    });
  };
  // Labels first (they belong to a wire end), then power names, then part texts; bigger parts first.
  for (const w of wants.sort((a, b) => a.priority - b.priority)) {
    const own = w.near;
    let chosen: ReturnType<typeof linesAt> | null = null;
    for (const s of opts.naive ? [] : w.spots) {
      const lines = linesAt(w, s);
      // Labels may touch their own wire; everything else keeps off wires and bodies.
      if (w.fields[0]!.field === 'label' ? lines.every((l) => !placed.some((t) => hit(l.box, t.box))) : free(lines.map((l) => l.box), own)) {
        chosen = lines;
        break;
      }
    }
    if (!chosen && !opts.naive && w.fields[0]!.field !== 'label') {
      // Nearest free spot around the usual one, on a 1.27 mm step, up to ~10 mm away.
      const base = w.spots[0]!;
      search: for (let r = 1; r <= 8; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (const dy of [-r, r]) {
            for (const [ox, oy] of [[dx, dy], [dy, dx]] as const) {
              const lines = linesAt(w, { ...base, at: { x: base.at.x + ox * 1.27, y: base.at.y + oy * 1.27 } });
              if (free(lines.map((l) => l.box), own)) {
                chosen = lines;
                break search;
              }
            }
          }
        }
      }
    }
    const crowded = !chosen;
    for (const l of chosen ?? linesAt(w, w.spots[0]!)) placed.push({ owner: w.owner, field: l.field, text: l.text, at: l.at, size: l.size, align: l.align, base: l.base, box: l.box, ...(crowded ? { crowded } : {}) });
  }
  return placed;
}

/** Pairs of texts that overlap (for checks and tests). */
export function textOverlaps(texts: PlacedText[]): [PlacedText, PlacedText][] {
  const out: [PlacedText, PlacedText][] = [];
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (hit(texts[i]!.box, texts[j]!.box)) out.push([texts[i]!, texts[j]!]);
  return out;
}

/**
 * Texts that cover a symbol body or a wire (a net label touching its own wire end does not
 * count), plus text-on-text overlaps. 0 means the sheet reads cleanly.
 */
export function textClashes(doc: Doc, engine: StyleEngine, sheetUid: string, texts: PlacedText[]): number {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) return 0;
  const bodies: { owner: string; box: Rect }[] = [];
  const wires: Rect[] = [];
  for (const c of sheet.children) {
    const n = doc.nodes.get(c);
    if (n?.type === 'wire') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) wires.push(segBox(a, b));
    } else if (n?.type === 'symbol') {
      const bx = bodyBox(n, engine);
      if (bx) bodies.push({ owner: n.uid, box: bx });
    }
  }
  let n = textOverlaps(texts).length;
  for (const t of texts) {
    if (t.field === 'label') continue;
    if (bodies.some((b) => hit(t.box, b.box)) || wires.some((w) => hit(t.box, w))) n++;
  }
  return n;
}
