/**
 * SyncClient: keeps one document in step with a collaboration server.
 *
 * Local edits (anything that goes through History.apply / undo / redo) are applied at once,
 * sent as a transaction, and kept as "pending" until the server acknowledges them. When a
 * remote transaction arrives, pending edits are rolled back, the remote one is applied, and
 * the pending edits are replayed on top — the same order the server used — so every
 * client ends up with the same document.
 */
import { applyOps, fromFile, newUid, type ApplyResult, type Doc, type History, type Op } from '@hassassin/core';
import type { ClientMsg, Cursor, Presence, ProjectInfo, Role, ServerMsg, User } from './protocol.ts';
import { opsAllowed } from './protocol.ts';

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'closed';

interface Pending {
  id: string;
  label: string;
  ops: Op[];
  inverse: Op[];
}

export interface SyncTarget {
  /** Current document and its history (the client listens to the history). */
  doc(): Doc;
  history(): History;
  /** Replace the whole document (first connection, restore, resync). */
  replace(doc: Doc): void;
  /** The document changed because of remote edits or a rebase. */
  changed(res: ApplyResult): void;
}

type Events = {
  status: SyncStatus;
  presence: Map<string, Presence>;
  rejected: { label: string; reason: string };
  remote: { label: string; user: User };
  reset: { reason: string };
  welcome: { role: Role; project: ProjectInfo };
};

export interface SyncOptions {
  /** ws:// or wss:// URL of the server's socket endpoint. */
  url: string;
  project: string;
  token?: string;
  user: User;
  target: SyncTarget;
  /** WebSocket constructor (defaults to the global one). */
  WebSocketImpl?: typeof WebSocket;
  reconnect?: boolean;
}

export class SyncClient {
  status: SyncStatus = 'connecting';
  role: Role = 'view';
  clientId = '';
  seq = 0;
  project: ProjectInfo | null = null;
  readonly peers = new Map<string, Presence>();
  private pending: Pending[] = [];
  private ws: WebSocket | null = null;
  private opts: SyncOptions;
  private unlisten: (() => void) | null = null;
  private listeners = new Map<keyof Events, Set<(v: never) => void>>();
  private applyingRemote = false;
  private retry = 0;
  private closed = false;
  private welcomed: ((v: void) => void) | null = null;
  private failed: ((e: Error) => void) | null = null;
  private flushWaiters: (() => void)[] = [];
  private lastPresence: { cursor: Cursor | null; selection: string[] } = { cursor: null, selection: [] };

  constructor(opts: SyncOptions) {
    this.opts = opts;
  }

