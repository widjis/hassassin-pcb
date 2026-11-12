/**
 * Agent panel: chat with the AI design assistant, laid out like a chat app: your messages
 * as bubbles, replies as formatted text (Markdown), tool steps folded into one expandable
 * row per run, a task card, and a composer that grows as you type.
 *
 * The agent runs on the collaboration server (Claude Code / Codex on your subscription, or
 * the Claude API) and joins the shared project as a collaborator, so its edits are live,
 * undoable and in the history. The conversation is kept per project in this browser.
 */
import { computeGates } from '@hassassin/tools';
import type { App } from '../app.ts';
import type { Collab } from '../collab.ts';
import { clear, h } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { toggleRight, toggleWideLeft } from './resize.ts';

interface Step {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
  summary?: string;
  detail?: string;
}

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'steps'; steps: Step[] }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

interface Task {
  title: string;
  status: string;
  stage?: string;
}

interface Cli {
  id: 'claude' | 'codex';
  label: string;
  installed: boolean;
  loggedIn: boolean;
  detail: string;
}

type Backend = 'api' | 'claude' | 'codex';

const STAGE_PROMPTS: Record<string, string> = {
  requirements: 'Help me complete the requirements: ask me what is missing, one question at a time, and record my answers.',
  schematic: 'Review the schematic and fix the ERC errors. Explain anything you are unsure about before changing it.',
  components: 'Go through the parts: give every part a real footprint and tell me which ones still need a manufacturer part number. Do not invent MPNs.',
  layout: 'Look at the board: what is still unrouted or failing DRC, and what would you fix first?',
  review: 'Review this design for problems: decoupling, current capacity, thermal, ESD protection, and manufacturability. List findings by severity.',
  fabrication: 'Is this design ready to order? Check every stage and tell me what is left.',
};

const STEP_LABEL: Record<string, string> = {
  project_status: 'Read project status',
  query: 'Search objects',
  inspect: 'Inspect',
  list_parts: 'List parts',
  netlist: 'Read netlist',
  run_erc: 'Run ERC',
  run_drc: 'Run DRC',
  list_rules: 'Read rules',
  set_rule: 'Set rule',
  set_property: 'Set property',
  set_spec: 'Update requirements',
  add_part: 'Add part',
  place_part: 'Place part',
  connect_pins: 'Wire pins',
  add_label: 'Add net label',
  update_pcb: 'Update PCB from schematic',
  move_part: 'Move part',
  route: 'Route',
  autoroute: 'Autoroute',
  auto_place: 'Auto-place',
  refill_pours: 'Refill pours',
  search_parts: 'Search library',
  get_part: 'Read part',
  search_footprints: 'Search footprints',
  assign_footprint: 'Assign footprint',
  set_part_info: 'Set part info',
  bom: 'Price BOM',
  net_lengths: 'Measure lengths',
  tune_length: 'Tune length',
  impedance: 'Impedance',
  get_stackup: 'Read stackup',
  set_stackup: 'Set stackup',
  undo: 'Undo',
  redo: 'Redo',
  update_tasks: 'Update tasks',
};
const stepLabel = (n: string) => STEP_LABEL[n] ?? n.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Short argument hint shown next to a step ("R1 → chip-0805"). */
function argHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const vals = ['ref', 'target', 'selector', 'id', 'query', 'kind', 'from', 'to', 'net', 'footprint', 'pin', 'name']
    .map((k) => o[k])
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .slice(0, 2)
    .map(String);
  return vals.join(' → ').slice(0, 60);
}

const store = {
  key: (p: string) => `hassassin:agent:chat:${p}`,
  load(p: string): { items: Item[]; chat: string | null; tasks: Task[]; backend?: Backend } | null {
    try {
      return JSON.parse(localStorage.getItem(this.key(p)) ?? 'null');
    } catch {
      return null;
    }
  },
  save(p: string, v: { items: Item[]; chat: string | null; tasks: Task[]; backend: Backend }) {
    try {
      localStorage.setItem(this.key(p), JSON.stringify({ ...v, items: v.items.slice(-200) }));
    } catch {
      /* full or blocked */
    }
  },
};

