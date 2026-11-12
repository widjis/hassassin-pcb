/**
 * Official KiCad symbol and footprint libraries on demand (S21), for machines without KiCad.
 *
 * After the user agrees, the libraries are downloaded from KiCad's public repositories on GitLab
 * (one archive each) and unpacked into a local cache:
 *   <cache>/kicad-libraries/<version>/symbols/*.kicad_sym
 *   <cache>/kicad-libraries/<version>/footprints/<Lib>.pretty/*.kicad_mod
 *   <cache>/kicad-libraries/current.json   { version, date, sources, license }
 * They are data under their own license (CC BY-SA 4.0 with KiCad's library exception); they are
 * never copied into this repository. Node only (not exported from the package index).
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KICAD_REPOS = {
  symbols: 'https://gitlab.com/kicad/libraries/kicad-symbols',
  footprints: 'https://gitlab.com/kicad/libraries/kicad-footprints',
} as const;
export const KICAD_LIBRARY_LICENSE = {
  name: 'CC BY-SA 4.0 with the KiCad libraries exception',
  summary: 'The KiCad symbol and footprint libraries are licensed CC BY-SA 4.0, with an exception: using them in a design (and the boards, files and documents made from it) does not put the design under that license.',
  url: 'https://www.kicad.org/libraries/license/',
};
/** Used when the list of releases cannot be read. */
export const FALLBACK_VERSION = '9.0.6';

export function kicadCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'hassassin', 'kicad-libraries');
}

export interface DownloadedLibraries {
  version: string;
  date: string;
  symbols: string;
  footprints: string;
  sources: string[];
  license: string;
}

/** The downloaded libraries, or null when there are none. */
export async function downloadedKicadLibraries(root = kicadCacheRoot()): Promise<DownloadedLibraries | null> {
  try {
    const cur = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as Omit<DownloadedLibraries, 'symbols' | 'footprints'>;
    const dir = join(root, cur.version);
    const out = { ...cur, symbols: join(dir, 'symbols'), footprints: join(dir, 'footprints') };
    return existsSync(out.symbols) && existsSync(out.footprints) ? out : null;
  } catch {
    return null;
  }
}

