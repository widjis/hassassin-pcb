/**
 * A small CSS-like selector language over the document tree.
 *
 *   trace                       type
 *   #R2   #"U 1"                designator (node name)
 *   [MPN]  [Value="10k"]        property presence / exact
 *   [name^=SPI] [x$=_N] [x*=CLK] [x~=word] [x|=lang]   partial matches; add " i" for case-insensitive
 *   [uid=abc]                   node uid
 *   *                           any node
 *   a b   a > b                 descendant / child
 *   :not(sel)                   negation
 *   a, b                        list
 *
 * Specificity is [ids, attributes, types]; `*`, combinators and :not() add nothing.
 */
import type { Doc, DocNode } from './model.ts';

type AttrOp = '=' | '~=' | '|=' | '^=' | '$=' | '*=';

interface AttrTest {
  name: string;
  op?: AttrOp;
  value?: string;
  caseInsensitive?: boolean;
}

interface Compound {
  type?: string; // undefined or '*' = any
  ids: string[];
  attrs: AttrTest[];
  nots: SelectorList[];
}

interface Complex {
  /** Compounds left to right; combinators[i] joins parts[i] and parts[i+1]. */
  parts: Compound[];
  combinators: ('>' | ' ')[];
}

export type Specificity = [number, number, number];

export interface SelectorList {
  source: string;
  complexes: Complex[];
}

