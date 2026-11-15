/**
 * Bend styles for drawing outlines and lines (docs/05-pcb-improvements.md, P6b), after EAGLE's documented
 * `SET WIRE_BEND` styles and `MITER` command (EAGLE help: SET, WIRE, POLYGON, MITER):
 *   0 horizontal then vertical · 1 horizontal then 45° · 2 straight · 3 45° then horizontal
 *   4 vertical then horizontal · 5 arc then horizontal · 6 horizontal then arc · 7 freehand arc
 * ("horizontal" is the longer axis when the other way cannot reach the end).
 * Miter: a radius at the corner of the 90° and 45° styles; positive rounds it (an arc), negative cuts it
 * straight (only for the 90° styles, as EAGLE).
 */
import type { Vec2 } from './model.ts';

export const BEND_STYLES: { n: number; label: string; short: string }[] = [
  { n: 0, label: 'Horizontal, then vertical', short: '⌐ 90°' },
  { n: 1, label: 'Horizontal, then 45°', short: '⌐ 45°' },
  { n: 2, label: 'Straight (any angle)', short: '/ any' },
  { n: 3, label: '45°, then horizontal', short: '45° ⌐' },
  { n: 4, label: 'Vertical, then horizontal', short: '90° ⌐' },
  { n: 5, label: 'Arc, then horizontal', short: '◜ arc' },
  { n: 6, label: 'Horizontal, then arc', short: 'arc ◝' },
  { n: 7, label: 'Freehand arc', short: '~ arc' },
];

/** EAGLE's Ctrl + right button: the corresponding style (the same bend the other way round). */
export const BEND_PARTNER: Record<number, number> = { 0: 4, 4: 0, 1: 3, 3: 1, 5: 6, 6: 5, 2: 2, 7: 7 };

const sgn = (v: number) => (v < 0 ? -1 : 1);
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const unit = (v: Vec2): Vec2 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};
const r4 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/** Points of an arc of the circle centred at c from a to b, turning counter-clockwise (+1) or clockwise (−1). */
function arc(c: Vec2, a: Vec2, b: Vec2, turn: 1 | -1): Vec2[] {
  const r = len(sub(a, c));
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  let a1 = Math.atan2(b.y - c.y, b.x - c.x);
  let sweep = a1 - a0;
  if (turn > 0) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  a1 = a0 + sweep;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = a0 + (sweep * i) / steps;
    out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r });
  }
  out[out.length - 1] = b;
  return out;
}

/** A quarter arc from a (leaving along `dir`) to b, the corner of the square they span being turned. */
function quarter(a: Vec2, b: Vec2, along: 'x' | 'y'): Vec2[] {
  // Leaving a along x: the centre lies straight across from a in y, level with b in y … i.e. (a.x, b.y);
  // leaving along y: (b.x, a.y).
  const c = along === 'x' ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  const cross = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x);
  return arc(c, a, b, cross > 0 ? 1 : -1);
}

/** Round (r > 0) or cut (r < 0) the corner `c` between a → c and c → b. */
function miterCorner(a: Vec2, c: Vec2, b: Vec2, r: number, ninety: boolean): Vec2[] {
  const u1 = unit(sub(c, a));
  const u2 = unit(sub(b, c));
  const turnAngle = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
  if (!r || turnAngle < 1e-6 || len(sub(c, a)) < 1e-9 || len(sub(b, c)) < 1e-9) return [c];
  if (r < 0 && !ninety) return [c];
  const room = Math.min(len(sub(c, a)), len(sub(b, c)));
  if (r < 0) {
    const s = Math.min(-r, room);
    return [{ x: c.x - u1.x * s, y: c.y - u1.y * s }, { x: c.x + u2.x * s, y: c.y + u2.y * s }];
  }
  // Fillet: tangent length t = r · tan(φ/2), at most the room on either side.
  let t = r * Math.tan(turnAngle / 2);
  let rr = r;
  if (t > room) (t = room), (rr = room / Math.tan(turnAngle / 2));
  const p1 = { x: c.x - u1.x * t, y: c.y - u1.y * t };
  const p2 = { x: c.x + u2.x * t, y: c.y + u2.y * t };
  const turn = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : -1;
  const n1 = turn > 0 ? { x: -u1.y, y: u1.x } : { x: u1.y, y: -u1.x };
  const centre = { x: p1.x + n1.x * rr, y: p1.y + n1.y * rr };
  return arc(centre, p1, p2, turn);
}

/**
 * The path from `from` to `to` for a bend style, including both ends. `prevDir` (the direction the
 * previous segment arrived in) is used by the freehand arc (7), which leaves tangent to it; `miter` rounds
 * or cuts the corner of styles 0, 1, 3 and 4.
 */
