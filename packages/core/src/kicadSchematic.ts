/**
 * KiCad schematic export (S14): the schematic as `.kicad_sch` files (format 20250114, read by KiCad 9
 * and 10), one file per sheet, plus a minimal `.kicad_pro` so references resolve when it is opened.
 *
 * Written from KiCad's public file format documentation and example files; no KiCad code is used.
 * Each placed symbol's drawing and pins become a library symbol in the file's `lib_symbols`
 * (instances with the same library id and drawing share one); power ports become power symbols.
 * Library coordinates have Y pointing up, sheets Y down, so library points are flipped on the way out
 * (the reverse of the importer).
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { allSheets, sheetItems, sheetPath, symbolFrame, type SymbolFrame } from './schematic.ts';
import { unplace } from './geom.ts';
import { sheetFrame, FRAME_SIZES } from './sheetFrame.ts';
import { layoutSheetTexts, type PlacedText } from './textLayout.ts';
import { uuidFor } from './kicadNetlist.ts';
import { kicadFootprintFor } from './footprints.ts';

export interface KicadSchematicOptions {
  /** Project name, used for the file names and the symbol instances (default: the project's name). */
  project?: string;
  /** Tool version written as generator_version. */
  version?: string;
}

export interface KicadSchematicFile {
  name: string;
  text: string;
}

export interface KicadSchematic {
  /** Root sheet first, then sub-sheets, then the project file. */
  files: KicadSchematicFile[];
  root: string;
  symbols: number;
  sheets: number;
  warnings: string[];
}

type Graphic =
  | { t: 'poly'; pts: Vec2[]; fill?: boolean; w?: number }
  | { t: 'rect'; a: Vec2; b: Vec2; fill?: boolean; w?: number }
  | { t: 'circle'; c: Vec2; r: number; fill?: boolean; w?: number }
  | { t: 'arc'; s: Vec2; m: Vec2; e: Vec2; w?: number }
  | { t: 'text'; at: Vec2; text: string; size?: number };

interface LibPin {
  number: string;
  name: string;
  type: string;
  at: Vec2;
  angle: number;
  length: number;
  hidden?: boolean;
}

interface LibUnit {
  graphics: Graphic[];
  pins: LibPin[];
}

interface LibDef {
  id: string;
  power: boolean;
  /** Reference prefix (R, U, #PWR …). */
  prefix: string;
  units: Map<number, LibUnit>;
  /** Drawing signature per unit, to tell symbols with the same id but another drawing apart. */
  sig: Map<number, string>;
}

const PIN_TYPES = new Set(['input', 'output', 'bidirectional', 'tri_state', 'passive', 'free', 'unspecified', 'power_in', 'power_out', 'open_collector', 'open_emitter', 'no_connect']);
const SHAPES = new Set(['input', 'output', 'bidirectional', 'tri_state', 'passive']);

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const n = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};
/** Library point: symbol-local (Y down) → library (Y up). */
const lp = (p: Vec2) => `${n(p.x)} ${n(-p.y)}`;
const sp = (p: Vec2) => `${n(p.x)} ${n(p.y)}`;
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const font = (size = 1.27) => `(font (size ${n(size)} ${n(size)}))`;
const safeName = (s: string) => s.replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';

function graphicText(g: Graphic): string {
  const stroke = `(stroke (width ${n(('w' in g && g.w) || 0.254)}) (type default))`;
  // A filled body (a box, an amplifier triangle) takes the background colour; small filled marks
  // (arrow heads, dots) the outline colour, as KiCad's own symbols do.
  const big = (pts: Vec2[]) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) > 3 && Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) > 3;
  const filled = 'fill' in g && g.fill;
  const body = g.t === 'rect' ? true : g.t === 'poly' ? big(g.pts) : g.t === 'circle' ? g.r > 1.5 : false;
  const fill = `(fill (type ${filled ? (body ? 'background' : 'outline') : 'none'}))`;
  switch (g.t) {
    case 'poly':
      return `(polyline (pts ${g.pts.map((p) => `(xy ${lp(p)})`).join(' ')}) ${stroke} ${fill})`;
    case 'rect':
      return `(rectangle (start ${lp(g.a)}) (end ${lp(g.b)}) ${stroke} ${fill})`;
    case 'circle':
      return `(circle (center ${lp(g.c)}) (radius ${n(g.r)}) ${stroke} ${fill})`;
    case 'arc':
      return `(arc (start ${lp(g.s)}) (mid ${lp(g.m)}) (end ${lp(g.e)}) ${stroke} (fill (type none)))`;
    case 'text':
      return `(text ${q(g.text)} (at ${lp(g.at)} 0) (effects ${font(g.size)}))`;
  }
}

