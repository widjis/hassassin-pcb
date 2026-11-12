/**
 * Footprint generator (S19): a land pattern from datasheet dimensions, when no library footprint
 * exists. Written from scratch on top of the generic footprints in footprints.ts; no KiCad code.
 *
 * Families (all coordinates in mm, footprint centre at 0,0, Y down, pin 1 top-left):
 *   - two-row:     SOIC / SOP / TSSOP / DIP / headers. Pins down the left then up the right
 *                  ("around", as on a package) or alternating across the rows ("zigzag", as on a
 *                  pin header or ribbon connector). SMD or through-hole (drill).
 *   - four-side:   QFP / QFN. Counter-clockwise from pin 1 at the top of the left side.
 *   - grid:        BGA / LGA. Rows A, B … (I, O, Q, S, X, Z skipped, as JEDEC does), columns 1, 2 …
 *   - castellated: module with edge pads (ESP-12F style): pads straddle the body edge, counter-
 *                  clockwise from the top of the left side; optional half-hole drills.
 *   - pads:        a free list of pads.
 * Extras for every family: an exposed / thermal pad (with optional thermal vias), mounting holes.
 *
 * Pads are given as the datasheet's recommended land pattern (pad size, pad-centre spacing), or —
 * for two-row and four-side packages — derived from lead dimensions with these margins (ours,
 * round numbers for a nominal-density land pattern):
 *   gull-wing leads (SOIC, TSSOP, QFP): toe 0.35, heel 0.35, side 0.05 mm
 *   no-lead (QFN, DFN):                  toe 0.30, heel 0.00, side 0.00 mm
 *   J-lead (SOJ, PLCC):                  toe 0.10, heel 0.60, side 0.05 mm
 * pad length = lead length + toe + heel; pad width = lead width + 2 × side, never closer than
 * 0.2 mm to the next pad; the outer pad edge sits `toe` beyond the lead tip.
 */
import type { Vec2 } from './model.ts';
import { finishFootprint, type FootprintSpec, type FpPad, type PadShape } from './footprints.ts';

export type LeadType = 'gullwing' | 'nolead' | 'jlead';
export const LEAD_MARGINS: Record<LeadType, { toe: number; heel: number; side: number }> = {
  gullwing: { toe: 0.35, heel: 0.35, side: 0.05 },
  nolead: { toe: 0.3, heel: 0, side: 0 },
  jlead: { toe: 0.1, heel: 0.6, side: 0.05 },
};
/** Smallest copper gap left between neighbouring pads when pads are derived from leads. */
export const MIN_PAD_GAP = 0.2;

export interface PadSize {
  /** Along the lead (perpendicular to the package edge). */
  length: number;
  /** Across the lead (along the package edge). */
  width: number;
  shape?: PadShape;
}

/** Lead dimensions from the package drawing (use the maximum values when a range is given). */
export interface Leads {
  /** Tip-to-tip span across the package (E for two-row, D/E for four-side). */
  span: number;
  /** Foot length (L). */
  length: number;
  /** Lead width (b). */
  width: number;
  type?: LeadType;
}

export interface ExposedPad {
  w: number;
  h: number;
  x?: number;
  y?: number;
  /** Pad number; default: one more than the last pin. */
  number?: string;
  /** Thermal vias: drill, and a grid of rows × cols at `pitch`. */
  vias?: { drill: number; rows: number; cols: number; pitch: number };
}

export interface MountingHole {
  x: number;
  y: number;
  drill: number;
  /** Plated with a copper ring of this diameter; otherwise a bare (NPTH) hole. */
  pad?: number;
  number?: string;
}

interface Common {
  name: string;
  description?: string;
  /** Package body for fab / silk outlines and the courtyard (default: from the pads). */
  body?: { w: number; h: number };
  ep?: ExposedPad;
  holes?: MountingHole[];
  /** Courtyard margin around everything (default 0.25 mm). */
  courtyard?: number;
}

export type FootprintParams = Common &
  (
    | { family: 'two-row'; pins: number; pitch: number; numbering?: 'around' | 'zigzag'; rowSpacing?: number; pad?: PadSize; leads?: Leads; drill?: number; padDiameter?: number }
    | { family: 'four-side'; pins: number; pitch: number; pinsX?: number; spanX?: number; spanY?: number; pad?: PadSize; leads?: Leads; leadsY?: Leads }
    | { family: 'grid'; rows: number; cols: number; pitch: number; ball: number; shape?: 'circle' | 'rect'; skip?: string[] }
    | { family: 'castellated'; left: number; bottom?: number; right?: number; top?: number; pitch: number; pad: PadSize; body: { w: number; h: number }; outside?: number; drill?: number; leftStart?: number; bottomStart?: number }
    | { family: 'pads'; pads: { number: string; x: number; y: number; w: number; h: number; shape?: PadShape; drill?: number; rot?: number }[] }
  );

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const SMD_TOP = ['F.Cu', 'F.Paste', 'F.Mask'];
const THT = ['*.Cu', '*.Mask'];