export class SelectorError extends Error {}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  private peek(): string {
    return this.s[this.i] ?? '';
  }
  private eof(): boolean {
    return this.i >= this.s.length;
  }
  private ws(): boolean {
    const start = this.i;
    while (/\s/.test(this.peek())) this.i++;
    return this.i > start;
  }
  private err(msg: string): never {
    throw new SelectorError(`${msg} at position ${this.i} in "${this.s}"`);
  }
  private expect(ch: string): void {
    if (this.peek() !== ch) this.err(`expected "${ch}"`);
    this.i++;
  }
  private quoted(): string {
    const q = this.peek();
    this.i++;
    let out = '';
    while (!this.eof() && this.peek() !== q) {
      if (this.peek() === '\\') this.i++;
      out += this.peek();
      this.i++;
    }
    if (this.eof()) this.err('unterminated string');
    this.i++;
    return out;
  }
  private ident(re: RegExp): string {
    const start = this.i;
    while (!this.eof() && re.test(this.peek())) this.i++;
    if (this.i === start) this.err('expected a name');
    return this.s.slice(start, this.i);
  }
  private value(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.quoted();
    return this.ident(/[^\s\]"']/);
  }

  list(stopAtParen = false): SelectorList {
    const start = this.i;
    const complexes: Complex[] = [];
    this.ws();
    for (;;) {
      complexes.push(this.complex());
      this.ws();
      if (this.peek() === ',') {
        this.i++;
        this.ws();
        continue;
      }
      if (stopAtParen && this.peek() === ')') break;
      if (this.eof()) break;
      this.err(`unexpected "${this.peek()}"`);
    }
    return { source: this.s.slice(start, this.i).trim(), complexes };
  }

  private complex(): Complex {
    const parts: Compound[] = [this.compound()];
    const combinators: ('>' | ' ')[] = [];
    for (;;) {
      const hadWs = this.ws();
      const c = this.peek();
      if (c === '>') {
        this.i++;
        this.ws();
        combinators.push('>');
        parts.push(this.compound());
      } else if (hadWs && c !== '' && c !== ',' && c !== ')') {
        combinators.push(' ');
        parts.push(this.compound());
      } else {
        return { parts, combinators };
      }
    }
  }

  private compound(): Compound {
    const comp: Compound = { ids: [], attrs: [], nots: [] };
    let any = false;
    const c0 = this.peek();
    if (c0 === '*') {
      this.i++;
      comp.type = '*';
      any = true;
    } else if (/[a-zA-Z]/.test(c0)) {
      comp.type = this.ident(/[a-zA-Z0-9_-]/);
      any = true;
    }
    for (;;) {
      const c = this.peek();
      if (c === '#') {
        this.i++;
        const q = this.peek();
        comp.ids.push(q === '"' || q === "'" ? this.quoted() : this.ident(/[^\s>,#[\]:()*"'=]/));
        any = true;
      } else if (c === '[') {
        this.i++;
        this.ws();
        const name = this.ident(/[^\s\]=~|^$*"']/);
        this.ws();
        const test: AttrTest = { name };
        const op2 = this.s.slice(this.i, this.i + 2);
        if (['~=', '|=', '^=', '$=', '*='].includes(op2)) {
          test.op = op2 as AttrOp;
          this.i += 2;
        } else if (this.peek() === '=') {
          test.op = '=';
          this.i++;
        }
        if (test.op) {
          this.ws();
          test.value = this.value();
          this.ws();
          if (/^i\b/i.test(this.s.slice(this.i)) && this.s[this.i + 1] !== '=') {
            test.caseInsensitive = true;
            this.i++;
            this.ws();
          }
        }
        this.expect(']');
        comp.attrs.push(test);
        any = true;
      } else if (this.s.startsWith(':not(', this.i)) {
        this.i += 5;
        comp.nots.push(this.list(true));
        this.expect(')');
        any = true;
      } else {
        break;
      }
    }
    if (!any) this.err('expected a selector');
    return comp;
  }
}

const cache = new Map<string, SelectorList>();

export function parseSelector(source: string): SelectorList {
  const hit = cache.get(source);
  if (hit) return hit;
  const p = new Parser(source);
  const list = p.list();
  if (cache.size > 2000) cache.clear();
  cache.set(source, list);
  return list;
}

function complexSpecificity(c: Complex): Specificity {
  const s: Specificity = [0, 0, 0];
  for (const p of c.parts) {
    s[0] += p.ids.length;
    s[1] += p.attrs.length;
    if (p.type && p.type !== '*') s[2] += 1;
  }
  return s;
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const normKey = (k: string) => k.replace(/\s+/g, '');

function attrValue(node: DocNode, name: string): string | undefined {
  if (name === 'uid') return node.uid;
  if (name === 'name' || name === 'designator') return node.name;
  if (name === 'type') return node.type;
  const direct = node.props[name];
  if (direct !== undefined) return String(direct);
  for (const [k, v] of Object.entries(node.props)) if (normKey(k) === name) return String(v);
  return undefined;
}

function attrMatches(node: DocNode, t: AttrTest): boolean {
  let actual = attrValue(node, t.name);
  if (actual === undefined || actual === '') return false;
  if (!t.op) return true;
  let want = t.value ?? '';
  if (t.caseInsensitive) {
    actual = actual.toLowerCase();
    want = want.toLowerCase();
  }
  switch (t.op) {
    case '=':
      return actual === want;
    case '~=':
      return actual.split(/\s+/).includes(want);
    case '|=':
      return actual === want || actual.startsWith(`${want}-`);
    case '^=':
      return want !== '' && actual.startsWith(want);
    case '$=':
      return want !== '' && actual.endsWith(want);
    case '*=':
      return want !== '' && actual.includes(want);
  }
}

function compoundMatches(doc: Doc, node: DocNode, c: Compound): boolean {
  if (c.type && c.type !== '*' && node.type !== c.type) return false;
  for (const id of c.ids) if (node.name !== id) return false;
  for (const a of c.attrs) if (!attrMatches(node, a)) return false;
  for (const n of c.nots) if (matchesList(doc, node, n)) return false;
  return true;
}

function complexMatches(doc: Doc, node: DocNode, cx: Complex): boolean {
  // Right-to-left with backtracking over descendant combinators.
  const rec = (n: DocNode, idx: number): boolean => {
    if (!compoundMatches(doc, n, cx.parts[idx]!)) return false;
    if (idx === 0) return true;
    const comb = cx.combinators[idx - 1];
    let p = n.parent ? doc.nodes.get(n.parent) : undefined;
    if (comb === '>') return p ? rec(p, idx - 1) : false;
    while (p) {
      if (rec(p, idx - 1)) return true;
      p = p.parent ? doc.nodes.get(p.parent) : undefined;
    }
    return false;
  };
  return rec(node, cx.parts.length - 1);
}

function matchesList(doc: Doc, node: DocNode, list: SelectorList): boolean {
  return list.complexes.some((cx) => complexMatches(doc, node, cx));
}

/** Highest specificity among the list's complexes that match `node`, or null. */
export function matchSpecificity(doc: Doc, node: DocNode, list: SelectorList): Specificity | null {
  let best: Specificity | null = null;
  for (const cx of list.complexes) {
    if (!complexMatches(doc, node, cx)) continue;
    const s = complexSpecificity(cx);
    if (!best || compareSpecificity(s, best) > 0) best = s;
  }
  return best;
}

export function matches(doc: Doc, node: DocNode, selector: string | SelectorList): boolean {
  const list = typeof selector === 'string' ? parseSelector(selector) : selector;
  return matchesList(doc, node, list);
}

export function querySelectorAll(doc: Doc, selector: string): DocNode[] {
  const list = parseSelector(selector);
  const out: DocNode[] = [];
  for (const n of doc.nodes.values()) if (matchesList(doc, n, list)) out.push(n);
  return out;
}
