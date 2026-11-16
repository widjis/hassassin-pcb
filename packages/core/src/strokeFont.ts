/**
 * A single-stroke vector font for board texts (docs/05-pcb-improvements.md, P13), drawn for this project:
 * every glyph is a few polylines on a small grid, so a text becomes strokes that the editor draws, the Gerber
 * writer plots with a round aperture and DRC checks, all from the same geometry.
 *
 * Grid: x 0…4 (glyph width), y 0…6 (baseline to cap height, y up), x-height 4, descenders down to −2. A
 * stroke is written "x,y x,y …"; strokes of a glyph are separated by "|". The advance is 6 units, so a text of
 * size h has capitals h tall and characters about h apart.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { place } from './geom.ts';
import { frameOf, toWorld } from './frames.ts';

const G: Record<string, string> = {
  ' ': '',
  // ---- capitals
  A: '0,0 0,4 2,6 4,4 4,0|0,3 4,3',
  B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0',
  C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
  D: '0,0 0,6 2,6 4,4 4,2 2,0 0,0',
  E: '4,6 0,6 0,0 4,0|0,3 3,3',
  F: '4,6 0,6 0,0|0,3 3,3',
  G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '1,6 3,6|2,6 2,0|1,0 3,0',
  J: '4,6 4,1 3,0 1,0 0,1 0,2',
  K: '0,0 0,6|4,6 0,2|1,3 4,0',
  L: '0,6 0,0 4,0',
  M: '0,0 0,6 2,3 4,6 4,0',
  N: '0,0 0,6 4,0 4,6',
  O: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0',
  P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
  Q: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|2,2 4,0',
  R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0',
  S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
  T: '0,6 4,6|2,6 2,0',
  U: '0,6 0,1 1,0 3,0 4,1 4,6',
  V: '0,6 2,0 4,6',
  W: '0,6 1,0 2,3 3,0 4,6',
  X: '0,0 4,6|0,6 4,0',
  Y: '0,6 2,3 4,6|2,3 2,0',
  Z: '0,6 4,6 0,0 4,0',
  // ---- digits (the zero is slashed, to tell it from O)
  '0': '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|0,1 4,5',
  '1': '1,5 2,6 2,0|1,0 3,0',
  '2': '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
  '3': '0,5 1,6 3,6 4,5 4,4 3,3 1,3|3,3 4,2 4,1 3,0 1,0 0,1',
  '4': '3,0 3,6 0,2 4,2',
  '5': '4,6 0,6 0,3 3,3 4,2 4,1 3,0 1,0 0,1',
  '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3',
  '7': '0,6 4,6 1,0',
  '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
  '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
  // ---- small letters
  a: '4,4 4,0|4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  b: '0,6 0,0|0,3 1,4 3,4 4,3 4,1 3,0 1,0 0,1',
  c: '4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  d: '4,6 4,0|4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  e: '0,2 4,2 4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  f: '4,6 3,6 2,5 2,0|1,4 3,4',
  g: '4,4 4,-1 3,-2 1,-2 0,-1|4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  h: '0,6 0,0|0,3 1,4 3,4 4,3 4,0',
  i: '2,4 2,0|2,5.6 2,6',
  j: '3,4 3,-1 2,-2 1,-2|3,5.6 3,6',
  k: '0,6 0,0|3,4 0,1|1,2 3,0',
  l: '2,6 2,1 3,0',
  m: '0,4 0,0|0,3 1,4 2,3 2,0|2,3 3,4 4,3 4,0',
  n: '0,4 0,0|0,3 1,4 3,4 4,3 4,0',
  o: '1,0 0,1 0,3 1,4 3,4 4,3 4,1 3,0 1,0',
  p: '0,4 0,-2|0,3 1,4 3,4 4,3 4,1 3,0 1,0 0,1',
  q: '4,4 4,-2|4,3 3,4 1,4 0,3 0,1 1,0 3,0 4,1',
  r: '0,4 0,0|0,2 2,4 4,4',
  s: '4,3 3,4 1,4 0,3 1,2 3,2 4,1 3,0 1,0 0,1',
  t: '2,6 2,1 3,0 4,0|1,4 3,4',
  u: '0,4 0,1 1,0 3,0 4,1|4,4 4,0',
  v: '0,4 2,0 4,4',
  w: '0,4 1,0 2,2 3,0 4,4',
  x: '0,0 4,4|0,4 4,0',
  y: '0,4 2,0|4,4 2,0 1,-2',
  z: '0,4 4,4 0,0 4,0',
  // ---- punctuation and signs
  '!': '2,6 2,2|2,0.4 2,0',
  '"': '1,6 1,5|3,6 3,5',
  '#': '1,0 1,6|3,0 3,6|0,2 4,2|0,4 4,4',
  $: '4,5 3,5.5 1,5.5 0,4.5 1,3 3,3 4,1.5 3,0.5 1,0.5 0,1|2,6.5 2,-0.5',
  '%': '0,0 4,6|0,6 0,5 1,5 1,6 0,6|3,0 3,1 4,1 4,0 3,0',
  '&': '4,0 1,4 1,5 2,6 3,5 3,4 0,2 0,1 1,0 2,0 4,2',
  "'": '2,6 2,5',
  '(': '3,6 2,5 1.5,3 2,1 3,0',
  ')': '1,6 2,5 2.5,3 2,1 1,0',
  '*': '2,5 2,1|0,4 4,2|0,2 4,4',
  '+': '2,5 2,1|0,3 4,3',
  ',': '2,0.4 2,0 1,-1',
  '-': '0,3 4,3',
  '.': '2,0.4 2,0',
  '/': '0,0 4,6',
  ':': '2,4 2,3.6|2,0.4 2,0',
  ';': '2,4 2,3.6|2,0.4 2,0 1,-1',
  '<': '4,5 0,3 4,1',
  '=': '0,2 4,2|0,4 4,4',
  '>': '0,5 4,3 0,1',
  '?': '0,5 1,6 3,6 4,5 4,4 2,3 2,2|2,0.4 2,0',
  '@': '3,2 3,4 1,4 1,2 3,2 4,3 4,5 3,6 1,6 0,5 0,1 1,0 4,0',
  '[': '3,6 1,6 1,0 3,0',
  '\\': '0,6 4,0',
  ']': '1,6 3,6 3,0 1,0',
  '^': '0,4 2,6 4,4',
  _: '0,-1 4,-1',
  '`': '1,6 2,5',
  '{': '3,6 2,6 1.5,5 1.5,3.5 0.5,3 1.5,2.5 1.5,1 2,0 3,0',
  '|': '2,6.5 2,-1',
  '}': '1,6 2,6 2.5,5 2.5,3.5 3.5,3 2.5,2.5 2.5,1 2,0 1,0',
  '~': '0,3 1,4 3,2 4,3',
  // ---- a few signs used in values
  'Ω': '0,0 1,0 1,1 0,3 0,5 1,6 3,6 4,5 4,3 3,1 3,0 4,0',
  'µ': '0,-2 0,4|0,1 1,0 3,0 4,1|4,4 4,0',
  '°': '1,6 2,6 2,5 1,5 1,6',
  '±': '2,5 2,1|0,3 4,3|0,0 4,0',
};
// "u" (micro) typed as the Greek letter mu, too.
G['μ'] = G['µ']!;
// Anything else: an open box, so a missing glyph shows instead of vanishing.
const MISSING = '0,0 0,6 4,6 4,0 0,0';

const parsed = new Map<string, Vec2[][]>();
/** The strokes of one character, in grid units (y up). */
export function glyph(ch: string): Vec2[][] {
  let g = parsed.get(ch);
  if (g) return g;
  const src = G[ch] ?? MISSING;
  g = src ? src.split('|').map((s) => s.trim().split(/\s+/).map((p) => {
    const [x, y] = p.split(',').map(Number);
    return { x: x!, y: y! };
  })) : [];
  parsed.set(ch, g);
  return g;
}

