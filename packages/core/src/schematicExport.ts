/**
 * Schematic export to SVG and PDF (S10).
 *
 * A sheet is first turned into a display list (lines, circles, texts in sheet mm), the same picture
 * the editor draws minus editing aids (grid, selection, ERC markers, comments). Two small writers turn
 * the list into SVG (one sheet per file) or PDF (one page per sheet). Both are vector output; texts
 * use a monospaced font (Courier in PDF, so no font has to be embedded).
 *
 * The page is the sheet's frame when it has one (S9), else the drawn content plus a margin. A paper
 * size (A4 …) scales the page to fit that paper, so a sheet stays readable when printed.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import type { SymGraphicSpec } from './symbolGen.ts';
import { arcPoints } from './geom.ts';
import { allSheets, sheetItems, sheetPath, symbolFrame, symToSheet } from './schematic.ts';
import type { Rect } from './schematicEdit.ts';
import { FRAME_SIZES, groupBoxRect, sheetContentBox, sheetFrame, type SheetFrame } from './sheetFrame.ts';
import { layoutSheetTexts, type PlacedText } from './textLayout.ts';

export type ExportTheme = 'light' | 'dark' | 'mono';

export interface Palette {
  bg: string;
  wire: string;
  body: string;
  bodyFill: string | null;
  pin: string;
  pinNum: string;
  ref: string;
  value: string;
  text: string;
  local: string;
  global: string;
  hier: string;
  power: string;
  block: string;
  nc: string;
  frame: string;
  frameLabel: string;
  note: string;
  group: string;
}

export const PALETTES: Record<ExportTheme, Palette> = {
  // For printing: white paper, dark ink, colours close to the usual schematic conventions.
  light: {
    bg: '#ffffff', wire: '#007a45', body: '#8a2200', bodyFill: '#fff8dc', pin: '#8a2200', pinNum: '#6b6b6b',
    ref: '#005f63', value: '#005f63', text: '#333333', local: '#1a46a0', global: '#9c1461', hier: '#a04b00',
    power: '#b0001e', block: '#2b4fa8', nc: '#c40000', frame: '#5a1d00', frameLabel: '#7a5a48', note: '#222222', group: '#5244a3',
  },
  // As on screen.
  dark: {
    bg: '#0e1014', wire: '#4fd6a6', body: '#e8c47a', bodyFill: '#1d1c19', pin: '#c9ced8', pinNum: '#8f96a3',
    ref: '#f2efe6', value: '#a7b0be', text: '#c7cdd8', local: '#8ab4ff', global: '#f59fd0', hier: '#ffb86b',
    power: '#ff8f8f', block: '#7aa2f7', nc: '#ff6b6b', frame: '#7a8194', frameLabel: '#6c7383', note: '#c9cdd6', group: '#8a7fc4',
  },
  // Black on white, for black-and-white printers and copies.
  mono: {
    bg: '#ffffff', wire: '#000000', body: '#000000', bodyFill: null, pin: '#000000', pinNum: '#444444',
    ref: '#000000', value: '#000000', text: '#000000', local: '#000000', global: '#000000', hier: '#000000',
    power: '#000000', block: '#000000', nc: '#000000', frame: '#000000', frameLabel: '#444444', note: '#000000', group: '#444444',
  },
};

export type Align = 'left' | 'right' | 'center';
export type Baseline = 'top' | 'middle' | 'bottom';

export type Prim =
  | { k: 'path'; pts: Vec2[]; closed?: boolean; w: number; stroke: string | null; fill?: string | null; dash?: number[] }
  | { k: 'circle'; c: Vec2; r: number; w: number; stroke: string | null; fill?: string | null }
  | { k: 'text'; text: string; at: Vec2; size: number; color: string; align: Align; base: Baseline };

export interface SheetDrawing {
  /** Sheet path, e.g. "/" or "/Power". */
  name: string;
  /** Area of the sheet shown on the page (sheet mm). */
  view: Rect;
  /** Page size (mm); the view is scaled uniformly and centred on it. */
  page: Vec2;
  bg: string;
  prims: Prim[];
}

