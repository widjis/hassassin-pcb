/**
 * KiCad libraries → parts and footprints.
 *   .kicad_mod  (one footprint)          → FootprintSpec
 *   .kicad_sym  (a library of symbols)   → PartDef[] (one per non-power symbol)
 * Formats are read from KiCad's public file-format documentation and example files.
 * The library files themselves stay on the user's machine; nothing is bundled.
 */
import type { FootprintSpec, FpGraphic, FpPad, PadKind, PadShape, PartDef, PartUnit, Vec2 } from '@hassassin/core';
import { child, children, flag, head, isList, num, parseSExpr, str, type SList } from './sexpr.ts';
import { parseSymbolDefs } from './importSch.ts';

const xy = (l: SList | undefined): Vec2 | undefined => {
  if (!l) return undefined;
  const x = num(l[1]);
  const y = num(l[2]);
  return x === undefined || y === undefined ? undefined : { x, y };
};

const hidden = (l: SList) => flag(l, 'hide') || str(child(l, 'hide')?.[1]) === 'yes' || flag(child(l, 'effects') ?? [], 'hide') || str(child(child(l, 'effects') ?? [], 'hide')?.[1]) === 'yes';

/** Parse one footprint (.kicad_mod text, or a footprint S-list). */
export function parseKicadFootprint(input: string | SList, lib = ''): FootprintSpec {
  const fp = typeof input === 'string' ? parseSExpr(input) : input;
  const h = head(fp);
  if (h !== 'footprint' && h !== 'module') throw new Error('Not a KiCad footprint (expected "(footprint …").');
  const name = str(fp[1]) ?? 'footprint';
  const pads: FpPad[] = [];
  const graphics: FpGraphic[] = [];
  const width = (g: SList) => num(child(child(g, 'stroke') ?? [], 'width')?.[1]) ?? num(child(g, 'width')?.[1]) ?? 0.12;
  const filled = (g: SList) => {
    const f = child(g, 'fill');
    const v = f ? str(f[1]) : undefined;
    return v === 'solid' || v === 'yes' || str(child(f ?? [], 'type')?.[1]) === 'solid';
  };
  for (const e of fp) {
    if (!isList(e)) continue;
    const k = head(e)!;
    const layer = str(child(e, 'layer')?.[1]) ?? '';
    if (k === 'pad') {
      const at = child(e, 'at');
      const t = str(e[2]) ?? 'smd';
      const shape = (str(e[3]) ?? 'rect') as PadShape;
      const type: PadKind = t === 'thru_hole' ? 'through' : t === 'np_thru_hole' ? 'npth' : t === 'connect' ? 'edge' : 'smd';
      const pad: FpPad = {
        number: str(e[1]) ?? '',
        at: xy(at) ?? { x: 0, y: 0 },
        size: xy(child(e, 'size')) ?? { x: 1, y: 1 },
        shape: (['circle', 'rect', 'roundrect', 'oval', 'trapezoid', 'custom'] as const).includes(shape) ? shape : 'rect',
        type,
        layers: (child(e, 'layers') ?? []).slice(1).map((x) => str(x) ?? '').filter(Boolean),
      };
      const rot = num(at?.[3]);
      if (rot) pad.rot = rot;
      const rr = num(child(e, 'roundrect_rratio')?.[1]);
      if (rr !== undefined) pad.cornerRatio = rr;
      const drill = child(e, 'drill');
      if (drill) {
        if (str(drill[1]) === 'oval') {
          const a = num(drill[2]) ?? 0;
          pad.drill = { x: a, y: num(drill[3]) ?? a };
        } else if (num(drill[1]) !== undefined) pad.drill = num(drill[1])!;
      }
      if (shape === 'custom') {
        const poly = children(child(e, 'primitives') ?? [], 'gr_poly')[0];
        const ring = (child(poly ?? [], 'pts') ?? []).filter(isList).map((p) => xy(p)).filter((p): p is Vec2 => !!p);
        if (ring.length >= 3) pad.points = ring;
      }
      pads.push(pad);
    } else if (k === 'fp_line') {
      const a = xy(child(e, 'start'));
      const b = xy(child(e, 'end'));
      if (a && b) graphics.push({ kind: 'line', layer, w: width(e), a, b });
    } else if (k === 'fp_rect') {
      const a = xy(child(e, 'start'));
      const b = xy(child(e, 'end'));
      if (a && b) graphics.push({ kind: 'rect', layer, w: width(e), a, b, ...(filled(e) ? { fill: true } : {}) });
    } else if (k === 'fp_circle') {
      const c = xy(child(e, 'center'));
      const p = xy(child(e, 'end'));
      if (c && p) graphics.push({ kind: 'circle', layer, w: width(e), c, r: Math.hypot(p.x - c.x, p.y - c.y), ...(filled(e) ? { fill: true } : {}) });
    } else if (k === 'fp_arc') {
      const s = xy(child(e, 'start'));
      const m = xy(child(e, 'mid'));
      const en = xy(child(e, 'end'));
      if (s && m && en) graphics.push({ kind: 'arc', layer, w: width(e), s, m, e: en });
    } else if (k === 'fp_poly') {
      const pts = (child(e, 'pts') ?? []).filter(isList).map((p) => xy(p)).filter((p): p is Vec2 => !!p);
      if (pts.length >= 2) graphics.push({ kind: 'poly', layer, w: width(e), pts, ...(filled(e) ? { fill: true } : {}) });
    } else if (k === 'property' || k === 'fp_text') {
      const key = str(e[1]);
      let text: string | undefined;
      if (k === 'property') text = key === 'Reference' ? '%R' : key === 'Value' ? '%V' : undefined;
      else text = key === 'reference' ? '%R' : key === 'value' ? '%V' : str(e[2]);
      const at = child(e, 'at');
      const p = xy(at);
      if (!text || !p || !layer) continue;
      const size = num(child(child(child(e, 'effects') ?? [], 'font') ?? [], 'size')?.[1]) ?? 1;
      graphics.push({ kind: 'text', layer, at: p, text, size, ...(num(at?.[3]) ? { rot: num(at?.[3])! } : {}), ...(hidden(e) ? { hidden: true } : {}) });
    }
  }
  const descr = str(child(fp, 'descr')?.[1]);
  const tags = str(child(fp, 'tags')?.[1]);
  return {
    name: lib ? `${lib}:${name}` : name,
    ...(descr ? { description: descr } : {}),
    ...(tags ? { tags: tags.split(/\s+/).filter(Boolean) } : {}),
    pads,
    graphics,
    source: lib ? `kicad:${lib}` : 'kicad',
  };
}

