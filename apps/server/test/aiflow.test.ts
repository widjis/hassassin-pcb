/**
 * A14 (docs/06-agent-plugins.md): AI Full projects go through their stages one at a time (finish_stage stops
 * the agent until the user continues); the agent asks decisions with ask_user (questions with choices) and
 * keeps a checklist of every piece of work, with every backend.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import {
  agentTools, aiFlowNote, aiFlowOf, isGoAhead, AGENT_SYSTEM, AgentSession, DEFAULT_LIMITS, newProject, parseQuestions, projectNameFrom, runTool, wizardPrompt,
  type AgentEvent, type AgentParams, type ModelCall,
} from '@hassassin/tools';
import { CliAgentSession } from '../src/cliAgents.ts';
import { startServer } from '../src/server.ts';

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

const fullProject = (stage = 'requirements') => {
  const p = newProject('t');
  p.doc.meta.aiFlow = { mode: 'full', stage, waiting: false };
  p.doc.meta.agentLimits = { ...DEFAULT_LIMITS, budget: 'USD 8' };
  return p;
};

describe('AI Full stages (A14)', () => {
  it('tells the agent its stage, its limits and to stop at the end; nothing for AI Assisted', () => {
    const p = newProject('t');
    expect(aiFlowNote(p.doc)).toBe('');
    p.doc.meta.aiFlow = { mode: 'assisted', stage: 'requirements', waiting: false };
    expect(aiFlowNote(p.doc)).toBe('');
    const f = fullProject('schematic');
    const note = aiFlowNote(f.doc);
    expect(note).toContain('Current stage: Schematic.');
    expect(note).toContain('parts budget per board: USD 8');
    expect(note).toContain('call finish_stage');
    expect(note).toContain('Never start the Components stage yourself');
    f.doc.meta.aiFlow = { mode: 'full', stage: 'schematic', waiting: true };
    expect(aiFlowNote(f.doc)).toContain('the user has not continued yet');
  });

  it('a typed go-ahead counts as Continue; other messages do not', () => {
    for (const t of ['lanjut', 'Lanjut!', 'lanjutkan', 'oke lanjut', 'ya, lanjut', 'gas', 'continue', 'go ahead', 'next', 'lanjut ke tahap berikutnya']) expect(isGoAhead(t), t).toBe(true);
    for (const t of ['lanjut tapi ganti sensornya ke AHT20', 'ganti LED', 'continue with 4 layers instead', 'ok']) expect(isGoAhead(t), t).toBe(false);
  });

  it('builds the first message from the wizard, and a project name', () => {
    const text = wizardPrompt({ description: 'A USB-C sensor node with an ESP32-C3', spec: { supply: 'USB-C 5 V' }, limits: { ...DEFAULT_LIMITS, distributors: ['LCSC'] } });
    expect(text).toContain('I want to build: A USB-C sensor node with an ESP32-C3');
    expect(text).toContain('- Power supply: USB-C 5 V');
    expect(text).toMatch(/Propose values for: Max current, Interfaces/);
    expect(text).toContain('distributors: LCSC');
    expect(text).toContain('Start with the Requirements stage.');
    expect(projectNameFrom('A USB-C sensor node with an ESP32-C3, small')).toBe('A USB-C sensor node with');
  });

  it('finish_stage ends the current stage only, and waits; the last one finishes the project', async () => {
    const plain = newProject('t');
    await expect(runTool(plain, 'finish_stage', { stage: 'requirements', summary: 'x' })).rejects.toThrow(/not in AI Full/);
    const p = fullProject();
    await expect(runTool(p, 'finish_stage', { stage: 'schematic', summary: 'x' })).rejects.toThrow(/current stage is Requirements/);
    const r = (await runTool(p, 'finish_stage', { stage: 'requirements', summary: 'Spec done; blocks chosen.', open: 'Battery or USB only?' })) as { next: string };
    expect(r.next).toBe('schematic');
    expect(aiFlowOf(p.doc)).toMatchObject({ mode: 'full', stage: 'requirements', waiting: true, summary: 'Spec done; blocks chosen.', open: 'Battery or USB only?' });
    // The user continues (the Agent tab sets the next stage), and at the end every stage is done.
    p.doc.meta.aiFlow = { mode: 'full', stage: 'review', waiting: false };
    expect(((await runTool(p, 'finish_stage', { stage: 'review', summary: 'Reviewed.' })) as { next: null }).next).toBeNull();
    expect(aiFlowOf(p.doc)).toMatchObject({ done: true, waiting: true });
  });
});

describe('questions with choices and the checklist (A14)', () => {
  it('ask_user is offered in both modes and checks its questions', () => {
    for (const mode of ['agent', 'ask'] as const) expect(agentTools(mode).map((t) => t.name)).toEqual(expect.arrayContaining(['update_tasks', 'ask_user']));
    expect(() => parseQuestions({ questions: [] })).toThrow(/1 to 4/);
    expect(() => parseQuestions({ questions: [{ question: 'Supply?', header: 'Supply', options: [{ label: 'USB' }] }] })).toThrow(/2 to 4 options/);
    expect(parseQuestions({ questions: [{ question: ' Supply? ', header: 'Power supply input', options: [{ label: 'USB-C (recommended)' }, { label: 'Battery', description: '1S Li-ion' }], multiSelect: true }] })).toEqual([
      { question: 'Supply?', header: 'Power supply inp', options: [{ label: 'USB-C (recommended)' }, { label: 'Battery', description: '1S Li-ion' }], multiSelect: true },
    ]);
    // Every piece of work gets a checklist; decisions are asked with buttons.
    expect(AGENT_SYSTEM).toMatch(/For every request that does work .* checklist .* update_tasks/);
    expect(AGENT_SYSTEM).toContain('ask with ask_user');
  });

  it('the API agent shows the questions as a card and the call does not change the project', async () => {
    const q = { questions: [{ question: 'How is it powered?', header: 'Supply', options: [{ label: 'USB-C (recommended)' }, { label: '1S Li-ion' }] }] };
    const { model } = scripted([() => ({ tools: [{ name: 'update_tasks', input: { tasks: [{ title: 'Ask about power', status: 'doing' }] } }, { name: 'ask_user', input: q }] }), () => ({ text: 'Waiting for your answer.' })]);
    const p = newProject('t');
    const content = () => JSON.stringify({ ...toFile(p.doc), savedAt: '' });
    const before = content();
    const s = new AgentSession({ model, runTool: (n, a) => runTool(p, n, a) });
    const ev: AgentEvent[] = [];
    await s.send('start', (e) => ev.push(e));
    expect(ev.find((e) => e.type === 'tasks')).toMatchObject({ tasks: [{ title: 'Ask about power', status: 'doing' }] });
    expect(ev.find((e) => e.type === 'question')).toMatchObject({ questions: [{ header: 'Supply', options: [{ label: 'USB-C (recommended)' }, { label: '1S Li-ion' }] }] });
    expect(ev.filter((e) => e.type === 'tool_result').every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(content()).toBe(before);
  });

  it('Claude Code and Codex: an ask_user call through the MCP server shows the same card', () => {
    const s = new CliAgentSession({ cli: 'claude', editLink: 'http://x/?p=a&t=e', viewLink: 'http://x/?p=a&t=v', workDir: mkdtempSync(join(tmpdir(), 'hcli-')), agentName: 'AI' });
    const ev: AgentEvent[] = [];
    (s as unknown as { tool: (id: string, name: string, input: unknown, emit: (e: AgentEvent) => void, names: Map<string, string>) => void }).tool('t1', 'mcp__hassassin__ask_user', { questions: [{ question: 'Layers?', header: 'Layers', options: [{ label: '2' }, { label: '4' }] }] }, (e) => ev.push(e), new Map());
    expect(ev.map((e) => e.type)).toEqual(['question', 'tool']);
    expect(ev[0]).toMatchObject({ type: 'question', id: 't1', questions: [{ header: 'Layers' }] });
  });
});

describe('an AI Full project on the collaboration server (A14)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  const { model, calls } = scripted([() => ({ tools: [{ name: 'finish_stage', input: { stage: 'requirements', summary: 'Requirements complete.' } }] }), () => ({ text: 'Stage done; continue when ready.' })]);
  beforeAll(async () => {
    srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hflow-')), kicad: false, agentModel: model, builtinPlugins: null });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  it('gives the agent its stage with each message, and finish_stage leaves the project waiting', async () => {
    const p = fullProject();
    const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'F', doc: toFile(p.doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { edit: string } };
    const res = await fetch(`${base}/api/agent/${id}?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ prompt: 'I want to build a sensor node', user: { name: 'Ana' } }) });
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(JSON.stringify(calls[0]!.messages[0])).toContain('Current stage: Requirements.');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'finish_stage', ok: true });
    const proj = (await (await fetch(`${base}/api/projects/${id}/file?token=${tokens.edit}`)).json()) as { meta: { aiFlow: unknown } };
    expect(proj.meta.aiFlow).toMatchObject({ mode: 'full', stage: 'requirements', waiting: true, summary: 'Requirements complete.' });
  });
});
