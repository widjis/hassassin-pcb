/**
 * Line icons for the layout toolbar, drawn for this app in the style of the rail icons (20 × 20, 1.5 px
 * stroke). The button's name moves to its tooltip and aria-label; menus keep a small ▾.
 */
import { tipOf } from './tooltip.ts';

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const TOOL_ICONS = {
  // An arrow pointer.
  select: svg('<path d="M5 3l10 6-4.4 1.3L13 15l-2 1-2.4-4.6L5 14z"/>'),
  // Two pads joined by a trace with a 45° bend.
  route: svg('<circle cx="4.5" cy="15.5" r="1.8"/><circle cx="15.5" cy="4.5" r="1.8"/><path d="M6.3 15.5H10l5.5-5.5V6.3"/>'),
  // A ruler.
  measure: svg('<path d="M3 13.5 13.5 3 17 6.5 6.5 17z"/><path d="m6 10.5 1.5 1.5M8.5 8 10 9.5M11 5.5l1.5 1.5"/>'),
  // A trace cut between two pads.
  unroute: svg('<circle cx="3.8" cy="10" r="1.8"/><circle cx="16.2" cy="10" r="1.8"/><path d="M5.6 10h2.2M12.2 10h2.2"/><path d="m8.5 6.5 3 7M11.5 6.5l-3 7"/>'),
  // Two pads, a trace between them, and a spark: routed for you.
  autoroute: svg('<circle cx="4" cy="15.5" r="1.8"/><circle cx="16" cy="15.5" r="1.8"/><path d="M5.8 15.5h2.4l1.8-2.5 1.8 2.5h2.4"/><path d="M11 2.5 8.5 6.5h3L9 10.5"/>'),
  stop: svg('<rect x="5" y="5" width="10" height="10" rx="1.5"/>'),
  // Turning the board over: two opposite arrows.
  flip: svg('<path d="M3 7h12l-3-3M17 13H5l3 3"/>'),
  // Four corners: fit the board.
  fit: svg('<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>'),
  // Drawing a pour: a hatched polygon with its corner points.
  pour: svg('<path d="M3.5 7 9 3.5l7.5 3V16h-13z"/><path d="M3.5 12 9 6.5M3.5 16l9.5-9.5M8.5 16l8-8M13 16l3.5-3.5"/>'),
  // Filling the pours: a paint bucket.
  fill: svg('<path d="m3.5 9.5 6-6 6 6-6 6z"/><path d="M3.5 9.5h12"/><path d="M17.5 13.5c0 1-.6 1.7-1.3 1.7s-1.3-.7-1.3-1.7c0-.8 1.3-2.3 1.3-2.3s1.3 1.5 1.3 2.3z"/>'),
  // A keep-out area: a box crossed out.
  keepout: svg('<rect x="3" y="3" width="14" height="14" rx="1"/><path d="m3 3 14 14M17 3 3 17"/>'),
  // The board outline as a polygon: corners joined.
  'outline-poly': svg('<path d="M3 6.5 8 3h9v9l-4 5H3z"/><circle cx="3" cy="6.5" r="1" fill="currentColor"/><circle cx="17" cy="3" r="1" fill="currentColor"/><circle cx="13" cy="17" r="1" fill="currentColor"/>'),
  // The board outline as a rectangle with rounded corners.
  'outline-rect': svg('<rect x="3" y="4" width="14" height="12" rx="2.5"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="17" cy="16" r="1" fill="currentColor"/>'),
  // A silkscreen line with bends.
  line: svg('<path d="M3 15 8 7l4 6 5-9"/>'),
  // Text.
  text: svg('<path d="M4.5 5V3.5h11V5M10 3.5V16.5M7.5 16.5h5"/>'),
  // A mounting hole: a plated ring round the drill.
  hole: svg('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="3"/>'),
  // A fiducial: a dot in a clear ring, with cross hairs.
  fiducial: svg('<circle cx="10" cy="10" r="6.5" stroke-dasharray="2 1.6"/><circle cx="10" cy="10" r="2.2" fill="currentColor"/><path d="M10 1.5v2.5M10 16v2.5M1.5 10H4M16 10h2.5"/>'),
  // Delete: a bin.
  delete: svg('<path d="M4 5.5h12M8 5.5V3.5h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5"/>'),
  // The outline alone, dashed: the pour without its copper.
  unpour: svg('<rect x="3" y="4.5" width="14" height="11" rx="1" stroke-dasharray="2.2 2"/>'),
  // A funnel: what a box picks.
  pick: svg('<path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z"/>'),
  // ---- schematic
  'sch-select': svg('<path d="M5 3l10 6-4.4 1.3L13 15l-2 1-2.4-4.6L5 14z"/>'),
  // A wire with a bend and a junction dot.
  'sch-wire': svg('<path d="M3 15h7V5h7"/><circle cx="10" cy="15" r="1.4" fill="currentColor"/>'),
  // A bus: a thick line with wires leaving it.
  'sch-bus': svg('<path d="M3 6.5h14" stroke-width="3.2"/><path d="m6 8 2.5 2.5V16M12 8l2.5 2.5V16"/>'),
  // A bus entry: the 45° stub between a bus and a wire.
  'sch-entry': svg('<path d="M4 3v14" stroke-width="3.2"/><path d="m5.5 9 3.5 3.5H17"/>'),
  // A net label: a tag on a wire.
  label: svg('<path d="M2.5 14h4"/><path d="M6.5 14V9.5L9 7h8.5v7z"/><path d="M10.5 10.5h4"/>'),
  // A sub-sheet: a block with pins on its edge.
  subsheet: svg('<rect x="5" y="3.5" width="10" height="13" rx="1"/><path d="M2 7.5h3M2 12.5h3M15 10h3"/><path d="M7.5 6.5h5" opacity="0.6"/>'),
  // A part: an IC symbol with a plus.
  part: svg('<rect x="5" y="5" width="8" height="10" rx="1"/><path d="M2.5 8H5M2.5 12H5M13 8h2"/><path d="M16 11.5v5M13.5 14h5"/>'),
  // Annotate: references numbered in order.
  annotate: svg('<path d="M3 5h3M3 10h3M3 15h3"/><path d="M8.5 5h8M8.5 10h8M8.5 15h8" opacity="0.6"/><path d="M4.5 3.5V6.5M4 8.5h1.5l-1.5 3h2M3.5 13.5h2l-1 1.2h.3a1 1 0 0 1 0 2H3.5" stroke-width="1"/>'),
  // A drawing frame with its title block.
  frame: svg('<rect x="2.5" y="3.5" width="15" height="13" rx="1"/><path d="M10.5 16.5v-4h7M10.5 14.5h7"/>'),
  // Export: an arrow out of a tray.
  export: svg('<path d="M10 3v9M6.5 6.5 10 3l3.5 3.5"/><path d="M4 11v5h12v-5"/>'),
  // Compact: blocks drawn together.
  compact: svg('<rect x="2.5" y="7" width="4" height="6" rx="0.8"/><rect x="13.5" y="7" width="4" height="6" rx="0.8"/><path d="M8 10h4M10.3 8.3 12 10l-1.7 1.7M9.7 8.3 8 10l1.7 1.7"/>'),
  // Tidy wires: a crooked wire made straight.
  tidy: svg('<path d="M3 6.5 6 4l3 3.5 2.5-2.5" opacity="0.6"/><path d="M3 14.5h7.5V11H17"/><path d="m15 9 2 2-2 2"/>'),
  // Update PCB: from the schematic (a wire) to the board.
  'to-pcb': svg('<path d="M2.5 6h5" /><circle cx="7.5" cy="6" r="1.2" fill="currentColor"/><rect x="10.5" y="9" width="7" height="8" rx="1"/><path d="M5 9.5v3.5h4M7.7 11.3 9.5 13l-1.8 1.7"/>'),
  // Update from PCB: from the board back to the schematic.
  'from-pcb': svg('<rect x="2.5" y="3" width="7" height="8" rx="1"/><path d="M12.5 14h5"/><circle cx="12.5" cy="14" r="1.2" fill="currentColor"/><path d="M6 11.5V15h4M8.2 13.3 10 15l-1.8 1.7"/>'),
} as const;

