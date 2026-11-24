/**
 * Agent panel: chat with the AI design assistant, laid out like a chat app: your messages
 * as bubbles, replies as formatted text (Markdown), tool steps folded into one expandable
 * row per run, a task card, and a composer that grows as you type.
 *
 * The agent runs on the collaboration server (Claude Code / Codex on your subscription, or
 * the Claude API) and joins the shared project as a collaborator, so its edits are live,
 * undoable and in the history. The conversation is kept per project in this browser.
 */
import { aiFlowOf, AUTONOMY_LABEL, computeGates, isGoAhead, limitsOf, nextStage, STAGE_TITLES, AI_STAGES, type AgentQuestion, type Autonomy } from '@hassassin/tools';
import type { App } from '../app.ts';
import type { Collab } from '../collab.ts';
import { clear, h } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { toggleLeft, toggleRight, toggleWideLeft } from './resize.ts';

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
  | { kind: 'error'; text: string }
  /** A change held by a gate (A13): ask / allowed / declined. */
  | { kind: 'gate'; id: string; summary: string; parts: string[]; nets: string[]; state: string; busy?: boolean; error?: string }
  /** What the agent decided on its own in a reply (A13). */
  | { kind: 'decisions'; items: { kind: string; what: string; reason?: string }[] }
  /** The agent asked for a plugin (A12): approve / settings / done / declined. */
  | { kind: 'plugin'; id: string; plugin: string; name: string; description: string; permission: string; hosts: string[]; reason: string; installed: boolean; state: string; settings?: string[]; error?: string; busy?: boolean }
  /** Questions with choices from the agent (ask_user, A14); `answered` is what the user sent. */
  | { kind: 'question'; id: string; questions: AgentQuestion[]; answered?: string; readonly?: boolean }
  /** The edits one reply made, with a button to undo them together. */
  | { kind: 'edits'; chat: string; turn: string; count: number; labels: string[]; state?: 'busy' | 'undone'; error?: string };

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
  const flowBox = h('div', { class: 'agent-flow' });
  const statusBox = h('div', { class: 'agent-status' });
  const autonomyBox = h('div', { class: 'agent-autonomy' });
  /** The project's autonomy level and its gate (A13), editors only. */
  const drawAutonomy = () => {
    clear(autonomyBox);
    if (!app.doc || !collab.session) return;
    const l = limitsOf(app.doc);
    const set = (patch: Record<string, unknown>, label: string) => app.apply(label, [{ op: 'setMeta', key: 'agentLimits', value: { ...((app.doc!.meta.agentLimits as object) ?? {}), ...l, ...patch } }]);
    const sel = h('select', { title: 'What the agent may do without asking you', ...(canEdit ? {} : { disabled: true }) }, ...(['ask', 'auto', 'full'] as Autonomy[]).map((v) => h('option', { value: v, ...(v === l.autonomy ? { selected: true } : {}) }, AUTONOMY_LABEL[v]))) as HTMLSelectElement;
    sel.addEventListener('change', () => set({ autonomy: sel.value }, `Autonomy: ${AUTONOMY_LABEL[sel.value as Autonomy]}`));
    const bulk = h('input', { type: 'number', min: '1', max: '100', value: String(l.bulkLimit ?? 5), title: 'Removing more parts or nets than this at once always needs your OK', style: 'width:46px', ...(canEdit ? {} : { disabled: true }) }) as HTMLInputElement;
    bulk.addEventListener('change', () => {
      const v = Math.max(1, Math.min(100, Math.round(Number(bulk.value) || 5)));
      set({ bulkLimit: v }, `Agent asks before removing more than ${v}`);
    });
    autonomyBox.append(h('span', { class: 'dim' }, 'Autonomy'), sel, h('span', { class: 'dim', title: 'Removing or replacing more parts or nets than this at once always waits for your OK, at every level' }, 'asks before removing >'), bulk);
  };
  /**
   * Agents running on this project, as the server reports them (its mirror of every conversation), so the
   * panel always says whether an agent works, whose, since when and on what, also after a reload or when
   * it was started in another tab.
   */
  interface Run {
    by: string;
    backend: string;
    since: number;
    last: string;
  }
  const runs = new Map<string, Run>();
  const ownRunning = () => !!chat && runs.has(chat);
  /** This conversation's agent is working (started here, or seen running on the server). */
  const working = () => busy || ownRunning();
  let statusTimer = 0;
  const pluginBox = h('div', { class: 'agent-plugins' });
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

  // ---------------------------------------------------------------- questions (ask_user, A14)
  const renderQuestion = (it: Extract<Item, { kind: 'question' }>): HTMLElement => {
    const card = h('div', { class: `msg question${it.answered ? ' answered' : ''}` });
    if (it.answered) {
      card.append(h('div', { class: 'q-head' }, it.readonly ? 'Questions to the user' : 'You answered'), h('pre', { class: 'q-answer' }, it.answered));
      return card;
    }
    const picked = it.questions.map(() => new Set<number>());
    const other = it.questions.map(() => '');
    const submit = h('button', { class: 'btn primary', disabled: true }, 'Send answers');
    const ready = () => it.questions.every((_, i) => picked[i]!.size || other[i]!.trim());
    it.questions.forEach((q, qi) => {
      const opts = h('div', { class: 'q-options' });
      const buttons: HTMLElement[] = [];
      q.options.forEach((o, oi) => {
        const b = h('button', { class: 'q-option', title: o.description ?? '' }, h('span', { class: 'q-label' }, o.label), o.description ? h('span', { class: 'q-desc' }, o.description) : null);
        b.addEventListener('click', () => {
          if (it.readonly) return;
          const set = picked[qi]!;
          if (q.multiSelect) set.has(oi) ? set.delete(oi) : set.add(oi);
          else (set.clear(), set.add(oi));
          buttons.forEach((x, k) => x.classList.toggle('on', set.has(k)));
          (submit as HTMLButtonElement).disabled = !ready();
        });
        buttons.push(b);
        opts.append(b);
      });
      const free = h('input', { class: 'q-other', placeholder: 'Other answer…', ...(it.readonly ? { disabled: true } : {}) });
      free.addEventListener('input', () => ((other[qi] = (free as HTMLInputElement).value), ((submit as HTMLButtonElement).disabled = !ready())));
      card.append(h('div', { class: 'q-block' }, h('div', { class: 'q-title' }, h('span', { class: 'q-chip' }, q.header), h('span', {}, q.question)), opts, free));
    });
    submit.addEventListener('click', () => {
      if (busy || !ready()) return;
      const lines = it.questions.map((q, i) => {
        const chosen = [...picked[i]!].map((k) => q.options[k]!.label);
        if (other[i]!.trim()) chosen.push(other[i]!.trim());
        return `- ${q.header}: ${chosen.join(', ')}`;
      });
      it.answered = lines.join('\n');
      updateItem(it);
      void send(`My answers:\n${it.answered}`);
    });
    if (!it.readonly) card.append(h('div', { class: 'q-actions' }, submit));
    return card;
  };

  // ---------------------------------------------------------------- gates and decisions (A13)
  const renderGateCard = (it: Extract<Item, { kind: 'gate' }>): HTMLElement => {
    const card = h('div', { class: 'msg question gate-card' }, h('div', { class: 'q-title' }, h('span', { class: 'q-chip' }, 'Needs your OK'), h('span', {}, it.summary)));
    if (it.state === 'ask') {
      const allow = h('button', { class: 'btn primary', ...(it.busy ? { disabled: true } : {}) }, 'Allow');
      const no = h('button', { class: 'btn' }, "Don't");
      const decide = async (decision: 'allow' | 'decline') => {
        if (!collab.session) return;
        it.busy = true;
        updateItem(it);
        const r = await fetch(`/api/agent/${collab.session.id}/gates/decide?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: viewing ?? chat, id: it.id, decision, user: { name: collab.user.name } }) });
        it.busy = false;
        if (!r.ok) it.error = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
        else it.state = decision === 'allow' ? 'allowed' : 'declined';
        updateItem(it);
        persist();
        // My own conversation: tell the agent, so it goes on (or not).
        if (r.ok && !viewing) void send(decision === 'allow' ? `Allowed: go ahead with "${it.summary}".` : `Not allowed: do not do "${it.summary}". Suggest another way.`);
      };
      allow.addEventListener('click', () => void decide('allow'));
      no.addEventListener('click', () => void decide('decline'));
      card.append(h('div', { class: 'q-desc' }, 'The agent waits for you. Allowing lets this change through once.'), h('div', { class: 'q-actions' }, no, allow));
    } else card.append(h('div', { class: 'q-head' }, it.state === 'allowed' ? '✓ Allowed once' : 'Not allowed'));
    if (it.error) card.append(h('div', { class: 'err-text' }, it.error));
    return card;
  };
  const DECISION_LABEL: Record<string, string> = { plugin: 'Plugin', part: 'Part', source: 'Source' };
  const renderDecisions = (it: Extract<Item, { kind: 'decisions' }>): HTMLElement =>
    h(
      'details',
      { class: 'msg decisions', open: true },
      h('summary', {}, `Decided by the agent (${it.items.length})`),
      h('ul', {}, ...it.items.map((d) => h('li', {}, h('span', { class: 'q-chip' }, DECISION_LABEL[d.kind] ?? d.kind), ` ${d.what}`, d.reason ? h('span', { class: 'dim' }, ` — ${d.reason}`) : null))),
      h('div', { class: 'dim', style: 'font-size:11px' }, 'Changes to the project are undone with "Undo these changes" below.'),
    );
  const gateEvent = (list: Item[], e: Record<string, unknown>, push: (it: Item) => void) => {
    const known = list.find((x): x is Extract<Item, { kind: 'gate' }> => x.kind === 'gate' && x.id === e.id);
    if (known) return ((known.state = String(e.state ?? known.state)), updateItem(known));
    push({ kind: 'gate', id: String(e.id), summary: String(e.summary ?? ''), parts: Array.isArray(e.parts) ? e.parts.map(String) : [], nets: Array.isArray(e.nets) ? e.nets.map(String) : [], state: String(e.state ?? 'ask') });
  };

  // ---------------------------------------------------------------- plugin requests (A12)
  const renderPluginCard = (it: Extract<Item, { kind: 'plugin' }>): HTMLElement => {
    const head = h('div', { class: 'q-title' }, h('span', { class: 'q-chip' }, 'Plugin'), h('span', {}, `The agent asks for ${it.name || it.plugin}`));
    const meta = h('div', { class: 'q-desc' }, `${it.permission}${it.hosts.length ? ` · contacts ${it.hosts.join(', ')}` : ''}${it.installed ? ' · installed, off for this project' : ' · from the plugin catalog'}`);
    const card = h('div', { class: 'msg question plugin-card' }, head, it.description ? h('div', { class: 'q-desc' }, it.description) : null, meta, it.reason ? h('div', { class: 'plugin-reason' }, `Why: ${it.reason}`) : null);
    if (it.state === 'approve') {
      const yes = h('button', { class: 'btn primary', ...(it.busy ? { disabled: true } : {}) }, it.installed ? 'Switch on' : 'Install & switch on');
      const no = h('button', { class: 'btn' }, 'Not now');
      const decide = async (decision: 'install' | 'decline') => {
        if (!collab.session) return;
        it.busy = true;
        updateItem(it);
        const r = await fetch(`/api/agent/${collab.session.id}/plugins/decide?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin: it.plugin, request: it.id, chat: viewing ?? chat, decision, user: { name: collab.user.name } }) });
        it.busy = false;
        if (!r.ok) it.error = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
        else ((it.state = decision === 'install' ? 'done' : 'declined'), (it.error = undefined));
        updateItem(it);
        persist();
        if (pluginsOpen) void loadPlugins();
      };
      yes.addEventListener('click', () => void decide('install'));
      no.addEventListener('click', () => void decide('decline'));
      card.append(h('div', { class: 'q-actions' }, no, yes));
    } else if (it.state === 'settings') card.append(h('div', { class: 'err-text plugin-reason' }, `Installed and switched on, but it needs ${(it.settings ?? []).join(', ')}: the server's owner fills ${it.settings && it.settings.length > 1 ? 'them' : 'it'} in under Settings in the Plugins section (on the server's machine). The agent goes on without it meanwhile.`));
    else card.append(h('div', { class: 'q-head' }, it.state === 'done' ? `✓ ${it.name || it.plugin} is switched on for this project${it.installed ? '' : ' (installed from the catalog)'}` : 'Not now: the plugin stays off.'));
    if (it.error) card.append(h('div', { class: 'err-text' }, it.error));
    return card;
  };
  /** A plugin_request event: a new card, or the state of one shown already. */
  const pluginEvent = (list: Item[], e: Record<string, unknown>, push: (it: Item) => void) => {
    const known = list.find((x): x is Extract<Item, { kind: 'plugin' }> => x.kind === 'plugin' && x.id === e.id);
    if (known) {
      known.state = String(e.state ?? known.state);
      if (Array.isArray(e.settings)) known.settings = e.settings.map(String);
      updateItem(known);
      return;
    }
    push({ kind: 'plugin', id: String(e.id), plugin: String(e.plugin ?? ''), name: String(e.name ?? e.plugin ?? ''), description: String(e.description ?? ''), permission: String(e.permission ?? ''), hosts: Array.isArray(e.hosts) ? e.hosts.map(String) : [], reason: String(e.reason ?? ''), installed: !!e.installed, state: String(e.state ?? 'approve'), ...(Array.isArray(e.settings) ? { settings: e.settings.map(String) } : {}) });
  };

  // ---------------------------------------------------------------- AI Full stages (A14)
  const drawFlow = () => {
    clear(flowBox);
    const f = aiFlowOf(app.doc);
    if (!f || f.mode !== 'full' || !collab.session) return;
    const n = AI_STAGES.indexOf(f.stage) + 1;
    const next = nextStage(f.stage);
    flowBox.append(
      h(
        'div',
        { class: 'flow-head' },
        h('span', { class: 'flow-badge' }, 'AI Full'),
        h('span', {}, f.done ? 'Every stage done' : `Stage ${n} of ${AI_STAGES.length} · ${STAGE_TITLES[f.stage]}`),
        h('span', { class: 'dim' }, working() ? '· working' : f.done ? '' : f.waiting ? '· waiting for you' : '· stopped'),
      ),
      h('div', { class: 'flow-steps' }, ...AI_STAGES.map((s, i) => h('span', { class: `flow-step${i < n - 1 || f.done || (s === f.stage && f.waiting) ? ' done' : s === f.stage ? ' now' : ''}`, title: STAGE_TITLES[s] }))),
    );
    if (f.waiting && !f.done && !working()) {
      // The stage's summary folded, so the panel keeps room for the conversation.
      if (f.summary || f.open) {
        const d = h('details', { class: 'flow-details' }, h('summary', {}, `What the AI did in ${STAGE_TITLES[f.stage]}${f.open ? ' · open points' : ''}`));
        if (f.summary) d.append(h('div', { class: 'flow-summary' }, renderMarkdown(f.summary)));
        if (f.open) d.append(h('div', { class: 'flow-open' }, h('b', {}, 'Open: '), f.open));
        flowBox.append(d);
      }
      const go = h('button', { class: 'btn primary' }, next ? `Continue to ${STAGE_TITLES[next]}` : 'Finish');
      go.addEventListener('click', () => {
        if (!next) return;
        void send(`Continue with the ${STAGE_TITLES[next]} stage.`, next);
      });
      const change = h('button', { class: 'btn' }, 'Change something');
      change.addEventListener('click', () => {
        input.placeholder = `What should change in the ${STAGE_TITLES[f.stage]} stage?`;
        input.focus();
      });
      flowBox.append(h('div', { class: 'flow-actions' }, go, change));
    }
  };

  // ---------------------------------------------------------------- rendering
  const renderItem = (it: Item): HTMLElement => {
    if (it.kind === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, it.text));
    if (it.kind === 'error') return h('div', { class: 'msg error' }, it.text);
    if (it.kind === 'edits') {
      const what = `${it.count} change${it.count === 1 ? '' : 's'}${it.labels.length ? `: ${it.labels.join(', ')}` : ''}`;
      if (it.state === 'undone') return h('div', { class: 'msg edits undone' }, h('span', {}, `Undone · ${what}`));
      const btn = h('button', { class: 'btn', disabled: it.state === 'busy', title: 'Undo everything the agent changed in this reply, as one step' }, it.state === 'busy' ? 'Undoing…' : 'Undo these changes');
      btn.addEventListener('click', () => void undoEdits(it));
      return h('div', { class: 'msg edits' }, h('span', {}, `Agent made ${what}`), btn, it.error ? h('div', { class: 'err-text' }, it.error) : null);
    }
    if (it.kind === 'question') return renderQuestion(it);
    if (it.kind === 'plugin') return renderPluginCard(it);
    if (it.kind === 'gate') return renderGateCard(it);
    if (it.kind === 'decisions') return renderDecisions(it);
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
    const visible = it.steps.filter((s) => s.name !== 'update_tasks' && s.name !== 'ask_user');
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
    if (w && w.chat !== chat) {
      log.append(
        h(
          'div',
          { class: 'watch-banner' },
          h('span', { class: `live-dot ${w.running ? 'online' : 'offline'}` }),
          h('span', {}, `Watching ${w.by}'s agent · ${backendName(w.backend)}${w.running ? ' · working' : ''}`),
          h('button', { class: 'link', onclick: () => ((viewing = null), drawLog(), drawTasks()) }, 'Back to my chat'),
        ),
      );
    } else if ([...watched.values()].some((o) => o.chat !== chat)) {
      const others = [...watched.values()].filter((o) => o.chat !== chat);
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
    // The step "in progress" spins only while that conversation's agent really works.
    const live = viewing ? runs.has(viewing) : working();
    if (!live && tasks.some((t) => t.status === 'doing' || t.status === 'todo')) head.append(h('span', { class: 'dim tasks-stopped' }, '· not running'));
    if (tasksOpen) for (const t of tasks) taskBox.append(h('div', { class: `agent-task ${t.status}${t.status === 'doing' && !live ? ' stalled' : ''}` }, h('span', { class: 'tick' }, t.status === 'done' ? '✓' : t.status === 'doing' ? '' : t.status === 'blocked' ? '!' : ''), h('span', {}, t.title)));
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
    refreshWorking();
  };
  /** Composer, status line, stage bar and checklist follow whether the agent works. */
  const refreshWorking = () => {
    const w = working();
    typing.style.display = w && !viewing ? '' : 'none';
    sendBtn.style.display = w ? 'none' : '';
    stopBtn.style.display = w ? '' : 'none';
    input.placeholder = w ? 'The agent is working… you can stop it with ■' : 'Ask about the design, or tell the agent what to do…';
    drawHints();
    drawFlow();
    drawStatus();
    drawTasks();
  };
  const backendName = (b: string) => (b === 'claude' ? 'Claude Code' : b === 'codex' ? 'Codex' : 'Claude API');
  const ago = (t: number) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  };
  const drawStatus = () => {
    clear(statusBox);
    if (!collab.session) return;
    if (!runs.size) {
      statusBox.append(h('div', { class: 'status-row idle' }, h('span', { class: 'live-dot offline' }), h('span', {}, 'No agent is working on this project')));
      clearInterval(statusTimer);
      statusTimer = 0;
      return;
    }
    for (const [id, r] of runs) {
      const here = id === chat;
      // Several agents may work at once: mine (this chat or another of my chats) can be stopped here.
      const mine = here || r.by === collab.user.name;
      const stop = h('button', { class: 'link', title: 'Stop this agent' }, 'Stop');
      stop.addEventListener('click', () => collab.session && void fetch(`/api/agent/${collab.session.id}/stop?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', body: JSON.stringify({ chat: id }) }));
      statusBox.append(
        h(
          'div',
          { class: 'status-row working' },
          h('span', { class: 'live-dot online pulse' }),
          h('span', {}, h('b', {}, here ? 'Your agent is working' : mine ? 'Your other agent is working' : `${r.by}'s agent is working`), ` · ${backendName(r.backend)} · ${ago(r.since)}${r.last ? ` · ${r.last}` : ''}`),
          here ? null : h('button', { class: 'link', onclick: () => ((viewing = id), drawLog(), drawTasks()) }, 'Watch'),
          mine ? stop : null,
        ),
      );
    }
    if (!statusTimer) statusTimer = window.setInterval(drawStatus, 1000);
  };
  /** Keep `runs` up to date from a conversation's mirrored event. */
  const noteRun = (id: string, by: string, backend: string, e: Record<string, unknown>) => {
    if (e.type === 'start') runs.set(id, { by, backend, since: Number(e.at) || Date.now(), last: '' });
    else if (e.type === 'end') {
      runs.delete(id);
      // My own reply, followed after a reload: it becomes my conversation again when it ends.
      const w = id === chat ? watched.get(id) : undefined;
      if (w && !busy) {
        setTimeout(() => {
          items = [...w.items];
          tasks = [...w.tasks];
          watched.delete(id);
          if (viewing === id) viewing = null;
          persist();
          drawLog();
          drawTasks();
        }, 0);
      }
    }
    else if (e.type === 'tool' && runs.has(id) && e.name !== 'update_tasks') runs.get(id)!.last = stepLabel(String(e.name));
    else return;
    refreshWorking();
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
      h('button', { class: 'insp-toggle', title: 'Hide / show the inspector on the right', onclick: () => toggleRight() }, '◨'),
      h('button', { title: 'Hide this panel for more room (Ctrl+\\); the top button of the rail brings it back', onclick: () => toggleLeft() }, '«'),
    );
    const state = h('div', { class: 'agent-backend' }, h('span', { class: `live-dot ${cur.ready ? 'online' : 'offline'}` }), h('span', { class: 'dim ellipsis' }, cur.note));
    if (!cur.ready && backend !== 'api' && cur.installed) state.append(h('button', { class: 'btn primary', onclick: () => void signIn(backend as Cli['id']) }, 'Sign in'));
    if (cur.ready && backend !== 'api') state.append(h('button', { class: 'link', title: 'Sign in with another account', onclick: () => void signIn(backend as Cli['id']) }, 'Switch account'));
    header.append(h('div', { class: 'head-row' }, pick, menu), h('div', { class: 'head-row' }, modeSeg, state));
    sendBtn.disabled = !cur.ready;
    input.placeholder = cur.ready ? (mode === 'ask' ? 'Ask about the design (read-only)…' : 'Ask about the design, or tell the agent what to do…') : 'Choose an AI above and sign in first';
  };

  // ---------------------------------------------------------------- plugins (docs/06-agent-plugins.md, A1)
  interface PluginInfo {
    id: string;
    name: string;
    version: string;
    publisher: string;
    description?: string;
    permission: 'read' | 'propose';
    hosts: string[];
    builtin?: boolean;
    backendWebSearch?: boolean;
    fromCatalog?: boolean;
    settings: { key: string; label: string; secret?: boolean; required?: boolean; configured: boolean }[];
    status: { ok: true; tools: { name: string; description: string }[] } | { ok: false; error: string };
  }
  interface PluginLog {
    at: string;
    by: string;
    plugin: string;
    tool: string;
    args: string;
    ok: boolean;
    bytes: number;
  }
  interface Offered {
    id: string;
    version?: string;
    license?: string;
    name: string;
    description?: string;
    permission: string;
    hosts: string[];
  }
  interface InstallLog {
    at: string;
    action: string;
    id: string;
    version: string;
    by: string;
    reason?: string;
  }
  let plugins: { plugins: PluginInfo[]; problems: { id: string; problems: string[] }[]; log: PluginLog[]; offered?: Offered[]; installs?: InstallLog[]; canInstall?: boolean } | null = null;
  /** Install or remove a catalog plugin on this server (only from the machine it runs on). */
  const catalogAction = async (action: 'install' | 'remove', id: string) => {
    if (!collab.session) return;
    const r = await fetch(`/api/agent/${collab.session.id}/plugins/${action}?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin: id, user: { name: collab.user.name } }) });
    if (!r.ok) app.say(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    await loadPlugins(true);
  };
  /** The server could not list plugins (an older server, or not reachable). */
  let pluginsError = '';
  let pluginsOpen = false;
  let canEdit = false;
  const enabledPlugins = (): string[] => {
    const v = app.doc?.meta.agentPlugins;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  const loadPlugins = async (refresh = false) => {
    if (!collab.session) return;
    const q = `token=${encodeURIComponent(collab.session.token)}${refresh ? '&refresh=1' : ''}`;
    const [list, info] = await Promise.all([
      fetch(`/api/agent/${collab.session.id}/plugins?${q}`)
        .then((r) => (r.ok ? r.json() : ((pluginsError = r.status === 404 || r.status === 400 ? 'This server does not know plugins yet: restart it with the current version.' : `The server answered ${r.status}.`), null)))
        .catch(() => ((pluginsError = 'The server is not reachable.'), null)),
      collab.info().catch(() => null),
    ]);
    plugins = list;
    if (list) pluginsError = '';
    canEdit = info?.role === 'edit';
    drawAutonomy();
    drawPlugins();
  };
  /** Switch a plugin on or off for this project: a change of the project (one undo step), editors only. */
  const setPlugin = (id: string, on: boolean) => {
    const cur = enabledPlugins();
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    app.apply(`Agent plugin ${id} ${on ? 'on' : 'off'}`, [{ op: 'setMeta', key: 'agentPlugins', value: next.length ? next : null }]);
    drawPlugins();
  };
  /** Fill in a plugin's settings (an API key) on the server's own machine; secrets are never shown back. */
  const settingsForm = (p: PluginInfo): HTMLElement => {
    const open = p.settings.some((x) => x.required && !x.configured);
    const box = h('details', { class: 'plugin-settings', ...(open ? { open: true } : {}) }, h('summary', {}, open ? 'Set it up' : 'Settings'));
    const inputs = p.settings.map((x) => {
      const inp = h('input', { type: x.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: 'false', placeholder: x.configured ? (x.secret ? 'set ✓ (type to replace)' : 'set ✓') : x.required ? 'required' : 'optional' }) as HTMLInputElement;
      box.append(h('label', { class: 'plugin-setting' }, h('span', {}, x.label || x.key), inp));
      return [x, inp] as const;
    });
    const save = async () => {
      if (!collab.session) return;
      const values = Object.fromEntries(inputs.filter(([, i]) => i.value.trim()).map(([x, i]) => [x.key, i.value.trim()]));
      if (!Object.keys(values).length) return;
      const r = await fetch(`/api/agent/${collab.session.id}/plugins/settings?token=${encodeURIComponent(collab.session.token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin: p.id, values }) });
      if (!r.ok) app.say(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      await loadPlugins(true);
    };
    box.append(h('div', { class: 'dim plugin-meta' }, 'Kept in plugin-settings.json on this server only; never in the project, and never given to the AI.'), h('button', { class: 'btn small', onclick: () => void save() }, 'Save'));
    return box;
  };
  const drawPlugins = () => {
    clear(pluginBox);
    const list = plugins?.plugins ?? [];
    const enabled = enabledPlugins();
    const on = list.filter((p) => enabled.includes(p.id));
    const head = h(
      'button',
      { class: 'tasks-head', title: 'Tools from outside Hassassin that the agent may use in this project', onclick: () => ((pluginsOpen = !pluginsOpen), pluginsOpen ? void loadPlugins() : drawPlugins()) },
      h('span', {}, pluginsOpen ? '▾' : '▸'),
      h('span', {}, 'Plugins'),
      h('span', { class: 'dim' }, !plugins ? (pluginsError ? 'not available' : '…') : list.length ? `${on.length} of ${list.length} on` : 'none installed'),
    );
    pluginBox.append(head);
    if (!pluginsOpen) return;
    if (!plugins) return void pluginBox.append(h('div', { class: pluginsError ? 'err-text plugin-note' : 'dim' }, pluginsError || 'Loading…'));
    if (!list.length)
      pluginBox.append(h('div', { class: 'dim plugin-note' }, 'No plugins are installed on this server. The owner lists them in plugins.json in the server\'s data folder (see docs/03-agents.md).'));
    for (const p of list) {
      const isOn = enabled.includes(p.id);
      const sw = h('input', { type: 'checkbox', ...(isOn ? { checked: true } : {}), ...(canEdit ? {} : { disabled: true }), title: canEdit ? `Switch ${p.name} ${isOn ? 'off' : 'on'} for this project` : 'Only editors can switch plugins' });
      sw.addEventListener('change', () => setPlugin(p.id, (sw as HTMLInputElement).checked));
      const st = p.status.ok ? h('span', { class: 'plugin-ok' }, `ready · ${p.status.tools.length} tool${p.status.tools.length === 1 ? '' : 's'}`) : h('span', { class: 'err-text' }, p.status.error);
      const missing = p.settings.filter((x) => !x.configured);
      pluginBox.append(
        h(
          'div',
          { class: `plugin-row${isOn ? ' on' : ''}` },
          h('label', { class: 'plugin-title' }, sw, h('span', { class: 'plugin-name' }, p.name), h('span', { class: `badge ${p.permission}`, title: p.permission === 'read' ? 'Returns data only; also in Ask mode' : 'May propose changes (the agent applies them with Hassassin tools); Agent mode only' }, p.permission)),
          h('div', { class: 'dim plugin-meta' }, `${p.builtin ? 'bundled · ' : ''}${p.publisher} · v${p.version}${p.hosts.length ? ` · contacts ${p.hosts.join(', ')}` : ' · no network'}${p.backendWebSearch ? ' · also switches on the AI\'s own web search' : ''}`),
          p.description ? h('div', { class: 'plugin-desc' }, p.description) : null,
          h('div', { class: 'plugin-status' }, st, p.status.ok ? h('span', { class: 'dim' }, ` ${p.status.tools.map((t) => t.name).join(', ')}`) : null),
          p.settings.length ? h('div', { class: 'dim plugin-meta' }, `Settings: ${p.settings.map((x) => `${x.label || x.key} ${x.configured ? '✓' : x.required ? '(missing)' : '(not set)'}`).join(' · ')}`) : null,
          missing.some((x) => x.required) && !plugins.canInstall ? h('div', { class: 'plugin-meta err-text' }, 'The server\'s owner sets it up on the server\'s machine.') : null,
          plugins.canInstall && p.settings.length ? settingsForm(p) : null,
        ),
      );
    }
    // What the catalog offers that is not installed (A12).
    if (plugins.offered?.length) {
      pluginBox.append(h('div', { class: 'step-label' }, 'In the plugin catalog'));
      for (const o of plugins.offered) {
        const install = plugins.canInstall ? h('button', { class: 'link', onclick: () => void catalogAction('install', o.id) }, 'Install') : null;
        pluginBox.append(h('div', { class: 'plugin-row' }, h('div', { class: 'plugin-title' }, h('span', { class: 'plugin-name' }, o.name), h('span', { class: `badge ${o.permission}` }, o.permission), install), h('div', { class: 'dim plugin-meta' }, `v${o.version ?? '?'} · ${o.license ?? ''}${o.hosts.length ? ` · contacts ${o.hosts.join(', ')}` : ''}`), o.description ? h('div', { class: 'plugin-desc' }, o.description) : null));
      }
      if (!plugins.canInstall) pluginBox.append(h('div', { class: 'dim plugin-note' }, 'Installed by the server\'s owner on its machine, or by the agent when the project allows it.'));
    }
    for (const pl of list.filter((x) => x.fromCatalog))
      if (plugins.canInstall) pluginBox.append(h('button', { class: 'link', onclick: () => confirm(`Remove ${pl.name} from this server?`) && void catalogAction('remove', pl.id) }, `Remove ${pl.name}`));
    const installs = (plugins.installs ?? []).slice(-5).reverse();
    if (installs.length) {
      pluginBox.append(h('div', { class: 'step-label' }, 'Installs'));
      for (const l of installs) pluginBox.append(h('div', { class: 'plugin-call', title: l.reason ?? '' }, h('span', {}, `${l.action} ${l.id} ${l.version}`), h('span', { class: 'dim' }, ` · ${l.by} · ${new Date(l.at).toLocaleString()}`)));
    }
    for (const pr of plugins.problems) pluginBox.append(h('div', { class: 'err-text plugin-meta' }, `plugins.json, ${pr.id}: ${pr.problems.join('; ')}`));
    const recent = plugins.log.slice(-8).reverse();
    if (recent.length) {
      pluginBox.append(h('div', { class: 'step-label' }, 'Recent plugin calls'));
      for (const l of recent)
        pluginBox.append(
          h('div', { class: `plugin-call${l.ok ? '' : ' bad'}`, title: l.args }, h('span', {}, `${l.ok ? '✓' : '!'} ${l.plugin}.${l.tool}`), h('span', { class: 'dim' }, ` ${l.by} · ${new Date(l.at).toLocaleTimeString()} · ${l.bytes} chars`)),
        );
    }
    pluginBox.append(h('button', { class: 'link', onclick: () => void loadPlugins(true) }, 'Check again'));
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
    root.append(header, loginBox, statusBox, autonomyBox, pluginBox, flowBox, taskBox, log, bottom);
    drawAutonomy();
    drawFlow();
    drawHeader();
    void loadPlugins();
    drawTasks();
    drawLog();
    setBusy(busy);
  };

  // ---------------------------------------------------------------- undo one reply's edits
  const undoEdits = async (it: Extract<Item, { kind: 'edits' }>) => {
    if (!collab.session || it.state) return;
    it.state = 'busy';
    delete it.error;
    updateItem(it);
    try {
      const r = await fetch(`/api/agent/${collab.session.id}/undo?token=${encodeURIComponent(collab.session.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat: it.chat, turn: it.turn, user: { name: collab.user.name } }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      it.state = 'undone';
      app.say('Undid the agent’s changes from that reply.');
    } catch (e) {
      delete it.state;
      it.error = (e as Error).message;
    }
    updateItem(it);
    persist();
  };

  // ---------------------------------------------------------------- sending
  const send = async (text?: string, advanceTo?: (typeof AI_STAGES)[number]) => {
    const prompt = (text ?? input.value).trim();
    if (!prompt || working() || !collab.session || (sendBtn.disabled && text === undefined)) return;
    input.placeholder = 'Ask about the design, or tell the agent what to do…';
    if (viewing) {
      viewing = null;
      drawLog();
      drawTasks();
    }
    if (text === undefined) input.value = '';
    autoGrow();
    // A typed "lanjut" / "continue" while an AI Full stage waits is the Continue button (A14).
    const flow = aiFlowOf(app.doc);
    const nxt = flow?.mode === 'full' && flow.waiting && !flow.done ? nextStage(flow.stage) : null;
    const stageTo = advanceTo ?? (nxt && isGoAhead(prompt) ? nxt : null);
    // The next stage starts only if the server takes the message (undone when it refuses it).
    const advanced = !!stageTo && app.apply(`AI Full: start ${STAGE_TITLES[stageTo]}`, [{ op: 'setMeta', key: 'aiFlow', value: { mode: 'full', stage: stageTo, waiting: false } }]);
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
        if (advanced) app.undo();
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
          // Remember the conversation at once, so a reload during the reply still knows it is mine.
          if (e.type === 'chat') ((chat = e.chat), persist());
          else if (e.type === 'text') {
            stepsItem = null;
            if (!agentItem) push((agentItem = { kind: 'agent', text: '' }));
            agentItem.text += e.text;
            updateItem(agentItem);
          } else if (e.type === 'note') {
            push({ kind: 'note', text: e.text });
          } else if (e.type === 'gate') {
            agentItem = null;
            stepsItem = null;
            gateEvent(items, e, push);
          } else if (e.type === 'decisions') {
            push({ kind: 'decisions', items: e.items ?? [] });
          } else if (e.type === 'plugin_request') {
            agentItem = null;
            stepsItem = null;
            pluginEvent(items, e, push);
            if (pluginsOpen) void loadPlugins();
          } else if (e.type === 'question') {
            agentItem = null;
            stepsItem = null;
            push({ kind: 'question', id: e.id, questions: e.questions });
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
          } else if (e.type === 'edits' && chat) {
            push({ kind: 'edits', chat, turn: e.turn, count: e.count, labels: e.labels ?? [] });
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
  // The AI Full wizard starts the work with a first message (A14).
  app.agentStart = (prompt: string) => {
    mode = 'agent';
    drawHeader();
    void send(prompt);
  };
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
      push({ kind: 'user', text: w.chat === chat ? String(e.text ?? '') : `${String(e.by ?? w.by)}: ${String(e.text ?? '')}` });
    } else if (t === 'start') w.running = true;
    else if (t === 'end' || t === 'done') w.running = false;
    else if (t === 'text') {
      w.stepsItem = null;
      if (!w.agentItem) push((w.agentItem = { kind: 'agent', text: '' }));
      w.agentItem.text += String(e.text ?? '');
      if (show) updateItem(w.agentItem);
    } else if (t === 'note') push({ kind: 'note', text: String(e.text ?? '') });
    else if (t === 'plugin_request') pluginEvent(w.items, e, push);
    else if (t === 'gate') gateEvent(w.items, e, push);
    else if (t === 'decisions') push({ kind: 'decisions', items: (e.items as { kind: string; what: string; reason?: string }[]) ?? [] });
    else if (t === 'question') push({ kind: 'question', id: String(e.id), questions: (e.questions as AgentQuestion[]) ?? [], readonly: true, answered: ((e.questions as AgentQuestion[]) ?? []).map((q) => `- ${q.question}`).join('\n') });
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
      noteRun(id, by, b, event);
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
    runs.clear();
    for (const c of list as { chat: string; by: string; backend: string; running: boolean; since?: number; events: Record<string, unknown>[] }[]) {
      if (c.running) {
        const lastTool = [...c.events].reverse().find((e) => e.type === 'tool' && e.name !== 'update_tasks');
        runs.set(c.chat, { by: c.by, backend: c.backend, since: c.since ?? Date.now(), last: lastTool ? stepLabel(String(lastTool.name)) : '' });
      }
      // My own conversation, still running after a reload: followed live like any other.
      if (c.chat === chat && !c.running) continue;
      watched.delete(c.chat);
      const w = watch(c.chat, c.by, c.backend);
      for (const e of c.events) applyWatched(w, e);
      w.running = c.running;
    }
    const live = [...watched.values()].reverse().find((w) => w.running);
    if (live && (!items.length || live.chat === chat)) viewing = live.chat;
    drawLog();
    refreshWorking();
  };

  app.on('collab', () => {
    listen();
    void render().then(loadTranscripts);
  });
  app.on('drc', drawHints);
  // A collaborator may switch plugins; the switches follow the project.
  app.on('change', () => (pluginsOpen && drawPlugins(), drawFlow(), drawAutonomy()));
  app.on('doc', drawFlow);
  // The intro's button depends on whether a project is open.
  app.on('doc', () => {
    if (!app.collab) void render();
  });
  listen();
  void render().then(loadTranscripts);
}
