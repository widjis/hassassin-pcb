/**
 * Layer stackup and controlled-impedance estimates.
 *
 * Impedance uses the public closed-form approximations (Hammerstad–Jensen for microstrip,
 * the IPC-2141 forms for stripline and edge-coupled pairs). They are typically within
 * ±5–10 % of a field solver; for production impedance control, confirm with the
 * fabricator's own stackup calculator.
 */
import type { Doc } from './model.ts';

export interface StackLayer {
  name: string;
  kind: 'copper' | 'dielectric' | 'mask';
  /** mm */
  thickness: number;
  material?: string;
  /** Relative permittivity (dielectrics, mask). */
  er?: number;
  lossTangent?: number;
  /** Flexible dielectric (polyimide) — for flex and rigid-flex builds. */
  flex?: boolean;
}

export interface Stackup {
  layers: StackLayer[];
  /** Finished board thickness (mm). */
  thickness: number;
}

const cu = (name: string, oz = 1): StackLayer => ({ name, kind: 'copper', thickness: +(0.035 * oz).toFixed(4), material: `${oz} oz copper` });
const di = (name: string, thickness: number, er = 4.4, material = 'FR-4', flex = false): StackLayer => ({ name, kind: 'dielectric', thickness, material, er, lossTangent: flex ? 0.004 : 0.02, ...(flex ? { flex } : {}) });
const mask = (name: string): StackLayer => ({ name, kind: 'mask', thickness: 0.015, material: 'LPI solder mask', er: 3.8 });

/** A typical stackup for the board's copper layers (names in board order: F.Cu, In1.Cu…, B.Cu). */
export function defaultStackup(copper: string[], thickness = 1.6, opts: { flex?: boolean } = {}): Stackup {
  const n = copper.length;
  const layers: StackLayer[] = [mask('F.Mask')];
  if (opts.flex) {
    // Thin polyimide flex: copper / polyimide / copper.
    copper.forEach((c, i) => {
      layers.push(cu(c, 0.5));
      if (i < n - 1) layers.push(di(`Polyimide ${i + 1}`, 0.05, 3.4, 'Polyimide', true));
    });
    layers.push(mask('B.Mask'));
    return { layers: layers.map((l) => (l.kind === 'mask' ? { ...l, material: 'Coverlay', er: 3.4, thickness: 0.025 } : l)), thickness: +layers.reduce((s, l) => s + l.thickness, 0).toFixed(3) };
  }
  if (n <= 1) {
    layers.push(cu(copper[0] ?? 'F.Cu'), di('Core', thickness - 0.035 - 0.03));
  } else if (n === 2) {
    layers.push(cu(copper[0]!), di('Core', +(thickness - 0.07 - 0.03).toFixed(3)), cu(copper[1]!));
  } else {
    // Prepreg near the outer layers, cores in between.
    const inner = n - 2;
    const pre = 0.2;
    const coreTotal = thickness - 0.03 - 2 * 0.035 - inner * 0.0175 - 2 * pre;
    const cores = Math.max(1, inner - 1);
    copper.forEach((c, i) => {
      layers.push(i === 0 || i === n - 1 ? cu(c) : cu(c, 0.5));
      if (i === n - 1) return;
      if (i === 0 || i === n - 2) layers.push(di(`Prepreg ${i + 1}`, pre, 4.2, '7628 prepreg'));
      else layers.push(di(`Core ${i}`, +(coreTotal / cores).toFixed(3), 4.5));
    });
  }
  layers.push(mask('B.Mask'));
  return { layers, thickness: +layers.reduce((s, l) => s + l.thickness, 0).toFixed(3) };
}

export function stackupOf(doc: Doc, copper: string[]): Stackup {
  const s = doc.meta.stackup as Stackup | undefined;
  if (s?.layers?.length) return s;
  const t = [...doc.nodes.values()].find((n) => n.type === 'layout')?.props.Thickness;
  return defaultStackup(copper, typeof t === 'number' ? t : 1.6);
}

export interface LineGeometry {
  kind: 'microstrip' | 'stripline';
  /** Dielectric height to the reference plane (microstrip) or plane-to-plane spacing (stripline). */
  h: number;
  t: number;
  er: number;
  /** Covered by solder mask (microstrip). */
  masked: boolean;
  /** Stripline: dielectric to the nearer and the farther plane (mm). */
  h1?: number;
  h2?: number;
}

