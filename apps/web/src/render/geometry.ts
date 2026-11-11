/**
 * Tessellation: PCB primitives -> triangles (flat [x0,y0,x1,y1,…] arrays in mm).
 * Shared math (frames, outlines, hit tests) lives in @hassassin/core.
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
