/**
 * A13 (docs/06-agent-plugins.md): autonomy levels per project (Ask every time / Automatic within limits /
 * Full) decide what the agent does without asking; gates hold some changes for the user's OK at every level;
 * what the agent decided on its own is listed in the conversation and logged.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { autonomyNote, checkGate, DEFAULT_LIMITS, GateError, newProject, runTool, type AgentParams, type ModelCall } from '@hassassin/tools';
import { startServer } from '../src/server.ts';

const ECHO = join(import.meta.dirname, 'fixtures', 'echo-plugin.mjs');

/** A project with `n` resistors R1…Rn. */
async function withParts(n: number) {
  const p = newProject('t');
  for (let i = 0; i < n; i++) await runTool(p, 'add_part', { kind: 'resistor', x: i * 10, y: 0 });
  return p;
}
const refs = (n: number) => Array.from({ length: n }, (_, i) => `R${i + 1}`).join(', ');
const symbols = (p: { doc: { nodes: Map<string, { type: string }> } }) => [...p.doc.nodes.values()].filter((x) => x.type === 'symbol').length;

describe('gates (A13)', () => {
  it('an agent removing more parts than the limit at once is held; an OK lets one such change through', async () => {
    const p = await withParts(7);
    // A person (no guard) is never held.
    const free = await withParts(7);
    await runTool(free, 'delete', { target: refs(7) });
    expect(symbols(free)).toBe(0);
    p.guard = { bulkLimit: 5 };
    await runTool(p, 'delete', { target: refs(3) });
    expect(symbols(p)).toBe(4);
    const q = await withParts(7);
    q.guard = { bulkLimit: 5 };
    const err = await runTool(q, 'delete', { target: refs(7) }).catch((e) => e);
    expect(err).toBeInstanceOf(GateError);
    expect((err as GateError).gate).toMatchObject({ kind: 'bulk-remove', count: 7, parts: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] });
    expect((err as GateError).message).toMatch(/needs the user's OK first: Delete.*removing 7 parts .* at once \(more than 5\)/);
    expect(symbols(q)).toBe(7);
    q.guard.allow = { kind: 'bulk-remove', max: 7 };
    await runTool(q, 'delete', { target: refs(7) });
    expect(symbols(q)).toBe(0);
    expect(q.guard.allow).toBeUndefined();
    // Directly: nets count too.
    const r = await withParts(1);
    r.guard = { bulkLimit: 0 };
    expect(() => checkGate(r, 'x', [{ op: 'remove', uid: [...r.doc.nodes.values()].find((n) => n.type === 'symbol')!.uid }])).toThrow(GateError);
  });

  it('tells the agent its level, the gates and to list its own decisions', () => {
    const p = newProject('t');
    expect(autonomyNote(p.doc)).toMatch(/Automatic within limits[\s\S]*read-only ones you ask for are switched on at once[\s\S]*more than 5 parts or nets/);
    p.doc.meta.agentLimits = { ...DEFAULT_LIMITS, autonomy: 'ask', bulkLimit: 3 };
    expect(autonomyNote(p.doc)).toMatch(/Ask every time[\s\S]*let the user pick each part[\s\S]*more than 3 parts or nets/);
    p.doc.meta.agentLimits = { ...DEFAULT_LIMITS, autonomy: 'full' };
    expect(autonomyNote(p.doc)).toMatch(/Full[\s\S]*Plugins you ask for are switched on at once[\s\S]*say what you decided on your own/);
  });
});

