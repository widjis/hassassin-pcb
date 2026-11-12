/**
 * Resizable side panels: drag the edge between a panel and the canvas. Widths are kept
 * per browser. Double-click an edge to restore the default width.
 */
const KEY = 'hassassin:layout';
const DEFAULT = { left: 270, right: 320 };
/** The inspector opens on its own when something is selected, so it never gets narrower than this. */
const MIN_RIGHT = 240;

let widths = { ...DEFAULT };
let ws: HTMLElement | null = null;

function apply() {
  if (!ws) return;
  ws.style.setProperty('--left-w', `${widths.left}px`);
  ws.style.setProperty('--right-w', `${widths.right}px`);
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('resize'));
}

const clamp = (side: 'left' | 'right', w: number) => {
  const max = Math.max(320, window.innerWidth - (side === 'left' ? widths.right : widths.left) - 240);
  return Math.round(Math.min(max, Math.max(side === 'left' ? 220 : MIN_RIGHT, w)));
};

export function initResizers(workspace: HTMLElement): void {
  ws = workspace;
  try {
    widths = { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    if (widths.right > 0 && widths.right < MIN_RIGHT) widths.right = DEFAULT.right;
  } catch {
    /* ignore */
  }
  for (const side of ['left', 'right'] as const) {
    const handle = document.createElement('div');
    handle.className = `resizer ${side}`;
    handle.title = 'Drag to resize · double-click to reset';
    workspace.append(handle);
    handle.addEventListener('dblclick', () => ((widths[side] = DEFAULT[side]), apply()));
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('active');
      document.body.classList.add('resizing');
      const startX = e.clientX;
      const start = widths[side];
      const move = (m: PointerEvent) => {
        const dx = m.clientX - startX;
        widths[side] = clamp(side, side === 'left' ? start + dx : start - dx);
        apply();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
  }
  apply();
}

/** Toggle a wide left panel (for long chats) and back. */
let before: number | null = null;
export function toggleWideLeft(): boolean {
  if (before === null) {
    before = widths.left;
    widths.left = clamp('left', Math.round(window.innerWidth * 0.45));
  } else {
    widths.left = before;
    before = null;
  }
  apply();
  return before !== null;
}

/** Collapse / restore the right (inspector) panel. */
let rightBefore: number | null = null;
export function toggleRight(): boolean {
  if (rightBefore === null) {
    rightBefore = widths.right || DEFAULT.right;
    widths.right = 0;
  } else {
    widths.right = rightBefore;
    rightBefore = null;
  }
  apply();
  return rightBefore !== null;
}
