/**
 * Application state: the document, its style engine, the scene and the view.
 * UI panels subscribe with `on()` and read state directly.
 */
import { querySelectorAll, StyleEngine, type Doc, type DocNode } from '@hassassin/core';
import { importKicadPcb, type LayerInfo } from '@hassassin/kicad-import';
import { cssColor, HIGHLIGHT, layerColor, QUERY_HIGHLIGHT, type RGBA } from './render/colors.ts';
import { GLRenderer, screenToWorld, worldToScreen, type View } from './render/gl.ts';
import { buildScene, highlightTris, HOLES, type Scene } from './render/scene.ts';

export type Inspected = { kind: 'node'; uid: string } | { kind: 'ruleset'; id: string } | { kind: 'none' };
type Event = 'doc' | 'selection' | 'layers' | 'rules' | 'query' | 'view' | 'inspect';

const DEFAULT_HIDDEN = new Set(['paste', 'mask', 'adhesive', 'courtyard', 'fab', 'user']);

export class App {
  doc: Doc | null = null;
  engine: StyleEngine | null = null;
  layers: LayerInfo[] = [];
  copper: string[] = [];
  scene: Scene | null = null;
  visible = new Set<string>();
  selection = new Set<string>();
  queryMatches = new Set<string>();
  queryError: string | null = null;
  inspected: Inspected = { kind: 'none' };
  view: View = { cx: 0, cy: 0, scale: 10, flipped: false };
  hoverUid: string | null = null;
  cursor = { x: 0, y: 0 };
  stats: Record<string, number> = {};
  fileName = '';

  private listeners = new Map<Event, Set<() => void>>();
  private frame = 0;
  readonly renderer: GLRenderer;

  constructor(
    readonly glCanvas: HTMLCanvasElement,
    readonly overlay: HTMLCanvasElement,
  ) {
    this.renderer = new GLRenderer(glCanvas);
    new ResizeObserver(() => this.requestRender()).observe(glCanvas);
  }

