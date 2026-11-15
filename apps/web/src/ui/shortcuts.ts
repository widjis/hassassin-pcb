/**
 * Every keyboard and mouse shortcut of the layout, in one list, shown by ? or Ctrl+F1 (KiCad's "List
 * Hotkeys"). The keys follow the KiCad 8 PCB Editor's Actions reference where the browser and the existing
 * keys allow it, and EAGLE for the bend styles; the source of each is shown.
 */
import { clear, h } from './dom.ts';

export interface Shortcut {
  keys: string;
  what: string;
  /** Where the key comes from: KiCad, EAGLE, or our own (where the others' key is taken). */
  as?: 'KiCad' | 'EAGLE' | 'own';
  note?: string;
}

export const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: 'Tools',
    items: [
      { keys: 'S', what: 'Select', as: 'own' },
      { keys: 'X', what: 'Route a track', as: 'KiCad' },
      { keys: 'Q · Ctrl+Shift+M', what: 'Measure', as: 'KiCad', note: 'Q is ours' },
      { keys: 'Ctrl+Shift+F', what: 'Draw a copper pour', as: 'own', note: "KiCad's Ctrl+Shift+Z is Redo here" },
      { keys: 'Ctrl+Shift+K', what: 'Draw a keep-out area', as: 'KiCad' },
      { keys: 'Ctrl+Shift+P', what: 'Draw the board outline (polygon)', as: 'KiCad' },
      { keys: 'Ctrl+Shift+L', what: 'Draw a silkscreen line', as: 'KiCad' },
      { keys: 'T', what: 'Place text', as: 'own', note: "KiCad's Ctrl+Shift+T reopens a tab in the browser" },
      { keys: 'P', what: 'Part library', as: 'own' },
      { keys: 'Esc', what: 'Stop the tool, back to Select' },
    ],
  },
  {
    group: 'While routing',
    items: [
      { keys: 'Right button · Ctrl+/', what: 'Next corner mode: 45°, 90°, 45° rounded, 90° rounded, free', as: 'KiCad', note: 'right button as EAGLE' },
      { keys: 'Shift + right button · Ctrl+Shift+/', what: 'Previous corner mode' },
      { keys: '/', what: 'Flip the posture: which leg comes first (e.g. the bend goes up or down)', as: 'KiCad' },
      { keys: 'Backspace', what: 'Take the last placed segment or via back, go on from before it', as: 'KiCad' },
      { keys: 'Shift (held)', what: 'Free angle for this segment' },
      { keys: 'M', what: 'Walkaround → shove → free', as: 'own' },
      { keys: 'W · Shift+W', what: 'Next / previous track width', as: 'KiCad' },
      { keys: "V", what: 'Place a via, go to the other layer', as: 'KiCad' },
      { keys: "' · \\ · Shift+V", what: 'Bigger / smaller / next via size', as: 'KiCad' },
      { keys: 'Click', what: 'Place the segments; on a pad of the net: finish' },
      { keys: 'Double-click · Esc', what: 'Stop the route' },
    ],
  },
  {
    group: 'While drawing (pour, keep-out, outline, line)',
    items: [
      { keys: 'Right button', what: 'Next bend style (Shift: previous, Ctrl: the other way round)', as: 'EAGLE' },
      { keys: '0 – 7', what: 'Bend style by number (0 ⌐90°, 1 ⌐45°, 2 straight, 3 45°⌐, 4 90°⌐, 5 arc, 6 arc, 7 freehand arc)', as: 'EAGLE', note: 'SET WIRE_BEND n' },
      { keys: 'Shift+Space', what: 'Constrain to 45° / back to straight', as: 'KiCad' },
      { keys: 'Backspace', what: 'Take the last point back' },
      { keys: 'Enter · double-click · click the first point', what: 'Close the outline', as: 'KiCad' },
      { keys: 'Drag from the first point', what: 'A rectangle' },
    ],
  },
  {
    group: 'Selection and editing',
    items: [
      { keys: 'Drag on empty board', what: 'Box: left → right inside, right → left touching; Shift adds' },
      { keys: 'Drag an item', what: 'Move it (traces follow); one straight trace: drag it sideways' },
      { keys: 'R · Shift+R', what: 'Rotate counter-clockwise / clockwise', as: 'KiCad' },
      { keys: 'F', what: 'Flip the selected parts to the other side (nothing selected: flip the view)', as: 'KiCad' },
      { keys: 'K', what: 'Lock / unlock', as: 'own', note: "KiCad's L switches the layer here" },
      { keys: 'U', what: 'Unroute the selection (traces, vias; copper on selected parts\' pads)', as: 'own', note: 'KiCad Unroute Selected has no default key' },
      { keys: 'Shift+U', what: 'Unroute the nets of the selection', as: 'own', note: 'as EAGLE RIPUP signal' },
      { keys: 'Delete', what: 'Delete; on a corner handle: delete that corner', as: 'EAGLE', note: 'DELETE on a corner' },
      { keys: 'Shift / Alt + drag an edge handle', what: 'Insert a corner / bend the edge into an arc', as: 'EAGLE', note: 'SPLIT' },
      { keys: 'Ctrl+C · Ctrl+V · Ctrl+D', what: 'Copy · paste (follows the mouse) · duplicate', as: 'KiCad' },
      { keys: 'Ctrl+Z · Ctrl+Shift+Z · Ctrl+Y', what: 'Undo · redo', as: 'KiCad' },
      { keys: 'Ctrl+S', what: 'Save', as: 'KiCad' },
      { keys: 'B', what: 'Refill the pours', as: 'KiCad' },
    ],
  },
  {
    group: 'View and layers',
    items: [
      { keys: 'L', what: 'Switch the active copper layer', as: 'own' },
      { keys: 'PgUp · PgDn · +', what: 'F.Cu · B.Cu · next layer', as: 'KiCad' },
      { keys: '`', what: 'Highlight the net under the cursor (again: clear)', as: 'KiCad' },
      { keys: 'Space + drag · middle drag · two-finger scroll', what: 'Pan' },
      { keys: 'Wheel · pinch', what: 'Zoom' },
      { keys: 'Home · 0', what: 'Fit the board' },
      { keys: '3', what: '3D view' },
      { keys: 'Tab', what: 'Schematic' },
      { keys: 'C', what: 'Comment mode' },
      { keys: '? · Ctrl+F1', what: 'This list', as: 'KiCad' },
    ],
  },
];

