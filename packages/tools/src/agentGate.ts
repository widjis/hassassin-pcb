/**
 * Gates for agents (docs/06-agent-plugins.md, A13): changes an agent never makes without the user's OK, at
 * every autonomy level. The one a tool call can reach is a bulk removal: deleting (or replacing, which
 * removes first) more than a set number of parts or nets in one change. The others of the agreement are out
 * of the agent's reach: fabrication and file exports are not offered to it, publishing to the team library
 * and inviting people are not tools, and it never receives a secret.
 *
 * A project worked on by an agent carries a `guard`; `apply` checks every change against it and throws a
 * GateError instead of applying. Whoever runs the agent's tools asks the user (a card), and once the user
 * allows it, sets `guard.allow` for one change of at most that size and runs the tool again.
 */
import type { Doc, Op } from '@hassassin/core';
import type { Project } from './project.ts';

export interface AgentGuard {
  /** More parts or nets than this removed in one change needs the user's OK. */
  bulkLimit: number;
  /** An OK the user gave: one change removing at most `max`. Used once. */
  allow?: { kind: 'bulk-remove'; max: number };
}

export interface GateInfo {
  kind: 'bulk-remove';
  count: number;
  parts: string[];
  nets: string[];
  label: string;
  summary: string;
}

/** Not a ToolError subclass (tools.ts imports this file); callers tell it apart with `instanceof`. */
export class GateError extends Error {
  gate: GateInfo;
  constructor(gate: GateInfo) {
    super(`This needs the user's OK first: ${gate.summary}. A card asks them; stop here, tell the user why, and wait for their answer.`);
    this.gate = gate;
  }
}

export const DEFAULT_BULK_LIMIT = 5;

/** Parts (by reference) and nets that a change removes. */
export function removals(doc: Doc, ops: Op[]): { parts: string[]; nets: string[] } {
  const parts = new Set<string>();
  const nets = new Set<string>();
  for (const op of ops) {
    if (op.op !== 'remove') continue;
    const n = doc.nodes.get(op.uid);
    if (!n) continue;
    if (n.type === 'element') parts.add(n.name);
    else if (n.type === 'symbol' && !n.props.power) parts.add(String(n.props.ref ?? n.name));
    else if (n.type === 'net' && n.name !== '(no net)') nets.add(n.name);
  }
  return { parts: [...parts].sort(), nets: [...nets].sort() };
}

/** Throws a GateError when an agent's change goes past a gate (and no OK covers it). */
export function checkGate(p: Project, label: string, ops: Op[]): void {
  const g = p.guard;
  if (!g) return;
  const { parts, nets } = removals(p.doc, ops);
  const count = parts.length + nets.length;
  if (count <= g.bulkLimit) return;
  if (g.allow?.kind === 'bulk-remove' && count <= g.allow.max) {
    g.allow = undefined;
    return;
  }
  const list = (xs: string[]) => (xs.length > 8 ? `${xs.slice(0, 8).join(', ')} and ${xs.length - 8} more` : xs.join(', '));
  const summary = `${label}: removing ${parts.length ? `${parts.length} part${parts.length === 1 ? '' : 's'} (${list(parts)})` : ''}${parts.length && nets.length ? ' and ' : ''}${nets.length ? `${nets.length} net${nets.length === 1 ? '' : 's'} (${list(nets)})` : ''} at once (more than ${g.bulkLimit})`;
  throw new GateError({ kind: 'bulk-remove', count, parts, nets, label, summary });
}
