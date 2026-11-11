/** Plain 2D geometry shared by rendering, connectivity and tools. Units: mm, degrees. */
import type { Vec2 } from './model.ts';

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const emptyBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

export function growBox(b: BBox, x: number, y: number, pad = 0): void {
  if (x - pad < b.minX) b.minX = x - pad;
  if (y - pad < b.minY) b.minY = y - pad;
  if (x + pad > b.maxX) b.maxX = x + pad;
  if (y + pad > b.maxY) b.maxY = y + pad;
}

export const boxValid = (b: BBox) => Number.isFinite(b.minX) && Number.isFinite(b.maxX);

/**
 * Rotate `p` by `deg` and translate by `origin`. Positive angles turn counter-clockwise
 * as seen on screen (Y pointing down), which is the convention of the imported files.
 */
export function place(p: Vec2, origin: Vec2, deg: number): Vec2 {
  if (!deg) return { x: origin.x + p.x, y: origin.y + p.y };
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: origin.x + p.x * c + p.y * s, y: origin.y - p.x * s + p.y * c };
}

/** Inverse of `place`. */
export function unplace(p: Vec2, origin: Vec2, deg: number): Vec2 {
  const d = { x: p.x - origin.x, y: p.y - origin.y };
  if (!deg) return d;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: d.x * c - d.y * s, y: d.x * s + d.y * c };
}

export function circleFrom3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
}

/** Points along the arc start → mid → end. */
export function arcPoints(s: Vec2, m: Vec2, e: Vec2): Vec2[] {
  const circ = circleFrom3(s, m, e);
  if (!circ) return [s, e];
  const { c, r } = circ;
  const ang = (p: Vec2) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(s);
  let sweep = norm(ang(e) - a0);
  if (norm(ang(m) - a0) > sweep) sweep -= 2 * Math.PI;
  const n = Math.max(6, Math.ceil((Math.abs(sweep) * r) / 0.2));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

const circleSegments = (r: number) => Math.max(10, Math.min(48, Math.ceil(r * 24)));

export function roundedRectPoints(w: number, h: number, radius: number): Vec2[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const hw = w / 2;
  const hh = h / 2;
  if (r < 1e-6) return [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  }
  return out;
}

/** Pad copper outline centred on (0,0), unrotated. */
export function padOutline(shape: string, size: Vec2, cornerRatio: number): Vec2[] {
  const w = size.x;
  const h = size.y;
  switch (shape) {
    case 'circle': {
      const r = Math.min(w, h) / 2;
      const n = circleSegments(r);
      return Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * Math.PI * 2) * r, y: Math.sin((i / n) * Math.PI * 2) * r }));
    }
    case 'oval':
      return roundedRectPoints(w, h, Math.min(w, h) / 2);
    case 'roundrect':
    case 'chamfered':
      return roundedRectPoints(w, h, Math.min(w, h) * cornerRatio);
    default:
      return roundedRectPoints(w, h, 0);
  }
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

export function snapToGrid(p: Vec2, step: number): Vec2 {
  if (!(step > 0)) return p;
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

/**
 * Two-segment route from a to b: one 45° leg and one straight leg ("posture").
 * `diagonalFirst` chooses which leg comes first.
 */
export function route45(a: Vec2, b: Vec2, diagonalFirst: boolean): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 1e-9 || ady < 1e-9 || Math.abs(adx - ady) < 1e-9) return [a, b];
  const d = Math.min(adx, ady);
  const diag = { x: Math.sign(dx) * d, y: Math.sign(dy) * d };
  const mid = diagonalFirst ? { x: a.x + diag.x, y: a.y + diag.y } : { x: b.x - diag.x, y: b.y - diag.y };
  return [a, mid, b];
}
