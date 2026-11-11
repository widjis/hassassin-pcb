/**
 * Physical quantities. Internally every length is stored in millimetres and every
 * angle in degrees; units only exist at the edges (parsing user input, formatting).
 */

export const LENGTH_UNITS: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  um: 0.001,
  'µm': 0.001,
  nm: 0.000001,
  mil: 0.0254,
  mils: 0.0254,
  thou: 0.0254,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
};

export const ANGLE_UNITS: Readonly<Record<string, number>> = {
  deg: 1,
  '°': 1,
  rad: 180 / Math.PI,
  turn: 360,
};

export type QuantityKind = 'length' | 'angle';

const QUANTITY_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-zµ°]*)\s*$/i;

/**
 * Parse "10mil", "0.5 mm", "90deg", "1.2" (bare numbers use `defaultUnit`).
 * Returns the value in canonical units (mm or deg), or null when it does not parse.
 */
export function parseQuantity(input: string, kind: QuantityKind, defaultUnit?: string): number | null {
  const m = QUANTITY_RE.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const table = kind === 'length' ? LENGTH_UNITS : ANGLE_UNITS;
  const unit = (m[2] ?? '') || defaultUnit || (kind === 'length' ? 'mm' : 'deg');
  const factor = table[unit] ?? table[unit.toLowerCase()];
  if (factor === undefined) return null;
  return n * factor;
}

export function parseLength(input: string | number, defaultUnit = 'mm'): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input * (LENGTH_UNITS[defaultUnit] ?? 1) : null;
  return parseQuantity(input, 'length', defaultUnit);
}

export function parseAngle(input: string | number, defaultUnit = 'deg'): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input * (ANGLE_UNITS[defaultUnit] ?? 1) : null;
  return parseQuantity(input, 'angle', defaultUnit);
}

/** Trim float noise: 0.30000000000000004 -> "0.3". */
export function trimNumber(n: number, maxDecimals = 4): string {
  if (!Number.isFinite(n)) return String(n);
  const s = n.toFixed(maxDecimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function formatLength(mm: number, unit = 'mm'): string {
  const f = LENGTH_UNITS[unit] ?? 1;
  return `${trimNumber(mm / f)}${unit}`;
}

export function formatAngle(deg: number, unit = 'deg'): string {
  const f = ANGLE_UNITS[unit] ?? 1;
  return unit === 'deg' ? `${trimNumber(deg / f, 2)}°` : `${trimNumber(deg / f)}${unit}`;
}