const smd = (number: string, x: number, y: number, w: number, h: number, shape: PadShape = 'roundrect'): FpPad => ({
  number, at: { x: r3(x), y: r3(y) }, size: { x: r3(w), y: r3(h) }, shape, type: 'smd', layers: SMD_TOP, ...(shape === 'roundrect' ? { cornerRatio: 0.25 } : {}),
});
const tht = (number: string, x: number, y: number, w: number, h: number, drill: number, shape: PadShape): FpPad => ({
  number, at: { x: r3(x), y: r3(y) }, size: { x: r3(w), y: r3(h) }, shape, type: 'through', layers: THT, drill: r3(drill),
});

/** Pad length / centre distance from the package centre, and width, from lead dimensions. */
export function padFromLeads(leads: Leads, pitch: number): { length: number; width: number; centre: number } {
  const m = LEAD_MARGINS[leads.type ?? 'gullwing'];
  const outer = leads.span / 2 + m.toe;
  const inner = leads.span / 2 - leads.length - m.heel;
  const width = Math.min(leads.width + 2 * m.side, pitch - MIN_PAD_GAP);
  return { length: r3(outer - inner), width: r3(width), centre: r3((outer + inner) / 2) };
}

const positive = (v: number | undefined, what: string) => {
  if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new Error(`${what} must be a positive number`);
  return v;
};

/** JEDEC grid row letters: A … Z without I, O, Q, S, X, Z, then AA, AB … */
export function gridRowName(i: number): string {
  const L = 'ABCDEFGHJKLMNPRTUVWY';
  return i < L.length ? L[i]! : L[Math.floor(i / L.length) - 1]! + L[i % L.length]!;
}