  on<K extends keyof Events>(ev: K, fn: (v: Events[K]) => void): () => void {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn as (v: never) => void);
    return () => s!.delete(fn as (v: never) => void);
  }
  private emit<K extends keyof Events>(ev: K, v: Events[K]): void {
    this.listeners.get(ev)?.forEach((f) => (f as (x: Events[K]) => void)(v));
  }
  private setStatus(s: SyncStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Connect and wait for the first welcome (the document is then in the target). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.welcomed = resolve;
      this.failed = reject;
      this.open();
    });
  }

  private open(): void {
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    this.setStatus('connecting');
    const ws = new WS(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', project: this.opts.project, ...(this.opts.token ? { token: this.opts.token } : {}), user: this.opts.user });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return this.setStatus('closed');
      this.setStatus('offline');
      if (this.failed && !this.clientId) {
        this.failed(new Error('Could not connect to the collaboration server.'));
        this.failed = null;
        return;
      }
      if (this.opts.reconnect !== false) {
        const delay = Math.min(10000, 500 * 2 ** this.retry++);
        setTimeout(() => !this.closed && this.open(), delay);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  close(): void {
    this.closed = true;
    this.unlisten?.();
    this.ws?.close();
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  sendPresence(cursor: Cursor | null, selection: string[]): void {
    this.lastPresence = { cursor, selection };
    this.send({ t: 'presence', cursor, selection });
  }

  /** Resolves when every local edit has been acknowledged by the server. */
  flush(): Promise<void> {
    if (!this.pending.length) return Promise.resolve();
    return new Promise((r) => this.flushWaiters.push(r));
  }

  private checkFlushed(): void {
    if (this.pending.length) return;
    const w = this.flushWaiters.splice(0);
    w.forEach((f) => f());
  }

  /** Listen to the target's history so local edits are sent. Called after every replace. */
  private attach(): void {
    this.unlisten?.();
    this.unlisten = this.opts.target.history().onChange((res, kind, ops, label) => {
      if (kind === 'remote' || this.applyingRemote || !ops.length) return;
      const why = opsAllowed(this.role, this.opts.target.doc(), ops);
      if (why) {
        // Not allowed: take it back right away.
        this.applyingRemote = true;
        try {
          const r = applyOps(this.opts.target.doc(), res.inverse);
          this.opts.target.changed({ ...r, global: true });
        } finally {
          this.applyingRemote = false;
        }
        this.emit('rejected', { label, reason: why });
        return;
      }
      const p: Pending = { id: newUid('tx'), label, ops: structuredClone(ops), inverse: res.inverse };
      this.pending.push(p);
      this.send({ t: 'tx', id: p.id, baseSeq: this.seq, label, ops: p.ops });
    });
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.retry = 0;
        this.clientId = msg.clientId;
        this.role = msg.role;
        this.seq = msg.seq;
        this.project = msg.project;
        this.peers.clear();
        for (const p of msg.peers) this.peers.set(p.clientId, p);
        const unsent = this.pending;
        this.pending = [];
        this.opts.target.replace(fromFile(msg.doc));
        this.attach();
        // Edits made while offline are replayed and sent again.
        for (const p of unsent) {
          try {
            this.opts.target.history().apply(p.label, p.ops);
          } catch {
            this.emit('rejected', { label: p.label, reason: 'It no longer applies after reconnecting.' });
          }
        }
        this.setStatus('online');
        this.emit('welcome', { role: msg.role, project: msg.project });
        this.emit('presence', this.peers);
        if (this.lastPresence.cursor) this.sendPresence(this.lastPresence.cursor, this.lastPresence.selection);
        this.welcomed?.();
        this.welcomed = null;
        this.failed = null;
        return;
      }
      case 'tx':
        this.rebase(msg.ops, msg.label);
        this.seq = msg.seq;
        this.emit('remote', { label: msg.label, user: msg.user });
        return;
      case 'ack': {
        const i = this.pending.findIndex((p) => p.id === msg.id);
        if (i >= 0) this.pending.splice(i, 1);
        this.seq = Math.max(this.seq, msg.seq);
        this.checkFlushed();
        return;
      }
      case 'reject': {
        const i = this.pending.findIndex((p) => p.id === msg.id);
        if (i < 0) return;
        const rejected = this.pending[i]!;
        // Roll back this edit and everything after it, then replay the later ones.
        const later = this.pending.slice(i + 1);
        this.applyingRemote = true;
        try {
          const doc = this.opts.target.doc();
          for (const p of [...later].reverse()) applyOps(doc, p.inverse);
          applyOps(doc, rejected.inverse);
          this.pending = this.pending.slice(0, i);
          for (const p of later) {
            try {
              p.inverse = applyOps(doc, p.ops).inverse;
              this.pending.push(p);
            } catch {
              /* dropped; the server will reject it too */
            }
          }
        } finally {
          this.applyingRemote = false;
        }
        this.opts.target.changed({ inverse: [], touched: new Set(), global: true });
        this.emit('rejected', { label: rejected.label, reason: msg.reason });
        this.checkFlushed();
        return;
      }
      case 'reset':
        this.pending = [];
        this.seq = msg.seq;
        this.opts.target.replace(fromFile(msg.doc));
        this.attach();
        this.emit('reset', { reason: msg.reason });
        this.checkFlushed();
        return;
      case 'presence':
        if (msg.peer.clientId === this.clientId) return;
        this.peers.set(msg.peer.clientId, msg.peer);
        this.emit('presence', this.peers);
        return;
      case 'leave':
        this.peers.delete(msg.clientId);
        this.emit('presence', this.peers);
        return;
      case 'error':
        this.emit('rejected', { label: 'connection', reason: msg.message });
        if (this.failed && !this.clientId) {
          this.failed(new Error(msg.message));
          this.failed = null;
          this.closed = true;
          this.ws?.close();
        }
        return;
      default:
        return;
    }
  }

  /** Apply a remote transaction underneath our pending edits. */
  private rebase(ops: Op[], label: string): void {
    const doc = this.opts.target.doc();
    const touched = new Set<string>();
    this.applyingRemote = true;
    try {
      for (const p of [...this.pending].reverse()) for (const u of applyOps(doc, p.inverse).touched) touched.add(u);
      try {
        for (const u of applyOps(doc, ops).touched) touched.add(u);
      } catch (e) {
        // Should not happen: the server applied the same ops to the same state.
        this.emit('rejected', { label, reason: `Out of sync (${(e as Error).message}); reloading.` });
        this.ws?.close(); // reconnecting fetches a fresh copy
        return;
      }
      const kept: Pending[] = [];
      for (const p of this.pending) {
        try {
          const r = applyOps(doc, p.ops);
          p.inverse = r.inverse;
          for (const u of r.touched) touched.add(u);
          kept.push(p);
        } catch {
          this.emit('rejected', { label: p.label, reason: 'Someone else changed the same thing first.' });
        }
      }
      this.pending = kept;
    } finally {
      this.applyingRemote = false;
    }
    const rulesets = ops.some((o) => o.op === 'setRulesets');
    this.opts.target.changed({ inverse: [], touched, global: rulesets || touched.size > 2000 });
  }
}
