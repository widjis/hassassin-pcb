import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper/web';
import { setClipper } from '@hassassin/core';
import { App, type Mode } from './app.ts';
import { mountInspector } from './ui/inspector.ts';
import { mountLayers } from './ui/layers.ts';
import { mountRules } from './ui/rules.ts';
import { mountReview } from './ui/review.ts';
import { mountTree } from './ui/tree.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = new App($<HTMLCanvasElement>('gl'), $<HTMLCanvasElement>('overlay'));
(window as unknown as { app: App }).app = app; // handy for debugging in the console

mountLayers(app, $('layersPanel'));
mountTree(app, $('treePanel'), $<HTMLInputElement>('treeFilter'));
mountRules(app, $('rulesPanel'));
mountInspector(app, $('inspector'));
mountReview(app, $('reviewPanel'), $('reviewBadge'));

// Polygon engine (WebAssembly) for pours; loads in the background.
loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmWithAsmJsFallback)
  .then((lib) => setClipper(lib as unknown as Parameters<typeof setClipper>[0]))
  .catch((e) => console.error('Geometry engine failed to load', e));

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

// ---- loading, saving, autosave ----
const AUTOSAVE = 'hassassin:autosave:v1';
const status = $('status');
const msg = $('msg');
let msgTimer = 0;
app.on('status', () => {
  msg.textContent = app.message;
  clearTimeout(msgTimer);
  if (app.message && app.mode !== 'route') msgTimer = window.setTimeout(() => (msg.textContent = ''), 4000);
});

const loadText = (text: string, name: string) => {
  try {
    app.load(text, name);
    $('dropHint').classList.add('hidden');
    $('docTitle').textContent = app.fileName;
  } catch (e) {
    alert(`Could not open ${name}:\n${(e as Error).message}`);
  }
};

