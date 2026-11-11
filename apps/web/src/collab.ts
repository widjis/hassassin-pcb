/**
 * Browser side of collaboration: identity, sharing, joining, presence, versions.
 * The server is reached on the same origin (/api, /ws); Vite proxies them in development.
 */
import { SyncClient, type Cursor, type Role, type User, type VersionInfo } from '@hassassin/sync';
import type { App } from './app.ts';

const COLORS = ['#f2a93b', '#4fd6a6', '#8ab4ff', '#f59fd0', '#ff8f8f', '#b48cff', '#7fd1ff', '#d6e36b'];

export function identity(ask = false): User {
  let id = '';
  let name = '';
  let color = '';
  try {
    id = localStorage.getItem('hassassin:user:id') ?? '';
    name = localStorage.getItem('hassassin:user:name') ?? '';
    color = localStorage.getItem('hassassin:user:color') ?? '';
  } catch {
    /* storage blocked */
  }
  if (!id) id = Math.random().toString(36).slice(2, 10);
  if (!color) color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
  if (!name && ask) name = (prompt('Your name (shown to collaborators):') ?? '').trim();
  if (!name) name = `Guest ${id.slice(0, 3)}`;
  try {
    localStorage.setItem('hassassin:user:id', id);
    localStorage.setItem('hassassin:user:name', name);
    localStorage.setItem('hassassin:user:color', color);
  } catch {
    /* ignore */
  }
  return { id, name, color, kind: 'person' };
}

export interface Session {
  id: string;
  token: string;
  /** All share links, known only to whoever created the project in this browser. */
  tokens?: Record<Role, string>;
}

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
export const shareLink = (id: string, token: string) => `${location.origin}${location.pathname}?p=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;

function remember(s: Session): void {
  try {
    if (s.tokens) localStorage.setItem(`hassassin:tokens:${s.id}`, JSON.stringify(s.tokens));
  } catch {
    /* ignore */
  }
}
export function knownTokens(id: string): Record<Role, string> | null {
  try {
    return JSON.parse(localStorage.getItem(`hassassin:tokens:${id}`) ?? 'null');
  } catch {
    return null;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export class Collab {
  session: Session | null = null;
  user: User;
  private app: App;
  private lastSent = 0;
  private pendingCursor: Cursor | null = null;
  private timer = 0;

  constructor(app: App) {
    this.app = app;
    this.user = identity();
  }

  get client(): SyncClient | null {
    return this.app.collab;
  }

  /** Upload the open document as a new shared project and connect as its editor. */
  async share(): Promise<Session> {
    if (!this.app.doc) throw new Error('Open or create a project first.');
    this.user = identity(true);
    const body = JSON.stringify({ name: this.app.fileName || 'Untitled', doc: JSON.parse(this.app.serialize()) });
    const r = await api<{ id: string; tokens: Record<Role, string> }>('/api/projects', { method: 'POST', body });
    const s: Session = { id: r.id, token: r.tokens.edit, tokens: r.tokens };
    remember(s);
    await this.join(s.id, s.token);
    return s;
  }

  async join(id: string, token: string): Promise<void> {
    this.leave();
    if (!this.user.name || this.user.name.startsWith('Guest ')) this.user = identity(true);
    const client = new SyncClient({ url: wsUrl(), project: id, token, user: this.user, target: this.app.syncTarget() });
    this.app.collab = client;
    this.session = { id, token, ...(knownTokens(id) ? { tokens: knownTokens(id)! } : {}) };
    client.on('status', () => this.app.emit('collab'));
    client.on('presence', () => {
      this.app.emit('presence');
      this.app.requestRender();
    });
    client.on('rejected', (r) => this.app.say(`Not saved: ${r.label} — ${r.reason}`));
    client.on('reset', (r) => this.app.say(r.reason));
    let lastToast = 0;
    client.on('remote', (r) => {
      if (Date.now() - lastToast > 2500) {
        lastToast = Date.now();
        this.app.say(`${r.user.name}: ${r.label}`);
      }
    });
    client.on('welcome', ({ role, project }) => {
      this.app.fileName = project.name;
      this.app.dirty = false;
      if (role !== 'edit') this.app.say(role === 'view' ? 'You can view this project.' : 'You can view and comment on this project.');
      this.app.emit('collab');
    });
    await client.connect();
    history.replaceState(null, '', shareLink(id, token));
    this.app.emit('collab');
  }

  leave(): void {
    this.app.collab?.close();
    this.app.collab = null;
    this.session = null;
    this.app.emit('collab');
  }

  /** Throttled cursor/selection broadcast. */
  presence(cursor: Cursor | null): void {
    const c = this.client;
    if (!c || c.status !== 'online') return;
    this.pendingCursor = cursor;
    const now = performance.now();
    const send = () => {
      this.lastSent = performance.now();
      c.sendPresence(this.pendingCursor, [...this.app.selection].slice(0, 200));
    };
    if (now - this.lastSent > 50) send();
    else if (!this.timer) this.timer = window.setTimeout(() => ((this.timer = 0), send()), 50);
  }

  private q() {
    if (!this.session) throw new Error('Not connected to a shared project.');
    return `token=${encodeURIComponent(this.session.token)}`;
  }

  info() {
    return api<{ project: { name: string; publicRole: string; forkedFrom?: string }; role: Role; versions: VersionInfo[] }>(`/api/projects/${this.session!.id}?${this.q()}`);
  }
  saveVersion(name: string) {
    return api<VersionInfo>(`/api/projects/${this.session!.id}/versions?${this.q()}`, { method: 'POST', body: JSON.stringify({ name, author: this.user.name }) });
  }
  restore(versionId: string) {
    return api<{ ok: boolean }>(`/api/projects/${this.session!.id}/restore?${this.q()}`, { method: 'POST', body: JSON.stringify({ versionId, author: this.user.name }) });
  }
  async fork(name: string, withHistory: boolean): Promise<Session> {
    const r = await api<{ id: string; tokens: Record<Role, string> }>(`/api/projects/${this.session!.id}/fork?${this.q()}`, { method: 'POST', body: JSON.stringify({ name, history: withHistory }) });
    const s: Session = { id: r.id, token: r.tokens.edit, tokens: r.tokens };
    remember(s);
    return s;
  }
  setPublic(role: 'none' | 'view' | 'comment') {
    return api<{ ok: boolean }>(`/api/projects/${this.session!.id}/public?${this.q()}`, { method: 'POST', body: JSON.stringify({ role }) });
  }
}
