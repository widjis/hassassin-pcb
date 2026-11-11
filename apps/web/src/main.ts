import { loadNativeClipperLibInstanceAsync, NativeClipperLibRequestedFormat } from 'js-angusj-clipper/web';
import { PART_KINDS, setClipper, type PartKind } from '@hassassin/core';
import { App, type Mode, type Space } from './app.ts';
import { SchematicView } from './sch/view.ts';
import { Collab } from './collab.ts';
import { mountCollabBar, mountComments, mountHistory, openShareDialog } from './ui/collabUi.ts';
import type { DocNode, Vec2 } from '@hassassin/core';
import { mountProject } from './ui/project.ts';
import { mountParts } from './ui/parts.ts';
import { mountAgent } from './ui/agent.ts';
import { mountBoard } from './ui/board.ts';
import { initResizers } from './ui/resize.ts';
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
mountProject(app, $('projectPanel'));
const sch = new SchematicView(app, $<HTMLCanvasElement>('sch'));
mountReview(app, $('reviewPanel'), $('reviewBadge'), (v) => {
  app.setSpace('schematic');
  if (v.sheet && v.sheet !== sch.sheet()?.uid) sch.openSheet(v.sheet);
  sch.view.cx = v.at.x;
  sch.view.cy = v.at.y;
  sch.view.scale = Math.max(sch.view.scale, 12);
  app.select(v.uids.filter((u) => app.node(u)));
  app.focusedViolation = v.id;
  app.emit('drc');
  sch.requestRender();
});
(window as unknown as { sch: SchematicView }).sch = sch;

// Polygon engine (WebAssembly) for pours; loads in the background.
loadNativeClipperLibInstanceAsync(NativeClipperLibRequestedFormat.WasmWithAsmJsFallback)
  .then((lib) => setClipper(lib as unknown as Parameters<typeof setClipper>[0]))
  .catch((e) => console.error('Geometry engine failed to load', e));

initResizers(document.querySelector<HTMLElement>('.workspace')!);

// ---- left tabs ----
const tabs = $('leftTabs');
const showTab = (name: string) => {
  for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll<HTMLElement>('.tab-body')) s.classList.toggle('hidden', s.dataset.body !== name);
  (document.querySelector<HTMLElement>(`.tab-body[data-body="${name}"]`) as (HTMLElement & { refresh?: () => void }) | null)?.refresh?.();
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

const loaded = () => {
  $('dropHint').classList.add('hidden');
  $('docTitle').textContent = app.fileName;
  sch.sheetUid = null;
  sch.fit();
};
const loadText = (text: string, name: string) => {
  try {
    app.load(text, name);
    loaded();
  } catch (e) {
    alert(`Could not open ${name}:\n${(e as Error).message}`);
  }
};
const loadFiles = async (list: FileList | File[]) => {
  const files = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
  try {
    app.loadProject(files);
    loaded();
  } catch (e) {
    alert(`Could not open the files:\n${(e as Error).message}`);
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
  if (input.files?.length) await loadFiles(input.files);
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
  if (e.dataTransfer?.files?.length) await loadFiles(e.dataTransfer.files);
});

