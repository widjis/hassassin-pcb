/**
 * Collaboration protocol (JSON over WebSocket).
 *
 * The server orders every change: clients apply their own edits immediately, send them,
 * and replay them on top of whatever the server broadcast in between.
 */
import type { Doc, DocFile, DocNode, Op } from '@hassassin/core';

export type Role = 'edit' | 'comment' | 'view';

export interface User {
  id: string;
  name: string;
  color: string;
  /** "agent" for AI/MCP clients, so the UI can label them. */
  kind?: 'person' | 'agent';
}

export interface Cursor {
  space: 'layout' | 'schematic';
  sheet?: string;
  x: number;
  y: number;
}

export interface Presence {
  clientId: string;
  user: User;
  cursor: Cursor | null;
  selection: string[];
}

export interface VersionInfo {
  id: string;
  name: string;
  seq: number;
  at: string;
  author: string;
  auto: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  createdAt: string;
  forkedFrom?: string;
  publicRole: Role | 'none';
}

// client → server
export type ClientMsg =
  | { t: 'hello'; project: string; token?: string; user: User }
  | { t: 'tx'; id: string; baseSeq: number; label: string; ops: Op[] }
  | { t: 'presence'; cursor: Cursor | null; selection: string[] }
  | { t: 'ping' };

// server → client
export type ServerMsg =
  | { t: 'welcome'; clientId: string; role: Role; seq: number; doc: DocFile; project: ProjectInfo; peers: Presence[] }
  | { t: 'tx'; seq: number; clientId: string; user: User; label: string; ops: Op[] }
  | { t: 'ack'; id: string; seq: number }
  | { t: 'reject'; id: string; reason: string }
  | { t: 'presence'; peer: Presence }
  | { t: 'leave'; clientId: string }
  | { t: 'reset'; seq: number; doc: DocFile; reason: string }
  | { t: 'error'; message: string }
  | { t: 'pong' };

export const COMMENTS_CONTAINER = 'Comments';

/** The container that holds comment threads (created by the server when missing). */
export function commentsContainer(doc: Doc): DocNode | undefined {
  const root = doc.nodes.get(doc.rootId);
  for (const c of root?.children ?? []) {
    const n = doc.nodes.get(c);
    if (n?.type === 'container' && n.name === COMMENTS_CONTAINER) return n;
  }
  return undefined;
}

const isCommentish = (doc: Doc, uid: string) => {
  const n = doc.nodes.get(uid);
  return !!n && (n.type === 'comment' || (n.type === 'container' && n.name === COMMENTS_CONTAINER));
};

/** Whether `role` may apply `ops` to `doc` (checked by the server and, for feedback, the client). */
export function opsAllowed(role: Role, doc: Doc, ops: Op[]): string | null {
  if (role === 'edit') return null;
  if (role === 'view') return 'You can only view this project.';
  for (const op of ops) {
    if (op.op === 'add') {
      if (!isCommentish(doc, op.parent) || op.tree.nodes.some((n) => n.type !== 'comment')) return 'Commenters can only add comments.';
    } else if (op.op === 'setProp' || op.op === 'remove') {
      if (doc.nodes.get(op.uid)?.type !== 'comment') return 'Commenters can only change comments.';
    } else return 'Commenters can only change comments.';
  }
  return null;
}
