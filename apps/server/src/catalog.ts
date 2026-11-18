/**
 * The plugin catalog (docs/06-agent-plugins.md, A12): the plugins the owner trusts, which this server may
 * install on request (by the user or, within the project's limits, by the agent). Nothing outside the
 * catalog is ever installed: no npm, pip or system packages, no address the agent picked.
 *
 * The catalog is `plugins/catalog.json` in this repository (updated with the app), or the file or address
 * named by `"catalog"` in `<data>/plugins.json`. Each entry is either bundled with Hassassin (`bundled`) or a
 * single-file plugin (one `.mjs`, no install step) with its download address, SHA-256, license and the
 * oldest Hassassin version it works with. Installing checks the license and the SHA-256, stores the file in
 * `<data>/plugins/<id>/<version>/` and adds its manifest to `plugins.json`; every install, update and
 * removal is logged in `<data>/plugin-log/_installs.jsonl` with who or what asked for it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { manifestProblems, type PluginManifest } from './plugins.ts';

export interface CatalogEntry {
  id: string;
  /** Comes with Hassassin (`plugins/<id>/`): nothing to download. */
  bundled?: boolean;
  version?: string;
  license?: string;
  /** Oldest Hassassin version it works with. */
  minHassassin?: string;
  /** Its manifest (A1) without `command` / `args` (the downloaded file is the command). */
  manifest?: Omit<PluginManifest, 'command' | 'args' | 'dir' | 'builtin'>;
  download?: { url: string; sha256: string };
}

export interface CatalogInstall {
  at: string;
  action: 'install' | 'update' | 'remove';
  id: string;
  version: string;
  /** Who or what asked: a person, or "agent (for …)" with its reason. */
  by: string;
  reason?: string;
}

/** Licenses a catalog plugin may have (permissive only). */
export const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT', 'BSL-1.0']);

