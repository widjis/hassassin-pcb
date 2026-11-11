/**
 * Our own file format (.hpcb): versioned JSON of the node tree, project rulesets and
 * metadata. Defaults are not stored; they come from the app version that opens the file.
 */
import { systemDefaults } from './defaults.ts';
import type { Doc, DocNode, Ruleset } from './model.ts';

export const FORMAT = 'hassassin-pcb';
export const FORMAT_VERSION = 1;

export interface DocFile {
  format: typeof FORMAT;
  version: number;
  savedAt: string;
  rootId: string;
  nodes: DocNode[];
  rulesets: Ruleset[];
  meta: Record<string, unknown>;
}

export function toFile(doc: Doc): DocFile {
  const nodes: DocNode[] = [];
  const visit = (uid: string) => {
    const n = doc.nodes.get(uid);
    if (!n) return;
    nodes.push(n);
    n.children.forEach(visit);
  };
  visit(doc.rootId);
  return { format: FORMAT, version: FORMAT_VERSION, savedAt: new Date().toISOString(), rootId: doc.rootId, nodes, rulesets: doc.rulesets, meta: doc.meta };
}

export function stringifyDoc(doc: Doc): string {
  return JSON.stringify(toFile(doc));
}

export function fromFile(data: unknown): Doc {
  const f = data as Partial<DocFile>;
  if (!f || f.format !== FORMAT) throw new Error('Not a Hassassin PCB file.');
  if (typeof f.version !== 'number' || f.version > FORMAT_VERSION) {
    throw new Error(`This file was saved by a newer version (format ${f.version}). Please update the app.`);
  }
  if (!Array.isArray(f.nodes) || typeof f.rootId !== 'string') throw new Error('The file is damaged (no node list).');
  const nodes = new Map<string, DocNode>();
  for (const n of f.nodes) {
    if (!n || typeof n.uid !== 'string' || typeof n.type !== 'string') throw new Error('The file is damaged (bad node).');
    nodes.set(n.uid, { ...n, props: n.props ?? {}, rules: n.rules ?? [], children: n.children ?? [], parent: n.parent ?? null });
  }
  if (!nodes.has(f.rootId)) throw new Error('The file is damaged (missing root).');
  // Drop dangling child references rather than failing.
  for (const n of nodes.values()) n.children = n.children.filter((c) => nodes.has(c));
  return { rootId: f.rootId, nodes, rulesets: f.rulesets ?? [], defaults: systemDefaults(), meta: f.meta ?? {} };
}

export function parseDoc(text: string): Doc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  return fromFile(data);
}
