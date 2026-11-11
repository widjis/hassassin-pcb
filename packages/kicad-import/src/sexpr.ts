/**
 * Minimal S-expression reader for KiCad text files.
 * Lists become arrays, quoted strings become { s: string } so they can be told apart
 * from bare atoms (which stay plain strings).
 */

export interface Quoted {
  s: string;
}
export type SAtom = string | Quoted;
export type SExpr = SAtom | SList;
export interface SList extends Array<SExpr> {}

export class SExprError extends Error {}

export function parseSExpr(text: string): SList {
  let i = 0;
  const n = text.length;
  const stack: SList[] = [];
  let root: SList | null = null;

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 40 /* ( */) {
      const list: SList = [];
      if (stack.length) stack[stack.length - 1]!.push(list);
      else if (root === null) root = list;
      else throw new SExprError(`more than one top-level list (offset ${i})`);
      stack.push(list);
      i++;
    } else if (c === 41 /* ) */) {
      if (!stack.length) throw new SExprError(`unbalanced ")" at offset ${i}`);
      stack.pop();
      i++;
    } else if (c === 34 /* " */) {
      i++;
      let out = '';
      let start = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 /* \ */) {
          out += text.slice(start, i);
          const e = text[i + 1] ?? '';
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
          start = i;
        } else if (d === 34) {
          break;
        } else {
          i++;
        }
      }
      if (i >= n) throw new SExprError('unterminated string');
      out += text.slice(start, i);
      i++;
      const top = stack[stack.length - 1];
      if (!top) throw new SExprError('string outside of a list');
      top.push({ s: out });
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
    } else {
      const start = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 40 || d === 41 || d === 32 || d === 9 || d === 10 || d === 13 || d === 34) break;
        i++;
      }
      const top = stack[stack.length - 1];
      if (!top) throw new SExprError('atom outside of a list');
      top.push(text.slice(start, i));
    }
  }
  if (stack.length) throw new SExprError('unexpected end of file (unclosed list)');
  if (!root) throw new SExprError('empty file');
  return root;
}

// ---- helpers for walking the tree ----

export const isList = (e: SExpr | undefined): e is SList => Array.isArray(e);

export function str(e: SExpr | undefined): string | undefined {
  if (e === undefined || isList(e)) return undefined;
  return typeof e === 'string' ? e : e.s;
}

export function num(e: SExpr | undefined): number | undefined {
  const s = str(e);
  if (s === undefined) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

export const head = (l: SList): string | undefined => str(l[0]);

/** First child list whose head is `key`. */
export function child(l: SList, key: string): SList | undefined {
  for (const e of l) if (isList(e) && head(e) === key) return e;
  return undefined;
}

export function children(l: SList, key: string): SList[] {
  const out: SList[] = [];
  for (const e of l) if (isList(e) && head(e) === key) out.push(e);
  return out;
}

/** True when a bare atom flag (e.g. `hide`) or a `(flag yes)` child is present. */
export function flag(l: SList, key: string): boolean {
  for (const e of l) {
    if (e === key) return true;
    if (isList(e) && head(e) === key) return str(e[1]) !== 'no';
  }
  return false;
}