let open: HTMLElement | null = null;

export function closeShortcuts(): boolean {
  if (!open) return false;
  open.remove();
  open = null;
  return true;
}

/** Show the list (or close it when it is open). */
export function toggleShortcuts(): void {
  if (closeShortcuts()) return;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const k = (s: string) => (isMac ? s.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : s);
  const box = h('div', { class: 'shortcuts', style: 'position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center' });
  const panel = h('div', { style: 'background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;width:min(980px, 94vw);box-sizing:border-box;max-height:84vh;overflow:auto;font-size:12px;box-shadow:0 10px 40px rgba(0,0,0,.5)' });
  clear(panel);
  panel.append(h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px' }, h('b', { style: 'font-size:14px' }, 'Keyboard and mouse shortcuts — layout'), h('span', { class: 'dim' }, 'Esc or ? closes')));
  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px, 100%),1fr));gap:14px 22px' });
  for (const g of SHORTCUTS) {
    const sec = h('div', {}, h('div', { style: 'color:var(--accent);font-weight:600;margin:4px 0 6px' }, g.group));
    for (const it of g.items)
      sec.append(
        h(
          'div',
          { style: 'display:grid;grid-template-columns:minmax(110px, 170px) 1fr;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)' },
          h('span', { style: 'font-family:var(--mono);color:var(--text)' }, k(it.keys)),
          h('span', {}, it.what, it.as && it.as !== 'own' ? h('span', { class: 'dim' }, ` · as ${it.as}${it.note ? ` (${it.note})` : ''}`) : it.note ? h('span', { class: 'dim' }, ` · ${it.note}`) : null),
        ),
      );
    grid.append(sec);
  }
  panel.append(grid);
  box.append(panel);
  box.addEventListener('click', (e) => e.target === box && closeShortcuts());
  document.body.append(box);
  open = box;
}
