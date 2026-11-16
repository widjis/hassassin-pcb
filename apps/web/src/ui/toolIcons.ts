/**
 * Line icons for the layout toolbar, drawn for this app in the style of the rail icons (20 × 20, 1.5 px
 * stroke). The button's name moves to its tooltip and aria-label; menus keep a small ▾.
 */
const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const TOOL_ICONS = {
  // An arrow pointer.
  select: svg('<path d="M5 3l10 6-4.4 1.3L13 15l-2 1-2.4-4.6L5 14z"/>'),
  // Two pads joined by a trace with a 45° bend.
  route: svg('<circle cx="4.5" cy="15.5" r="1.8"/><circle cx="15.5" cy="4.5" r="1.8"/><path d="M6.3 15.5H10l5.5-5.5V6.3"/>'),
  // A ruler.
  measure: svg('<path d="M3 13.5 13.5 3 17 6.5 6.5 17z"/><path d="m6 10.5 1.5 1.5M8.5 8 10 9.5M11 5.5l1.5 1.5"/>'),
  // A pen over a line.
  draw: svg('<path d="M12.5 3.5l4 4L8 16H4v-4z"/><path d="m10.5 5.5 4 4"/>'),
  // A trace cut between two pads.
  unroute: svg('<circle cx="3.8" cy="10" r="1.8"/><circle cx="16.2" cy="10" r="1.8"/><path d="M5.6 10h2.2M12.2 10h2.2"/><path d="m8.5 6.5 3 7M11.5 6.5l-3 7"/>'),
  // Two pads, a trace between them, and a spark: routed for you.
  autoroute: svg('<circle cx="4" cy="15.5" r="1.8"/><circle cx="16" cy="15.5" r="1.8"/><path d="M5.8 15.5h2.4l1.8-2.5 1.8 2.5h2.4"/><path d="M11 2.5 8.5 6.5h3L9 10.5"/>'),
  stop: svg('<rect x="5" y="5" width="10" height="10" rx="1.5"/>'),
  // Turning the board over: two opposite arrows.
  flip: svg('<path d="M3 7h12l-3-3M17 13H5l3 3"/>'),
  // Four corners: fit the board.
  fit: svg('<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>'),
  // A hatched area: copper poured.
  pour: svg('<rect x="3" y="4.5" width="14" height="11" rx="1"/><path d="M3 10l5.5-5.5M5 15.5 16 4.5M10.5 15.5 17 9"/>'),
  // The outline alone, dashed: the pour without its copper.
  unpour: svg('<rect x="3" y="4.5" width="14" height="11" rx="1" stroke-dasharray="2.2 2"/>'),
  // A funnel: what a box picks.
  pick: svg('<path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z"/>'),
} as const;

export type ToolIcon = keyof typeof TOOL_ICONS;

/** Put an icon on a button, its name in the tooltip (first) and aria-label; `menu` adds a ▾. */
export function iconize(btn: HTMLElement, icon: ToolIcon, name: string, menu = false): void {
  btn.classList.add('ico');
  btn.innerHTML = TOOL_ICONS[icon] + (menu ? '<span class="caret">▾</span>' : '');
  btn.setAttribute('aria-label', name);
  const t = btn.getAttribute('title') ?? '';
  if (!t.toLowerCase().startsWith(name.toLowerCase())) btn.title = t ? `${name} — ${t}` : name;
}
