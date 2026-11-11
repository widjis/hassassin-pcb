/**
 * In-app agent backed by a coding-agent CLI the user is signed in to (Claude Code or
 * Codex), so it runs on the user's own subscription instead of API credits.
 *
 * The CLI is started for each message with the Hassassin MCP server bound to the shared
 * project (HASSASSIN_PROJECT = an edit or view link), built-in tools off (Claude) or a
 * read-only sandbox in an empty folder (Codex). Its JSON event stream is translated into
 * the same AgentEvents the Agent tab already shows.
 *
 * Meant for a server on the user's own machine: a subscription is personal, so a server
 * shared with other people should use the API backend instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SYSTEM, type AgentEvent, type AgentMode, type AgentTask } from '@hassassin/tools';

export type CliId = 'claude' | 'codex';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const MCP_BIN = join(ROOT, 'apps', 'cli', 'bin', 'hassassin.mjs');

/** The CLI binary installed with the project (apps/server/node_modules/.bin), else the one on PATH. */
export function cliBin(id: CliId): string {
  const local = join(here, '..', 'node_modules', '.bin', id);
  return existsSync(local) ? local : id;
}

export const CLI_LABEL: Record<CliId, string> = { claude: 'Claude Code (Claude subscription)', codex: 'Codex (ChatGPT subscription)' };

/** Environment for the CLIs: subscription sign-in only, never this server's API keys. */
export function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  return env;
}

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
    } catch {
      return resolve({ code: -1, out: '' });
    }
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', () => (clearTimeout(t), resolve({ code: -1, out })));
    child.on('close', (code) => (clearTimeout(t), resolve({ code, out })));
  });
}

export interface CliStatus {
  id: CliId;
  label: string;
  installed: boolean;
  loggedIn: boolean;
  detail: string;
}

export async function cliStatus(id: CliId): Promise<CliStatus> {
  const bin = cliBin(id);
  const base = { id, label: CLI_LABEL[id] };
  if (id === 'claude') {
    const r = await run(bin, ['auth', 'status']);
    if (r.code === -1) return { ...base, installed: false, loggedIn: false, detail: 'not installed' };
    try {
      const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
      return { ...base, installed: true, loggedIn: !!j.loggedIn, detail: j.loggedIn ? `signed in (${j.subscriptionType ?? j.authMethod ?? 'account'})` : 'not signed in' };
    } catch {
      return { ...base, installed: true, loggedIn: false, detail: 'status unknown' };
    }
  }
  const r = await run(bin, ['login', 'status']);
  if (r.code === -1) return { ...base, installed: false, loggedIn: false, detail: 'not installed' };
  const ok = r.code === 0 && /logged in/i.test(r.out);
  return { ...base, installed: true, loggedIn: ok, detail: ok ? r.out.trim().split('\n').pop()! : 'not signed in' };
}

/** A sign-in started from the browser: the CLI opens the provider's page; output is relayed. */
export class LoginJob {
  id: CliId;
  lines: string[] = [];
  done = false;
  ok = false;
  private child: ChildProcess;

  constructor(id: CliId) {
    this.id = id;
    const args = id === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'];
    this.child = spawn(cliBin(id), args, { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv() });
    const take = (d: Buffer) => {
      for (const l of String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) if (l.trim()) this.lines.push(l.trim());
      if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
    };
    this.child.stdout?.on('data', take);
    this.child.stderr?.on('data', take);
    this.child.on('error', (e) => (this.lines.push(String(e.message)), (this.done = true)));
    this.child.on('close', (code) => ((this.done = true), (this.ok = code === 0)));
    setTimeout(() => !this.done && this.child.kill(), 10 * 60 * 1000).unref?.();
  }

  /** Send a line (e.g. a code the sign-in page shows) to the CLI. */
  write(line: string): void {
    this.child.stdin?.write(`${line}\n`);
  }

  cancel(): void {
    this.child.kill();
  }

  get urls(): string[] {
    return [...new Set(this.lines.flatMap((l) => l.match(/https?:\/\/\S+/g) ?? []))];
  }
}

const READ_ONLY_HINT = 'This conversation is in Ask mode: you can read the project but not change it. If the user asks for a change, describe it and tell them to switch the Agent tab to Agent mode.';