export type ToolIcon = keyof typeof TOOL_ICONS;

/** The names of the palette's tools, for their tooltips and aria-labels. */
export const PALETTE_NAMES: Partial<Record<ToolIcon, string>> = {
  select: 'Select',
  route: 'Route',
  measure: 'Measure',
  pour: 'Copper pour',
  keepout: 'Keep-out area',
  'outline-poly': 'Board outline, polygon',
  'outline-rect': 'Board outline, rectangle',
  line: 'Silkscreen line',
  text: 'Text',
  hole: 'Mounting hole',
  fiducial: 'Fiducial',
  delete: 'Delete',
  'sch-select': 'Select',
  'sch-wire': 'Wire',
  'sch-bus': 'Bus',
  'sch-entry': 'Bus entry',
};

/** Put an icon on a button, its name in the tooltip (first) and aria-label; `menu` adds a ▾. */
export function iconize(btn: HTMLElement, icon: ToolIcon, name: string, menu = false): void {
  btn.classList.add('ico');
  btn.innerHTML = TOOL_ICONS[icon] + (menu ? '<span class="caret">▾</span>' : '');
  btn.setAttribute('aria-label', name);
  const t = tipOf(btn);
  if (!t.toLowerCase().startsWith(name.toLowerCase())) btn.title = t ? `${name} — ${t}` : name;
}
