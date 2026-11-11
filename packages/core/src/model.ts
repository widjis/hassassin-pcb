/**
 * The document is a tree of typed nodes with stable UIDs. Geometry and layout values
 * are not plain fields: they are *rules* (object-specific declarations or rulesets)
 * that the style engine resolves into computed values.
 */

export type NodeType =
  | 'root'
  | 'layout'
  | 'container'
  | 'group'
  | 'element'
  | 'footprint'
  | 'pad'
  | 'trace'
  | 'via'
  | 'fill'
  | 'zone'
  | 'net'
  | 'text'
  | 'line'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'rectangle'
  // schematic
  | 'schematic'
  | 'sheet'
  | 'block'
  | 'sheetPin'
  | 'symbol'
  | 'pin'
  | 'wire'
  | 'label'
  | 'junction'
  | 'noconnect'
  // collaboration
  | 'comment';

export const NODE_TYPES: readonly NodeType[] = [
  'root', 'layout', 'container', 'group', 'element', 'footprint', 'pad', 'trace', 'via',
  'fill', 'zone', 'net', 'text', 'line', 'circle', 'arc', 'polygon', 'rectangle',
  'schematic', 'sheet', 'block', 'sheetPin', 'symbol', 'pin', 'wire', 'label', 'junction', 'noconnect', 'comment',
];

export interface Vec2 {
  x: number;
  y: number;
}

export interface KeepOut {
  /** Clearance against everything not listed in `byType` (mm). */
  all?: number;
  /** Clearance per target type, e.g. { fill: 0.5, net: 0.3 } (mm). */
  byType: Record<string, number>;
}

export type RuleValue =
  | number
  | string
  | boolean
  | Vec2
  | Vec2[]
  | Vec2[][]
  | string[]
  | KeepOut;

export interface RuleDecl {
  name: string;
  value: RuleValue;
  important?: boolean;
}

export type PropValue = string | number | boolean;

export interface DocNode {
  uid: string;
  type: NodeType;
  /** Designator or display name (R1, GND, "Components"). */
  name: string;
  /** Free metadata (Value, MPN, Footprint, net name…). Selectable with [prop]. */
  props: Record<string, PropValue>;
  /** Object-specific rules — the "Specified" values of this node. */
  rules: RuleDecl[];
  parent: string | null;
  children: string[];
  /** Heavy derived data that is not a rule (e.g. imported zone fill polygons). */
  data?: Record<string, unknown>;
}

export type RulesetOrigin = 'default' | 'project';

export interface Ruleset {
  id: string;
  name: string;
  description?: string;
  selector: string;
  rules: RuleDecl[];
  enabled: boolean;
  origin: RulesetOrigin;
}

export interface Doc {
  rootId: string;
  nodes: Map<string, DocNode>;
  /** Project rulesets, in cascade order (later wins at equal specificity). */
  rulesets: Ruleset[];
  /** Read-only rulesets applied below everything else. */
  defaults: Ruleset[];
  meta: Record<string, unknown>;
}

let uidCounter = 0;
export function newUid(prefix = 'n'): string {
  uidCounter += 1;
  return `${prefix}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createDoc(defaults: Ruleset[] = []): Doc {
  const rootId = newUid('root');
  const nodes = new Map<string, DocNode>();
  nodes.set(rootId, { uid: rootId, type: 'root', name: 'Project', props: {}, rules: [], parent: null, children: [] });
  return { rootId, nodes, rulesets: [], defaults, meta: {} };
}

export interface NewNode {
  uid?: string;
  type: NodeType;
  name?: string;
  props?: Record<string, PropValue>;
  rules?: RuleDecl[];
  data?: Record<string, unknown>;
}

export function addNode(doc: Doc, parentUid: string, spec: NewNode): DocNode {
  const parent = doc.nodes.get(parentUid);
  if (!parent) throw new Error(`addNode: unknown parent ${parentUid}`);
  let uid = spec.uid ?? newUid(spec.type.slice(0, 2));
  if (doc.nodes.has(uid)) uid = newUid(spec.type.slice(0, 2));
  const node: DocNode = {
    uid,
    type: spec.type,
    name: spec.name ?? '',
    props: spec.props ?? {},
    rules: spec.rules ?? [],
    parent: parentUid,
    children: [],
    ...(spec.data ? { data: spec.data } : {}),
  };
  doc.nodes.set(uid, node);
  parent.children.push(uid);
  return node;
}

export function getNode(doc: Doc, uid: string): DocNode {
  const n = doc.nodes.get(uid);
  if (!n) throw new Error(`unknown node ${uid}`);
  return n;
}

/** Depth-first, parents before children. */
export function* walk(doc: Doc, fromUid = doc.rootId): Generator<DocNode> {
  const stack = [fromUid];
  while (stack.length) {
    const uid = stack.pop()!;
    const n = doc.nodes.get(uid);
    if (!n) continue;
    yield n;
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
}

export function ancestors(doc: Doc, uid: string): DocNode[] {
  const out: DocNode[] = [];
  let p = doc.nodes.get(uid)?.parent ?? null;
  while (p) {
    const n = doc.nodes.get(p);
    if (!n) break;
    out.push(n);
    p = n.parent;
  }
  return out;
}

export function setRule(node: DocNode, decl: RuleDecl): void {
  const i = node.rules.findIndex((r) => r.name === decl.name);
  if (i >= 0) node.rules[i] = decl;
  else node.rules.push(decl);
}
