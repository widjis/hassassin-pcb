/**
 * Quick tooltips (owner: "the tooltips take too long"). The browser shows a `title` only after about a
 * second and that delay cannot be changed, so this shows the same text after a short delay in its own box.
 * While the pointer is on an element its `title` is held aside (so the browser's own tooltip does not
 * show as well) and put back when the pointer leaves, unless the code set a new one meanwhile.
 */
const DELAY_MS = 150;
/** Once one tooltip is showing, moving to the next control shows its tooltip at once. */
const WARM_MS = 400;

let box: HTMLDivElement | null = null;
let current: HTMLElement | null = null;
let held = '';
let timer = 0;
let warmUntil = 0;

function ensureBox(): HTMLDivElement {
  if (box) return box;
  box = document.createElement('div');
  box.className = 'qtip';
  box.setAttribute('role', 'tooltip');
  document.body.append(box);
  return box;
}

function place(el: HTMLElement, text: string): void {
  const b = ensureBox();
  b.textContent = text;
  b.style.display = 'block';
  const r = el.getBoundingClientRect();
  const w = b.offsetWidth;
  const hgt = b.offsetHeight;
  // Below the control; above when there is no room; beside it for the side palettes.
  let x = r.left + r.width / 2 - w / 2;
  let y = r.bottom + 6;
  if (el.closest('.rail')) {
    const right = el.closest('.palette') !== null;
    x = right ? r.left - w - 8 : r.right + 8;
    y = r.top + r.height / 2 - hgt / 2;
  } else if (y + hgt > window.innerHeight - 4) y = r.top - hgt - 6;
  b.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, x))}px`;
  b.style.top = `${Math.max(4, Math.min(window.innerHeight - hgt - 4, y))}px`;
}

function hide(): void {
  clearTimeout(timer);
  if (box?.style.display === 'block') warmUntil = performance.now() + WARM_MS;
  if (box) box.style.display = 'none';
  if (current) {
    // Put the title back, unless the code gave it a new one while the pointer was on it.
    if (!current.getAttribute('title') && held) current.setAttribute('title', held);
    current = null;
    held = '';
  }
}

/** Start the quick tooltips for every element with a `title` in the page. */
export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[title]');
    if (el === current) return;
    hide();
    if (!el || e.pointerType === 'touch') return;
    const text = el.getAttribute('title') ?? '';
    if (!text) return;
    current = el;
    held = text;
    el.removeAttribute('title');
    const show = () => current === el && place(el, held);
    if (performance.now() < warmUntil) show();
    else timer = window.setTimeout(show, DELAY_MS);
  });
  document.addEventListener('pointerout', (e) => {
    if (current && !current.contains(e.relatedTarget as Node | null)) hide();
  });
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(ev, hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
}

/** The tooltip text of an element, also while the pointer is on it (its title is then held aside). */
export const tipOf = (el: HTMLElement): string => el.getAttribute('title') || (el === current ? held : '');
