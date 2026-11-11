/**
 * Collaboration server: HTTP API + WebSocket sync + (optionally) the built web app.
 *
 * HTTP (JSON):
 *   POST /api/projects                     {name, doc}         → {id, tokens}
 *   GET  /api/projects/:id?token=…                             → {project, role, versions}
 *   GET  /api/projects/:id/file?token=…                        → .hpcb
 *   POST /api/projects/:id/versions?token= {name}              → version        (edit)
 *   POST /api/projects/:id/restore?token=  {versionId}         → ok             (edit)
 *   POST /api/projects/:id/fork?token=     {name, history}     → {id, tokens}   (any role)
 *   POST /api/projects/:id/public?token=   {role}              → ok             (edit)
 * WebSocket: /ws  (messages in @hassassin/sync/protocol)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fromFile, toFile, type DocFile } from '@hassassin/core';
import { opsAllowed, type ClientMsg, type Presence, type Role, type ServerMsg, type User } from '@hassassin/sync';
import { WebSocketServer, type WebSocket } from 'ws';
import { Store, type LiveProject } from './store.ts';

interface Client {
  id: string;
  ws: WebSocket;
  project: LiveProject;
  role: Role;
  user: User;
  presence: Presence;
}

export interface ServerOptions {
  port: number;
  host?: string;
  dataDir: string;
  staticDir?: string;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function startServer(opts: ServerOptions) {
  const store = new Store(opts.dataDir);
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Set<Client>>();
  let nextClient = 1;

  const body = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) throw new Error('Request too large');
      chunks.push(c as Buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  };
  const json = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const broadcast = (lp: LiveProject, msg: ServerMsg, except?: Client) => {
    const s = JSON.stringify(msg);
    for (const c of rooms.get(lp.meta.id) ?? []) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const parts = url.pathname.split('/').filter(Boolean); // api, projects, :id, action
    const tok = url.searchParams.get('token') ?? undefined;
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'projects') {
      const b = await body(req);
      const doc = fromFile(b.doc as DocFile);
      const r = await store.create(String(b.name ?? 'Untitled'), doc);
      log(`created project ${r.meta.id} "${r.meta.name}"`);
      return json(res, 201, { id: r.meta.id, name: r.meta.name, tokens: r.tokens });
    }
    const id = parts[2];
    if (parts[1] !== 'projects' || !id || !store.exists(id)) return json(res, 404, { error: 'No such project' });
    const lp = await store.get(id);
    const role = store.roleFor(lp, tok);
    if (!role) return json(res, 403, { error: 'This link does not give access to the project.' });
    const action = parts[3];
    const needEdit = () => {
      if (role !== 'edit') {
        json(res, 403, { error: 'Only editors can do that.' });
        return true;
      }
      return false;
    };
    if (req.method === 'GET' && !action) {
      const { tokens: _t, snapshotSeq: _s, ...info } = lp.meta;
      return json(res, 200, { project: info, role, seq: lp.seq, versions: lp.versions });
    }
    if (req.method === 'GET' && action === 'file') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${lp.meta.name.replace(/[^\w.-]+/g, '_')}.hpcb"` });
      return res.end(JSON.stringify(toFile(lp.doc)));
    }
    if (req.method === 'POST' && action === 'versions') {
      if (needEdit()) return;
      const b = await body(req);
      const v = await store.saveVersion(lp, String(b.name ?? 'Version'), String(b.author ?? 'someone'));
      return json(res, 201, v);
    }
    if (req.method === 'POST' && action === 'restore') {
      if (needEdit()) return;
      const b = await body(req);
      await store.restore(lp, String(b.versionId), String(b.author ?? 'someone'));
      const v = lp.versions.find((x) => x.id === b.versionId);
      broadcast(lp, { t: 'reset', seq: lp.seq, doc: toFile(lp.doc), reason: `Restored “${v?.name ?? 'a version'}” (${v ? new Date(v.at).toLocaleString() : ''})` });
      return json(res, 200, { ok: true, seq: lp.seq });
    }
    if (req.method === 'POST' && action === 'fork') {
      const b = await body(req);
      const r = await store.fork(lp, String(b.name ?? `${lp.meta.name} (copy)`), b.history !== false);
      return json(res, 201, { id: r.meta.id, name: r.meta.name, tokens: r.tokens });
    }
    if (req.method === 'POST' && action === 'public') {
      if (needEdit()) return;
      const b = await body(req);
      const r = String(b.role);
      if (!['none', 'view', 'comment'].includes(r)) return json(res, 400, { error: 'role must be none, view or comment' });
      await store.setPublic(lp, r as Role | 'none');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Unknown endpoint' });
  };

  const serveStatic = async (res: ServerResponse, path: string) => {
    if (!opts.staticDir) return json(res, 404, { error: 'Not found' });
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.(\/|\\|$))+/, '');
    let file = join(opts.staticDir, rel);
    if (!file.startsWith(opts.staticDir)) return json(res, 400, { error: 'Bad path' });
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(opts.staticDir, 'index.html');
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/health') return json(res, 200, { ok: true });
      return await serveStatic(res, url.pathname);
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      json(res, 500, { error: (e as Error).message });
    }
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    let client: Client | null = null;
    const send = (m: ServerMsg) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    // One message at a time per connection keeps transactions in order.
    let chain: Promise<unknown> = Promise.resolve();
    ws.on('message', (raw) => {
      chain = chain.then(async () => {
        let msg: ClientMsg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return send({ t: 'error', message: 'Bad message' });
        }
        if (msg.t === 'ping') return send({ t: 'pong' });
        if (msg.t === 'hello') {
          if (client) return;
          if (!store.exists(msg.project)) return send({ t: 'error', message: 'No such project' });
          const lp = await store.get(msg.project);
          const role = store.roleFor(lp, msg.token);
          if (!role) return send({ t: 'error', message: 'This link does not give access to the project.' });
          const user: User = { id: String(msg.user?.id ?? 'anon').slice(0, 64), name: String(msg.user?.name ?? 'Anonymous').slice(0, 40), color: String(msg.user?.color ?? '#999999').slice(0, 16), kind: msg.user?.kind === 'agent' ? 'agent' : 'person' };
          const id = `c${nextClient++}`;
          client = { id, ws, project: lp, role, user, presence: { clientId: id, user, cursor: null, selection: [] } };
          const room = rooms.get(lp.meta.id) ?? new Set<Client>();
          rooms.set(lp.meta.id, room);
          const { tokens: _t, snapshotSeq: _s, ...info } = lp.meta;
          send({ t: 'welcome', clientId: id, role, seq: lp.seq, doc: toFile(lp.doc), project: info, peers: [...room].map((c) => c.presence) });
          room.add(client);
          broadcast(lp, { t: 'presence', peer: client.presence }, client);
          log(`${user.name} joined ${lp.meta.id} as ${role}`);
          return;
        }
        if (!client) return send({ t: 'error', message: 'Say hello first' });
        const c = client;
        if (msg.t === 'presence') {
          c.presence = { clientId: c.id, user: c.user, cursor: msg.cursor ?? null, selection: Array.isArray(msg.selection) ? msg.selection.slice(0, 500) : [] };
          return broadcast(c.project, { t: 'presence', peer: c.presence }, c);
        }
        if (msg.t === 'tx') {
          const why = opsAllowed(c.role, c.project.doc, msg.ops);
          if (why) return send({ t: 'reject', id: msg.id, reason: why });
          try {
            const seq = await store.commit(c.project, c.user, msg.label, msg.ops);
            send({ t: 'ack', id: msg.id, seq });
            broadcast(c.project, { t: 'tx', seq, clientId: c.id, user: c.user, label: msg.label, ops: msg.ops }, c);
          } catch (e) {
            send({ t: 'reject', id: msg.id, reason: (e as Error).message });
          }
        }
      });
    });
    ws.on('close', () => {
      if (!client) return;
      rooms.get(client.project.meta.id)?.delete(client);
      broadcast(client.project, { t: 'leave', clientId: client.id });
      log(`${client.user.name} left ${client.project.meta.id}`);
    });
  });

  await new Promise<void>((r) => http.listen(opts.port, opts.host ?? '127.0.0.1', r));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    port,
    store,
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => r());
      }),
  };
}