const PREFIX_FALLBACK = 'U';

/** Parse a .kicad_sym library into parts (power symbols are skipped). */
export function parseKicadSymbolLib(text: string, lib: string, only?: Set<string>): { parts: PartDef[]; warnings: string[] } {
  const root = parseSExpr(text);
  if (head(root) !== 'kicad_symbol_lib') throw new Error('Not a KiCad symbol library (expected "(kicad_symbol_lib …").');
  return partsFromSymbolLists(children(root, 'symbol'), lib, only);
}

/** Parts from top-level symbol S-lists (used for whole files and for indexed chunks). */
export function partsFromSymbolLists(defs: SList[], lib: string, only?: Set<string>): { parts: PartDef[]; warnings: string[] } {
  const warnings: string[] = [];
  const syms = parseSymbolDefs(defs, warnings);
  const rawByName = new Map(defs.map((d) => [str(d[1]) ?? '', d]));
  const parts: PartDef[] = [];
  for (const [name, sym] of syms) {
    if (sym.power || (only && !only.has(name))) continue;
    const raw = rawByName.get(name)!;
    const props: Record<string, string> = {};
    const collect = (d: SList | undefined, depth = 0) => {
      if (!d || depth > 4) return;
      const ext = str(child(d, 'extends')?.[1]);
      if (ext) collect(rawByName.get(ext), depth + 1);
      for (const p of children(d, 'property')) {
        const k = str(p[1]);
        const v = str(p[2]);
        if (k && v !== undefined && v !== '') props[k] = v;
      }
    };
    collect(raw);
    const unitNums = [...new Set(sym.pins.map((p) => p.unit).concat(sym.graphics.map((g) => g.unit)))].filter((u) => u > 0).sort((a, b) => a - b);
    const unitList = unitNums.length ? unitNums : [1];
    const units: PartUnit[] = unitList.map((u) => ({
      graphics: sym.graphics.filter((g) => g.unit === 0 || g.unit === u).map((g) => g.g),
      pins: sym.pins.filter((p) => p.unit === 0 || p.unit === u).map((p) => ({ number: p.number, name: p.name, type: p.type, at: p.at, angle: p.angle, length: p.length, ...(p.hidden ? { hidden: true } : {}) })),
    }));
    const prefix = (props.Reference ?? PREFIX_FALLBACK).replace(/[?\d]+$/, '') || PREFIX_FALLBACK;
    const properties: Record<string, string> = {};
    for (const k of ['Datasheet', 'MPN', 'Manufacturer', 'LCSC', 'Manufacturer Part Number']) if (props[k] && props[k] !== '~') properties[k === 'Manufacturer Part Number' ? 'MPN' : k] = props[k]!;
    parts.push({
      id: `kicad:${lib}:${name}`,
      name,
      ...(props.Description ? { description: props.Description } : {}),
      category: lib,
      keywords: (props.ki_keywords ?? '').split(/\s+/).filter(Boolean),
      prefix,
      value: props.Value ?? name,
      units,
      ...(props.Footprint ? { footprint: props.Footprint } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      source: `kicad:${lib}`,
    });
  }
  return { parts, warnings };
}