export const HASSASSIN_VERSION = (() => {
  try {
    return String((JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

export interface CatalogOptions {
  dataDir: string;
  /** The repository's `plugins/` folder (its `catalog.json` is the default catalog). */
  builtinDir: string | null;
  /** For tests: allow downloads from http and local addresses. */
  allowLocal?: boolean;
  fetchImpl?: typeof fetch;
}

export class Catalog {
  private o: CatalogOptions;
  private cache: { key: string; entries: CatalogEntry[]; problems: string[] } | null = null;

  constructor(o: CatalogOptions) {
    this.o = o;
  }

  private get pluginsFile(): string {
    return join(this.o.dataDir, 'plugins.json');
  }

  /** Where the catalog comes from: `"catalog"` in plugins.json, else the repository's plugins/catalog.json. */
  source(): string | null {
    try {
      const raw = existsSync(this.pluginsFile) ? (JSON.parse(readFileSync(this.pluginsFile, 'utf8')) as { catalog?: unknown }) : {};
      if (typeof raw.catalog === 'string' && raw.catalog.trim()) {
        const c = raw.catalog.trim();
        return /^https?:\/\//.test(c) || isAbsolute(c) ? c : resolve(this.o.dataDir, c);
      }
    } catch {
      /* the plugins file is reported by the host */
    }
    return this.o.builtinDir ? join(this.o.builtinDir, 'catalog.json') : null;
  }

  /** The catalog's entries (a remote catalog is read again after ten minutes). */
  async entries(): Promise<{ entries: CatalogEntry[]; problems: string[] }> {
    const src = this.source();
    if (!src) return { entries: [], problems: [] };
    const remote = /^https?:\/\//.test(src);
    const key = remote ? `${src}@${Math.floor(Date.now() / 600_000)}` : existsSync(src) ? `${src}@${statSync(src).mtimeMs}` : `${src}@none`;
    if (this.cache?.key === key) return this.cache;
    const problems: string[] = [];
    let raw: { plugins?: CatalogEntry[] } = {};
    try {
      if (remote) {
        const r = await (this.o.fetchImpl ?? fetch)(src, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        raw = (await r.json()) as typeof raw;
      } else if (existsSync(src)) raw = JSON.parse(readFileSync(src, 'utf8')) as typeof raw;
    } catch (e) {
      problems.push(`The catalog (${src}) cannot be read: ${(e as Error).message}`);
    }
    const entries: CatalogEntry[] = [];
    for (const e of raw.plugins ?? []) {
      if (!e || typeof e.id !== 'string') continue;
      if (e.bundled) {
        entries.push({ id: e.id, bundled: true });
        continue;
      }
      const why: string[] = [];
      if (!e.version || !/^\d+\.\d+\.\d+$/.test(e.version)) why.push('version');
      if (!e.license || !PERMISSIVE.has(e.license)) why.push(`license ${e.license ?? '(none)'} is not a permissive one`);
      if (!e.download?.url || !/^[0-9a-f]{64}$/.test(e.download.sha256 ?? '')) why.push('download address or SHA-256');
      if (!e.download?.url?.endsWith('.mjs')) why.push('the download must be one .mjs file');
      const m = manifestProblems({ ...(e.manifest ?? {}), id: e.id, command: 'plugin.mjs' } as Partial<PluginManifest>);
      if (m.length) why.push(...m);
      if (why.length) problems.push(`Catalog entry ${e.id}: ${why.join('; ')}`);
      else entries.push(e);
    }
    this.cache = { key, entries, problems };
    return this.cache;
  }

  async entry(id: string): Promise<CatalogEntry | undefined> {
    return (await this.entries()).entries.find((e) => e.id === id);
  }

  private readPlugins(): { plugins: Record<string, unknown>[]; rest: Record<string, unknown> } {
    if (!existsSync(this.pluginsFile)) return { plugins: [], rest: {} };
    const raw = JSON.parse(readFileSync(this.pluginsFile, 'utf8')) as Record<string, unknown>;
    const { plugins, ...rest } = raw;
    return { plugins: Array.isArray(plugins) ? (plugins as Record<string, unknown>[]) : [], rest };
  }

  private writePlugins(plugins: Record<string, unknown>[], rest: Record<string, unknown>): void {
    mkdirSync(this.o.dataDir, { recursive: true });
    writeFileSync(`${this.pluginsFile}.tmp`, `${JSON.stringify({ ...rest, plugins }, null, 2)}\n`);
    renameSync(`${this.pluginsFile}.tmp`, this.pluginsFile);
  }

  /** The version of a catalog plugin installed from the catalog, if any. */
  installedVersion(id: string): string | null {
    const p = this.readPlugins().plugins.find((x) => x.id === id) as { catalog?: { version?: string } } | undefined;
    return p?.catalog?.version ?? null;
  }

  private async logInstall(e: CatalogInstall): Promise<void> {
    await mkdir(join(this.o.dataDir, 'plugin-log'), { recursive: true });
    await appendFile(join(this.o.dataDir, 'plugin-log', '_installs.jsonl'), `${JSON.stringify(e)}\n`);
  }

  readInstalls(last = 30): CatalogInstall[] {
    const f = join(this.o.dataDir, 'plugin-log', '_installs.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-last).map((l) => JSON.parse(l) as CatalogInstall);
  }

  /**
   * Install (or update) a catalog plugin: only an id the catalog lists, a permissive license, a Hassassin
   * new enough, and a download whose SHA-256 is the catalog's. Bundled plugins need no install.
   */
  async install(id: string, by: string, reason?: string): Promise<{ id: string; version: string; action: 'install' | 'update' | 'none' }> {
    const e = await this.entry(id);
    if (!e) throw new Error(`${id} is not in the plugin catalog; only catalog plugins can be installed.`);
    if (e.bundled) return { id, version: HASSASSIN_VERSION, action: 'none' };
    if (e.minHassassin && newer(e.minHassassin, HASSASSIN_VERSION)) throw new Error(`${id} ${e.version} needs Hassassin ${e.minHassassin} or newer (this is ${HASSASSIN_VERSION}).`);
    const was = this.installedVersion(id);
    if (was === e.version) return { id, version: e.version!, action: 'none' };
    const url = e.download!.url;
    if (!this.o.allowLocal && !url.startsWith('https://')) throw new Error(`${id}: the download must come over https.`);
    const r = await (this.o.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
    if (!r.ok) throw new Error(`${id}: the download answered ${r.status}.`);
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > 20 * 1024 * 1024) throw new Error(`${id}: the download is larger than 20 MB.`);
    const sha = createHash('sha256').update(body).digest('hex');
    if (sha !== e.download!.sha256) throw new Error(`${id}: the download's SHA-256 (${sha.slice(0, 16)}…) is not the catalog's (${e.download!.sha256.slice(0, 16)}…); refused.`);
    const dir = join(this.o.dataDir, 'plugins', id, e.version!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.mjs'), body);
    const { plugins, rest } = this.readPlugins();
    const manifest = { ...e.manifest, id, version: e.version, command: join(dir, 'plugin.mjs'), args: [], catalog: { version: e.version, sha256: sha, license: e.license } };
    const next = [...plugins.filter((p) => p.id !== id), manifest];
    this.writePlugins(next, rest);
    // The older version's folder goes once the new one is in place.
    if (was) rmSync(join(this.o.dataDir, 'plugins', id, was), { recursive: true, force: true });
    const action = was ? 'update' : 'install';
    await this.logInstall({ at: new Date().toISOString(), action, id, version: e.version!, by, ...(reason ? { reason } : {}) });
    return { id, version: e.version!, action };
  }

  /** Remove a plugin installed from the catalog (bundled plugins and the owner's own entries stay). */
  async remove(id: string, by: string): Promise<void> {
    const { plugins, rest } = this.readPlugins();
    const p = plugins.find((x) => x.id === id) as { catalog?: { version?: string } } | undefined;
    if (!p?.catalog) throw new Error(`${id} was not installed from the catalog; remove it from plugins.json by hand.`);
    this.writePlugins(plugins.filter((x) => x.id !== id), rest);
    rmSync(join(this.o.dataDir, 'plugins', id), { recursive: true, force: true });
    await this.logInstall({ at: new Date().toISOString(), action: 'remove', id, version: p.catalog.version ?? '', by });
  }
}

