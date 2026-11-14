/**
 * Application state: the document, its style engine, history, scene and view.
 * Every edit goes through `apply()` (→ History → ops), never by mutating the doc.
 */
import { type WaivedViolation,
  computeRatsnest,
  createDoc,
  extractNetlist,
  fpKey,
  hasClipper,
  newProjectOps,
  planSync,
  pinPadCheck,
  runErc,
  systemDefaults,
  applyOps,
  arcPoints,
  type ErcViolation,
  type Netlist,
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
  type RouteSnapshot,
  type Vec2,
} from '@hassassin/core';
import { importKicadPcb, importKicadSchematic, type LayerInfo } from '@hassassin/kicad-import';
import { buildFab, fabZip } from '@hassassin/fab';
import { commentsContainer, opsAllowed, type SyncClient, type SyncTarget } from '@hassassin/sync';
import { cssColor, HIGHLIGHT, layerColor, QUERY_HIGHLIGHT, type RGBA } from './render/colors.ts';
import { GLRenderer, screenToWorld, worldToScreen, type View } from './render/gl.ts';
import { HOLES, highlightTris, SceneCache } from './render/scene.ts';
import { RouteTool } from './tools/route.ts';
import { circle, polyline } from './render/geometry.ts';
import { library } from './library.ts';

export type Inspected = { kind: 'node'; uid: string } | { kind: 'ruleset'; id: string } | { kind: 'none' };
export type Mode = 'select' | 'route';
type Event = 'parts' | 'doc' | 'change' | 'selection' | 'layers' | 'rules' | 'query' | 'view' | 'inspect' | 'mode' | 'status' | 'drc' | 'space' | 'sheet' | 'collab' | 'presence' | 'comments';
export type Space = 'layout' | 'schematic';

