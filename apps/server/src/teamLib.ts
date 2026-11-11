/**
 * Team library on the server: parts and footprints published from projects, stored as
 * versioned JSON documents under <data>/library/{parts,footprints}/.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { genericFootprint, partSummary, scorePart, type FootprintSpec, type PartDef, type PartSummary } from '@hassassin/core';
import type { FootprintSummary, LibrarySource } from '@hassassin/tools';

const safe = (s: string) => encodeURIComponent(s).replace(/%/g, '_');

export class TeamLibrary implements LibrarySource {
  name = 'team';
  private dir: string;
  private parts = new Map<string, PartDef>();
  private fps = new Map<string, FootprintSpec>();
  private loaded: Promise<void> | null = null;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'library');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const [sub, map] of [['parts', this.parts], ['footprints', this.fps]] as const) {
        const d = join(this.dir, sub);
        if (!existsSync(d)) continue;
        for (const f of await readdir(d)) {
          if (!f.endsWith('.json')) continue;
          try {
            const v = JSON.parse(await readFile(join(d, f), 'utf8'));
            (map as Map<string, unknown>).set(sub === 'parts' ? v.id : v.name, v);
          } catch {
            /* skip broken file */
          }
        }
      }
    })();
    return this.loaded;
  }

  /** Publish (or update) a part; returns the stored version. */
  async publishPart(part: PartDef, author: string): Promise<PartDef> {
    await this.load();
    if (!part.id || !part.name || !Array.isArray(part.units)) throw new Error('A part needs id, name and units.');
    const id = part.id.startsWith('team:') ? part.id : `team:${part.id.replace(/^(kicad|project|mpn|generic):/, '')}`;
    const prev = this.parts.get(id);
    const stored: PartDef & { author?: string; updatedAt?: string } = { ...part, id, source: 'team', version: (prev?.version ?? 0) + 1, author, updatedAt: new Date().toISOString() };
    await mkdir(join(this.dir, 'parts'), { recursive: true });
    await writeFile(join(this.dir, 'parts', `${safe(id)}.json`), JSON.stringify(stored, null, 1));
    this.parts.set(id, stored);
    return stored;
  }

  async publishFootprint(fp: FootprintSpec): Promise<FootprintSpec> {
    await this.load();
    if (!fp.name || !Array.isArray(fp.pads)) throw new Error('A footprint needs name and pads.');
    if (genericFootprint(fp.name)) return fp; // generics are built in
    const stored = { ...fp, source: 'team' };
    await mkdir(join(this.dir, 'footprints'), { recursive: true });
    await writeFile(join(this.dir, 'footprints', `${safe(fp.name)}.json`), JSON.stringify(stored));
    this.fps.set(fp.name, stored);
    return stored;
  }

  async searchParts(q: string, limit: number): Promise<PartSummary[]> {
    await this.load();
    return [...this.parts.values()]
      .map((p) => [scorePart({ ...partSummary(p), ...(p.keywords ? { keywords: p.keywords } : {}) }, q), partSummary(p)] as const)
      .filter(([s]) => s > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, limit)
      .map(([, p]) => p);
  }

  async searchFootprints(q: string, limit: number): Promise<FootprintSummary[]> {
    await this.load();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.fps.values()].filter((f) => words.every((w) => `${f.name} ${f.description ?? ''}`.toLowerCase().includes(w))).slice(0, limit).map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), source: 'team' }));
  }

  async getPart(id: string) {
    await this.load();
    return this.parts.get(id) ?? null;
  }

  async getFootprint(name: string) {
    await this.load();
    return this.fps.get(name) ?? null;
  }
}
