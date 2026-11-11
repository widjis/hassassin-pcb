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
 *   GET  /api/library/parts?q=             search (team library + installed KiCad libraries)
 *   GET  /api/library/part?id=              → part
 *   GET  /api/library/footprints?q=         search
 *   GET  /api/library/footprint?name=       → footprint
 *   POST /api/library/parts  {part, footprint?, author, project, token}  publish (needs an edit link)
 * WebSocket: /ws  (messages in @hassassin/sync/protocol)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fromFile, toFile, type DocFile } from '@hassassin/core';
import { opsAllowed, type ClientMsg, type Presence, type Role, type ServerMsg, type User } from '@hassassin/sync';
import { WebSocketServer, type WebSocket } from 'ws';
import { Store, type LiveProject } from './store.ts';
import { Library, type LibrarySource } from '@hassassin/tools';
import { kicadSystemLibrary } from '../../../packages/tools/src/nodeLib.ts';
import { TeamLibrary } from './teamLib.ts';
import { AgentSession, runTool, TOOLS, type AgentEvent, type AgentMode, type ModelCall } from '@hassassin/tools';
import { anthropicModel, hasAnthropicCredentials } from '../../../packages/tools/src/agentModel.ts';
import { openLive, runLive, type LiveSession } from '../../cli/src/live.ts';
import { CLI_LABEL, CliAgentSession, cliStatus, LoginJob, type CliId } from './cliAgents.ts';

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
  /** Serve the KiCad libraries installed on this machine (default true). */
  kicad?: boolean;
  /** Model for the in-app agent (default: Claude through the Anthropic SDK, if credentials exist). */
  agentModel?: ModelCall | null;
}

type Backend = 'api' | CliId;

interface Chat {
  id: string;
  project: string;
  backend: Backend;
  session: AgentSession | CliAgentSession;
  live: LiveSession | null;
  abort: AbortController | null;
  lastUsed: number;
  /** Who started it, and the transcript so far (for people who open the project later). */
  by: string;
  events: Record<string, unknown>[];
}