const params = new URLSearchParams(location.search);
const boardParam = params.get('board');
const schParam = params.get('sch'); // comma-separated URLs of .kicad_sch files
if (boardParam || schParam) {
  const urls = [...(boardParam ? [boardParam] : []), ...(schParam ? schParam.split(',') : [])];
  Promise.all(urls.map((u) => fetch(u).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${u}: HTTP ${r.status}`)))).then((text) => ({ name: decodeURIComponent(u.split('/').pop() ?? u), text }))))
    .then((files) => {
      app.loadProject(files);
      loaded();
      if (params.get('view') === 'schematic') app.setSpace('schematic');
    })
    .catch((e) => (status.textContent = `Could not load: ${(e as Error).message}`));
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
// ---- layout / schematic spaces ----
const spaces = $('spaces');
spaces.addEventListener('click', (e) => {
  const s = (e.target as HTMLElement).closest('button')?.dataset.space as Space | undefined;
  if (s) app.setSpace(s);
});
const sheetSelect = $<HTMLSelectElement>('sheetSelect');
const syncSpace = () => {
  const schMode = app.space === 'schematic';
  for (const b of spaces.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.space === app.space);
  $('schTools').classList.toggle('hidden', !schMode);
  $('sch').classList.toggle('hidden', !schMode);
  app.glCanvas.classList.toggle('hidden', schMode);
  app.overlay.classList.toggle('hidden', schMode);
  wrap.classList.toggle('sch-mode', schMode);
  tools.classList.toggle('hidden', schMode);
  $('layerBtn').classList.toggle('hidden', schMode);
  $('flipBtn').classList.toggle('hidden', schMode);
  // sheet list
  sheetSelect.replaceChildren(
    ...sch.sheets().map((s) => {
      const o = document.createElement('option');
      o.value = s.uid;
      o.textContent = s.name === 'Root' ? 'Root sheet' : `↳ ${s.name}`;
      o.selected = s.uid === sch.sheet()?.uid;
      return o;
    }),
  );
  if (schMode) sch.requestRender();
  else app.requestRender();
};
sheetSelect.addEventListener('change', () => sch.openSheet(sheetSelect.value));
for (const ev of ['space', 'doc', 'sheet'] as const) app.on(ev, syncSpace);
for (const ev of ['change', 'selection', 'drc'] as const) app.on(ev, () => app.space === 'schematic' && sch.requestRender());
const schToolSeg = $('schToolSeg');
schToolSeg.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button')?.dataset.tool as 'select' | 'wire' | undefined;
  if (t) sch.setTool(t);
});
app.on('mode', () => {
  for (const b of schToolSeg.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.tool === sch.tool);
});
const partSelect = $<HTMLSelectElement>('partSelect');
for (const k of PART_KINDS) {
  const o = document.createElement('option');
  o.value = k.kind;
  o.textContent = k.label;
  partSelect.append(o);
}
const addPart = (kind: PartKind) => {
  const pins = kind === 'ic' || kind === 'connector' ? Number(prompt('How many pins?', kind === 'ic' ? '8' : '4')) : undefined;
  if (pins !== undefined && !(pins > 0)) return;
  sch.addPart(kind, pins ? { pins } : {});
};
partSelect.addEventListener('change', () => {
  if (partSelect.value) addPart(partSelect.value as PartKind);
  partSelect.value = '';
});
const placeLabel = () => {
  const name = prompt('Net label name (prefix with * for a global label):');
  if (!name?.trim()) return;
  const global = name.trim().startsWith('*');
  sch.addLabel(sch.cursorPoint, global ? name.trim().slice(1) : name.trim(), global ? 'global' : 'local');
};
$('labelBtn').addEventListener('click', placeLabel);
$('syncBtn').addEventListener('click', () => void app.syncToPcb());
const openLibrary = () => {
  showTab('parts');
  app.emit('parts');
};
$('libBtn').addEventListener('click', openLibrary);
$('newBtn').addEventListener('click', () => {
  if (app.dirty && !confirm('Discard unsaved changes and start a new project?')) return;
  app.newProject();
  loaded();
});
showTab('layers');

// ---- collaboration ----
const collab = new Collab(app);
(window as unknown as { collab: Collab }).collab = collab;
mountCollabBar(app, collab, $('collabBar'), () => openShareDialog(app, collab));
const focusComment = (c: DocNode) => {
  app.focusedComment = c.uid;
  showTab('comments');
  const at: Vec2 = { x: Number(c.props.x), y: Number(c.props.y) };
  if (c.props.space === 'schematic') {
    app.setSpace('schematic');
    if (typeof c.props.sheet === 'string' && c.props.sheet !== sch.sheet()?.uid && app.node(c.props.sheet)) sch.openSheet(c.props.sheet);
    sch.view.cx = at.x;
    sch.view.cy = at.y;
    sch.requestRender();
  } else {
    app.setSpace('layout');
    app.view.cx = at.x;
    app.view.cy = at.y;
    app.requestRender();
  }
  app.emit('comments');
};
mountComments(app, collab, $('commentsPanel'), focusComment);
mountHistory(app, collab, $('historyPanel'));
mountAgent(app, collab, $('agentPanel'));
mountParts(app, $('partsPanel'), {
  place: (part, extra) => {
    if (!app.doc) return app.say('Open or create a project first.');
    app.setSpace('schematic');
    sch.placePart(part, extra);
  },
  shareAuth: () => (app.collab && collab.session && app.collab.role === 'edit' ? { project: collab.session.id, token: collab.session.token, author: collab.user.name } : null),
});
app.on('comments', () => {
  const open = app.comments().filter((c) => !c.props.resolved).length;
  $('commentBadge').textContent = open ? String(open) : '';
  $('commentBadge').className = `badge${open ? ' ok' : ''}`;
  sch.requestRender();
  app.requestRender();
});
app.on('selection', () => collab.presence(lastCursor));
let lastCursor: { space: 'layout' | 'schematic'; sheet?: string; x: number; y: number } | null = null;
const placeComment = (space: 'layout' | 'schematic', p: Vec2, sheet?: string) => {
  app.commentMode = false;
  app.emit('comments');
  if (!app.collab) return app.say('Share the project first; comments are stored on the collaboration server.');
  const text = prompt('Comment:');
  if (!text?.trim()) return;
  const blocking = confirm('Mark as blocking? (It must be resolved before the Review stage is green.)');
  app.addComment({ space, ...(sheet ? { sheet } : {}), x: p.x, y: p.y }, text.trim(), collab.user.name, collab.user.color, blocking);
  showTab('comments');
};
sch.onCursor = (p) => {
  lastCursor = { space: 'schematic', ...(sch.sheet() ? { sheet: sch.sheet()!.uid } : {}), x: p.x, y: p.y };
  collab.presence(lastCursor);
};
sch.onPlaceComment = (p) => placeComment('schematic', p, sch.sheet()?.uid);
sch.onCommentClick = focusComment;
{
  const p = new URLSearchParams(location.search);
  const pid = p.get('p');
  const tok = p.get('t');
  if (pid && tok) {
    collab
      .join(pid, tok)
      .then(() => {
        loaded();
        if (p.get('view') === 'schematic') app.setSpace('schematic');
      })
      .catch((e) => alert(`Could not open the shared project: ${(e as Error).message}`));
  }
}

const layerBtn = $<HTMLButtonElement>('layerBtn');
layerBtn.addEventListener('click', () => app.toggleActiveLayer());
$('undoBtn').addEventListener('click', () => app.undo());
$('redoBtn').addEventListener('click', () => app.redo());
$('saveBtn').addEventListener('click', save);
$('pourBtn').addEventListener('click', () => app.refillPours());
mountBoard(app, $('boardPanel'));

// ---- 3D view (three.js is loaded on first use) ----
let board3d: import('./render/view3d.ts').Board3D | null = null;
let rebuild3d = 0;
const host3d = $('view3d');
const toggle3d = async () => {
  const on = host3d.classList.toggle('hidden') === false;
  $('view3dBtn').classList.toggle('on', on);
  if (!on) return;
  if (!board3d) {
    const { Board3D } = await import('./render/view3d.ts');
    board3d = new Board3D(host3d);
  }
  board3d.build(app);
};
$('view3dBtn').addEventListener('click', () => void toggle3d());
app.on('change', () => {
  if (!board3d || host3d.classList.contains('hidden')) return;
  clearTimeout(rebuild3d);
  rebuild3d = window.setTimeout(() => board3d?.build(app), 300);
});
app.on('doc', () => board3d && !host3d.classList.contains('hidden') && board3d.build(app));
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
  lastCursor = { space: 'layout', x: world.x, y: world.y };
  collab.presence(lastCursor);
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
  if (drag && !drag.moved && e.button === 0 && app.commentMode) {
    drag = null;
    return placeComment('layout', app.toWorld(sx, sy));
  }
  const pin = drag && !drag.moved && e.button === 0 ? app.commentAt('layout', undefined, sx, sy, (q) => worldToScreenPx(q)) : null;
  if (pin) {
    drag = null;
    return focusComment(pin);
  }
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
  if (mod && app.space === 'schematic') {
    const k = e.key.toLowerCase();
    if (k === 'c') return void (e.preventDefault(), sch.copySelection());
    if (k === 'v') return void (e.preventDefault(), sch.paste());
    if (k === 'd') return void (e.preventDefault(), sch.duplicateSelection());
  }
  if (mod) return;
  if (e.key === 'c' || e.key === 'C') {
    app.commentMode = !app.commentMode;
    app.emit('comments');
    app.say(app.commentMode ? 'Click where the comment should go.' : '');
    return e.preventDefault();
  }
  if (e.key === '3') return void toggle3d();
  if (e.key === 'p' || e.key === 'P') return openLibrary();
  if (app.space === 'schematic') {
    switch (e.key) {
      case 'Escape':
        if (sch.cancelPaste()) break;
        if (sch.tool === 'wire') sch.setTool('select');
        else app.select([]);
        break;
      case 'w':
      case 'W':
        sch.setTool('wire');
        break;
      case '/':
        sch.toggleCorner();
        break;
      case 'l':
      case 'L':
        placeLabel();
        break;
      case 'a':
      case 'A':
        partSelect.focus();
        partSelect.showPicker?.();
        break;
      case 'r':
      case 'R':
        sch.rotateSelection();
        break;
      case 'x':
      case 'X':
        sch.mirrorSelection('h');
        break;
      case 'y':
      case 'Y':
        sch.mirrorSelection('v');
        break;
      case 'Delete':
      case 'Backspace':
        sch.deleteSelection();
        break;
      case 'u':
      case 'U': {
        const s = sch.sheet();
        const block = s?.parent ? app.node(s.parent) : undefined;
        const up = block?.type === 'block' && block.parent ? app.node(block.parent) : undefined;
        if (up?.type === 'sheet') sch.openSheet(up.uid);
        break;
      }
      case 'Home':
      case '0':
        sch.fit();
        break;
      case 'Tab':
        app.setSpace('layout');
        break;
      default:
        return;
    }
    return e.preventDefault();
  }
  switch (e.key) {
    case 'Tab':
      app.setSpace('schematic');
      break;
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

function worldToScreenPx(p: Vec2): Vec2 {
  const r = app.glCanvas.getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  const dx = (p.x - app.view.cx) * app.view.scale;
  return { x: w / 2 + (app.view.flipped ? -dx : dx), y: h / 2 + (p.y - app.view.cy) * app.view.scale };
}
