/**
 * Style engine: resolves every node's rules into computed values and remembers where
 * each value came from.
 *
 * Precedence for one rule on one node (highest first):
 *   1. !important object-specific rule
 *   2. !important project ruleset (higher specificity, then later order)
 *   3. object-specific rule
 *   4. project ruleset (higher specificity, then later order)
 *   5. inherited from the parent — only for inheritable rules (the parent's value may
 *      itself be a default, so e.g. a ground net's default width reaches its traces)
 *   6. default ruleset for the node type
 */
import type { Doc, DocNode, RuleDecl, RuleValue, Ruleset } from './model.ts';
import { walk } from './model.ts';
import { RULE_DEFS } from './ruleDefs.ts';
import { compareSpecificity, matchSpecificity, parseSelector, type SelectorList, type Specificity } from './selector.ts';

export type SourceKind = 'object' | 'ruleset' | 'inherited' | 'default';

export interface Source {
  kind: SourceKind;
  important: boolean;
  rulesetId?: string;
  rulesetName?: string;
  selector?: string;
  /** For inherited values: the ancestor whose value was taken. */
  fromUid?: string;
}

export interface Computed {
  value: RuleValue;
  source: Source;
}

export type ComputedMap = Map<string, Computed>;

interface Candidate {
  decl: RuleDecl;
  important: boolean;
  origin: 2 | 1; // object = 2, ruleset = 1
  spec: Specificity;
  order: number;
  ruleset?: Ruleset;
}

function better(a: Candidate, b: Candidate): boolean {
  if (a.important !== b.important) return a.important;
  if (a.origin !== b.origin) return a.origin > b.origin;
  const s = compareSpecificity(a.spec, b.spec);
  if (s !== 0) return s > 0;
  return a.order > b.order;
}

interface Compiled {
  ruleset: Ruleset;
  list: SelectorList | null;
  error?: string;
}

export interface RulesetMatch {
  ruleset: Ruleset;
  count: number;
  error?: string;
}

export class StyleEngine {
  private computed = new Map<string, ComputedMap>();
  private compiledProject: Compiled[] = [];
  private compiledDefaults: Compiled[] = [];
  private matchCounts = new Map<string, number>();

  constructor(private readonly doc: Doc) {
    this.recompute();
  }

  private compile(rs: Ruleset): Compiled {
    try {
      return { ruleset: rs, list: parseSelector(rs.selector) };
    } catch (e) {
      return { ruleset: rs, list: null, error: (e as Error).message };
    }
  }

  /** Recompute everything. Fine for Phase 0; incremental invalidation comes later. */
  recompute(): void {
    const { doc } = this;
    this.compiledProject = doc.rulesets.filter((r) => r.enabled).map((r) => this.compile(r));
    this.compiledDefaults = doc.defaults.filter((r) => r.enabled).map((r) => this.compile(r));
    this.computed.clear();
    this.matchCounts.clear();
    for (const node of walk(doc)) this.computed.set(node.uid, this.computeNode(node));
  }

  private computeNode(node: DocNode): ComputedMap {
    const best = new Map<string, Candidate>();
    const offer = (c: Candidate) => {
      const cur = best.get(c.decl.name);
      if (!cur || better(c, cur)) best.set(c.decl.name, c);
    };

    node.rules.forEach((decl, i) =>
      offer({ decl, important: !!decl.important, origin: 2, spec: [Infinity, 0, 0], order: i }),
    );
    this.compiledProject.forEach((c, order) => {
      if (!c.list) return;
      const spec = matchSpecificity(this.doc, node, c.list);
      if (!spec) return;
      this.matchCounts.set(c.ruleset.id, (this.matchCounts.get(c.ruleset.id) ?? 0) + 1);
      for (const decl of c.ruleset.rules) offer({ decl, important: !!decl.important, origin: 1, spec, order, ruleset: c.ruleset });
    });

    const out: ComputedMap = new Map();
    for (const [name, c] of best) {
      out.set(name, {
        value: c.decl.value,
        source: {
          kind: c.origin === 2 ? 'object' : 'ruleset',
          important: c.important,
          ...(c.ruleset ? { rulesetId: c.ruleset.id, rulesetName: c.ruleset.name, selector: c.ruleset.selector } : {}),
        },
      });
    }

    // Inheritance.
    const parent = node.parent ? this.computed.get(node.parent) : undefined;
    if (parent) {
      for (const [name, pc] of parent) {
        if (out.has(name)) continue;
        if (!RULE_DEFS.get(name)?.inheritable) continue;
        out.set(name, {
          value: pc.value,
          source: {
            kind: 'inherited',
            important: false,
            fromUid: pc.source.kind === 'inherited' ? pc.source.fromUid : node.parent!,
            ...(pc.source.kind === 'default' ? { rulesetId: pc.source.rulesetId, rulesetName: pc.source.rulesetName, selector: pc.source.selector } : {}),
          },
        });
      }
    }

    // Defaults (lowest); among themselves they cascade by specificity, then order.
    const defBest = new Map<string, Candidate>();
    this.compiledDefaults.forEach((c, order) => {
      const spec = c.list ? matchSpecificity(this.doc, node, c.list) : null;
      if (!spec) return;
      this.matchCounts.set(c.ruleset.id, (this.matchCounts.get(c.ruleset.id) ?? 0) + 1);
      for (const decl of c.ruleset.rules) {
        if (out.has(decl.name)) continue;
        const cand: Candidate = { decl, important: false, origin: 1, spec, order, ruleset: c.ruleset };
        const cur = defBest.get(decl.name);
        if (!cur || better(cand, cur)) defBest.set(decl.name, cand);
      }
    });
    for (const [name, c] of defBest) {
      out.set(name, {
        value: c.decl.value,
        source: { kind: 'default', important: false, rulesetId: c.ruleset!.id, rulesetName: c.ruleset!.name, selector: c.ruleset!.selector },
      });
    }
    return out;
  }

  /** All computed values for a node. */
  of(uid: string): ComputedMap {
    return this.computed.get(uid) ?? new Map();
  }

  get(uid: string, rule: string): Computed | undefined {
    return this.computed.get(uid)?.get(rule);
  }

  value<T extends RuleValue = RuleValue>(uid: string, rule: string, fallback: T): T {
    const c = this.computed.get(uid)?.get(rule);
    return c === undefined ? fallback : (c.value as T);
  }

  /** How many nodes each ruleset (project and default) currently matches. */
  rulesetMatches(): RulesetMatch[] {
    return [...this.compiledDefaults, ...this.compiledProject].map((c) => ({
      ruleset: c.ruleset,
      count: this.matchCounts.get(c.ruleset.id) ?? 0,
      ...(c.error ? { error: c.error } : {}),
    }));
  }
}
