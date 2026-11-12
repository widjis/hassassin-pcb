/**
 * The icon rail on the canvas edge. Each icon opens one tool panel (layers, rules, review …) as a
 * flyout over the canvas, so the left panel stays free for the agent. Clicking the open icon again,
 * the × or Esc closes it.
 */
import { h } from './dom.ts';

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Simple line icons drawn for this app. */
const ICONS: Record<string, string> = {
  project: svg('<path d="M4 5h5l1.5 2H16v8H4z"/>'),
  parts: svg('<rect x="6" y="6" width="8" height="8" rx="1"/><path d="M8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3"/>'),
  board: svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="6" cy="7" r="0.8"/><circle cx="14" cy="13" r="0.8"/><path d="M6 7.8V11h5l3 2"/>'),
  layers: svg('<path d="M10 3 3 7l7 4 7-4z"/><path d="m3 10.5 7 4 7-4"/><path d="m3 13.5 7 4 7-4" opacity="0.6"/>'),
  objects: svg('<path d="M4 5h3M4 10h3M4 15h3M9 5h7M11 10h5M11 15h5"/>'),
  rules: svg('<path d="M4 6h12M4 10h8M4 14h10"/><circle cx="14" cy="10" r="1.6"/>'),
  review: svg('<path d="M10 3 4 5.5V10c0 3.5 2.6 6 6 7 3.4-1 6-3.5 6-7V5.5z"/><path d="m7.5 10 1.8 1.8L12.8 8"/>'),
  comments: svg('<path d="M4 5h12v8H9l-3 3v-3H4z"/>'),
  history: svg('<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/>'),
  help: svg('<circle cx="10" cy="10" r="7"/><path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5"/><circle cx="10" cy="14" r="0.4" fill="currentColor"/>'),
};

export interface RailEntry {
  id: string;
  title: string;
  /** Id for a count badge on the icon (the panel's own code fills it). */
  badge?: string;
  /** Placed at the bottom of the rail. */
  bottom?: boolean;
}

export interface Rail {
  show(id: string): void;
  close(): void;
  readonly open: string | null;
}

export function mountRail(rail: HTMLElement, flyout: HTMLElement, entries: RailEntry[]): Rail {
  const title = flyout.querySelector<HTMLElement>('#flyoutTitle')!;
  let open: string | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const top = h('div', { class: 'rail-group' });
  const bottom = h('div', { class: 'rail-group' });
  for (const e of entries) {
    const b = h('button', { class: 'rail-btn', title: e.title, 'aria-label': e.title, onclick: () => (open === e.id ? api.close() : api.show(e.id)) });
    b.innerHTML = ICONS[e.id] ?? '';
    if (e.badge) b.append(h('span', { id: e.badge, class: 'badge rail-badge' }));
    buttons.set(e.id, b);
    (e.bottom ? bottom : top).append(b);
  }
  rail.append(top, bottom);

  const sections = () => flyout.querySelectorAll<HTMLElement & { refresh?: () => void }>('.tab-body');
  const api: Rail = {
    show(id) {
      open = id;
      for (const [k, b] of buttons) b.classList.toggle('on', k === id);
      title.textContent = entries.find((e) => e.id === id)?.title ?? '';
      flyout.classList.remove('hidden');
      for (const s of sections()) {
        s.classList.toggle('hidden', s.dataset.body !== id);
        if (s.dataset.body === id) s.refresh?.();
      }
    },
    close() {
      open = null;
      for (const b of buttons.values()) b.classList.remove('on');
      flyout.classList.add('hidden');
    },
    get open() {
      return open;
    },
  };
  flyout.querySelector('#flyoutClose')?.addEventListener('click', () => api.close());
  return api;
}