export interface ExportOptions {
  theme?: ExportTheme;
  /** 'auto' (default): the frame's paper, or the content size. Or a paper size (landscape): A4 … A0. */
  paper?: string;
}

/** Monospaced advance per character, in em (Courier and most monospaced fonts). */
export const MONO_ADVANCE = 0.6;
/** Distance from the anchor to the baseline, in em, for each vertical alignment. */
const BASELINE: Record<Baseline, number> = { top: 0.78, middle: 0.33, bottom: -0.2 };

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v && 'y' in v ? (v as Vec2) : undefined);
const plain = (t: string) => t.replace(/~\{([^}]*)\}/g, '$1');

/**
 * Lines and texts of a title block, shared by the editor view and the exports.
 * `kind` picks the colour: label (small caption), title, value.
 */
export function titleBlockGraphics(frame: SheetFrame): { lines: [Vec2, Vec2][]; texts: { text: string; at: Vec2; size: number; kind: 'label' | 'title' | 'value' }[] } {
  const tb = frame.titleBlock;
  const rowY = [tb.minY + 12, tb.minY + 19, tb.minY + 25.5];
  const lines: [Vec2, Vec2][] = rowY.map((y) => [{ x: tb.minX, y }, { x: tb.maxX, y }]);
  for (const x of [tb.minX + 30, tb.minX + 75]) lines.push([{ x, y: rowY[1]! }, { x, y: rowY[2]! }]);
  const f = frame.fields;
  const texts: { text: string; at: Vec2; size: number; kind: 'label' | 'title' | 'value' }[] = [];
  const lab = (text: string, x: number, y: number) => texts.push({ text, at: { x, y }, size: 1.1, kind: 'label' });
  const val = (text: string, x: number, y: number) => texts.push({ text, at: { x, y }, size: 1.8, kind: 'value' });
  lab('Title', tb.minX + 1.5, tb.minY + 1);
  texts.push({ text: f.title, at: { x: tb.minX + 1.5, y: tb.minY + 4.5 }, size: 3.2, kind: 'title' });
  lab('Project', tb.minX + 1.5, rowY[0]! + 0.8);
  val(f.project || '—', tb.minX + 14, rowY[0]! + 0.6);
  lab('Rev', tb.minX + 1.5, rowY[1]! + 0.8);
  val(f.revision, tb.minX + 9, rowY[1]! + 0.8);
  lab('Date', tb.minX + 31.5, rowY[1]! + 0.8);
  val(f.date || '—', tb.minX + 40, rowY[1]! + 0.8);
  lab('Sheet', tb.minX + 76.5, rowY[1]! + 0.8);
  val(f.sheet, tb.minX + 87, rowY[1]! + 0.8);
  lab('Author', tb.minX + 1.5, rowY[2]! + 0.8);
  val(f.author || '—', tb.minX + 14, rowY[2]! + 0.6);
  return { lines, texts };
}

const rectPts = (r: Rect): Vec2[] => [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];

