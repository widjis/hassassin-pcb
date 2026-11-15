/**
 * Drawing tools on the board (P6, P6b in docs/05-pcb-improvements.md): the board outline (a rectangle with
 * optional rounded corners, or a polygon), copper pours, keep-out areas, silkscreen lines and text,
 * mounting holes and fiducials, and editing the corners and edges of a selected outline, pour or keep-out.
 * Each finished shape goes through the same tool the agents use (one undo step).
 *
 * Drawing follows EAGLE (help: WIRE, POLYGON, SET WIRE_BEND, MITER, SPLIT, DELETE): click the corners;
 * the right mouse button steps through the bend styles (Shift: backwards, Ctrl: the corresponding style),
 * the miter rounds (+) or cuts (−) the bend's corner; the segment being drawn and the closing line are
 * dashed. Backspace takes the last point back; Enter, a double-click or a click on the first point closes;
 * Esc stops. A drag from the first point draws a rectangle.
 *
 * Editing (select mode, as KiCad's zone handles): square handles drag a corner, round handles on edge
 * midpoints drag the edge; Shift + drag on an edge handle inserts a corner there (SPLIT), Alt + drag bends
 * the edge into an arc through the pointer; Delete with the pointer on a corner removes it.
 */
import { arcPoints, BEND_PARTNER, BEND_STYLES, bendPath, dist, isBoardMovable, keepoutAreas, newUid, snapToGrid, type DocNode, type Op, type Vec2 } from '@hassassin/core';
import { runTool, type Project } from '@hassassin/tools';
import type { App } from '../app.ts';
import { h } from '../ui/dom.ts';

export type DrawKind = 'outline-rect' | 'outline-poly' | 'pour' | 'keepout' | 'line' | 'text' | 'hole' | 'fiducial';

export const DRAW_KINDS: { kind: DrawKind; label: string; hint: string }[] = [
  { kind: 'outline-rect', label: 'Board outline (rectangle)', hint: 'Drag from corner to corner; then set the corner radius.' },
  { kind: 'outline-poly', label: 'Board outline (polygon)', hint: 'Click the corners · right button: bend style (Shift back, Ctrl other way) · Backspace undo point · Enter or double-click closes.' },
  { kind: 'pour', label: 'Copper pour', hint: 'Click the corners (drag for a rectangle) · right button: bend style · Enter or double-click closes; then the net, layers and pour settings.' },
  { kind: 'keepout', label: 'Keep-out area', hint: 'Click the corners (drag for a rectangle) · right button: bend style · Enter closes; then what it forbids.' },
  { kind: 'line', label: 'Silkscreen line', hint: 'Click the start, then each bend · right button: bend style · Esc stops.' },
  { kind: 'text', label: 'Text', hint: 'Click where the text goes.' },
  { kind: 'hole', label: 'Mounting hole', hint: 'Click where the hole goes.' },
  { kind: 'fiducial', label: 'Fiducial', hint: 'Click where the fiducial goes.' },
];

