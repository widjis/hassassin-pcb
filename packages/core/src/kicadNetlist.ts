/**
 * KiCad netlist export (S13): the schematic's components and nets in KiCad's S-expression netlist
 * format (version "E"), as read by KiCad's PCB editor (File → Import → Netlist).
 *
 * Written from the format as KiCad's own netlist files show it: a design header with the sheets,
 * one `comp` per reference (all units together) and one `net` per connected net with its pin nodes.
 * Power and flag symbols are not components, as in KiCad. Generic footprints are mapped to KiCad
 * library footprints where there is a clear match, so KiCad can find them.
 */
import type { Doc, DocNode } from './model.ts';
import type { StyleEngine } from './style.ts';
import { extractNetlist, noConnectPins } from './netlist.ts';
import { allSheets, sheetPath } from './schematic.ts';
import { sheetFrame } from './sheetFrame.ts';
import { kicadFootprintFor } from './footprints.ts';

export interface KicadNetlistOptions {
  /** Shown as the design source, e.g. "lamp.kicad_sch". */
  source?: string;
  /** ISO date and time of the export (default: now). */
  date?: string;
  tool?: string;
  /** Map generic footprints (chip-0603 …) to KiCad library footprints (default true). */
  mapFootprints?: boolean;
}

export interface KicadNetlist {
  text: string;
  components: number;
  nets: number;
  /** Generic footprints replaced by a KiCad library footprint. */
  mapped: { ref: string; from: string; to: string }[];
  /** Footprints KiCad will not find by name (no "Library:Name" form), or none at all. */
  unresolved: { ref: string; footprint: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stable UUID for an object id: the id itself when it is one, otherwise derived from it. */
export function uuidFor(id: string): string {
  if (UUID.test(id)) return id.toLowerCase();
  const words: string[] = [];
  for (let seed = 0; seed < 4; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
    words.push(h.toString(16).padStart(8, '0'));
  }
  const hex = words.join('');
  // Version 5 / RFC 4122 variant bits, so readers that check them accept it.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Sheet of a schematic item: its nearest sheet ancestor. */
function sheetOf(doc: Doc, n: DocNode): DocNode | null {
  let p = n.parent ? doc.nodes.get(n.parent) : undefined;
  while (p && p.type !== 'sheet') p = p.parent ? doc.nodes.get(p.parent) : undefined;
  return p ?? null;
}

/** "/uuid/uuid/" of the sheet blocks above a sheet, as KiCad identifies a sheet instance. */
function sheetStamps(doc: Doc, sheet: DocNode): string {
  const ids: string[] = [];
  let s: DocNode | undefined = sheet;
  while (s) {
    const block: DocNode | undefined = s.parent ? doc.nodes.get(s.parent) : undefined;
    if (!block || block.type !== 'block') break;
    ids.unshift(typeof block.props.uuid === 'string' ? block.props.uuid : uuidFor(block.uid));
    s = block.parent ? doc.nodes.get(block.parent) : undefined;
  }
  return ids.length ? `/${ids.join('/')}/` : '/';
}

const isPowerSymbol = (n: DocNode) => !!n.props.power || String(n.props.ref ?? n.name).startsWith('#');

/** Properties that are part of the symbol itself, not user fields. */
const INTERNAL = new Set(['ref', 'unit', 'libId', 'partId', 'element', 'power', 'Value', 'Footprint', 'Datasheet', 'Description', 'mechanicalPads']);

export function kicadNetlist(doc: Doc, engine: StyleEngine, opts: KicadNetlistOptions = {}): KicadNetlist {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  // Local time, as KiCad writes it.
  const now = opts.date ?? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const mapFp = opts.mapFootprints !== false;
  const out: string[] = [];
  const line = (depth: number, s: string) => out.push('\t'.repeat(depth) + s);

  // Sheets: the root first, then by path.
  const sheets = allSheets(doc).sort((a, b) => {
    const pa = sheetPath(doc, a);
    const pb = sheetPath(doc, b);
    return pa === '/' ? -1 : pb === '/' ? 1 : natural(pa, pb);
  });
  const source = opts.source ?? `${String(doc.meta.projectName ?? 'design').replace(/[^\w.-]+/g, '_')}.kicad_sch`;

  line(0, '(export');
  line(1, '(version "E")');
  line(1, '(design');
  line(2, `(source ${q(source)})`);
  line(2, `(date ${q(now)})`);
  line(2, `(tool ${q(opts.tool ?? 'Hassassin PCB')})`);
  sheets.forEach((sh, i) => {
    line(2, '(sheet');
    line(3, `(number ${q(String(i + 1))})`);
    line(3, `(name ${q(sheetPath(doc, sh))})`);
    line(3, `(tstamps ${q(sheetStamps(doc, sh))})`);
    const f = sheetFrame(doc, sh)?.fields;
    line(3, '(title_block');
    line(4, `(title ${q(f?.title ?? '')})`);
    line(4, `(company ${q(f?.author ?? '')})`);
    line(4, `(rev ${q(f?.revision ?? '')})`);
    line(4, `(date ${q(f?.date ?? '')})`);
    line(4, `(source ${q(typeof sh.props.file === 'string' ? sh.props.file : source)})`);
    line(3, ')');
    line(2, ')');
  });
  line(1, ')');

  // Components: one per reference; the first unit (lowest) carries the properties.
  const byRef = new Map<string, DocNode[]>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || isPowerSymbol(n)) continue;
    const ref = String(n.props.ref ?? n.name);
    const list = byRef.get(ref) ?? [];
    list.push(n);
    byRef.set(ref, list);
  }
  const mapped: KicadNetlist['mapped'] = [];
  const unresolved: KicadNetlist['unresolved'] = [];
  const refs = [...byRef.keys()].sort(natural);
  line(1, '(components');
  for (const ref of refs) {
    const units = byRef.get(ref)!.sort((a, b) => Number(a.props.unit ?? 1) - Number(b.props.unit ?? 1));
    const s = units[0]!;
    const p = s.props;
    const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    let fp = str(p.Footprint);
    if (fp && !fp.includes(':') && mapFp) {
      const k = kicadFootprintFor(fp, ref.replace(/\d.*$/, ''));
      if (k) {
        mapped.push({ ref, from: fp, to: k });
        fp = k;
      }
    }
    if (!fp.includes(':')) unresolved.push({ ref, footprint: fp });
    const libId = str(p.libId) || str(p.partId);
    const [lib, part] = libId.includes(':') ? [libId.slice(0, libId.lastIndexOf(':')), libId.slice(libId.lastIndexOf(':') + 1)] : ['', libId];
    const sheet = sheetOf(doc, s);
    line(2, '(comp');
    line(3, `(ref ${q(ref)})`);
    line(3, `(value ${q(str(p.Value) || '~')})`);
    if (fp) line(3, `(footprint ${q(fp)})`);
    const ds = str(p.Datasheet);
    if (ds && ds !== '~') line(3, `(datasheet ${q(ds)})`);
    if (p.Description) line(3, `(description ${q(str(p.Description))})`);
    const fields = Object.entries(p).filter(([k, v]) => !INTERNAL.has(k) && k !== 'dnp' && (typeof v === 'string' || typeof v === 'number') && String(v) !== '');
    line(3, '(fields');
    if (fp) line(4, `(field (name "Footprint") ${q(fp)})`);
    if (ds && ds !== '~') line(4, `(field (name "Datasheet") ${q(ds)})`);
    for (const [k, v] of fields) line(4, `(field (name ${q(k)}) ${q(String(v))})`);
    line(3, ')');
    if (lib || part) line(3, `(libsource (lib ${q(lib)}) (part ${q(part)}) (description ""))`);
    if (sheet) {
      line(3, `(property (name "Sheetname") (value ${q(sheetPath(doc, sheet) === '/' ? 'Root' : sheet.name)}))`);
      line(3, `(property (name "Sheetfile") (value ${q(typeof sheet.props.file === 'string' ? sheet.props.file : source)}))`);
    }
    if (p.dnp === true) line(3, '(property (name "dnp") (value "1"))');
    line(3, '(sheetpath');
    line(4, `(names ${q(sheet ? sheetPath(doc, sheet) : '/')})`);
    line(4, `(tstamps ${q(sheet ? sheetStamps(doc, sheet) : '/')})`);
    line(3, ')');
    line(3, `(tstamps ${units.map((u) => q(uuidFor(u.uid))).join(' ')})`);
    line(2, ')');
  }
  line(1, ')');

  // Nets: pins of components only; nets left with no pin are dropped.
  const nl = extractNetlist(doc, engine);
  const nc = noConnectPins(doc, engine);
  const isComp = (ref: string) => byRef.has(ref);
  let code = 0;
  line(1, '(nets');
  for (const net of nl.nets) {
    const pins = net.pins.filter((x) => isComp(x.ref)).sort((a, b) => natural(a.ref, b.ref) || natural(a.pin, b.pin));
    if (!pins.length) continue;
    line(2, '(net');
    line(3, `(code ${q(String(++code))})`);
    line(3, `(name ${q(net.name)})`);
    line(3, '(class "Default")');
    for (const x of pins) {
      const base = (x.pinType || 'passive').replace(/\s+/g, '_');
      const type = base + (nc.has(x.pinUid) && base !== 'no_connect' ? '+no_connect' : '');
      const fn = x.pinName && x.pinName !== '~' ? ` (pinfunction ${q(x.pinName)})` : '';
      line(3, `(node (ref ${q(x.ref)}) (pin ${q(x.pin)})${fn} (pintype ${q(type)}))`);
    }
    line(2, ')');
  }
  line(1, ')');
  line(0, ')');
  return { text: out.join('\n') + '\n', components: refs.length, nets: code, mapped, unresolved };
}
