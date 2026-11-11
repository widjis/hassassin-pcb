/**
 * Turn PCB primitives into triangles (flat [x0,y0,x1,y1,…] arrays in mm).
 */
import earcut from 'earcut';
import type { Vec2 } from '@hassassin/core';

export type Tris = number[];

const circleSegments = (r: number) => Math.max(10, Math.min(48, Math.ceil(r * 24)));

export function circle(out: Tris, c: Vec2, r: number): void {
  if (!(r > 0)) return;
  const n = circleSegments(r);
  let px = c.x + r;
  let py = c.y;
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = c.x + Math.cos(a) * r;
    const y = c.y + Math.sin(a) * r;
    out.push(c.x, c.y, px, py, x, y);
    px = x;
    py = y;
  }
}

export function ring(out: Tris, c: Vec2, rOuter: number, rInner: number): void {
  if (!(rOuter > rInner) || rInner <= 0) return circle(out, c, rOuter);
  const n = circleSegments(rOuter);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const o0x = c.x + Math.cos(a0) * rOuter, o0y = c.y + Math.sin(a0) * rOuter;
    const o1x = c.x + Math.cos(a1) * rOuter, o1y = c.y + Math.sin(a1) * rOuter;
    const i0x = c.x + Math.cos(a0) * rInner, i0y = c.y + Math.sin(a0) * rInner;
    const i1x = c.x + Math.cos(a1) * rInner, i1y = c.y + Math.sin(a1) * rInner;
    out.push(o0x, o0y, o1x, o1y, i0x, i0y, i0x, i0y, o1x, o1y, i1x, i1y);
  }
}

/** Thick line with round caps. */
export function segment(out: Tris, a: Vec2, b: Vec2, w: number, caps = true): void {
  const hw = Math.max(w, 0.01) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) {
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    out.push(a.x + nx, a.y + ny, b.x + nx, b.y + ny, b.x - nx, b.y - ny, a.x + nx, a.y + ny, b.x - nx, b.y - ny, a.x - nx, a.y - ny);
  }
  if (caps) {
    circle(out, a, hw);
    if (len > 1e-9) circle(out, b, hw);
  }
}

export function polyline(out: Tris, pts: Vec2[], w: number, closed: boolean): void {
  for (let i = 0; i + 1 < pts.length; i++) segment(out, pts[i]!, pts[i + 1]!, w);
  if (closed && pts.length > 2) segment(out, pts[pts.length - 1]!, pts[0]!, w);
}

export function fillPolygon(out: Tris, outline: Vec2[], holes: Vec2[][] = []): void {
  if (outline.length < 3) return;
  const flat: number[] = [];
  const holeIdx: number[] = [];
  for (const p of outline) flat.push(p.x, p.y);
  for (const h of holes) {
    if (h.length < 3) continue;
    holeIdx.push(flat.length / 2);
    for (const p of h) flat.push(p.x, p.y);
  }
  const idx = earcut(flat, holeIdx.length ? holeIdx : undefined, 2);
  for (const i of idx) out.push(flat[i * 2]!, flat[i * 2 + 1]!);
}

/** Circle through three points; null when they are collinear. */
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
  const a0 = ang(s);
  let a1 = ang(m);
  let a2 = ang(e);
  // Choose direction so that mid lies between start and end.
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(a2 - a0);
  if (norm(a1 - a0) > sweep) sweep -= 2 * Math.PI;
  a1 = a0;
  a2 = a0 + sweep;
  const n = Math.max(6, Math.ceil((Math.abs(sweep) * r) / 0.2));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a1 + ((a2 - a1) * i) / n;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

/** Rotate a local point (relative to origin) by `deg` in the board's sense, then translate. */
export function place(p: Vec2, origin: Vec2, deg: number): Vec2 {
  if (!deg) return { x: origin.x + p.x, y: origin.y + p.y };
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: origin.x + p.x * c + p.y * s, y: origin.y - p.x * s + p.y * c };
}

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
