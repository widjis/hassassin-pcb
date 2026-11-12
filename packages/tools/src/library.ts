/**
 * Part & footprint library seen by tools: the project's own parts, the generic
 * parametric parts, and (when available) extra sources such as the KiCad libraries
 * installed on this machine or a team library on the collaboration server.
 */
import {
  genericFootprint,
  genericFootprintNames,
  getLocalPart,
  projectFootprints,
  resolveFootprintLocal,
  scorePart,
  searchLocalParts,
  type Doc,
  type FootprintSpec,
  type PartDef,
  type PartSummary,
} from '@hassassin/core';
import { parseKicadFootprint, parseSExpr, partsFromSymbolLists, type SList } from '@hassassin/kicad-import';

export interface FootprintSummary {
  name: string;
  description?: string;
  source: string;
  license?: string;
}

/** An extra place to find parts and footprints. All methods may be slow (disk, network). */
export interface LibrarySource {
  name: string;
  searchParts(q: string, limit: number): Promise<PartSummary[]>;
  searchFootprints(q: string, limit: number): Promise<FootprintSummary[]>;
  getPart(id: string): Promise<PartDef | null>;
  getFootprint(name: string): Promise<FootprintSpec | null>;
}

export class Library {
  sources: LibrarySource[];
  constructor(sources: LibrarySource[] = []) {
    this.sources = sources;
  }

  async searchParts(doc: Doc | null, q: string, limit = 30): Promise<PartSummary[]> {
    const out = searchLocalParts(doc, q, limit);
    for (const s of this.sources) {
      if (out.length >= limit) break;
      try {
        out.push(...(await s.searchParts(q, limit - out.length)));
      } catch {
        /* a source being unavailable must not break search */
      }
    }
    return out.slice(0, limit);
  }

  async searchFootprints(doc: Doc | null, q: string, limit = 30): Promise<FootprintSummary[]> {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const out: FootprintSummary[] = [];
    for (const fp of doc ? projectFootprints(doc) : []) if (match(`${fp.name} ${fp.description ?? ''} ${(fp.tags ?? []).join(' ')}`)) out.push({ name: fp.name, ...(fp.description ? { description: fp.description } : {}), source: 'project' });
    for (const n of genericFootprintNames()) {
      if (!match(n)) continue;
      const fp = genericFootprint(n)!;
      out.push({ name: n, ...(fp.description ? { description: fp.description } : {}), source: 'generic' });
    }
    for (const s of this.sources) {
      if (out.length >= limit) break;
      try {
        out.push(...(await s.searchFootprints(q, limit - out.length)));
      } catch {
        /* ignore */
      }
    }
    return out.slice(0, limit);
  }

  async getPart(doc: Doc | null, id: string): Promise<PartDef | null> {
    const local = getLocalPart(doc, id);
    if (local) return local;
    for (const s of this.sources) {
      const p = await s.getPart(id).catch(() => null);
      if (p) return p;
    }
    return null;
  }

  /** Exact footprints first (project, sources), generic stand-ins last. */
  async getFootprint(doc: Doc | null, name: string): Promise<FootprintSpec | null> {
    if (!name) return null;
    const own = doc?.meta[`fp:${name}`] as FootprintSpec | undefined;
    if (own) return own;
    const gen = genericFootprint(name);
    if (gen) return gen;
    for (const s of this.sources) {
      const fp = await s.getFootprint(name).catch(() => null);
      if (fp) return fp;
    }
    return doc ? resolveFootprintLocal(doc, name) : null;
  }

  /** Resolve a set of names up front, for the synchronous schematic → PCB update. */
  async resolver(doc: Doc, names: Iterable<string>): Promise<(name: string) => FootprintSpec | null> {
    const map = new Map<string, FootprintSpec | null>();
    for (const n of new Set(names)) if (n) map.set(n, await this.getFootprint(doc, n));
    return (n) => map.get(n) ?? null;
  }
}

// ---------------------------------------------------------------------------
// KiCad libraries installed on this machine (read-only, read on demand).

