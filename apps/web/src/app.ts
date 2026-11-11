/**
 * Application state: the document, its style engine, history, scene and view.
 * Every edit goes through `apply()` (→ History → ops), never by mutating the doc.
 */
import {
  computeRatsnest,
  hasClipper,
  History,
  planPours,
  refillOps,
  runDrc,
  type DrcResult,
  type Violation,
  newUid,
  parseDoc,
  querySelectorAll,
  snapToGrid,
  stringifyDoc,
  StyleEngine,
  type ApplyResult,
  type Doc,
  type DocNode,
  type Op,
  type Ratsnest,
  type Ruleset,
  type Vec2,
} from '@hassassin/core';
import { importKicadPcb, type LayerInfo } from '@hassassin/kicad-import';
import { buildFab, fabZip } from '@hassassin/fab';
import { cssColor, HIGHLIGHT, layerColor, QUERY_HIGHLIGHT, type RGBA } from './render/colors.ts';
import { GLRenderer, screenToWorld, worldToScreen, type View } from './render/gl.ts';
import { HOLES, highlightTris, SceneCache } from './render/scene.ts';
import { RouteTool } from './tools/route.ts';

export type Inspected = { kind: 'node'; uid: string } | { kind: 'ruleset'; id: string } | { kind: 'none' };
export type Mode = 'select' | 'route';
type Event = 'doc' | 'change' | 'selection' | 'layers' | 'rules' | 'query' | 'view' | 'inspect' | 'mode' | 'status' | 'drc';

const DEFAULT_HIDDEN = new Set(['paste', 'mask', 'adhesive', 'courtyard', 'fab', 'user']);
const MOVABLE = new Set(['element', 'via', 'trace']);
const DELETABLE = new Set(['element', 'via', 'trace', 'line', 'arc', 'circle', 'polygon', 'rectangle', 'text', 'fill', 'zone']);

interface MoveState {
  start: Vec2;
  key: string;
  last: Vec2;
  items: { uid: string; rules: Record<string, Vec2> }[];
}

export class App {
  doc: Doc | null = null;
  engine: StyleEngine | null = null;
  history: History | null = null;
  layers: LayerInfo[] = [];
  copper: string[] = [];
  scene: SceneCache | null = null;
  ratsnest: Ratsnest = { lines: [], nets: [], unroutedNets: 0 };
  drc: DrcResult | null = null;
  focusedViolation: string | null = null;
  private drcTimer = 0;
  visible = new Set<string>();
  selection = new Set<string>();
  queryMatches = new Set<string>();
  netHighlight = new Set<string>();
  queryError: string | null = null;
  inspected: Inspected = { kind: 'none' };
  view: View = { cx: 0, cy: 0, scale: 10, flipped: false };
  mode: Mode = 'select';
  activeLayer = 'F.Cu';
  hoverUid: string | null = null;
  cursor: Vec2 = { x: 0, y: 0 };
  message = '';
  stats: Record<string, number> = {};
  fileName = '';
  dirty = false;
  readonly route: RouteTool;

  private listeners = new Map<Event, Set<() => void>>();
  private frame = 0;
  private move: MoveState | null = null;
  readonly renderer: GLRenderer;

