/**
 * Copy, paste and duplicate for schematic items (S3).
 *
 * A clip holds whole subtrees (a symbol with its pins, a wire, a label …) as they are in the
 * document, plus an anchor point. Pasting gives every node a new uid, gives symbols the next
 * free references (R7 → R8 …, units of one part keep sharing a reference) and moves everything
 * by an offset. Connections inside the copied group are kept because the geometry is kept;
 * labels keep their names, so pasted global labels join the same nets.
 */
import type { Op, Subtree } from './commands.ts';
import { snapshot } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { symbolBounds } from './schematicEdit.ts';

export interface Clip {
  kind: 'hassassin-schematic-clip';
  version: 1;
  trees: Subtree[];
  /** Centre of the copied items, on the grid. */
  anchor: Vec2;
}

const COPYABLE = new Set(['symbol', 'wire', 'label', 'junction', 'noconnect']);
const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v && 'y' in v ? (v as Vec2) : undefined);
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000 });

/** Copy the given items (others in the list are ignored). Returns null when nothing is copyable. */
export function copyItems(doc: Doc, engine: StyleEngine, uids: Iterable<string>, grid = 1.27): Clip | null {
  const trees: Subtree[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p: Vec2) => ((x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y)));
  for (const uid of uids) {
    const n = doc.nodes.get(uid);
    if (!n || !COPYABLE.has(n.type)) continue;
    // A symbol's own labels come with the symbol.
    if (n.type === 'label' && doc.nodes.get(n.parent ?? '')?.type === 'symbol') continue;
    trees.push(snapshot(doc, uid));
    if (n.type === 'symbol') {
      const b = symbolBounds(doc, engine, uid);
      grow({ x: b.minX, y: b.minY });
      grow({ x: b.maxX, y: b.maxY });
    } else if (n.type === 'wire') {
      for (const k of ['start', 'end']) {
        const p = vec(engine.get(uid, k)?.value);
        if (p) grow(p);
      }
    } else {
      const p = vec(engine.get(uid, 'position')?.value);
      if (p) grow(p);
    }
  }
  if (!trees.length || !Number.isFinite(x0)) return null;
  const anchor = { x: Math.round((x0 + x1) / 2 / grid) * grid, y: Math.round((y0 + y1) / 2 / grid) * grid };
  return { kind: 'hassassin-schematic-clip', version: 1, trees, anchor: round(anchor) };
}

/** True when `v` looks like a clip (for reading one back from storage). */
export function isClip(v: unknown): v is Clip {
  return !!v && typeof v === 'object' && (v as Clip).kind === 'hassassin-schematic-clip' && Array.isArray((v as Clip).trees);
}

/** Splits "R12" → ["R", 12], "#PWR3" → ["#PWR", 3]; null for references without a number. */
function splitRef(ref: string): [string, number] | null {
  const m = /^(#?[A-Za-z_]+)(\d+)$/.exec(ref);
  return m ? [m[1]!, Number(m[2])] : null;
}

export interface PasteResult {
  ops: Op[];
  /** Uids of the pasted top-level items (to select them). */
  uids: string[];
  /** Every rule holding a sheet position, as pasted: move them together to let the paste follow the mouse. */
  positions: { uid: string; name: string; value: Vec2 }[];
  /** Old reference → new reference. */
  refs: Map<string, string>;
}

/** Ops that paste `clip` onto a sheet, moved by `offset` (sheet mm). */
export function pasteOps(doc: Doc, sheetUid: string, clip: Clip, offset: Vec2): PasteResult {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) throw new Error('No such sheet');
  // References in use, per prefix.
  const used = new Map<string, Set<number>>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' && n.type !== 'element') continue;
    const s = splitRef(String(n.props.ref ?? n.name));
    if (s) (used.get(s[0]) ?? used.set(s[0], new Set()).get(s[0])!).add(s[1]);
  }
  const refs = new Map<string, string>();
  const newRef = (old: string): string => {
    const known = refs.get(old);
    if (known) return known;
    const s = splitRef(old);
    if (!s) return old;
    const set = used.get(s[0]) ?? used.set(s[0], new Set()).get(s[0])!;
    let i = 1;
    while (set.has(i)) i++;
    set.add(i);
    const r = `${s[0]}${i}`;
    refs.set(old, r);
    return r;
  };

  const ops: Op[] = [];
  const uids: string[] = [];
  const positions: PasteResult['positions'] = [];
  clip.trees.forEach((tree, ti) => {
    const map = new Map<string, string>();
    for (const n of tree.nodes) map.set(n.uid, newUid(n.type.slice(0, 3)));
    const nodes: DocNode[] = tree.nodes.map((n, i) => {
      const uid = map.get(n.uid)!;
      const out: DocNode = {
        ...structuredClone(n),
        uid,
        parent: i === 0 ? sheetUid : (map.get(n.parent ?? '') ?? null),
        children: n.children.map((c) => map.get(c)!).filter(Boolean),
      };
      // Pins are placed relative to their symbol; everything else holds sheet positions.
      if (n.type !== 'pin') {
        out.rules = out.rules.map((r) => {
          const v = vec(r.value);
          if (!v || !['position', 'start', 'end'].includes(r.name)) return r;
          const moved = round({ x: v.x + offset.x, y: v.y + offset.y });
          positions.push({ uid, name: r.name, value: moved });
          return { ...r, value: moved };
        });
      }
      if (n.type === 'symbol') {
        const old = String(n.props.ref ?? '');
        if (old) {
          const r = newRef(old);
          out.props = { ...out.props, ref: r };
          if (n.name === old) out.name = r;
        }
      }
      return out;
    });
    uids.push(nodes[0]!.uid);
    ops.push({ op: 'add', parent: sheetUid, index: sheet.children.length + ti, tree: { nodes } });
  });
  return { ops, uids, positions, refs };
}