function pinText(p: LibPin): string {
  const type = PIN_TYPES.has(p.type.replace(/\s+/g, '_')) ? p.type.replace(/\s+/g, '_') : 'passive';
  return `(pin ${type} line (at ${lp(p.at)} ${n(p.angle)}) (length ${n(p.length)})${p.hidden ? ' (hide yes)' : ''} (name ${q(p.name || '~')} (effects ${font()})) (number ${q(p.number)} (effects ${font()})))`;
}

/** The symbol's library drawing and pins, from its own data (as placed or as imported). */
function unitOf(doc: Doc, engine: StyleEngine, sym: DocNode): LibUnit {
  const graphics = ((sym.data as { graphics?: Graphic[] } | undefined)?.graphics ?? []).slice();
  const pins: LibPin[] = [];
  for (const c of sym.children) {
    const p = doc.nodes.get(c);
    if (p?.type !== 'pin') continue;
    pins.push({
      number: String(p.props.number ?? p.name),
      name: String(p.props.pinName ?? ''),
      type: String(p.props.pinType ?? 'passive'),
      at: vec(engine.get(p.uid, 'position')?.value) ?? { x: 0, y: 0 },
      angle: Number(engine.get(p.uid, 'rotation')?.value ?? 0) || 0,
      length: Number(engine.get(p.uid, 'pinLength')?.value ?? 2.54),
      ...(p.props.hidden ? { hidden: true } : {}),
    });
  }
  return { graphics, pins };
}

/** Sheet point → symbol-local point (the inverse of symToSheet). */
function sheetToSym(f: SymbolFrame, p: Vec2): Vec2 {
  const d = { x: p.x - f.origin.x, y: p.y - f.origin.y };
  const m = f.mirror === 'x' ? { x: d.x, y: -d.y } : f.mirror === 'y' ? { x: -d.x, y: d.y } : d;
  return unplace(m, { x: 0, y: 0 }, f.rot);
}