/** Generate a footprint from parameters. Throws with a readable message on bad input. */
export function generateFootprint(p: FootprintParams): FootprintSpec {
  if (!p.name?.trim()) throw new Error('The footprint needs a name');
  const pads: FpPad[] = [];
  let pin1: Vec2 | undefined;
  let desc = p.description ?? '';
  let lastNumber = 0;

  if (p.family === 'two-row') {
    const n = positive(p.pins, 'pins');
    if (n % 2) throw new Error('A two-row package needs an even number of pins');
    const pitch = positive(p.pitch, 'pitch');
    const per = n / 2;
    const isTht = p.drill !== undefined;
    let len: number, wid: number, rowX: number;
    if (isTht) {
      const d = positive(p.drill, 'drill');
      const dia = p.padDiameter ?? r3(Math.min(d + 0.7, pitch - MIN_PAD_GAP));
      if (dia <= d) throw new Error('padDiameter must be larger than the drill');
      len = wid = dia;
      rowX = positive(p.rowSpacing, 'rowSpacing') / 2;
    } else if (p.pad) {
      len = positive(p.pad.length, 'pad.length');
      wid = positive(p.pad.width, 'pad.width');
      rowX = positive(p.rowSpacing, 'rowSpacing (pad centre to pad centre across the package)') / 2;
    } else if (p.leads) {
      const d = padFromLeads(p.leads, pitch);
      ((len = d.length), (wid = d.width), (rowX = d.centre));
    } else throw new Error('Give pad (land pattern) and rowSpacing, leads (lead dimensions), or drill for through-hole pins');
    const zig = p.numbering === 'zigzag';
    for (let i = 0; i < n; i++) {
      // around: 1..per down the left, per+1..n up the right; zigzag: odd left, even right.
      const left = zig ? i % 2 === 0 : i < per;
      const k = zig ? Math.floor(i / 2) : left ? i : n - 1 - i;
      const x = left ? -rowX : rowX;
      const y = (k - (per - 1) / 2) * pitch;
      const num = String(i + 1);
      if (isTht) pads.push(tht(num, x, y, len, wid, p.drill!, i === 0 ? 'rect' : 'circle'));
      else pads.push(smd(num, x, y, len, wid, p.pad?.shape ?? 'roundrect'));
    }
    lastNumber = n;
    pin1 = { x: r3(-rowX - len / 2 - 0.45), y: r3(-((per - 1) / 2) * pitch) };
    if (isTht) pin1 = undefined; // the square pad marks pin 1
    desc ||= `${n} pins, ${pitch} mm pitch, two rows ${r3(rowX * 2)} mm apart${isTht ? `, drill ${p.drill} mm` : ''}`;
  } else if (p.family === 'four-side') {
    const n = positive(p.pins, 'pins');
    const pitch = positive(p.pitch, 'pitch');
    const px = p.pinsX ?? n / 4;
    const py = n / 2 - px;
    if (!Number.isInteger(px) || !Number.isInteger(py) || px < 1 || py < 1) throw new Error('pins must split evenly over four sides (or give pinsX, the pins on the left / right side)');
    let lenX: number, widX: number, cX: number, lenY: number, widY: number, cY: number;
    if (p.pad) {
      lenX = lenY = positive(p.pad.length, 'pad.length');
      widX = widY = positive(p.pad.width, 'pad.width');
      cX = positive(p.spanX, 'spanX (pad centre to pad centre, left to right)') / 2;
      cY = (p.spanY ?? p.spanX!) / 2;
    } else if (p.leads) {
      const a = padFromLeads(p.leads, pitch);
      const b = padFromLeads(p.leadsY ?? p.leads, pitch);
      ((lenX = a.length), (widX = a.width), (cX = a.centre), (lenY = b.length), (widY = b.width), (cY = b.centre));
    } else throw new Error('Give pad (land pattern) with spanX / spanY, or leads (lead dimensions)');
    const shape = p.pad?.shape ?? 'roundrect';
    const off = (k: number, count: number) => (k - (count - 1) / 2) * pitch;
    let num = 1;
    // Left side top → bottom (pins along Y: px of them), bottom left → right, right bottom → top, top right → left.
    for (let k = 0; k < px; k++) pads.push(smd(String(num++), -cX, off(k, px), lenX, widX, shape));
    for (let k = 0; k < py; k++) pads.push(smd(String(num++), off(k, py), cY, widY, lenY, shape));
    for (let k = px - 1; k >= 0; k--) pads.push(smd(String(num++), cX, off(k, px), lenX, widX, shape));
    for (let k = py - 1; k >= 0; k--) pads.push(smd(String(num++), off(k, py), -cY, widY, lenY, shape));
    lastNumber = n;
    pin1 = { x: r3(-cX - lenX / 2 - 0.45), y: r3(off(0, px)) };
    desc ||= `${n} pins on four sides, ${pitch} mm pitch`;
  } else if (p.family === 'grid') {
    const rows = positive(p.rows, 'rows');
    const cols = positive(p.cols, 'cols');
    const pitch = positive(p.pitch, 'pitch');
    const ball = positive(p.ball, 'ball (pad diameter)');
    if (ball > pitch - MIN_PAD_GAP / 2) throw new Error('ball is too large for the pitch');
    const skip = new Set((p.skip ?? []).map((s) => s.toUpperCase()));
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const name = `${gridRowName(r)}${c + 1}`;
        if (skip.has(name)) continue;
        pads.push(smd(name, (c - (cols - 1) / 2) * pitch, (r - (rows - 1) / 2) * pitch, ball, ball, p.shape === 'rect' ? 'rect' : 'circle'));
      }
    pin1 = { x: r3(-((cols - 1) / 2) * pitch - ball / 2 - 0.5), y: r3(-((rows - 1) / 2) * pitch - ball / 2 - 0.5) };
    desc ||= `Grid ${rows}×${cols}, ${pitch} mm pitch, ${ball} mm pads`;
  } else if (p.family === 'castellated') {
    const pitch = positive(p.pitch, 'pitch');
    const bw = positive(p.body?.w, 'body.w') / 2;
    const bh = positive(p.body?.h, 'body.h') / 2;
    const len = positive(p.pad.length, 'pad.length');
    const wid = positive(p.pad.width, 'pad.width');
    // How far a pad reaches beyond the body edge (default: half of it, centred on the edge).
    const out = p.outside ?? len / 2;
    const c = (edge: number, dir: 1 | -1) => edge + dir * (out - len / 2);
    const left = positive(p.left, 'left');
    const right = p.right ?? left;
    const bottom = p.bottom ?? 0;
    const top = p.top ?? 0;
    // Column / row positions: centred on their side unless a start (pad 1 from the body's top,
    // first bottom pad from the body's left) is given.
    const colY = (k: number, count: number) => (p.leftStart !== undefined ? -bh + p.leftStart + k * pitch : (k - (count - 1) / 2) * pitch);
    const rowX = (k: number, count: number) => (p.bottomStart !== undefined ? -bw + p.bottomStart + k * pitch : (k - (count - 1) / 2) * pitch);
    let num = 1;
    const add = (x: number, y: number, horiz: boolean) => {
      const w = horiz ? len : wid;
      const h = horiz ? wid : len;
      const s = String(num++);
      if (p.drill !== undefined) {
        // Plated half holes: the drill sits on the body edge; the board edge cuts it in half.
        pads.push(tht(s, x, y, w, h, p.drill, 'oval'));
      } else pads.push(smd(s, x, y, w, h, p.pad.shape ?? 'rect'));
    };
    for (let k = 0; k < left; k++) add(c(-bw, -1), colY(k, left), true);
    for (let k = 0; k < bottom; k++) add(rowX(k, bottom), c(bh, 1), false);
    // Right side bottom → top, mirroring the left column.
    for (let k = right - 1; k >= 0; k--) add(c(bw, 1), colY(k, right), true);
    for (let k = top - 1; k >= 0; k--) add(rowX(k, top), c(-bh, -1), false);
    lastNumber = num - 1;
    pin1 = { x: r3(c(-bw, -1) - len / 2 - 0.5), y: r3(colY(0, left)) };
    desc ||= `Module ${p.body.w}×${p.body.h} mm, ${lastNumber} edge pads at ${pitch} mm`;
  } else if (p.family === 'pads') {
    if (!p.pads?.length) throw new Error('Give at least one pad');
    for (const q of p.pads) {
      const w = positive(q.w, `pad ${q.number} w`);
      const h = positive(q.h, `pad ${q.number} h`);
      const pad = q.drill !== undefined ? tht(q.number, q.x, q.y, w, h, q.drill, q.shape ?? 'circle') : smd(q.number, q.x, q.y, w, h, q.shape ?? 'roundrect');
      if (q.rot) pad.rot = q.rot;
      pads.push(pad);
    }
    lastNumber = Math.max(0, ...p.pads.map((q) => Number(q.number) || 0));
    desc ||= `${p.pads.length} pads`;
  } else throw new Error(`Unknown family "${(p as { family: string }).family}"; use two-row, four-side, grid, castellated or pads`);

  // Exposed / thermal pad.
  if (p.ep) {
    const num = p.ep.number ?? String(lastNumber + 1);
    pads.push({ ...smd(num, p.ep.x ?? 0, p.ep.y ?? 0, positive(p.ep.w, 'ep.w'), positive(p.ep.h, 'ep.h'), 'rect') });
    const v = p.ep.vias;
    if (v) {
      for (let r = 0; r < v.rows; r++)
        for (let c = 0; c < v.cols; c++)
          pads.push(tht(num, (p.ep.x ?? 0) + (c - (v.cols - 1) / 2) * v.pitch, (p.ep.y ?? 0) + (r - (v.rows - 1) / 2) * v.pitch, r3(v.drill + 0.3), r3(v.drill + 0.3), v.drill, 'circle'));
    }
    desc += `, exposed pad ${p.ep.w}×${p.ep.h} mm (pad ${num})`;
  }
  // Mounting holes.
  for (const h of p.holes ?? []) {
    const d = positive(h.drill, 'hole drill');
    if (h.pad) pads.push(tht(h.number ?? '', h.x, h.y, h.pad, h.pad, d, 'circle'));
    else pads.push({ number: '', at: { x: r3(h.x), y: r3(h.y) }, size: { x: d, y: d }, shape: 'circle', type: 'npth', layers: ['*.Cu', '*.Mask'], drill: d });
  }
  // Overlapping copper of different pads is an error in the input.
  for (let i = 0; i < pads.length; i++)
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i]!;
      const b = pads[j]!;
      if (a.number === b.number && a.number !== '') continue;
      const gx = Math.abs(a.at.x - b.at.x) - (a.size.x + b.size.x) / 2;
      const gy = Math.abs(a.at.y - b.at.y) - (a.size.y + b.size.y) / 2;
      if (gx < 0 && gy < 0) throw new Error(`Pads ${a.number || 'hole'} and ${b.number || 'hole'} overlap; check pitch and pad size`);
    }

  const body = p.body ?? (() => {
    const xs = pads.map((q) => Math.abs(q.at.x) - q.size.x / 2);
    const ys = pads.map((q) => Math.abs(q.at.y) - q.size.y / 2);
    return { w: r3(Math.max(1, ...xs) * 2), h: r3(Math.max(1, ...ys) * 2) };
  })();
  const fp = finishFootprint(p.name.trim(), desc, pads, body, { ...(pin1 ? { pin1 } : {}), tags: ['generated', p.family], ...(p.courtyard !== undefined ? { courtyard: p.courtyard } : {}) });
  fp.source = 'project';
  return { ...fp, generator: p } as FootprintSpec;
}