/** Whether the font has its own glyph for this character. */
export const hasGlyph = (ch: string) => ch in G;

export const GLYPH_ADVANCE = 6;
export const GLYPH_CAP = 6;
/** Distance between lines of a multi-line text, in text heights. */
export const LINE_PITCH = 1.6;

export type TextJustify = 'left' | 'center' | 'right';

export interface TextPlacement {
  /** Anchor point (board or part coordinates, y down). */
  pos: Vec2;
  /** Height of capitals. */
  size: number;
  /** Degrees, counter-clockwise on screen, as every rotation in the project. */
  rot: number;
  justify?: TextJustify;
  /** Mirrored left to right (texts on the bottom side, read from below). */
  mirror?: boolean;
  /**
   * Turn the text half round when it would read upside down (as KiCad does for part texts), so it stays
   * readable from the bottom or the right edge.
   */
  upright?: boolean;
}

/**
 * The strokes of a text (one polyline per stroke, y down, around `pos`). Lines are split at "\n"; the text
 * is centred vertically on `pos` and aligned by `justify` (default centre).
 */
export function textStrokes(text: string, at: TextPlacement): Vec2[][] {
  const u = at.size / GLYPH_CAP;
  const lines = text.split('\n');
  const out: Vec2[][] = [];
  let rot = at.rot;
  if (at.upright) {
    const r = ((rot % 360) + 360) % 360;
    if (r > 90 + 1e-6 && r <= 270 + 1e-6) rot += 180;
  }
  const lineH = at.size * LINE_PITCH;
  const top = ((lines.length - 1) * lineH) / 2;
  lines.forEach((line, li) => {
    const chars = [...line];
    // Width from the left of the first glyph to the right of the last (no gap after it).
    const width = chars.length ? (chars.length * GLYPH_ADVANCE - (GLYPH_ADVANCE - 4)) * u : 0;
    const x0 = at.justify === 'left' ? 0 : at.justify === 'right' ? -width : -width / 2;
    // Centre of the capitals on the line's centre (y down).
    const yMid = -top + li * lineH;
    chars.forEach((ch, k) => {
      for (const s of glyph(ch)) {
        out.push(
          s.map((p) => {
            let x = x0 + (k * GLYPH_ADVANCE + p.x) * u;
            const y = yMid - (p.y - GLYPH_CAP / 2) * u;
            if (at.mirror) x = -x;
            return place({ x, y }, at.pos, rot);
          }),
        );
      }
    });
  });
  return out;
}

