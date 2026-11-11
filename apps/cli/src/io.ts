/** File helpers shared by the CLI and the MCP server (Node only). */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper';
import { ensureGeometry, openProject, saveProject, type InputFile, type Project } from '@hassassin/tools';

export const loadGeometry = () => ensureGeometry(() => loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmOnly));

export const isHpcb = (p: string) => extname(p).toLowerCase() === '.hpcb';

/**
 * Read a project. For a .kicad_pcb, the .kicad_sch files next to it are loaded too;
 * extra files (schematics in another folder) can be passed explicitly.
 */
export async function readProject(paths: string[]): Promise<Project> {
  if (!paths.length) throw new Error('Give a project file (.hpcb) or KiCad files.');
  const files: InputFile[] = [];
  const seen = new Set<string>();
  const add = async (p: string) => {
    const abs = resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    files.push({ name: abs, text: await readFile(abs, 'utf8') });
  };
  for (const p of paths) await add(p);
  const pcb = paths.find((p) => p.toLowerCase().endsWith('.kicad_pcb'));
  if (pcb && !paths.some((p) => p.toLowerCase().endsWith('.kicad_sch'))) {
    const dir = dirname(resolve(pcb));
    for (const f of await readdir(dir)) if (f.toLowerCase().endsWith('.kicad_sch')) await add(join(dir, f));
  }
  const proj = openProject(files);
  if (isHpcb(paths[0]!)) proj.name = basename(paths[0]!).replace(/\.hpcb$/i, '');
  return proj;
}

export async function writeProject(p: Project, path: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, saveProject(p));
}

export async function writeAny(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
}

export async function mtime(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}