export function kicadSchematic(doc: Doc, engine: StyleEngine, opts: KicadSchematicOptions = {}): KicadSchematic {
  const warnings: string[] = [];
  /** The footprint as KiCad looks it up (Library:Name): generic ones mapped where the match is clear. */
  const kicadFootprint = (sym: DocNode, ref: string): string => {
    const fp = String(sym.props.Footprint ?? '');
    if (!fp || fp.includes(':')) return fp;
    const k = kicadFootprintFor(fp, ref.replace(/\d.*$/, ''));
    if (!k) warnings.push(`${ref}: no KiCad footprint for ${fp}`);
    return k ?? fp;
  };
  const project = safeName(opts.project ?? String(doc.meta.projectName ?? 'design'));
  const sheets = allSheets(doc).sort((a, b) => {
    const pa = sheetPath(doc, a);
    const pb = sheetPath(doc, b);
    return pa === '/' ? -1 : pb === '/' ? 1 : pa.localeCompare(pb, undefined, { numeric: true });
  });
  const rootSheet = sheets.find((s) => sheetPath(doc, s) === '/') ?? sheets[0];
  const rootUuid = uuidFor(rootSheet ? `root:${rootSheet.uid}` : 'root');
  const blockOf = (s: DocNode) => {
    const b = s.parent ? doc.nodes.get(s.parent) : undefined;
    return b?.type === 'block' ? b : null;
  };
  const blockUuid = (b: DocNode) => (typeof b.props.uuid === 'string' ? b.props.uuid : uuidFor(b.uid));
  /** "/root/block/block" instance path of a sheet. */
  const instancePath = (s: DocNode): string => {
    const ids: string[] = [];
    let cur: DocNode | null = s;
    while (cur) {
      const b = blockOf(cur);
      if (!b) break;
      ids.unshift(blockUuid(b));
      let up: DocNode | undefined = b.parent ? doc.nodes.get(b.parent) : undefined;
      while (up && up.type !== 'sheet') up = up.parent ? doc.nodes.get(up.parent) : undefined;
      cur = up ?? null;
    }
    return `/${[rootUuid, ...ids].join('/')}`;
  };
  // File name of every sheet: the imported one, or one made from the sheet name.
  const used = new Set<string>([`${project}.kicad_sch`]);
  const fileOf = new Map<string, string>();
  for (const s of sheets) {
    if (s === rootSheet) {
      fileOf.set(s.uid, `${project}.kicad_sch`);
      continue;
    }
    let f = typeof s.props.file === 'string' && /\.kicad_sch$/.test(s.props.file) ? s.props.file.split('/').pop()! : `${safeName(s.name)}.kicad_sch`;
    for (let i = 2; used.has(f); i++) f = f.replace(/(_\d+)?\.kicad_sch$/, `_${i}.kicad_sch`);
    used.add(f);
    fileOf.set(s.uid, f);
  }
  const pageOf = new Map(sheets.map((s, i) => [s.uid, i + 1]));

  // Library symbols, shared by every file (each file lists the ones it uses).
  const defs = new Map<string, LibDef>();
  const libIdOf = new Map<string, string>(); // symbol uid → lib id
  const symbolsOf = new Map<string, DocNode[]>();
  let symbolCount = 0;
  let pwr = 0;
  let flg = 0;
  const powerRefs = new Map<string, string>();
  for (const s of sheets) {
    const syms = sheetItems(doc, s).filter((x) => x.type === 'symbol');
    symbolsOf.set(s.uid, syms);
    for (const sym of syms) {
      const isPower = !!sym.props.power;
      const unit = isPower ? 1 : Number(sym.props.unit ?? 1) || 1;
      let u: LibUnit;
      let base: string;
      if (isPower) {
        // The port's pin sits where its label is.
        const label = sym.children.map((c) => doc.nodes.get(c)).find((c) => c?.type === 'label');
        const net = String(label?.name ?? sym.props.Value ?? 'PWR');
        const isFlag = label?.props.kind === 'flag' || /PWR_FLAG/i.test(net);
        const at0 = label ? sheetToSym(symbolFrame(engine, sym.uid), vec(engine.get(label.uid, 'position')?.value) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
        const at = { x: Math.round(at0.x * 10000) / 10000 + 0, y: Math.round(at0.y * 10000) / 10000 + 0 };
        const graphics = ((sym.data as { graphics?: Graphic[] } | undefined)?.graphics ?? []).slice();
        u = { graphics, pins: [{ number: '1', name: '', type: isFlag ? 'power_out' : 'power_in', at, angle: 270, length: 0 }] };
        base = typeof sym.props.libId === 'string' && sym.props.libId.includes(':') ? sym.props.libId : `Hassassin:${isFlag ? 'PWR_FLAG' : safeName(net)}`;
        powerRefs.set(sym.uid, isFlag ? `#FLG${String(++flg).padStart(2, '0')}` : `#PWR${String(++pwr).padStart(2, '0')}`);
      } else {
        symbolCount++;
        u = unitOf(doc, engine, sym);
        const lid = String(sym.props.libId ?? '');
        const pid = String(sym.props.partId ?? '');
        base = lid.includes(':') ? lid : pid.includes(':') ? `Hassassin:${safeName(pid.split(':').pop()!)}` : `Hassassin:${safeName(String(sym.props.Value ?? sym.props.ref ?? sym.name).replace(/\d+$/, '') || 'part')}`;
      }
      const sig = JSON.stringify(u);
      let id = base;
      for (let i = 2; ; i++) {
        const d = defs.get(id);
        if (!d) {
          const prefix = isPower ? (powerRefs.get(sym.uid)!.startsWith('#FLG') ? '#FLG' : '#PWR') : String(sym.props.ref ?? sym.name).replace(/\d+[A-Z]?$/, '') || 'U';
          defs.set(id, { id, power: isPower, prefix, units: new Map([[unit, u]]), sig: new Map([[unit, sig]]) });
          break;
        }
        const have = d.sig.get(unit);
        if (have === undefined && d.power === isPower) {
          d.units.set(unit, u);
          d.sig.set(unit, sig);
          break;
        }
        if (have === sig) break;
        id = `${base}_${i}`;
      }
      libIdOf.set(sym.uid, id);
    }
  }

  /** A symbol imported from KiCad and unchanged since: its definition exactly as it came. */
  const original = (d: LibDef): string | null => {
    const m = doc.meta[`kicadSym:${d.id}`] as { text?: string; units?: Record<string, string> } | undefined;
    if (!m?.text || !m.units) return null;
    for (const [u, sig] of d.sig) if (m.units[String(u)] !== sig) return null;
    return m.text;
  };
  /** In a schematic the definition is named with its library (`Lib:Name`); in a library file without. */
  const libSymbolText = (d: LibDef, inLibrary = false): string => {
    if (!inLibrary) {
      const o = original(d);
      if (o) return o;
    }
    const name = d.id.split(':').pop()!;
    const props = d.power
      ? `(property "Reference" ${q(d.prefix)} (at 0 0 0) (hide yes) (effects ${font()})) (property "Value" ${q(name)} (at 0 0 0) (effects ${font()}))`
      : `(property "Reference" ${q(d.prefix)} (at 0 0 0) (effects ${font()})) (property "Value" ${q(name)} (at 0 0 0) (effects ${font()}))`;
    const units = [...d.units.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([u, body]) => `(symbol ${q(`${name}_${u}_1`)} ${body.graphics.map(graphicText).join(' ')} ${body.pins.map(pinText).join(' ')})`)
      .join(' ');
    const pinNames = d.power ? '(pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) ' : '';
    return `(symbol ${q(inLibrary ? name : d.id)} ${d.power ? '(power) ' : ''}${pinNames}(exclude_from_sim no) (in_bom yes) (on_board yes) ${props} ${units})`;
  };

  const files: KicadSchematicFile[] = [];
  for (const s of sheets) {
    const out: string[] = [];
    const add = (t: string) => out.push(`\t${t}`);
    const items = sheetItems(doc, s);
    const frame = sheetFrame(doc, s);
    // Page: the sheet's frame; else the smallest paper that holds the drawing.
    const pts: Vec2[] = [];
    for (const it of items) {
      const p = vec(engine.get(it.uid, 'position')?.value);
      if (p) pts.push(p);
      for (const k of ['start', 'end'] as const) {
        const w = vec(engine.get(it.uid, k)?.value);
        if (w) pts.push(w);
      }
    }
    const maxX = Math.max(0, ...pts.map((p) => p.x));
    const maxY = Math.max(0, ...pts.map((p) => p.y));
    // Symbols, texts and the title block need room beyond the anchor points.
    const paper = frame?.size ?? (['A4', 'A3', 'A2', 'A1', 'A0'].find((k) => FRAME_SIZES[k]!.x >= maxX + 25 && FRAME_SIZES[k]!.y >= maxY + 25) ?? 'A0');
    const f = frame?.fields;
    const sheetUuid = s === rootSheet ? rootUuid : uuidFor(`sheetfile:${s.uid}`);
    add(`(version 20250114)`);
    add(`(generator "hassassin_pcb")`);
    add(`(generator_version ${q(opts.version ?? '0.0')})`);
    add(`(uuid ${q(sheetUuid)})`);
    add(`(paper ${q(paper)})`);
    if (f) add(`(title_block (title ${q(f.title)}) (date ${q(f.date)}) (rev ${q(f.revision)}) (company ${q(f.author)}) (comment 1 ${q(f.project)}))`);
    else add(`(title_block (title ${q(s === rootSheet ? project : s.name)}))`);
    const syms = symbolsOf.get(s.uid) ?? [];
    const usedDefs = [...new Set(syms.map((x) => libIdOf.get(x.uid)!))].sort();
    add(`(lib_symbols ${usedDefs.map((id) => libSymbolText(defs.get(id)!)).join(' ')})`);

    for (const it of items) {
      const parent = it.parent ? doc.nodes.get(it.parent) : undefined;
      if (parent?.type === 'symbol' || parent?.type === 'block') continue; // pins, power labels, sheet pins
      const u = q(uuidFor(it.uid));
      const p = vec(engine.get(it.uid, 'position')?.value);
      const rot = Number(engine.get(it.uid, 'rotation')?.value ?? 0) || 0;
      if (it.type === 'wire') {
        const a = vec(engine.get(it.uid, 'start')?.value);
        const b = vec(engine.get(it.uid, 'end')?.value);
        if (a && b) add(`(wire (pts (xy ${sp(a)}) (xy ${sp(b)})) (stroke (width 0) (type default)) (uuid ${u}))`);
      } else if (it.type === 'junction' && p) {
        add(`(junction (at ${sp(p)}) (diameter 0) (color 0 0 0 0) (uuid ${u}))`);
      } else if (it.type === 'noconnect' && p) {
        add(`(no_connect (at ${sp(p)}) (uuid ${u}))`);
      } else if (it.type === 'label' && p) {
        const kind = String(it.props.kind ?? 'local');
        const just = rot === 180 || rot === 270 ? 'right' : 'left';
        if (kind === 'global' || kind === 'hier') {
          const shape = SHAPES.has(String(it.props.shape)) ? String(it.props.shape) : kind === 'global' ? 'bidirectional' : 'passive';
          const extra = kind === 'global' ? ` (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${sp(p)} 0) (hide yes) (effects ${font()}))` : '';
          add(`(${kind === 'global' ? 'global_label' : 'hierarchical_label'} ${q(it.name)} (shape ${shape}) (at ${sp(p)} ${n(rot)}) (effects ${font()} (justify ${just})) (uuid ${u})${extra})`);
        } else if (kind === 'local') {
          add(`(label ${q(it.name)} (at ${sp(p)} ${n(rot)}) (effects ${font()} (justify ${just} bottom)) (uuid ${u}))`);
        }
      } else if (it.type === 'note' && p) {
        add(`(text ${q(it.name)} (exclude_from_sim no) (at ${sp(p)} 0) (effects ${font(Number(it.props.size ?? 1.27) || 1.27)} (justify left top)) (uuid ${u}))`);
      } else if (it.type === 'groupBox' && p) {
        const size = vec(engine.get(it.uid, 'size')?.value) ?? { x: 10, y: 10 };
        add(`(rectangle (start ${sp(p)}) (end ${sp({ x: p.x + size.x, y: p.y + size.y })}) (stroke (width 0) (type dash)) (fill (type none)) (uuid ${u}))`);
        if (it.name) add(`(text ${q(it.name)} (exclude_from_sim no) (at ${sp({ x: p.x + 1.27, y: p.y - 0.5 })} 0) (effects ${font(1.5)} (justify left bottom)) (uuid ${q(uuidFor(`title:${it.uid}`))}))`);
      } else if (it.type === 'block' && p) {
        const size = vec(engine.get(it.uid, 'size')?.value) ?? { x: 20, y: 20 };
        const child = it.children.map((c) => doc.nodes.get(c)).find((c) => c?.type === 'sheet');
        if (!child) continue;
        const pins = it.children
          .map((c) => doc.nodes.get(c))
          .filter((c): c is DocNode => c?.type === 'sheetPin')
          .map((pin) => {
            const pp = vec(engine.get(pin.uid, 'position')?.value) ?? p;
            const side = Math.abs(pp.x - p.x) < 1e-3 ? 'L' : Math.abs(pp.x - (p.x + size.x)) < 1e-3 ? 'R' : Math.abs(pp.y - p.y) < 1e-3 ? 'T' : 'B';
            const angle = side === 'L' ? 180 : side === 'R' ? 0 : side === 'T' ? 90 : 270;
            const kind = SHAPES.has(String(pin.props.kind)) ? String(pin.props.kind) : 'passive';
            return `(pin ${q(pin.name)} ${kind} (at ${sp(pp)} ${angle}) (effects ${font()} (justify ${side === 'L' ? 'left' : 'right'})) (uuid ${q(uuidFor(pin.uid))}))`;
          });
        add(
          `(sheet (at ${sp(p)}) (size ${sp(size)}) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid ${q(blockUuid(it))}) ` +
            `(property "Sheetname" ${q(it.name)} (at ${sp({ x: p.x, y: p.y - 0.7 })} 0) (effects ${font()} (justify left bottom))) ` +
            `(property "Sheetfile" ${q(fileOf.get(child.uid)!)} (at ${sp({ x: p.x, y: p.y + size.y + 0.6 })} 0) (effects ${font()} (justify left top))) ` +
            `${pins.join(' ')} (instances (project ${q(project)} (path ${q(instancePath(s))} (page ${q(String(pageOf.get(child.uid)))})))))`,
        );
      }
    }
    // Texts kept from an imported sheet.
    for (const t of ((s.data as { texts?: { at: Vec2; text: string; size: number }[] } | undefined)?.texts ?? []))
      add(`(text ${q(t.text)} (exclude_from_sim no) (at ${sp(t.at)} 0) (effects ${font(t.size)} (justify left top)) (uuid ${q(uuidFor(`text:${s.uid}:${t.at.x}:${t.at.y}`))}))`);

    // Symbols, with their reference and value where the editor draws them.
    const texts = new Map<string, PlacedText>();
    try {
      for (const t of layoutSheetTexts(doc, engine, s.uid)) texts.set(`${t.owner}:${t.field}`, t);
    } catch {
      /* without a layout the texts sit on the symbol */
    }
    for (const sym of syms) {
      const fr = symbolFrame(engine, sym.uid);
      const isPower = !!sym.props.power;
      const ref = isPower ? powerRefs.get(sym.uid)! : String(sym.props.ref ?? sym.name);
      const unit = isPower ? 1 : Number(sym.props.unit ?? 1) || 1;
      const prop = (key: string, value: string, field: 'ref' | 'value' | 'power' | null, hide: boolean) => {
        const t = field ? texts.get(`${sym.uid}:${field}`) : undefined;
        const at = t?.at ?? fr.origin;
        const justify = t ? ` (justify ${t.align === 'center' ? '' : t.align} ${t.base === 'middle' ? '' : t.base})`.replace(/\s+\)/, ')').replace(/\(justify\s*\)/, '') : '';
        return `(property ${q(key)} ${q(value)} (at ${sp(at)} 0)${hide ? ' (hide yes)' : ''} (effects ${font(t?.size ?? 1.27)}${justify}))`;
      };
      const label = sym.children.map((c) => doc.nodes.get(c)).find((c) => c?.type === 'label');
      const value = isPower ? String(label?.name ?? sym.props.Value ?? '') : String(sym.props.Value ?? '');
      const parts = [
        prop('Reference', ref, isPower ? null : 'ref', isPower),
        prop('Value', value, isPower ? 'power' : 'value', false),
        prop('Footprint', isPower ? '' : kicadFootprint(sym, ref), null, true),
        prop('Datasheet', isPower ? '' : String(sym.props.Datasheet ?? ''), null, true),
      ];
      if (!isPower)
        for (const [k, v] of Object.entries(sym.props))
          if (!['ref', 'unit', 'libId', 'partId', 'element', 'power', 'Value', 'Footprint', 'Datasheet', 'dnp', 'unitDef', 'mechanicalPads'].includes(k) && (typeof v === 'string' || typeof v === 'number') && String(v) !== '')
            parts.push(prop(k, String(v), null, true));
      const pins = isPower
        ? [`(pin "1" (uuid ${q(uuidFor(`pin:${sym.uid}`))}))`]
        : sym.children
            .map((c) => doc.nodes.get(c))
            .filter((c): c is DocNode => c?.type === 'pin')
            .map((p) => `(pin ${q(String(p.props.number ?? p.name))} (uuid ${q(uuidFor(p.uid))}))`);
      const mirror = fr.mirror === 'x' || fr.mirror === 'y' ? ` (mirror ${fr.mirror})` : '';
      add(
        `(symbol (lib_id ${q(libIdOf.get(sym.uid)!)}) (at ${sp(fr.origin)} ${n(fr.rot)})${mirror} (unit ${unit}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp ${sym.props.dnp === true ? 'yes' : 'no'}) (uuid ${q(uuidFor(sym.uid))}) ` +
          `${parts.join(' ')} ${pins.join(' ')} (instances (project ${q(project)} (path ${q(instancePath(s))} (reference ${q(ref)}) (unit ${unit})))))`,
      );
    }
    if (s === rootSheet) add(`(sheet_instances (path "/" (page "1")))`);
    add('(embedded_fonts no)');
    files.push({ name: fileOf.get(s.uid)!, text: `(kicad_sch\n${out.join('\n')}\n)\n` });
  }
  // Symbols made here go into a project library, so KiCad finds them and they match their copies.
  const own = [...defs.values()].filter((d) => d.id.startsWith('Hassassin:')).sort((a, b) => a.id.localeCompare(b.id));
  if (own.length) {
    files.push({ name: 'hassassin.kicad_sym', text: `(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "hassassin_pcb")\n${own.map((d) => `\t${libSymbolText(d, true)}`).join('\n')}\n)\n` });
    files.push({ name: 'sym-lib-table', text: '(sym_lib_table\n\t(version 7)\n\t(lib (name "Hassassin") (type "KiCad") (uri "${KIPRJMOD}/hassassin.kicad_sym") (options "") (descr "Symbols exported from Hassassin PCB"))\n)\n' });
  }
  // A minimal project file: KiCad fills in its defaults.
  files.push({ name: `${project}.kicad_pro`, text: JSON.stringify({ meta: { filename: `${project}.kicad_pro`, version: 1 }, sheets: [[rootUuid, 'Root']] }, null, 2) + '\n' });
  return { files, root: `${project}.kicad_sch`, symbols: symbolCount, sheets: sheets.length, warnings };
}
