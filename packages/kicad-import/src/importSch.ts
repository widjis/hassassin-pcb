/**
 * Import KiCad schematics (.kicad_sch, format 2021+) into a document, following
 * hierarchical sheets. The file format is read from KiCad's public documentation and
 * from example files; no KiCad code is used.
 *
 * Library coordinates have Y pointing up; the document uses Y down, so library points
 * are flipped when stored as symbol-local coordinates.
 */
import { addNode, createDoc, symToSheet, systemDefaults, type Doc, type DocNode, type Mirror, type PropValue, type RuleDecl, type Vec2 } from '@hassassin/core';
import { child, children, flag, head, isList, num, parseSExpr, str, type SList } from './sexpr.ts';

export type SymGraphic =
  | { t: 'poly'; pts: Vec2[]; fill: boolean; w: number }
  | { t: 'rect'; a: Vec2; b: Vec2; fill: boolean; w: number }
  | { t: 'circle'; c: Vec2; r: number; fill: boolean; w: number }
  | { t: 'arc'; s: Vec2; m: Vec2; e: Vec2; w: number }
  | { t: 'text'; at: Vec2; text: string; size: number };

export interface LibPin {
  unit: number;
  at: Vec2;
  angle: number;
  length: number;
  type: string;
  name: string;
  number: string;
  hidden: boolean;
}

export interface LibSymbol {
  name: string;
  power: boolean;
  pins: LibPin[];
  graphics: { unit: number; g: SymGraphic }[];
}

export interface SchImportResult {
  doc: Doc;
  sheets: number;
  symbols: number;
  warnings: string[];
}

const up = (l: SList | undefined): Vec2 | undefined => {
  if (!l) return undefined;
  const x = num(l[1]);
  const y = num(l[2]);
  return x === undefined || y === undefined ? undefined : { x, y: -y };
};
const at = (l: SList | undefined): Vec2 | undefined => {
  if (!l) return undefined;
  const x = num(l[1]);
  const y = num(l[2]);
  return x === undefined || y === undefined ? undefined : { x, y };
};
const rule = (name: string, value: RuleDecl['value']): RuleDecl => ({ name, value });

function parseLibSymbols(root: SList, warnings: string[]): Map<string, LibSymbol> {
  return parseSymbolDefs(children(child(root, 'lib_symbols') ?? [], 'symbol'), warnings);
}

/** Symbol definitions (from a schematic's lib_symbols or a .kicad_sym library), with `extends` resolved. */
export function parseSymbolDefs(defs: SList[], warnings: string[]): Map<string, LibSymbol> {
  const libs = new Map<string, LibSymbol>();
  const raw = new Map<string, SList>();
  for (const s of defs) {
    const name = str(s[1]);
    if (name) raw.set(name, s);
  }
  const build = (name: string, depth = 0): LibSymbol | undefined => {
    const cached = libs.get(name);
    if (cached) return cached;
    const s = raw.get(name);
    if (!s || depth > 8) return undefined;
    const sym: LibSymbol = { name, power: !!child(s, 'power') || flag(s, 'power'), pins: [], graphics: [] };
    const ext = str(child(s, 'extends')?.[1]);
    if (ext) {
      const parent = build(ext.includes(':') ? ext : `${name.split(':')[0]}:${ext}`, depth + 1) ?? build(ext, depth + 1);
      if (parent) {
        sym.pins.push(...parent.pins);
        sym.graphics.push(...parent.graphics);
        sym.power ||= parent.power;
      } else warnings.push(`Symbol ${name} extends missing ${ext}`);
    }
    for (const sub of children(s, 'symbol')) {
      const m = /_(\d+)_(\d+)$/.exec(str(sub[1]) ?? '');
      const unit = m ? Number(m[1]) : 0;
      const style = m ? Number(m[2]) : 1;
      if (style > 1) continue; // only the normal (non-De Morgan) body style
      for (const e of sub) {
        if (!isList(e)) continue;
        const h = head(e);
        const w = num(child(child(e, 'stroke') ?? [], 'width')?.[1]) ?? 0.254;
        const fill = ['outline', 'background', 'color'].includes(str(child(child(e, 'fill') ?? [], 'type')?.[1]) ?? '');
        if (h === 'pin') {
          const a = child(e, 'at');
          sym.pins.push({
            unit,
            at: up(a) ?? { x: 0, y: 0 },
            angle: num(a?.[3]) ?? 0,
            length: num(child(e, 'length')?.[1]) ?? 2.54,
            type: str(e[1]) ?? 'passive',
            name: str(child(e, 'name')?.[1]) ?? '',
            number: str(child(e, 'number')?.[1]) ?? '',
            hidden: flag(e, 'hide'),
          });
        } else if (h === 'polyline') {
          const pts = (child(e, 'pts') ?? []).filter(isList).map((p) => up(p)).filter((p): p is Vec2 => !!p);
          if (pts.length >= 2) sym.graphics.push({ unit, g: { t: 'poly', pts, fill, w } });
        } else if (h === 'rectangle') {
          const a = up(child(e, 'start'));
          const b = up(child(e, 'end'));
          if (a && b) sym.graphics.push({ unit, g: { t: 'rect', a, b, fill, w } });
        } else if (h === 'circle') {
          const c = up(child(e, 'center'));
          const r = num(child(e, 'radius')?.[1]);
          if (c && r) sym.graphics.push({ unit, g: { t: 'circle', c, r, fill, w } });
        } else if (h === 'arc') {
          const s0 = up(child(e, 'start'));
          const m0 = up(child(e, 'mid'));
          const e0 = up(child(e, 'end'));
          if (s0 && m0 && e0) sym.graphics.push({ unit, g: { t: 'arc', s: s0, m: m0, e: e0, w } });
        } else if (h === 'text') {
          const p = up(child(e, 'at'));
          const size = num(child(child(child(e, 'effects') ?? [], 'font') ?? [], 'size')?.[1]) ?? 1.27;
          if (p) sym.graphics.push({ unit, g: { t: 'text', at: p, text: str(e[1]) ?? '', size } });
        }
      }
    }
    libs.set(name, sym);
    return sym;
  };
  for (const name of raw.keys()) build(name);
  return libs;
}