function systemPrompt(mode: AgentMode): string {
  return `${AGENT_SYSTEM}\n\nYou work through the "hassassin" tools only; they are already bound to the project the user has open, so never pass a project argument. Publish multi-step plans with hassassin update_tasks.${mode === 'ask' ? `\n\n${READ_ONLY_HINT}` : ''}`;
}

const toolName = (n: string) => n.replace(/^mcp__hassassin__/, '');

/** One conversation with a CLI agent (each message is one CLI run, resuming the previous one). */
export class CliAgentSession {
  readonly cli: CliId;
  mode: AgentMode = 'agent';
  tasks: AgentTask[] = [];
  private link: string;
  private viewLink: string;
  private workDir: string;
  private sessionId: string | null = null;
  private child: ChildProcess | null = null;
  private agentName: string;

  private bin: string;

  constructor(opts: { cli: CliId; editLink: string; viewLink: string; workDir: string; agentName: string; bin?: string }) {
    this.cli = opts.cli;
    this.bin = opts.bin ?? cliBin(opts.cli);
    this.link = opts.editLink;
    this.viewLink = opts.viewLink;
    this.workDir = opts.workDir;
    this.agentName = opts.agentName;
  }

  get running(): boolean {
    return !!this.child;
  }

  private mcpEnv(): Record<string, string> {
    return {
      HASSASSIN_PROJECT: this.mode === 'agent' ? this.link : this.viewLink,
      ...(this.mode === 'ask' ? { HASSASSIN_MCP_READONLY: '1' } : {}),
      HASSASSIN_AGENT_NAME: this.agentName,
    };
  }

  private args(prompt: string): string[] {
    const env = this.mcpEnv();
    if (this.cli === 'claude') {
      const mcp = { mcpServers: { hassassin: { command: process.execPath, args: [MCP_BIN, 'mcp'], env } } };
      return [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
        '--tools', '',
        '--allowedTools', 'mcp__hassassin',
        '--permission-mode', 'dontAsk',
        '--append-system-prompt', systemPrompt(this.mode),
        ...(this.sessionId ? ['--resume', this.sessionId] : []),
      ];
    }
    const toml = (s: string) => JSON.stringify(s);
    const envToml = `{${Object.entries(env).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}`;
    // Replace the user's own MCP servers for this run: only Hassassin is offered.
    const servers = `mcp_servers={hassassin={command=${toml(process.execPath)},args=[${toml(MCP_BIN)},"mcp"],env=${envToml}}}`;
    const common = ['--json', '--skip-git-repo-check', '-s', 'read-only', '-c', 'approval_policy="never"', '-c', servers];
    // Codex has no separate system prompt flag here: the instructions lead the first message,
    // and the mode is restated on each later one.
    const text = this.sessionId ? `${this.mode === 'ask' ? `(${READ_ONLY_HINT})\n\n` : '(Agent mode: you may change the project.)\n\n'}${prompt}` : `<instructions>\n${systemPrompt(this.mode)}\n</instructions>\n\n${prompt}`;
    return this.sessionId ? ['exec', 'resume', ...common, this.sessionId, text] : ['exec', ...common, text];
  }

