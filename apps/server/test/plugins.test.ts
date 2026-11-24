/**
 * Agent plugins (docs/06-agent-plugins.md, A1): installed per server, switched on per project, offered to
 * every backend only when on, Ask mode gets read plugins only, secrets stay on the server, a missing or
 * crashing plugin leaves the agent working, every call logged.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { AgentSession, newProject, runTool, type AgentEvent, type AgentParams, type ModelCall } from '@hassassin/tools';
import { CliAgentSession } from '../src/cliAgents.ts';
import { manifestProblems, McpClient, PluginHost, type PluginManifest } from '../src/plugins.ts';
import { startServer } from '../src/server.ts';

const ECHO = join(import.meta.dirname, 'fixtures', 'echo-plugin.mjs');
const SECRET = 'sk-test-0123456789';

const echo = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'echo', name: 'Echo', version: '1.0.0', publisher: 'Tests', permission: 'read', hosts: ['example.com'], command: ECHO,
  settings: [{ key: 'ECHO_KEY', label: 'Echo key', secret: true, required: true }], ...over,
});

/** A data folder with the given plugins installed, and settings for them. */
function dataDir(plugins: unknown[], settings: Record<string, Record<string, string>> = { echo: { ECHO_KEY: SECRET } }): string {
  const d = mkdtempSync(join(tmpdir(), 'hplug-'));
  writeFileSync(join(d, 'plugins.json'), JSON.stringify({ plugins }));
  writeFileSync(join(d, 'plugin-settings.json'), JSON.stringify(settings));
  return d;
}

/** Scripted model: each call returns the next step (see agent.test.ts). */
function scripted(steps: ((p: AgentParams) => { text?: string; tools?: { name: string; input: unknown }[] })[]): { model: ModelCall; calls: AgentParams[] } {
  const calls: AgentParams[] = [];
  let n = 0;
  const model: ModelCall = async (params, onText) => {
    calls.push(structuredClone(params));
    const s = steps[Math.min(n++, steps.length - 1)]!(params);
    if (s.text) onText(s.text);
    const content = [...(s.text ? [{ type: 'text', text: s.text, citations: null }] : []), ...(s.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: t.name, input: t.input }))];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } as never;
  };
  return { model, calls };
}

