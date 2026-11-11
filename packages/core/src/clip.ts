/**
 * Polygon boolean/offset engine (Clipper 6 compiled to WebAssembly, MIT licence).
 * The native module loads asynchronously, so apps call `setClipper()` once at start-up
 * with an instance from `loadNativeClipperLibInstanceAsync` (web or universal build).
 * Everything here works in integer units of 0.1 µm.
 */
import type { ClipperLibWrapper, IntPoint } from 'js-angusj-clipper';
import type { Vec2 } from './model.ts';

export const SCALE = 10000;
/** Max deviation of generated arcs from a true circle: 5 µm. */
const ARC_TOL = 0.005 * SCALE;
/** Added to every clearance so polygonal arcs never come closer than the true circle. */
export const ARC_MARGIN = 0.01;

export type IPath = IntPoint[];
export type IPaths = IntPoint[][];

let lib: ClipperLibWrapper | null = null;

export function setClipper(instance: ClipperLibWrapper): void {
  lib = instance;
}

export function hasClipper(): boolean {
  return lib !== null;
}

function L(): ClipperLibWrapper {
  if (!lib) throw new Error('The geometry engine is not loaded yet.');
  return lib;
}

export const toIPath = (pts: Vec2[]): IPath => pts.map((v) => ({ x: Math.round(v.x * SCALE), y: Math.round(v.y * SCALE) }));
export const fromIPath = (p: IPath): Vec2[] => p.map((q) => ({ x: q.x / SCALE, y: q.y / SCALE }));

/** Closed outlines with consistent outer orientation, so offsets grow them. */
export function toIAreas(list: Vec2[][]): IPaths {
  const lb = L();
  return list
    .filter((l) => l.length >= 3)
    .map((l) => {
      const p = toIPath(l);
      return lb.orientation(p) ? p : p.reverse();
    });
}

export function union(paths: IPaths): IPaths {
  if (!paths.length) return [];
  return L().clipToPaths({ clipType: 'union' as never, subjectInputs: [{ data: paths, closed: true }], subjectFillType: 'nonZero' as never }) ?? [];
}

export function difference(a: IPaths, b: IPaths): IPaths {
  if (!a.length) return [];
  if (!b.length) return a;
  return (
    L().clipToPaths({
      clipType: 'difference' as never,
      subjectInputs: [{ data: a, closed: true }],
      clipInputs: [{ data: b }],
      subjectFillType: 'nonZero' as never,
      clipFillType: 'nonZero' as never,
    }) ?? []
  );
}

export function intersect(a: IPaths, b: IPaths): IPaths {
  if (!a.length || !b.length) return [];
  return (
    L().clipToPaths({
      clipType: 'intersection' as never,
      subjectInputs: [{ data: a, closed: true }],
      clipInputs: [{ data: b }],
      subjectFillType: 'nonZero' as never,
      clipFillType: 'nonZero' as never,
    }) ?? []
  );
}

/** Grow (or shrink, if negative) closed areas by `mm`. */
export function offsetAreas(paths: IPaths, mm: number, join: 'round' | 'miter' = 'round'): IPaths {
  if (!paths.length) return [];
  return L().offsetToPaths({ delta: mm * SCALE, arcTolerance: ARC_TOL, offsetInputs: [{ data: paths, joinType: join as never, endType: 'closedPolygon' as never }] }) ?? [];
}

/** Round-capped band of half-width `mm` around an open path (a single point gives a circle). */
export function offsetLine(path: IPath, mm: number): IPaths {
  const data = path.length === 1 ? [path[0]!, path[0]!] : path;
  return L().offsetToPaths({ delta: mm * SCALE, arcTolerance: ARC_TOL, offsetInputs: [{ data, joinType: 'round' as never, endType: 'openRound' as never }] }) ?? [];
}

/** Outer rings are oriented one way and holes the other. */
export function isOuter(p: IPath): boolean {
  return L().orientation(p);
}
