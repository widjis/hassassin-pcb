/**
 * Drawing tools on the board (P6, docs/05-pcb-improvements.md): the board outline (a rectangle with
 * optional rounded corners, or a polygon whose segments may be arcs), copper pours, keep-out areas,
 * silkscreen lines and text, mounting holes and fiducials; and dragging the corner points of a selected
 * outline, pour or keep-out. Each finished shape goes through the same tool the agents use (one undo step).
 *
 * Polygon: click the corners; A makes the next segment an arc (click a point on it, then its end);
 * Backspace removes the last point; Enter, a double-click or a click on the first point closes it; Esc
 * stops. Rectangle: drag from corner to corner (or click both corners).
 */
import { arcPoints, dist, isBoardMovable, keepoutAreas, newUid, snapToGrid, type DocNode, type Op, type Vec2 } from '@hassassin/core';
import { runTool, type Project } from '@hassassin/tools';
import type { App } from '../app.ts';
import { h } from '../ui/dom.ts';

export type DrawKind = 'outline-rect' | 'outline-poly' | 'pour' | 'keepout' | 'line' | 'text' | 'hole' | 'fiducial';

export const DRAW_KINDS: { kind: DrawKind; label: string; hint: string }[] = [
  { kind: 'outline-rect', label: 'Board outline (rectangle)', hint: 'Drag from corner to corner; then set the corner radius.' },
  { kind: 'outline-poly', label: 'Board outline (polygon)', hint: 'Click the corners · A arc · Backspace undo point · Enter or double-click closes.' },
  { kind: 'pour', label: 'Copper pour', hint: 'Click the corners of the pour (drag for a rectangle) · Enter closes; then choose the net and layers.' },
  { kind: 'keepout', label: 'Keep-out area', hint: 'Click the corners (drag for a rectangle) · Enter closes; then choose what it forbids.' },
  { kind: 'line', label: 'Silkscreen line', hint: 'Click the start, then the end (keeps going until Esc).' },
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
  /** Corner points so far (world, snapped); arcs already expanded into points. */
  private pts: Vec2[] = [];
  /** A pending arc: its point on the arc, waiting for the end. */
  private arcMid: Vec2 | null = null;
  private arcNext = false;
  private rectFrom: Vec2 | null = null;
  private cursor: Vec2 | null = null;
  private popup: HTMLElement | null = null;
  /** Corner drag (select mode): the item, which point, and the undo key. */
  private vertex: { uid: string; rule: string; index: number; key: string } | null = null;

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
    this.app.say(`${DRAW_KINDS.find((d) => d.kind === kind)?.label}: ${this.hint()}`);
  }

  cancel(): void {
    this.pts = [];
    this.arcMid = null;
    this.arcNext = false;
    this.rectFrom = null;
    this.closePopup();
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
      if (!this.pts.length) return void (this.pts = [q]);
      const a = this.pts[0]!;
      void this.run('add_line', { x1: a.x, y1: a.y, x2: q.x, y2: q.y, layer: 'F.SilkS' });
      this.pts = [q];
      return;
    }
    // Polygon kinds.
    if (this.pts.length > 2 && q === this.pts[0]) return this.close();
    if (this.arcNext && this.pts.length) {
      if (!this.arcMid) return void (this.arcMid = q);
      const s = this.pts[this.pts.length - 1]!;
      const arc = arcPoints(s, this.arcMid, q);
      this.pts.push(...arc.slice(1).map((r) => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4) })));
      this.arcMid = null;
      this.arcNext = false;
      return this.app.requestRender();
    }
    this.pts.push(q);
    this.app.requestRender();
  }

  /** A double-click closes a polygon. */
  dblclick(): void {
    if (this.polygonKind() && this.pts.length > 2) this.close();
  }

  key(e: KeyboardEvent): boolean {
    if (this.popup) return false;
    if (e.key === 'Escape') {
      if (this.busy) this.cancel();
      else this.app.setMode('select');
      return true;
    }
    if (e.key === 'Enter' && this.polygonKind() && this.pts.length > 2) return this.close(), true;
    if (e.key === 'Backspace' && this.pts.length) {
      this.pts.pop();
      this.app.requestRender();
      return true;
    }
    if ((e.key === 'a' || e.key === 'A') && this.polygonKind() && this.pts.length) {
      this.arcNext = !this.arcNext;
      this.arcMid = null;
      this.app.say(this.arcNext ? 'Arc: click a point on the arc, then its end.' : 'Straight segments.');
      return true;
    }
    return false;
  }

  private close(): void {
    const pts = this.pts.slice();
    this.pts = [];
    this.arcMid = null;
    this.arcNext = false;
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
          { key: 'priority', label: 'Priority', value: '0' },
        ],
        (v) => void this.run('add_pour', { net: v.net, layers: v.layers, priority: Number(v.priority) || 0, ...area }, `Pour of ${v.net} added and filled.`),
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

  /** The point rules of the selected shapes that can be edited by dragging their corners. */
  private handles(): { uid: string; rule: string; index: number; at: Vec2 }[] {
    const app = this.app;
    const out: { uid: string; rule: string; index: number; at: Vec2 }[] = [];
    if (!app.doc || !app.engine || app.selection.size > 3) return out;
    for (const uid of app.selection) {
      const n: DocNode | undefined = app.doc.nodes.get(uid);
      if (!n || !isBoardMovable(app.doc, n) || n.type === 'element' || n.type === 'via' || n.type === 'text') continue;
      const pts = app.engine.get(uid, 'points')?.value;
      if (Array.isArray(pts)) (pts as Vec2[]).forEach((at, index) => out.push({ uid, rule: 'points', index, at }));
      for (const r of n.type === 'line' || n.type === 'arc' ? ['start', 'end'] : []) {
        const v = app.engine.get(uid, r)?.value as Vec2 | undefined;
        if (v) out.push({ uid, rule: r, index: -1, at: v });
      }
    }
    return out;
  }

  /** Start dragging a corner under the screen point; false when there is none. */
  beginVertex(world: Vec2): boolean {
    const tol = 6 / this.app.view.scale;
    const h0 = this.handles().find((h1) => dist(h1.at, world) < tol);
    if (!h0) return false;
    this.vertex = { uid: h0.uid, rule: h0.rule, index: h0.index, key: newUid('vx') };
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
    if (v.index >= 0) {
      const pts = ((app.engine.get(v.uid, v.rule)?.value as Vec2[]) ?? []).slice();
      pts[v.index] = q;
      value = pts;
    } else value = q;
    app.apply('Move corner', [{ op: 'setRule', uid: v.uid, name: v.rule, decl: { name: v.rule, value } }], v.key);
  }

  endVertex(): void {
    const v = this.vertex;
    this.vertex = null;
    if (!v) return;
    // A pour or the board outline changed shape: fill the pours again, in the same undo step.
    const n = this.app.node(v.uid);
    const outline = this.app.engine?.get(v.uid, 'layer')?.value === 'Edge.Cuts';
    if (n?.type === 'fill' || n?.type === 'zone' || outline) this.app.refillPours({ mergeKey: v.key, quiet: true });
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
        ctx.fillStyle = 'rgba(242,169,59,0.95)';
        ctx.strokeStyle = 'rgba(20,20,24,0.9)';
        ctx.lineWidth = 1;
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
        ctx.strokeRect(s.x - 4 + 0.5, s.y - 4 + 0.5, 8, 8);
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
      ctx.beginPath();
      const p0 = S(this.pts[0]!);
      ctx.moveTo(p0.x, p0.y);
      for (const p of this.pts.slice(1)) {
        const s = S(p);
        ctx.lineTo(s.x, s.y);
      }
      const last = this.pts[this.pts.length - 1]!;
      if (this.arcMid) {
        for (const p of arcPoints(last, this.arcMid, c).slice(1)) {
          const s = S(p);
          ctx.lineTo(s.x, s.y);
        }
      } else {
        const s = S(c);
        ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
      for (const p of this.pts) {
        const s = S(p);
        ctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
      }
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
