/**
 * Schematic editor view (Canvas 2D). Shows one sheet at a time.
 * Tools: select/move (drag; attached wires follow), wire (W), net label (L), add part (A), rotate (R), mirror (X / Y),
 * delete (Del), enter sub-sheet (double-click a sheet block), up (Backspace on empty / U).
 */
import {
  genericPart,
  isGroundNet,
  moveSymbolsOps,
  snapshotWires,
  straightenSafelyOps,
  netGroups,
  applyOps,
  type WiresBefore,
  transformSelectionOps,
  sheetFrame,
  noteBox,
  groupBoxRect,
  sheetContentBox,
  addNoteOp,
  addGroupBoxOp,
  groupBoxAround,
  alignOps,
  type AlignMode,
  layoutSheetTexts,
  type PlacedText,
  pinGridOrigin,
  symbolPinLocals,
  schematicGrid,
  type SchematicGrid,
  routeWirePath,
  wirePathOps,
  renameRefOps,
  setPartPropsOps,
  withJunctionsOps,
  junctionOps,
  dragWireOps,
  copyItems,
  pasteOps,
  isClip,
  type Clip,
  itemsInRect,
  symbolBounds,
  placePartOps,
  type PartDef,
  arcPoints,
  dist,
  distToSegment,
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

/**
 * Best guess whether a wheel event comes from a trackpad (two-finger scroll) rather than a mouse
 * wheel: trackpads send pixel deltas, often sideways, in steps that are not multiples of a notch.
 */
function isTrackpadScroll(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return false;
  if (Math.abs(e.deltaX) > 0) return true;
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (typeof legacy === 'number' && legacy !== 0) return legacy % 120 !== 0;
  return !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

export class SchematicView {
  sheetUid: string | null = null;
  tool: Tool = 'select';
  view: View = { cx: 0, cy: 0, scale: 6 };
  private wireStart: Vec2 | null = null;
  private wireHorizontalFirst = true;
  private cursor: Vec2 = { x: 0, y: 0 };
  private drag: {
    x: number;
    y: number;
    moved: boolean;
    kind: 'pan' | 'move' | 'box' | 'none';
    /** Dragging one wire segment: its neighbours stretch (S4). */
    wireOnly?: string;
    /** Grid offset applied by the last drag frame. */
    last?: Vec2;
    /** Selection box corners in screen pixels (kind 'box'). */
    box?: { a: Vec2; b: Vec2 };
    start: Vec2;
    key: string;
    items: { uid: string; rules: Record<string, Vec2> }[];
    /** Selected symbols: original positions (moved through moveSymbolsOps so wires follow). */
    symbols: { uid: string; at: Vec2 }[];
    /** Wire ends before the drag, to straighten wires on drop. */
    wires: WiresBefore | null;
    /** Net partition before the drag, to warn when the drop connects or splits nets. */
    nets: string | null;
  } | null = null;
  private frame = 0;
  /** Space held: dragging pans. */
  private spaceDown = false;
  /** Copied items (also kept in localStorage so another tab can paste them). */
  private clip: Clip | null = null;
  /** A paste in progress: follows the mouse until a click places it. */
  private swallowClick = false;
  private wirePathCache: { key: string; value: { path: Vec2[]; clean: boolean } } | null = null;
  private layoutCache: { key: string; value: Map<string, PlacedText[]> } | null = null;
  /** Bumped on every document change (invalidates cached wire paths). */
  private rev = 0;
  private pasting: { key: string; positions: { uid: string; name: string; value: Vec2 }[]; base: Vec2 } | null = null;
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
    app.on('change', () => this.rev++);
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
    return symbolBounds(this.app.doc!, this.app.engine!, sym.uid);
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
    const fr = this.app.doc && this.sheet() ? sheetFrame(this.app.doc, this.sheet()!) : null;
    if (fr) (grow({ x: fr.paper.minX, y: fr.paper.minY - 3 }), grow({ x: fr.paper.maxX, y: fr.paper.maxY }));
    const content = this.app.doc && this.sheet() ? sheetContentBox(this.app.doc, e, this.sheet()!) : null;
    if (content) (grow({ x: content.minX, y: content.minY }), grow({ x: content.maxX, y: content.maxY }));
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
      } else if (n.type === 'note') {
        const b = noteBox(e, n);
        if (b && p.x >= b.minX - tol && p.x <= b.maxX + tol && p.y >= b.minY - tol && p.y <= b.maxY + tol) offer(n, 3.5);
      } else if (n.type === 'groupBox') {
        // Only its outline and title pick a group box, so clicks inside still reach the parts.
        const b = groupBoxRect(e, n);
        if (!b) continue;
        const onEdge = (Math.abs(p.x - b.minX) < tol * 1.5 || Math.abs(p.x - b.maxX) < tol * 1.5) && p.y >= b.minY && p.y <= b.maxY;
        const onEdgeY = (Math.abs(p.y - b.minY) < tol * 1.5 || Math.abs(p.y - b.maxY) < tol * 1.5) && p.x >= b.minX && p.x <= b.maxX;
        const onTitle = p.x >= b.minX && p.x <= b.minX + 2 + n.name.length * 0.85 && p.y >= b.minY && p.y <= b.minY + 2.6;
        if (onEdge || onEdgeY || onTitle) offer(n, 1.5);
      } else if (n.type === 'block') {
        const q = vec(e.get(n.uid, 'position')?.value);
        const s = vec(e.get(n.uid, 'size')?.value);
        if (q && s && p.x >= q.x && p.x <= q.x + s.x && p.y >= q.y && p.y <= q.y + s.y) offer(n, 1);
      }
    }
    return (best as { n: DocNode } | null)?.n ?? null;
  }

  /** The project's schematic grid (pin grid for parts, wire grid for everything else). */
  grid(): SchematicGrid {
    return schematicGrid(this.app.doc);
  }

  // ---------- editing ----------
  private snap(p: Vec2): Vec2 {
    return snapToGrid(p, this.grid().wire);
  }

  addPart(kind: PartKind, opts: { pins?: number; value?: string } = {}): void {
    this.placePart(genericPart(kind, opts));
  }

  /** Place every unit of a library part at the view centre (part + footprint copied into the project). */
  placePart(part: PartDef, extra: Op[] = []): void {
    const s = this.sheet();
    const doc = this.app.doc;
    if (!s || !doc) return this.app.say('Open or create a schematic first.');
    const at = this.snap({ x: this.view.cx, y: this.view.cy });
    // Step right past symbols already sitting at the view centre.
    const taken = s.children.map((c) => doc.nodes.get(c)).filter((n) => n?.type === 'symbol').map((n) => this.app.engine?.get(n!.uid, 'position')?.value as Vec2 | undefined);
    for (let i = 0; i < 40 && taken.some((q) => q && Math.abs(q.x - at.x) < 7 && Math.abs(q.y - at.y) < 7); i++) at.x += 12.7;
    const { ops, ref, uids } = placePartOps(doc, s.uid, part, at);
    if (this.app.apply(`Place ${part.name}`, [...extra, ...ops])) {
      this.app.select(uids);
      this.app.say(`Placed ${ref}${uids.length > 1 ? ` (${uids.length} units)` : ''}. Drag it into place; R rotates, X / Y mirror.`);
    }
  }

  addLabel(at: Vec2, name: string, kind: 'local' | 'global' = 'local'): void {
    const s = this.sheet();
    if (!s || !name.trim()) return;
    this.app.apply('Add label', [
      { op: 'add', parent: s.uid, index: s.children.length, tree: { nodes: [{ uid: newUid('lbl'), type: 'label', name: name.trim(), props: { kind }, rules: [{ name: 'position', value: at }, { name: 'rotation', value: 0 }], parent: s.uid, children: [] }] } },
    ]);
  }

  /** Path the wire tool would draw from `a` to `b`: clean if possible, else the plain L (flagged). */
  private wirePath(a: Vec2, b: Vec2): { path: Vec2[]; clean: boolean } {
    const s = this.sheet();
    const key = `${a.x},${a.y}>${b.x},${b.y}|${this.wireHorizontalFirst}|${this.rev}`;
    if (this.wirePathCache?.key === key) return this.wirePathCache.value;
    const routed = s && this.app.doc && this.app.engine ? routeWirePath(this.app.doc, this.app.engine, s.uid, a, b, { horizontalFirst: this.wireHorizontalFirst }) : null;
    const mid = this.wireHorizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const value = routed ? { path: routed, clean: true } : { path: [a, mid, b], clean: false };
    this.wirePathCache = { key, value };
    return value;
  }

  private addWire(a: Vec2, b: Vec2): void {
    const s = this.sheet();
    const doc = this.app.doc;
    if (!s || !doc || dist(a, b) < 1e-6) return;
    const { path, clean } = this.wirePath(a, b);
    if (this.app.apply('Draw wire', this.withJunctions(wirePathOps(doc, s.uid, path))) && !clean)
      this.app.say('No clean path: this wire crosses a part or touches another net. Undo and use net labels (L), or move parts to make room.');
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

  /** Nets as sorted pin groups (names ignored), to notice connection changes. */
  private netPartition(): string | null {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return null;
    return netGroups(doc, e);
  }

  /** Turn the selection 90° (key R): one symbol around its origin, several items around their centre. */
  rotateSelection(): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return;
    const ops = transformSelectionOps(doc, e, [...this.app.selection], 'rotate', this.grid().pin);
    if (ops.length) this.applyKeepingNets('Rotate', ops, 'Rotating');
  }

  /** Align or spread the selected parts (at least two; three to spread). */
  alignSelection(mode: AlignMode): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return;
    const ops = alignOps(doc, e, this.app.selection, mode);
    if (!ops.length) return this.app.say(mode.startsWith('distribute') ? 'Select at least three parts to spread them.' : 'Select at least two parts to align them.');
    this.applyKeepingNets(`Align ${mode}`, ops, 'Aligning');
  }

  /** Apply an edit that must not change connectivity; undo it and explain if it would. */
  private applyKeepingNets(label: string, ops: Op[], verb: string): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (doc && e) {
      // Try it on the document for a moment, then put it back before deciding.
      const before = netGroups(doc, e);
      const r = applyOps(doc, ops);
      e.recompute();
      const after = netGroups(doc, e);
      applyOps(doc, r.inverse);
      e.recompute();
      if (after !== before) return this.app.say(`${verb} here would connect a pin or wire to another net. Move the part to a spot with more room first.`);
    }
    this.app.apply(label, this.withJunctions(ops));
  }

  /** Flip the selection left↔right ('h', key X) or top↔bottom ('v', key Y); wires follow. */
  mirrorSelection(axis: 'h' | 'v'): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return;
    const ops = transformSelectionOps(doc, e, [...this.app.selection], axis === 'h' ? 'mirror-h' : 'mirror-v', this.grid().pin);
    if (ops.length) this.applyKeepingNets(axis === 'h' ? 'Mirror left–right' : 'Mirror top–bottom', ops, 'Mirroring');
    else this.app.say('Select something to mirror.');
  }

  /** Add / remove junction dots on this sheet, merged into the undo step `key`. */
  private fixJunctions(key: string): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    const s = this.sheet();
    if (!doc || !e || !s) return;
    const ops = junctionOps(doc, e, s.uid);
    if (ops.length) this.app.apply('Junctions', ops, key);
  }

  /** `ops` plus the junction dots they add or make unnecessary. */
  private withJunctions(ops: Op[]): Op[] {
    const doc = this.app.doc;
    const e = this.app.engine;
    return doc && e ? withJunctionsOps(doc, e, ops) : ops;
  }

  /** Text placement of the current sheet, by owner uid (recomputed after document changes). */
  private textLayout(): Map<string, PlacedText[]> {
    const sheet = this.sheet();
    const doc = this.app.doc;
    const e = this.app.engine;
    const key = `${sheet?.uid}|${this.rev}`;
    if (this.layoutCache?.key === key) return this.layoutCache.value;
    const value = new Map<string, PlacedText[]>();
    if (sheet && doc && e) for (const t of layoutSheetTexts(doc, e, sheet.uid)) (value.get(t.owner) ?? value.set(t.owner, []).get(t.owner)!).push(t);
    this.layoutCache = { key, value };
    return value;
  }

  // ---------- in-place editing (S5) ----------
  /** Screen rectangles of a symbol's reference and value texts (as drawn). */
  private fieldRects(n: DocNode): { field: 'ref' | 'value'; text: string; at: Vec2; size: number; minX: number; minY: number; maxX: number; maxY: number }[] {
    if (n.type !== 'symbol' || n.props.power) return [];
    const out = [];
    for (const t of this.textLayout().get(n.uid) ?? []) {
      if (t.field !== 'ref' && t.field !== 'value') continue;
      out.push({ field: t.field, text: t.text, at: t.at, size: t.size, minX: t.box.minX - 0.3, minY: t.box.minY - 0.2, maxX: t.box.maxX + 0.3, maxY: t.box.maxY + 0.2 });
    }
    return out;
  }

  /** The reference / value text under a sheet point, if any. */
  private fieldAt(p: Vec2): { sym: DocNode; field: 'ref' | 'value' } | null {
    for (const n of this.items()) {
      for (const r of this.fieldRects(n)) if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) return { sym: n, field: r.field };
    }
    return null;
  }

  /** Edit a symbol's reference or value in a text box over the sheet: Enter saves, Esc cancels. */
  editField(sym: DocNode, field: 'ref' | 'value'): void {
    const r = this.fieldRects(sym).find((x) => x.field === field);
    if (!r) return;
    const ref = String(sym.props.ref ?? sym.name);
    const box = this.canvas.getBoundingClientRect();
    const q = this.toScreen({ x: r.minX, y: r.minY });
    const px = Math.max(12, Math.min(28, r.size * this.view.scale));
    const input = document.createElement('input');
    input.className = 'sch-field-edit';
    input.value = field === 'ref' ? ref : String(sym.props.Value ?? '');
    input.setAttribute('aria-label', field === 'ref' ? 'Reference' : 'Value');
    Object.assign(input.style, { position: 'fixed', left: `${box.left + q.x - 4}px`, top: `${box.top + q.y - 4}px`, font: `${px}px ui-monospace, Menlo, monospace`, minWidth: '80px', width: `${Math.max(80, (input.value.length + 4) * px * 0.62)}px`, zIndex: '50' });
    document.body.append(input);
    input.focus();
    input.select();
    let done = false;
    const close = (save: boolean) => {
      if (done) return;
      done = true;
      input.remove();
      if (!save) return this.requestRender();
      const doc = this.app.doc;
      const v = input.value.trim();
      if (!doc) return;
      try {
        if (field === 'ref') {
          const ops = renameRefOps(doc, ref, v);
          if (ops.length) this.app.apply(`Rename ${ref} to ${v}`, ops);
        } else if (v !== String(sym.props.Value ?? '')) this.app.apply(`Value of ${ref}`, setPartPropsOps(doc, ref, { Value: v || null }));
      } catch (e) {
        this.app.say((e as Error).message);
      }
      this.requestRender();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  // ---------- notes, group boxes, frame (S9) ----------
  /** A text box over the sheet at `at`; multi-line uses Shift+Enter for a new line. Enter saves, Esc cancels. */
  private openEditor(at: Vec2, value: string, multiline: boolean, onSave: (v: string) => void): void {
    const box = this.canvas.getBoundingClientRect();
    const q = this.toScreen(at);
    const el = document.createElement(multiline ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
    el.className = 'sch-field-edit';
    el.value = value;
    Object.assign(el.style, { position: 'fixed', left: `${box.left + q.x - 4}px`, top: `${box.top + q.y - 4}px`, font: '14px ui-monospace, Menlo, monospace', minWidth: '160px', zIndex: '50', ...(multiline ? { minHeight: '60px' } : {}) });
    document.body.append(el);
    el.focus();
    el.select();
    let done = false;
    const close = (save: boolean) => {
      if (done) return;
      done = true;
      el.remove();
      if (save && el.value.trim() && el.value !== value) onSave(el.value.replace(/\s+$/, ''));
      this.requestRender();
    };
    el.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      ev.stopPropagation();
      if (ev.key === 'Enter' && !(multiline && ev.shiftKey)) (ev.preventDefault(), close(true));
      else if (ev.key === 'Escape') close(false);
    });
    el.addEventListener('blur', () => close(true));
  }

  /** Key T: a free text note at the cursor. */
  addNoteAtCursor(): void {
    const s = this.sheet();
    if (!s) return;
    const at = this.cursor;
    this.openEditor(at, '', true, (text) => {
      const { op, uid } = addNoteOp(s, text, at);
      if (this.app.apply('Add note', [op])) this.app.select([uid]);
    });
  }

  /** Key G: a titled box around the selection. */
  groupSelection(): void {
    const s = this.sheet();
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!s || !doc || !e) return;
    const rect = groupBoxAround(doc, e, this.app.selection);
    if (!rect) return this.app.say('Select the parts of a block, then press G to draw a titled box around them.');
    this.openEditor({ x: rect.minX + 1, y: rect.minY + 0.6 }, 'Group', false, (title) => {
      const { op, uid } = addGroupBoxOp(s, title, rect);
      if (this.app.apply('Add group box', [op])) this.app.select([uid]);
    });
  }

  /** Double-click on a note or a group box title edits its text. */
  private editNoteOrGroup(n: DocNode): void {
    const e = this.app.engine;
    if (!e) return;
    const at = n.type === 'note' ? vec(e.get(n.uid, 'position')?.value) : (() => {
      const r = groupBoxRect(e, n);
      return r ? { x: r.minX + 1, y: r.minY + 0.6 } : undefined;
    })();
    if (!at) return;
    this.openEditor(at, n.name, n.type === 'note', (v) => this.app.apply(n.type === 'note' ? 'Edit note' : 'Rename group box', [{ op: 'setName', uid: n.uid, name: v }]));
  }

  // ---------- copy / paste ----------
  copySelection(): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return;
    const clip = copyItems(doc, e, this.app.selection, this.grid().wire);
    if (!clip) return this.app.say('Select symbols, wires or labels to copy.');
    this.clip = clip;
    try {
      localStorage.setItem('hassassin.schematicClip', JSON.stringify(clip));
    } catch {
      // Storage may be unavailable (private mode); the copy still works in this tab.
    }
    this.app.say(`Copied ${clip.trees.length} item${clip.trees.length > 1 ? 's' : ''}.`);
  }

  paste(): void {
    let clip = this.clip;
    try {
      const stored = JSON.parse(localStorage.getItem('hassassin.schematicClip') ?? 'null');
      if (isClip(stored)) clip = stored;
    } catch {
      // Ignore unreadable storage; fall back to this tab's copy.
    }
    if (!clip) return this.app.say('Nothing copied yet: select items and press Cmd/Ctrl+C.');
    this.startPaste(clip, 'Paste');
  }

  /** Copy and paste in one go, without touching the clipboard. */
  duplicateSelection(): void {
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!doc || !e) return;
    const clip = copyItems(doc, e, this.app.selection, this.grid().wire);
    if (!clip) return this.app.say('Select symbols, wires or labels to duplicate.');
    this.startPaste(clip, 'Duplicate');
  }

  private startPaste(clip: Clip, label: string): void {
    const doc = this.app.doc;
    const s = this.sheet();
    if (!doc || !s) return;
    this.finishPaste();
    const at = this.cursor;
    const offset = snapToGrid({ x: at.x - clip.anchor.x, y: at.y - clip.anchor.y }, this.grid().pin);
    const res = pasteOps(doc, s.uid, clip, offset);
    const key = newUid('paste');
    if (!this.app.apply(label, res.ops, key)) return;
    this.pasting = { key, positions: res.positions, base: { ...at } };
    this.app.select(res.uids);
    this.app.say(`${label}: move the mouse to place it, click to drop, Esc to cancel.`);
  }

  private followPaste(p: Vec2): void {
    const ps = this.pasting;
    if (!ps) return;
    const d = snapToGrid({ x: p.x - ps.base.x, y: p.y - ps.base.y }, this.grid().pin);
    const ops: Op[] = ps.positions.map((r) => ({ op: 'setRule', uid: r.uid, name: r.name, decl: { name: r.name, value: { x: r.value.x + d.x, y: r.value.y + d.y } } }));
    if (ops.length) this.app.apply('Paste', ops, ps.key);
  }

  /** Drop a paste in progress where it is (one undo step). */
  finishPaste(): boolean {
    if (!this.pasting) return false;
    const key = this.pasting.key;
    this.pasting = null;
    this.fixJunctions(key);
    this.app.history?.seal();
    this.app.say('');
    return true;
  }

  /** Esc while pasting: take the paste back. */
  cancelPaste(): boolean {
    if (!this.pasting) return false;
    this.pasting = null;
    this.app.history?.seal();
    this.app.undo();
    this.app.say('Paste cancelled.');
    return true;
  }

  deleteSelection(): void {
    const ops: Op[] = [];
    for (const uid of this.app.selection) {
      const n = this.app.node(uid);
      if (n && ['symbol', 'wire', 'label', 'junction', 'noconnect', 'note', 'groupBox'].includes(n.type) && !(n.type === 'label' && this.app.node(n.parent ?? '')?.type === 'symbol')) ops.push({ op: 'remove', uid });
    }
    if (ops.length) {
      this.app.apply(`Delete ${ops.length} item${ops.length > 1 ? 's' : ''}`, this.withJunctions(ops));
      this.app.select([]);
    }
  }

  // ---------- input ----------
  /** Select what a box drawn on screen picks (left→right: inside; right→left: touching). */
  private finishBox(box: { a: Vec2; b: Vec2 }, additive: boolean): void {
    const sheet = this.sheet();
    const doc = this.app.doc;
    const e = this.app.engine;
    if (!sheet || !doc || !e) return;
    const p = this.toWorld(box.a.x, box.a.y);
    const q = this.toWorld(box.b.x, box.b.y);
    const r = { minX: Math.min(p.x, q.x), minY: Math.min(p.y, q.y), maxX: Math.max(p.x, q.x), maxY: Math.max(p.y, q.y) };
    const picked = itemsInRect(doc, e, sheet.uid, r, box.b.x >= box.a.x ? 'inside' : 'touch');
    if (additive) this.app.select(picked.filter((u) => !this.app.selection.has(u)), true);
    else this.app.select(picked);
    if (picked.length) this.app.say(`${picked.length} item${picked.length > 1 ? 's' : ''} selected. Drag to move · R rotate · X / Y mirror · Del delete.`);
  }

  private bind(): void {
    const c = this.canvas;
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]');
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || this.app.space !== 'schematic' || typing(e.target)) return;
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        if (!this.drag) c.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      this.spaceDown = false;
      if (!this.drag) c.style.cursor = '';
    });
    window.addEventListener('blur', () => (this.spaceDown = false));
    const local = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      if (e.button === 1) e.preventDefault(); // no auto-scroll on middle click
      if (this.pasting && e.button === 0) {
        this.finishPaste();
        this.swallowClick = true;
        return;
      }
      c.setPointerCapture(e.pointerId);
      const { sx, sy } = local(e);
      const p = this.toWorld(sx, sy);
      // Pan: middle button, or Space + drag. Left drag on empty sheet draws a selection box.
      let kind: 'pan' | 'move' | 'box' | 'none' = e.button === 1 || this.spaceDown ? 'pan' : 'none';
      const items: { uid: string; rules: Record<string, Vec2> }[] = [];
      const symbols: { uid: string; at: Vec2 }[] = [];
      if (kind === 'none' && this.tool === 'select' && e.button === 0) {
        const hit = this.pick(p);
        if (hit && ['symbol', 'label', 'wire', 'junction', 'noconnect', 'block', 'note', 'groupBox'].includes(hit.type) && !(hit.type === 'label' && this.app.node(hit.parent ?? '')?.type === 'symbol')) {
          if (!this.app.selection.has(hit.uid)) this.app.select([hit.uid], e.shiftKey);
          kind = 'move';
          const eng = this.app.engine!;
          for (const uid of this.app.selection) {
            const n = this.app.node(uid);
            if (!n) continue;
            if (n.type === 'symbol') {
              const at = vec(eng.get(uid, 'position')?.value);
              if (at) symbols.push({ uid, at: { ...at } });
              continue;
            }
            const keys = n.type === 'wire' ? ['start', 'end'] : ['position'];
            const rules: Record<string, Vec2> = {};
            for (const k of keys) {
              const v = vec(eng.get(uid, k)?.value);
              if (v) rules[k] = { ...v };
            }
            if (Object.keys(rules).length) items.push({ uid, rules });
          }
        } else if (!hit) kind = 'box';
      }
      // One wire on its own: drag the segment, neighbours stretch.
      const only = kind === 'move' && this.app.selection.size === 1 ? this.app.node([...this.app.selection][0]!) : undefined;
      const wireOnly = only?.type === 'wire' ? only.uid : undefined;
      if (wireOnly) items.length = 0;
      const sheetUid = this.sheet()?.uid;
      const wires = kind === 'move' && sheetUid && this.app.doc && this.app.engine ? snapshotWires(this.app.doc, this.app.engine, sheetUid) : null;
      const nets = kind === 'move' ? this.netPartition() : null;
      this.drag = { x: e.clientX, y: e.clientY, moved: false, kind, start: p, key: newUid('smv'), items, symbols, wires, nets, ...(wireOnly ? { wireOnly } : {}), ...(kind === 'box' ? { box: { a: { x: sx, y: sy }, b: { x: sx, y: sy } } } : {}) };
      if (kind === 'pan') c.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      const { sx, sy } = local(e);
      const p = this.toWorld(sx, sy);
      this.cursor = this.snap(p);
      this.onCursor?.(p);
      if (this.pasting) this.followPaste(p);
      const d = this.drag;
      if (d) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
        if (d.kind === 'box' && d.box) d.box.b = { x: sx, y: sy };
        if (d.moved && d.kind === 'pan') {
          this.view.cx -= dx / this.view.scale;
          this.view.cy -= dy / this.view.scale;
          d.x = e.clientX;
          d.y = e.clientY;
        } else if (d.moved && d.kind === 'move') {
          let delta = snapToGrid({ x: p.x - d.start.x, y: p.y - d.start.y }, this.grid().wire);
          // With symbols in the move, step so the first one's pins land on the 2.54 mm grid;
          // everything else moves by the same offset, so the selection stays rigid.
          const lead = d.symbols[0];
          if (lead && this.app.doc && this.app.engine) {
            const f = symbolFrame(this.app.engine, lead.uid);
            const to = pinGridOrigin({ x: lead.at.x + p.x - d.start.x, y: lead.at.y + p.y - d.start.y }, symbolPinLocals(this.app.doc, this.app.engine, lead.uid), f.rot, f.mirror, this.grid().pin);
            delta = { x: to.x - lead.at.x, y: to.y - lead.at.y };
          }
          if (d.wireOnly && this.app.doc && this.app.engine) {
            const last = d.last ?? { x: 0, y: 0 };
            const step = dragWireOps(this.app.doc, this.app.engine, d.wireOnly, { x: delta.x - last.x, y: delta.y - last.y });
            if (step.length) this.app.apply('Move wire', step, d.key);
            d.last = delta;
            return this.requestRender();
          }
          const ops: Op[] = [];
          for (const it of d.items) for (const [k, v] of Object.entries(it.rules)) ops.push({ op: 'setRule', uid: it.uid, name: k, decl: { name: k, value: { x: v.x + delta.x, y: v.y + delta.y } } });
          if (this.app.doc && this.app.engine) {
            // Symbols go through moveSymbolsOps so attached wires, stubs and power symbols follow;
            // so do wires of other items that end on a selected wire or label.
            const last = d.last ?? { x: 0, y: 0 };
            const points = d.items.flatMap((it) => Object.values(it.rules).map((v) => ({ from: { x: v.x + last.x, y: v.y + last.y }, to: { x: v.x + delta.x, y: v.y + delta.y } })));
            const sid = this.sheet()?.uid;
            ops.push(
              ...moveSymbolsOps(this.app.doc, this.app.engine, d.symbols.map((s0) => ({ uid: s0.uid, position: { x: s0.at.x + delta.x, y: s0.at.y + delta.y } })), {
                orthogonal: false,
                skip: new Set([...d.items.map((i) => i.uid), ...d.symbols.map((x) => x.uid)]),
                points,
                ...(sid ? { sheet: sid } : {}),
              }),
            );
          }
          d.last = delta;
          if (ops.length) this.app.apply('Move', ops, d.key);
        }
      }
      this.requestRender();
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      c.style.cursor = this.spaceDown ? 'grab' : '';
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      if (d?.kind === 'box' && d.moved && d.box) {
        this.finishBox(d.box, e.shiftKey);
        return this.requestRender();
      }
      if (d?.kind === 'pan' && (d.moved || this.spaceDown || e.button === 1)) return;
      if (d?.kind === 'move' && d.moved) {
        // Bend wires that the move left slanted back into right angles, in the same undo step.
        if (d.wires && this.app.doc && this.app.engine) {
          const fix = d.nets !== null ? straightenSafelyOps(this.app.doc, this.app.engine, d.wires, d.nets) : [];
          if (fix.length) this.app.apply('Move', fix, d.key);
        }
        this.fixJunctions(d.key);
        this.app.history?.seal();
        if (d.nets !== null && this.netPartition() !== d.nets) this.app.say('This move changed connections: a pin or wire now touches another net. Undo (Cmd/Ctrl+Z) if that was not intended.');
      }
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
      const field = this.fieldAt(this.toWorld(sx, sy));
      if (field) return this.editField(field.sym, field.field);
      const hit = this.pick(this.toWorld(sx, sy));
      if (hit?.type === 'note' || hit?.type === 'groupBox') return this.editNoteOrGroup(hit);
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
        // Two-finger trackpad scroll pans; a mouse wheel or a pinch (ctrlKey) zooms.
        if (!e.ctrlKey && isTrackpadScroll(e)) {
          this.view.cx += e.deltaX / this.view.scale;
          this.view.cy += e.deltaY / this.view.scale;
          return this.requestRender();
        }
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
        // Ending on the middle of another wire joins it (a junction dot is added).
        if (a && b && dist(a, p) > 1e-3 && dist(b, p) > 1e-3 && distToSegment(p, a, b) < 1e-3) return true;
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
    const layout = this.textLayout();
    const lw = (mm: number) => Math.max(1, mm * s);

    // Grid dots
    const gw = this.grid().wire;
    if (s * gw * 2 >= 8) {
      const step = gw * (s * gw >= 8 ? 1 : 2);
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

    // Frame and title block (S9)
    const frame = sheetFrame(doc, sheet);
    if (frame) {
      const R = (r: { minX: number; minY: number; maxX: number; maxY: number }, w: number, color: string) => {
        const a = S({ x: r.minX, y: r.minY });
        const b = S({ x: r.maxX, y: r.maxY });
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      };
      R(frame.paper, 1, '#3a3f4b');
      R(frame.inner, Math.max(1, 0.35 * s), '#7a8194');
      const tb = frame.titleBlock;
      R(tb, Math.max(1, 0.3 * s), '#7a8194');
      // Rows: title / project / rev, date, sheet / author.
      const rowY = [tb.minY + 12, tb.minY + 19, tb.minY + 25.5];
      ctx.beginPath();
      for (const y of rowY) {
        const a = S({ x: tb.minX, y });
        const b = S({ x: tb.maxX, y });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (const x of [tb.minX + 30, tb.minX + 75]) {
        const a = S({ x, y: rowY[1]! });
        const b = S({ x, y: rowY[2]! });
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      const f = frame.fields;
      const lab = (t: string, x: number, y: number) => text(t, { x, y }, 1.1, '#6c7383', 'left', 'top');
      lab('Title', tb.minX + 1.5, tb.minY + 1);
      text(f.title, { x: tb.minX + 1.5, y: tb.minY + 4.5 }, 3.2, C.ref, 'left', 'top');
      lab('Project', tb.minX + 1.5, rowY[0]! + 0.8);
      text(f.project || '—', { x: tb.minX + 14, y: rowY[0]! + 0.6 }, 1.8, C.value, 'left', 'top');
      lab('Rev', tb.minX + 1.5, rowY[1]! + 0.8);
      text(f.revision, { x: tb.minX + 9, y: rowY[1]! + 0.8 }, 1.8, C.value, 'left', 'top');
      lab('Date', tb.minX + 31.5, rowY[1]! + 0.8);
      text(f.date || '—', { x: tb.minX + 40, y: rowY[1]! + 0.8 }, 1.8, C.value, 'left', 'top');
      lab('Sheet', tb.minX + 76.5, rowY[1]! + 0.8);
      text(f.sheet, { x: tb.minX + 87, y: rowY[1]! + 0.8 }, 1.8, C.value, 'left', 'top');
      lab('Author', tb.minX + 1.5, rowY[2]! + 0.8);
      text(f.author || '—', { x: tb.minX + 14, y: rowY[2]! + 0.6 }, 1.8, C.value, 'left', 'top');
      text(`${f.title} · ${frame.size}`, { x: frame.paper.minX + 1, y: frame.paper.minY - 1 }, 1.4, '#6c7383', 'left', 'bottom');
    }

    // Group boxes and notes (S9)
    for (const n of items) {
      if (n.type === 'groupBox') {
        const r = groupBoxRect(e, n);
        if (!r) continue;
        const a = S({ x: r.minX, y: r.minY });
        const b = S({ x: r.maxX, y: r.maxY });
        ctx.save();
        ctx.strokeStyle = isSel(n) ? C.sel : '#8a7fc4';
        ctx.lineWidth = isSel(n) ? 2 : 1.2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.restore();
        text(n.name, { x: r.minX + 1, y: r.minY + 0.6 }, 1.4, isSel(n) ? C.sel : '#a99de6', 'left', 'top');
      } else if (n.type === 'note') {
        const at = vec(e.get(n.uid, 'position')?.value);
        if (!at) continue;
        const size = Number(n.props.size ?? 1.5) || 1.5;
        n.name.split('\n').forEach((line, i) => text(line, { x: at.x, y: at.y + i * size * 1.4 }, size, isSel(n) ? C.sel : '#c9cdd6', 'left', 'top'));
      }
    }

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
      // References, values and power names: placed by the text layout so they do not overlap.
      for (const t of layout.get(n.uid) ?? []) {
        const color = t.field === 'power' ? C.power : t.field === 'ref' ? (selected ? C.sel : C.ref) : C.value;
        text(t.text, t.at, t.size, color, t.align, t.base);
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
        } else {
          // A local label's text goes above or below its wire, whichever is free.
          const t = layout.get(n.uid)?.[0];
          if (t) text(t.text, t.at, t.size, color, t.align, t.base);
          else text(n.name, { x: p.x + (right ? -0.4 : 0.4), y: p.y - 0.4 }, 1.2, color, right ? 'right' : 'left', 'bottom');
        }
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

    // Selection box
    if (this.drag?.kind === 'box' && this.drag.moved && this.drag.box) {
      const { a, b } = this.drag.box;
      const touch = b.x < a.x;
      ctx.save();
      ctx.fillStyle = touch ? 'rgba(120,200,140,0.10)' : 'rgba(110,160,255,0.10)';
      ctx.strokeStyle = touch ? 'rgba(120,200,140,0.9)' : 'rgba(110,160,255,0.9)';
      ctx.lineWidth = 1;
      if (touch) ctx.setLineDash([5, 4]);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.restore();
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
      if (this.wireStart && dist(this.wireStart, this.cursor) > 1e-6) {
        const { path, clean } = this.wirePath(this.wireStart, this.cursor);
        ctx.strokeStyle = clean ? C.wire : '#e5484d';
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = lw(0.15);
        if (!clean) ctx.setLineDash([6, 4]);
        ctx.beginPath();
        path.forEach((pt, i) => {
          const sp = S(pt);
          if (i === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
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