describe('agent plugins (A1)', () => {
  it('checks manifests: id, permission, hosts, settings keys', () => {
    expect(manifestProblems(echo())).toEqual([]);
    expect(manifestProblems({ ...echo(), id: 'hassassin' }).join()).toMatch(/id/);
    expect(manifestProblems({ ...echo(), id: 'Bad id' }).join()).toMatch(/id/);
    expect(manifestProblems({ ...echo(), permission: 'write' as never }).join()).toMatch(/permission/);
    expect(manifestProblems({ ...echo(), hosts: undefined as never }).join()).toMatch(/hosts/);
    expect(manifestProblems({ ...echo(), settings: [{ key: 'lower', label: 'x' }] }).join()).toMatch(/UPPER_CASE/);
    // A bad entry in plugins.json is reported, the good ones still load.
    const host = new PluginHost(dataDir([echo(), { id: 'x' }]));
    expect(host.manifests().manifests.map((m) => m.id)).toEqual(['echo']);
    expect(host.manifests().problems[0]!.id).toBe('x');
  });

  it('lists plugins with their tools and settings filled in, never the setting values', async () => {
    const host = new PluginHost(dataDir([echo(), echo({ id: 'nokey' }), echo({ id: 'gone', command: './no-such-plugin.mjs' })], { echo: { ECHO_KEY: SECRET }, gone: { ECHO_KEY: SECRET } }));
    const { plugins } = await host.list();
    expect(JSON.stringify(plugins)).not.toContain(SECRET);
    const by = Object.fromEntries(plugins.map((p) => [p.id, p]));
    expect(by.echo!.status).toMatchObject({ ok: true, tools: [{ name: 'echo' }, { name: 'crash' }] });
    expect(by.echo!.settings).toEqual([expect.objectContaining({ key: 'ECHO_KEY', configured: true })]);
    // Without its required setting it is not started; a command that does not exist gives a clear error.
    expect(by.nokey!.status).toMatchObject({ ok: false, error: expect.stringMatching(/not set up: Echo key missing/) });
    expect(by.gone!.status).toMatchObject({ ok: false, error: expect.stringMatching(/plugin (exited|stopped|.*ENOENT|.*Cannot find)/i) });
  });

  it('gives a message only the plugins switched on, set up and allowed in its mode', async () => {
    const host = new PluginHost(dataDir([echo(), echo({ id: 'writer', permission: 'propose' })], { echo: { ECHO_KEY: SECRET }, writer: { ECHO_KEY: SECRET } }));
    expect((await host.active(undefined, 'agent')).plugins).toEqual([]);
    const on = await host.active(['echo', 'writer', 'missing'], 'agent');
    expect(on.plugins.map((p) => p.manifest.id)).toEqual(['echo', 'writer']);
    expect(on.skipped).toEqual([{ id: 'missing', reason: expect.stringMatching(/not installed/) }]);
    // The plugin process gets its settings, not the server's environment.
    expect(on.plugins[0]!.env).toMatchObject({ ECHO_KEY: SECRET, HASSASSIN_PLUGIN: 'echo' });
    const ask = await host.active(['echo', 'writer'], 'ask');
    expect(ask.plugins.map((p) => p.manifest.id)).toEqual(['echo']);
    expect(ask.skipped).toEqual([{ id: 'writer', reason: expect.stringMatching(/Ask mode/) }]);
  });

  it('talks MCP to a plugin: tools, a call with its setting, the server keys kept out, a crash reported', async () => {
    const host = new PluginHost(dataDir([echo()]));
    const [p] = (await host.active(['echo'], 'agent')).plugins;
    process.env.ANTHROPIC_API_KEY ??= 'server-key';
    const c = new McpClient(p!.command, p!.args, p!.env, 5000);
    await c.start();
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo', 'crash']);
    expect(JSON.parse((await c.callTool('echo', { text: 'hi' })).text)).toEqual({ echo: 'hi', keySet: true, apiKeyLeaked: false });
    await expect(c.callTool('crash', {})).rejects.toThrow(/exited.*crashing as asked/);
    expect(c.alive).toBe(false);
    c.close();
  });

  it('offers plugins to Claude Code and Codex only when they are on', async () => {
    const host = new PluginHost(dataDir([echo()]));
    const { plugins } = await host.active(['echo'], 'agent');
    const mk = (cli: 'claude' | 'codex') => new CliAgentSession({ cli, editLink: 'http://x/?p=a&t=e', viewLink: 'http://x/?p=a&t=v', workDir: mkdtempSync(join(tmpdir(), 'hcli-')), agentName: 'AI' });
    const argsOf = (s: CliAgentSession) => (s as unknown as { args: (p: string) => string[] }).args('hi');
    const claude = mk('claude');
    let a = argsOf(claude);
    expect(Object.keys(JSON.parse(a[a.indexOf('--mcp-config') + 1]!).mcpServers)).toEqual(['hassassin']);
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__hassassin');
    claude.plugins = plugins;
    claude.pluginNote = 'Plugins for this project: echo';
    a = argsOf(claude);
    const servers = JSON.parse(a[a.indexOf('--mcp-config') + 1]!).mcpServers;
    expect(Object.keys(servers)).toEqual(['hassassin', 'echo']);
    expect(servers.echo.env.ECHO_KEY).toBe(SECRET);
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__hassassin,mcp__echo');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('Plugins for this project: echo');
    const codex = mk('codex');
    expect(argsOf(codex).find((x) => x.startsWith('mcp_servers='))).not.toContain('"echo"');
    codex.plugins = plugins;
    expect(argsOf(codex).find((x) => x.startsWith('mcp_servers='))).toContain('"echo"={command=');
  });

  it('the API agent calls a plugin tool; a crashing tool is an error result and the agent goes on', async () => {
    const host = new PluginHost(dataDir([echo()]));
    const { plugins } = await host.active(['echo'], 'agent');
    const p = plugins[0]!;
    const c = new McpClient(p.command, p.args, p.env, 5000);
    const tools = p.tools.map((t) => ({
      name: `echo__${t.name}`, display: `echo.${t.name}`, description: t.description, input_schema: t.inputSchema,
      call: async (args: Record<string, unknown>) => {
        if (!c.alive) await c.start();
        return c.callTool(t.name, args);
      },
    }));
    const { model, calls } = scripted([
      () => ({ tools: [{ name: 'echo__echo', input: { text: 'datasheet' } }] }),
      () => ({ tools: [{ name: 'echo__crash', input: {} }] }),
      () => ({ text: 'The plugin stopped; I went on without it.' }),
    ]);
    const proj = newProject('t');
    const s = new AgentSession({ model, runTool: (n, a) => runTool(proj, n, a) });
    const ev: AgentEvent[] = [];
    await s.send('find it', (e) => ev.push(e), undefined, { tools, note: 'Plugins for this project: echo' });
    expect(calls[0]!.tools!.map((t) => (t as { name: string }).name)).toContain('echo__echo');
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('<context>');
    const results = ev.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    expect(results.map((r) => [r.name, r.ok])).toEqual([['echo.echo', true], ['echo.crash', false]]);
    expect(results[0]!.detail).toContain('"echo":"datasheet"');
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'end_turn' });
    c.close();
    // Without plugins the next message offers none.
    await s.send('again', () => {});
    expect(calls.at(-1)!.tools!.some((t) => (t as { name: string }).name.startsWith('echo__'))).toBe(false);
  });
});

