/**
 * A loaded project with everything tools need: document, style engine, history, layers.
 * Shared by the CLI, the MCP server and (later) the in-app agent.
 */
import {
  applyOps,
  createDoc,
  hasClipper,
  History,
  newProjectOps,
  parseDoc,
  setClipper,
  stringifyDoc,
  StyleEngine,
  systemDefaults,
  type Doc,
} from '@hassassin/core';
import { importKicadPcb, importKicadSchematic, type LayerInfo } from '@hassassin/kicad-import';

export const DEFAULT_LAYERS: LayerInfo[] = [
  ['F.Cu', 'copper', 'front'], ['B.Cu', 'copper', 'back'], ['F.SilkS', 'silk', 'front'], ['B.SilkS', 'silk', 'back'],
  ['F.Mask', 'mask', 'front'], ['B.Mask', 'mask', 'back'], ['F.Paste', 'paste', 'front'], ['B.Paste', 'paste', 'back'],
  ['F.CrtYd', 'courtyard', 'front'], ['F.Fab', 'fab', 'front'], ['Edge.Cuts', 'edge', 'none'],
].map(([name, kind, side], index) => ({ name: name!, kind: kind as LayerInfo['kind'], side: side as LayerInfo['side'], index }));

export interface Project {
  name: string;
  doc: Doc;
  engine: StyleEngine;
  history: History;
  layers: LayerInfo[];
  copper: string[];
  /** Set when a tool changed the document since it was loaded/saved. */
  dirty: boolean;
}

/** Wrap a document as a tool-ready project (style engine + history). */
export function wrapProject(doc: Doc, layers: LayerInfo[], name: string): Project {
  if (!doc.meta.layers) doc.meta.layers = layers;
  const engine = new StyleEngine(doc);
  const history = new History(doc);
  const p: Project = { name, doc, engine, history, layers, copper: layers.filter((l) => l.kind === 'copper').map((l) => l.name), dirty: false };
  history.onChange(() => {
    engine.recompute();
    p.dirty = true;
  });
  return p;
}

export interface InputFile {
  name: string;
  text: string;
}

/** Open a .hpcb, or a KiCad board and/or schematics (root sheet is detected). */
export function openProject(files: InputFile[]): Project {
  const hpcb = files.find((f) => /\.hpcb$/i.test(f.name));
  if (hpcb) {
    const doc = parseDoc(hpcb.text);
    return wrapProject(doc, (doc.meta.layers as LayerInfo[]) ?? DEFAULT_LAYERS, hpcb.name.replace(/\.hpcb$/i, ''));
  }
  const pcb = files.find((f) => /\.kicad_pcb$/i.test(f.name));
  const schs = files.filter((f) => /\.kicad_sch$/i.test(f.name));
  if (!pcb && !schs.length) throw new Error('Nothing to open: give a .hpcb, a .kicad_pcb and/or .kicad_sch files.');
  let doc: Doc;
  let layers = DEFAULT_LAYERS;
  let name = 'project';
  if (pcb) {
    const r = importKicadPcb(pcb.text, pcb.name);
    doc = r.doc;
    layers = r.layers;
    name = pcb.name.replace(/\.kicad_pcb$/i, '');
  } else doc = createDoc(systemDefaults());
  if (schs.length) {
    const map: Record<string, string> = {};
    for (const f of schs) map[f.name.split('/').pop()!] = f.text;
    const referenced = new Set<string>();
    for (const f of schs) for (const m of f.text.matchAll(/\(property "Sheet ?file" "([^"]+)"/g)) referenced.add(m[1]!.split('/').pop()!);
    const base = (n: string) => n.split('/').pop()!;
    const root = schs.find((f) => pcb && base(f.name) === base(pcb.name).replace(/\.kicad_pcb$/i, '.kicad_sch')) ?? schs.find((f) => !referenced.has(base(f.name))) ?? schs[0]!;
    importKicadSchematic({ files: map, root: base(root.name) }, doc);
    if (!pcb) name = base(root.name).replace(/\.kicad_sch$/i, '');
  }
  return wrapProject(doc, layers, name);
}

export function newProject(name = 'untitled'): Project {
  const doc = createDoc(systemDefaults());
  doc.meta.layers = DEFAULT_LAYERS;
  applyOps(doc, newProjectOps(doc));
  return wrapProject(doc, DEFAULT_LAYERS, name);
}

export function saveProject(p: Project): string {
  p.dirty = false;
  return stringifyDoc(p.doc);
}

/** Load the polygon engine (needed for pours). Pass the platform's loader. */
export async function ensureGeometry(load: () => Promise<unknown>): Promise<void> {
  if (hasClipper()) return;
  setClipper((await load()) as Parameters<typeof setClipper>[0]);
}
