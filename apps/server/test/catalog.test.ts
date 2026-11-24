/**
 * A12 (docs/06-agent-plugins.md): a catalog of trusted plugins; installing (license, SHA-256, one .mjs file),
 * updating and removing, logged; the agent asks for a plugin with request_plugin and, per the project's
 * settings, it is switched on at once (the reply goes on with it) or the user decides on a card; nothing
 * outside the catalog.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { DEFAULT_LIMITS, newProject, type AgentParams, type ModelCall } from '@hassassin/tools';
import { Catalog } from '../src/catalog.ts';
import { startServer } from '../src/server.ts';

const PLUGIN = readFileSync(join(import.meta.dirname, 'fixtures', 'echo-plugin.mjs'));
const SHA = createHash('sha256').update(PLUGIN).digest('hex');

let files: Server;
let base = '';
beforeAll(async () => {
  files = createServer((req, res) => (req.url?.startsWith('/releases/') ? res.writeHead(200).end(PLUGIN) : res.writeHead(404).end()));
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(files.address() as { port: number }).port}`;
});
afterAll(() => files.close());

const manifest = (id: string, over: Record<string, unknown> = {}) => ({ name: `Plugin ${id}`, version: '1.0.0', publisher: 'Tests', description: `does ${id}`, permission: 'read', hosts: [], ...over });
/** A data folder whose plugins.json points at a catalog file in it. */
function dataWithCatalog(version = '1.0.0'): string {
  const d = mkdtempSync(join(tmpdir(), 'hcat-'));
  writeFileSync(join(d, 'plugins.json'), JSON.stringify({ catalog: 'catalog.json', plugins: [] }));
  writeFileSync(
    join(d, 'catalog.json'),
    JSON.stringify({
      plugins: [
        { id: 'web', bundled: true },
        { id: 'echo-cat', version, license: 'MIT', minHassassin: '0.4.0', manifest: manifest('echo-cat'), download: { url: `${base}/releases/echo-${version}.mjs`, sha256: SHA } },
        { id: 'bad-sha', version: '1.0.0', license: 'MIT', manifest: manifest('bad-sha'), download: { url: `${base}/releases/bad.mjs`, sha256: '0'.repeat(64) } },
        { id: 'copyleft', version: '1.0.0', license: 'GPL-3.0', manifest: manifest('copyleft'), download: { url: `${base}/releases/c.mjs`, sha256: SHA } },
        { id: 'writer', version: '1.0.0', license: 'Apache-2.0', manifest: manifest('writer', { permission: 'propose' }), download: { url: `${base}/releases/w.mjs`, sha256: SHA } },
        { id: 'keyed', version: '1.0.0', license: 'MIT', manifest: manifest('keyed', { settings: [{ key: 'ECHO_KEY', label: 'Echo key', secret: true, required: true }] }), download: { url: `${base}/releases/k.mjs`, sha256: SHA } },
        { id: 'future', version: '1.0.0', license: 'MIT', minHassassin: '9.0.0', manifest: manifest('future'), download: { url: `${base}/releases/f.mjs`, sha256: SHA } },
      ],
    }),
  );
  return d;
}