/** A tool-ready view of the editor's board whose edits all land in one undo step (keyed by `key`). */
function toolProject(app: App, key: string): Project {
  const history = new Proxy(app.history!, {
    get(t, k) {
      if (k === 'apply') return (label: string, ops: Op[]) => t.apply(label, ops, key);
      const v = Reflect.get(t, k) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { name: app.fileName || 'board', doc: app.doc!, engine: app.engine!, history, layers: app.layers, copper: app.copper, dirty: false };
}

const fmtPts = (pts: Vec2[]) => pts.map((p) => `${+p.x.toFixed(4)} ${+p.y.toFixed(4)}`).join(', ');

export class DrawTool {
  kind: DrawKind = 'outline-poly';
  /** Points so far (world, snapped); arcs and mitred corners already expanded into points. */
  private pts: Vec2[] = [];
  /** The points that were clicked (marked while drawing). */
  private clicks: Vec2[] = [];
  /** EAGLE wire bend style 0–7 (see `BEND_STYLES`). */
  bend = 2;
  /** Miter radius (mm): + rounds the bend's corner, − cuts it, 0 leaves it sharp. */
  miter = 0;
  private rectFrom: Vec2 | null = null;
  private cursor: Vec2 | null = null;
  private popup: HTMLElement | null = null;
  /** Corner drag (select mode): the item, which point, and the undo key. */
  private vertex: { uid: string; rule: string; index: number; key: string; mode: 'corner' | 'edge' | 'split' | 'bend'; orig: Vec2[]; from: Vec2 } | null = null;

  private app: App;
  constructor(app: App) {
    this.app = app;
  }

  get busy(): boolean {
    return this.pts.length > 0 || !!this.rectFrom || !!this.popup;
  }

  hint(): string {
    return DRAW_KINDS.find((d) => d.kind === this.kind)?.hint ?? '';
  }

  start(kind: DrawKind): void {
    this.cancel();
    this.kind = kind;
    this.app.setMode('draw');
    this.app.emit('mode');
    this.app.say(`${DRAW_KINDS.find((d) => d.kind === kind)?.label}: ${this.hint()}`);
  }

  cancel(): void {
    this.pts = [];
    this.clicks = [];
    this.rectFrom = null;
    this.closePopup();
    this.app.requestRender();
  }

  /** The path from the last point to `q` in the current bend style. */
  private pathTo(q: Vec2): Vec2[] {
    const last = this.pts[this.pts.length - 1]!;
    const prev = this.pts.length > 1 ? this.pts[this.pts.length - 2]! : undefined;
    return bendPath(last, q, this.bend, { ...(prev ? { prevDir: { x: last.x - prev.x, y: last.y - prev.y } } : {}), miter: this.miter });
  }

  /** The right mouse button (EAGLE): the next bend style; Shift the previous; Ctrl the corresponding one. */
  cycleBend(back: boolean, partner: boolean): void {
    this.bend = partner ? BEND_PARTNER[this.bend]! : (this.bend + (back ? 7 : 1)) % 8;
    this.app.say(`Bend ${this.bend}: ${BEND_STYLES[this.bend]!.label}${this.miter && [0, 1, 3, 4].includes(this.bend) ? ` · miter ${this.miter} mm` : ''}`);
    this.app.emit('mode');
    this.app.requestRender();
  }

  private snap(p: Vec2): Vec2 {
    const s = snapToGrid(p, this.app.gridStep() / 2);
    // Close onto the first point when near it.
    if (this.pts.length > 2 && dist(p, this.pts[0]!) < 8 / this.app.view.scale) return this.pts[0]!;
    return s;
  }

  private polygonKind(): boolean {
    return this.kind === 'outline-poly' || this.kind === 'pour' || this.kind === 'keepout';
  }

  hover(p: Vec2): void {
    this.cursor = this.snap(p);
    this.app.requestRender();
  }

  /** Pointer down in draw mode (a drag from here draws a rectangle for rectangle-like kinds). */
  down(p: Vec2): void {
    if (this.popup) return;
    if (this.kind === 'outline-rect' || ((this.kind === 'pour' || this.kind === 'keepout') && !this.pts.length)) this.rectFrom = this.snap(p);
  }

  /** Pointer up: `dragged` when the pointer moved since down. */
  up(p: Vec2, dragged: boolean): void {
    if (this.popup) return;
    const q = this.snap(p);
    if (this.rectFrom && dragged && dist(this.rectFrom, q) > 1e-6) {
      const a = this.rectFrom;
      this.rectFrom = null;
      return this.finishShape([a, { x: q.x, y: a.y }, q, { x: a.x, y: q.y }], true);
    }
    if (this.kind === 'outline-rect') {
      // Two clicks: first corner, then the opposite one.
      if (!this.pts.length) return void (this.pts = [q], (this.rectFrom = null));
      const a = this.pts[0]!;
      this.pts = [];
      this.rectFrom = null;
      return this.finishShape([a, { x: q.x, y: a.y }, q, { x: a.x, y: q.y }], true);
    }
    this.rectFrom = null;
    if (this.kind === 'text' || this.kind === 'hole' || this.kind === 'fiducial') return this.placeAt(q);
    if (this.kind === 'line') {
      if (!this.pts.length) return void ((this.pts = [q]), (this.clicks = [q]));
      // The pieces of this bend become silkscreen lines, in one undo step; drawing goes on from here.
      const path = this.pathTo(q);
      if (path.length < 2) return;
      void this.runMany(path.slice(1).map((b, i) => ['add_line', { x1: path[i]!.x, y1: path[i]!.y, x2: b.x, y2: b.y, layer: 'F.SilkS' }] as const));
      this.pts = path.slice(-2);
      this.clicks = [q];
      return;
    }
    // Polygon kinds.
    if (this.clicks.length > 2 && q === this.clicks[0]) return this.close();
    if (!this.pts.length) {
      this.pts = [q];
      this.clicks = [q];
    } else {
      this.pts.push(...this.pathTo(q).slice(1));
      this.clicks.push(q);
    }
    this.app.requestRender();
  }

  /** A double-click closes a polygon. */
  dblclick(): void {
    if (this.polygonKind() && this.clicks.length > 2) this.close();
  }

  key(e: KeyboardEvent): boolean {
    if (this.popup) return false;
    if (e.key === 'Escape') {
      if (this.busy) this.cancel();
      else this.app.setMode('select');
      return true;
    }
    if (e.key === 'Enter' && this.polygonKind() && this.clicks.length > 2) return this.close(), true;
    if (e.key === 'Backspace' && this.clicks.length) {
      // Back to the previous click (the whole bend that led to the last one goes).
      this.clicks.pop();
      const back = this.clicks[this.clicks.length - 1];
      if (!back) this.pts = [];
      else {
        let i = this.pts.length - 1;
        while (i > 0 && this.pts[i] !== back) i--;
        this.pts = this.pts.slice(0, i + 1);
      }
      this.app.requestRender();
      return true;
    }
    return false;
  }

  private close(): void {
    // The outline closes with a straight edge back to the first point (as EAGLE and KiCad).
    const pts = this.pts.filter((p, i) => i === 0 || dist(p, this.pts[i - 1]!) > 1e-6);
    if (pts.length > 1 && dist(pts[0]!, pts[pts.length - 1]!) < 1e-6) pts.pop();
    this.pts = [];
    this.clicks = [];
    this.finishShape(pts, false);
  }

  /** A closed shape was drawn: ask what is needed, then create it. */
  private finishShape(pts: Vec2[], rect: boolean): void {
    const app = this.app;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (this.kind === 'outline-rect' || (this.kind === 'outline-poly' && rect)) {
      return this.form('Board outline', [{ key: 'r', label: 'Corner radius (mm)', value: '0' }], (v) => void this.run('set_board_outline', { ...box, corner_radius: Number(v.r) || 0 }, 'Board outline set.'));
    }
    if (this.kind === 'outline-poly') return void this.run('set_board_outline', { points: fmtPts(pts) }, 'Board outline set.');
    const area = rect ? box : { points: fmtPts(pts) };
    if (this.kind === 'pour') {
      const nets = [...app.doc!.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)').map((n) => n.name).sort();
      const sel = [...app.selection].map((u) => app.netOf(u)).find(Boolean);
      const def = sel ?? nets.find((n) => /gnd/i.test(n)) ?? nets[0] ?? '';
      return this.form(
        'Copper pour',
        [
          { key: 'net', label: 'Net', value: def, options: nets },
          { key: 'layers', label: 'Layers', value: app.activeLayer, options: [app.activeLayer, ...app.copper.filter((l) => l !== app.activeLayer), app.copper.join(' ')] },
          { key: 'priority', label: 'Priority (KiCad priority / EAGLE rank; higher fills first)', value: '0' },
          { key: 'clearance', label: 'Clearance (EAGLE isolate), mm', value: '' },
          { key: 'minWidth', label: 'Minimum width, mm', value: '' },
          { key: 'pads', label: 'Pad connection', value: 'thermal', options: ['thermal', 'solid', 'none'] },
          { key: 'spoke', label: 'Thermal spoke width, mm', value: '' },
        ],
        (v) =>
          void this.run(
            'add_pour',
            {
              net: v.net,
              layers: v.layers,
              priority: Number(v.priority) || 0,
              pad_connection: v.pads,
              ...(Number(v.clearance) > 0 ? { clearance: Number(v.clearance) } : {}),
              ...(Number(v.minWidth) > 0 ? { min_width: Number(v.minWidth) } : {}),
              ...(Number(v.spoke) > 0 ? { spoke_width: Number(v.spoke) } : {}),
              ...area,
            },
            `Pour of ${v.net} added and filled.`,
          ),
      );
    }
    if (this.kind === 'keepout') {
      return this.form(
        'Keep-out area',
        [
          { key: 'layers', label: 'Layers', value: app.copper.join(' '), options: [app.copper.join(' '), ...app.copper] },
          { key: 'forbid', label: 'Forbids', value: 'traces vias pours', checks: ['traces', 'vias', 'pours', 'parts'] },
        ],
        (v) => void this.run('add_keepout', { layers: v.layers, forbid: v.forbid, ...area }, 'Keep-out area added.'),
      );
    }
  }

  private placeAt(q: Vec2): void {
    if (this.kind === 'text') return this.form('Text', [{ key: 'text', label: 'Text', value: '' }, { key: 'size', label: 'Height (mm)', value: '1' }, { key: 'layer', label: 'Layer', value: 'F.SilkS', options: ['F.SilkS', 'B.SilkS', 'F.Fab', ...this.app.copper] }], (v) => v.text && void this.run('add_text', { text: v.text, x: q.x, y: q.y, size: Number(v.size) || 1, layer: v.layer }));
    if (this.kind === 'hole')
      return this.form(
        'Mounting hole',
        [
          { key: 'size', label: 'Screw', value: 'm3', options: ['m2', 'm2.5', 'm3', 'm4'] },
          { key: 'plated', label: 'Plated', value: '', checks: ['plated'] },
          { key: 'net', label: 'Net (plated only)', value: '', options: ['', ...[...this.app.doc!.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)').map((n) => n.name).sort()] },
        ],
        (v) => void this.run('add_mounting_hole', { x: q.x, y: q.y, size: v.size, plated: v.plated === 'plated', ...(v.plated === 'plated' && v.net ? { net: v.net } : {}) }),
      );
    if (this.kind === 'fiducial') return void this.run('add_fiducial', { x: q.x, y: q.y });
  }

  /** Run an agent tool on the editor's board as one undo step. */
  private async run(tool: string, args: Record<string, unknown>, done?: string): Promise<void> {
    const app = this.app;
    if (!app.doc || !app.history) return;
    const key = newUid('draw');
    try {
      const r = (await runTool(toolProject(app, key), tool, args)) as Record<string, unknown>;
      app.history.seal();
      const ref = typeof r?.ref === 'string' ? `${r.ref} placed.` : '';
      const hits = Array.isArray(r?.violations) && r.violations.length ? ` ${r.violations.length} item(s) are in it now (see Review).` : '';
      app.say(`${done ?? (ref || 'Done.')}${hits}`);
    } catch (e) {
      app.history.seal();
      app.say((e as Error).message);
    }
    app.requestRender();
  }

  /** Several tool calls as one undo step. */
  private async runMany(calls: readonly (readonly [string, Record<string, unknown>])[]): Promise<void> {
    const app = this.app;
    if (!app.doc || !app.history) return;
    const key = newUid('draw');
    try {
      for (const [tool, args] of calls) await runTool(toolProject(app, key), tool, args);
    } catch (e) {
      app.say((e as Error).message);
    }
    app.history.seal();
    app.requestRender();
  }

  // ---------- a small form next to the canvas ----------

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  private form(title: string, fields: { key: string; label: string; value: string; options?: string[]; checks?: string[] }[], ok: (v: Record<string, string>) => unknown): void {
    this.closePopup();
    const inputs = new Map<string, () => string>();
    const rows = fields.map((f) => {
      if (f.checks) {
        const boxes = f.checks.map((c) => h('input', { type: 'checkbox', ...(f.value.split(/\s+/).includes(c) ? { checked: true } : {}) }) as HTMLInputElement);
        inputs.set(f.key, () => f.checks!.filter((_, i) => boxes[i]!.checked).join(' '));
        return h('div', { style: 'display:grid;gap:3px' }, h('span', { class: 'dim' }, f.label), h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, ...f.checks.map((c, i) => h('label', { style: 'display:flex;gap:4px;align-items:center' }, boxes[i]!, c))));
      }
      let el: HTMLInputElement | HTMLSelectElement;
      if (f.options) {
        el = h('select', {}, ...[...new Set(f.options)].map((o) => h('option', { value: o, ...(o === f.value ? { selected: true } : {}) }, o || '(none)')));
      } else el = h('input', { value: f.value, style: 'width:100%' });
      inputs.set(f.key, () => el.value.trim());
      return h('label', { style: 'display:grid;gap:3px' }, h('span', { class: 'dim' }, f.label), el);
    });
    const submit = () => {
      const v = Object.fromEntries([...inputs].map(([k, get]) => [k, get()]));
      this.closePopup();
      void ok(v);
    };
    const box = h(
      'form',
      { class: 'draw-form', style: 'position:fixed;z-index:70;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:grid;gap:8px;min-width:220px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.45)' },
      h('b', {}, title),
      ...rows,
      h('div', { style: 'display:flex;gap:6px;justify-content:flex-end' }, h('button', { type: 'button', onclick: () => (this.closePopup(), this.app.say('Cancelled.'), this.app.requestRender()) }, 'Cancel'), h('button', { type: 'submit', class: 'primary' }, 'OK')),
    );
    box.addEventListener('submit', (e) => (e.preventDefault(), submit()));
    box.addEventListener('keydown', (e) => e.stopPropagation());
    const r = this.app.glCanvas.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left + 70}px`, top: `${r.top + 60}px` });
    document.body.append(box);
    this.popup = box;
    (box.querySelector('input:not([type=checkbox]), select') as HTMLElement | null)?.focus();
  }

  // ---------- corner handles of a selected outline, pour or keep-out (select mode) ----------

  /**
   * Handles of the selected shapes: corners (square) and, on outlines with corner points, edge midpoints
   * (round; `edge` is the index of the edge's first corner).
   */
  private handles(): { uid: string; rule: string; index: number; at: Vec2; edge?: boolean }[] {
    const app = this.app;
    const out: { uid: string; rule: string; index: number; at: Vec2; edge?: boolean }[] = [];
    if (!app.doc || !app.engine || app.selection.size > 3) return out;
    for (const uid of app.selection) {
      const n: DocNode | undefined = app.doc.nodes.get(uid);
      if (!n || !isBoardMovable(app.doc, n) || n.type === 'element' || n.type === 'via' || n.type === 'text' || n.props.locked) continue;
      const pts = app.engine.get(uid, 'points')?.value;
      if (Array.isArray(pts)) {
        const P = pts as Vec2[];
        P.forEach((at, index) => out.push({ uid, rule: 'points', index, at }));
        P.forEach((a, index) => {
          const b = P[(index + 1) % P.length]!;
          if (dist(a, b) * app.view.scale > 24) out.push({ uid, rule: 'points', index, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, edge: true });
        });
      }
      for (const r of n.type === 'line' || n.type === 'arc' ? ['start', 'end'] : []) {
        const v = app.engine.get(uid, r)?.value as Vec2 | undefined;
        if (v) out.push({ uid, rule: r, index: -1, at: v });
      }
    }
    return out;
  }

  /** Start dragging a handle under the pointer (Shift on an edge: insert a corner; Alt: bend it into an arc). */
  beginVertex(world: Vec2, mods: { shift?: boolean; alt?: boolean } = {}): boolean {
    const tol = 6 / this.app.view.scale;
    const hs = this.handles().filter((h1) => dist(h1.at, world) < tol);
    const h0 = hs.find((x) => !x.edge) ?? hs[0];
    if (!h0) return false;
    const orig = h0.index >= 0 ? ((this.app.engine!.get(h0.uid, h0.rule)?.value as Vec2[]) ?? []).map((p) => ({ ...p })) : [];
    const mode = !h0.edge ? 'corner' : mods.shift ? 'split' : mods.alt ? 'bend' : 'edge';
    this.vertex = { uid: h0.uid, rule: h0.rule, index: h0.index, key: newUid('vx'), mode, orig, from: world };
    return true;
  }

  /** Delete with the pointer on a corner of a selected outline: that corner goes (EAGLE DELETE). */
  deleteCornerAt(world: Vec2): boolean {
    const tol = 6 / this.app.view.scale;
    const h0 = this.handles().find((x) => !x.edge && x.index >= 0 && dist(x.at, world) < tol);
    if (!h0) return false;
    const pts = ((this.app.engine!.get(h0.uid, h0.rule)?.value as Vec2[]) ?? []).slice();
    if (pts.length <= 3) return (this.app.say('An outline keeps at least three corners.'), true);
    pts.splice(h0.index, 1);
    const key = newUid('vx');
    this.app.apply('Remove corner', [{ op: 'setRule', uid: h0.uid, name: h0.rule, decl: { name: h0.rule, value: pts } }], key);
    this.afterShapeEdit(h0.uid, key);
    return true;
  }

  get draggingVertex(): boolean {
    return !!this.vertex;
  }

  dragVertex(world: Vec2): void {
    const v = this.vertex;
    const app = this.app;
    if (!v || !app.engine) return;
    const q = snapToGrid(world, app.gridStep() / 2);
    let value: Vec2 | Vec2[];
    let label = 'Move corner';
    if (v.index < 0) value = q;
    else {
      // Always from the outline as it was when the drag began.
      const pts = v.orig.map((p) => ({ ...p }));
      const i = v.index;
      const j = (i + 1) % pts.length;
      if (v.mode === 'corner') pts[i] = q;
      else if (v.mode === 'edge') {
        const d = snapToGrid({ x: world.x - v.from.x, y: world.y - v.from.y }, app.gridStep() / 2);
        pts[i] = { x: v.orig[i]!.x + d.x, y: v.orig[i]!.y + d.y };
        pts[j] = { x: v.orig[j]!.x + d.x, y: v.orig[j]!.y + d.y };
        label = 'Move edge';
      } else if (v.mode === 'split') {
        pts.splice(i + 1, 0, q);
        label = 'Insert corner';
      } else {
        // Bend the edge into an arc through the pointer.
        const arc = arcPoints(v.orig[i]!, q, v.orig[j]!).slice(1, -1).map((p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 }));
        pts.splice(i + 1, 0, ...arc);
        label = 'Bend edge';
      }
      value = pts;
    }
    app.apply(label, [{ op: 'setRule', uid: v.uid, name: v.rule, decl: { name: v.rule, value } }], v.key);
  }

  endVertex(): void {
    const v = this.vertex;
    this.vertex = null;
    if (v) this.afterShapeEdit(v.uid, v.key);
  }

  /** A pour, keep-out or the board outline changed shape: fill the pours again, in the same undo step. */
  private afterShapeEdit(uid: string, key: string): void {
    const n = this.app.node(uid);
    const outline = this.app.engine?.get(uid, 'layer')?.value === 'Edge.Cuts';
    if (n?.type === 'fill' || n?.type === 'zone' || outline) this.app.refillPours({ mergeKey: key, quiet: true });
    this.app.history?.seal();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, S: (p: Vec2) => Vec2): void {
    const app = this.app;
    // Keep-out areas: a red dashed outline with a light hatch, so they read as "nothing here".
    if (app.doc && app.engine)
      for (const z of keepoutAreas(app.doc, app.engine, app.copper)) {
        if (!z.layers.some((l) => app.visible.has(l))) continue;
        const pts = z.poly.map(S);
        ctx.save();
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,80,80,0.08)';
        ctx.fill();
        ctx.clip();
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        ctx.strokeStyle = 'rgba(255,90,90,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = x0 - (y1 - y0); t < x1; t += 8) (ctx.moveTo(t, y1), ctx.lineTo(t + (y1 - y0), y0));
        ctx.stroke();
        ctx.restore();
        ctx.save();
        ctx.strokeStyle = app.selection.has(z.uid) ? 'rgba(255,200,120,0.95)' : 'rgba(255,90,90,0.85)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    // Corner handles of the selection (select mode).
    if (app.mode === 'select')
      for (const h1 of this.handles()) {
        const s = S(h1.at);
        ctx.fillStyle = h1.edge ? 'rgba(150,230,255,0.95)' : 'rgba(242,169,59,0.95)';
        ctx.strokeStyle = 'rgba(20,20,24,0.9)';
        ctx.lineWidth = 1;
        if (h1.edge) {
          ctx.beginPath();
          ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
          ctx.strokeRect(s.x - 4 + 0.5, s.y - 4 + 0.5, 8, 8);
        }
      }
    if (app.mode !== 'draw') return;
    const c = this.cursor ?? app.cursor;
    const color = this.kind === 'keepout' ? 'rgba(255,90,90,0.95)' : this.kind === 'pour' ? 'rgba(120,200,255,0.95)' : 'rgba(242,215,90,0.95)';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    const from = this.rectFrom ?? (this.kind === 'outline-rect' ? this.pts[0] : undefined);
    if (from) {
      const a = S(from);
      const b = S(c);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.setLineDash([]);
    } else if (this.pts.length) {
      const poly = (pts: Vec2[]) => {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const s = S(p);
          if (i) ctx.lineTo(s.x, s.y);
          else ctx.moveTo(s.x, s.y);
        });
        ctx.stroke();
      };
      // Placed segments solid; the bend being drawn dashed; the closing line back to the start dashed and dim.
      poly(this.pts);
      ctx.setLineDash([6, 4]);
      poly(this.pathTo(c));
      if (this.polygonKind() && this.clicks.length >= 2) {
        ctx.strokeStyle = color.replace('0.95', '0.45');
        poly([c, this.pts[0]!]);
        ctx.strokeStyle = color;
      }
      ctx.setLineDash([]);
      for (const p of this.clicks) {
        const s = S(p);
        ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
      }
    }
    // The bend style (and miter) next to the cursor.
    if (this.kind !== 'text' && this.kind !== 'hole' && this.kind !== 'fiducial' && this.kind !== 'outline-rect') {
      const s0 = S(c);
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(230,235,245,0.9)';
      ctx.fillText(`bend ${this.bend} ${BEND_STYLES[this.bend]!.short}${this.miter && [0, 1, 3, 4].includes(this.bend) ? ` · miter ${this.miter}` : ''}`, s0.x + 12, s0.y + 10);
      ctx.fillStyle = color;
    }
    // Cursor cross.
    const s = S(c);
    ctx.beginPath();
    ctx.moveTo(s.x - 8, s.y);
    ctx.lineTo(s.x + 8, s.y);
    ctx.moveTo(s.x, s.y - 8);
    ctx.lineTo(s.x, s.y + 8);
    ctx.stroke();
  }
}
