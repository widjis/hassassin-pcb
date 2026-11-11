/**
 * Every change to a document is a list of small, invertible operations. The UI, undo/redo,
 * and later collaboration and the AI agent all go through `History.apply`.
 */
import type { Doc, DocNode, PropValue, RuleDecl, Ruleset } from './model.ts';

/** A node and its whole subtree, detached from any document. */
export interface Subtree {
  nodes: DocNode[]; // first entry is the subtree root
}

export type Op =
  | { op: 'setRule'; uid: string; name: string; decl: RuleDecl | null }
  | { op: 'setProp'; uid: string; key: string; value: PropValue | null }
  | { op: 'setName'; uid: string; name: string }
  | { op: 'add'; parent: string; index: number; tree: Subtree }
  | { op: 'remove'; uid: string }
  | { op: 'setRulesets'; rulesets: Ruleset[] }
  /** Derived data that is not a rule (e.g. computed pour polygons). */
  | { op: 'setData'; uid: string; key: string; value: unknown }
  /** Project-level metadata (specification, stage gates…). */
  | { op: 'setMeta'; key: string; value: unknown };

export interface ApplyResult {
  inverse: Op[];
  /** Nodes whose own geometry/values may have changed (descendants not included). */
  touched: Set<string>;
  /** True when rulesets changed, so everything must be recomputed. */
  global: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

export function snapshot(doc: Doc, uid: string): Subtree {
  const out: DocNode[] = [];
  const visit = (u: string) => {
    const n = doc.nodes.get(u);
    if (!n) return;
    out.push(clone(n));
    n.children.forEach(visit);
  };
  visit(uid);
  return { nodes: out };
}

function applyOne(doc: Doc, op: Op, res: ApplyResult): void {
  switch (op.op) {
    case 'setRule': {
      const n = doc.nodes.get(op.uid);
      if (!n) throw new Error(`setRule: unknown node ${op.uid}`);
      const i = n.rules.findIndex((r) => r.name === op.name);
      const prev = i >= 0 ? n.rules[i]! : null;
      if (op.decl) {
        if (i >= 0) n.rules[i] = clone(op.decl);
        else n.rules.push(clone(op.decl));
      } else if (i >= 0) n.rules.splice(i, 1);
      res.inverse.push({ op: 'setRule', uid: op.uid, name: op.name, decl: prev ? clone(prev) : null });
      res.touched.add(op.uid);
      return;
    }
    case 'setProp': {
      const n = doc.nodes.get(op.uid);
      if (!n) throw new Error(`setProp: unknown node ${op.uid}`);
      const prev = op.key in n.props ? n.props[op.key]! : null;
      if (op.value === null) delete n.props[op.key];
      else n.props[op.key] = op.value;
      res.inverse.push({ op: 'setProp', uid: op.uid, key: op.key, value: prev });
      res.touched.add(op.uid);
      return;
    }
    case 'setName': {
      const n = doc.nodes.get(op.uid);
      if (!n) throw new Error(`setName: unknown node ${op.uid}`);
      res.inverse.push({ op: 'setName', uid: op.uid, name: n.name });
      n.name = op.name;
      res.touched.add(op.uid);
      return;
    }
    case 'add': {
      const parent = doc.nodes.get(op.parent);
      if (!parent) throw new Error(`add: unknown parent ${op.parent}`);
      const [root, ...rest] = op.tree.nodes;
      if (!root) return;
      for (const n of op.tree.nodes) if (doc.nodes.has(n.uid)) throw new Error(`add: duplicate uid ${n.uid}`);
      for (const n of [root, ...rest]) doc.nodes.set(n.uid, clone(n));
      doc.nodes.get(root.uid)!.parent = op.parent;
      const idx = Math.max(0, Math.min(op.index, parent.children.length));
      parent.children.splice(idx, 0, root.uid);
      res.inverse.push({ op: 'remove', uid: root.uid });
      for (const n of op.tree.nodes) res.touched.add(n.uid);
      return;
    }
    case 'remove': {
      const n = doc.nodes.get(op.uid);
      if (!n || !n.parent) throw new Error(`remove: cannot remove ${op.uid}`);
      const parent = doc.nodes.get(n.parent)!;
      const index = parent.children.indexOf(op.uid);
      const tree = snapshot(doc, op.uid);
      parent.children.splice(index, 1);
      for (const x of tree.nodes) doc.nodes.delete(x.uid);
      res.inverse.push({ op: 'add', parent: parent.uid, index, tree });
      for (const x of tree.nodes) res.touched.add(x.uid);
      return;
    }
    case 'setData': {
      const n = doc.nodes.get(op.uid);
      if (!n) throw new Error(`setData: unknown node ${op.uid}`);
      const prev = n.data && op.key in n.data ? n.data[op.key] : null;
      if (op.value === null || op.value === undefined) {
        if (n.data) delete n.data[op.key];
      } else {
        n.data = { ...(n.data ?? {}), [op.key]: clone(op.value) };
      }
      res.inverse.push({ op: 'setData', uid: op.uid, key: op.key, value: prev === null ? null : clone(prev) });
      res.touched.add(op.uid);
      return;
    }
    case 'setMeta': {
      const prev = op.key in doc.meta ? clone(doc.meta[op.key]) : null;
      if (op.value === null || op.value === undefined) delete doc.meta[op.key];
      else doc.meta[op.key] = clone(op.value);
      res.inverse.push({ op: 'setMeta', key: op.key, value: prev });
      res.touched.add(doc.rootId);
      return;
    }
    case 'setRulesets': {
      res.inverse.push({ op: 'setRulesets', rulesets: clone(doc.rulesets) });
      doc.rulesets = clone(op.rulesets);
      res.global = true;
      return;
    }
  }
}

/** Apply ops in order. On error, already-applied ops are rolled back and the error rethrown. */
export function applyOps(doc: Doc, ops: Op[]): ApplyResult {
  const res: ApplyResult = { inverse: [], touched: new Set(), global: false };
  try {
    for (const op of ops) applyOne(doc, op, res);
  } catch (e) {
    const undo = res.inverse.slice().reverse();
    applyOps(doc, undo);
    throw e;
  }
  res.inverse.reverse();
  return res;
}

export interface HistoryEntry {
  label: string;
  ops: Op[];
  inverse: Op[];
  /** Consecutive entries with the same key are merged (e.g. one drag = one undo step). */
  mergeKey?: string;
}

/** `ops` are the forward operations that were just applied (what a collaborator needs). */
export type ChangeListener = (res: ApplyResult, kind: 'do' | 'undo' | 'redo' | 'remote', ops: Op[], label: string) => void;

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<ChangeListener>();
  limit = 500;