  async send(prompt: string, emit: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.child) throw new Error('The agent is still working on the previous message.');
    await mkdir(this.workDir, { recursive: true });
    // Run on the signed-in subscription, not on API keys this server may have.
    const child = spawn(this.bin, this.args(prompt), { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
    this.child = child;
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop);
    const errLines: string[] = [];
    const names = new Map<string, string>();
    let buf = '';
    let finished = false;

    const onEvent = (e: Record<string, unknown>) => {
      if (this.cli === 'claude') {
        if (e.type === 'system' && typeof e.session_id === 'string') this.sessionId = e.session_id;
        const msg = e.message as { content?: Record<string, unknown>[] } | undefined;
        if (e.type === 'assistant') {
          for (const b of msg?.content ?? []) {
            if (b.type === 'text' && typeof b.text === 'string') emit({ type: 'text', text: b.text });
            else if (b.type === 'tool_use') this.tool(String(b.id), String(b.name), b.input, emit, names);
          }
        } else if (e.type === 'user') {
          for (const b of msg?.content ?? []) if (b.type === 'tool_result') this.result(String(b.tool_use_id), !b.is_error, b.content, emit, names);
        } else if (e.type === 'result') {
          finished = true;
          const u = e.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;
          if (u) emit({ type: 'usage', input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 });
          if (e.is_error) emit({ type: 'error', message: String(e.result ?? e.subtype ?? 'The agent stopped with an error.') });
          else emit({ type: 'done', reason: String(e.subtype ?? 'end_turn') });
        }
        return;
      }
      // Codex
      if (e.type === 'thread.started' && typeof e.thread_id === 'string') this.sessionId = e.thread_id;
      const item = e.item as Record<string, unknown> | undefined;
      if (item?.type === 'mcp_tool_call') {
        if (e.type === 'item.started') this.tool(String(item.id), String(item.tool), item.arguments, emit, names);
        else if (e.type === 'item.completed') {
          const r = item.result as { content?: { text?: string }[] } | null;
          this.result(String(item.id), !item.error && item.status !== 'failed', item.error ? String((item.error as { message?: string }).message ?? item.error) : r?.content?.map((c) => c.text ?? '').join('') ?? '', emit, names);
        }
      } else if (item?.type === 'agent_message' && e.type === 'item.completed' && typeof item.text === 'string') emit({ type: 'text', text: `${item.text}\n` });
      else if (item?.type === 'reasoning' && e.type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) emit({ type: 'note', text: item.text.trim() });
      else if (item?.type === 'error' && typeof item.message === 'string') errLines.push(item.message);
      else if (e.type === 'turn.completed') {
        finished = true;
        const u = e.usage as { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined;
        if (u) emit({ type: 'usage', input: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), output: u.output_tokens ?? 0, cacheRead: u.cached_input_tokens ?? 0 });
        emit({ type: 'done', reason: 'end_turn' });
      } else if (e.type === 'turn.failed' || e.type === 'error') {
        finished = true;
        emit({ type: 'error', message: String((e.error as { message?: string } | undefined)?.message ?? e.message ?? 'The agent stopped with an error.') });
      }
    };

    child.stdout?.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
          /* not an event line */
        }
      }
    });
    child.stderr?.on('data', (d) => {
      for (const l of String(d).split('\n')) if (l.trim() && !/rmcp::transport|Reading additional input/.test(l)) errLines.push(l.trim());
      if (errLines.length > 30) errLines.splice(0, errLines.length - 30);
    });
    const code: number | null = await new Promise((r) => {
      child.on('error', (e) => (errLines.push(e.message), r(-1)));
      child.on('close', (c) => r(c));
    });
    signal?.removeEventListener('abort', stop);
    this.child = null;
    if (signal?.aborted) return emit({ type: 'done', reason: 'stopped' });
    if (!finished) {
      const hint = errLines.slice(-3).join(' · ');
      emit({ type: 'error', message: code === 0 ? 'The agent finished without an answer.' : `${CLI_LABEL[this.cli]} stopped (exit ${code})${hint ? `: ${hint}` : ''}. Is it signed in?` });
    }
  }

  private tool(id: string, name: string, input: unknown, emit: (e: AgentEvent) => void, names: Map<string, string>) {
    const n = toolName(name);
    names.set(id, n);
    if (n === 'update_tasks') {
      const list = (input as { tasks?: AgentTask[] } | undefined)?.tasks;
      if (Array.isArray(list)) {
        this.tasks = list.map((t) => ({ title: String(t.title), status: (['todo', 'doing', 'done', 'blocked'].includes(t.status) ? t.status : 'todo') as AgentTask['status'], ...(t.stage ? { stage: String(t.stage) } : {}) }));
        emit({ type: 'tasks', tasks: this.tasks });
      }
    }
    emit({ type: 'tool', id, name: n, input });
  }

  private result(id: string, ok: boolean, content: unknown, emit: (e: AgentEvent) => void, names: Map<string, string>) {
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('') : JSON.stringify(content ?? '');
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON */
    }
    emit({ type: 'tool_result', id, name: names.get(id) ?? '', ok, summary: ok ? summarize(text) : text.slice(0, 200), detail: pretty.length > 6000 ? `${pretty.slice(0, 6000)}…` : pretty });
  }
}

function summarize(text: string): string {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return `${v.length} result(s)`;
    if (v && typeof v === 'object') {
      if ('errors' in v) return `${v.errors} error(s)${'warnings' in v ? `, ${v.warnings} warning(s)` : ''}`;
      if (typeof v.ref === 'string') return v.ref;
      if (typeof v.total === 'number') return `${v.total} match(es)`;
    }
  } catch {
    /* plain text */
  }
  return 'ok';
}
