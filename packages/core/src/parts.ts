/**
 * Parts: reusable definitions that bundle a schematic symbol (one or more units), a
 * footprint, properties (MPN, manufacturer, datasheet) and supplier offers.
 *
 * A project keeps its own copy of every part and footprint it uses (doc.meta keys
 * "part:<id>" and "fp:<name>"), so a project file is self-contained and two people
 * adding different parts at once never overwrite each other.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import { genericAlias, genericFootprint, genericFootprintNames, type FootprintSpec } from './footprints.ts';
import { makeSymbol, nextRef, PART_KINDS, type PartKind, type PinSpec, type SymGraphicSpec } from './symbolGen.ts';

export interface PriceBreak {
  qty: number;
  price: number;
}

export interface Offer {
  supplier: string;
  sku?: string;
  stock?: number;
  moq?: number;
  currency: string;
  breaks: PriceBreak[];
  url?: string;
  /** ISO date the numbers were taken. Prices and stock go stale; the UI shows the age. */
  updatedAt?: string;
}

export interface PartUnit {
  graphics: SymGraphicSpec[];
  pins: PinSpec[];
}

export interface PartDef {
  id: string;
  name: string;
  description?: string;
  category?: string;
  keywords?: string[];
  prefix: string;
  value?: string;
  units: PartUnit[];
  /** Footprint name, resolved through the library (generic name, "Lib:Name", or a project footprint). */
  footprint?: string;
  /** Other footprints that fit the same symbol. */
  footprints?: string[];
  /** MPN, Manufacturer, Datasheet, LCSC… copied onto placed symbols and components. */
  properties?: Record<string, string>;
  offers?: Offer[];
  source?: string;
  version?: number;
}

export interface PartSummary {
  id: string;
  name: string;
  description?: string;
  category?: string;
  footprint?: string;
  source: string;
  mpn?: string;
}

export const partSummary = (p: PartDef): PartSummary => ({
  id: p.id,
  name: p.name,
  ...(p.description ? { description: p.description } : {}),
  ...(p.category ? { category: p.category } : {}),
  ...(p.footprint ? { footprint: p.footprint } : {}),
  source: p.source ?? 'project',
  ...(p.properties?.MPN ? { mpn: p.properties.MPN } : {}),
});

const DEFAULT_FP: Record<PartKind, string> = {
  resistor: 'chip-0603',
  capacitor: 'chip-0603',
  inductor: 'chip-0805',
  diode: 'sod-123',
  led: 'chip-0603',
  connector: 'header-1x04-p2.54',
  ic: 'soic-8',
};

const FP_CHOICES: Record<PartKind, string[]> = {
  resistor: ['chip-0402', 'chip-0603', 'chip-0805', 'chip-1206', 'chip-2512'],
  capacitor: ['chip-0402', 'chip-0603', 'chip-0805', 'chip-1206', 'chip-1210'],
  inductor: ['chip-0603', 'chip-0805', 'chip-1206', 'chip-1210'],
  diode: ['sod-123', 'sod-323', 'sma', 'smb', 'smc'],
  led: ['chip-0402', 'chip-0603', 'chip-0805', 'chip-1206'],
  connector: [],
  ic: [],
};

/**
 * A generic, parametric part: "generic:resistor", or with parameters
 * "generic:resistor?value=4k7&package=chip-0402", "generic:connector?pins=6".
 */