describe('plugins on the collaboration server', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  const { model } = scripted([() => ({ tools: [{ name: 'echo__echo', input: { text: SECRET } }] }), () => ({ text: 'Done.' })]);
  beforeAll(async () => {
    srv = await startServer({ port: 0, dataDir: dataDir([echo(), echo({ id: 'off' })], { echo: { ECHO_KEY: SECRET }, off: { ECHO_KEY: SECRET } }), kicad: false, agentModel: model });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  it('lists the plugins and the project\'s switches, runs a switched-on plugin and logs the call without secrets', async () => {
    const p = newProject('P');
    p.doc.meta.agentPlugins = ['echo', 'gone'];
    const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'P', doc: toFile(p.doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { edit: string; view: string } };
    const list = (await (await fetch(`${base}/api/agent/${id}/plugins?token=${tokens.view}`)).json()) as { plugins: { id: string }[]; enabled: string[]; log: unknown[] };
    expect(list.plugins.map((x) => x.id)).toEqual(['datasheets', 'mouser', 'web', 'echo', 'off']); // the bundled web plugin (A2) is listed too, off
    expect(list.enabled).toEqual(['echo', 'gone']);
    expect(list.log).toEqual([]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    const res = await fetch(`${base}/api/agent/${id}?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ prompt: 'use echo', user: { name: 'Ana' } }) });
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(events).toContainEqual({ type: 'note', text: expect.stringMatching(/Plugin gone .*not installed/) });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'echo.echo', ok: true });
    const after = (await (await fetch(`${base}/api/agent/${id}/plugins?token=${tokens.view}`)).json()) as { log: { plugin: string; tool: string; args: string; ok: boolean; by: string; hosts: string[] }[] };
    expect(after.log).toEqual([expect.objectContaining({ plugin: 'echo', tool: 'echo', ok: true, by: 'Ana', hosts: ['example.com'], args: '{"text":"[secret]"}' })]);
  });
});