/** Geometry of a trace on a copper layer: reference planes are the neighbouring copper layers. */
export function lineGeometry(st: Stackup, layer: string): LineGeometry | null {
  const L = st.layers;
  const i = L.findIndex((l) => l.kind === 'copper' && l.name === layer);
  if (i < 0) return null;
  const t = L[i]!.thickness;
  const side = (dir: 1 | -1) => {
    let h = 0;
    let erSum = 0;
    for (let k = i + dir; k >= 0 && k < L.length; k += dir) {
      const l = L[k]!;
      if (l.kind === 'copper') return { h, er: h ? erSum / h : 4.4, plane: true };
      if (l.kind === 'dielectric') (h += l.thickness), (erSum += (l.er ?? 4.4) * l.thickness);
    }
    return { h, er: h ? erSum / h : 4.4, plane: false };
  };
  const up = side(-1);
  const down = side(1);
  if (up.plane && down.plane) return { kind: 'stripline', h: up.h + down.h + t, t, er: (up.er * up.h + down.er * down.h) / (up.h + down.h), masked: false, h1: Math.min(up.h, down.h), h2: Math.max(up.h, down.h) };
  const ref = up.plane ? up : down;
  return { kind: 'microstrip', h: ref.h, t, er: ref.er, masked: true };
}

/** Single-ended impedance (ohm) of a trace of width w (mm). */
export function impedance(g: LineGeometry, w: number): number {
  if (g.kind === 'stripline') {
    if (g.h1 !== undefined && g.h2 !== undefined && g.h2 > g.h1 * 1.1) {
      // IPC-2141 asymmetric (offset) stripline.
      const z = (80 / Math.sqrt(g.er)) * Math.log((1.9 * (2 * g.h1 + g.t)) / (0.8 * w + g.t)) * (1 - g.h1 / (4 * g.h2));
      return Math.max(1, z);
    }
    // IPC-2141 symmetric stripline.
    const z = (60 / Math.sqrt(g.er)) * Math.log((4 * g.h) / (0.67 * Math.PI * (0.8 * w + g.t)));
    return Math.max(1, z);
  }
  // Hammerstad–Jensen microstrip with a thickness-corrected width.
  const h = g.h;
  const t = g.t;
  const we = w + (t / Math.PI) * Math.log(1 + (4 * Math.E) / ((t / h) * Math.pow(1 / Math.tanh(Math.sqrt(6.517 * (w / h))), 2)));
  const u = we / h;
  const a = 1 + Math.log((Math.pow(u, 4) + Math.pow(u / 52, 2)) / (Math.pow(u, 4) + 0.432)) / 49 + Math.log(1 + Math.pow(u / 18.1, 3)) / 18.7;
  const b = 0.564 * Math.pow((g.er - 0.9) / (g.er + 3), 0.053);
  const eeff = (g.er + 1) / 2 + ((g.er - 1) / 2) * Math.pow(1 + 10 / u, -a * b);
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-Math.pow(30.666 / u, 0.7528));
  let z = (60 / Math.sqrt(eeff)) * Math.log(f / u + Math.sqrt(1 + 4 / (u * u)));
  // Solder mask over the trace lowers impedance by a few percent.
  if (g.masked) z *= 0.97;
  return z;
}

/** Differential impedance of an edge-coupled pair (width w, gap s). */
export function diffImpedance(g: LineGeometry, w: number, s: number): number {
  const z0 = impedance(g, w);
  return g.kind === 'stripline' ? 2 * z0 * (1 - 0.347 * Math.exp((-2.9 * s) / (g.h1 !== undefined ? 2 * g.h1 + g.t : g.h))) : 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * s) / g.h));
}

/** Trace width (mm) for a target impedance; gap given → differential. null when out of range. */
export function widthForImpedance(g: LineGeometry, target: number, gap?: number): number | null {
  const z = (w: number) => (gap !== undefined ? diffImpedance(g, w, gap) : impedance(g, w));
  let lo = 0.03;
  let hi = 5;
  if (z(lo) < target || z(hi) > target) return null;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (z(mid) > target) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 1000;
}
