/**
 * Project ERC settings (S17), kept in the document's meta so they are undoable, shared with
 * collaborators and saved with the project:
 *   - `ercPinMatrix`: overrides of the pin-type matrix, `{"output|output": "error", …}`;
 *   - `ercSeverity`: per check, `error`, `warning` or `ignore`;
 *   - `ercOptions`: `{ powerSymbolsNeedSource }`;
 *   - `ercWaivers`: violations accepted with a reason, by violation id.
 * The default matrix is written from what each pin type means electrically (two drivers fight, a
 * no-connect pin must stay alone, an unspecified pin cannot be checked).
 */
import type { Op } from './commands.ts';
import type { Doc } from './model.ts';

import type { PinType } from './symbolEditor.ts';

/** Pin types in the order the matrix shows them. */
export const ERC_PIN_TYPES: readonly PinType[] = ['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect'];
const PIN_TYPES = ERC_PIN_TYPES;
export type ErcLevel = 'ok' | 'warning' | 'error';
export type ErcSeverityOverride = 'error' | 'warning' | 'ignore';

export interface ErcWaiver {
  reason: string;
  by?: string;
  at: string;
  /** What the violation said when it was waived. */
  message?: string;
}

export const PIN_TYPE_LABEL: Record<PinType, string> = {
  input: 'Input',
  output: 'Output',
  bidirectional: 'Bidirectional',
  tri_state: 'Tri-state',
  passive: 'Passive',
  free: 'Free',
  unspecified: 'Unspecified',
  power_in: 'Power input',
  power_out: 'Power output',
  open_collector: 'Open collector',
  open_emitter: 'Open emitter',
  no_connect: 'Not connected',
};

/** A pin type as stored ("tri state", "unconnected" …) in matrix terms. */
export function pinTypeOf(t: string): PinType {
  const s = t.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'unconnected') return 'no_connect';
  return (PIN_TYPES as readonly string[]).includes(s) ? (s as PinType) : 'unspecified';
}

const key = (a: PinType, b: PinType) => (PIN_TYPES.indexOf(a) <= PIN_TYPES.indexOf(b) ? `${a}|${b}` : `${b}|${a}`);

/**
 * The built-in level for two pin types on one net. Matches what KiCad 10's ERC reports for each pair
 * by default (checked pair by pair with kicad-cli: 78 pairs of the 12 types).
 */
export function defaultPinLevel(a: PinType, b: PinType): ErcLevel {
  const has = (t: PinType) => a === t || b === t;
  const both = (x: PinType, y: PinType) => (a === x && b === y) || (a === y && b === x);
  if (has('no_connect')) return 'warning'; // a pin that should stay unconnected is connected
  if (has('free')) return 'ok';
  if (has('unspecified')) return 'warning'; // nothing can be checked
  if (has('passive')) return 'ok';
  const strong = (t: PinType) => t === 'output' || t === 'power_out';
  const open = (t: PinType) => t === 'open_collector' || t === 'open_emitter';
  // Two pins that both force the level fight each other.
  if (strong(a) && strong(b)) return 'error';
  if ((strong(a) && open(b)) || (strong(b) && open(a))) return 'error';
  if (both('power_out', 'tri_state')) return 'error';
  if (both('output', 'tri_state') || both('power_out', 'bidirectional')) return 'warning';
  if (both('bidirectional', 'open_emitter')) return 'warning';
  if (has('tri_state') && (has('power_in') || has('open_collector') || has('open_emitter'))) return 'warning';
  return 'ok';
}

export interface ErcSettings {
  level(a: PinType, b: PinType): ErcLevel;
  /** Entries changed from the default. */
  matrix: Record<string, ErcLevel>;
  severity: Record<string, ErcSeverityOverride>;
  powerSymbolsNeedSource: boolean;
  waivers: Record<string, ErcWaiver>;
}

const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {});

export function ercSettings(doc: Doc | null | undefined): ErcSettings {
  const matrix = obj<ErcLevel>(doc?.meta?.ercPinMatrix);
  const severity = obj<ErcSeverityOverride>(doc?.meta?.ercSeverity);
  const options = obj<unknown>(doc?.meta?.ercOptions);
  return {
    level: (a, b) => matrix[key(a, b)] ?? defaultPinLevel(a, b),
    matrix,
    severity,
    powerSymbolsNeedSource: options.powerSymbolsNeedSource === true,
    waivers: obj<ErcWaiver>(doc?.meta?.ercWaivers),
  };
}

/** Op that sets one matrix entry (both orders); `null` goes back to the default. */
export function setPinLevelOp(doc: Doc, a: PinType, b: PinType, level: ErcLevel | null): Op {
  const m = { ...obj<ErcLevel>(doc.meta.ercPinMatrix) };
  const k = key(a, b);
  if (level === null || level === defaultPinLevel(a, b)) delete m[k];
  else m[k] = level;
  return { op: 'setMeta', key: 'ercPinMatrix', value: Object.keys(m).length ? m : null };
}

/** Op that sets how one check reports (`null`: as built in). */
export function setErcSeverityOp(doc: Doc, kind: string, level: ErcSeverityOverride | null): Op {
  const m = { ...obj<ErcSeverityOverride>(doc.meta.ercSeverity) };
  if (level === null) delete m[kind];
  else m[kind] = level;
  return { op: 'setMeta', key: 'ercSeverity', value: Object.keys(m).length ? m : null };
}

export function setErcOptionOp(doc: Doc, name: 'powerSymbolsNeedSource', value: boolean): Op {
  return { op: 'setMeta', key: 'ercOptions', value: { ...obj<unknown>(doc.meta.ercOptions), [name]: value } };
}

/** Op that accepts one violation (by its id) with a reason; it then no longer counts as a problem. */
export function waiveOp(doc: Doc, id: string, reason: string, by?: string, message?: string): Op {
  if (!reason.trim()) throw new Error('A waiver needs a reason');
  const w = { ...obj<ErcWaiver>(doc.meta.ercWaivers) };
  w[id] = { reason: reason.trim(), ...(by ? { by } : {}), at: new Date().toISOString(), ...(message ? { message } : {}) };
  return { op: 'setMeta', key: 'ercWaivers', value: w };
}

export function unwaiveOp(doc: Doc, id: string): Op {
  const w = { ...obj<ErcWaiver>(doc.meta.ercWaivers) };
  delete w[id];
  return { op: 'setMeta', key: 'ercWaivers', value: Object.keys(w).length ? w : null };
}