/** The display list of one sheet. */
export function sheetDrawing(doc: Doc, engine: StyleEngine, sheet: DocNode, opts: ExportOptions = {}): SheetDrawing {
  const P = PALETTES[opts.theme ?? 'light'];
  const prims: Prim[] = [];
  const line = (pts: Vec2[], w: number, stroke: string, extra: Partial<Extract<Prim, { k: 'path' }>> = {}) => prims.push({ k: 'path', pts, w, stroke, ...extra });
  const text = (t: string, at: Vec2, size: number, color: string, align: Align = 'left', base: Baseline = 'middle') => {
    const s = plain(t);
    if (s.trim()) prims.push({ k: 'text', text: s, at, size, color, align, base });
  };
  const items = sheetItems(doc, sheet);
  const layout = new Map<string, PlacedText[]>();
  for (const t of layoutSheetTexts(doc, engine, sheet.uid)) (layout.get(t.owner) ?? layout.set(t.owner, []).get(t.owner)!).push(t);

  // Frame and title block
  const frame = sheetFrame(doc, sheet);
  if (frame) {
    line(rectPts(frame.inner), 0.35, P.frame, { closed: true });
    line(rectPts(frame.titleBlock), 0.3, P.frame, { closed: true });
    const g = titleBlockGraphics(frame);
    for (const [a, b] of g.lines) line([a, b], 0.2, P.frame);
    for (const t of g.texts) text(t.text, t.at, t.size, t.kind === 'label' ? P.frameLabel : t.kind === 'title' ? P.ref : P.value, 'left', 'top');
  }

  // Group boxes and notes
  for (const n of items) {
    if (n.type === 'groupBox') {
      const r = groupBoxRect(engine, n);
      if (!r) continue;
      line(rectPts(r), 0.2, P.group, { closed: true, dash: [1.5, 1] });
      text(n.name, { x: r.minX + 1, y: r.minY + 0.6 }, 1.4, P.group, 'left', 'top');
    } else if (n.type === 'note') {
      const at = vec(engine.get(n.uid, 'position')?.value);
      if (!at) continue;
      const size = Number(n.props.size ?? 1.5) || 1.5;
      n.name.split('\n').forEach((l, i) => text(l, { x: at.x, y: at.y + i * size * 1.4 }, size, P.note, 'left', 'top'));
    }
  }
  for (const t of ((sheet.data?.texts ?? []) as { at: Vec2; text: string; size: number }[]))
    t.text.split('\n').forEach((l, i) => text(l, { x: t.at.x, y: t.at.y + i * t.size * 1.4 }, t.size, P.text, 'left', 'top'));

  // Sub-sheet blocks
  for (const n of items) {
    if (n.type !== 'block') continue;
    const p = vec(engine.get(n.uid, 'position')?.value);
    const sz = vec(engine.get(n.uid, 'size')?.value);
    if (!p || !sz) continue;
    line(rectPts({ minX: p.x, minY: p.y, maxX: p.x + sz.x, maxY: p.y + sz.y }), 0.2, P.block, { closed: true });
    text(n.name, { x: p.x, y: p.y - 1 }, 1.6, P.block, 'left', 'bottom');
    for (const c of n.children) {
      const sp = doc.nodes.get(c);
      if (sp?.type !== 'sheetPin') continue;
      const q = vec(engine.get(sp.uid, 'position')?.value);
      if (!q) continue;
      const left = q.x - p.x < sz.x / 2;
      prims.push({ k: 'path', pts: rectPts({ minX: q.x - 0.5, minY: q.y - 0.5, maxX: q.x + 0.5, maxY: q.y + 0.5 }), closed: true, w: 0, stroke: null, fill: P.hier });
      text(sp.name, { x: q.x + (left ? 1.2 : -1.2), y: q.y }, 1.2, P.hier, left ? 'left' : 'right');
    }
  }

  // Wires
  for (const n of items) {
    if (n.type !== 'wire') continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    if (a && b) line([a, b], 0.2, P.wire);
  }

  // Buses (thick) and bus entries (thin, in the bus colour)
  for (const n of items) {
    if (n.type === 'bus') {
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      if (a && b) line([a, b], 0.5, P.block);
    } else if (n.type === 'busEntry') {
      const a = vec(engine.get(n.uid, 'position')?.value);
      const sz = vec(engine.get(n.uid, 'size')?.value);
      if (a && sz) line([a, { x: a.x + sz.x, y: a.y + sz.y }], 0.2, P.block);
    }
  }

  // Symbols
  for (const n of items) {
    if (n.type !== 'symbol') continue;
    const f = symbolFrame(engine, n.uid);
    const W = (p: Vec2) => symToSheet(f, p);
    for (const g of (n.data?.graphics ?? []) as (SymGraphicSpec | { t: 'arc'; s: Vec2; m: Vec2; e: Vec2; w: number })[]) {
      if (g.t === 'text') {
        text(g.text, W(g.at), g.size, P.body, 'center');
        continue;
      }
      const w = Math.max('w' in g ? g.w : 0, 0.2);
      if (g.t === 'circle') {
        prims.push({ k: 'circle', c: W(g.c), r: g.r, w, stroke: P.body, fill: g.fill ? P.bodyFill : null });
        continue;
      }
      let pts: Vec2[] = [];
      let closed = false;
      let fill = false;
      if (g.t === 'poly') ((pts = g.pts), (fill = g.fill));
      else if (g.t === 'rect') ((pts = [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }]), (closed = true), (fill = g.fill));
      else if (g.t === 'arc') pts = arcPoints(g.s, g.m, g.e);
      if (pts.length < 2) continue;
      line(pts.map(W), w, P.body, { closed, fill: fill ? P.bodyFill : null });
    }
    for (const c of n.children) {
      const pin = doc.nodes.get(c);
      if (pin?.type !== 'pin' || pin.props.hidden) continue;
      const at = vec(engine.get(pin.uid, 'position')?.value);
      if (!at) continue;
      const ang = (Number(engine.get(pin.uid, 'rotation')?.value ?? 0) * Math.PI) / 180;
      const len = Number(engine.get(pin.uid, 'pinLength')?.value ?? 2.54);
      if (!(len > 0)) continue;
      const end = { x: at.x + Math.cos(ang) * len, y: at.y - Math.sin(ang) * len };
      line([W(at), W(end)], 0.15, P.pin);
      if (n.props.power) continue;
      const mid = W({ x: (at.x + end.x) / 2, y: (at.y + end.y) / 2 });
      const num = String(pin.props.number ?? '');
      if (num) {
        // Beside the pin line: above a horizontal pin, right of a vertical one.
        const a = W(at);
        const b = W(end);
        if (Math.abs(a.x - b.x) < Math.abs(a.y - b.y)) text(num, { x: mid.x + 0.35, y: mid.y }, 0.9, P.pinNum, 'left', 'middle');
        else text(num, { x: mid.x, y: mid.y - 0.35 }, 0.9, P.pinNum, 'center', 'bottom');
      }
      const nm = String(pin.props.pinName ?? '');
      if (nm && nm !== '~' && nm !== num) {
        const inner = W({ x: end.x + Math.cos(ang) * 0.6, y: end.y - Math.sin(ang) * 0.6 });
        const dir = W({ x: end.x + Math.cos(ang) * 2, y: end.y - Math.sin(ang) * 2 });
        text(nm, inner, 1.05, P.text, dir.x >= inner.x ? 'left' : 'right');
      }
    }
    for (const t of layout.get(n.uid) ?? []) text(t.text, t.at, t.size, t.field === 'power' ? P.power : t.field === 'ref' ? P.ref : P.value, t.align, t.base);
  }

  // Labels, junctions, no-connects
  for (const n of items) {
    const p = vec(engine.get(n.uid, 'position')?.value);
    if (!p) continue;
    if (n.type === 'junction') prims.push({ k: 'circle', c: p, r: 0.45, w: 0, stroke: null, fill: P.wire });
    else if (n.type === 'noconnect') {
      const r = 0.65;
      line([{ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r }], 0.2, P.nc);
      line([{ x: p.x + r, y: p.y - r }, { x: p.x - r, y: p.y + r }], 0.2, P.nc);
    } else if (n.type === 'label' && doc.nodes.get(n.parent ?? '')?.type !== 'symbol') {
      const kind = String(n.props.kind ?? 'local');
      const color = kind === 'global' ? P.global : kind === 'hier' ? P.hier : P.local;
      const right = Number(engine.get(n.uid, 'rotation')?.value ?? 0) === 180;
      if (kind !== 'local') {
        // Boxed name next to the connection point; the point side is a flag tip.
        const size = 1.2;
        const tw = n.name.length * size * MONO_ADVANCE + 1;
        const h = 0.9;
        const x0 = p.x;
        const sgn = right ? -1 : 1;
        line(
          [
            { x: x0, y: p.y },
            { x: x0 + sgn * h, y: p.y - h },
            { x: x0 + sgn * (h + tw), y: p.y - h },
            { x: x0 + sgn * (h + tw), y: p.y + h },
            { x: x0 + sgn * h, y: p.y + h },
          ],
          0.15,
          color,
          { closed: true },
        );
        text(n.name, { x: x0 + sgn * (h + 0.5), y: p.y }, size, color, right ? 'right' : 'left');
      } else {
        const t = layout.get(n.uid)?.[0];
        if (t) text(t.text, t.at, t.size, color, t.align, t.base);
        else text(n.name, { x: p.x + (right ? -0.4 : 0.4), y: p.y - 0.4 }, 1.2, color, right ? 'right' : 'left', 'bottom');
      }
    }
  }

  // Page
  let view: Rect;
  if (frame) view = frame.paper;
  else {
    const b = sheetContentBox(doc, engine, sheet) ?? { minX: 0, minY: 0, maxX: 100, maxY: 60 };
    // Texts can stick out of the content box (labels, values): include them, plus a margin.
    for (const p of prims) if (p.k === 'text') {
      const r = textBox(p);
      b.minX = Math.min(b.minX, r.minX), b.minY = Math.min(b.minY, r.minY), b.maxX = Math.max(b.maxX, r.maxX), b.maxY = Math.max(b.maxY, r.maxY);
    }
    const m = 10;
    view = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
  }
  const vw = view.maxX - view.minX;
  const vh = view.maxY - view.minY;
  const paperKey = (opts.paper ?? 'auto').toUpperCase();
  let page: Vec2 = { x: vw, y: vh };
  if (paperKey !== 'AUTO') {
    const paper = FRAME_SIZES[paperKey];
    if (!paper) throw new Error(`Paper must be auto or one of ${Object.keys(FRAME_SIZES).join(', ')}`);
    // Landscape unless the drawing is clearly taller than wide.
    page = vh > vw * 1.1 ? { x: paper.y, y: paper.x } : { ...paper };
  }
  return { name: sheetPath(doc, sheet), view, page, bg: P.bg, prims };
}