  private doc: Doc;
  constructor(doc: Doc) {
    this.doc = doc;
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(res: ApplyResult, kind: 'do' | 'undo' | 'redo' | 'remote', ops: Op[], label: string) {
    for (const l of this.listeners) l(res, kind, ops, label);
  }

  /**
   * Apply operations that came from someone else: they change the document and notify
   * listeners, but do not enter this user's undo stack.
   */
  applyRemote(label: string, ops: Op[]): ApplyResult {
    const res = applyOps(this.doc, ops);
    this.notify(res, 'remote', ops, label);
    return res;
  }

  /** Tell listeners that the document changed outside of ops (e.g. a full reload). */
  notifyExternal(res: ApplyResult): void {
    this.notify(res, 'remote', [], '');
  }

  apply(label: string, ops: Op[], mergeKey?: string): ApplyResult {
    if (!ops.length) return { inverse: [], touched: new Set(), global: false };
    const res = applyOps(this.doc, ops);
    const top = this.undoStack[this.undoStack.length - 1];
    if (mergeKey && top && top.mergeKey === mergeKey) {
      top.ops.push(...ops);
      top.inverse = [...res.inverse, ...top.inverse];
    } else {
      this.undoStack.push({ label, ops: [...ops], inverse: res.inverse, ...(mergeKey ? { mergeKey } : {}) });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.notify(res, 'do', ops, label);
    return res;
  }

  /** Stop merging into the last entry (call at the end of a drag). */
  seal(): void {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) delete top.mergeKey;
  }

  undo(): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    const inv = e.inverse;
    const res = applyOps(this.doc, inv);
    this.redoStack.push(e);
    this.notify(res, 'undo', inv, `Undo ${e.label}`);
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    const res = applyOps(this.doc, e.ops);
    e.inverse = res.inverse;
    this.undoStack.push(e);
    this.notify(res, 'redo', e.ops, e.label);
    return e;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }
  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