  on(ev: Event, fn: () => void): void {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn);
  }
  emit(ev: Event): void {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  node(uid: string): DocNode | undefined {
    return this.doc?.nodes.get(uid);
  }

  load(text: string, fileName: string): void {
    const res = importKicadPcb(text, fileName);
    this.doc = res.doc;
    this.layers = res.layers;
    this.copper = res.layers.filter((l) => l.kind === 'copper').map((l) => l.name);
    this.stats = res.stats;
    this.fileName = fileName;
    this.visible = new Set([...res.layers.filter((l) => !DEFAULT_HIDDEN.has(l.kind)).map((l) => l.name), HOLES]);
    this.selection.clear();
    this.queryMatches.clear();
    this.inspected = { kind: 'none' };
    this.engine = new StyleEngine(this.doc);
    this.rebuild();
    this.fit();
    for (const w of res.warnings) console.warn('[import]', w.message);
    this.emit('doc');
  }

  /** Re-resolve rules and rebuild geometry (after any rule change). */
  rebuild(): void {
    if (!this.doc || !this.engine) return;
    this.engine.recompute();
    this.scene = buildScene(this.doc, this.engine, this.copper);
    this.renderer.clearLayers();
    for (const [k, v] of this.scene.layers) this.renderer.setLayer(k, v);
    this.refreshHighlights();
  }

  rulesChanged(): void {
    this.rebuild();
    if (this.queryText) this.runQuery(this.queryText);
    this.emit('rules');
    this.emit('inspect');
  }

  // ---- layers ----
  drawOrder(): string[] {
    const names = this.layers.map((l) => l.name);
    const front = (n: string) => n.startsWith('F.');
    const back = (n: string) => n.startsWith('B.');
    const near = this.view.flipped ? back : front;
    const far = this.view.flipped ? front : back;
    const nearCu = this.view.flipped ? 'B.Cu' : 'F.Cu';
    const farCu = this.view.flipped ? 'F.Cu' : 'B.Cu';
    const inner = this.copper.filter((c) => c !== 'F.Cu' && c !== 'B.Cu');
    if (!this.view.flipped) inner.reverse();
    const farOther = names.filter((n) => far(n) && n !== farCu);
    const nearOther = names.filter((n) => near(n) && n !== nearCu);
    const rest = names.filter((n) => !front(n) && !back(n) && !inner.includes(n));
    return [...farOther, farCu, ...inner, nearCu, HOLES, ...nearOther, ...rest];
  }

  setLayerVisible(name: string, on: boolean): void {
    if (on) this.visible.add(name);
    else this.visible.delete(name);
    this.refreshHighlights();
    this.emit('layers');
  }

  // ---- view ----
  fit(): void {
    const b = this.scene?.bbox;
    const w = this.glCanvas.clientWidth || 800;
    const h = this.glCanvas.clientHeight || 600;
    if (!b || !Number.isFinite(b.minX)) return;
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cy = (b.minY + b.maxY) / 2;
    this.view.scale = Math.min(w / bw, h / bh) * 0.88;
    this.requestRender();
    this.emit('view');
  }

  flip(): void {
    this.view.flipped = !this.view.flipped;
    this.requestRender();
    this.emit('view');
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const w = this.glCanvas.clientWidth;
    const h = this.glCanvas.clientHeight;
    const before = screenToWorld(this.view, w, h, sx, sy);
    this.view.scale = Math.max(0.5, Math.min(4000, this.view.scale * factor));
    const after = screenToWorld(this.view, w, h, sx, sy);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.requestRender();
    this.emit('view');
  }

  panBy(dxPx: number, dyPx: number): void {
    this.view.cx -= (this.view.flipped ? -dxPx : dxPx) / this.view.scale;
    this.view.cy -= dyPx / this.view.scale;
    this.requestRender();
  }

  // ---- picking & selection ----
  pickAt(sx: number, sy: number, deep: boolean): string | null {
    if (!this.scene || !this.doc) return null;
    const w = this.glCanvas.clientWidth;
    const h = this.glCanvas.clientHeight;
    const p = screenToWorld(this.view, w, h, sx, sy);
    const tol = 3 / this.view.scale;
    const nearSide = this.view.flipped ? 'B.' : 'F.';
    let best: { uid: string; score: number } | null = null;
    for (const pk of this.scene.pick) {
      if (p.x < pk.box.minX - tol || p.x > pk.box.maxX + tol || p.y < pk.box.minY - tol || p.y > pk.box.maxY + tol) continue;
      if (!pk.layers.some((l) => this.visible.has(l))) continue;
      if (!pk.hit(p, tol)) continue;
      const area = (pk.box.maxX - pk.box.minX) * (pk.box.maxY - pk.box.minY);
      const side = pk.layers.some((l) => l.startsWith(nearSide)) ? 1 : 0;
      const score = side * 1000 + pk.priority * 100 - Math.min(99, area);
      if (!best || score > best.score) best = { uid: pk.uid, score };
    }
    if (!best) return null;
    if (deep) return best.uid;
    // Clicking any part of a component selects the component.
    let n = this.doc.nodes.get(best.uid);
    while (n) {
      if (n.type === 'element') return n.uid;
      n = n.parent ? this.doc.nodes.get(n.parent) : undefined;
    }
    return best.uid;
  }

  select(uids: string[], additive = false): void {
    if (!additive) this.selection.clear();
    for (const u of uids) {
      if (additive && this.selection.has(u)) this.selection.delete(u);
      else this.selection.add(u);
    }
    const last = uids[uids.length - 1];
    this.inspected = this.selection.size && last ? { kind: 'node', uid: last } : { kind: 'none' };
    this.refreshHighlights();
    this.emit('selection');
    this.emit('inspect');
  }

  inspectRuleset(id: string): void {
    this.inspected = { kind: 'ruleset', id };
    const rs = this.doc && [...this.doc.rulesets, ...this.doc.defaults].find((r) => r.id === id);
    if (rs) this.runQuery(rs.selector, false);
    this.emit('inspect');
  }

  // ---- selector query ----
  queryText = '';
  runQuery(text: string, remember = true): void {
    if (remember) this.queryText = text;
    this.queryMatches.clear();
    this.queryError = null;
    if (this.doc && text.trim()) {
      try {
        for (const n of querySelectorAll(this.doc, text)) this.queryMatches.add(n.uid);
      } catch (e) {
        this.queryError = (e as Error).message;
      }
    }
    this.refreshHighlights();
    this.emit('query');
  }

  private refreshHighlights(): void {
    if (!this.doc || !this.engine) return;
    const vis = (l: string) => this.visible.has(l);
    this.renderer.setLayer('__sel', highlightTris(this.doc, this.engine, this.selection, this.copper, vis));
    this.renderer.setLayer('__query', highlightTris(this.doc, this.engine, this.queryMatches, this.copper, vis));
    this.requestRender();
  }

  // ---- drawing ----
  requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const order = this.drawOrder()
      .filter((n) => this.visible.has(n))
      .map((key) => ({ key, color: layerColor(key) as RGBA }));
    order.push({ key: '__query', color: QUERY_HIGHLIGHT }, { key: '__sel', color: HIGHLIGHT });
    this.renderer.draw(this.view, order, [0.031, 0.035, 0.047, 1]);
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const c = this.overlay;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.scene) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const s = this.view.scale;
    for (const t of this.scene.texts) {
      if (t.kind === 'padNumber') {
        if (s < 18 || !this.visible.has(t.layer)) continue;
      } else if (!this.visible.has(t.layer)) continue;
      const px = t.size * s;
      if (px < 5) continue;
      const p = worldToScreen(this.view, w, h, t.pos.x, t.pos.y);
      if (p.x < -200 || p.y < -200 || p.x > w + 200 || p.y > h + 200) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      let rot = (-t.rot * Math.PI) / 180;
      if (this.view.flipped) rot = -rot;
      // keep text upright-ish
      if (Math.cos(rot) < -0.01) rot += Math.PI;
      ctx.rotate(rot);
      ctx.font = `${t.kind === 'padNumber' ? 600 : 500} ${px.toFixed(1)}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = t.kind === 'padNumber' ? 'rgba(255,255,255,0.85)' : cssColor(layerColor(t.layer));
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }
  }
}
