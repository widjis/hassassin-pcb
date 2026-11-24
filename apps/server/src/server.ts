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
 *   GET  /api/library/kicad                 KiCad libraries: installed / downloaded / none, download progress
 *   POST /api/library/kicad/download {version?}  download the official libraries (this machine only, after
 *                                           the user agreed in the app)
 * WebSocket: /ws  (messages in @hassassin/sync/protocol)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fromFile, toFile, type DocFile } from '@hassassin/core';
import { opsAllowed, type ClientMsg, type Presence, type Role, type ServerMsg, type User } from '@hassassin/sync';
import { WebSocketServer, type WebSocket } from 'ws';
import { Store, agentEdits, planUndo, type LiveProject } from './store.ts';
import { KicadSystemLibrary, Library, type LibrarySource } from '@hassassin/tools';
import { kicadSystemLibrary, nodeLibFs, resetKicadSystemLibrary } from '../../../packages/tools/src/nodeLib.ts';
import { downloadKicadLibraries, downloadedKicadLibraries, KICAD_LIBRARY_LICENSE, KICAD_REPOS, type DownloadProgress } from '../../../packages/tools/src/kicadDownload.ts';
import { TeamLibrary } from './teamLib.ts';
import { AgentSession, runTool, TOOLS, type AgentEvent, type AgentMode, type ModelCall } from '@hassassin/tools';
import { anthropicModel, hasAnthropicCredentials } from '../../../packages/tools/src/agentModel.ts';
import { openLive, runLive, type LiveSession } from '../../cli/src/live.ts';
import { CLI_LABEL, CliAgentSession, cliStatus, LoginJob, type CliId } from './cliAgents.ts';
import { fileURLToPath } from 'node:url';
import { McpClient, PluginHost, pluginNote, pluginToolName, type ActivePlugin } from './plugins.ts';
import { Catalog } from './catalog.ts';
import { autonomyNote, GateError, limitsOf, type GateInfo } from '@hassassin/tools';
import type { Op } from '@hassassin/core';
import { aiFlowNote, type ExternalTool } from '@hassassin/tools';

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
  /** Where downloaded KiCad libraries go, and the fetch used (tests). */
  kicadDownload?: { root?: string; fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response> };
  /** Model for the in-app agent (default: Claude through the Anthropic SDK, if credentials exist). */
  agentModel?: ModelCall | null;
  /** Folder of the plugins bundled with Hassassin (default `plugins/` of the repository; null for none). */
  builtinPlugins?: string | null;
  /** Tests: catalog downloads may come over http from this machine. */
  allowLocalPluginDownloads?: boolean;
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
  /** Name the agent's edits carry in the log (as the collaboration server stores it). */
  agentUser: string;
  /** Each reply's range of transactions, so its edits can be undone together. */
  turns: Map<string, { from: number; to: number; undone: boolean }>;
  /** When the reply now running started (for the Agent tab's status line), and what it was asked. */
  startedAt?: number;
  lastPrompt?: string;
  /** Running plugin processes of this chat (API backend), started on first use. */
  pluginClients: Map<string, McpClient>;
  /** While a reply runs: send an event to its stream (and the mirror). */
  emit?: (e: Record<string, unknown>) => void;
  /** Plugins switched on during this reply at the agent's request: the reply goes on with them. */
  pluginsChanged?: string[];
  /** Gates (A13): cards waiting for the user, and OKs given (each for one change, for a while). */
  pendingGates?: Map<string, GateInfo>;
  gateOks?: { kind: GateInfo['kind']; max: number; until: number }[];
  /** What the agent decided on its own in the reply now running (A13). */
  decisions?: { kind: 'plugin' | 'part' | 'source'; what: string; reason?: string }[];
}

/** Stop a chat's connections: the live project link and its plugin processes. */
const closeChat = (c: Chat) => {
  c.live?.client.close();
  for (const p of c.pluginClients.values()) p.close();
  c.pluginClients.clear();
};

