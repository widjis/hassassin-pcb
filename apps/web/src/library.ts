/**
 * Browser side of the part library: the project's own parts and the generic ones are
 * always there; the collaboration server (when running) adds the team library and the
 * KiCad libraries installed on that machine.
 */
import type { FootprintSpec, PartDef, PartSummary } from '@hassassin/core';
import { Library, type FootprintSummary, type LibrarySource } from '@hassassin/tools';

async function get<T>(path: string): Promise<T | null> {
  const r = await fetch(path).catch(() => null);
  if (!r || !r.ok) return null;
  return (await r.json().catch(() => null)) as T | null;
}

export class ServerLibrary implements LibrarySource {
  name = 'server';
  available: boolean | null = null;
  sources: string[] = [];

  async check(): Promise<boolean> {
    if (this.available !== null) return this.available;
    const info = await get<{ sources: string[] }>('/api/library/info');
    this.sources = info?.sources ?? [];
    return (this.available = !!info);
  }
  async searchParts(q: string, limit: number): Promise<PartSummary[]> {
    if (!(await this.check())) return [];
    return (await get<PartSummary[]>(`/api/library/parts?q=${encodeURIComponent(q)}&limit=${limit}`)) ?? [];
  }
  async searchFootprints(q: string, limit: number): Promise<FootprintSummary[]> {
    if (!(await this.check())) return [];
    return (await get<FootprintSummary[]>(`/api/library/footprints?q=${encodeURIComponent(q)}&limit=${limit}`)) ?? [];
  }
  async getPart(id: string): Promise<PartDef | null> {
    if (!(await this.check())) return null;
    return get<PartDef>(`/api/library/part?id=${encodeURIComponent(id)}`);
  }
  async getFootprint(name: string): Promise<FootprintSpec | null> {
    if (!(await this.check())) return null;
    return get<FootprintSpec>(`/api/library/footprint?name=${encodeURIComponent(name)}`);
  }
}

export const serverLibrary = new ServerLibrary();
export const library = new Library([serverLibrary]);