export function genericPart(kind: PartKind, params: { value?: string; package?: string; pins?: number } = {}): PartDef {
  const pins = params.pins;
  const sym = makeSymbol(kind, { ...(pins ? { pins } : {}), ...(params.value ? { value: params.value } : {}) });
  let fp = params.package ?? DEFAULT_FP[kind];
  if (kind === 'connector' && !params.package) fp = `header-1x${String(sym.pins.length).padStart(2, '0')}-p2.54`;
  if (kind === 'ic' && !params.package) fp = sym.pins.length <= 16 && sym.pins.length % 2 === 0 ? `soic-${Math.max(8, sym.pins.length)}` : `tssop-${sym.pins.length + (sym.pins.length % 2)}`;
  const label = PART_KINDS.find((k) => k.kind === kind)?.label ?? kind;
  const q = new URLSearchParams();
  if (params.value) q.set('value', params.value);
  if (params.package) q.set('package', params.package);
  if (pins) q.set('pins', String(pins));
  const qs = q.toString();
  return {
    id: `generic:${kind}${qs ? `?${qs}` : ''}`,
    name: `${label}${params.value ? ` ${params.value}` : ''}`,
    description: `Generic ${label.toLowerCase()} — set the value and package, then pick a manufacturer part number`,
    category: kind === 'ic' ? 'Integrated circuits' : kind === 'connector' ? 'Connectors' : 'Passives & discretes',
    keywords: [kind, label.toLowerCase()],
    prefix: sym.prefix,
    value: sym.value,
    units: [{ graphics: sym.graphics, pins: sym.pins }],
    footprint: fp,
    footprints: FP_CHOICES[kind].length ? FP_CHOICES[kind] : [fp],
    source: 'generic',
  };
}

export function parseGenericId(id: string): PartDef | null {
  const m = /^generic:([a-z]+)(?:\?(.*))?$/.exec(id);
  if (!m || !PART_KINDS.some((k) => k.kind === m[1])) return null;
  const q = new URLSearchParams(m[2] ?? '');
  return genericPart(m[1] as PartKind, {
    ...(q.get('value') ? { value: q.get('value')! } : {}),
    ...(q.get('package') ? { package: q.get('package')! } : {}),
    ...(q.get('pins') ? { pins: Number(q.get('pins')) } : {}),
  });
}

export const GENERIC_PARTS: PartDef[] = PART_KINDS.map((k) => genericPart(k.kind));

// ---------------------------------------------------------------------------
// Project library (doc.meta)

export const partKey = (id: string) => `part:${id}`;
export const fpKey = (name: string) => `fp:${name}`;

export function projectParts(doc: Doc): PartDef[] {
  return Object.entries(doc.meta)
    .filter(([k]) => k.startsWith('part:'))
    .map(([, v]) => v as PartDef);
}

export function projectFootprints(doc: Doc): FootprintSpec[] {
  return Object.entries(doc.meta)
    .filter(([k]) => k.startsWith('fp:'))
    .map(([, v]) => v as FootprintSpec);
}

/** Look a footprint up: project copy, then generic name, then a generic alias for a foreign name. */
export function resolveFootprintLocal(doc: Doc, name: string): FootprintSpec | null {
  if (!name) return null;
  const own = doc.meta[fpKey(name)] as FootprintSpec | undefined;
  if (own) return own;
  const gen = genericFootprint(name);
  if (gen) return gen;
  const alias = genericAlias(name);
  return alias ? genericFootprint(alias) : null;
}

export type FootprintResolver = (name: string) => FootprintSpec | null;

/** Ops that store a part (and optionally its footprint) in the project. */
export function storePartOps(doc: Doc, part: PartDef, fp?: FootprintSpec | null): Op[] {
  const ops: Op[] = [];
  if (part.source !== 'generic' && JSON.stringify(doc.meta[partKey(part.id)]) !== JSON.stringify(part)) ops.push({ op: 'setMeta', key: partKey(part.id), value: part });
  if (fp && fp.source !== 'generic' && !doc.meta[fpKey(fp.name)]) ops.push({ op: 'setMeta', key: fpKey(fp.name), value: fp });
  return ops;
}