export function mountAgent(app: App, collab: Collab, root: HTMLElement, onShare: () => void): void {
  let items: Item[] = [];
  let tasks: Task[] = [];
  let chat: string | null = null;
  let mode: 'agent' | 'ask' = 'agent';
  let busy = false;
  let status: { available: boolean; clis: Cli[] } | null = null;
  let backend: Backend = 'claude';
  let loadedFor = '';
  let tasksOpen = true;
  /** Agent conversations started by other people on this project (mirrored by the server). */
  interface Watched {
    chat: string;
    by: string;
    backend: string;
    items: Item[];
    tasks: Task[];
    running: boolean;
    agentItem: Extract<Item, { kind: 'agent' }> | null;
    stepsItem: Extract<Item, { kind: 'steps' }> | null;
  }
  const watched = new Map<string, Watched>();
  let viewing: string | null = null; // a watched chat id, or null for my own conversation
  const curItems = () => (viewing ? (watched.get(viewing)?.items ?? []) : items);
  const curTasks = () => (viewing ? (watched.get(viewing)?.tasks ?? []) : tasks);
  const curBusy = () => (viewing ? !!watched.get(viewing)?.running : busy);
  try {
    backend = (localStorage.getItem('hassassin:agent:backend') as Backend) ?? 'claude';
  } catch {
    /* storage blocked */
  }
  let loginTimer = 0;
  let usage = { input: 0, output: 0, cacheRead: 0 };

  root.classList.add('agent-panel');
  const header = h('div', { class: 'agent-head' });
  const loginBox = h('div', { class: 'agent-login' });
  const taskBox = h('div', { class: 'agent-tasks' });
  const log = h('div', { class: 'agent-log' });
  const input = h('textarea', { rows: '1', placeholder: 'Ask about the design, or tell the agent what to do…' });
  const sendBtn = h('button', { class: 'send', title: 'Send (Enter) · new line: Shift+Enter' }, '↑');
  const stopBtn = h('button', { class: 'stop', title: 'Stop' }, '■');
  const hintRow = h('div', { class: 'agent-hints' });
  const composer = h('div', { class: 'agent-composer' }, input, h('div', { class: 'composer-actions' }, stopBtn, sendBtn));
  const bottom = h('div', { class: 'agent-bottom' }, hintRow, composer);
  let renderSeq = 0;
  const nodes = new Map<Item, HTMLElement>();
  let stickToBottom = true;
  log.addEventListener('scroll', () => (stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40));

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  };
  input.addEventListener('input', autoGrow);

  const persist = () => collab.session && store.save(collab.session.id, { items, chat, tasks, backend });

  // ---------------------------------------------------------------- rendering
  const renderItem = (it: Item): HTMLElement => {
    if (it.kind === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, it.text));
    if (it.kind === 'error') return h('div', { class: 'msg error' }, it.text);
    if (it.kind === 'note') {
      const d = h('details', { class: 'msg note' }, h('summary', {}, 'Thinking'), h('div', { class: 'note-body' }, it.text));
      return d;
    }
    if (it.kind === 'agent') {
      const body = h('div', { class: 'md' });
      body.append(renderMarkdown(it.text));
      const copy = h('button', { class: 'msg-copy', title: 'Copy reply' }, 'Copy');
      copy.addEventListener('click', () => void navigator.clipboard?.writeText(it.text).then(() => ((copy.textContent = 'Copied'), setTimeout(() => (copy.textContent = 'Copy'), 1200))));
      return h('div', { class: 'msg agent' }, body, h('div', { class: 'msg-tools' }, copy));
    }
    // Steps: one foldable row per run of tool calls.
    const visible = it.steps.filter((s) => s.name !== 'update_tasks');
    const running = visible.some((s) => s.ok === undefined);
    const failed = visible.filter((s) => s.ok === false).length;
    const last = visible[visible.length - 1];
    const title = visible.length === 1 && last ? `${stepLabel(last.name)}${argHint(last.input) ? ` · ${argHint(last.input)}` : ''}` : `${visible.length} steps${last ? ` · ${stepLabel(last.name)}` : ''}`;
    const d = h('details', { class: `steps${running ? ' running' : ''}${failed ? ' failed' : ''}` });
    d.append(h('summary', {}, h('span', { class: 'steps-icon' }, running ? '◌' : failed ? '!' : '✓'), h('span', { class: 'steps-title' }, title), failed ? h('span', { class: 'steps-fail' }, `${failed} failed`) : null));
    for (const s of visible) {
      const row = h('details', { class: `step${s.ok === false ? ' bad' : s.ok ? ' good' : ''}` });
      row.append(h('summary', {}, h('span', { class: 'step-name' }, stepLabel(s.name)), h('span', { class: 'step-hint' }, argHint(s.input)), h('span', { class: 'step-sum' }, s.ok === undefined ? '…' : (s.summary ?? ''))));
      row.append(h('div', { class: 'step-label' }, 'Input'), h('pre', {}, JSON.stringify(s.input ?? {}, null, 2)));
      if (s.detail !== undefined) row.append(h('div', { class: 'step-label' }, s.ok === false ? 'Error' : 'Result'), h('pre', {}, s.detail));
      d.append(row);
    }
    return d;
  };

  const updateItem = (it: Item) => {
    const old = nodes.get(it);
    const open = old instanceof HTMLDetailsElement ? old.open : false;
    const openRows = old ? [...old.querySelectorAll<HTMLDetailsElement>('details.step')].map((x) => x.open) : [];
    const fresh = renderItem(it);
    if (fresh instanceof HTMLDetailsElement && open) fresh.open = true;
    fresh.querySelectorAll<HTMLDetailsElement>('details.step').forEach((x, k) => (x.open = !!openRows[k]));
    if (old) old.replaceWith(fresh);
    else log.insertBefore(fresh, typing);
    nodes.set(it, fresh);
    if (stickToBottom) log.scrollTop = log.scrollHeight;
  };

  const typing = h('div', { class: 'typing' }, h('span', {}), h('span', {}), h('span', {}));
  const drawLog = () => {
    clear(log);
    nodes.clear();
    const w = viewing ? watched.get(viewing) : null;
    if (w) {
      log.append(
        h(
          'div',
          { class: 'watch-banner' },
          h('span', { class: `live-dot ${w.running ? 'online' : 'offline'}` }),
          h('span', {}, `${w.by}'s agent · ${w.backend === 'claude' ? 'Claude Code' : w.backend === 'codex' ? 'Codex' : 'Claude API'}${w.running ? ' · working' : ''}`),
          h('button', { class: 'link', onclick: () => ((viewing = null), drawLog(), drawTasks()) }, 'My chat'),
        ),
      );
    } else if (watched.size) {
      const others = [...watched.values()];
      log.append(h('div', { class: 'watch-list' }, ...others.map((o) => h('button', { class: 'link', onclick: () => ((viewing = o.chat), drawLog(), drawTasks()) }, `${o.running ? '● ' : ''}Watch ${o.by}'s agent`))));
    }
    const items = curItems();
    if (!items.length && !w) {
      log.append(
        h(
          'div',
          { class: 'agent-empty' },
          h('div', { class: 'agent-empty-title' }, 'What should we work on?'),
          h('div', { class: 'dim' }, 'The agent can read the whole project and, in Agent mode, edit it. Every change is live and undoable.'),
        ),
      );
    }
    log.append(typing);
    for (const it of items) updateItem(it);
    typing.style.display = curBusy() ? '' : 'none';
    log.scrollTop = log.scrollHeight;
  };

  const drawTasks = () => {
    clear(taskBox);
    const tasks = curTasks();
    if (!tasks.length) return;
    const done = tasks.filter((t) => t.status === 'done').length;
    const head = h('button', { class: 'tasks-head', onclick: () => ((tasksOpen = !tasksOpen), drawTasks()) }, h('span', {}, tasksOpen ? '▾' : '▸'), h('span', {}, 'Tasks'), h('span', { class: 'dim' }, `${done}/${tasks.length}`), h('span', { class: 'tasks-bar' }, h('span', { style: `width:${(done / tasks.length) * 100}%` })));
    taskBox.append(head);
    if (tasksOpen) for (const t of tasks) taskBox.append(h('div', { class: `agent-task ${t.status}` }, h('span', { class: 'tick' }, t.status === 'done' ? '✓' : t.status === 'doing' ? '' : t.status === 'blocked' ? '!' : ''), h('span', {}, t.title)));
  };

  const drawHints = () => {
    clear(hintRow);
    if (app.doc && !busy) {
      const gates = computeGates({ doc: app.doc, erc: app.erc, drc: app.drc, ratsnest: app.ratsnest });
      const next = gates.find((g) => g.state === 'todo');
      const id = next?.id ?? 'fabrication';
      hintRow.append(h('button', { class: 'chip', title: STAGE_PROMPTS[id], onclick: () => ((input.value = STAGE_PROMPTS[id] ?? ''), autoGrow(), input.focus()) }, `✦ ${next ? `Next: ${next.title.replace(/^\d+ · /, '')}` : 'Ready to order?'}`));
    }
    if (usage.input || usage.output) hintRow.append(h('span', { class: 'usage', title: `${usage.input + usage.cacheRead} input tokens (${usage.cacheRead} cached), ${usage.output} output tokens` }, `${Math.round((usage.input + usage.cacheRead) / 1000)}k in · ${usage.output} out${backend === 'api' ? '' : ' · subscription'}`));
  };

  const setBusy = (b: boolean) => {
    busy = b;
    typing.style.display = b ? '' : 'none';
    sendBtn.style.display = b ? 'none' : '';
    stopBtn.style.display = b ? '' : 'none';
    drawHints();
  };

  // ---------------------------------------------------------------- backend & sign-in
  const loadStatus = async () => {
    status = await fetch('/api/agent/status').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  };

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
        drawHeader();
      }
    }, 1500);
  };

  const options = () => {
    const clis = status?.clis ?? [];
    return [
      ...clis.map((c) => ({ id: c.id as Backend, label: c.id === 'claude' ? 'Claude Code' : 'Codex', sub: c.id === 'claude' ? 'Claude subscription' : 'ChatGPT subscription', ready: c.installed && c.loggedIn, note: c.installed ? c.detail : 'not installed', installed: c.installed })),
      { id: 'api' as Backend, label: 'Claude API', sub: 'pay per use', ready: !!status?.available, note: status?.available ? 'API key set on the server' : 'no API key on the server', installed: true },
    ];
  };

  const drawHeader = () => {
    clear(header);
    const opts = options();
    if (!opts.some((o) => o.id === backend)) backend = opts[0]!.id;
    const cur = opts.find((o) => o.id === backend)!;
    const pick = h('select', { class: 'backend', title: 'Which AI does the work' });
    for (const o of opts) pick.append(h('option', { value: o.id, ...(o.id === backend ? { selected: true } : {}) }, `${o.label} — ${o.sub}${o.ready ? '' : ' (not ready)'}`));
    pick.addEventListener('change', () => {
      backend = pick.value as Backend;
      chat = null;
      try {
        localStorage.setItem('hassassin:agent:backend', backend);
      } catch {
        /* ignore */
      }
      drawHeader();
      persist();
    });
    const modeSeg = h('div', { class: 'seg mode' });
    for (const [m, label, tip] of [['agent', 'Agent', 'Can edit the project'], ['ask', 'Ask', 'Read-only answers']] as const) {
      modeSeg.append(h('button', { class: mode === m ? 'on' : '', title: tip, onclick: () => ((mode = m), drawHeader()) }, label));
    }
    const menu = h(
      'div',
      { class: 'head-actions' },
      h('button', { title: 'New chat', onclick: () => ((chat = null), (items = []), (tasks = []), (usage = { input: 0, output: 0, cacheRead: 0 }), persist(), drawLog(), drawTasks(), drawHints()) }, '＋'),
      h('button', { title: 'Wider panel for the chat (toggle)', onclick: () => toggleWideLeft() }, '⇔'),
      h('button', { title: 'Hide / show the inspector on the right', onclick: () => toggleRight() }, '◨'),
    );
    const state = h('div', { class: 'agent-backend' }, h('span', { class: `live-dot ${cur.ready ? 'online' : 'offline'}` }), h('span', { class: 'dim ellipsis' }, cur.note));
    if (!cur.ready && backend !== 'api' && cur.installed) state.append(h('button', { class: 'btn primary', onclick: () => void signIn(backend as Cli['id']) }, 'Sign in'));
    if (cur.ready && backend !== 'api') state.append(h('button', { class: 'link', title: 'Sign in with another account', onclick: () => void signIn(backend as Cli['id']) }, 'Switch account'));
    header.append(h('div', { class: 'head-row' }, pick, menu), h('div', { class: 'head-row' }, modeSeg, state));
    sendBtn.disabled = !cur.ready;
    input.placeholder = cur.ready ? (mode === 'ask' ? 'Ask about the design (read-only)…' : 'Ask about the design, or tell the agent what to do…') : 'Choose an AI above and sign in first';
  };

  const render = async () => {
    const seq = ++renderSeq;
    if (!status) await loadStatus();
    if (seq !== renderSeq) return; // a newer render started while this one waited
    clear(root);
    if (!app.collab || !collab.session) {
      root.append(
        h(
          'div',
          { class: 'agent-intro' },
          h('div', { class: 'agent-intro-title' }, 'AI agent'),
          h('p', {}, 'Describe what to build or ask about the design. The agent works as a collaborator on a shared project, so every edit is live and undoable.'),
          app.doc
            ? h('button', { class: 'btn primary', onclick: onShare }, 'Share project to start')
            : h('p', { class: 'dim' }, 'Open or create a project first (File menu).'),
        ),
      );
      return;
    }
    if (!status) {
      root.append(h('div', { class: 'empty' }, 'The collaboration server is not reachable (pnpm run server).'));
      return;
    }
    if (loadedFor !== collab.session.id) {
      loadedFor = collab.session.id;
      const saved = store.load(loadedFor);
      items = saved?.items ?? [];
      tasks = saved?.tasks ?? [];
      chat = saved?.chat ?? null;
      if (saved?.backend) backend = saved.backend;
    }
    root.append(header, loginBox, taskBox, log, bottom);
    drawHeader();
    drawTasks();
    drawLog();
    setBusy(busy);
  };

  // ---------------------------------------------------------------- sending
  const send = async () => {
    const prompt = input.value.trim();
    if (!prompt || busy || !collab.session || sendBtn.disabled) return;
    if (viewing) {
      viewing = null;
      drawLog();
      drawTasks();
    }
    input.value = '';
    autoGrow();
    if (!items.length) clear(log), log.append(typing);
    const user: Item = { kind: 'user', text: prompt };
    items.push(user);
    updateItem(user);
    stickToBottom = true;
    setBusy(true);
    let agentItem: Extract<Item, { kind: 'agent' }> | null = null;
    let stepsItem: Extract<Item, { kind: 'steps' }> | null = null;
    const push = (it: Item) => (items.push(it), updateItem(it));
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
            stepsItem = null;
            if (!agentItem) push((agentItem = { kind: 'agent', text: '' }));
            agentItem.text += e.text;
            updateItem(agentItem);
          } else if (e.type === 'note') {
            push({ kind: 'note', text: e.text });
          } else if (e.type === 'tool') {
            agentItem = null;
            if (!stepsItem) push((stepsItem = { kind: 'steps', steps: [] }));
            stepsItem.steps.push({ id: e.id, name: e.name, input: e.input });
            updateItem(stepsItem);
          } else if (e.type === 'tool_result') {
            const owner = [...items].reverse().find((x): x is Extract<Item, { kind: 'steps' }> => x.kind === 'steps' && x.steps.some((s) => s.id === e.id));
            const s = owner?.steps.find((x) => x.id === e.id);
            if (s && owner) {
              s.ok = e.ok;
              s.summary = e.summary;
              if (e.detail !== undefined) s.detail = e.detail;
              updateItem(owner);
            }
          } else if (e.type === 'tasks') {
            tasks = e.tasks;
            drawTasks();
          } else if (e.type === 'usage') {
            usage.input += e.input;
            usage.output += e.output;
            usage.cacheRead += e.cacheRead;
          } else if (e.type === 'error') push({ kind: 'error', text: e.message });
        }
      }
    } catch (e) {
      push({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
      persist();
    }
  };
  sendBtn.addEventListener('click', () => void send());
  stopBtn.addEventListener('click', () => collab.session && chat && fetch(`/api/agent/${collab.session.id}/stop?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', body: JSON.stringify({ chat }) }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  /** Fold one mirrored event into a watched conversation. */
  const applyWatched = (w: Watched, e: Record<string, unknown>) => {
    const show = viewing === w.chat;
    const push = (it: Item) => (w.items.push(it), show && updateItem(it));
    const t = e.type;
    if (t === 'user') {
      w.agentItem = null;
      w.stepsItem = null;
      push({ kind: 'user', text: `${String(e.by ?? w.by)}: ${String(e.text ?? '')}` });
    } else if (t === 'start') w.running = true;
    else if (t === 'end' || t === 'done') w.running = false;
    else if (t === 'text') {
      w.stepsItem = null;
      if (!w.agentItem) push((w.agentItem = { kind: 'agent', text: '' }));
      w.agentItem.text += String(e.text ?? '');
      if (show) updateItem(w.agentItem);
    } else if (t === 'note') push({ kind: 'note', text: String(e.text ?? '') });
    else if (t === 'tool') {
      w.agentItem = null;
      if (!w.stepsItem) push((w.stepsItem = { kind: 'steps', steps: [] }));
      w.stepsItem.steps.push({ id: String(e.id), name: String(e.name), input: e.input });
      if (show) updateItem(w.stepsItem);
    } else if (t === 'tool_result') {
      const owner = [...w.items].reverse().find((x): x is Extract<Item, { kind: 'steps' }> => x.kind === 'steps' && x.steps.some((st) => st.id === e.id));
      const st = owner?.steps.find((x) => x.id === e.id);
      if (st && owner) {
        st.ok = !!e.ok;
        st.summary = String(e.summary ?? '');
        if (e.detail !== undefined) st.detail = String(e.detail);
        if (show) updateItem(owner);
      }
    } else if (t === 'tasks') {
      w.tasks = (e.tasks as Task[]) ?? [];
      if (show) drawTasks();
    } else if (t === 'error') push({ kind: 'error', text: String(e.message ?? '') });
    if (show) typing.style.display = w.running ? '' : 'none';
  };

  const watch = (chatId: string, by: string, backendName: string) => {
    let w = watched.get(chatId);
    if (!w) {
      w = { chat: chatId, by, backend: backendName, items: [], tasks: [], running: false, agentItem: null, stepsItem: null };
      watched.set(chatId, w);
    }
    return w;
  };

  let unsubscribe: (() => void) | null = null;
  const listen = () => {
    unsubscribe?.();
    unsubscribe = null;
    const c = app.collab;
    if (!c) return;
    unsubscribe = c.on('agent', ({ chat: id, by, backend: b, event }) => {
      if (id === chat && busy) return; // my own conversation arrives on my request stream
      const fresh = !watched.has(id);
      const w = watch(id, by, b);
      applyWatched(w, event);
      // Follow someone else's agent automatically when I am not in my own conversation.
      if (fresh && !busy && !items.length) {
        viewing = id;
        drawLog();
        drawTasks();
      } else if (fresh && !viewing) drawLog();
    });
  };

  /** Conversations already under way when the project was opened. */
  const loadTranscripts = async () => {
    if (!collab.session) return;
    const list = await fetch(`/api/agent/${collab.session.id}/chats?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    for (const c of list as { chat: string; by: string; backend: string; running: boolean; events: Record<string, unknown>[] }[]) {
      if (c.chat === chat) continue;
      watched.delete(c.chat);
      const w = watch(c.chat, c.by, c.backend);
      for (const e of c.events) applyWatched(w, e);
      w.running = c.running;
    }
    const live = [...watched.values()].reverse().find((w) => w.running);
    if (live && !items.length) viewing = live.chat;
    drawLog();
    drawTasks();
  };

  app.on('collab', () => {
    listen();
    void render().then(loadTranscripts);
  });
  app.on('drc', drawHints);
  // The intro's button depends on whether a project is open.
  app.on('doc', () => {
    if (!app.collab) void render();
  });
  listen();
  void render().then(loadTranscripts);
}