export interface SchFiles {
  /** File name → contents, for the root and every sub-sheet file. */
  files: Record<string, string>;
  root: string;
}

/** Add the schematic to `doc` (or a new document). Symbols link to PCB components by reference. */
export function importKicadSchematic(input: SchFiles, existing?: Doc): SchImportResult {
  const doc = existing ?? createDoc(systemDefaults());
  const warnings: string[] = [];
  let sheets = 0;
  let symbols = 0;
  const elementsByRef = new Map<string, string>();
  for (const n of doc.nodes.values()) if (n.type === 'element') elementsByRef.set(n.name, n.uid);
  const container = addNode(doc, doc.rootId, { type: 'schematic', name: 'Schematic' });
  const parsed = new Map<string, SList>();
  const getFile = (name: string): SList | undefined => {
    if (parsed.has(name)) return parsed.get(name);
    const text = input.files[name] ?? input.files[name.split('/').pop()!];
    if (text === undefined) return undefined;
    const r = parseSExpr(text);
    if (head(r) !== 'kicad_sch') throw new Error(`${name} is not a KiCad schematic`);
    parsed.set(name, r);
    return r;
  };

  const loadSheet = (file: string, parent: DocNode, name: string, depth: number): void => {
    if (depth > 16) return void warnings.push(`Sheet nesting too deep at ${file}`);
    const root = getFile(file);
    if (!root) return void warnings.push(`Missing sheet file ${file}`);
    sheets++;
    const texts: { at: Vec2; text: string; size: number }[] = [];
    const sheet = addNode(doc, parent.uid, { type: 'sheet', name, props: { file } });
    const libs = parseLibSymbols(root, warnings);

    for (const e of root) {
      if (!isList(e)) continue;
      const h = head(e);
      if (h === 'symbol' && child(e, 'lib_id')) {
        const libId = str(child(e, 'lib_id')?.[1]) ?? '';
        const lib = libs.get(libId);
        const a = child(e, 'at');
        const pos = at(a) ?? { x: 0, y: 0 };
        const rot = num(a?.[3]) ?? 0;
        const mirror = str(child(e, 'mirror')?.[1]);
        const unit = num(child(e, 'unit')?.[1]) ?? 1;
        const props: Record<string, PropValue> = { libId, unit };
        for (const p of children(e, 'property')) {
          const k = str(p[1]);
          const v = str(p[2]);
          if (k && v !== undefined) props[k === 'Reference' ? 'ref' : k] = v;
        }
        const instRef = str(child(child(child(child(e, 'instances') ?? [], 'project') ?? [], 'path') ?? [], 'reference')?.[1]);
        if (instRef && (!props.ref || String(props.ref).includes('?'))) props.ref = instRef;
        if (!lib) {
          warnings.push(`Symbol ${props.ref ?? libId} uses unknown library symbol ${libId}`);
          continue;
        }
        const ref = String(props.ref ?? '?');
        const frameRules = [rule('position', pos), rule('rotation', rot), rule('mirror', mirror === 'x' || mirror === 'y' ? mirror : 'none')];
        if (lib.power) {
          // Power ports become labels; PWR_FLAG only marks a net as driven.
          const pin = lib.pins[0];
          const isFlag = /PWR_FLAG/i.test(libId) || /PWR_FLAG/i.test(String(props.Value ?? ''));
          const sym = addNode(doc, sheet.uid, {
            type: 'symbol',
            name: ref,
            props: { ...props, power: true },
            rules: frameRules,
            data: { graphics: lib.graphics.filter((g) => g.unit === 0 || g.unit === unit).map((g) => g.g) },
          });
          addNode(doc, sym.uid, {
            type: 'label',
            name: isFlag ? 'PWR_FLAG' : String(props.Value ?? lib.name),
            props: { kind: isFlag ? 'flag' : 'power' },
            // Labels hold sheet coordinates: place the pin through the symbol's frame.
            rules: [rule('position', symToSheet({ origin: pos, rot, mirror: (mirror === 'x' || mirror === 'y' ? mirror : 'none') as Mirror }, pin ? pin.at : { x: 0, y: 0 })), rule('rotation', 0)],
          });
          continue;
        }
        symbols++;
        // Multi-unit symbols keep their library definition in the project, so units can be switched
        // and missing units found (S12).
        const unitNums = [...new Set(lib.pins.map((p) => p.unit).concat(lib.graphics.map((g) => g.unit)))].filter((u) => u > 0).sort((a, b) => a - b);
        if (unitNums.length > 1 && unitNums[unitNums.length - 1] === unitNums.length) {
          const id = `kicad:${libId}`;
          if (!doc.meta[`part:${id}`]) {
            doc.meta[`part:${id}`] = {
              id,
              name: lib.name.split(':').pop() ?? lib.name,
              prefix: ref.replace(/\d+$/, '') || 'U',
              source: 'kicad-schematic',
              units: unitNums.map((u) => ({
                graphics: lib.graphics.filter((g) => g.unit === 0 || g.unit === u).map((g) => g.g),
                pins: lib.pins.filter((q) => q.unit === 0 || q.unit === u).map((q) => ({ number: q.number, name: q.name, type: q.type, at: q.at, angle: q.angle, length: q.length, ...(q.hidden ? { hidden: true } : {}) })),
              })),
            };
          }
          props.unitDef = id;
        }
        const sym = addNode(doc, sheet.uid, {
          uid: str(child(e, 'uuid')?.[1]),
          type: 'symbol',
          name: ref,
          props: { ...props, ...(elementsByRef.has(ref) ? { element: elementsByRef.get(ref)! } : {}) },
          rules: frameRules,
          data: { graphics: lib.graphics.filter((g) => g.unit === 0 || g.unit === unit).map((g) => g.g) },
        });
        for (const p of lib.pins) {
          if (p.unit !== 0 && p.unit !== unit) continue;
          addNode(doc, sym.uid, {
            type: 'pin',
            name: p.number,
            props: { number: p.number, pinName: p.name, pinType: p.type, ...(p.hidden ? { hidden: true } : {}) },
            rules: [rule('position', p.at), rule('rotation', p.angle), rule('pinLength', p.length)],
          });
        }
      } else if (h === 'wire') {
        const pts = (child(e, 'pts') ?? []).filter(isList).map((p) => at(p)).filter((p): p is Vec2 => !!p);
        for (let i = 0; i + 1 < pts.length; i++) {
          addNode(doc, sheet.uid, { type: 'wire', rules: [rule('start', pts[i]!), rule('end', pts[i + 1]!)] });
        }
      } else if (h === 'label' || h === 'global_label' || h === 'hierarchical_label') {
        const a = child(e, 'at');
        const p = at(a);
        if (!p) continue;
        const kind = h === 'label' ? 'local' : h === 'global_label' ? 'global' : 'hier';
        addNode(doc, sheet.uid, { type: 'label', name: str(e[1]) ?? '', props: { kind }, rules: [rule('position', p), rule('rotation', num(a?.[3]) ?? 0)] });
      } else if (h === 'junction' || h === 'no_connect') {
        const p = at(child(e, 'at'));
        if (p) addNode(doc, sheet.uid, { type: h === 'junction' ? 'junction' : 'noconnect', rules: [rule('position', p)] });
      } else if (h === 'text') {
        const p = at(child(e, 'at'));
        const size = num(child(child(child(e, 'effects') ?? [], 'font') ?? [], 'size')?.[1]) ?? 1.27;
        if (p) texts.push({ at: p, text: str(e[1]) ?? '', size });
      } else if (h === 'sheet') {
        const p = at(child(e, 'at')) ?? { x: 0, y: 0 };
        const size = at(child(e, 'size')) ?? { x: 20, y: 20 };
        let sname = '';
        let sfile = '';
        for (const pr of children(e, 'property')) {
          const k = str(pr[1]);
          if (k === 'Sheetname' || k === 'Sheet name') sname = str(pr[2]) ?? '';
          if (k === 'Sheetfile' || k === 'Sheet file') sfile = str(pr[2]) ?? '';
        }
        const uuid = str(child(e, 'uuid')?.[1]);
        const block = addNode(doc, sheet.uid, { type: 'block', name: sname || sfile, props: { file: sfile, ...(uuid ? { uuid } : {}) }, rules: [rule('position', p), rule('size', size)] });
        for (const pin of children(e, 'pin')) {
          const pp = at(child(pin, 'at'));
          if (pp) addNode(doc, block.uid, { type: 'sheetPin', name: str(pin[1]) ?? '', props: { kind: str(pin[2]) ?? 'passive' }, rules: [rule('position', pp)] });
        }
        if (sfile) loadSheet(sfile, block, sname || sfile, depth + 1);
      }
    }
    if (texts.length) sheet.data = { texts };
  };

  loadSheet(input.root, container, 'Root', 0);
  return { doc, sheets, symbols, warnings };
}
