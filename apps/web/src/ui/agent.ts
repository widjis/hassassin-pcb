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
  let available: boolean | null = null;
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
    footer.textContent = usage.input ? `This chat: ${usage.input + usage.cacheRead} input tokens (${usage.cacheRead} cached), ${usage.output} output tokens` : '';
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

  const render = async () => {
    clear(root);
    if (available === null) {
      const s = await fetch('/api/agent/status').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      available = !!s?.available;
      if (!s) available = null;
    }
    if (!app.collab || !collab.session) {
      root.append(h('div', { class: 'empty' }, 'The AI agent works on shared projects: it joins as a collaborator so its edits are live and undoable. Click Share in the top bar first.'));
      return;
    }
    if (available === false) {
      root.append(h('div', { class: 'empty' }, 'The agent is not configured on the server. Set ANTHROPIC_API_KEY (or run `ant auth login`) where the server runs, then restart it (pnpm run server).'));
      return;
    }
    root.append(h('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' }, modeSel, h('button', { onclick: () => ((chat = null), (lines.length = 0), (tasks = []), (usage = { input: 0, output: 0, cacheRead: 0 }), draw()) }, 'New chat')), taskBox, log, suggest, input, h('div', { style: 'display:flex;gap:6px;margin-top:6px' }, sendBtn, stopBtn), footer);
    drawSuggest();
    draw();
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
        body: JSON.stringify({ prompt, chat, mode, user: { name: collab.user.name } }),
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