/** Area a text covers (sheet mm), from the monospaced advance. */
export function textBox(t: Extract<Prim, { k: 'text' }>): Rect {
  const w = t.text.length * t.size * MONO_ADVANCE;
  const x0 = t.align === 'left' ? t.at.x : t.align === 'right' ? t.at.x - w : t.at.x - w / 2;
  const baseY = t.at.y + BASELINE[t.base] * t.size;
  return { minX: x0, minY: baseY - 0.75 * t.size, maxX: x0 + w, maxY: baseY + 0.22 * t.size };
}

/** Uniform scale and offset that put the view in the middle of the page (page mm = sheet mm × k + o). */
export function pageTransform(d: SheetDrawing): { k: number; ox: number; oy: number } {
  const vw = d.view.maxX - d.view.minX;
  const vh = d.view.maxY - d.view.minY;
  const k = Math.min(d.page.x / vw, d.page.y / vh);
  return { k, ox: (d.page.x - vw * k) / 2 - d.view.minX * k, oy: (d.page.y - vh * k) / 2 - d.view.minY * k };
}

// ---------------------------------------------------------------- SVG

const n4 = (v: number) => String(Math.round(v * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One sheet as a standalone SVG document (page size in mm). */
export function drawingToSvg(d: SheetDrawing): string {
  const { k, ox, oy } = pageTransform(d);
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${n4(d.page.x)}mm" height="${n4(d.page.y)}mm" viewBox="0 0 ${n4(d.page.x)} ${n4(d.page.y)}">`);
  out.push(`<title>${esc(d.name)}</title>`);
  out.push(`<rect x="0" y="0" width="${n4(d.page.x)}" height="${n4(d.page.y)}" fill="${d.bg}"/>`);
  out.push(`<g transform="matrix(${n4(k)} 0 0 ${n4(k)} ${n4(ox)} ${n4(oy)})" stroke-linecap="round" stroke-linejoin="round" font-family="'Courier New', Courier, monospace">`);
  for (const p of d.prims) {
    if (p.k === 'path') {
      const pts = p.pts.map((q) => `${n4(q.x)},${n4(q.y)}`).join(' ');
      const tag = p.closed ? 'polygon' : 'polyline';
      const stroke = p.stroke && p.w > 0 ? ` stroke="${p.stroke}" stroke-width="${n4(p.w)}"` : ' stroke="none"';
      const dash = p.dash ? ` stroke-dasharray="${p.dash.map(n4).join(' ')}"` : '';
      out.push(`<${tag} points="${pts}" fill="${p.fill ?? 'none'}"${stroke}${dash}/>`);
    } else if (p.k === 'circle') {
      const stroke = p.stroke && p.w > 0 ? ` stroke="${p.stroke}" stroke-width="${n4(p.w)}"` : ' stroke="none"';
      out.push(`<circle cx="${n4(p.c.x)}" cy="${n4(p.c.y)}" r="${n4(p.r)}" fill="${p.fill ?? 'none'}"${stroke}/>`);
    } else {
      const anchor = p.align === 'left' ? 'start' : p.align === 'right' ? 'end' : 'middle';
      const y = p.at.y + BASELINE[p.base] * p.size;
      // textLength keeps the monospaced width even when the viewer substitutes the font.
      const len = p.text.length * p.size * MONO_ADVANCE;
      out.push(`<text x="${n4(p.at.x)}" y="${n4(y)}" font-size="${n4(p.size)}" fill="${p.color}" text-anchor="${anchor}" textLength="${n4(len)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(p.text)}</text>`);
    }
  }
  out.push('</g>', '</svg>', '');
  return out.join('\n');
}

// ---------------------------------------------------------------- PDF

/** Characters outside WinAnsi that schematics use, spelled with ones inside it. */
const PDF_SUBST: Record<string, string> = { 'Ω': 'Ohm', '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '≈': '~', 'Δ': 'd', '−': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...' };
/** WinAnsi codes of the non-ASCII characters it has (the Latin-1 range maps to itself). */
const WIN_ANSI_EXTRA: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‰': 0x89, '–': 0x96, '—': 0x97, '™': 0x99, '•': 0x95 };

function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const sub = PDF_SUBST[ch];
    if (sub !== undefined) {
      out += pdfString(sub);
      continue;
    }
    const c = ch.codePointAt(0)!;
    let code: number;
    if (c >= 0x20 && c < 0x7f) code = c;
    else if (c >= 0xa0 && c <= 0xff) code = c;
    else code = WIN_ANSI_EXTRA[ch] ?? 0x3f; // '?'
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += '\\' + String.fromCharCode(code);
    else if (code < 0x80) out += String.fromCharCode(code);
    else out += '\\' + code.toString(8).padStart(3, '0');
  }
  return out;
}