export interface LibFs {
  readText(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mtime(path: string): Promise<number>;
}

interface SymIndexEntry {
  lib: string;
  name: string;
  d?: string;
  k?: string;
  f?: string;
}

interface KicadIndex {
  version: 1;
  stamp: string;
  symbols: SymIndexEntry[];
  footprints: { lib: string; name: string }[];
}

const SYM_START = /\n\t\(symbol "((?:[^"\\]|\\.)*)"/g;

/** Top-level symbol chunks of a .kicad_sym file, by name (text slices, parsed on demand). */
function symbolChunks(text: string): Map<string, string> {
  const starts: [string, number][] = [];
  for (const m of text.matchAll(SYM_START)) starts.push([m[1]!, m.index! + 1]);
  const out = new Map<string, string>();
  starts.forEach(([name, at], i) => {
    const end = i + 1 < starts.length ? starts[i + 1]![1] : text.lastIndexOf(')');
    out.set(name, text.slice(at, end));
  });
  return out;
}

const prop = (chunk: string, key: string): string | undefined => {
  const m = new RegExp(`\\n\\t\\t\\(property "${key}" "((?:[^"\\\\]|\\\\.)*)"`).exec(chunk);
  return m?.[1] || undefined;
};

/** License of the official KiCad libraries, shown with every part and footprint taken from them. */
export const KICAD_LICENSE = 'CC BY-SA 4.0 with the KiCad libraries exception (designs using them are not affected)';

export class KicadSystemLibrary implements LibrarySource {
  name = 'kicad';
  /** Installed with KiCad, or downloaded on demand (S21). */
  origin: 'installed' | 'downloaded';
  readonly symbolsDir: string;
  readonly footprintsDir: string;
  private fs: LibFs;
  private symDir: string;
  private fpDir: string;
  private cachePath: string | undefined;
  private writeCache: ((path: string, text: string) => Promise<void>) | undefined;
  private index: KicadIndex | null = null;
  private building: Promise<KicadIndex> | null = null;
  private fileCache = new Map<string, Map<string, string>>();

  constructor(opts: { fs: LibFs; symbolsDir: string; footprintsDir: string; cachePath?: string; writeCache?: (path: string, text: string) => Promise<void>; origin?: 'installed' | 'downloaded' }) {
    this.origin = opts.origin ?? 'installed';
    this.symbolsDir = opts.symbolsDir;
    this.footprintsDir = opts.footprintsDir;
    this.fs = opts.fs;
    this.symDir = opts.symbolsDir;
    this.fpDir = opts.footprintsDir;
    this.cachePath = opts.cachePath;
    this.writeCache = opts.writeCache;
  }

  private async stamp(): Promise<string> {
    const a = await this.fs.mtime(this.symDir).catch(() => 0);
    const b = await this.fs.mtime(this.fpDir).catch(() => 0);
    return `${this.symDir}|${a}|${this.fpDir}|${b}`;
  }

