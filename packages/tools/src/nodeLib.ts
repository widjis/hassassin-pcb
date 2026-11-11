/**
 * Node-only helpers: find the KiCad libraries installed on this machine.
 * Not exported from the package index (the browser build must not pull in node:fs);
 * the CLI and the server import this file directly.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KicadSystemLibrary, type LibFs } from './library.ts';

export const nodeLibFs: LibFs = {
  readText: (p) => readFile(p, 'utf8'),
  list: (d) => readdir(d),
  exists: async (p) => existsSync(p),
  mtime: async (p) => (await stat(p)).mtimeMs,
};

/** KiCad symbol/footprint folders: env vars first, then the usual install places. */
export function findKicadDirs(env: NodeJS.ProcessEnv = process.env): { symbols: string; footprints: string } | null {
  const symEnv = Object.entries(env).find(([k]) => /^KICAD\d*_SYMBOL_DIR$/.test(k))?.[1];
  const fpEnv = Object.entries(env).find(([k]) => /^KICAD\d*_FOOTPRINT_DIR$/.test(k))?.[1];
  if (env.HASSASSIN_NO_KICAD) return null;
  if (symEnv && fpEnv && existsSync(symEnv) && existsSync(fpEnv)) return { symbols: symEnv, footprints: fpEnv };
  const roots = [
    '/Applications/KiCad/KiCad.app/Contents/SharedSupport',
    '/usr/share/kicad',
    '/usr/local/share/kicad',
    'C:\\Program Files\\KiCad\\9.0\\share\\kicad',
    'C:\\Program Files\\KiCad\\8.0\\share\\kicad',
  ];
  for (const r of roots) {
    const s = join(r, 'symbols');
    const f = join(r, 'footprints');
    if (existsSync(s) && existsSync(f)) return { symbols: symEnv ?? s, footprints: fpEnv ?? f };
  }
  return null;
}

let shared: KicadSystemLibrary | null | undefined;

/** The installed KiCad libraries (index cached under ~/.cache/hassassin), or null. */
export function kicadSystemLibrary(): KicadSystemLibrary | null {
  if (shared !== undefined) return shared;
  const dirs = findKicadDirs();
  if (!dirs) return (shared = null);
  const cachePath = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'hassassin', 'kicad-index.json');
  shared = new KicadSystemLibrary({
    fs: nodeLibFs,
    symbolsDir: dirs.symbols,
    footprintsDir: dirs.footprints,
    cachePath,
    writeCache: async (p, t) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, t);
    },
  });
  return shared;
}