/** Place every unit of a part on a sheet, side by side. Returns the ops and the reference. */
export function placePartOps(doc: Doc, sheetUid: string, part: PartDef, at: Vec2, opts: { ref?: string; value?: string } = {}): { ops: Op[]; ref: string; uids: string[] } {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) throw new Error('No such sheet');
  const ref = opts.ref ?? nextRef(doc, part.prefix);
  const ops: Op[] = [];
  const uids: string[] = [];
  let x = at.x;
  part.units.forEach((u, i) => {
    const uid = newUid('sym');
    const pins: DocNode[] = u.pins.map((p) => ({
      uid: newUid('pin'),
      type: 'pin',
      name: p.number,
      props: { number: p.number, pinName: p.name, pinType: p.type, ...(p.hidden ? { hidden: true } : {}) },
      rules: [
        { name: 'position', value: p.at },
        { name: 'rotation', value: p.angle },
        { name: 'pinLength', value: p.length },
      ],
      parent: uid,
      children: [],
    }));
    const props: DocNode['props'] = { ref, Value: opts.value ?? part.value ?? part.name, unit: i + 1, partId: part.id, ...(part.footprint ? { Footprint: part.footprint } : {}) };
    for (const [k, v] of Object.entries(part.properties ?? {})) if (v) props[k] = v;
    const sym: DocNode = {
      uid,
      type: 'symbol',
      name: ref,
      props,
      rules: [
        { name: 'position', value: { x, y: at.y } },
        { name: 'rotation', value: 0 },
        { name: 'mirror', value: 'none' },
      ],
      parent: sheetUid,
      children: pins.map((p) => p.uid),
      data: { graphics: u.graphics },
    };
    // Next unit to the right of this one.
    let maxX = 0;
    for (const p of u.pins) maxX = Math.max(maxX, Math.abs(p.at.x));
    for (const g of u.graphics) if (g.t === 'rect') maxX = Math.max(maxX, Math.abs(g.a.x), Math.abs(g.b.x));
    x += Math.ceil((maxX * 2 + 10) / 2.54) * 2.54;
    ops.push({ op: 'add', parent: sheetUid, index: sheet.children.length + i, tree: { nodes: [sym, ...pins] } });
    uids.push(uid);
  });
  return { ops, ref, uids };
}

