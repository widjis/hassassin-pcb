import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { AgentSession, agentTools, newProject, runTool, type AgentEvent, type AgentParams, type ModelCall } from '@hassassin/tools';
import { startServer } from '../src/server.ts';

/** A scripted stand-in for the model: each call returns the next step. */
function scripted(steps: ((p: AgentParams) => { text?: string; tools?: { name: string; input: unknown }[] })[]): { model: ModelCall; calls: AgentParams[] } {
  const calls: AgentParams[] = [];
  let n = 0;
  const model: ModelCall = async (params, onText) => {
    calls.push(structuredClone(params));
    const s = steps[Math.min(n++, steps.length - 1)]!(params);
    if (s.text) onText(s.text);
    const content = [
      ...(s.text ? [{ type: 'text', text: s.text, citations: null }] : []),
      ...(s.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name: t.name, input: t.input })),
    ];
    return { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: s.tools?.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } } as never;
  };
  return { model, calls };
}

describe('agent loop', () => {
  it('plans, edits through tools, recovers from tool errors, keeps history append-only', async () => {
    const p = newProject('t');
    const { model, calls } = scripted([
      () => ({ text: 'Plan first.', tools: [{ name: 'update_tasks', input: { tasks: [{ title: 'Add LED + resistor', status: 'doing', stage: 'schematic' }] } }] }),
      () => ({ tools: [{ name: 'add_part', input: { kind: 'resistor', x: 0, y: 0, value: '330' } }, { name: 'add_part', input: { kind: 'nope', x: 0, y: 0 } }] }),
      (params) => {
        const last = params.messages.at(-1)!;
        const res = (last.content as { is_error?: boolean }[]);
        expect(res.map((r) => !!r.is_error)).toEqual([false, true]); // both results in one user message
        return { tools: [{ name: 'add_part', input: { kind: 'led', x: 15.24, y: 0 } }, { name: 'connect_pins', input: { from: 'R1.2', to: 'D1.2' } }] };
      },
      () => ({ text: 'Done: R1 and D1 are connected.' }),
    ]);
    const s = new AgentSession({ model, runTool: (name, args) => runTool(p, name, args) });
    const ev: AgentEvent[] = [];
    await s.send('Add an LED with a resistor', (e) => ev.push(e));
    expect(ev.find((e) => e.type === 'tasks')).toMatchObject({ tasks: [{ title: 'Add LED + resistor', status: 'doing' }] });
    expect(ev.filter((e) => e.type === 'tool_result').map((e) => (e as { ok: boolean }).ok)).toEqual([true, true, false, true, true]);
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'end_turn' });
    expect([...p.doc.nodes.values()].filter((n) => n.type === 'symbol').map((n) => n.name).sort()).toEqual(['D1', 'R1']);
    // Every request extends the previous one (prefix-stable for caching and preserved thinking).
    for (let i = 1; i < calls.length; i++) expect(JSON.stringify(calls[i]!.messages).startsWith(JSON.stringify(calls[i - 1]!.messages).slice(0, -1))).toBe(true);
    expect(calls[0]!.model).toBe('claude-opus-5-5');
    expect(calls[0]!.messages[0]!.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('<project_status') })]));
  });

  it('ask mode offers only read tools and refuses edits', async () => {
    expect(agentTools('ask').map((t) => t.name)).not.toContain('add_part');
    expect(agentTools('agent').map((t) => t.name)).toContain('add_part');
    expect(agentTools('agent').map((t) => t.name)).not.toContain('export_fab');
    const p = newProject('t');
    const { model } = scripted([() => ({ tools: [{ name: 'add_part', input: { kind: 'resistor', x: 0, y: 0 } }] }), () => ({ text: 'ok' })]);
    const s = new AgentSession({ model, runTool: (name, args) => runTool(p, name, args), mode: 'ask' });
    const ev: AgentEvent[] = [];
    await s.send('add a resistor', (e) => ev.push(e));
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    expect([...p.doc.nodes.values()].some((n) => n.type === 'symbol')).toBe(false);
  });
});