export interface BoardText {
  uid: string;
  layer: string;
  /** Stroke width (the text's `strokeWidth`). */
  width: number;
  strokes: Vec2[][];
}

/**
 * A board text node as strokes in board coordinates, or null when it is hidden or empty. Texts on a bottom
 * layer (B.*) are mirrored, or when their `mirror` rule says x; texts of a part stay upright.
 */
export function boardTextStrokes(doc: Doc, engine: StyleEngine, n: DocNode): BoardText | null {
  if (n.type !== 'text' || engine.get(n.uid, 'visible')?.value === false || engine.get(n.uid, 'enabled')?.value === false) return null;
  const local = engine.get(n.uid, 'position')?.value as Vec2 | undefined;
  const text = String(engine.get(n.uid, 'text')?.value ?? n.name ?? '');
  if (!local || typeof local !== 'object' || !text) return null;
  const layer = String(engine.get(n.uid, 'layer')?.value ?? 'F.SilkS');
  const f = frameOf(doc, engine, n);
  const size = Number(engine.get(n.uid, 'fontSize')?.value ?? 1) || 1;
  const width = Number(engine.get(n.uid, 'strokeWidth')?.value ?? 0.15) || size * 0.15;
  const j = engine.get(n.uid, 'justify')?.value;
  const m = engine.get(n.uid, 'mirror')?.value;
  const strokes = textStrokes(text, {
    pos: toWorld(f, local),
    size,
    rot: f.rot + (Number(engine.get(n.uid, 'rotation')?.value ?? 0) || 0),
    justify: j === 'left' || j === 'right' ? j : 'center',
    mirror: m === 'x' || m === 'y' ? true : m === 'none' ? false : layer.startsWith('B.'),
    upright: f.elementUid !== null,
  });
  return { uid: n.uid, layer, width, strokes };
}
