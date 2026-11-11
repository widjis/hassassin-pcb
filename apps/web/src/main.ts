import { App } from './app.ts';
import { screenToWorld } from './render/gl.ts';
import { mountInspector } from './ui/inspector.ts';
import { mountLayers } from './ui/layers.ts';
import { mountRules } from './ui/rules.ts';
import { mountTree } from './ui/tree.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = new App($<HTMLCanvasElement>('gl'), $<HTMLCanvasElement>('overlay'));
(window as unknown as { app: App }).app = app; // handy for debugging in the console

mountLayers(app, $('layersPanel'));
mountTree(app, $('treePanel'), $<HTMLInputElement>('treeFilter'));
mountRules(app, $('rulesPanel'));
mountInspector(app, $('inspector'));

// ---- left tabs ----
const tabs = $('leftTabs');
const showTab = (name: string) => {
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll<HTMLElement>('.tab-body')) s.classList.toggle('hidden', s.dataset.body !== name);
};
tabs.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button')?.dataset.tab;
  if (t) showTab(t);
});
app.on('inspect', () => {
  if (app.inspected.kind === 'ruleset') showTab('rules');
});

// ---- loading ----
const status = $('status');
const loadText = (text: string, name: string) => {
  try {
    app.load(text, name);
    $('dropHint').classList.add('hidden');
    $('docTitle').textContent = name;
  } catch (e) {
    alert(`Could not open ${name}:\n${(e as Error).message}`);
  }
};
$<HTMLInputElement>('fileInput').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadText(await f.text(), f.name);
});
const wrap = $('canvasWrap');
wrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  wrap.classList.add('dragging');
});
wrap.addEventListener('dragleave', () => wrap.classList.remove('dragging'));
wrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  wrap.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadText(await f.text(), f.name);
});
const boardParam = new URLSearchParams(location.search).get('board');
if (boardParam) {
  fetch(boardParam)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((t) => loadText(t, decodeURIComponent(boardParam.split('/').pop() ?? boardParam)))
    .catch((e) => (status.textContent = `Could not load ${boardParam}: ${(e as Error).message}`));
}

// ---- canvas interaction ----
const canvas = app.glCanvas;
let drag: { x: number; y: number; moved: boolean; id: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.moved || Math.hypot(dx, dy) > 3) {
      drag.moved = true;
      app.panBy(dx, dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
    }
  }
  app.cursor = screenToWorld(app.view, r.width, r.height, sx, sy);
  if (!drag?.moved) app.hoverUid = app.pickAt(sx, sy, e.metaKey || e.ctrlKey);
  updateStatus();
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    const r = canvas.getBoundingClientRect();
    const uid = app.pickAt(e.clientX - r.left, e.clientY - r.top, e.metaKey || e.ctrlKey);
    if (uid) app.select([uid], e.shiftKey);
    else if (!e.shiftKey) app.select([]);
  }
  drag = null;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    // Normalise line/page deltas and clamp so one big wheel event cannot jump 30×.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
    app.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    updateStatus();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'f' || e.key === 'F') app.flip();
  else if (e.key === 'Home' || e.key === '0') app.fit();
  else if (e.key === 'Escape') app.select([]);
});
$('fitBtn').addEventListener('click', () => app.fit());
$('flipBtn').addEventListener('click', () => app.flip());
app.on('view', () => ($('flipBtn').textContent = app.view.flipped ? 'Bottom' : 'Top'));

// ---- selector query ----
const query = $<HTMLInputElement>('query');
const queryInfo = $('queryInfo');
let qTimer = 0;
query.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = window.setTimeout(() => app.runQuery(query.value), 120);
});
query.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && app.queryMatches.size) app.select([...app.queryMatches]);
  if (e.key === 'Escape') {
    query.value = '';
    app.runQuery('');
  }
});
app.on('query', () => {
  query.classList.toggle('bad', !!app.queryError);
  queryInfo.textContent = app.queryError ? 'invalid selector' : app.queryText ? `${app.queryMatches.size} match${app.queryMatches.size === 1 ? '' : 'es'} · Enter selects` : '';
  queryInfo.title = app.queryError ?? '';
});

function updateStatus(): void {
  const hov = app.hoverUid ? app.node(app.hoverUid) : undefined;
  const hovText = hov ? `  ·  ${hov.type} ${hov.name || hov.props.number || ''}` : '';
  status.textContent = `x ${app.cursor.x.toFixed(3)}  y ${app.cursor.y.toFixed(3)} mm  ·  ${app.view.scale.toFixed(1)} px/mm${hovText}`;
}
app.on('doc', updateStatus);
