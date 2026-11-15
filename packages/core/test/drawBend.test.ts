/**
 * P6b (docs/05-pcb-improvements.md): bend styles after EAGLE's SET WIRE_BEND and MITER, rounded corners
 * after KiCad's router corner modes.
 */
import { describe, expect, it } from 'vitest';
import { bendPath, piecePoints, roundCorners, type Vec2 } from '@hassassin/core';

const A = { x: 0, y: 0 };
const B = { x: 10, y: 4 };
const dirs = (p: Vec2[]) => p.slice(1).map((q, i) => [Math.sign(Math.round((q.x - p[i]!.x) * 1e6)), Math.sign(Math.round((q.y - p[i]!.y) * 1e6))].join(','));
const deg = (a: Vec2, b: Vec2) => Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
const r = (p: Vec2) => Math.hypot(p.x, p.y);

describe('bend styles (EAGLE SET WIRE_BEND)', () => {
  it('0 horizontal then vertical, 4 vertical then horizontal, 2 straight', () => {
    expect(bendPath(A, B, 0)).toEqual([A, { x: 10, y: 0 }, B]);
    expect(bendPath(A, B, 4)).toEqual([A, { x: 0, y: 4 }, B]);
    expect(bendPath(A, B, 2)).toEqual([A, B]);
  });

  it('1 horizontal then 45°, 3 45° then horizontal', () => {
    const p1 = bendPath(A, B, 1);
    expect(p1).toHaveLength(3);
    expect(deg(p1[0]!, p1[1]!)).toBe(0);
    expect(deg(p1[1]!, p1[2]!)).toBe(45);
    const p3 = bendPath(A, B, 3);
    expect(deg(p3[0]!, p3[1]!)).toBe(45);
    expect(deg(p3[1]!, p3[2]!)).toBe(0);
  });

  it('5 a quarter arc then straight, 6 straight then a quarter arc, ending where asked', () => {
    for (const st of [5, 6]) {
      const p = bendPath(A, B, st);
      expect(p[0]).toEqual(A);
      expect(p.at(-1)).toEqual(B);
      expect(p.length).toBeGreaterThan(4);
    }
    // The arc of style 5 is a quarter circle of radius 4 (the short side) centred at (4, 0).
    const arc = bendPath(A, B, 5).slice(0, -1);
    for (const q of arc) expect(Math.hypot(q.x - 4, q.y)).toBeCloseTo(4, 3);
  });

  it('7 freehand arc leaves tangent to the previous segment and passes through the end', () => {
    const p = bendPath(A, B, 7, { prevDir: { x: 1, y: 0 } });
    expect(p.at(-1)).toEqual(B);
    // First piece runs (nearly) along the previous direction.
    expect(Math.abs(p[1]!.y - p[0]!.y)).toBeLessThan(Math.abs(p[1]!.x - p[0]!.x) * 0.2);
    // Without a previous segment it is straight.
    expect(bendPath(A, B, 7)).toEqual([A, B]);
  });

  it('miter: positive rounds the corner with that radius, negative cuts it (90° styles only)', () => {
    const round = bendPath(A, B, 0, { miter: 2 });
    // The corner (10, 0) is replaced by an arc of radius 2 centred at (8, 2).
    expect(round.some((q) => q.x === 10 && q.y === 0)).toBe(false);
    for (const q of round.slice(1, -1)) expect(Math.hypot(q.x - 8, q.y - 2)).toBeCloseTo(2, 3);
    for (const q of round) expect(q.x <= 10 + 1e-9 && q.y >= -1e-9).toBe(true);
    expect(bendPath(A, B, 0, { miter: -1.5 })).toEqual([A, { x: 8.5, y: 0 }, { x: 10, y: 1.5 }, B]);
    // A straight miter on a 45° style changes nothing (as EAGLE).
    expect(bendPath(A, B, 1, { miter: -1 })).toEqual(bendPath(A, B, 1));
    expect(dirs(bendPath(A, B, 1, { miter: 1 }))[0]).toBe('1,0');
  });
});

describe('rounded corners (KiCad router corner modes)', () => {
  it('a 90° corner becomes an arc tangent to both legs; a refused arc leaves it sharp', () => {
    const pts = [A, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const pieces = roundCorners(pts, 2);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toEqual({ a: A, b: { x: 8, y: 0 } });
    expect(pieces[1]!.mid).toBeDefined();
    expect(Math.hypot(pieces[1]!.mid!.x - 8, pieces[1]!.mid!.y - 2)).toBeCloseTo(2, 4);
    expect(pieces[2]).toEqual({ a: { x: 10, y: 2 }, b: { x: 10, y: 10 } });
    expect(piecePoints(pieces).at(-1)).toEqual({ x: 10, y: 10 });
    // The arc goes the short way round: every point stays inside the corner's box.
    for (const q of piecePoints(pieces)) expect(q.x <= 10 + 1e-9 && q.y >= -1e-9 && q.x >= -1e-9 && q.y <= 10 + 1e-9).toBe(true);
    // And so for a corner turning the other way.
    for (const q of piecePoints(roundCorners([A, { x: 10, y: 0 }, { x: 10, y: -10 }], 2))) expect(q.x <= 10 + 1e-9 && q.y <= 1e-9).toBe(true);
    expect(roundCorners(pts, 2, () => false)).toEqual([{ a: A, b: { x: 10, y: 0 } }, { a: { x: 10, y: 0 }, b: { x: 10, y: 10 } }]);
    // Short legs: the radius shrinks so the arc takes at most half of each leg.
    const tight = roundCorners([A, { x: 1, y: 0 }, { x: 1, y: 1 }], 5);
    expect(r(tight[0]!.b)).toBeCloseTo(0.5, 6);
  });
});
