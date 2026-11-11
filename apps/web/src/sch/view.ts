/**
 * Schematic editor view (Canvas 2D). Shows one sheet at a time.
 * Tools: select/move (drag), wire (W), net label (L), add part (A), rotate (R),
 * delete (Del), enter sub-sheet (double-click a sheet block), up (Backspace on empty / U).
 */
import {
  addSymbolOp,
  arcPoints,
  dist,
  distToSegment,
  makeSymbol,
  newUid,
  sheetItems,
  sheetPath,
  snapToGrid,
  symbolFrame,
  symToSheet,
  type DocNode,
  type Op,
  type PartKind,
  type SymGraphicSpec,
  type Vec2,
} from '@hassassin/core';
import { drawComments, drawPeerCursor, type App } from '../app.ts';

export const SCH_GRID = 1.27;

const C = {
  bg: '#0e1014',
  grid: 'rgba(120,130,150,0.18)',
  wire: '#4fd6a6',
  body: '#e8c47a',
  bodyFill: 'rgba(232,196,122,0.07)',
  pin: '#c9ced8',
  pinNum: '#8f96a3',
  ref: '#f2efe6',
  value: '#a7b0be',
  local: '#8ab4ff',
  global: '#f59fd0',
  hier: '#ffb86b',
  power: '#ff8f8f',
  block: '#7aa2f7',
  nc: '#ff6b6b',
  sel: '#ffd166',
  text: '#c7cdd8',
};

type Tool = 'select' | 'wire';