  constructor(
    readonly glCanvas: HTMLCanvasElement,
    readonly overlay: HTMLCanvasElement,
  ) {
    this.renderer = new GLRenderer(glCanvas);
    this.route = new RouteTool(this);
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
  say(msg: string): void {
    this.message = msg;
    this.emit('status');
  }

  node(uid: string): DocNode | undefined {
    return this.doc?.nodes.get(uid);
  }

  // ---------- loading & saving ----------
  load(text: string, fileName: string): void {
    let doc: Doc;
    let layers: LayerInfo[];
    let stats: Record<string, number> = {};
    if (/\.hpcb$/i.test(fileName) || text.trimStart().startsWith('{')) {
      doc = parseDoc(text);
      layers = (doc.meta.layers as LayerInfo[]) ?? [];
    } else {
      const res = importKicadPcb(text, fileName);
      doc = res.doc;
      layers = res.layers;
      stats = res.stats;
      for (const w of res.warnings) console.warn('[import]', w.message);
    }
    this.setDoc(doc, layers, fileName.replace(/\.(kicad_pcb|hpcb)$/i, ''), stats);
  }

  private setDoc(doc: Doc, layers: LayerInfo[], name: string, stats: Record<string, number>): void {
    this.doc = doc;
    this.layers = layers;
    this.copper = layers.filter((l) => l.kind === 'copper').map((l) => l.name);
    this.activeLayer = this.copper[0] ?? 'F.Cu';
    this.fileName = name;
    this.stats = stats;
    this.visible = new Set([...layers.filter((l) => !DEFAULT_HIDDEN.has(l.kind)).map((l) => l.name), HOLES]);
    this.selection.clear();
    this.queryMatches.clear();
    this.netHighlight.clear();
    this.inspected = { kind: 'none' };
    this.mode = 'select';
    this.route.cancel();
    this.engine = new StyleEngine(doc);
    this.history = new History(doc);
    this.history.onChange((res) => this.onChange(res));
    this.scene = new SceneCache(doc, this.engine, this.copper);
    this.uploadLayers(true);
    this.updateRatsnest();
    this.drc = null;
    this.runDrcSoon(50);
    this.dirty = false;
    this.fit();
    this.emit('doc');
    this.emit('mode');
  }

  serialize(): string {
    if (!this.doc) throw new Error('No document');
    return stringifyDoc(this.doc);
  }

  // ---------- editing ----------
  apply(label: string, ops: Op[], mergeKey?: string): boolean {
    if (!this.history || !ops.length) return false;
    try {
      this.history.apply(label, ops, mergeKey);
      return true;
    } catch (e) {
      this.say(`Could not ${label.toLowerCase()}: ${(e as Error).message}`);
      return false;
    }
  }

  undo(): void {
    const e = this.history?.undo();
    this.say(e ? `Undid: ${e.label}` : 'Nothing to undo');
  }
  redo(): void {
    const e = this.history?.redo();
    this.say(e ? `Redid: ${e.label}` : 'Nothing to redo');
  }

  private onChange(res: ApplyResult): void {
    if (!this.doc || !this.engine || !this.scene) return;
    this.engine.recompute();
    if (res.global) this.scene.rebuildAll();
    else this.scene.update(res.touched);
    for (const u of [...this.selection]) if (!this.doc.nodes.has(u)) this.selection.delete(u);
    if (this.inspected.kind === 'node' && !this.doc.nodes.has(this.inspected.uid)) this.inspected = { kind: 'none' };
    this.uploadLayers(false);
    this.updateRatsnest();
    this.runDrcSoon();
    if (this.queryText) this.runQuery(this.queryText);
    this.dirty = true;
    this.emit('change');
    if (res.global) this.emit('rules');
    this.emit('inspect');
  }

  private uploadLayers(force: boolean): void {
    if (!this.scene) return;
    const { layers, changed } = this.scene.layers();
    if (!changed && !force) return;
    this.renderer.clearLayers();
    for (const [k, v] of layers) this.renderer.setLayer(k, v);
    this.refreshHighlights();
  }

  private updateRatsnest(): void {
    if (!this.doc || !this.engine) return;
    this.ratsnest = computeRatsnest(this.doc, this.engine, this.copper);
    this.requestRender();
  }

  // ---------- checks, pours, fabrication ----------
  runDrcSoon(delay = 400): void {
    clearTimeout(this.drcTimer);
    this.drcTimer = window.setTimeout(() => {
      if (this.move) return this.runDrcSoon(delay);
      this.runDrcNow();
    }, delay);
  }

  runDrcNow(): void {
    if (!this.doc || !this.engine) return;
    this.drc = runDrc(this.doc, this.engine, this.copper, { ratsnest: this.ratsnest });
    if (this.focusedViolation && !this.drc.violations.some((v) => v.id === this.focusedViolation)) this.focusedViolation = null;
    this.emit('drc');
    this.requestRender();
  }

  /** Create pours requested by net rules, then refill every pour — one undo step. */
  refillPours(): void {
    if (!this.doc || !this.engine) return;
    if (!hasClipper()) return this.say('The geometry engine is still loading; try again in a moment.');
    const key = newUid('pour');
    const plan = planPours(this.doc, this.engine, this.copper);
    if (plan.length) this.apply('Refill pours', plan, key);
    const { ops, ms, pours } = refillOps(this.doc, this.engine, this.copper);
    if (!pours) {
      this.history?.seal();
      return this.say('No pours yet. Select a net and set its “Pour layers” rule (e.g. F.Cu B.Cu), then refill.');
    }
    this.apply('Refill pours', ops, key);
    this.history?.seal();
    this.say(`Refilled ${pours} pour${pours > 1 ? 's' : ''} in ${Math.round(ms)} ms.`);
  }

  exportFab(): { blob: Blob; name: string; notes: string[] } | null {
    if (!this.doc || !this.engine) return null;
    const r = buildFab(this.doc, this.engine, this.layers.map((l) => l.name), this.fileName || 'board');
    const bytes = fabZip(r);
    return { blob: new Blob([bytes as BlobPart], { type: 'application/zip' }), name: `${this.fileName || 'board'}-fab.zip`, notes: r.notes };
  }

  focusViolation(v: Violation): void {
    this.focusedViolation = v.id;
    this.view.cx = v.at.x;
    this.view.cy = v.at.y;
    this.view.scale = Math.max(this.view.scale, 40);
    this.select(v.uids.filter((u) => this.doc?.nodes.has(u)));
    this.focusedViolation = v.id;
    this.emit('view');
    this.emit('drc');
    this.requestRender();
  }

  /** Apply a change to the project rulesets as one undoable step. */
  updateRulesets(label: string, mutate: (rulesets: Ruleset[]) => void): void {
    if (!this.doc) return;
    const next = structuredClone(this.doc.rulesets);
    mutate(next);
    this.apply(label, [{ op: 'setRulesets', rulesets: next }]);
  }

  gridStep(): number {
    const v = this.doc ? this.engine?.get(this.doc.rootId, 'gridSpacing')?.value : undefined;
    return typeof v === 'number' && v > 0 ? v : 0.5;
  }

  movable(uid: string): boolean {
    const n = this.node(uid);
    return !!n && MOVABLE.has(n.type);
  }

  beginMove(world: Vec2): void {
    if (!this.doc) return;
    const items: MoveState['items'] = [];
    for (const uid of this.selection) {
      const n = this.doc.nodes.get(uid);
      if (!n || !MOVABLE.has(n.type)) continue;
      const rules: Record<string, Vec2> = {};
      const keys = n.type === 'trace' ? ['start', 'end', 'mid'] : ['position'];
      for (const k of keys) {
        const v = this.engine!.get(uid, k)?.value;
        if (v && typeof v === 'object' && 'x' in v) rules[k] = { ...(v as Vec2) };
      }
      if (Object.keys(rules).length) items.push({ uid, rules });
    }
    if (!items.length) return;
    this.move = { start: world, last: { x: 0, y: 0 }, key: newUid('mv'), items };
  }

  get moving(): boolean {
    return !!this.move;
  }

  dragMove(world: Vec2, snap: boolean): void {
    const m = this.move;
    if (!m) return;
    let d = { x: world.x - m.start.x, y: world.y - m.start.y };
    if (snap) d = snapToGrid(d, this.gridStep());
    if (d.x === m.last.x && d.y === m.last.y) return;
    m.last = d;
    const ops: Op[] = [];
    for (const it of m.items) {
      for (const [k, v] of Object.entries(it.rules)) {
        ops.push({ op: 'setRule', uid: it.uid, name: k, decl: { name: k, value: { x: v.x + d.x, y: v.y + d.y } } });
      }
    }
    this.apply('Move', ops, m.key);
    this.say(`Δ ${d.x.toFixed(3)}, ${d.y.toFixed(3)} mm`);
  }

  endMove(): void {
    if (this.move) this.history?.seal();
    this.move = null;
  }

  rotateSelection(deg: number): void {
    if (!this.engine) return;
    const ops: Op[] = [];
    for (const uid of this.selection) {
      if (this.node(uid)?.type !== 'element') continue;
      const cur = Number(this.engine.get(uid, 'rotation')?.value ?? 0);
      const next = (((cur + deg) % 360) + 360) % 360;
      ops.push({ op: 'setRule', uid, name: 'rotation', decl: { name: 'rotation', value: next } });
    }
    if (!ops.length) return this.say('Select a component to rotate it.');
    this.apply('Rotate', ops);
  }

  deleteSelection(): void {
    const ops: Op[] = [];
    const sel = [...this.selection];
    const set = new Set(sel);
    for (const uid of sel) {
      const n = this.node(uid);
      if (!n || !DELETABLE.has(n.type)) continue;
      // Skip children of something that is also being deleted.
      let p = n.parent;
      let covered = false;
      while (p) {
        if (set.has(p)) covered = true;
        p = this.node(p)?.parent ?? null;
      }
      if (!covered) ops.push({ op: 'remove', uid });
    }
    if (!ops.length) return this.say('Nothing deletable is selected (pads and nets cannot be deleted here).');
    this.apply(`Delete ${ops.length} item${ops.length > 1 ? 's' : ''}`, ops);
    this.select([]);
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    if (mode !== 'route') this.route.cancel();
    this.mode = mode;
    this.say(mode === 'route' ? 'Route: click a pad, via or trace to start. V = via, / = corner style, Esc = stop.' : '');
    this.emit('mode');
    this.requestRender();
  }

  toggleActiveLayer(): void {
    if (this.copper.length < 2) return;
    const i = this.copper.indexOf(this.activeLayer);
    this.activeLayer = this.copper[(i + 1) % this.copper.length]!;
    this.route.layerChanged();
    this.emit('mode');
  }

  // ---------- layers ----------
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
    // The active routing layer is drawn on top of the other copper.
    const cu = [farCu, ...inner, nearCu].filter((l) => l !== this.activeLayer || this.mode !== 'route');
    if (this.mode === 'route') cu.push(this.activeLayer);
    return [...farOther, ...cu, HOLES, ...nearOther, ...rest];
  }

