import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@hassassin/tools';
import { CliAgentSession } from '../src/cliAgents.ts';

const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);
const mk = (cli: 'claude' | 'codex') => new CliAgentSession({ cli, editLink: 'http://127.0.0.1:1/?p=a&t=edit', viewLink: 'http://127.0.0.1:1/?p=a&t=view', workDir: mkdtempSync(join(tmpdir(), 'hcli-agent-')), agentName: 'AI', bin: fx(`fake-${cli}.mjs`) });

describe('CLI agent backends', () => {
  it('translates Claude Code stream-json into agent events and resumes the session', async () => {
    const s = mk('claude');
    const ev: AgentEvent[] = [];
    await s.send('check', (e) => ev.push(e));
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Checking.', 'Two ERC errors.']);
    expect(ev.find((e) => e.type === 'tasks')).toMatchObject({ tasks: [{ title: 'Look', status: 'doing' }] });
    expect(ev.filter((e) => e.type === 'tool_result')).toMatchObject([{ name: 'update_tasks', ok: true }, { name: 'run_erc', ok: true, summary: '2 error(s), 0 warning(s)' }]);
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'success' });
    const again: AgentEvent[] = [];
    await s.send('again', (e) => again.push(e));
    expect(again.find((e) => e.type === 'text')).toMatchObject({ text: 'Again.' });
  });

  it('translates Codex exec JSON, honours Ask mode, and resumes the thread', async () => {
    const s = mk('codex');
    s.mode = 'ask';
    const ev: AgentEvent[] = [];
    await s.send('parts?', (e) => ev.push(e));
    expect(ev.some((e) => e.type === 'text' && e.text.includes('agent mode'))).toBe(false); // MCP server got the read-only flag
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'list_parts', ok: true, summary: '1 result(s)' });
    expect(ev.find((e) => e.type === 'usage')).toEqual({ type: 'usage', input: 40, output: 7, cacheRead: 60 });
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'end_turn' });
    const again: AgentEvent[] = [];
    await s.send('more', (e) => again.push(e));
    expect(again.find((e) => e.type === 'text')).toMatchObject({ text: 'resumed\n' });
  });

  it('Stop ends the whole CLI, also the program its launcher started', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcli-stop-'));
    process.env.FAKE_CHILD_PID = join(dir, 'child.pid');
    const s = new CliAgentSession({ cli: 'claude', editLink: 'http://127.0.0.1:1/?p=a&t=edit', viewLink: 'http://127.0.0.1:1/?p=a&t=view', workDir: dir, agentName: 'AI', bin: fx('fake-claude-slow.mjs') });
    const abort = new AbortController();
    const ev: AgentEvent[] = [];
    const run = s.send('work', (e) => ev.push(e), abort.signal);
    for (let i = 0; i < 50 && !existsSync(process.env.FAKE_CHILD_PID); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(process.env.FAKE_CHILD_PID, 'utf8'));
    abort.abort();
    await run;
    expect(ev.at(-1)).toEqual({ type: 'done', reason: 'stopped' });
    await new Promise((r) => setTimeout(r, 300));
    const alive = (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    expect(alive).toBe(false);
    delete process.env.FAKE_CHILD_PID;
  });
});
