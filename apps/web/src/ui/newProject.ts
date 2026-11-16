/**
 * New project (docs/06-agent-plugins.md, A14): the choice between **AI Full** (a wizard, then the agent takes
 * the project through its stages, stopping after each for the user's go-ahead) and **AI Assisted** (the
 * schematic, the agent on demand).
 */
import { AUTONOMY_LABEL, DEFAULT_LIMITS, projectNameFrom, SPEC_FIELDS, wizardPrompt, type AgentLimits, type Autonomy, type Spec } from '@hassassin/tools';
import type { App } from '../app.ts';
import type { Collab } from '../collab.ts';
import { clear, h } from './dom.ts';
import { showLeft } from './resize.ts';

type Backend = 'api' | 'claude' | 'codex';
interface Status {
  available: boolean;
  clis: { id: 'claude' | 'codex'; label: string; loggedIn: boolean }[];
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  },
};

/** The agent backends that can work now, best first. */
function readyBackends(s: Status | null): { id: Backend; label: string }[] {
  if (!s) return [];
  return [
    ...s.clis.filter((c) => c.loggedIn).map((c) => ({ id: c.id as Backend, label: c.id === 'claude' ? 'Claude Code (your Claude subscription)' : 'Codex (your ChatGPT subscription)' })),
    ...(s.available ? [{ id: 'api' as Backend, label: 'Claude API (pay per use)' }] : []),
  ];
}

