/**
 * Agent panel: chat with the AI design assistant. The agent runs on the collaboration
 * server (the API key stays there) and joins the shared project as a collaborator, so its
 * edits arrive like anyone else's: live, undoable, in the history.
 */
import { computeGates } from '@hassassin/tools';
import type { App } from '../app.ts';
import type { Collab } from '../collab.ts';
import { clear, h } from './dom.ts';

interface Line {
  kind: 'user' | 'agent' | 'tool' | 'note' | 'error';
  text: string;
  ok?: boolean;
}

interface Task {
  title: string;
  status: string;
  stage?: string;
}

const STAGE_PROMPTS: Record<string, string> = {
  requirements: 'Help me complete the requirements: ask me what is missing, one question at a time, and record my answers.',
  schematic: 'Review the schematic and fix the ERC errors. Explain anything you are unsure about before changing it.',
  components: 'Go through the parts: give every part a real footprint and tell me which ones still need a manufacturer part number. Do not invent MPNs.',
  layout: 'Look at the board: what is still unrouted or failing DRC, and what would you fix first?',
  review: 'Review this design for problems: decoupling, current capacity, thermal, ESD protection, and manufacturability. List findings by severity.',
  fabrication: 'Is this design ready to order? Check every stage and tell me what is left.',
};

export function mountAgent(app: App, collab: Collab, root: HTMLElement): void {
  const lines: Line[] = [];
  let tasks: Task[] = [];
  let chat: string | null = null;
  let mode: 'agent' | 'ask' = 'agent';
  let busy = false;
  interface Cli {
    id: 'claude' | 'codex';
    label: string;
    installed: boolean;
    loggedIn: boolean;
    detail: string;
  }
  let status: { available: boolean; clis: Cli[] } | null = null;
  let backend: 'api' | 'claude' | 'codex' = 'claude';
  try {
    backend = (localStorage.getItem('hassassin:agent:backend') as typeof backend) ?? 'claude';
  } catch {
    /* storage blocked */
  }
  const loginBox = h('div', { class: 'agent-login' });
  let loginTimer = 0;
  let usage = { input: 0, output: 0, cacheRead: 0 };

  const log = h('div', { class: 'agent-log' });
  const taskBox = h('div', { class: 'agent-tasks' });
  const input = h('textarea', { rows: '3', placeholder: 'Ask about the design, or tell the agent what to do…' });
  const sendBtn = h('button', { class: 'btn primary' }, 'Send');
  const stopBtn = h('button', { class: 'btn' }, 'Stop');
  const modeSel = h('select', { title: 'Agent: may edit the project. Ask: read-only answers.' }, h('option', { value: 'agent' }, 'Agent (can edit)'), h('option', { value: 'ask' }, 'Ask (read-only)'));
  const suggest = h('div', { class: 'agent-suggest' });
  const footer = h('div', { class: 'dim', style: 'font-size:10.5px' });
  modeSel.addEventListener('change', () => (mode = modeSel.value as 'agent' | 'ask'));

  const draw = () => {
    clear(log);
    for (const l of lines) {
      if (l.kind === 'tool') log.append(h('div', { class: `agent-tool ${l.ok === false ? 'bad' : l.ok ? 'good' : ''}` }, l.text));
      else if (l.kind === 'note') log.append(h('div', { class: 'agent-note' }, l.text));
      else log.append(h('div', { class: `agent-msg ${l.kind}` }, l.text));
    }
    if (busy) log.append(h('div', { class: 'agent-note' }, 'Working…'));
    log.scrollTop = log.scrollHeight;
    clear(taskBox);
    if (tasks.length) {
      taskBox.append(h('div', { class: 'section-title' }, h('span', {}, 'Tasks')));
      for (const t of tasks) taskBox.append(h('div', { class: `agent-task ${t.status}` }, h('span', {}, t.status === 'done' ? '✓' : t.status === 'doing' ? '▸' : t.status === 'blocked' ? '!' : '○'), t.title));
    }
    sendBtn.disabled = busy;
    stopBtn.style.display = busy ? '' : 'none';
    footer.textContent = usage.input || usage.output ? `This chat: ${usage.input + usage.cacheRead} input tokens (${usage.cacheRead} cached), ${usage.output} output tokens${backend === 'api' ? '' : ' · on your subscription'}` : '';
  };

  const drawSuggest = () => {
    clear(suggest);
    if (!app.doc) return;
    const gates = computeGates({ doc: app.doc, erc: app.erc, drc: app.drc, ratsnest: app.ratsnest });
    const next = gates.find((g) => g.state === 'todo');
    const id = next?.id ?? 'fabrication';
    suggest.append(
      h('span', { class: 'dim', style: 'font-size:11px' }, next ? `Next stage: ${next.title}` : 'All stages done'),
      h('button', { onclick: () => ((input.value = STAGE_PROMPTS[id] ?? ''), input.focus()) }, `Suggest: ${id}`),
    );
  };

  const loadStatus = async () => {
    status = await fetch('/api/agent/status').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  };

  /** Sign a CLI in: the server starts its sign-in, which opens the provider's page in the browser. */
  const signIn = async (cli: Cli['id']) => {
    clear(loginBox);
    loginBox.append(h('div', { class: 'dim' }, 'Starting sign-in… a browser page should open; finish signing in there.'));
    const r = await fetch('/api/agent/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cli }) });
    if (!r.ok) return void loginBox.append(h('div', { class: 'err-text' }, ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`));
    const code = h('input', { placeholder: 'Paste the code from the sign-in page (if it shows one)' });
    code.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !code.value.trim()) return;
      void fetch('/api/agent/login/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cli, line: code.value.trim() }) });
      code.value = '';
    });
    const out = h('div', { class: 'agent-login-out' });
    loginBox.append(out, code);
    clearInterval(loginTimer);
    loginTimer = window.setInterval(async () => {
      const j = await fetch(`/api/agent/login?cli=${cli}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (!j) return;
      clear(out);
      for (const u of j.urls as string[]) out.append(h('a', { href: u, target: '_blank', rel: 'noopener' }, 'Open the sign-in page ↗'));
      out.append(h('pre', {}, (j.lines as string[]).slice(-6).join('\n')));
      if (j.done) {
        clearInterval(loginTimer);
        await loadStatus();
        clear(loginBox);
        if (!j.ok) loginBox.append(h('div', { class: 'err-text' }, 'Sign-in did not finish. Try again.'));
        void render();
      }
    }, 1500);
  };

  const render = async () => {
    clear(root);
    if (!status) await loadStatus();
    if (!app.collab || !collab.session) {
      root.append(h('div', { class: 'empty' }, 'The AI agent works on shared projects: it joins as a collaborator so its edits are live and undoable. Click Share in the top bar first.'));
      return;
    }
    if (!status) {
      root.append(h('div', { class: 'empty' }, 'The collaboration server is not reachable (pnpm run server).'));
      return;
    }
    const clis = status.clis ?? [];
    const options: { id: typeof backend; label: string; ready: boolean; note: string }[] = [
      ...clis.map((c) => ({ id: c.id, label: c.label, ready: c.installed && c.loggedIn, note: c.installed ? c.detail : 'not installed' })),
      { id: 'api' as const, label: 'Claude API (credits)', ready: status.available, note: status.available ? 'API key set on the server' : 'no API key on the server' },
    ];
    if (!options.some((o) => o.id === backend)) backend = options[0]!.id;
    const pick = h('select', { title: 'Which AI does the work' });
    for (const o of options) pick.append(h('option', { value: o.id, ...(o.id === backend ? { selected: true } : {}) }, `${o.label}${o.ready ? '' : ' — not ready'}`));
    pick.addEventListener('change', () => {
      backend = pick.value as typeof backend;
      chat = null;
      try {
        localStorage.setItem('hassassin:agent:backend', backend);
      } catch {
        /* ignore */
      }
      void render();
    });
    const cur = options.find((o) => o.id === backend)!;
    const state = h('div', { class: 'agent-backend' }, h('span', { class: `live-dot ${cur.ready ? 'online' : 'offline'}` }), h('span', { class: 'dim' }, cur.note));
    if (!cur.ready && backend !== 'api' && clis.find((c) => c.id === backend)?.installed) state.append(h('button', { class: 'btn primary', onclick: () => void signIn(backend as Cli['id']) }, 'Sign in'));
    if (cur.ready && backend !== 'api') state.append(h('button', { title: 'Sign in with another account', onclick: () => void signIn(backend as Cli['id']) }, 'Switch account'));
    root.append(
      h('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:4px' }, pick),
      state,
      loginBox,
      h('div', { style: 'display:flex;gap:6px;align-items:center;margin:6px 0' }, modeSel, h('button', { onclick: () => ((chat = null), (lines.length = 0), (tasks = []), (usage = { input: 0, output: 0, cacheRead: 0 }), draw()) }, 'New chat')),
      taskBox,
      log,
      suggest,
      input,
      h('div', { style: 'display:flex;gap:6px;margin-top:6px' }, sendBtn, stopBtn),
      footer,
    );
    sendBtn.disabled = busy || !cur.ready;
    drawSuggest();
    draw();
    sendBtn.disabled = busy || !cur.ready;
  };

  const send = async () => {
    const prompt = input.value.trim();
    if (!prompt || busy || !collab.session) return;
    input.value = '';
    lines.push({ kind: 'user', text: prompt });
    busy = true;
    draw();
    let agentLine: Line | null = null;
    try {
      const r = await fetch(`/api/agent/${collab.session.id}?token=${encodeURIComponent(collab.session.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, chat, mode, backend, user: { name: collab.user.name } }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i).replace(/^data: /, '');
          buf = buf.slice(i + 2);
          const e = JSON.parse(raw);
          if (e.type === 'chat') chat = e.chat;
          else if (e.type === 'text') {
            if (!agentLine) lines.push((agentLine = { kind: 'agent', text: '' }));
            agentLine.text += e.text;
          } else if (e.type === 'note') lines.push({ kind: 'note', text: e.text });
          else if (e.type === 'tool') {
            agentLine = null;
            if (e.name !== 'update_tasks') lines.push({ kind: 'tool', text: `${e.name.replace(/_/g, ' ')} ${JSON.stringify(e.input).slice(0, 120)}` });
          } else if (e.type === 'tool_result') {
            const l = [...lines].reverse().find((x) => x.kind === 'tool' && x.ok === undefined);
            if (l) (l.ok = e.ok), (l.text += ` → ${e.summary}`);
          } else if (e.type === 'tasks') tasks = e.tasks;
          else if (e.type === 'usage') (usage.input += e.input), (usage.output += e.output), (usage.cacheRead += e.cacheRead);
          else if (e.type === 'error') lines.push({ kind: 'error', text: e.message });
          draw();
        }
      }
    } catch (e) {
      lines.push({ kind: 'error', text: (e as Error).message });
    } finally {
      busy = false;
      draw();
      drawSuggest();
    }
  };
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => collab.session && chat && fetch(`/api/agent/${collab.session.id}/stop?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', body: JSON.stringify({ chat }) }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  app.on('collab', () => void render());
  app.on('drc', drawSuggest);
  void render();
}