const DEFAULT_HIDDEN = new Set(['paste', 'mask', 'adhesive', 'courtyard', 'fab', 'user']);
const DEFAULT_LAYERS: LayerInfo[] = [
  ['F.Cu', 'copper', 'front'], ['B.Cu', 'copper', 'back'], ['F.SilkS', 'silk', 'front'], ['B.SilkS', 'silk', 'back'],
  ['F.Mask', 'mask', 'front'], ['B.Mask', 'mask', 'back'], ['F.Paste', 'paste', 'front'], ['B.Paste', 'paste', 'back'],
  ['F.CrtYd', 'courtyard', 'front'], ['F.Fab', 'fab', 'front'], ['Edge.Cuts', 'edge', 'none'],
].map(([name, kind, side], index) => ({ name: name!, kind: kind as LayerInfo['kind'], side: side as LayerInfo['side'], index }));
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
  erc: { violations: ErcViolation[]; waived: WaivedViolation[]; netlist: Netlist } | null = null;
  space: Space = 'layout';
  /** Live collaboration session, when the project is opened from a server. */
  collab: SyncClient | null = null;
  /** Next canvas click places a comment. */
  commentMode = false;
  focusedComment: string | null = null;
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
  /** Counts document changes (caches keyed on the board, e.g. the route tool's obstacles, use it). */
  docVersion = 0;
  /** Copper layers with a live autorouter preview drawn (P4); empty when none. */
  private livePreview: string[] = [];
  private move: MoveState | null = null;
  readonly renderer: GLRenderer;

  readonly glCanvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;

  constructor(glCanvas: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.glCanvas = glCanvas;
    this.overlay = overlay;
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
  /** Open several files at once: a board and/or schematics (first .kicad_sch named like the board is the root). */
  loadProject(files: { name: string; text: string }[]): void {
    const pcb = files.find((f) => /\.kicad_pcb$/i.test(f.name));
    const hpcb = files.find((f) => /\.hpcb$/i.test(f.name));
    const schs = files.filter((f) => /\.kicad_sch$/i.test(f.name));
    if (hpcb) return this.load(hpcb.text, hpcb.name);
    let doc: Doc;
    let layers: LayerInfo[];
    let stats: Record<string, number> = {};
    let name = 'project';
    if (pcb) {
      const res = importKicadPcb(pcb.text, pcb.name);
      doc = res.doc;
      layers = res.layers;
      stats = res.stats;
      name = pcb.name.replace(/\.kicad_pcb$/i, '');
    } else {
      doc = createDoc(systemDefaults());
      layers = DEFAULT_LAYERS;
      doc.meta.layers = layers;
    }
    if (schs.length) {
      const map: Record<string, string> = {};
      for (const f of schs) map[f.name] = f.text;
      const referenced = new Set<string>();
      for (const f of schs) for (const m of f.text.matchAll(/\(property "Sheet ?file" "([^"]+)"/g)) referenced.add(m[1]!.split('/').pop()!);
      const root = schs.find((f) => pcb && f.name === pcb.name.replace(/\.kicad_pcb$/i, '.kicad_sch')) ?? schs.find((f) => !referenced.has(f.name)) ?? schs[0]!;
      const r = importKicadSchematic({ files: map, root: root.name }, doc);
      for (const w of r.warnings) console.warn('[schematic]', w);
      if (!pcb) name = root.name.replace(/\.kicad_sch$/i, '');
    }
    this.setDoc(doc, layers, name, stats);
    if (schs.length && !pcb) this.setSpace('schematic');
  }

  newProject(): void {
    const doc = createDoc(systemDefaults());
    doc.meta.layers = DEFAULT_LAYERS;
    applyOps(doc, newProjectOps(doc));
    this.setDoc(doc, DEFAULT_LAYERS, 'untitled', {});
    this.setSpace('schematic');
    this.say('New project: add parts with A, draw wires with W, then “Update PCB”.');
  }

  setSpace(space: Space): void {
    if (this.space === space) return;
    this.space = space;
    if (space === 'schematic') this.route.cancel();
    this.emit('space');
    this.requestRender();
  }

  /** Push the schematic into the board as one undo step (footprints come from the library). */
  async syncToPcb(): Promise<void> {
    if (!this.doc || !this.engine) return;
    const doc = this.doc;
    if (![...doc.nodes.values()].some((n) => n.type === 'sheet')) return this.say('There is no schematic to update from.');
    const names = [...doc.nodes.values()].filter((n) => n.type === 'symbol' && !n.props.power && n.props.Footprint).map((n) => String(n.props.Footprint));
    this.say('Updating board…');
    const resolveFootprint = await library.resolver(doc, names);
    if (this.doc !== doc || !this.engine) return;
    const nl = extractNetlist(doc, this.engine);
    const { ops, report } = planSync(doc, this.engine, nl, { resolveFootprint, copper: this.copper });
    if (!ops.length) return this.say('The board already matches the schematic.');
    const keep: Op[] = [];
    for (const n of new Set(names)) {
      const fp = resolveFootprint(n);
      if (fp && fp.source !== 'generic' && !doc.meta[fpKey(n)]) keep.push({ op: 'setMeta', key: fpKey(n), value: { ...fp, name: n } });
    }
    this.apply('Update PCB from schematic', [...keep, ...ops]);
    const parts = [
      report.componentsAdded.length && `${report.componentsAdded.length} part(s) added`,
      report.footprintsChanged.length && `${report.footprintsChanged.length} footprint(s) replaced`,
      report.footprintsMissing.length && `${report.footprintsMissing.length} footprint(s) not found (placeholders)`,
      report.propChanges && `${report.propChanges} propert${report.propChanges === 1 ? 'y' : 'ies'} copied`,
      report.padChanges && `${report.padChanges} pad net(s) changed`,
      report.netsRenamed.length && `${report.netsRenamed.length} net(s) renamed`,
      report.netsCreated.length && `${report.netsCreated.length} net(s) created`,
      report.netsRemoved.length && `${report.netsRemoved.length} empty net(s) removed`,
      report.onlyOnPcb.length && `${report.onlyOnPcb.length} board-only part(s) kept (${report.onlyOnPcb.slice(0, 4).join(', ')})`,
    ].filter(Boolean);
    // Pin ↔ pad check (S20): the details are in Review (ERC).
    const pp = pinPadCheck(doc, { resolve: resolveFootprint });
    if (pp.length) parts.push(`pins and pads differ on ${pp.map((f) => f.ref).slice(0, 4).join(', ')}${pp.length > 4 ? ' …' : ''} (see Review)`);
    this.say(`Board updated: ${parts.join(' · ')}.`);
  }

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

  /** Swap in a new copy of the document (from the server) without resetting the view. */
  replaceDoc(doc: Doc, name?: string): void {
    const layers = (doc.meta.layers as LayerInfo[] | undefined) ?? this.layers;
    this.setDoc(doc, layers.length ? layers : DEFAULT_LAYERS, name ?? this.fileName, this.stats, true);
  }

  /** The adapter the collaboration client uses to read and update this app. */
  syncTarget(): SyncTarget {
    return {
      doc: () => this.doc!,
      history: () => this.history!,
      replace: (d) => this.replaceDoc(d),
      changed: (res) => this.applyChange(res, true),
    };
  }

  private setDoc(doc: Doc, layers: LayerInfo[], name: string, stats: Record<string, number>, keepView = false): void {
    const keep = keepView && this.doc ? { view: { ...this.view }, space: this.space, visible: new Set(this.visible), selection: [...this.selection] } : null;
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
    this.space = [...doc.nodes.values()].some((n) => n.type === 'layout') ? 'layout' : 'schematic';
    this.route.cancel();
    this.docVersion++;
    this.engine = new StyleEngine(doc);
    this.history = new History(doc);
    this.history.onChange((res, kind) => kind !== 'remote' && this.applyChange(res, false));
    this.scene = new SceneCache(doc, this.engine, this.copper);
    if (keep) {
      this.view = keep.view;
      this.space = keep.space;
      this.visible = keep.visible;
      for (const u of keep.selection) if (doc.nodes.has(u)) this.selection.add(u);
    }
    this.uploadLayers(true);
    this.updateRatsnest();
    this.drc = null;
    this.runDrcSoon(50);
    this.dirty = false;
    if (!keep) this.fit();
    this.emit('doc');
    this.emit('mode');
    this.emit('comments');
  }

  serialize(): string {
    if (!this.doc) throw new Error('No document');
    return stringifyDoc(this.doc);
  }

  // ---------- editing ----------
  apply(label: string, ops: Op[], mergeKey?: string): boolean {
    if (!this.history || !ops.length || !this.doc) return false;
    if (this.collab) {
      const why = opsAllowed(this.collab.role, this.doc, ops);
      if (why) {
        this.say(why);
        return false;
      }
    }
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

  /** React to a document change (local edit, or `remote` from collaborators). */
  applyChange(res: ApplyResult, remote: boolean): void {
    if (!this.doc || !this.engine || !this.scene) return;
    this.docVersion++;
    if (remote && this.move) this.endMove();
    this.engine.recompute();
    if (res.global) this.scene.rebuildAll();
    else this.scene.update(res.touched);
    for (const u of [...this.selection]) if (!this.doc.nodes.has(u)) this.selection.delete(u);
    if (this.inspected.kind === 'node' && !this.doc.nodes.has(this.inspected.uid)) this.inspected = { kind: 'none' };
    this.uploadLayers(false);
    this.updateRatsnest();
    this.runDrcSoon();
    if (this.queryText) this.runQuery(this.queryText);
    if (!this.collab) this.dirty = true;
    this.emit('change');
    if ([...res.touched].some((u) => this.doc!.nodes.get(u)?.type === 'comment') || res.global) this.emit('comments');
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

  /** World bounding box of an object (components: all their shapes). */
  boxFor(uid: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.scene || !this.doc) return null;
    const want = new Set<string>([uid]);
    const n = this.doc.nodes.get(uid);
    if (n?.type === 'element') for (const c of n.children) want.add(c);
    let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    for (const pk of this.scene.pick) {
      if (!want.has(pk.uid)) continue;
      b = b ? { minX: Math.min(b.minX, pk.box.minX), minY: Math.min(b.minY, pk.box.minY), maxX: Math.max(b.maxX, pk.box.maxX), maxY: Math.max(b.maxY, pk.box.maxY) } : { ...pk.box };
    }
    return b;
  }

  /** Comment thread whose pin is under the screen point, if any. */
  commentAt(space: Space, sheet: string | undefined, sx: number, sy: number, toScreen: (p: Vec2) => Vec2): DocNode | null {
    for (const c of this.comments()) {
      if (c.props.space !== space || (space === 'schematic' && c.props.sheet !== sheet) || c.props.resolved) continue;
      const q = toScreen({ x: Number(c.props.x), y: Number(c.props.y) });
      if (Math.hypot(q.x + 9 - sx, q.y - 9 - sy) < 12) return c;
    }
    return null;
  }

  // ---------- comments ----------
  comments(): DocNode[] {
    const c = this.doc ? commentsContainer(this.doc) : undefined;
    return c ? c.children.map((u) => this.doc!.nodes.get(u)!).filter((n) => n?.type === 'comment') : [];
  }

  addComment(anchor: { space: Space; sheet?: string; x: number; y: number }, text: string, author: string, color: string, blocking = false): void {
    const c = this.doc ? commentsContainer(this.doc) : undefined;
    if (!c) return this.say('Comments need a shared project: click Share first.');
    const uid = newUid('cm');
    if (
      this.apply('Comment', [
        {
          op: 'add',
          parent: c.uid,
          index: c.children.length,
          tree: {
            nodes: [
              {
                uid,
                type: 'comment',
                name: '',
                props: { text, author, color, createdAt: new Date().toISOString(), resolved: false, blocking, space: anchor.space, ...(anchor.sheet ? { sheet: anchor.sheet } : {}), x: anchor.x, y: anchor.y },
                rules: [],
                parent: c.uid,
                children: [],
              },
            ],
          },
        },
      ])
    )
      this.focusedComment = uid;
  }

  reply(threadUid: string, text: string, author: string, color: string): void {
    const t = this.node(threadUid);
    if (!t) return;
    this.apply('Reply', [{ op: 'add', parent: t.uid, index: t.children.length, tree: { nodes: [{ uid: newUid('cm'), type: 'comment', name: '', props: { text, author, color, createdAt: new Date().toISOString() }, rules: [], parent: t.uid, children: [] }] } }]);
  }

  setCommentProp(uid: string, key: string, value: string | boolean | null): void {
    this.apply(key === 'resolved' ? (value ? 'Resolve comment' : 'Reopen comment') : 'Edit comment', [{ op: 'setProp', uid, key, value }]);
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
    const hasSch = [...this.doc.nodes.values()].some((n) => n.type === 'sheet');
    this.erc = hasSch ? runErc(this.doc, this.engine) : null;
    this.drc = runDrc(this.doc, this.engine, this.copper, { ratsnest: this.ratsnest });
    if (this.focusedViolation && !this.drc.violations.some((v) => v.id === this.focusedViolation) && !this.erc?.violations.some((v) => v.id === this.focusedViolation)) this.focusedViolation = null;
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
    this.say(mode === 'route' ? `Route (${this.route.mode}): click a pad, via or trace to start. M = mode, W = width, V = via, / = corner style, Esc = stop.` : '');
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

  /**
   * Live preview of the autorouter (P4): the routes it holds right now, drawn faint above the board.
   * Nothing on the board changes; `null` removes the overlay.
   */
  setLivePreview(snap: RouteSnapshot | null): void {
    for (const l of this.livePreview) this.renderer.setLayer(`__live:${l}`, new Float32Array());
    this.livePreview = [];
    if (snap) {
      const per = new Map<string, number[]>();
      const tris = (l: string) => per.get(l) ?? per.set(l, []).get(l)!;
      for (const t of snap.traces) polyline(tris(t.layer), t.mid ? arcPoints(t.a, t.mid, t.b) : [t.a, t.b], t.w, false);
      for (const v of snap.vias) for (const l of this.copper) circle(tris(l), v.at, v.d / 2);
      for (const [l, arr] of per) {
        this.renderer.setLayer(`__live:${l}`, new Float32Array(arr));
        this.livePreview.push(l);
      }
    }
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
      { key: '__shove', color: [1, 0.75, 0.3, 0.55] },
      { key: '__preview', color: this.route.dragColor ?? this.route.previewColor() },
    );
    for (const l of this.livePreview) {
      if (!this.visible.has(l)) continue;
      const c = layerColor(l);
      order.splice(order.length - 5, 0, { key: `__live:${l}`, color: [c[0], c[1], c[2], 0.45] });
    }
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

    // Comment pins and collaborators
    drawComments(ctx, this, 'layout', undefined, S);
    if (this.collab) {
      for (const p of this.collab.peers.values()) {
        for (const uid of p.selection) {
          const b = this.boxFor(uid);
          if (!b) continue;
          const a = S({ x: b.minX, y: b.minY });
          const c = S({ x: b.maxX, y: b.maxY });
          ctx.strokeStyle = p.user.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(Math.min(a.x, c.x) - 2, Math.min(a.y, c.y) - 2, Math.abs(c.x - a.x) + 4, Math.abs(c.y - a.y) + 4);
        }
        if (p.cursor?.space === 'layout') drawPeerCursor(ctx, S(p.cursor), p.user.name, p.user.color, p.user.kind === 'agent');
      }
    }

    // Routing cursor
    this.route.drawOverlay(ctx, S);
  }
}


/** Speech-bubble pins for unresolved comments in one space (and sheet). */
export function drawComments(ctx: CanvasRenderingContext2D, app: App, space: Space, sheet: string | undefined, S: (p: Vec2) => Vec2): void {
  const all = app.comments();
  all.forEach((c, i) => {
    if (c.props.space !== space || (space === 'schematic' && c.props.sheet !== sheet) || c.props.resolved) return;
    const p = S({ x: Number(c.props.x), y: Number(c.props.y) });
    const focused = app.focusedComment === c.uid;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = String(c.props.color ?? '#f2a93b');
    ctx.strokeStyle = focused ? '#ffffff' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = focused ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(4, -6);
    ctx.arc(9, -9, 9, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 2 - 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#16120a';
    ctx.font = '600 10px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), 9, -9);
    if (c.props.blocking) {
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(16, -16, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  });
}

/** A collaborator's pointer with a name tag. */
export function drawPeerCursor(ctx: CanvasRenderingContext2D, p: Vec2, name: string, color: string, agent: boolean): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(4, 11);
  ctx.lineTo(8, 18);
  ctx.lineTo(10, 17);
  ctx.lineTo(6, 10);
  ctx.lineTo(11, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.font = '600 11px system-ui';
  const label = agent ? `⚙ ${name}` : name;
  const w = ctx.measureText(label).width + 10;
  ctx.fillRect(12, 14, w, 17);
  ctx.fillStyle = '#111';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 17, 23);
  ctx.restore();
}