  async getIndex(): Promise<KicadIndex> {
    if (this.index) return this.index;
    if (this.building) return this.building;
    this.building = (async () => {
      const stamp = await this.stamp();
      if (this.cachePath && (await this.fs.exists(this.cachePath))) {
        try {
          const c = JSON.parse(await this.fs.readText(this.cachePath)) as KicadIndex;
          if (c.version === 1 && c.stamp === stamp) return (this.index = c);
        } catch {
          /* rebuild */
        }
      }
      const idx: KicadIndex = { version: 1, stamp, symbols: [], footprints: [] };
      for (const f of (await this.fs.list(this.symDir).catch(() => [])).filter((x) => x.endsWith('.kicad_sym')).sort()) {
        const lib = f.replace(/\.kicad_sym$/, '');
        const text = await this.fs.readText(`${this.symDir}/${f}`);
        for (const [name, chunk] of symbolChunks(text)) {
          if (/\n\t\t\(power\b/.test(chunk)) continue;
          const e: SymIndexEntry = { lib, name };
          const d = prop(chunk, 'Description') ?? prop(chunk, 'ki_description');
          const k = prop(chunk, 'ki_keywords');
          const fp = prop(chunk, 'Footprint');
          if (d) e.d = d;
          if (k) e.k = k;
          if (fp) e.f = fp;
          idx.symbols.push(e);
        }
      }
      for (const d of (await this.fs.list(this.fpDir).catch(() => [])).filter((x) => x.endsWith('.pretty')).sort()) {
        const lib = d.replace(/\.pretty$/, '');
        for (const f of await this.fs.list(`${this.fpDir}/${d}`).catch(() => [])) if (f.endsWith('.kicad_mod')) idx.footprints.push({ lib, name: f.replace(/\.kicad_mod$/, '') });
      }
      if (this.cachePath && this.writeCache) await this.writeCache(this.cachePath, JSON.stringify(idx)).catch(() => {});
      return (this.index = idx);
    })();
    try {
      return await this.building;
    } finally {
      this.building = null;
    }
  }

  async searchParts(q: string, limit: number): Promise<PartSummary[]> {
    const idx = await this.getIndex();
    const scored: [number, PartSummary][] = [];
    for (const e of idx.symbols) {
      const s: PartSummary & { keywords?: string[] } = { id: `kicad:${e.lib}:${e.name}`, name: e.name, category: e.lib, source: 'kicad', license: KICAD_LICENSE, ...(e.d ? { description: e.d } : {}), ...(e.f ? { footprint: e.f } : {}), ...(e.k ? { keywords: e.k.split(/\s+/) } : {}) };
      const sc = scorePart(s, q);
      if (sc > 0) {
        const { keywords: _k, ...rest } = s;
        scored.push([sc, rest]);
      }
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length).slice(0, limit).map(([, s]) => s);
  }

  async searchFootprints(q: string, limit: number): Promise<FootprintSummary[]> {
    const idx = await this.getIndex();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const out: FootprintSummary[] = [];
    for (const f of idx.footprints) {
      const full = `${f.lib}:${f.name}`;
      if (words.every((w) => full.toLowerCase().includes(w))) out.push({ name: full, source: 'kicad', license: KICAD_LICENSE });
    }
    return out.sort((a, b) => a.name.length - b.name.length).slice(0, limit);
  }

  private async chunks(lib: string): Promise<Map<string, string> | null> {
    const hit = this.fileCache.get(lib);
    if (hit) return hit;
    const path = `${this.symDir}/${lib}.kicad_sym`;
    if (!(await this.fs.exists(path))) return null;
    const m = symbolChunks(await this.fs.readText(path));
    if (this.fileCache.size > 8) this.fileCache.delete(this.fileCache.keys().next().value!);
    this.fileCache.set(lib, m);
    return m;
  }

  async getPart(id: string): Promise<PartDef | null> {
    const m = /^kicad:([^:]+):(.+)$/.exec(id);
    if (!m) return null;
    const chunks = await this.chunks(m[1]!);
    const chunk = chunks?.get(m[2]!);
    if (!chunks || !chunk) return null;
    const lists: SList[] = [parseSExpr(chunk)];
    // Follow `extends` chains inside the same library.
    let ext = /\(extends "([^"]+)"\)/.exec(chunk)?.[1];
    for (let i = 0; ext && i < 4; i++) {
      const c = chunks.get(ext);
      if (!c) break;
      lists.push(parseSExpr(c));
      ext = /\(extends "([^"]+)"\)/.exec(c)?.[1];
    }
    const part = partsFromSymbolLists(lists, m[1]!, new Set([m[2]!])).parts[0];
    return part ? { ...part, license: KICAD_LICENSE } : null;
  }

  async getFootprint(name: string): Promise<FootprintSpec | null> {
    const m = /^([^:]+):(.+)$/.exec(name);
    if (!m) return null;
    const path = `${this.fpDir}/${m[1]}.pretty/${m[2]}.kicad_mod`;
    if (!(await this.fs.exists(path))) return null;
    return { ...parseKicadFootprint(await this.fs.readText(path), m[1]), license: KICAD_LICENSE };
  }
}