/** The model's name for a plugin tool: letters, digits, "_" and "-", at most 64 characters. */
const modelToolName = (plugin: string, tool: string) => `${plugin}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

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
  // KiCad libraries on demand (S21): one download at a time, progress kept for the status call.
  let kicadJob: (DownloadProgress & { started: string }) | null = null;

  const agentModel: ModelCall | null = opts.agentModel !== undefined ? opts.agentModel : hasAnthropicCredentials() ? anthropicModel() : null;
  const chats = new Map<string, Chat>();
  const builtinDir = opts.builtinPlugins !== undefined ? opts.builtinPlugins : fileURLToPath(new URL('../../../plugins', import.meta.url));
  const pluginHost = new PluginHost(opts.dataDir, builtinDir);
  const catalog = new Catalog({ dataDir: opts.dataDir, builtinDir, ...(opts.allowLocalPluginDownloads ? { allowLocal: true } : {}) });

  /** A change of a project's document made by the server for an agent (switching a plugin on). */
  const commitFor = async (lp: LiveProject, who: string, label: string, ops: Op[]) => {
    const user: User = { id: 'agent-plugins', name: who.slice(0, 40), color: '#b48cff', kind: 'person' };
    const seq = await store.commit(lp, user, label, ops);
    broadcast(lp, { t: 'tx', seq, clientId: 'server', user, label, ops });
  };
  /** The decisions agents made on their own per project (A13): `<data>/agent-log/<project>.jsonl`. */
  const decisionFile = (project: string) => join(opts.dataDir, 'agent-log', `${project.replace(/[^\w-]/g, '_')}.jsonl`);
  const logDecisions = async (project: string, entry: Record<string, unknown>) => {
    await mkdir(join(opts.dataDir, 'agent-log'), { recursive: true });
    await appendFile(decisionFile(project), `${JSON.stringify(entry)}\n`);
  };
  const readDecisions = async (project: string, last: number) => {
    try {
      return (await readFile(decisionFile(project), 'utf8')).split('\n').filter(Boolean).slice(-Math.max(1, Math.min(500, last || 50))).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  const enabledOf = (lp: LiveProject) => (Array.isArray(lp.doc.meta.agentPlugins) ? (lp.doc.meta.agentPlugins as unknown[]).filter((x): x is string => typeof x === 'string') : []);

  /** Plugins the agent may ask for: catalog plugins not installed, and installed ones this project has off. */
  const pluginOffers = async (lp: LiveProject) => {
    const on = new Set(enabledOf(lp));
    const installed = pluginHost.manifests().manifests;
    const offers: { id: string; name: string; description: string; permission: string; hosts: string[]; installed: boolean }[] = [];
    for (const m of installed) if (!on.has(m.id)) offers.push({ id: m.id, name: m.name, description: m.description ?? '', permission: m.permission, hosts: m.hosts, installed: true });
    for (const e of (await catalog.entries()).entries)
      if (!e.bundled && e.manifest && !installed.some((m) => m.id === e.id)) offers.push({ id: e.id, name: e.manifest.name, description: e.manifest.description ?? '', permission: e.manifest.permission, hosts: e.manifest.hosts, installed: false });
    return offers;
  };

  /** A plugin card in a conversation (A12): sent to the reply's stream while it runs, kept in its transcript. */
  const pluginCard = (c: Chat | undefined, lp: LiveProject, card: Record<string, unknown>) => {
    const e = { type: 'plugin_request', ...card };
    if (c?.emit) return c.emit(e);
    if (c) {
      c.events.push(e);
      broadcast(lp, { t: 'agent', chat: c.id, by: c.by, backend: c.backend, event: e });
    }
  };

  /**
   * The agent asks for a plugin (A12). Only catalog plugins (or installed ones); what happens follows the
   * project's level (A13 seed: the "choosing parts" setting): Full, or Automatic for read-only plugins,
   * installs and switches it on at once; otherwise a card asks the user. A plugin that needs settings
   * always waits for the user to fill them in on the server.
   */
  const requestPlugin = async (lp: LiveProject, projectId: string, role: Role, plugin: string, reason: string, c: Chat | undefined) => {
    const installed = pluginHost.manifests().manifests.find((m) => m.id === plugin);
    const entry = await catalog.entry(plugin);
    if (!installed && !entry) throw new Error(`${plugin} is not in the plugin catalog. Only catalog plugins can be added; tell the user what you would need instead.`);
    if (installed && enabledOf(lp).includes(plugin)) return { plugin, state: 'on', note: 'It is already switched on for this project.' };
    const m = installed ?? ({ ...entry!.manifest, id: plugin } as NonNullable<typeof installed>);
    const autonomy = limitsOf(lp.doc).autonomy;
    const auto = role === 'edit' && (autonomy === 'full' || (autonomy === 'auto' && m.permission === 'read'));
    const card = { id: `pr-${Math.random().toString(36).slice(2, 10)}`, plugin, name: m.name, description: m.description ?? '', permission: m.permission, hosts: m.hosts, reason, installed: !!installed, by: c?.agentUser ?? 'agent' };
    if (!auto) {
      pluginCard(c, lp, { ...card, state: 'approve' });
      return { plugin, state: 'asked', note: 'The user decides on a card in the Agent tab. Go on without it for now, and tell the user why you asked.' };
    }
    if (!installed) await catalog.install(plugin, `${c?.agentUser ?? 'agent'} (${c?.by ?? 'someone'})`, reason);
    await commitFor(lp, c?.agentUser ?? 'AI agent', `Agent plugin ${plugin} on`, [{ op: 'setMeta', key: 'agentPlugins', value: [...new Set([...enabledOf(lp), plugin])] }]);
    const missing = (pluginHost.manifests().manifests.find((x) => x.id === plugin)?.settings ?? []).filter((s) => s.required);
    const probe = await pluginHost.probe(pluginHost.manifests().manifests.find((x) => x.id === plugin)!, true);
    if (!probe.status.ok && missing.length) {
      pluginCard(c, lp, { ...card, state: 'settings', settings: missing.map((s) => s.label || s.key) });
      return { plugin, state: 'needs-settings', note: `Installed and switched on, but it needs ${missing.map((s) => s.label || s.key).join(', ')}, which only the user can fill in on the server. Go on without it.` };
    }
    pluginCard(c, lp, { ...card, state: 'done', installedNow: !installed });
    c?.decisions?.push({ kind: 'plugin', what: `switched on ${m.name || plugin}${installed ? '' : ' (installed from the catalog)'}`, ...(reason ? { reason } : {}) });
    if (c) c.pluginsChanged = [...(c.pluginsChanged ?? []), plugin];
    return { plugin, state: 'on', note: 'Switched on for this project. Finish this step; the reply continues with its tools right after.' };
  };
  let boundPort = opts.port;
  const sweep = setInterval(() => {
    for (const [k, c] of chats) if (!c.abort && Date.now() - c.lastUsed > 20 * 60 * 1000) (closeChat(c), chats.delete(k));
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
  /**
   * An agent's change held by a gate (A13): an OK the user gave for this conversation lets it through (once);
   * otherwise a card asks the user.
   */
  const resolveGate = (c: Chat | undefined, lp: LiveProject, gate: GateInfo): { allowed: boolean } => {
    const now = Date.now();
    if (c) {
      c.gateOks = (c.gateOks ?? []).filter((o) => o.until > now);
      const ok = c.gateOks.find((o) => o.kind === gate.kind && gate.count <= o.max);
      if (ok) {
        c.gateOks.splice(c.gateOks.indexOf(ok), 1);
        return { allowed: true };
      }
    }
    const id = `gate-${Math.random().toString(36).slice(2, 10)}`;
    if (c) (c.pendingGates ??= new Map()).set(id, gate);
    const e = { type: 'gate', id, ...gate, state: 'ask' };
    if (c?.emit) c.emit(e);
    else if (c) (c.events.push(e), broadcast(lp, { t: 'agent', chat: c.id, by: c.by, backend: c.backend, event: e }));
    return { allowed: false };
  };
  /** A project an agent works on carries the gates of its project's limits. */
  const guardOf = (lp: LiveProject) => ({ bulkLimit: limitsOf(lp.doc).bulkLimit ?? 5 });

  /** Plugin tools for the API backend: each call goes to the chat's plugin process, started (again) when needed. */
  const externalTools = (chat: Chat, active: ActivePlugin[]): ExternalTool[] =>
    active.flatMap((p) =>
      p.tools.map((t) => ({
        name: modelToolName(p.manifest.id, t.name),
        display: pluginToolName(p.manifest.id, t.name),
        description: t.description,
        input_schema: t.inputSchema,
        call: async (args: Record<string, unknown>) => {
          let c = chat.pluginClients.get(p.manifest.id);
          if (!c?.alive) {
            c?.close();
            c = new McpClient(p.command, p.args, p.env);
            chat.pluginClients.set(p.manifest.id, c);
            await c.start();
          }
          return c.callTool(t.name, args);
        },
      })),
    );

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
    if (parts[3] === 'undo') {
      // Undo every edit one agent reply made, as one change (POST {chat, turn}).
      if (role !== 'edit') return json(res, 403, { error: 'Only editors can undo changes.' });
      const ch = chats.get(String(b.chat ?? ''));
      const turn = ch?.project === id ? ch.turns.get(String(b.turn ?? '')) : undefined;
      if (!ch || !turn) return json(res, 410, { error: 'This reply is no longer known to the server (it restarted). Restore a version from History instead.' });
      if (turn.undone) return json(res, 409, { error: 'Already undone.' });
      if (ch.session.running) return json(res, 409, { error: 'Wait until the agent has finished.' });
      const plan = planUndo(lp, turn.from, turn.to, ch.agentUser);
      if ('error' in plan) return json(res, 409, plan);
      const who = String((b.user as { name?: string } | undefined)?.name ?? 'Someone').slice(0, 40);
      const user: User = { id: 'agent-undo', name: who, color: '#999999', kind: 'person' };
      const label = 'Undo agent changes';
      try {
        const seq = await store.commit(lp, user, label, plan.ops);
        broadcast(lp, { t: 'tx', seq, clientId: 'server', user, label, ops: plan.ops });
      } catch (e) {
        return json(res, 409, { error: `Could not undo: ${(e as Error).message}` });
      }
      turn.undone = true;
      log(`${who} undid ${plan.count} agent change(s) on ${id}`);
      return json(res, 200, { ok: true, undone: plan.count });
    }
    if (parts[3] === 'datasheets' && parts[4]) {
      // A datasheet the datasheets plugin keeps for this project (A3): the stored copy, by its SHA-256.
      const sha = parts[4].toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) return json(res, 400, { error: 'Not a SHA-256' });
      const file = join(pluginHost.pluginData('datasheets', id), `${sha}.pdf`);
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': data.length, 'content-disposition': `inline; filename="datasheet-${sha.slice(0, 12)}.pdf"`, 'cache-control': 'private, max-age=86400' });
        return res.end(data);
      } catch {
        return json(res, 404, { error: 'This project keeps no datasheet with that SHA-256.' });
      }
    }
    if (parts[3] === 'gates' && !parts[4]) {
      // The MCP server (Claude Code, Codex) reports a change held by a gate.
      const agent = String(b.agent ?? '').slice(0, 40);
      const c = [...chats.values()].find((x) => x.project === id && x.abort && x.agentUser === agent);
      const g = b.gate as GateInfo | undefined;
      if (!g || g.kind !== 'bulk-remove' || typeof g.count !== 'number') return json(res, 400, { error: 'gate missing' });
      return json(res, 200, resolveGate(c, lp, { kind: g.kind, count: g.count, parts: (g.parts ?? []).map(String), nets: (g.nets ?? []).map(String), label: String(g.label ?? ''), summary: String(g.summary ?? '') }));
    }
    if (parts[3] === 'gates' && parts[4] === 'decide') {
      // The user answers a gate card: allow that change once (for the next quarter of an hour), or not.
      if (role !== 'edit') return json(res, 403, { error: 'Only editors can allow it.' });
      const c = chats.get(String(b.chat ?? ''));
      const gid = String(b.id ?? '');
      const g = c?.pendingGates?.get(gid);
      if (!c || !g) return json(res, 410, { error: 'This request is no longer known (the server restarted or it was answered). Ask the agent again.' });
      c.pendingGates!.delete(gid);
      const allow = b.decision === 'allow';
      if (allow) (c.gateOks ??= []).push({ kind: g.kind, max: g.count, until: Date.now() + 15 * 60 * 1000 });
      const e = { type: 'gate', id: gid, state: allow ? 'allowed' : 'declined', by: String((b.user as { name?: string } | undefined)?.name ?? '').slice(0, 40) };
      c.events.push(e);
      broadcast(lp, { t: 'agent', chat: c.id, by: c.by, backend: c.backend, event: e });
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'decisions') {
      // What agents decided on their own on this project (A13), newest last.
      return json(res, 200, await readDecisions(id, Number(url.searchParams.get('last') ?? 50)));
    }
    if (parts[3] === 'plugins' && parts[4] === 'request') {
      // The agent (through the MCP server) asks for a plugin (A12).
      const agent = String(b.agent ?? '').slice(0, 40);
      const c = [...chats.values()].find((x) => x.project === id && x.abort && x.agentUser === agent);
      try {
        return json(res, 200, await requestPlugin(lp, id, role, String(b.plugin ?? ''), String(b.reason ?? '').slice(0, 300), c));
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (parts[3] === 'plugins' && parts[4] === 'decide') {
      // The user answers a plugin card: install (if needed) and switch on, or not now.
      if (role !== 'edit') return json(res, 403, { error: 'Only editors can switch plugins on.' });
      const plugin = String(b.plugin ?? '');
      const c = chats.get(String(b.chat ?? ''));
      const who = String((b.user as { name?: string } | undefined)?.name ?? 'Someone').slice(0, 40);
      const done = (state: string, extra: Record<string, unknown> = {}) => {
        if (c) {
          const e = { type: 'plugin_request', id: String(b.request ?? ''), plugin, state, ...extra };
          c.events.push(e);
          broadcast(lp, { t: 'agent', chat: c.id, by: c.by, backend: c.backend, event: e });
        }
      };
      if (b.decision !== 'install') return (done('declined'), json(res, 200, { ok: true }));
      try {
        if (!pluginHost.manifests().manifests.some((m) => m.id === plugin)) await catalog.install(plugin, who, 'approved on a card');
        await commitFor(lp, who, `Agent plugin ${plugin} on`, [{ op: 'setMeta', key: 'agentPlugins', value: [...new Set([...enabledOf(lp), plugin])] }]);
        done('done');
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (parts[3] === 'plugins' && parts[4] === 'settings') {
      // Filling in a plugin's settings (an API key): the server's owner, on this machine. Secrets are kept in
      // plugin-settings.json on the server and never sent back.
      if (!isLocal(req)) return json(res, 403, { error: 'Plugin settings are filled in on the machine the server runs on.' });
      try {
        await pluginHost.setValues(String(b.plugin ?? ''), (b.values ?? {}) as Record<string, unknown>);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (parts[3] === 'live-offers') {
      // Live prices and stock for the BOM from the distributor plugins (A4), for this view only: fetched now,
      // returned, never stored (Mouser's terms forbid caching its data).
      const mpns = [...new Set((Array.isArray(b.mpns) ? b.mpns : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 50);
      const m = pluginHost.manifests().manifests.find((x) => x.id === 'mouser');
      if (!m) return json(res, 404, { error: 'The Mouser plugin is not installed on this server.' });
      const pr = await pluginHost.probe(m);
      if (!pr.status.ok) return json(res, 400, { error: `Mouser: ${pr.status.error}` });
      if (!mpns.length) return json(res, 200, { source: 'Mouser Electronics', offers: {}, notFound: [] });
      const l = pluginHost.launch(m, id);
      const c = new McpClient(l.command, l.args, { ...l.env, MOUSER_MAX_CALLS: '5' });
      const offers: Record<string, unknown[]> = {};
      const notFound: string[] = [];
      let retrievedAt = '';
      const who = String((b.user as { name?: string } | undefined)?.name ?? 'Someone').slice(0, 40);
      try {
        await c.start();
        for (let i = 0; i < mpns.length; i += 10) {
          const chunk = mpns.slice(i, i + 10);
          const r = await c.callTool('get_offers', { part_numbers: chunk });
          await pluginHost.log(id, { chat: '', by: `${who} (BOM)`, plugin: 'mouser', tool: 'get_offers', args: { part_numbers: chunk }, ok: !r.isError, bytes: r.text.length });
          if (r.isError) return json(res, 502, { error: r.text });
          const j = JSON.parse(r.text) as { retrievedAt: string; results: { partNumber: string; parts: { mpn: string; distributorPartNumber: string | null; stock: number | null; moq: number | null; priceBreaks: { qty: number; price: number; currency: string }[]; productUrl: string | null; retrievedAt: string }[] }[] };
          retrievedAt = j.retrievedAt;
          for (const x of j.results) {
            const list = x.parts
              .filter((p) => p.priceBreaks.length)
              .map((p) => ({ supplier: 'Mouser', ...(p.distributorPartNumber ? { sku: p.distributorPartNumber } : {}), ...(p.stock !== null ? { stock: p.stock } : {}), ...(p.moq !== null ? { moq: p.moq } : {}), currency: p.priceBreaks[0]!.currency, breaks: p.priceBreaks.map((q) => ({ qty: q.qty, price: q.price })), ...(p.productUrl ? { url: p.productUrl } : {}), updatedAt: p.retrievedAt, live: true }));
            if (list.length) offers[x.partNumber.toLowerCase()] = list;
            else notFound.push(x.partNumber);
          }
        }
      } catch (e) {
        return json(res, 502, { error: `Mouser: ${(e as Error).message}` });
      } finally {
        c.close();
      }
      return json(res, 200, { source: 'Mouser Electronics', retrievedAt, offers, notFound });
    }
    if (parts[3] === 'plugins' && (parts[4] === 'install' || parts[4] === 'remove')) {
      // Installing or removing a catalog plugin by hand: the server's owner, on this machine.
      if (!isLocal(req)) return json(res, 403, { error: 'Plugins are installed on the machine the server runs on.' });
      const who = String((b.user as { name?: string } | undefined)?.name ?? 'Someone').slice(0, 40);
      try {
        if (parts[4] === 'install') return json(res, 200, await catalog.install(String(b.plugin ?? ''), who, 'from the Plugins section'));
        await catalog.remove(String(b.plugin ?? ''), who);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (parts[3] === 'plugins') {
      // Plugins installed on this server, which this project switched on, its recent plugin calls, and what
      // the catalog offers that is not installed (A12).
      const { plugins, problems } = await pluginHost.list(url.searchParams.get('refresh') === '1');
      const enabled = Array.isArray(lp.doc.meta.agentPlugins) ? lp.doc.meta.agentPlugins : [];
      const cat = await catalog.entries();
      const offered = cat.entries.filter((e) => !e.bundled && e.manifest && !plugins.some((p) => p.id === e.id)).map((e) => ({ id: e.id, version: e.version, license: e.license, ...e.manifest }));
      return json(res, 200, { plugins, problems: [...problems, ...cat.problems.map((p) => ({ id: 'catalog', problems: [p] }))], enabled, offered, installs: catalog.readInstalls(20), canInstall: isLocal(req), log: await pluginHost.readLog(id, 30) });
    }
    if (parts[3] === 'chats') {
      // Recent agent conversations on this project, newest last.
      const list = [...chats.values()].filter((c) => c.project === id).sort((x, y) => x.lastUsed - y.lastUsed).slice(-5);
      return json(res, 200, list.map((c) => ({ chat: c.id, by: c.by, backend: c.backend, running: !!c.abort, ...(c.abort && c.startedAt ? { since: c.startedAt } : {}), events: c.events.slice(-600) })));
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
          runTool: async (name, args) => {
            const run = () => runLive(live, () => runTool(live.project, name, args, { library }), TOOLS.find((t) => t.name === name)?.mutates ?? false);
            // The project's gates (A13) hold changes that need the user's OK.
            live.project.guard = guardOf(lp);
            try {
              return await run();
            } catch (e) {
              if (!(e instanceof GateError) || !resolveGate(chats.get(chatId), lp, e.gate).allowed) throw e;
              live.project.guard.allow = { kind: e.gate.kind, max: e.gate.count };
              return await run();
            } finally {
              live.project.guard = undefined;
            }
          },
        });
        chat = { id: chatId, project: id, backend, session, live, abort: null, lastUsed: Date.now(), by: who || 'Someone', events: [], agentUser: agentName.slice(0, 40), turns: new Map(), pluginClients: new Map() };
      } else {
        const st = await cliStatus(backend);
        if (!st.installed) return json(res, 503, { error: `${CLI_LABEL[backend]} is not installed here (run pnpm install).` });
        if (!st.loggedIn) return json(res, 401, { error: `${CLI_LABEL[backend]} is not signed in yet: use Sign in in the Agent tab.` });
        const tokenFor = (r: string) => Object.entries(lp.meta.tokens).find(([, v]) => v === r)?.[0];
        const link = (t: string | undefined) => `http://127.0.0.1:${boundPort}/?p=${id}&t=${t ?? tok}`;
        const cliName = `${agentName} · ${backend === 'claude' ? 'Claude Code' : 'Codex'}`;
        const session = new CliAgentSession({ cli: backend, editLink: link(role === 'edit' ? tok : undefined), viewLink: link(tokenFor('view') ?? tok), workDir: join(opts.dataDir, 'agent-work', chatId), agentName: cliName });
        chat = { id: chatId, project: id, backend, session, live: null, abort: null, lastUsed: Date.now(), by: who || 'Someone', events: [], agentUser: cliName.slice(0, 40), turns: new Map(), pluginClients: new Map() };
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
    // Plugin calls are logged per project (tool, arguments with secrets removed, result size).
    const pluginCalls = new Map<string, { plugin: string; tool: string; input: unknown }>();
    const pluginLogs: Promise<unknown>[] = [];
    const send = (e: AgentEvent | { type: 'chat'; chat: string; mode: AgentMode; backend: Backend } | { type: 'edits'; turn: string; count: number; labels: string[] }) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type !== 'chat') mirror(e as Record<string, unknown>);
      // What the agent decides on its own (A13): parts it sets, sources it uses.
      if (e.type === 'tool' && (e.name === 'set_part_info' || e.name === 'place_part')) {
        const i = (e.input ?? {}) as Record<string, unknown>;
        if (e.name === 'set_part_info' && typeof i.mpn === 'string' && i.mpn) c0.decisions?.push({ kind: 'part', what: `${String(i.ref ?? '')}: ${i.mpn}${typeof i.manufacturer === 'string' && i.manufacturer ? ` (${i.manufacturer})` : ''}` });
        if (e.name === 'place_part' && typeof i.id === 'string') c0.decisions?.push({ kind: 'part', what: `placed ${i.id}${typeof i.ref === 'string' ? ` as ${i.ref}` : ''}` });
      }
      if (e.type === 'tool_result' && e.ok && (e.name === 'web.fetch_document' || e.name === 'datasheets.get_datasheet')) {
        const d = e.detail ?? '';
        const src = /"finalUrl":\s*"([^"]+)"/.exec(d)?.[1] ?? /"url":\s*"([^"]+)"/.exec(d)?.[1];
        const trust = /"trust":\s*"(\w+)"/.exec(d)?.[1];
        if (src && !c0.decisions?.some((x) => x.kind === 'source' && x.what.startsWith(src))) c0.decisions?.push({ kind: 'source', what: `${src}${trust ? ` (${trust})` : ''}` });
      }
      if (e.type === 'tool' && e.name.includes('.')) {
        const [plugin, ...rest] = e.name.split('.');
        pluginCalls.set(e.id, { plugin: plugin!, tool: rest.join('.'), input: e.input });
      } else if (e.type === 'tool_result' && pluginCalls.has(e.id)) {
        const c = pluginCalls.get(e.id)!;
        pluginCalls.delete(e.id);
        pluginLogs.push(pluginHost
          .log(id, { chat: chatId, by: c0.by, plugin: c.plugin, tool: c.tool, args: c.input, ok: e.ok, bytes: (e.detail ?? e.summary ?? '').length })
          .catch((err) => log(`plugin log: ${(err as Error).message}`)));
      }
    };
    send({ type: 'chat', chat: chatId, mode, backend });
    mirror({ type: 'user', text: prompt, by: c0.by });
    mirror({ type: 'start', at: Date.now() });
    chat.startedAt = Date.now();
    chat.lastPrompt = prompt;
    chat.emit = (e) => send(e as unknown as AgentEvent);
    chat.pluginsChanged = [];
    chat.decisions = [];
    const abort = new AbortController();
    chat.abort = abort;
    // Closing or reloading the page does not stop the agent: it works on (every open tab follows it through
    // the project's mirror, and a reopened tab picks it up); only Stop ends it.
    log(`agent (${backend}, ${mode}) on ${id}: ${prompt.slice(0, 80)}`);
    const turnId = `t${Date.now().toString(36)}`;
    const from = lp.seq;
    try {
     let turnPrompt = prompt;
     // A plugin the agent asked for and got (A12) joins the same reply: it goes on with the new tools.
     for (let round = 0; round < 3; round++) {
      // This project's plugins for this message; those that cannot run are left out with a note.
      const { plugins: active, skipped } = await pluginHost.active(lp.doc.meta.agentPlugins, mode, id);
      for (const s of skipped) send({ type: 'note', text: `Plugin ${s.id} ${s.reason}.` });
      // The plugins, and for an AI Full project its stage and limits (A14).
      // Other agents working on this project at the same time (several may run at once).
      const others = [...chats.values()].filter((c) => c.project === id && c.id !== chatId && c.abort);
      const together = others.length
        ? [
            `Other agents are working on this project at the same time; their edits appear live:`,
            ...others.map((c) => `- ${c.agentUser}, asked by ${c.by}: "${(c.lastPrompt ?? '').slice(0, 200)}"`),
            'Stay within your own task, do not undo or redo their changes, and avoid editing the same parts or nets they are working on; say so if your task needs them.',
          ].join('\n')
        : '';
      const offers = await pluginOffers(lp);
      const offerNote = offers.length
        ? ['Plugins you can ask for with request_plugin (id and why): the project\'s settings decide whether it is switched on at once or the user is asked.', ...offers.map((o) => `- ${o.id}: ${o.name}${o.description ? ` — ${o.description}` : ''} (${o.permission}${o.hosts.length ? `; contacts ${o.hosts.join(', ')}` : ''}${o.installed ? '' : '; installed from the catalog'})`)].join('\n')
        : '';
      const note = [autonomyNote(lp.doc), pluginNote(active, skipped), offerNote, aiFlowNote(lp.doc), together].filter(Boolean).join('\n\n');
      if (chat.session instanceof CliAgentSession) {
        chat.session.plugins = active;
        chat.session.pluginNote = note;
        await chat.session.send(turnPrompt, send, abort.signal);
      } else {
        // Fresh plugin processes for each message, so their limits count per message.
        for (const c of chat.pluginClients.values()) c.close();
        chat.pluginClients.clear();
        const web = active.find((p) => p.manifest.backendWebSearch);
        const maxUses = web ? Number(web.env.WEB_MAX_SEARCHES) || 10 : 0;
        const req0 = { name: 'request_plugin', display: 'request_plugin', description: 'Ask for a plugin you need (see the plugins you can ask for): id and the reason. Follow its answer.', input_schema: { type: 'object', properties: { plugin: { type: 'string' }, reason: { type: 'string' } }, required: ['plugin', 'reason'] }, call: async (a: Record<string, unknown>) => {
          try {
            return { text: JSON.stringify(await requestPlugin(lp, id, role, String(a.plugin ?? ''), String(a.reason ?? '').slice(0, 300), chat)), isError: false };
          } catch (e) {
            return { text: (e as Error).message, isError: true };
          }
        } };
        await chat.session.send(turnPrompt, send, abort.signal, { tools: [...externalTools(chat, active), ...(offers.length && mode === 'agent' ? [req0] : [])], note, ...(web ? { webSearch: { maxUses } } : {}) });
      }
      const got = chat.pluginsChanged ?? [];
      if (!got.length || abort.signal.aborted) break;
      chat.pluginsChanged = [];
      turnPrompt = `(The plugin${got.length === 1 ? '' : 's'} ${got.join(', ')} ${got.length === 1 ? 'is' : 'are'} now switched on. Continue the task with ${got.length === 1 ? 'it' : 'them'}.)`;
      send({ type: 'note', text: `Plugin ${got.join(', ')} switched on; the agent goes on with it.` });
     }
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    } finally {
      // What the agent decided on its own in this reply (A13): listed in the conversation and logged.
      const decided = chat.decisions ?? [];
      if (decided.length) {
        send({ type: 'decisions', items: decided } as unknown as AgentEvent);
        await logDecisions(id, { at: new Date().toISOString(), chat: chatId, by: chat.by, agent: chat.agentUser, items: decided }).catch((e) => log(`decision log: ${(e as Error).message}`));
      }
      chat.decisions = [];
      // The edits of this reply, so the person can undo them together.
      const made = agentEdits(lp, from, lp.seq, chat.agentUser);
      if (made.length) {
        chat.turns.set(turnId, { from, to: lp.seq, undone: false });
        send({ type: 'edits', turn: turnId, count: made.length, labels: [...new Set(made.map((e) => e.label))].slice(0, 6) });
      }
      // Every plugin call of this reply is in the log before the reply ends.
      await Promise.allSettled(pluginLogs);
      chat.emit = undefined;
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
    if (what === 'kicad') {
      const lib = library.sources.find((s): s is KicadSystemLibrary => s instanceof KicadSystemLibrary) ?? null;
      if (req.method === 'GET' && !url.pathname.split('/')[4]) {
        const dl = await downloadedKicadLibraries(opts.kicadDownload?.root);
        return json(res, 200, {
          available: !!lib,
          origin: lib?.origin ?? null,
          ...(lib ? { symbols: lib.symbolsDir, footprints: lib.footprintsDir } : {}),
          ...(dl ? { downloaded: { version: dl.version, date: dl.date } } : {}),
          download: kicadJob,
          canDownload: isLocal(req),
          repositories: [KICAD_REPOS.symbols, KICAD_REPOS.footprints],
          license: KICAD_LIBRARY_LICENSE,
        });
      }
      if (req.method === 'POST' && url.pathname.split('/')[4] === 'download') {
        // Fetches tens of megabytes for the machine the server runs on: only from that machine.
        if (!isLocal(req)) return json(res, 403, { error: 'The KiCad libraries can only be downloaded from the computer the server runs on.' });
        if (kicadJob && !['done', 'error'].includes(kicadJob.stage)) return json(res, 409, { error: 'A download is already running.', download: kicadJob });
        const b = await body(req).catch(() => ({}) as Record<string, unknown>);
        kicadJob = { stage: 'version', bytes: 0, files: 0, started: new Date().toISOString() };
        const started = kicadJob.started;
        log('downloading the official KiCad libraries');
        void downloadKicadLibraries({
          ...(typeof b.version === 'string' && /^\d+\.\d+\.\d+$/.test(b.version) ? { version: b.version } : {}),
          ...(opts.kicadDownload?.root ? { root: opts.kicadDownload.root } : {}),
          ...(opts.kicadDownload?.fetchImpl ? { fetchImpl: opts.kicadDownload.fetchImpl } : {}),
          // "done" is announced only once the new library is in use (below).
          onProgress: (p) => (kicadJob = { ...p, ...(p.stage === 'done' ? { stage: 'footprints' as const } : {}), started }),
        })
          .then((dl) => {
            // Use them now, unless KiCad itself is installed (that copy wins).
            if (!lib || lib.origin === 'downloaded') {
              const fresh = new KicadSystemLibrary({ fs: nodeLibFs, symbolsDir: dl.symbols, footprintsDir: dl.footprints, origin: 'downloaded' });
              library.sources = [...library.sources.filter((s) => !(s instanceof KicadSystemLibrary)), fresh];
              resetKicadSystemLibrary();
            }
            kicadJob = { ...(kicadJob ?? { bytes: 0, files: 0 }), stage: 'done', version: dl.version, started };
            log(`KiCad libraries ${dl.version} ready (${kicadJob.files} files)`);
          })
          .catch((e) => log(`KiCad library download failed: ${(e as Error).message}`));
        return json(res, 202, { download: kicadJob });
      }
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
        for (const c of chats.values()) closeChat(c);
        for (const l of logins.values()) l.cancel();
        for (const c of wss.clients) c.terminate();
        wss.close();
        http.close(() => r());
      }),
  };
}