describe('autonomy levels on the server (A13)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let url = '';
  let script: ((p: AgentParams) => { text?: string; tools?: { name: string; input: unknown }[] })[] = [];
  let n = 0;
  const model: ModelCall = async (params) => {
    const s = script[Math.min(n++, script.length - 1)]!(params);
    const content = [...(s.text ? [{ type: 'text', text: s.text, citations: null }] : []), ...(s.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: t.name, input: t.input }))];
    return { id: `m${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } as never;
  };
  beforeAll(async () => {
    const data = mkdtempSync(join(tmpdir(), 'hauto-'));
    // An installed read-only plugin, off in the projects, that the agent asks for.
    writeFileSync(join(data, 'plugins.json'), JSON.stringify({ plugins: [{ id: 'echo', name: 'Echo', version: '1.0.0', publisher: 'Tests', permission: 'read', hosts: [], command: ECHO }] }));
    srv = await startServer({ port: 0, dataDir: data, kicad: false, agentModel: model, builtinPlugins: null });
    url = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  const project = async (autonomy: 'ask' | 'auto' | 'full', parts = 0) => {
    const p = await withParts(parts);
    p.doc.meta.agentLimits = { ...DEFAULT_LIMITS, autonomy };
    const r = await fetch(`${url}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'P', doc: toFile(p.doc) }) });
    return (await r.json()) as { id: string; tokens: { edit: string } };
  };
  const run = async (id: string, token: string, prompt: string, chat?: string) =>
    (await (await fetch(`${url}/api/agent/${id}?token=${token}`, { method: 'POST', body: JSON.stringify({ prompt, user: { name: 'Ana' }, ...(chat ? { chat } : {}) }) })).text())
      .split('\n\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.replace(/^data: /, '')) as Record<string, unknown>);

  /** One task: ask for the plugin (to read a datasheet), place a regulator and give it its part number. */
  const task = () => {
    n = 0;
    script = [
      () => ({ tools: [{ name: 'request_plugin', input: { plugin: 'echo', reason: 'read the LDO datasheet' } }] }),
      () => ({ tools: [{ name: 'add_part', input: { kind: 'ic', x: 0, y: 0, ref: 'U1', pin_names: 'IN, GND, EN, NC, OUT' } }, { name: 'set_part_info', input: { ref: 'U1', mpn: 'TPS7A0233DBVR', manufacturer: 'Texas Instruments' } }] }),
      () => ({ text: 'U1 is the TPS7A02.' }),
    ];
  };

  for (const level of ['ask', 'auto', 'full'] as const) {
    it(`${level}: cards where the table says, the decisions listed and logged`, async () => {
      task();
      const { id, tokens } = await project(level);
      const ev = await run(id, tokens.edit, 'add a 3.3 V regulator with its datasheet');
      const card = ev.find((e) => e.type === 'plugin_request');
      // Ask every time: the user decides on a card; Automatic (read-only plugin) and Full: switched on at once.
      expect(card).toMatchObject({ plugin: 'echo', state: level === 'ask' ? 'approve' : 'done' });
      expect(ev.some((e) => e.type === 'gate')).toBe(false);
      const decided = ev.find((e) => e.type === 'decisions') as { items: { kind: string; what: string; reason?: string }[] };
      const expected = [...(level === 'ask' ? [] : [{ kind: 'plugin', what: 'switched on Echo', reason: 'read the LDO datasheet' }]), { kind: 'part', what: 'U1: TPS7A0233DBVR (Texas Instruments)' }];
      expect(decided.items).toEqual(expected);
      const log = (await (await fetch(`${url}/api/agent/${id}/decisions?token=${tokens.edit}`)).json()) as { items: unknown[]; by: string }[];
      expect(log.at(-1)).toMatchObject({ by: 'Ana', items: expected });
    });
  }

  it('the bulk gate gives a card even at Full; an OK lets the change through once', async () => {
    const { id, tokens } = await project('full', 7);
    n = 0;
    script = [() => ({ tools: [{ name: 'delete', input: { target: refs(7) } }] }), () => ({ text: 'Waiting for your OK.' })];
    const ev = await run(id, tokens.edit, 'remove all resistors');
    const gate = ev.find((e) => e.type === 'gate') as { id: string; count: number; summary: string; state: string };
    expect(gate).toMatchObject({ kind: 'bulk-remove', count: 7, state: 'ask' });
    expect(ev.find((e) => e.type === 'tool_result' && e.name === 'delete')).toMatchObject({ ok: false, summary: expect.stringMatching(/needs the user's OK/) });
    const chat = (ev.find((e) => e.type === 'chat') as { chat: string }).chat;
    const file = async () => (await (await fetch(`${url}/api/projects/${id}/file?token=${tokens.edit}`)).json()) as { nodes: { type: string }[] };
    expect((await file()).nodes.filter((x) => x.type === 'symbol')).toHaveLength(7);
    expect((await fetch(`${url}/api/agent/${id}/gates/decide?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ chat, id: gate.id, decision: 'allow', user: { name: 'Ana' } }) })).status).toBe(200);
    n = 0;
    script = [() => ({ tools: [{ name: 'delete', input: { target: refs(7) } }] }), () => ({ text: 'Removed.' })];
    const ev2 = await run(id, tokens.edit, 'Allowed: go ahead.', chat);
    expect(ev2.find((e) => e.type === 'tool_result' && e.name === 'delete')).toMatchObject({ ok: true });
    expect((await file()).nodes.filter((x) => x.type === 'symbol')).toHaveLength(0);
    // The OK was for one change: a second bulk removal is held again.
    expect((await fetch(`${url}/api/agent/${id}/gates/decide?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ chat, id: gate.id, decision: 'allow' }) })).status).toBe(410);
  });
});