describe('agent on the collaboration server', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  const { model } = scripted([
    () => ({ tools: [{ name: 'add_part', input: { kind: 'capacitor', x: 10, y: 10, value: '1u' } }] }),
    () => ({ text: 'Added C1.' }),
  ]);
  beforeAll(async () => {
    srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hagent-')), kicad: false, agentModel: model });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  it('streams events and its edits land in the shared project', async () => {
    const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'A', doc: toFile(newProject().doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { edit: string; view: string } };
    const res = await fetch(`${base}/api/agent/${id}?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ prompt: 'add a 1u capacitor', user: { name: 'Ana' } }) });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(events[0]).toMatchObject({ type: 'chat', mode: 'agent' });
    expect(events.at(-2)).toEqual({ type: 'done', reason: 'end_turn' });
    // After the reply: its edits, so they can be undone together.
    expect(events.at(-1)).toMatchObject({ type: 'edits', count: 1 });
    const lp = await srv.store.get(id);
    expect([...lp.doc.nodes.values()].filter((n) => n.type === 'symbol').map((n) => n.name)).toEqual(['C1']);
    // A view link only gets ask mode.
    const v = await fetch(`${base}/api/agent/${id}?token=${tokens.view}`, { method: 'POST', body: JSON.stringify({ prompt: 'what is here?' }) });
    expect((await v.text()).split('\n\n')[0]).toContain('"mode":"ask"');
    expect((await fetch(`${base}/api/agent/status`)).ok).toBe(true);
  });
});

describe('undoing one agent reply', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  const { model } = scripted([
    () => ({ tools: [{ name: 'add_part', input: { kind: 'resistor', x: 0, y: 0, value: '1k' } }] }),
    () => ({ tools: [{ name: 'add_part', input: { kind: 'capacitor', x: 20, y: 0, value: '1u' } }] }),
    () => ({ text: 'Added R1 and C1.' }),
    () => ({ tools: [{ name: 'add_part', input: { kind: 'led', x: 40, y: 0 } }] }),
    () => ({ text: 'Added D1.' }),
  ]);
  beforeAll(async () => {
    srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hundo-')), kicad: false, agentModel: model });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  const symbols = async (id: string) => [...(await srv.store.get(id)).doc.nodes.values()].filter((n) => n.type === 'symbol').map((n) => n.name).sort();

  it('undoes exactly that reply, once, and refuses when someone changed the same objects since', async () => {
    const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'U', doc: toFile(newProject().doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { edit: string; view: string } };
    const ask = async (prompt: string, chat?: string) =>
      (await (await fetch(`${base}/api/agent/${id}?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ prompt, chat, user: { name: 'Ana' } }) })).text())
        .split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as Record<string, unknown>);
    const undo = (chat: unknown, turn: unknown, token = tokens.edit) =>
      fetch(`${base}/api/agent/${id}/undo?token=${token}`, { method: 'POST', body: JSON.stringify({ chat, turn, user: { name: 'Ana' } }) });

    const first = await ask('add R1 and C1');
    const chat = first[0]!.chat;
    const e1 = first.find((e) => e.type === 'edits')!;
    expect(e1).toMatchObject({ count: 2 });
    const second = await ask('add an LED', String(chat));
    const e2 = second.find((e) => e.type === 'edits')!;
    expect(await symbols(id)).toEqual(['C1', 'D1', 'R1']);

    // Viewers cannot undo; the first reply's objects are untouched since, so it undoes; the second stays.
    expect((await undo(chat, e1.turn, tokens.view)).status).toBe(403);
    const ok = await undo(chat, e1.turn);
    expect(await ok.json()).toEqual({ ok: true, undone: 2 });
    expect(await symbols(id)).toEqual(['D1']);
    expect((await undo(chat, e1.turn)).status).toBe(409);

    // A person edits D1 afterwards: undoing the second reply would overwrite that, so it is refused.
    const lp = await srv.store.get(id);
    const d1 = [...lp.doc.nodes.values()].find((n) => n.type === 'symbol' && n.name === 'D1')!;
    await srv.store.commit(lp, { id: 'p', name: 'Ben', color: '#123456', kind: 'person' }, 'Rename', [{ op: 'setProp', uid: d1.uid, key: 'Value', value: 'red' }]);
    const refused = await undo(chat, e2.turn);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Ben changed the same objects/);
    expect(await symbols(id)).toEqual(['D1']);
  });
});