const rgb = (hex: string): string => {
  const h = hex.replace('#', '');
  const v = (i: number) => n4(parseInt(h.slice(i, i + 2), 16) / 255);
  return `${v(0)} ${v(2)} ${v(4)}`;
};

const PT = 72 / 25.4;

/** Content stream of one page (PDF units: pt, origin bottom-left). */
function pageContent(d: SheetDrawing): string {
  const { k, ox, oy } = pageTransform(d);
  const o: string[] = [];
  const W = d.page.x * PT;
  const H = d.page.y * PT;
  o.push(`${rgb(d.bg)} rg 0 0 ${n4(W)} ${n4(H)} re f`);
  // Sheet mm → pt with y pointing down, like the sheet.
  o.push(`${n4(k * PT)} 0 0 ${n4(-k * PT)} ${n4(ox * PT)} ${n4(H - oy * PT)} cm 1 J 1 j`);
  for (const p of d.prims) {
    if (p.k === 'path' || p.k === 'circle') {
      const stroke = !!p.stroke && p.w > 0;
      const fill = !!p.fill;
      if (!stroke && !fill) continue;
      const parts: string[] = [];
      if (stroke) parts.push(`${rgb(p.stroke!)} RG ${n4(p.w)} w`);
      if (fill) parts.push(`${rgb(p.fill!)} rg`);
      parts.push(p.k === 'path' && p.dash ? `[${p.dash.map(n4).join(' ')}] 0 d` : '[] 0 d');
      if (p.k === 'path') {
        parts.push(p.pts.map((q, i) => `${n4(q.x)} ${n4(q.y)} ${i ? 'l' : 'm'}`).join(' '));
        if (p.closed) parts.push('h');
      } else {
        // Circle from four Bézier quarters.
        const { c, r } = p;
        const m = r * 0.5523;
        parts.push(
          `${n4(c.x + r)} ${n4(c.y)} m`,
          `${n4(c.x + r)} ${n4(c.y + m)} ${n4(c.x + m)} ${n4(c.y + r)} ${n4(c.x)} ${n4(c.y + r)} c`,
          `${n4(c.x - m)} ${n4(c.y + r)} ${n4(c.x - r)} ${n4(c.y + m)} ${n4(c.x - r)} ${n4(c.y)} c`,
          `${n4(c.x - r)} ${n4(c.y - m)} ${n4(c.x - m)} ${n4(c.y - r)} ${n4(c.x)} ${n4(c.y - r)} c`,
          `${n4(c.x + m)} ${n4(c.y - r)} ${n4(c.x + r)} ${n4(c.y - m)} ${n4(c.x + r)} ${n4(c.y)} c`,
          'h',
        );
      }
      parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
      o.push(parts.join(' '));
    } else {
      const s = pdfString(p.text);
      // Width from the characters as written to the PDF (substitutions can change the count).
      const chars = s.replace(/\\[0-7]{3}|\\./g, '_').length;
      const w = chars * p.size * MONO_ADVANCE;
      const x = p.align === 'left' ? p.at.x : p.align === 'right' ? p.at.x - w : p.at.x - w / 2;
      const y = p.at.y + BASELINE[p.base] * p.size;
      o.push(`BT /F1 1 Tf ${rgb(p.color)} rg ${n4(p.size)} 0 0 ${n4(-p.size)} ${n4(x)} ${n4(y)} Tm (${s}) Tj ET`);
    }
  }
  return o.join('\n');
}