/** Requests from this machine (the CLI backends and sign-in act on the local user's accounts). */
const isLocal = (req: IncomingMessage) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function startServer(opts: ServerOptions) {
  const store = new Store(opts.dataDir);
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Set<Client>>();
  let nextClient = 1;
  const team = new TeamLibrary(opts.dataDir);
  const kicad = opts.kicad === false ? null : kicadSystemLibrary();
  const library = new Library([team, ...(kicad ? [kicad] : [])] as LibrarySource[]);

  const agentModel: ModelCall | null = opts.agentModel !== undefined ? opts.agentModel : hasAnthropicCredentials() ? anthropicModel() : null;
  const chats = new Map<string, Chat>();
  let boundPort = opts.port;
  const sweep = setInterval(() => {
    for (const [k, c] of chats) if (!c.abort && Date.now() - c.lastUsed > 20 * 60 * 1000) (c.live?.client.close(), chats.delete(k));
  }, 60 * 1000);
  sweep.unref?.();

  /**
   * POST /api/agent/:id?token=  {prompt, chat?, mode?, user?}  → text/event-stream of AgentEvent
   * POST /api/agent/:id/stop?token= {chat}
   * GET  /api/agent/status
   * The agent joins the shared project as a collaborator, so its edits reach everyone live.
   */
  const logins = new Map<CliId, LoginJob>();
  const isCli = (v: unknown): v is CliId => v === 'claude' || v === 'codex';

  /**
   * GET  /api/agent/status                       → {available, clis:[{id,label,installed,loggedIn}]}
   * POST /api/agent/login {cli}                  start signing in a CLI (this machine only)
   * GET  /api/agent/login?cli=                   → {lines, urls, done, ok}
   * POST /api/agent/login/input {cli, line}      send a code to the sign-in
   * POST /api/agent/:id?token=  {prompt, chat?, mode?, backend?, user?}  → text/event-stream of AgentEvent
   * POST /api/agent/:id/stop?token= {chat}
   * The agent joins the shared project as a collaborator, so its edits reach everyone live.
   */
  const agentApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const parts = url.pathname.split('/').filter(Boolean); // api agent :id [stop]
    if (req.method === 'GET' && parts[2] === 'status') {
      const clis = isLocal(req) ? await Promise.all((['claude', 'codex'] as const).map(cliStatus)) : [];
      return json(res, 200, { available: !!agentModel, model: agentModel ? 'claude-opus-5-5' : null, clis });
    }
    if (parts[2] === 'login') {
      if (!isLocal(req)) return json(res, 403, { error: 'Signing in a CLI is only possible from the machine the server runs on.' });
      if (req.method === 'GET') {
        const cli = url.searchParams.get('cli');
        const job = isCli(cli) ? logins.get(cli) : undefined;
        if (!job) return json(res, 404, { error: 'No sign-in in progress' });
        return json(res, 200, { lines: job.lines.slice(-40), urls: job.urls, done: job.done, ok: job.ok });
      }
      const b = await body(req);
      if (!isCli(b.cli)) return json(res, 400, { error: 'cli must be claude or codex' });
      if (parts[3] === 'input') {
        logins.get(b.cli)?.write(String(b.line ?? ''));
        return json(res, 200, { ok: true });
      }
      logins.get(b.cli)?.cancel();
      logins.set(b.cli, new LoginJob(b.cli));
      log(`signing in ${b.cli}`);
      return json(res, 202, { started: true });
    }
    const id = parts[2];
    if (!id || !store.exists(id)) return json(res, 404, { error: 'No such project' });
    const tok = url.searchParams.get('token') ?? '';
    const lp = await store.get(id);
    const role = store.roleFor(lp, tok);
    if (!role) return json(res, 403, { error: 'This link does not give access to the project.' });
    const b = await body(req);
    if (parts[3] === 'stop') {
      chats.get(String(b.chat ?? ''))?.abort?.abort();
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'chats') {
      // Recent agent conversations on this project, newest last.
      const list = [...chats.values()].filter((c) => c.project === id).sort((x, y) => x.lastUsed - y.lastUsed).slice(-5);
      return json(res, 200, list.map((c) => ({ chat: c.id, by: c.by, backend: c.backend, running: !!c.abort, events: c.events.slice(-600) })));
    }
    const backend: Backend = isCli(b.backend) ? b.backend : 'api';
    if (backend === 'api' && !agentModel) return json(res, 503, { error: 'The API backend is not configured: put ANTHROPIC_API_KEY in .env and restart the server, or choose Claude Code / Codex (your subscription) in the Agent tab.' });
    if (backend !== 'api' && !isLocal(req)) return json(res, 403, { error: 'Subscription backends (Claude Code / Codex) are for the server on your own machine; use the API backend here.' });
    const prompt = String(b.prompt ?? '').trim();
    if (!prompt) return json(res, 400, { error: 'Empty message' });
    const mode: AgentMode = b.mode === 'ask' || role !== 'edit' ? 'ask' : 'agent';
    const reuse = typeof b.chat === 'string' ? chats.get(b.chat) : undefined;
    const chatId = reuse && reuse.project === id && reuse.backend === backend ? reuse.id : `chat-${Math.random().toString(36).slice(2, 10)}`;
    let chat = chats.get(chatId);
    const who = String((b.user as { name?: string } | undefined)?.name ?? '').slice(0, 30);
    const agentName = who ? `AI agent (for ${who})` : 'AI agent';
    if (!chat) {
      if (backend === 'api') {
        const live = await openLive({ ws: `ws://127.0.0.1:${boundPort}/ws`, id, token: tok }, { id: `agent-${chatId}`, name: agentName, color: '#b48cff' });
        const session = new AgentSession({
          model: agentModel!,
          runTool: (name, args) => runLive(live, () => runTool(live.project, name, args, { library }), TOOLS.find((t) => t.name === name)?.mutates ?? false),
        });
        chat = { id: chatId, project: id, backend, session, live, abort: null, lastUsed: Date.now(), by: who || 'Someone', events: [] };
      } else {
        const st = await cliStatus(backend);
        if (!st.installed) return json(res, 503, { error: `${CLI_LABEL[backend]} is not installed here (run pnpm install).` });
        if (!st.loggedIn) return json(res, 401, { error: `${CLI_LABEL[backend]} is not signed in yet: use Sign in in the Agent tab.` });
        const tokenFor = (r: string) => Object.entries(lp.meta.tokens).find(([, v]) => v === r)?.[0];
        const link = (t: string | undefined) => `http://127.0.0.1:${boundPort}/?p=${id}&t=${t ?? tok}`;
        const session = new CliAgentSession({ cli: backend, editLink: link(role === 'edit' ? tok : undefined), viewLink: link(tokenFor('view') ?? tok), workDir: join(opts.dataDir, 'agent-work', chatId), agentName: `${agentName} · ${backend === 'claude' ? 'Claude Code' : 'Codex'}` });
        chat = { id: chatId, project: id, backend, session, live: null, abort: null, lastUsed: Date.now(), by: who || 'Someone', events: [] };
      }
      chats.set(chatId, chat);
    }
    if (chat.session.running) return json(res, 409, { error: 'The agent is still working on the previous message.' });
    chat.session.mode = mode;
    chat.lastUsed = Date.now();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const c0 = chat;
    const mirror = (e: Record<string, unknown>) => {
      c0.events.push(e);
      if (c0.events.length > 1200) c0.events.splice(0, c0.events.length - 1200);
      broadcast(lp, { t: 'agent', chat: chatId, by: c0.by, backend, event: e });
    };
    const send = (e: AgentEvent | { type: 'chat'; chat: string; mode: AgentMode; backend: Backend }) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type !== 'chat') mirror(e as Record<string, unknown>);
    };
    send({ type: 'chat', chat: chatId, mode, backend });
    mirror({ type: 'user', text: prompt, by: c0.by });
    mirror({ type: 'start' });
    const abort = new AbortController();
    chat.abort = abort;
    req.on('close', () => !res.writableEnded && abort.abort());
    log(`agent (${backend}, ${mode}) on ${id}: ${prompt.slice(0, 80)}`);
    try {
      await chat.session.send(prompt, send, abort.signal);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    } finally {
      chat.abort = null;
      chat.lastUsed = Date.now();
      mirror({ type: 'end' });
      res.end();
    }
  };

  const libraryApi = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const what = url.pathname.split('/')[3];
    const q = url.searchParams.get('q') ?? '';
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 40) || 40);
    if (req.method === 'GET' && what === 'info') return json(res, 200, { sources: library.sources.map((s) => s.name) });
    if (req.method === 'GET' && what === 'parts') {
      const out = [];
      for (const s of library.sources) if (out.length < limit) out.push(...(await s.searchParts(q, limit - out.length)));
      return json(res, 200, out);
    }
    if (req.method === 'GET' && what === 'footprints') {
      const out = [];
      for (const s of library.sources) if (out.length < limit) out.push(...(await s.searchFootprints(q, limit - out.length)));
      return json(res, 200, out);
    }
    if (req.method === 'GET' && what === 'part') {
      const p = await library.getPart(null, url.searchParams.get('id') ?? '');
      return p ? json(res, 200, p) : json(res, 404, { error: 'No such part' });
    }
    if (req.method === 'GET' && what === 'footprint') {
      const f = await library.getFootprint(null, url.searchParams.get('name') ?? '');
      return f ? json(res, 200, f) : json(res, 404, { error: 'No such footprint' });
    }
    if (req.method === 'POST' && what === 'parts') {
      const b = await body(req);
      // Publishing needs an edit link of some project on this server (there are no accounts yet).
      const pid = String(b.project ?? '');
      if (!pid || !store.exists(pid) || store.roleFor(await store.get(pid), String(b.token ?? '')) !== 'edit') return json(res, 403, { error: 'Publishing to the team library needs an edit link of a shared project.' });
      const author = String(b.author ?? 'someone').slice(0, 40);
      const fp = b.footprint ? await team.publishFootprint(b.footprint as never) : null;
      const part = await team.publishPart(b.part as never, author);
      log(`${author} published part ${part.id} v${part.version}`);
      return json(res, 201, { part, ...(fp ? { footprint: fp.name } : {}) });
    }
    return json(res, 404, { error: 'Unknown endpoint' });
  };

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
      if (url.pathname.startsWith('/api/library/')) return await libraryApi(req, res, url);
      if (url.pathname.startsWith('/api/agent/')) return await agentApi(req, res, url);
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
  boundPort = port;
  return {
    port,
    store,
    close: () =>
      new Promise<void>((r) => {
        clearInterval(sweep);
        for (const c of chats.values()) c.live?.client.close();
        for (const l of logins.values()) l.cancel();
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => r());
      }),
  };
}