export function openNewProjectDialog(app: App, collab: Collab, loaded: () => void): void {
  if (app.dirty && !confirm('Discard unsaved changes and start a new project?')) return;
  const dlg = h('dialog', { class: 'annotate-dialog newproj-dialog' }) as HTMLDialogElement;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  let status: Status | null = null;

  const assisted = () => {
    dlg.close();
    app.newProject();
    app.apply('AI Assisted', [{ op: 'setMeta', key: 'aiFlow', value: { mode: 'assisted', stage: 'requirements', waiting: false } }]);
    loaded();
  };

  // ---------------------------------------------------------------- the choice
  const choose = () => {
    clear(dlg);
    const backends = readyBackends(status);
    const why = status === null ? 'The collaboration server is not running (pnpm run server).' : !backends.length ? 'No AI is ready: sign in Claude Code or Codex in the Agent tab, or set an API key on the server.' : '';
    const full = h(
      'button',
      { class: 'np-choice', ...(why ? { disabled: true, title: why } : {}) },
      h('div', { class: 'np-title' }, 'AI Full'),
      h('div', { class: 'np-desc' }, 'Describe what you want to build. A short wizard asks for the requirements and limits, then the AI takes the project through requirements, schematic, components, layout and review, and stops after each stage for your go-ahead.'),
      why ? h('div', { class: 'np-why' }, why) : null,
    );
    full.addEventListener('click', () => !why && wizard(0));
    const asst = h(
      'button',
      { class: 'np-choice' },
      h('div', { class: 'np-title' }, 'AI Assisted'),
      h('div', { class: 'np-desc' }, 'Start on an empty schematic and design it yourself. The AI is in the Agent tab whenever you want it.'),
    );
    asst.addEventListener('click', assisted);
    dlg.append(
      h('h3', {}, 'New project'),
      h('p', { class: 'dim' }, 'How do you want to work on it? You can change this later in the Project panel.'),
      h('div', { class: 'np-choices' }, full, asst),
      h('div', { class: 'row' }, h('button', { onclick: () => dlg.close() }, 'Cancel')),
    );
  };

  // ---------------------------------------------------------------- the wizard (AI Full)
  let description = '';
  const spec: Partial<Spec> = {};
  const limits: AgentLimits = { ...DEFAULT_LIMITS, distributors: [...DEFAULT_LIMITS.distributors], avoid: [...(DEFAULT_LIMITS.avoid ?? [])] };
  let backend: Backend = (store.get('hassassin:agent:backend') as Backend) || 'claude';
  let userName = store.get('hassassin:user:name');
  const STEPS = ['What to build', 'Requirements', 'Limits', 'Start'];

  const wizard = (step: number) => {
    clear(dlg);
    dlg.append(
      h('h3', {}, `AI Full · ${STEPS[step]}`),
      h('div', { class: 'np-steps' }, ...STEPS.map((s, i) => h('span', { class: `np-step${i === step ? ' now' : i < step ? ' done' : ''}` }, `${i + 1} ${s}`))),
    );
    const body = h('div', { class: 'np-body' });
    dlg.append(body);
    const next = h('button', { class: 'primary' }, step === STEPS.length - 1 ? 'Start' : 'Next');
    const back = h('button', {}, step ? 'Back' : 'Cancel');
    back.addEventListener('click', () => (step ? wizard(step - 1) : choose()));

    if (step === 0) {
      const t = h('textarea', { rows: '5', placeholder: 'e.g. A USB-C powered sensor node with an ESP32-C3, a humidity and temperature sensor and a status LED, small enough for a wall box.' }) as HTMLTextAreaElement;
      t.value = description;
      const ok = () => ((next as HTMLButtonElement).disabled = t.value.trim().length < 10);
      t.addEventListener('input', () => ((description = t.value), ok()));
      ok();
      body.append(h('label', { class: 'np-field' }, h('span', {}, 'Describe the device: what it does, how it is powered, what it connects to.'), t));
      setTimeout(() => t.focus(), 0);
    } else if (step === 1) {
      body.append(h('p', { class: 'dim' }, 'Fill in what you know; leave the rest empty and the AI proposes values (and says they are proposals).'));
      for (const f of SPEC_FIELDS.filter((x) => x.key !== 'goal')) {
        const i = (f.multiline ? h('textarea', { rows: '2', placeholder: f.hint }) : h('input', { placeholder: f.hint })) as HTMLInputElement;
        i.value = spec[f.key] ?? '';
        i.addEventListener('input', () => (spec[f.key] = i.value));
        body.append(h('label', { class: 'np-field' }, h('span', {}, f.label), i));
      }
    } else if (step === 2) {
      const dist = h('div', { class: 'np-checks' });
      for (const d of ['LCSC', 'Mouser']) {
        const c = h('input', { type: 'checkbox', ...(limits.distributors.includes(d) ? { checked: true } : {}) }) as HTMLInputElement;
        c.addEventListener('change', () => (limits.distributors = c.checked ? [...new Set([...limits.distributors, d])] : limits.distributors.filter((x) => x !== d)));
        dist.append(h('label', {}, c, ` ${d}`));
      }
      const pkg = h('select', {}, ...['0201', '0402', '0603', '0805', '1206'].map((v) => h('option', { value: v, ...(v === limits.smallestPackage ? { selected: true } : {}) }, v))) as HTMLSelectElement;
      pkg.addEventListener('change', () => (limits.smallestPackage = pkg.value));
      const avoid = h('div', { class: 'np-checks' });
      for (const a of ['BGA', 'QFN', 'WLCSP']) {
        const c = h('input', { type: 'checkbox', ...(limits.avoid?.includes(a) ? { checked: true } : {}) }) as HTMLInputElement;
        c.addEventListener('change', () => (limits.avoid = c.checked ? [...new Set([...(limits.avoid ?? []), a])] : (limits.avoid ?? []).filter((x) => x !== a)));
        avoid.append(h('label', {}, c, ` ${a}`));
      }
      const budget = h('input', { placeholder: 'e.g. USD 10 per board (parts)' }) as HTMLInputElement;
      budget.value = limits.budget ?? '';
      budget.addEventListener('input', () => (limits.budget = budget.value || undefined));
      const layers = h('select', {}, ...[2, 4].map((v) => h('option', { value: String(v), ...(v === limits.layers ? { selected: true } : {}) }, `${v} layers`))) as HTMLSelectElement;
      layers.addEventListener('change', () => (limits.layers = Number(layers.value)));
      const size = h('input', { placeholder: 'e.g. 50 × 40 mm, or leave to the AI' }) as HTMLInputElement;
      size.value = limits.boardSize ?? '';
      size.addEventListener('input', () => (limits.boardSize = size.value || undefined));
      const auto = h('select', {}, ...(['ask', 'auto', 'full'] as Autonomy[]).map((v) => h('option', { value: v, ...(v === limits.autonomy ? { selected: true } : {}) }, AUTONOMY_LABEL[v]))) as HTMLSelectElement;
      auto.addEventListener('change', () => (limits.autonomy = auto.value as Autonomy));
      body.append(
        h('div', { class: 'np-field' }, h('span', {}, 'Buy parts from'), dist),
        h('label', { class: 'np-field' }, h('span', {}, 'Smallest passive package'), pkg),
        h('div', { class: 'np-field' }, h('span', {}, 'Packages to avoid (hand soldering, inspection)'), avoid),
        h('label', { class: 'np-field' }, h('span', {}, 'Parts budget'), budget),
        h('label', { class: 'np-field' }, h('span', {}, 'Copper layers'), layers),
        h('label', { class: 'np-field' }, h('span', {}, 'Board size'), size),
        h('label', { class: 'np-field' }, h('span', {}, 'Choosing parts'), auto, h('span', { class: 'dim' }, 'Ask every time: you pick each part. Automatic: the AI picks within these limits and lists its choices.')),
      );
    } else {
      const backends = readyBackends(status);
      if (!backends.some((b) => b.id === backend)) backend = backends[0]?.id ?? 'claude';
      const pick = h('select', {}, ...backends.map((b) => h('option', { value: b.id, ...(b.id === backend ? { selected: true } : {}) }, b.label))) as HTMLSelectElement;
      pick.addEventListener('change', () => (backend = pick.value as Backend));
      const given = SPEC_FIELDS.filter((f) => f.key !== 'goal' && (spec[f.key] ?? '').trim());
      body.append(
        h('div', { class: 'np-summary' }, h('b', {}, 'Build: '), description.trim()),
        h('div', { class: 'np-summary' }, h('b', {}, 'Requirements: '), given.length ? given.map((f) => `${f.label}: ${spec[f.key]}`).join(' · ') : 'all proposed by the AI'),
        h('div', { class: 'np-summary' }, h('b', {}, 'Limits: '), `${limits.distributors.join(', ') || 'any distributor'} · smallest ${limits.smallestPackage}${limits.avoid?.length ? ` · no ${limits.avoid.join(', ')}` : ''}${limits.budget ? ` · ${limits.budget}` : ''} · ${limits.layers} layers${limits.boardSize ? ` · ${limits.boardSize}` : ''} · ${AUTONOMY_LABEL[limits.autonomy]}`),
        h('label', { class: 'np-field' }, h('span', {}, 'AI that does the work'), pick),
      );
      if (!userName || userName.startsWith('Guest ')) {
        const n = h('input', { placeholder: 'Shown to collaborators' }) as HTMLInputElement;
        n.addEventListener('input', () => (userName = n.value.trim()));
        body.append(h('label', { class: 'np-field' }, h('span', {}, 'Your name'), n));
      }
      body.append(h('p', { class: 'dim' }, 'Start creates the project on the collaboration server (a private link) and the AI begins with the requirements. It stops after each stage; you continue or ask for changes in the Agent tab.'));
    }

    next.addEventListener('click', async () => {
      if (step < STEPS.length - 1) return wizard(step + 1);
      (next as HTMLButtonElement).disabled = true;
      next.textContent = 'Starting…';
      try {
        await start();
        dlg.close();
      } catch (e) {
        (next as HTMLButtonElement).disabled = false;
        next.textContent = 'Start';
        body.append(h('div', { class: 'err-text' }, (e as Error).message));
      }
    });
    dlg.append(h('div', { class: 'row' }, back, next));
  };

  const start = async () => {
    if (userName && !userName.startsWith('Guest ')) store.set('hassassin:user:name', userName);
    store.set('hassassin:agent:backend', backend);
    app.newProject();
    const fullSpec: Partial<Spec> = { ...spec, goal: description.trim() };
    app.apply('AI Full: wizard', [
      { op: 'setMeta', key: 'spec', value: fullSpec },
      { op: 'setMeta', key: 'agentLimits', value: limits as unknown as Record<string, unknown> },
      { op: 'setMeta', key: 'aiFlow', value: { mode: 'full', stage: 'requirements', waiting: false } },
      // The bundled web plugin for research (A2); left out with a note if a server does not have it.
      { op: 'setMeta', key: 'agentPlugins', value: ['web'] },
    ]);
    app.fileName = projectNameFrom(description);
    loaded();
    await collab.share();
    showLeft();
    // The Agent tab picks up the new shared project, then the work starts.
    await new Promise((r) => setTimeout(r, 400));
    app.agentStart?.(wizardPrompt({ description, spec: fullSpec, limits }));
  };

  dlg.append(h('p', { class: 'dim' }, 'Checking the AI…'));
  dlg.showModal();
  void fetch('/api/agent/status')
    .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
    .catch(() => null)
    .then((s) => {
      status = s;
      choose();
    });
}