export function bendPath(from: Vec2, to: Vec2, style: number, opts: { prevDir?: Vec2; miter?: number } = {}): Vec2[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 1e-9 && ay < 1e-9) return [from];
  const withCorner = (c: Vec2, ninety: boolean) => {
    if (len(sub(c, from)) < 1e-9 || len(sub(to, c)) < 1e-9) return [from, to];
    return [from, ...miterCorner(from, c, to, opts.miter ?? 0, ninety), to];
  };
  let out: Vec2[];
  switch (style) {
    case 0:
      out = withCorner({ x: to.x, y: from.y }, true);
      break;
    case 4:
      out = withCorner({ x: from.x, y: to.y }, true);
      break;
    case 1:
      out = ax >= ay ? withCorner({ x: to.x - sgn(dx) * ay, y: from.y }, false) : withCorner({ x: from.x, y: to.y - sgn(dy) * ax }, false);
      break;
    case 3:
      out = ax >= ay ? withCorner({ x: from.x + sgn(dx) * ay, y: to.y }, false) : withCorner({ x: to.x, y: from.y + sgn(dy) * ax }, false);
      break;
    case 5: {
      // A quarter arc across the short side, then straight along the long one.
      const r = Math.min(ax, ay);
      if (r < 1e-9) return [from, to];
      const e = { x: from.x + sgn(dx) * r, y: from.y + sgn(dy) * r };
      out = [...quarter(from, e, ax >= ay ? 'y' : 'x'), to];
      break;
    }
    case 6: {
      const r = Math.min(ax, ay);
      if (r < 1e-9) return [from, to];
      const s = { x: to.x - sgn(dx) * r, y: to.y - sgn(dy) * r };
      out = [from, ...quarter(s, to, ax >= ay ? 'x' : 'y')];
      break;
    }
    case 7: {
      const t = opts.prevDir && len(opts.prevDir) > 1e-9 ? unit(opts.prevDir) : null;
      if (!t) return [from, to];
      const d = sub(to, from);
      const n = { x: -t.y, y: t.x };
      const k = d.x * n.x + d.y * n.y;
      if (Math.abs(k) < 1e-9) return [from, to];
      // The circle tangent to t at `from` through `to`: centre from + n·R with R = |d|² / (2 d·n).
      const R = (d.x * d.x + d.y * d.y) / (2 * k);
      const c = { x: from.x + n.x * R, y: from.y + n.y * R };
      out = arc(c, from, to, R > 0 ? 1 : -1);
      break;
    }
    default:
      out = [from, to];
  }
  return out.map((p, i) => (i === 0 ? from : i === out.length - 1 ? to : r4(p)));
}

export interface PathPiece {
  a: Vec2;
  b: Vec2;
  /** A point on the arc, for a rounded corner (a trace's `mid`). */
  mid?: Vec2;
}

/**
 * The corners of a polyline rounded with radius `r` (less where the neighbouring segments are short:
 * at most half of each), as straight pieces and arcs (KiCad's rounded corner modes). `ok` may refuse an
 * arc (e.g. it would break clearance); that corner then stays sharp.
 */
export function roundCorners(pts: Vec2[], r: number, ok: (arc: Vec2[]) => boolean = () => true): PathPiece[] {
  if (pts.length < 3 || r <= 0) return pts.slice(1).map((b, i) => ({ a: pts[i]!, b }));
  const out: PathPiece[] = [];
  let start = pts[0]!;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1]!;
    const c = pts[i]!;
    const b = pts[i + 1]!;
    const u1 = unit(sub(c, a));
    const u2 = unit(sub(b, c));
    const phi = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)));
    const room = Math.min(len(sub(c, a)), len(sub(b, c))) / 2;
    let t = r * Math.tan(phi / 2);
    let rr = r;
    if (phi < 1e-6 || phi > Math.PI - 1e-3) {
      out.push({ a: start, b: c });
      start = c;
      continue;
    }
    if (t > room) (t = room), (rr = room / Math.tan(phi / 2));
    const p1 = r4({ x: c.x - u1.x * t, y: c.y - u1.y * t });
    const p2 = r4({ x: c.x + u2.x * t, y: c.y + u2.y * t });
    const turn = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : -1;
    const n1 = turn > 0 ? { x: -u1.y, y: u1.x } : { x: u1.y, y: -u1.x };
    const centre = { x: p1.x + n1.x * rr, y: p1.y + n1.y * rr };
    const m = unit(sub(c, centre));
    const mid = r4({ x: centre.x + m.x * rr, y: centre.y + m.y * rr });
    const sampled = arc(centre, p1, p2, turn as 1 | -1);
    if (!ok(sampled)) {
      out.push({ a: start, b: c });
      start = c;
      continue;
    }
    if (len(sub(p1, start)) > 1e-6) out.push({ a: start, b: p1 });
    out.push({ a: p1, b: p2, mid });
    start = p2;
  }
  out.push({ a: start, b: pts[pts.length - 1]! });
  return out;
}

/** Points along pieces (arcs sampled), for drawing a preview or checking clearance. */
export function piecePoints(pieces: PathPiece[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pieces) {
    const pts = p.mid ? arcThrough(p.a, p.mid, p.b) : [p.a, p.b];
    for (const q of out.length ? pts.slice(1) : pts) out.push(q);
  }
  return out;
}

/** Points of the arc through a, m and b. */
function arcThrough(a: Vec2, m: Vec2, b: Vec2): Vec2[] {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-12) return [a, b];
  const ux = ((a.x * a.x + a.y * a.y) * (m.y - b.y) + (m.x * m.x + m.y * m.y) * (b.y - a.y) + (b.x * b.x + b.y * b.y) * (a.y - m.y)) / d;
  const uy = ((a.x * a.x + a.y * a.y) * (b.x - m.x) + (m.x * m.x + m.y * m.y) * (a.x - b.x) + (b.x * b.x + b.y * b.y) * (m.x - a.x)) / d;
  const c = { x: ux, y: uy };
  // a → m → b turns counter-clockwise (in x, y) when m lies to the right of the chord a → b.
  const cross = (m.x - a.x) * (b.y - a.y) - (m.y - a.y) * (b.x - a.x);
  return arc(c, a, b, cross > 0 ? 1 : -1);
}