/** Ops that set properties on every symbol unit and the PCB component with this reference. */
export function setPartPropsOps(doc: Doc, ref: string, props: Record<string, string | null>): Op[] {
  const ops: Op[] = [];
  for (const n of doc.nodes.values()) {
    if ((n.type === 'symbol' && !n.props.power && String(n.props.ref ?? n.name) === ref) || (n.type === 'element' && n.name === ref)) {
      for (const [k, v] of Object.entries(props)) if ((n.props[k] ?? null) !== v) ops.push({ op: 'setProp', uid: n.uid, key: k, value: v });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Search

const norm = (s: string) => s.toLowerCase();

export function scorePart(p: PartSummary & { keywords?: string[] }, q: string): number {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = norm([p.name, p.id, p.description ?? '', p.category ?? '', p.footprint ?? '', p.mpn ?? '', ...(p.keywords ?? [])].join(' '));
  let s = 0;
  for (const w of words) {
    if (!hay.includes(w)) return 0;
    s += norm(p.name) === w ? 10 : norm(p.name).startsWith(w) ? 5 : 1;
  }
  return s;
}

export function searchLocalParts(doc: Doc | null, q: string, limit = 50): PartSummary[] {
  const all: (PartSummary & { keywords?: string[] })[] = [
    ...(doc ? projectParts(doc) : []).map((p) => ({ ...partSummary(p), ...(p.keywords ? { keywords: p.keywords } : {}) })),
    ...GENERIC_PARTS.map((p) => ({ ...partSummary(p), ...(p.keywords ? { keywords: p.keywords } : {}) })),
  ];
  return all
    .map((p) => [scorePart(p, q), p] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, limit)
    .map(([, p]) => {
      const { keywords: _k, ...rest } = p;
      return rest;
    });
}

export function getLocalPart(doc: Doc | null, id: string): PartDef | null {
  return parseGenericId(id) ?? ((doc?.meta[partKey(id)] as PartDef | undefined) ?? null);
}

export { genericFootprintNames };

// ---------------------------------------------------------------------------
// Bill of materials and sourcing

export interface BomLine {
  refs: string[];
  value: string;
  footprint: string;
  mpn: string;
  manufacturer: string;
  partId: string;
  qty: number;
  placeholder: boolean;
  /** Cheapest offer that has enough stock for the build, if any. */
  best?: { supplier: string; sku?: string; unit: number; total: number; currency: string; stock?: number; updatedAt?: string };
  issues: string[];
}

export interface BomResult {
  lines: BomLine[];
  boards: number;
  total: Record<string, number>;
  missingMpn: number;
  noOffer: number;
  shortStock: number;
}

/** Unit price for a quantity (largest break not above it; below the first break, the first). */
export function unitPrice(o: Offer, qty: number): number | null {
  const b = [...o.breaks].sort((x, y) => x.qty - y.qty);
  if (!b.length) return null;
  let p = b[0]!.price;
  for (const x of b) if (x.qty <= qty) p = x.price;
  return p;
}

/** Group components into BOM lines and price them for `boards` boards. */
export function buildBom(doc: Doc, boards = 1): BomResult {
  // Component source: PCB components, plus schematic-only symbols (not yet on the board).
  const byRef = new Map<string, Record<string, unknown>>();
  for (const n of doc.nodes.values()) {
    if (n.type === 'symbol' && !n.props.power) {
      const ref = String(n.props.ref ?? n.name);
      if (!byRef.has(ref)) byRef.set(ref, { ...n.props });
    }
  }
  for (const n of doc.nodes.values()) {
    if (n.type !== 'element') continue;
    const prev = byRef.get(n.name) ?? {};
    byRef.set(n.name, { ...prev, ...Object.fromEntries(Object.entries(n.props).filter(([, v]) => v !== '' && v !== undefined)), placeholder: !!n.props.placeholder });
  }
  const groups = new Map<string, BomLine>();
  for (const [ref, p] of byRef) {
    if (ref.startsWith('#') || p.dnp || p['exclude_from_bom']) continue;
    const mpn = String(p.MPN ?? p['Manufacturer Part Number'] ?? p.LCSC ?? '');
    const value = String(p.Value ?? '');
    const footprint = String(p.Footprint ?? '');
    const key = `${mpn}|${value}|${footprint}`;
    const line = groups.get(key) ?? { refs: [], value, footprint, mpn, manufacturer: String(p.Manufacturer ?? ''), partId: String(p.partId ?? ''), qty: 0, placeholder: false, issues: [] };
    line.refs.push(ref);
    line.qty++;
    line.placeholder ||= !!p.placeholder;
    groups.set(key, line);
  }
  const res: BomResult = { lines: [], boards, total: {}, missingMpn: 0, noOffer: 0, shortStock: 0 };
  const byMpn = new Map<string, PartDef>();
  for (const p of projectParts(doc)) if (p.properties?.MPN && p.offers?.length) byMpn.set(p.properties.MPN.toLowerCase(), p);
  for (const line of groups.values()) {
    line.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const need = line.qty * boards;
    const own = line.partId ? (doc.meta[partKey(line.partId)] as PartDef | undefined) : undefined;
    const offers = own?.offers?.length ? own.offers : line.mpn ? (byMpn.get(line.mpn.toLowerCase())?.offers ?? []) : [];
    if (!line.mpn) {
      line.issues.push('no manufacturer part number');
      res.missingMpn++;
    }
    if (line.placeholder) line.issues.push('placeholder footprint');
    let best: BomLine['best'];
    for (const o of offers) {
      const buy = Math.max(need, o.moq ?? 0);
      const unit = unitPrice(o, buy);
      if (unit === null) continue;
      if (o.stock !== undefined && o.stock < need) continue;
      const total = unit * buy;
      if (!best || total < best.total) best = { supplier: o.supplier, ...(o.sku ? { sku: o.sku } : {}), unit, total, currency: o.currency, ...(o.stock !== undefined ? { stock: o.stock } : {}), ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}) };
    }
    if (best) {
      line.best = best;
      res.total[best.currency] = Math.round(((res.total[best.currency] ?? 0) + best.total) * 10000) / 10000;
    } else if (offers.length) {
      line.issues.push(`not enough stock for ${need}`);
      res.shortStock++;
    } else if (line.mpn) {
      line.issues.push('no price/stock data');
      res.noOffer++;
    }
    res.lines.push(line);
  }
  res.lines.sort((a, b) => a.refs[0]!.localeCompare(b.refs[0]!, undefined, { numeric: true }));
  return res;
}

/**
 * Parse supplier price/stock data from CSV (e.g. a distributor's BOM-tool export).
 * Recognised headers (case-insensitive): mpn, supplier, sku, stock, moq, currency,
 * url, and price columns "price@<qty>" or qty/price pairs "qty1,price1,qty2,price2…".
 */
export function parseOffersCsv(text: string, today = new Date().toISOString().slice(0, 10)): Map<string, Offer[]> {
  const rows = csvRows(text);
  const out = new Map<string, Offer[]>();
  if (rows.length < 2) return out;
  const head = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iMpn = col('mpn', 'manufacturer part number', 'part number', 'mfr part #', 'mfr. part #');
  const iSup = col('supplier', 'distributor', 'vendor');
  const iSku = col('sku', 'supplier part number', 'order code');
  const iStock = col('stock', 'available', 'quantity available', 'in stock');
  const iMoq = col('moq', 'minimum order');
  const iCur = col('currency');
  const iUrl = col('url', 'link');
  const priceCols = head.map((h, i) => [h, i] as const).filter(([h]) => /^price ?@ ?\d+$/.test(h)).map(([h, i]) => [Number(h.replace(/\D/g, '')), i] as const);
  const iPrice = col('price', 'unit price');
  if (iMpn < 0) throw new Error('CSV needs an "MPN" column.');
  for (const r of rows.slice(1)) {
    const mpn = (r[iMpn] ?? '').trim();
    if (!mpn) continue;
    const n = (i: number) => {
      const v = Number(String(r[i] ?? '').replace(/[^\d.]/g, ''));
      return i >= 0 && Number.isFinite(v) && String(r[i] ?? '').trim() !== '' ? v : undefined;
    };
    const breaks: PriceBreak[] = priceCols.map(([qty, i]) => ({ qty, price: n(i) })).filter((b): b is PriceBreak => b.price !== undefined);
    if (!breaks.length && iPrice >= 0 && n(iPrice) !== undefined) breaks.push({ qty: 1, price: n(iPrice)! });
    const offer: Offer = {
      supplier: (r[iSup] ?? '').trim() || 'supplier',
      currency: (r[iCur] ?? '').trim() || 'USD',
      breaks,
      updatedAt: today,
      ...(iSku >= 0 && r[iSku] ? { sku: r[iSku]!.trim() } : {}),
      ...(n(iStock) !== undefined ? { stock: n(iStock)! } : {}),
      ...(n(iMoq) !== undefined ? { moq: n(iMoq)! } : {}),
      ...(iUrl >= 0 && r[iUrl] ? { url: r[iUrl]!.trim() } : {}),
    };
    const list = out.get(mpn) ?? [];
    list.push(offer);
    out.set(mpn, list);
  }
  return out;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/**
 * Ops that attach offers to the project's parts by MPN. Components whose MPN has no
 * project part get a small "mpn:<MPN>" part so the data has a home.
 */
export function applyOffersOps(doc: Doc, offers: Map<string, Offer[]>): { ops: Op[]; matched: string[]; unmatched: string[] } {
  const ops: Op[] = [];
  const matched: string[] = [];
  const byMpn = new Map<string, PartDef>();
  for (const p of projectParts(doc)) if (p.properties?.MPN) byMpn.set(p.properties.MPN.toLowerCase(), p);
  const used = new Map<string, string[]>(); // mpn → refs
  for (const n of doc.nodes.values()) {
    if (n.type !== 'element' && !(n.type === 'symbol' && !n.props.power)) continue;
    const mpn = String(n.props.MPN ?? '');
    if (!mpn) continue;
    const ref = n.type === 'element' ? n.name : String(n.props.ref ?? n.name);
    const l = used.get(mpn.toLowerCase()) ?? [];
    if (!l.includes(ref)) l.push(ref);
    used.set(mpn.toLowerCase(), l);
  }
  for (const [mpn, list] of offers) {
    const key = mpn.toLowerCase();
    let part = byMpn.get(key);
    if (!part && !used.has(key)) continue;
    matched.push(mpn);
    if (!part) part = { id: `mpn:${mpn}`, name: mpn, prefix: 'U', units: [], properties: { MPN: mpn }, source: 'project' };
    const merged = [...(part.offers ?? []).filter((o) => !list.some((x) => x.supplier === o.supplier && (x.sku ?? '') === (o.sku ?? ''))), ...list];
    ops.push({ op: 'setMeta', key: partKey(part.id), value: { ...part, offers: merged } });
  }
  return { ops, matched, unmatched: [...offers.keys()].filter((m) => !matched.includes(m)) };
}