/** Synchronous variant for start-up (reads current.json only when present). */
export function downloadedKicadDirsSync(root = kicadCacheRoot()): { symbols: string; footprints: string } | null {
  try {
    const text = readFileSync(join(root, 'current.json'), 'utf8');
    const v = String((JSON.parse(text) as { version: string }).version);
    const s = join(root, v, 'symbols');
    const f = join(root, v, 'footprints');
    return existsSync(s) && existsSync(f) ? { symbols: s, footprints: f } : null;
  } catch {
    return null;
  }
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Newest stable release tag (x.y.z, no release candidates) of the symbol repository. */
export async function latestKicadVersion(fetchImpl: Fetch = fetch): Promise<string> {
  try {
    const r = await fetchImpl('https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-symbols/repository/tags?per_page=50&order_by=version');
    if (!r.ok) return FALLBACK_VERSION;
    const tags = ((await r.json()) as { name: string }[]).map((t) => t.name).filter((n) => /^\d+\.\d+\.\d+$/.test(n));
    const key = (v: string) => v.split('.').map(Number) as [number, number, number];
    tags.sort((a, b) => { const x = key(a); const y = key(b); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
    return tags[0] ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const archiveUrl = (repo: string, version: string) => `${repo}/-/archive/${version}/${repo.split('/').pop()}-${version}.tar.gz`;

/**
 * Unpack the files of a .tar.gz stream that `keep` accepts (path without the archive's top folder)
 * into `dest`. Understands ustar and pax long names. Returns the number of files written.
 */
export async function untarGz(stream: Readable, dest: string, keep: (path: string) => boolean, onBytes?: (n: number) => void): Promise<number> {
  const gunzip = createGunzip();
  let total = 0;
  stream.on('data', (c: Buffer) => onBytes?.((total += c.length)));
  stream.pipe(gunzip);
  let buf: Buffer = Buffer.alloc(0);
  let written = 0;
  let paxPath: string | null = null;
  let pending: { path: string; size: number; type: string } | null = null;
  const str = (b: Buffer, a: number, n: number) => b.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  const writes: Promise<void>[] = [];
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!pending) {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        if (h.every((x) => x === 0)) {
          buf = buf.subarray(512);
          continue;
        }
        const name = str(h, 0, 100);
        const prefix = str(h, 345, 155);
        const size = parseInt(str(h, 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156]!) || '0';
        pending = { path: paxPath ?? (prefix ? `${prefix}/${name}` : name), size, type };
        if (type !== 'x' && type !== 'g') paxPath = null;
        buf = buf.subarray(512);
      }
      const need = Math.ceil(pending.size / 512) * 512;
      if (buf.length < need) break;
      const body = buf.subarray(0, pending.size);
      const { path, type } = pending;
      if (type === 'x') {
        // pax extended header: "len key=value\n" records; we only need the path.
        const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
        if (m) paxPath = m[1]!;
      } else if (type === '0' || type === '\0') {
        const rel = path.split('/').slice(1).join('/'); // drop the archive's top folder
        if (rel && !rel.includes('..') && keep(rel)) {
          const out = join(dest, rel);
          const data = Buffer.from(body);
          writes.push(mkdir(dirname(out), { recursive: true }).then(() => writeFile(out, data)));
          written++;
        }
      }
      buf = buf.subarray(need);
      pending = null;
    }
  }
  await Promise.all(writes);
  return written;
}

export interface DownloadProgress {
  stage: 'version' | 'symbols' | 'footprints' | 'done' | 'error';
  bytes: number;
  files: number;
  version?: string;
  error?: string;
}

/**
 * Download and unpack both libraries into the cache, then make them current. Only call this after
 * the user agreed (it fetches tens of megabytes from gitlab.com).
 */
export async function downloadKicadLibraries(opts: { version?: string; root?: string; fetchImpl?: Fetch; signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void } = {}): Promise<DownloadedLibraries> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const root = opts.root ?? kicadCacheRoot();
  const progress = (p: DownloadProgress) => opts.onProgress?.(p);
  progress({ stage: 'version', bytes: 0, files: 0 });
  const version = opts.version ?? (await latestKicadVersion(fetchImpl));
  const tmp = join(root, `.partial-${version}-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  let bytes = 0;
  let files = 0;
  try {
    for (const [what, repo, keep] of [
      ['symbols', KICAD_REPOS.symbols, (p: string) => /^[^/]+\.kicad_sym$/.test(p) || p === 'LICENSE.md'],
      ['footprints', KICAD_REPOS.footprints, (p: string) => /^[^/]+\.pretty\/[^/]+\.kicad_mod$/.test(p) || p === 'LICENSE.md'],
    ] as const) {
      const url = archiveUrl(repo, version);
      const r = await fetchImpl(url, opts.signal ? { signal: opts.signal } : undefined);
      if (!r.ok || !r.body) throw new Error(`Download of ${url} failed (${r.status})`);
      const base = bytes;
      const n = await untarGz(Readable.fromWeb(r.body as never), join(tmp, what), keep, (b) => {
        bytes = base + b;
        progress({ stage: what, bytes, files, version });
      });
      files += n;
      if (!n) throw new Error(`No ${what} found in ${url}`);
      progress({ stage: what, bytes, files, version });
    }
    const dir = join(root, version);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    const info = { version, date: new Date().toISOString(), sources: [archiveUrl(KICAD_REPOS.symbols, version), archiveUrl(KICAD_REPOS.footprints, version)], license: KICAD_LIBRARY_LICENSE.name };
    await writeFile(join(root, 'current.json'), JSON.stringify(info, null, 2));
    progress({ stage: 'done', bytes, files, version });
    return { ...info, symbols: join(dir, 'symbols'), footprints: join(dir, 'footprints') };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    progress({ stage: 'error', bytes, files, version, error: (e as Error).message });
    throw e;
  }
}