const save = () => {
  if (!app.doc) return;
  const blob = new Blob([app.serialize()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${app.fileName || 'board'}.hpcb`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  app.dirty = false;
  app.say(`Saved ${a.download}`);
};

let autosaveTimer = 0;
app.on('change', () => {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE, JSON.stringify({ name: app.fileName, at: Date.now(), data: app.serialize() }));
    } catch {
      /* storage full or blocked: autosave is best-effort */
    }
  }, 800);
});

$<HTMLInputElement>('fileInput').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) loadText(await f.text(), f.name);
  input.value = '';
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
} else {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTOSAVE) ?? 'null') as { name: string; at: number; data: string } | null;
    if (saved?.data) {
      const btn = $<HTMLButtonElement>('restoreBtn');
      btn.textContent = `Restore “${saved.name}” (autosaved ${new Date(saved.at).toLocaleString()})`;
      btn.classList.remove('hidden');
      btn.addEventListener('click', () => loadText(saved.data, `${saved.name}.hpcb`));
    }
  } catch {
    /* ignore unreadable autosave */
  }
}
window.addEventListener('beforeunload', (e) => {
  if (app.dirty) e.preventDefault();
});

// ---- toolbar ----
const tools = $('tools');
tools.addEventListener('click', (e) => {
  const m = (e.target as HTMLElement).closest('button')?.dataset.mode as Mode | undefined;
  if (m) app.setMode(m);
});
const layerBtn = $<HTMLButtonElement>('layerBtn');
layerBtn.addEventListener('click', () => app.toggleActiveLayer());
$('undoBtn').addEventListener('click', () => app.undo());
$('redoBtn').addEventListener('click', () => app.redo());
$('saveBtn').addEventListener('click', save);
$('pourBtn').addEventListener('click', () => app.refillPours());
$('fabBtn').addEventListener('click', () => {
  const r = app.exportFab();
  if (!r) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(r.blob);
  a.download = r.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  app.say(`Exported ${r.name}${r.notes.length ? ' — ' + r.notes[0] : ''}`);
});
$('fitBtn').addEventListener('click', () => app.fit());
$('flipBtn').addEventListener('click', () => app.flip());
const syncToolbar = () => {
  for (const b of tools.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.mode === app.mode);
  wrap.classList.toggle('route', app.mode === 'route');
  layerBtn.textContent = app.activeLayer;
  layerBtn.style.borderColor = app.activeLayer === 'B.Cu' ? '#3d8bff' : '#ef6a4c';
  const h = app.history;
  $<HTMLButtonElement>('undoBtn').disabled = !h?.canUndo;
  $<HTMLButtonElement>('redoBtn').disabled = !h?.canRedo;
  $('undoBtn').title = h?.undoLabel ? `Undo ${h.undoLabel} (Cmd/Ctrl+Z)` : 'Undo';
  $('redoBtn').title = h?.redoLabel ? `Redo ${h.redoLabel} (Shift+Cmd/Ctrl+Z)` : 'Redo';
  $('docTitle').textContent = app.fileName ? `${app.fileName}${app.dirty ? ' •' : ''}` : 'No board';
};
for (const ev of ['mode', 'change', 'doc'] as const) app.on(ev, syncToolbar);
app.on('view', () => ($('flipBtn').textContent = app.view.flipped ? 'Bottom' : 'Top'));
syncToolbar();

// ---- canvas interaction ----
const canvas = app.glCanvas;
type Drag = { x: number; y: number; moved: boolean; kind: 'pan' | 'move' };
let drag: Drag | null = null;
const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
};

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return;
  canvas.setPointerCapture(e.pointerId);
  const { sx, sy } = local(e);
  const middle = e.button === 1;
  let kind: Drag['kind'] = 'pan';
  if (app.mode === 'select' && !middle) {
    const uid = app.pickAt(sx, sy, e.metaKey || e.ctrlKey);
    if (uid && app.movable(uid)) {
      if (!app.selection.has(uid)) app.select([uid], e.shiftKey);
      kind = 'move';
      app.beginMove(app.toWorld(sx, sy));
    }
  }
  drag = { x: e.clientX, y: e.clientY, moved: false, kind };
});

canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = local(e);
  const world = app.toWorld(sx, sy);
  app.cursor = world;
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.moved) {
      if (drag.kind === 'pan') {
        app.panBy(dx, dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
      } else app.dragMove(world, !e.altKey);
    }
  }
  if (app.mode === 'route') {
    app.route.hover(world, e.shiftKey);
    app.requestRender();
  } else if (!drag?.moved) app.hoverUid = app.pickAt(sx, sy, e.metaKey || e.ctrlKey);
  updateStatus();
});

canvas.addEventListener('pointerup', (e) => {
  const { sx, sy } = local(e);
  if (drag?.kind === 'move') app.endMove();
  if (drag && !drag.moved && e.button === 0) {
    if (app.mode === 'route') app.route.click(app.toWorld(sx, sy), e.shiftKey);
    else {
      const uid = app.pickAt(sx, sy, e.metaKey || e.ctrlKey);
      if (uid) {
        if (!(app.selection.has(uid) && !e.shiftKey && app.selection.size === 1)) app.select([uid], e.shiftKey);
      } else if (!e.shiftKey) app.select([]);
    }
  }
  drag = null;
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (app.mode === 'route' && app.route.active) app.route.cancel();
});
canvas.addEventListener('dblclick', () => {
  if (app.mode === 'route' && app.route.active) app.route.cancel();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { sx, sy } = local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-120, Math.min(120, e.deltaY * unit));
    app.zoomAt(sx, sy, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
    updateStatus();
  },
  { passive: false },
);

// ---- keyboard ----
window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return save();
  }
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return e.shiftKey ? app.redo() : app.undo();
  }
  if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    return app.redo();
  }
  if (mod) return;
  switch (e.key) {
    case 'Escape':
      if (app.mode === 'route' && app.route.active) app.route.cancel();
      else if (app.mode === 'route') app.setMode('select');
      else app.select([]);
      break;
    case 'x':
    case 'X':
      app.setMode('route');
      break;
    case 's':
    case 'S':
      app.setMode('select');
      break;
    case 'v':
    case 'V':
      if (app.mode === 'route') app.route.placeVia();
      break;
    case '/':
      if (app.mode === 'route') app.route.togglePosture();
      break;
    case 'l':
    case 'L':
      app.toggleActiveLayer();
      break;
    case 'b':
    case 'B':
      app.refillPours();
      break;
    case 'r':
      app.rotateSelection(90);
      break;
    case 'R':
      app.rotateSelection(-90);
      break;
    case 'Delete':
    case 'Backspace':
      if (app.mode === 'select') app.deleteSelection();
      break;
    case 'f':
    case 'F':
      app.flip();
      break;
    case 'Home':
    case '0':
      app.fit();
      break;
    default:
      return;
  }
  e.preventDefault();
});

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
  const hovText = app.mode === 'select' && hov ? `  ·  ${hov.type} ${hov.name || hov.props.number || ''}` : '';
  const rn = app.ratsnest.lines.length;
  status.textContent = `x ${app.cursor.x.toFixed(3)}  y ${app.cursor.y.toFixed(3)} mm  ·  ${app.view.scale.toFixed(1)} px/mm  ·  ${rn} unrouted${hovText}`;
}
for (const ev of ['doc', 'change'] as const) app.on(ev, updateStatus);