interface View {
  cx: number;
  cy: number;
  scale: number;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export class SchematicView {
  sheetUid: string | null = null;
  tool: Tool = 'select';
  view: View = { cx: 0, cy: 0, scale: 6 };
  private wireStart: Vec2 | null = null;
  private wireHorizontalFirst = true;
  private cursor: Vec2 = { x: 0, y: 0 };
  private drag: { x: number; y: number; moved: boolean; kind: 'pan' | 'move'; start: Vec2; key: string; items: { uid: string; rules: Record<string, Vec2> }[] } | null = null;
  private frame = 0;
  /** Called with the sheet-space cursor (for presence). */
  onCursor: ((p: Vec2) => void) | null = null;
  /** Called when the user clicks with comment mode on. */
  onPlaceComment: ((p: Vec2) => void) | null = null;
  /** Called when a comment pin is clicked. */
  onCommentClick: ((c: DocNode) => void) | null = null;

  private app: App;
  readonly canvas: HTMLCanvasElement;

  constructor(app: App, canvas: HTMLCanvasElement) {
    this.app = app;
    this.canvas = canvas;
    new ResizeObserver(() => this.requestRender()).observe(canvas);
    this.bind();
  }

  // ---------- sheet navigation ----------
  sheets(): DocNode[] {
    const doc = this.app.doc;
    return doc ? [...doc.nodes.values()].filter((n) => n.type === 'sheet') : [];
  }

  sheet(): DocNode | undefined {
    const doc = this.app.doc;
    if (!doc) return undefined;
    if (!this.sheetUid || !doc.nodes.has(this.sheetUid)) this.sheetUid = this.sheets()[0]?.uid ?? null;
    return this.sheetUid ? doc.nodes.get(this.sheetUid) : undefined;
  }

  openSheet(uid: string): void {
    this.sheetUid = uid;
    this.cancelWire();
    this.fit();
    this.app.emit('sheet');
  }

  path(): string {
    const s = this.sheet();
    return s && this.app.doc ? sheetPath(this.app.doc, s) : '';
  }

  // ---------- geometry ----------
  private items(): DocNode[] {
    const s = this.sheet();
    return s && this.app.doc ? sheetItems(this.app.doc, s) : [];
  }

  private size() {
    return { w: this.canvas.clientWidth || 800, h: this.canvas.clientHeight || 600 };
  }
  toWorld(sx: number, sy: number): Vec2 {
    const { w, h } = this.size();
    return { x: this.view.cx + (sx - w / 2) / this.view.scale, y: this.view.cy + (sy - h / 2) / this.view.scale };
  }
  toScreen(p: Vec2): Vec2 {
    const { w, h } = this.size();
    return { x: w / 2 + (p.x - this.view.cx) * this.view.scale, y: h / 2 + (p.y - this.view.cy) * this.view.scale };
  }

  /** Bounding box of a symbol in sheet coordinates. */
  private symbolBox(sym: DocNode): { minX: number; minY: number; maxX: number; maxY: number } {
    const e = this.app.engine!;
    const f = symbolFrame(e, sym.uid);
    const pts: Vec2[] = [];
    for (const g of (sym.data?.graphics ?? []) as SymGraphicSpec[]) {
      if (g.t === 'poly') pts.push(...g.pts);
      else if (g.t === 'rect') pts.push(g.a, g.b);
      else if (g.t === 'circle') pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r });
    }
    for (const c of sym.children) {
      const p = this.app.doc!.nodes.get(c);
      const at = p?.type === 'pin' ? vec(e.get(p.uid, 'position')?.value) : undefined;
      if (at) pts.push(at);
    }
    if (!pts.length) pts.push({ x: -1, y: -1 }, { x: 1, y: 1 });
    const w = pts.map((p) => symToSheet(f, p));
    return { minX: Math.min(...w.map((p) => p.x)), minY: Math.min(...w.map((p) => p.y)), maxX: Math.max(...w.map((p) => p.x)), maxY: Math.max(...w.map((p) => p.y)) };
  }

  fit(): void {
    const items = this.items();
    if (!items.length) {
      this.view = { cx: 0, cy: 0, scale: 6 };
      return this.requestRender();
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (p: Vec2) => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    };
    const e = this.app.engine!;
    for (const n of items) {
      if (n.type === 'symbol') {
        const b = this.symbolBox(n);
        grow({ x: b.minX, y: b.minY });
        grow({ x: b.maxX, y: b.maxY });
      } else if (n.type === 'wire') {
        const a = vec(e.get(n.uid, 'start')?.value);
        const b = vec(e.get(n.uid, 'end')?.value);
        if (a && b) (grow(a), grow(b));
      } else if (n.type === 'block') {
        const p = vec(e.get(n.uid, 'position')?.value);
        const s = vec(e.get(n.uid, 'size')?.value);
        if (p && s) (grow(p), grow({ x: p.x + s.x, y: p.y + s.y }));
      } else {
        const p = vec(e.get(n.uid, 'position')?.value);
        if (p) grow(p);
      }
    }
    const { w, h } = this.size();
    this.view.cx = (minX + maxX) / 2;
    this.view.cy = (minY + maxY) / 2;
    this.view.scale = Math.max(1, Math.min(40, Math.min(w / Math.max(10, maxX - minX), h / Math.max(10, maxY - minY)) * 0.85));
    this.requestRender();
  }

  // ---------- picking ----------
  pick(p: Vec2): DocNode | null {
    const e = this.app.engine!;
    const tol = 4 / this.view.scale;
    const items = this.items();
    let best: { n: DocNode; score: number } | null = null;
    const offer = (n: DocNode, score: number) => {
      if (!best || score > best.score) best = { n, score };
    };
    for (const n of items) {
      if (n.type === 'label' && n.parent && this.app.doc!.nodes.get(n.parent)?.type === 'symbol') continue;
      if (n.type === 'label' || n.type === 'junction' || n.type === 'noconnect' || n.type === 'sheetPin') {
        const q = vec(e.get(n.uid, 'position')?.value);
        if (q && dist(p, q) < Math.max(tol * 2, 1)) offer(n, 4);
      } else if (n.type === 'wire') {
        const a = vec(e.get(n.uid, 'start')?.value);
        const b = vec(e.get(n.uid, 'end')?.value);
        if (a && b && distToSegment(p, a, b) < tol) offer(n, 3);
      } else if (n.type === 'symbol') {
        const b = this.symbolBox(n);
        if (p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol) offer(n, 2 - (b.maxX - b.minX) * (b.maxY - b.minY) * 1e-4);
      } else if (n.type === 'block') {
        const q = vec(e.get(n.uid, 'position')?.value);
        const s = vec(e.get(n.uid, 'size')?.value);
        if (q && s && p.x >= q.x && p.x <= q.x + s.x && p.y >= q.y && p.y <= q.y + s.y) offer(n, 1);
      }
    }
    return (best as { n: DocNode } | null)?.n ?? null;
  }

  // ---------- editing ----------
  private snap(p: Vec2): Vec2 {
    return snapToGrid(p, SCH_GRID);
  }

  addPart(kind: PartKind, opts: { pins?: number; value?: string } = {}): void {
    const s = this.sheet();
    const doc = this.app.doc;
    if (!s || !doc) return this.app.say('Open or create a schematic first.');
    const spec = makeSymbol(kind, opts);
    const at = this.snap({ x: this.view.cx, y: this.view.cy });
    const { op, uid } = addSymbolOp(doc, s.uid, spec, at);
    if (this.app.apply(`Add ${spec.prefix}`, [op])) {
      this.app.select([uid]);
      this.app.say(`Placed ${doc.nodes.get(uid)?.name}. Drag it into place; R rotates.`);
    }
  }

  addLabel(at: Vec2, name: string, kind: 'local' | 'global' = 'local'): void {
    const s = this.sheet();
    if (!s || !name.trim()) return;
    this.app.apply('Add label', [
      { op: 'add', parent: s.uid, index: s.children.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name: name.trim(), props: { kind }, rules: [{ name: 'position', value: at }, { name: 'rotation', value: 0 }], parent: s.uid, children: [] }] } },
    ]);
  }

  private addWire(a: Vec2, b: Vec2): void {
    const s = this.sheet();
    if (!s || dist(a, b) < 1e-6) return;
    const mid = this.wireHorizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const segs = [[a, mid], [mid, b]].filter(([p, q]) => dist(p!, q!) > 1e-6);
    const ops: Op[] = segs.map(([p, q], i) => ({
      op: 'add',
      parent: s.uid,
      index: s.children.length + i,
      tree: { nodes: [{ uid: newUid('w'), type: 'wire', name: '', props: {}, rules: [{ name: 'start', value: p! }, { name: 'end', value: q! }], parent: s.uid, children: [] }] },
    }));
    this.app.apply('Draw wire', ops);
  }

  cancelWire(): void {
    this.wireStart = null;
    this.requestRender();
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.cancelWire();
    this.app.say(t === 'wire' ? 'Wire: click to start, click to bend/finish, / flips the corner, Esc stops.' : '');
    this.app.emit('mode');
  }

  rotateSelection(): void {
    const e = this.app.engine!;
    const ops: Op[] = [];
    for (const uid of this.app.selection) {
      const n = this.app.node(uid);
      if (n?.type !== 'symbol' && n?.type !== 'label') continue;
      const cur = Number(e.get(uid, 'rotation')?.value ?? 0);
      ops.push({ op: 'setRule', uid, name: 'rotation', decl: { name: 'rotation', value: (cur + 90) % 360 } });
    }
    if (ops.length) this.app.apply('Rotate', ops);
  }

  deleteSelection(): void {
    const ops: Op[] = [];
    for (const uid of this.app.selection) {
      const n = this.app.node(uid);
      if (n && ['symbol', 'wire', 'label', 'junction', 'noconnect'].includes(n.type) && !(n.type === 'label' && this.app.node(n.parent ?? '')?.type === 'symbol')) ops.push({ op: 'remove', uid });
    }
    if (ops.length) {
      this.app.apply(`Delete ${ops.length} item${ops.length > 1 ? 's' : ''}`, ops);
      this.app.select([]);
    }
  }

  // ---------- input ----------
  private bind(): void {
    const c = this.canvas;
    const local = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      c.setPointerCapture(e.pointerId);
      const { sx, sy } = local(e);
      const p = this.toWorld(sx, sy);
      let kind: 'pan' | 'move' = 'pan';
      const items: { uid: string; rules: Record<string, Vec2> }[] = [];
      if (this.tool === 'select' && e.button === 0) {
        const hit = this.pick(p);
        if (hit && ['symbol', 'label', 'wire', 'junction', 'noconnect', 'block'].includes(hit.type) && !(hit.type === 'label' && this.app.node(hit.parent ?? '')?.type === 'symbol')) {
          if (!this.app.selection.has(hit.uid)) this.app.select([hit.uid], e.shiftKey);
          kind = 'move';
          const eng = this.app.engine!;
          for (const uid of this.app.selection) {
            const n = this.app.node(uid);
            if (!n) continue;
            const keys = n.type === 'wire' ? ['start', 'end'] : ['position'];
            const rules: Record<string, Vec2> = {};
            for (const k of keys) {
              const v = vec(eng.get(uid, k)?.value);
              if (v) rules[k] = { ...v };
            }
            if (Object.keys(rules).length) items.push({ uid, rules });
          }
        }
      }
      this.drag = { x: e.clientX, y: e.clientY, moved: false, kind, start: p, key: newUid('smv'), items };
    });
    c.addEventListener('pointermove', (e) => {
      const { sx, sy } = local(e);
      const p = this.toWorld(sx, sy);
      this.cursor = this.snap(p);
      this.onCursor?.(p);
      const d = this.drag;
      if (d) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
        if (d.moved && d.kind === 'pan') {
          this.view.cx -= dx / this.view.scale;
          this.view.cy -= dy / this.view.scale;
          d.x = e.clientX;
          d.y = e.clientY;
        } else if (d.moved && d.kind === 'move') {
          const delta = snapToGrid({ x: p.x - d.start.x, y: p.y - d.start.y }, SCH_GRID);
          const ops: Op[] = [];
          for (const it of d.items) for (const [k, v] of Object.entries(it.rules)) ops.push({ op: 'setRule', uid: it.uid, name: k, decl: { name: k, value: { x: v.x + delta.x, y: v.y + delta.y } } });
          this.app.apply('Move', ops, d.key);
        }
      }
      this.requestRender();
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'move' && d.moved) this.app.history?.seal();
      if (!d || d.moved || e.button !== 0) return;
      const { sx, sy } = local(e);
      const p = this.toWorld(sx, sy);
      if (this.app.commentMode) return this.onPlaceComment?.(p);
      const pin = this.app.commentAt('schematic', this.sheet()?.uid, sx, sy, (q) => this.toScreen(q));
      if (pin) return this.onCommentClick?.(pin);
      if (this.tool === 'wire') {
        const q = this.snap(p);
        if (!this.wireStart) this.wireStart = q;
        else {
          this.addWire(this.wireStart, q);
          // Stop when landing on an existing pin/wire end; otherwise keep drawing.
          this.wireStart = this.connectsAt(q) ? null : q;
        }
        return this.requestRender();
      }
      const hit = this.pick(p);
      if (hit) this.app.select([hit.uid, ...this.counterparts(hit)], e.shiftKey);
      else if (!e.shiftKey) this.app.select([]);
    });
    c.addEventListener('dblclick', (e) => {
      if (this.tool === 'wire') return this.cancelWire();
      const { sx, sy } = local(e);
      const hit = this.pick(this.toWorld(sx, sy));
      if (hit?.type === 'block') {
        const child = hit.children.map((u) => this.app.node(u)).find((n) => n?.type === 'sheet');
        if (child) this.openSheet(child.uid);
      }
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cancelWire();
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { sx, sy } = local(e);
        const before = this.toWorld(sx, sy);
        const dy = Math.max(-120, Math.min(120, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
        this.view.scale = Math.max(0.5, Math.min(200, this.view.scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002))));
        const after = this.toWorld(sx, sy);
        this.view.cx += before.x - after.x;
        this.view.cy += before.y - after.y;
        this.requestRender();
      },
      { passive: false },
    );
  }

  /** PCB element(s) that belong to a symbol (for cross-probing). */
  private counterparts(n: DocNode): string[] {
    if (n.type !== 'symbol' || !this.app.doc) return [];
    const ref = String(n.props.ref ?? n.name);
    for (const x of this.app.doc.nodes.values()) if (x.type === 'element' && x.name === ref) return [x.uid];
    return [];
  }

  private connectsAt(p: Vec2): boolean {
    const e = this.app.engine!;
    for (const n of this.items()) {
      if (n.type === 'pin') {
        const sym = this.app.node(n.parent ?? '');
        const local = vec(e.get(n.uid, 'position')?.value);
        if (sym && local && dist(symToSheet(symbolFrame(e, sym.uid), local), p) < 1e-3) return true;
      } else if (n.type === 'wire') {
        const a = vec(e.get(n.uid, 'start')?.value);
        const b = vec(e.get(n.uid, 'end')?.value);
        if (a && b && (dist(a, p) < 1e-3 || dist(b, p) < 1e-3) && this.wireStart && dist(this.wireStart, p) > 1e-3) return true;
      }
    }
    return false;
  }

  // ---------- drawing ----------
  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = this.size();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    const doc = this.app.doc;
    const e = this.app.engine;
    const sheet = this.sheet();
    if (!doc || !e || !sheet) {
      ctx.fillStyle = '#8b91a0';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No schematic yet. Use “New project”, or open a .kicad_sch together with its board.', w / 2, h / 2);
      return;
    }
    const s = this.view.scale;
    const S = (p: Vec2) => this.toScreen(p);
    const lw = (mm: number) => Math.max(1, mm * s);

    // Grid dots
    if (s * SCH_GRID * 2 >= 8) {
      const step = SCH_GRID * (s * SCH_GRID >= 8 ? 1 : 2);
      const tl = this.toWorld(0, 0);
      const br = this.toWorld(w, h);
      ctx.fillStyle = C.grid;
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step)
        for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
          const q = S({ x, y });
          ctx.fillRect(q.x - 0.75, q.y - 0.75, 1.5, 1.5);
        }
    }

    const sel = this.app.selection;
    const selectedRefs = new Set<string>();
    for (const u of sel) {
      const n = doc.nodes.get(u);
      if (n?.type === 'element') selectedRefs.add(n.name);
    }
    const isSel = (n: DocNode) => sel.has(n.uid) || (n.type === 'symbol' && selectedRefs.has(String(n.props.ref ?? n.name)));
    const items = this.items();
    const text = (t: string, p: Vec2, size: number, color: string, align: CanvasTextAlign = 'left', base: CanvasTextBaseline = 'middle') => {
      const px = size * s;
      if (px < 4) return;
      ctx.font = `${Math.min(px, 64).toFixed(1)}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = color;
      ctx.textAlign = align;
      ctx.textBaseline = base;
      const q = S(p);
      ctx.fillText(t.replace(/~\{([^}]*)\}/g, '$1'), q.x, q.y);
    };

    // Sheet texts
    for (const t of ((sheet.data?.texts ?? []) as { at: Vec2; text: string; size: number }[])) {
      t.text.split('\n').forEach((line, i) => text(line, { x: t.at.x, y: t.at.y + i * t.size * 1.4 }, t.size, '#6c7383', 'left', 'top'));
    }

    // Blocks (sub-sheets)
    for (const n of items) {
      if (n.type !== 'block') continue;
      const p = vec(e.get(n.uid, 'position')?.value);
      const sz = vec(e.get(n.uid, 'size')?.value);
      if (!p || !sz) continue;
      const a = S(p);
      ctx.strokeStyle = isSel(n) ? C.sel : C.block;
      ctx.lineWidth = lw(0.2);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(a.x, a.y, sz.x * s, sz.y * s);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(122,162,247,0.05)';
      ctx.fillRect(a.x, a.y, sz.x * s, sz.y * s);
      text(n.name, { x: p.x, y: p.y - 1 }, 1.6, C.block, 'left', 'bottom');
      text('double-click to open', { x: p.x + 1, y: p.y + sz.y - 1.2 }, 1, '#5d6b8f', 'left', 'bottom');
      for (const c2 of n.children) {
        const sp = doc.nodes.get(c2);
        if (sp?.type !== 'sheetPin') continue;
        const q = vec(e.get(sp.uid, 'position')?.value);
        if (!q) continue;
        const inside = q.x - p.x < sz.x / 2;
        ctx.fillStyle = C.hier;
        const qq = S(q);
        ctx.fillRect(qq.x - lw(0.5), qq.y - lw(0.5), lw(1), lw(1));
        text(sp.name, { x: q.x + (inside ? 1.2 : -1.2), y: q.y }, 1.2, C.hier, inside ? 'left' : 'right');
      }
    }

    // Wires
    for (const n of items) {
      if (n.type !== 'wire') continue;
      const a = vec(e.get(n.uid, 'start')?.value);
      const b = vec(e.get(n.uid, 'end')?.value);
      if (!a || !b) continue;
      ctx.strokeStyle = isSel(n) ? C.sel : C.wire;
      ctx.lineWidth = lw(0.15);
      ctx.beginPath();
      const p = S(a);
      const q = S(b);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }

    // Symbols
    for (const n of items) {
      if (n.type !== 'symbol') continue;
      const f = symbolFrame(e, n.uid);
      const W = (p: Vec2) => S(symToSheet(f, p));
      const selected = isSel(n);
      ctx.strokeStyle = selected ? C.sel : C.body;
      for (const g of (n.data?.graphics ?? []) as (SymGraphicSpec | { t: 'arc'; s: Vec2; m: Vec2; e: Vec2; w: number })[]) {
        ctx.lineWidth = lw('w' in g ? Math.max(g.w, 0.15) : 0.15);
        if (g.t === 'text') {
          text(g.text, symToSheet(f, g.at), g.size, C.body, 'center');
          continue;
        }
        let pts: Vec2[] = [];
        let closed = false;
        let fill = false;
        if (g.t === 'poly') ((pts = g.pts), (fill = g.fill));
        else if (g.t === 'rect') ((pts = [g.a, { x: g.b.x, y: g.a.y }, g.b, { x: g.a.x, y: g.b.y }]), (closed = true), (fill = g.fill));
        else if (g.t === 'circle') ((pts = Array.from({ length: 24 }, (_, i) => ({ x: g.c.x + Math.cos((i / 24) * 2 * Math.PI) * g.r, y: g.c.y + Math.sin((i / 24) * 2 * Math.PI) * g.r }))), (closed = true), (fill = g.fill));
        else if (g.t === 'arc') pts = arcPoints(g.s, g.m, g.e);
        if (pts.length < 2) continue;
        ctx.beginPath();
        pts.forEach((p, i) => {
          const q = W(p);
          if (i) ctx.lineTo(q.x, q.y);
          else ctx.moveTo(q.x, q.y);
        });
        if (closed) ctx.closePath();
        if (fill) {
          ctx.fillStyle = C.bodyFill;
          ctx.fill();
        }
        ctx.stroke();
      }
      // Pins
      for (const c2 of n.children) {
        const pin = doc.nodes.get(c2);
        if (pin?.type !== 'pin') continue;
        const at = vec(e.get(pin.uid, 'position')?.value);
        if (!at) continue;
        const ang = (Number(e.get(pin.uid, 'rotation')?.value ?? 0) * Math.PI) / 180;
        const len = Number(e.get(pin.uid, 'pinLength')?.value ?? 2.54);
        const end = { x: at.x + Math.cos(ang) * len, y: at.y - Math.sin(ang) * len };
        if (!pin.props.hidden && len > 0) {
          ctx.strokeStyle = selected ? C.sel : C.pin;
          ctx.lineWidth = lw(0.15);
          ctx.beginPath();
          const p = W(at);
          const q = W(end);
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          const mid = symToSheet(f, { x: (at.x + end.x) / 2, y: (at.y + end.y) / 2 });
          if (s > 5 && !n.props.power) text(String(pin.props.number ?? ''), { x: mid.x, y: mid.y - 0.5 }, 0.9, C.pinNum, 'center', 'bottom');
          const nm = String(pin.props.pinName ?? '');
          if (s > 5 && nm && nm !== '~' && nm !== pin.props.number) {
            const inner = symToSheet(f, { x: end.x + Math.cos(ang) * 0.6, y: end.y - Math.sin(ang) * 0.6 });
            const dir = symToSheet(f, { x: end.x + Math.cos(ang) * 2, y: end.y - Math.sin(ang) * 2 });
            text(nm, inner, 1.05, C.text, dir.x >= inner.x ? 'left' : 'right');
          }
        }
      }
      const b = this.symbolBox(n);
      if (n.props.power) {
        const lbl = n.children.map((u) => doc.nodes.get(u)).find((x) => x?.type === 'label');
        if (lbl) text(lbl.name, { x: (b.minX + b.maxX) / 2, y: b.minY - 0.4 }, 1.2, C.power, 'center', 'bottom');
      } else {
        text(String(n.props.ref ?? n.name), { x: b.maxX + 0.8, y: b.minY + 0.8 }, 1.3, selected ? C.sel : C.ref);
        const v = String(n.props.Value ?? '');
        if (v) text(v.length > 28 ? `${v.slice(0, 27)}…` : v, { x: b.maxX + 0.8, y: b.minY + 2.6 }, 1.1, C.value);
      }
    }

    // Labels, junctions, no-connects
    for (const n of items) {
      const p = vec(e.get(n.uid, 'position')?.value);
      if (!p) continue;
      if (n.type === 'junction') {
        ctx.fillStyle = C.wire;
        const q = S(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, Math.max(2.5, 0.45 * s), 0, Math.PI * 2);
        ctx.fill();
      } else if (n.type === 'noconnect') {
        const q = S(p);
        const r = Math.max(3, 0.65 * s);
        ctx.strokeStyle = C.nc;
        ctx.lineWidth = lw(0.15);
        ctx.beginPath();
        ctx.moveTo(q.x - r, q.y - r);
        ctx.lineTo(q.x + r, q.y + r);
        ctx.moveTo(q.x + r, q.y - r);
        ctx.lineTo(q.x - r, q.y + r);
        ctx.stroke();
      } else if (n.type === 'label' && this.app.node(n.parent ?? '')?.type !== 'symbol') {
        const kind = String(n.props.kind ?? 'local');
        const color = isSel(n) ? C.sel : kind === 'global' ? C.global : kind === 'hier' ? C.hier : C.local;
        const rot = Number(e.get(n.uid, 'rotation')?.value ?? 0);
        const right = rot === 180;
        const q = S(p);
        ctx.fillStyle = color;
        ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
        if (kind !== 'local') {
          ctx.font = `${Math.min(1.2 * s, 64).toFixed(1)}px ui-monospace, Menlo, monospace`;
          const tw = ctx.measureText(n.name).width + 8;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(right ? q.x - tw - 2 : q.x + 2, q.y - 0.9 * s, tw, 1.8 * s);
          text(n.name, { x: p.x + (right ? -0.5 - (tw - 4) / s : 0.5 + 4 / s), y: p.y }, 1.2, color, 'left');
        } else text(n.name, { x: p.x + (right ? -0.4 : 0.4), y: p.y - 0.4 }, 1.2, color, right ? 'right' : 'left', 'bottom');
      }
    }

    // ERC markers on this sheet
    for (const v of this.app.erc?.violations ?? []) {
      if (v.sheet !== sheet.uid) continue;
      const q = S(v.at);
      const focus = v.id === this.app.focusedViolation;
      const r = focus ? 11 : 6;
      ctx.strokeStyle = v.severity === 'error' ? 'rgba(255,90,90,0.95)' : 'rgba(255,200,60,0.95)';
      ctx.lineWidth = focus ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Comment pins and collaborators on this sheet
    drawComments(ctx, this.app, 'schematic', sheet.uid, S);
    for (const p of this.app.collab?.peers.values() ?? []) {
      for (const uid of p.selection) {
        const n = doc.nodes.get(uid);
        if (n?.type !== 'symbol' || items.indexOf(n) < 0) continue;
        const b = this.symbolBox(n);
        const a = S({ x: b.minX, y: b.minY });
        ctx.strokeStyle = p.user.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(a.x - 3, a.y - 3, (b.maxX - b.minX) * s + 6, (b.maxY - b.minY) * s + 6);
      }
      if (p.cursor?.space === 'schematic' && p.cursor.sheet === sheet.uid) drawPeerCursor(ctx, S(p.cursor), p.user.name, p.user.color, p.user.kind === 'agent');
    }

    // Wire tool preview
    if (this.tool === 'wire') {
      const q = S(this.cursor);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q.x - 8, q.y);
      ctx.lineTo(q.x + 8, q.y);
      ctx.moveTo(q.x, q.y - 8);
      ctx.lineTo(q.x, q.y + 8);
      ctx.stroke();
      if (this.wireStart) {
        const a = this.wireStart;
        const b = this.cursor;
        const mid = this.wireHorizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
        ctx.strokeStyle = C.wire;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = lw(0.15);
        ctx.beginPath();
        const pa = S(a);
        const pm = S(mid);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pm.x, pm.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  toggleCorner(): void {
    this.wireHorizontalFirst = !this.wireHorizontalFirst;
    this.requestRender();
  }

  get cursorPoint(): Vec2 {
    return this.cursor;
  }
}