/** A PDF with one page per drawing. Texts use the built-in Courier font. */
export function drawingsToPdf(drawings: SheetDrawing[], info: { title?: string; date?: Date } = {}): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body); // object number = index + 1
  add(''); // 1: catalog (filled below)
  add(''); // 2: pages
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'); // 3
  const date = info.date ?? new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const stamp = `D:${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`;
  add(`<< /Producer (Hassassin PCB) /Title (${pdfString(info.title ?? 'Schematic')}) /CreationDate (${stamp}) >>`); // 4
  const kids: number[] = [];
  for (const d of drawings) {
    const content = pageContent(d);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentNo = objs.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n4(d.page.x * PT)} ${n4(d.page.y * PT)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNo} 0 R >>`);
    kids.push(objs.length);
  }
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  // Everything above is ASCII (strings use octal escapes), so string length = byte length.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const out = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff;
  return out;
}

/** The sheets to export: one by uid / name / path, or every sheet in order. */
export function exportSheets(doc: Doc, which?: string): DocNode[] {
  const sheets = allSheets(doc);
  if (!which || which === 'all') return sheets;
  const hit = sheets.find((s) => s.uid === which || s.name === which || sheetPath(doc, s) === which);
  if (!hit) throw new Error(`No sheet "${which}". Sheets: ${sheets.map((s) => sheetPath(doc, s)).join(', ')}`);
  return [hit];
}

/** PDF of the given sheets (all by default). */
export function schematicPdf(doc: Doc, engine: StyleEngine, opts: ExportOptions & { sheet?: string; title?: string } = {}): Uint8Array {
  const drawings = exportSheets(doc, opts.sheet).map((s) => sheetDrawing(doc, engine, s, opts));
  return drawingsToPdf(drawings, { title: opts.title ?? (typeof doc.meta.projectName === 'string' ? doc.meta.projectName : undefined) });
}

/** SVG files of the given sheets (all by default): [{ name, svg }], name = sheet path. */
export function schematicSvgs(doc: Doc, engine: StyleEngine, opts: ExportOptions & { sheet?: string } = {}): { sheet: string; svg: string }[] {
  return exportSheets(doc, opts.sheet).map((s) => {
    const d = sheetDrawing(doc, engine, s, opts);
    return { sheet: d.name, svg: drawingToSvg(d) };
  });
}