describe('the plugin catalog (A12)', () => {
  it('lists trusted entries; installs with the SHA-256 checked, updates, removes, and logs who asked', async () => {
    const d = dataWithCatalog();
    const c = new Catalog({ dataDir: d, builtinDir: null, allowLocal: true });
    const { entries, problems } = await c.entries();
    expect(entries.map((e) => e.id)).toEqual(['web', 'echo-cat', 'bad-sha', 'writer', 'keyed', 'future']);
    expect(problems.join()).toMatch(/copyleft: license GPL-3.0 is not a permissive one/);
    expect(await c.install('echo-cat', 'Ana', 'needed it')).toEqual({ id: 'echo-cat', version: '1.0.0', action: 'install' });
    const pj = JSON.parse(readFileSync(join(d, 'plugins.json'), 'utf8')) as { catalog: string; plugins: { id: string; command: string; catalog: { sha256: string } }[] };
    expect(pj.catalog).toBe('catalog.json');
    expect(pj.plugins[0]).toMatchObject({ id: 'echo-cat', catalog: { sha256: SHA } });
    expect(readFileSync(pj.plugins[0]!.command).equals(PLUGIN)).toBe(true);
    await expect(c.install('bad-sha', 'Ana')).rejects.toThrow(/SHA-256 .* is not the catalog's/);
    await expect(c.install('copyleft', 'Ana')).rejects.toThrow(/not in the plugin catalog/);
    await expect(c.install('npm:left-pad', 'agent')).rejects.toThrow(/not in the plugin catalog/);
    await expect(c.install('future', 'Ana')).rejects.toThrow(/needs Hassassin 9.0.0/);
    expect((await c.install('web', 'Ana')).action).toBe('none');
    // Over http only on this machine in tests: a real catalog needs https.
    await expect(new Catalog({ dataDir: d, builtinDir: null }).install('keyed', 'Ana')).rejects.toThrow(/https/);
    // A new version in the catalog is an update; removing takes the files away.
    writeFileSync(join(d, 'catalog.json'), readFileSync(join(d, 'catalog.json'), 'utf8').replace('"version":"1.0.0","license":"MIT","minHassassin"', '"version":"1.1.0","license":"MIT","minHassassin"'));
    const c2 = new Catalog({ dataDir: d, builtinDir: null, allowLocal: true });
    expect((await c2.install('echo-cat', 'Ana')).action).toBe('update');
    expect(existsSync(join(d, 'plugins', 'echo-cat', '1.0.0'))).toBe(false);
    await c2.remove('echo-cat', 'Ana');
    expect(existsSync(join(d, 'plugins', 'echo-cat'))).toBe(false);
    expect(c2.readInstalls().map((l) => `${l.action} ${l.id} ${l.version} ${l.by}`)).toEqual(['install echo-cat 1.0.0 Ana', 'update echo-cat 1.1.0 Ana', 'remove echo-cat 1.1.0 Ana']);
    expect(c2.readInstalls()[0]!.reason).toBe('needed it');
  });

  it('the repository\'s catalog lists the bundled plugins', async () => {
    const c = new Catalog({ dataDir: mkdtempSync(join(tmpdir(), 'hcat0-')), builtinDir: join(import.meta.dirname, '..', '..', '..', 'plugins') });
    expect((await c.entries()).entries.map((e) => e.id)).toEqual(['web', 'datasheets', 'mouser']);
  });
});

describe('the agent asks for a plugin (A12)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let url = '';
  let data = '';
  const calls: AgentParams[] = [];
  let script: ((p: AgentParams) => { text?: string; tools?: { name: string; input: unknown }[] })[] = [];
  let n = 0;
  const model: ModelCall = async (params) => {
    calls.push(structuredClone(params));
    const s = script[Math.min(n++, script.length - 1)]!(params);
    const content = [...(s.text ? [{ type: 'text', text: s.text, citations: null }] : []), ...(s.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: t.name, input: t.input }))];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } as never;
  };
  beforeAll(async () => {
    data = dataWithCatalog();
    srv = await startServer({ port: 0, dataDir: data, kicad: false, agentModel: model, builtinPlugins: null, allowLocalPluginDownloads: true });
    url = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  const project = async (autonomy: 'ask' | 'auto' | 'full') => {
    const p = newProject('P');
    p.doc.meta.agentLimits = { ...DEFAULT_LIMITS, autonomy };
    const r = await fetch(`${url}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'P', doc: toFile(p.doc) }) });
    return (await r.json()) as { id: string; tokens: { edit: string; view: string } };
  };
  const run = async (id: string, token: string, prompt: string) =>
    (await (await fetch(`${url}/api/agent/${id}?token=${token}`, { method: 'POST', body: JSON.stringify({ prompt, user: { name: 'Ana' } }) })).text())
      .split('\n\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.replace(/^data: /, '')) as Record<string, unknown>);
  const fileOf = async (id: string, token: string) => (await (await fetch(`${url}/api/projects/${id}/file?token=${token}`)).json()) as { meta: { agentPlugins?: string[] } };

  it('Automatic within limits: a read plugin is installed, switched on, and the reply goes on with its tools', async () => {
    n = 0;
    calls.length = 0;
    script = [
      () => ({ tools: [{ name: 'request_plugin', input: { plugin: 'echo-cat', reason: 'to echo the datasheet title' } }] }),
      () => ({ text: 'Asked for it.' }),
      (p) => ({ tools: p.tools!.some((t) => (t as { name: string }).name === 'echo-cat__echo') ? [{ name: 'echo-cat__echo', input: { text: 'TPS7A02' } }] : [] }),
      () => ({ text: 'Done with the plugin.' }),
    ];
    const { id, tokens } = await project('auto');
    const ev = await run(id, tokens.edit, 'echo the title');
    // The first message offered the catalog plugin.
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('Plugins you can ask for with request_plugin');
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('echo-cat: Plugin echo-cat');
    expect(ev.find((e) => e.type === 'plugin_request')).toMatchObject({ plugin: 'echo-cat', state: 'done', installedNow: true });
    expect(ev).toContainEqual({ type: 'note', text: 'Plugin echo-cat switched on; the agent goes on with it.' });
    expect(ev.find((e) => e.type === 'tool_result' && e.name === 'echo-cat.echo')).toMatchObject({ ok: true });
    expect((await fileOf(id, tokens.edit)).meta.agentPlugins).toEqual(['echo-cat']);
    const log = (await (await fetch(`${url}/api/agent/${id}/plugins?token=${tokens.view}`)).json()) as { installs: { action: string; id: string; by: string; reason: string }[] };
    expect(log.installs.at(-1)).toMatchObject({ action: 'install', id: 'echo-cat', reason: 'to echo the datasheet title' });
    expect(log.installs.at(-1)!.by).toMatch(/AI agent .*Ana/);
  });

  it('Ask every time, a propose plugin, a plugin needing a key, one outside the catalog: cards and refusals', async () => {
    // Ask every time: a card; the user installs it from the card.
    n = 0;
    script = [() => ({ tools: [{ name: 'request_plugin', input: { plugin: 'writer', reason: 'propose a footprint' } }] }), () => ({ text: 'Waiting for you.' })];
    const a = await project('ask');
    const ev = await run(a.id, a.tokens.edit, 'go');
    const card = ev.find((e) => e.type === 'plugin_request')!;
    expect(card).toMatchObject({ plugin: 'writer', state: 'approve', permission: 'propose', reason: 'propose a footprint' });
    expect(ev.find((e) => e.type === 'tool_result' && e.name === 'request_plugin')).toMatchObject({ ok: true, summary: expect.any(String) });
    expect((await fileOf(a.id, a.tokens.edit)).meta.agentPlugins).toBeUndefined();
    const chats = (await (await fetch(`${url}/api/agent/${a.id}/chats?token=${a.tokens.edit}`, { method: 'POST', body: '{}' })).json()) as { chat: string }[];
    expect((await fetch(`${url}/api/agent/${a.id}/plugins/decide?token=${a.tokens.view}`, { method: 'POST', body: JSON.stringify({ plugin: 'writer', request: card.id, chat: chats[0]!.chat, decision: 'install' }) })).status).toBe(403);
    expect((await fetch(`${url}/api/agent/${a.id}/plugins/decide?token=${a.tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'writer', request: card.id, chat: chats[0]!.chat, decision: 'install', user: { name: 'Ana' } }) })).status).toBe(200);
    expect((await fileOf(a.id, a.tokens.edit)).meta.agentPlugins).toEqual(['writer']);
    // Full: a plugin that needs a key is installed and switched on, and a card asks the user for the key.
    const f = await project('full');
    const r = await fetch(`${url}/api/agent/${f.id}/plugins/request?token=${f.tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'keyed', reason: 'needs a key', agent: 'nobody' }) });
    expect(await r.json()).toMatchObject({ plugin: 'keyed', state: 'needs-settings' });
    // Outside the catalog: refused, whatever the level.
    const x = await fetch(`${url}/api/agent/${f.id}/plugins/request?token=${f.tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'some-npm-package', reason: 'x' }) });
    expect(x.status).toBe(400);
    expect(((await x.json()) as { error: string }).error).toMatch(/not in the plugin catalog/);
    // A view link (Ask mode) never switches anything on by itself: a card.
    const v = await fetch(`${url}/api/agent/${f.id}/plugins/request?token=${f.tokens.view}`, { method: 'POST', body: JSON.stringify({ plugin: 'echo-cat', reason: 'x' }) });
    expect(await v.json()).toMatchObject({ state: 'asked' });
    // Installing by hand: only from this machine (the test runs on it).
    expect((await fetch(`${url}/api/agent/${f.id}/plugins/install?token=${f.tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'bad-sha' }) })).status).toBe(400);
  });
});
