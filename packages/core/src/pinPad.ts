/**
 * Pin ↔ pad check (S20): does every symbol pin of a part have a footprint pad with the same
 * number, and every pad a pin?
 *
 * - Pins: all units of the reference together (a pin shared by several units counts once).
 * - Pads: numbered pads of the footprint (one number may have several pads, e.g. an exposed pad
 *   with thermal vias). Unnumbered pads and bare (NPTH) holes are mechanical and never need a pin.
 * - Pads that need no pin can be listed on the part (property `MechanicalPads`, e.g. "MP1, MP2, 25"),
 *   or carry a mechanical name (MP…, SH…, SHIELD…, MH…, ""), as mounting tabs and shields do.
 * - The footprint is the one on the board when the part is there (not a placeholder), else the one
 *   the schematic names, resolved through `resolve` (project and generic footprints by default).
 */
import type { Doc, DocNode } from './model.ts';
import type { FootprintSpec } from './footprints.ts';
import { resolveFootprintLocal } from './parts.ts';

export interface PinPadFinding {
  ref: string;
  footprint: string;
  /** Symbol pins without a pad of that number (connections that cannot reach the board). */
  pinsWithoutPad: string[];
  /** Footprint pads without a pin (left unconnected on the board). */
  padsWithoutPin: string[];
  pinCount: number;
  padCount: number;
  /** One symbol of the part, for markers and selection. */
  symbol: string;
}

/** Pad numbers that are mechanical by name (mounting tabs, shields, holes). */
export const MECHANICAL_PAD = /^(MP|SH|SHIELD|MH|MNT|TAB|EH)\d*$/i;

const splitList = (v: unknown): string[] => String(v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Pad numbers of the board component of `ref`, or null when it is not on the board / a placeholder. */
function boardPads(doc: Doc, ref: string): { pads: { number: string; npth: boolean }[]; footprint: string } | null {
  for (const n of doc.nodes.values()) {
    if (n.type !== 'element' || n.name !== ref || n.props.placeholder) continue;
    const pads: { number: string; npth: boolean }[] = [];
    for (const c of n.children) {
      const p = doc.nodes.get(c);
      if (p?.type !== 'pad') continue;
      const type = p.rules.find((r) => r.name === 'padType')?.value;
      pads.push({ number: String(p.props.number ?? p.name ?? ''), npth: type === 'npth' });
    }
    return { pads, footprint: String(n.props.Footprint ?? '') };
  }
  return null;
}

/** The check for every part (or one reference). Parts whose footprint is unknown are skipped. */
export function pinPadCheck(doc: Doc, opts: { resolve?: (name: string) => FootprintSpec | null; ref?: string } = {}): PinPadFinding[] {
  const resolve = opts.resolve ?? ((name: string) => resolveFootprintLocal(doc, name));
  const parts = new Map<string, { pins: Set<string>; footprint: string; mechanical: Set<string>; symbol: string }>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const ref = String(n.props.ref ?? n.name);
    if (opts.ref && ref !== opts.ref) continue;
    const part = parts.get(ref) ?? { pins: new Set<string>(), footprint: '', mechanical: new Set<string>(), symbol: n.uid };
    part.footprint ||= String(n.props.Footprint ?? '');
    for (const m of splitList(n.props.MechanicalPads)) part.mechanical.add(m);
    for (const c of n.children) {
      const p: DocNode | undefined = doc.nodes.get(c);
      if (p?.type === 'pin') part.pins.add(String(p.props.number ?? p.name));
    }
    parts.set(ref, part);
  }
  const out: PinPadFinding[] = [];
  for (const [ref, part] of parts) {
    let pads: { number: string; npth: boolean }[];
    let footprint = part.footprint;
    // The board's copy, unless the schematic already names another footprint (not synced yet).
    const board = boardPads(doc, ref);
    const base = (s: string) => s.split(':').pop() ?? s;
    const fp = !board || (footprint && base(board.footprint) !== base(footprint)) ? (footprint ? resolve(footprint) : null) : null;
    if (fp) pads = fp.pads.map((p) => ({ number: p.number, npth: p.type === 'npth' }));
    else if (board) ((pads = board.pads), (footprint = board.footprint || footprint));
    else continue; // unknown footprint: Update PCB reports it
    const padNumbers = new Set(pads.filter((p) => !p.npth && p.number).map((p) => p.number));
    const needed = [...padNumbers].filter((n) => !part.mechanical.has(n) && !MECHANICAL_PAD.test(n));
    const pinsWithoutPad = [...part.pins].filter((n) => !padNumbers.has(n)).sort(byNumber);
    const padsWithoutPin = needed.filter((n) => !part.pins.has(n)).sort(byNumber);
    if (!pinsWithoutPad.length && !padsWithoutPin.length) continue;
    out.push({ ref, footprint, pinsWithoutPad, padsWithoutPin, pinCount: part.pins.size, padCount: needed.length, symbol: part.symbol });
  }
  return out.sort((a, b) => byNumber(a.ref, b.ref));
}

/** One line per finding, for reports. */
export function describePinPad(f: PinPadFinding): string[] {
  const out: string[] = [];
  const list = (xs: string[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(', ')} … (${xs.length})` : xs.join(', '));
  const counts = `symbol ${f.pinCount} pin${f.pinCount === 1 ? '' : 's'}, footprint ${f.footprint || '?'} ${f.padCount} pad${f.padCount === 1 ? '' : 's'}`;
  if (f.pinsWithoutPad.length) out.push(`${f.ref}: pin${f.pinsWithoutPad.length > 1 ? 's' : ''} ${list(f.pinsWithoutPad)} ha${f.pinsWithoutPad.length > 1 ? 've' : 's'} no pad on the footprint, so ${f.pinsWithoutPad.length > 1 ? 'they' : 'it'} cannot be connected on the board (${counts})`);
  if (f.padsWithoutPin.length) out.push(`${f.ref}: pad${f.padsWithoutPin.length > 1 ? 's' : ''} ${list(f.padsWithoutPin)} ha${f.padsWithoutPin.length > 1 ? 've' : 's'} no symbol pin and will stay unconnected (${counts}); add the pin, or list the pad in MechanicalPads if it is a mounting / no-connect pad`);
  return out;
}