  setLayerVisible(name: string, on: boolean): void {
    if (on) this.visible.add(name);
    else this.visible.delete(name);
    this.refreshHighlights();
    this.emit('layers');
  }

  // ---------- view ----------
  size(): { w: number; h: number } {
    return { w: this.glCanvas.clientWidth || 800, h: this.glCanvas.clientHeight || 600 };
  }

  toWorld(sx: number, sy: number): Vec2 {
    const { w, h } = this.size();
    return screenToWorld(this.view, w, h, sx, sy);
  }

  fit(): void {
    const b = this.scene?.bbox;
    const { w, h } = this.size();
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
    const before = this.toWorld(sx, sy);
    this.view.scale = Math.max(0.5, Math.min(4000, this.view.scale * factor));
    const after = this.toWorld(sx, sy);
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

  // ---------- picking & selection ----------
  /** The raw shape under the cursor (pad, trace, via, graphic), or null. */
  pickRaw(p: Vec2, filter?: (uid: string) => boolean): { uid: string; anchor?: Vec2 } | null {
    if (!this.scene) return null;
    const tol = 3 / this.view.scale;
    const nearSide = this.view.flipped ? 'B.' : 'F.';
    let best: { uid: string; anchor?: Vec2; score: number } | null = null;
    for (const pk of this.scene.pick) {
      if (p.x < pk.box.minX - tol || p.x > pk.box.maxX + tol || p.y < pk.box.minY - tol || p.y > pk.box.maxY + tol) continue;
      if (!pk.layers.some((l) => this.visible.has(l))) continue;
      if (filter && !filter(pk.uid)) continue;
      if (!pk.hit(p, tol)) continue;
      const area = (pk.box.maxX - pk.box.minX) * (pk.box.maxY - pk.box.minY);
      const side = pk.layers.some((l) => l === this.activeLayer) && this.mode === 'route' ? 2 : pk.layers.some((l) => l.startsWith(nearSide)) ? 1 : 0;
      const score = side * 1000 + pk.priority * 100 - Math.min(99, area);
      if (!best || score > best.score) best = { uid: pk.uid, score, ...(pk.anchor ? { anchor: pk.anchor } : {}) };
    }
    return best;
  }

  pickAt(sx: number, sy: number, deep: boolean): string | null {
    if (!this.doc) return null;
    const hit = this.pickRaw(this.toWorld(sx, sy));
    if (!hit) return null;
    if (deep) return hit.uid;
    let n = this.doc.nodes.get(hit.uid);
    while (n) {
      if (n.type === 'element') return n.uid;
      n = n.parent ? this.doc.nodes.get(n.parent) : undefined;
    }
    return hit.uid;
  }

  /** Net name a node belongs to (pads by property, tracks/vias/pours by parent net). */
  netOf(uid: string): string | null {
    const n = this.node(uid);
    if (!n) return null;
    if (n.type === 'pad') return typeof n.props.net === 'string' && n.props.net ? n.props.net : null;
    if (n.type === 'net') return n.name;
    const p = n.parent ? this.node(n.parent) : undefined;
    return p?.type === 'net' && p.name !== '(no net)' ? p.name : null;
  }

  netNode(name: string): DocNode | undefined {
    if (!this.doc) return undefined;
    for (const n of this.doc.nodes.values()) if (n.type === 'net' && n.name === name) return n;
    return undefined;
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

  highlightNet(net: string | null): void {
    this.netHighlight.clear();
    if (net && this.doc) {
      const nn = this.netNode(net);
      if (nn) this.netHighlight.add(nn.uid);
      for (const n of this.doc.nodes.values()) if (n.type === 'pad' && n.props.net === net) this.netHighlight.add(n.uid);
    }
    this.refreshHighlights();
  }

  // ---------- selector query ----------
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

  refreshHighlights(): void {
    if (!this.doc || !this.engine) return;
    const vis = (l: string) => this.visible.has(l);
    this.renderer.setLayer('__sel', highlightTris(this.doc, this.engine, this.selection, this.copper, vis));
    this.renderer.setLayer('__query', highlightTris(this.doc, this.engine, this.queryMatches, this.copper, vis));
    this.renderer.setLayer('__net', highlightTris(this.doc, this.engine, this.netHighlight, this.copper, vis));
    this.requestRender();
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
    const order = this.drawOrder()
      .filter((n) => this.visible.has(n))
      .map((key) => ({ key, color: layerColor(key) as RGBA }));
    order.push(
      { key: '__net', color: [1, 1, 1, 0.22] },
      { key: '__query', color: QUERY_HIGHLIGHT },
      { key: '__sel', color: HIGHLIGHT },
      { key: '__preview', color: this.route.previewColor() },
    );
    this.renderer.draw(this.view, order, [0.031, 0.035, 0.047, 1]);
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const c = this.overlay;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = this.size();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.scene) return;
    const S = (p: Vec2) => worldToScreen(this.view, w, h, p.x, p.y);

    // Texts
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const s = this.view.scale;
    for (const t of this.scene.texts) {
      if (t.kind === 'padNumber' ? s < 18 || !this.visible.has(t.layer) : !this.visible.has(t.layer)) continue;
      const px = t.size * s;
      if (px < 5) continue;
      const p = S(t.pos);
      if (p.x < -200 || p.y < -200 || p.x > w + 200 || p.y > h + 200) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      let rot = (-t.rot * Math.PI) / 180;
      if (this.view.flipped) rot = -rot;
      if (Math.cos(rot) < -0.01) rot += Math.PI;
      ctx.rotate(rot);
      ctx.font = `${t.kind === 'padNumber' ? 600 : 500} ${px.toFixed(1)}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = t.kind === 'padNumber' ? 'rgba(255,255,255,0.85)' : cssColor(layerColor(t.layer));
      ctx.fillText(t.text, 0, 0);
      ctx.restore();
    }

    // Ratsnest
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(235, 240, 255, 0.7)';
    ctx.beginPath();
    for (const l of this.ratsnest.lines) {
      const a = S(l.a);
      const b = S(l.b);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // DRC markers (unrouted connections are already shown by the ratsnest)
    if (this.drc) {
      for (const v of this.drc.violations) {
        if (v.kind === 'unrouted' || v.kind === 'noOutline') continue;
        const p = S(v.at);
        if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) continue;
        const focus = v.id === this.focusedViolation;
        const r = focus ? 11 : 6;
        ctx.lineWidth = focus ? 2.5 : 1.5;
        ctx.strokeStyle = v.severity === 'error' ? 'rgba(255, 90, 90, 0.95)' : 'rgba(255, 200, 60, 0.95)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.moveTo(p.x - r * 0.6, p.y - r * 0.6);
        ctx.lineTo(p.x + r * 0.6, p.y + r * 0.6);
        ctx.moveTo(p.x + r * 0.6, p.y - r * 0.6);
        ctx.lineTo(p.x - r * 0.6, p.y + r * 0.6);
        ctx.stroke();
      }
    }

    // Routing cursor
    this.route.drawOverlay(ctx, S);
  }
}
