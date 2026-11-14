/**
 * Interactive routing (P4, docs/05-pcb-improvements.md): click a pad/via/trace to start on its net, move to
 * see the preview, click to lay segments, V for a via (switches layer), / flips the corner style, Esc stops.
 * Each click is one undoable step.
 *
 * Modes (M cycles): walkaround (default) — the preview walks around other nets' copper and their clearance,
 * or stops at the last legal point (the rest shown in red); shove — other nets' traces in the way are
 * pushed aside (P9) when the segment is placed; free — the plain 45° path, DRC reports what it breaks. In
 * every mode a route that would end on another net's copper is refused.
 *
 * Width and via size: W / Shift+W and Shift+V step through presets (the net's own rule first); traces and
 * vias laid with another size than the net's carry it as their own rule.
 *
 * A net in a differential pair with a `diffGap` (P10) is routed with its partner: both traces run at the
 * pair gap from the two start pads, and their lengths and skew are shown while routing.
 *
 * Dragging a single straight trace in select mode moves that segment sideways (its neighbours stretch and
 * keep their angles); it stops at other copper, or shoves it in shove mode.
 */
import {
  dist,
  netPads,
  netRouteRules,
  newUid,
  offsetPath,
  pairPartner,
  pathLength,
  planDragSegment,
  planShove,
  route45,
  routedLength,
  routeWorld,
  segmentHit,
  snapToGrid,
  viaFree,
  walkaround,
  type DragPlan,
  type Op,
  type RouteWorld,
  type Vec2,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { layerColor, type RGBA } from '../render/colors.ts';
import { polyline } from '../render/geometry.ts';

interface Target {
  p: Vec2;
  /** The same-net pad/via under the cursor, if any (completes the connection). */
  uid: string | null;
}

export type RouteMode = 'walkaround' | 'shove' | 'free';
/** Time the walkaround search may take under the mouse (ms). */
const HOVER_MS = 40;
const MODES: RouteMode[] = ['walkaround', 'shove', 'free'];
export const WIDTH_PRESETS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2];
export const VIA_PRESETS = [
  { d: 0.45, h: 0.2 },
  { d: 0.6, h: 0.3 },
  { d: 0.8, h: 0.4 },
  { d: 1, h: 0.5 },
];

interface PairState {
  partner: string;
  partnerUid: string;
  gap: number;
  name: string;
  /** Where the partner's trace continues from. */
  last: Vec2;
}

export class RouteTool {
  net: string | null = null;
  mode: RouteMode = 'walkaround';
  private netUid: string | null = null;
  private last: Vec2 | null = null;
  private startUid: string | null = null;
  private diagonalFirst = true;
  private target: Target | null = null;
  private preview: Vec2[] = [];
  /** The partner's preview, in pair routing. */
  private partnerPreview: Vec2[] = [];
  /** Where the preview stopped short of the cursor (walkaround), or the copper it crosses (free mode). */
  private blocked: Vec2 | null = null;
  private pair: PairState | null = null;
  /** The pair's breakouts cannot be made legal here (nothing is laid). */
  private pairBlocked = false;
  private width0: number | null = null;
  private via0: { d: number; h: number } | null = null;
  private worldCache: { key: string; w: RouteWorld }[] = [];
  private shoveTimer = 0;
  private drag: { uid: string; from: Vec2; nrm: Vec2; plan: DragPlan | null } | null = null;

  private app: App;
  constructor(app: App) {
    this.app = app;
  }

  get active(): boolean {
    return this.net !== null;
  }

  private rules() {
    return netRouteRules(this.app.doc!, this.app.engine!, this.net!);
  }

  width(): number {
    if (this.width0 !== null) return this.width0;
    return this.net && this.app.doc ? this.rules().width : 0.25;
  }

  private viaSize(): { d: number; h: number } {
    if (this.via0) return this.via0;
    if (!this.net || !this.app.doc) return { d: 0.6, h: 0.3 };
    const r = this.rules();
    return { d: r.viaDiameter, h: r.viaHole };
  }

  /** The obstacles for the current net, width, mode and board (cached until the board changes). */
  private world(net = this.net!, width = this.width(), own: string[] = [], shove = this.mode === 'shove'): RouteWorld {
    const app = this.app;
    const key = `${app.docVersion}|${net}|${width}|${shove}|${own.join(',')}`;
    const hit = this.worldCache.find((c) => c.key === key);
    if (hit) return hit.w;
    const w = routeWorld(app.doc!, app.engine!, app.copper, net, { width, shove, own });
    this.worldCache = [{ key, w }, ...this.worldCache.filter((c) => c.key.startsWith(`${app.docVersion}|`))].slice(0, 4);
    return w;
  }

  previewColor(): RGBA {
    const c = layerColor(this.app.activeLayer);
    return [c[0], c[1], c[2], 0.75];
  }

  status(): string {
    if (!this.net) return `Route · ${this.mode}`;
    const { d, h } = this.viaSize();
    return `${this.net}${this.pair ? ` + ${this.pair.partner}` : ''} · ${this.app.activeLayer} · ${this.mode} · width ${this.width().toFixed(2)} mm · via ${d.toFixed(2)}/${h.toFixed(2)}`;
  }

  cancel(): void {
    const was = this.active;
    this.net = this.netUid = this.last = this.startUid = null;
    this.target = null;
    this.preview = [];
    this.partnerPreview = [];
    this.blocked = null;
    this.pair = null;
    this.width0 = null;
    this.via0 = null;
    clearTimeout(this.shoveTimer);
    this.app.renderer.setLayer('__preview', new Float32Array());
    this.app.renderer.setLayer('__shove', new Float32Array());
    this.app.highlightNet(null);
    if (was) this.app.say('Route finished.');
    this.app.requestRender();
  }

  layerChanged(): void {
    this.rebuildPreview();
  }

  togglePosture(): void {
    this.diagonalFirst = !this.diagonalFirst;
    this.rebuildPreview();
  }

  cycleMode(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]!;
    this.app.say(`Routing mode: ${this.mode}${this.mode === 'walkaround' ? ' (around other copper)' : this.mode === 'shove' ? ' (pushes other traces aside)' : ' (no checks; DRC reports)'}`);
    this.app.emit('mode');
    this.rebuildPreview();
  }

  /** Step the trace width through the presets (the net's own width is where it starts). */
  stepWidth(dir: 1 | -1): void {
    if (!this.active) return this.app.say('Start routing first, then W / Shift+W changes the width.');
    const cur = this.width();
    const list = [...new Set([...WIDTH_PRESETS, this.rules().width])].sort((a, b) => a - b);
    const i = list.findIndex((x) => Math.abs(x - cur) < 1e-9);
    const next = list[Math.max(0, Math.min(list.length - 1, i + dir))]!;
    this.width0 = Math.abs(next - this.rules().width) < 1e-9 ? null : next;
    this.app.say(`Width ${next.toFixed(2)} mm${this.width0 === null ? ' (the net\'s rule)' : ''}`);
    this.app.emit('mode');
    this.rebuildPreview();
  }

  stepVia(): void {
    if (!this.active) return this.app.say('Start routing first, then Shift+V changes the via size.');
    const r = this.rules();
    const list = [{ d: r.viaDiameter, h: r.viaHole }, ...VIA_PRESETS.filter((v) => v.d !== r.viaDiameter)];
    const cur = this.viaSize();
    const i = list.findIndex((v) => v.d === cur.d && v.h === cur.h);
    const next = list[(i + 1) % list.length]!;
    this.via0 = i + 1 >= list.length || (next.d === r.viaDiameter && next.h === r.viaHole) ? null : next;
    this.app.say(`Via ${next.d.toFixed(2)}/${next.h.toFixed(2)} mm${this.via0 === null ? ' (the net\'s rule)' : ''}`);
    this.app.emit('mode');
  }

  /** Start routing from whatever copper is under `world`. */
  begin(world: Vec2): boolean {
    const app = this.app;
    const hit = app.pickRaw(world, (uid) => !!app.netOf(uid));
    if (!hit) {
      app.say('Start on a pad, via or trace that belongs to a net.');
      return false;
    }
    const net = app.netOf(hit.uid)!;
    const nn = app.netNode(net);
    if (!nn) {
      app.say(`Net ${net} has no net object to put traces in.`);
      return false;
    }
    const node = app.node(hit.uid)!;
    let start = hit.anchor ?? world;
    if (node.type === 'trace') {
      const s = app.engine!.get(node.uid, 'start')?.value as Vec2;
      const e = app.engine!.get(node.uid, 'end')?.value as Vec2;
      const tol = 6 / app.view.scale;
      if (dist(world, s) < tol) start = s;
      else if (dist(world, e) < tol) start = e;
      else start = projectOnSegment(world, s, e);
      const layer = app.engine!.get(node.uid, 'layer')?.value;
      if (typeof layer === 'string' && app.copper.includes(layer)) app.activeLayer = layer;
    } else if (node.type === 'pad') {
      const layers = (app.engine!.get(node.uid, 'layers')?.value as string[]) ?? [];
      const all = layers.includes('*') ? app.copper : layers;
      if (!all.includes(app.activeLayer)) {
        const cu = all.find((l) => app.copper.includes(l));
        if (cu) app.activeLayer = cu;
      }
    }
    this.net = net;
    this.netUid = nn.uid;
    this.last = start;
    this.startUid = hit.uid;
    // A pair: start the partner from its pad nearest to this start.
    this.pair = null;
    const pp = pairPartner(app.doc!, app.engine!, net);
    if (pp && node.type === 'pad') {
      const pads = netPads(app.doc!, app.engine!, app.copper, pp.partner).sort((a, b) => dist(a.at, start) - dist(b.at, start));
      const p0 = pads[0];
      if (p0 && dist(p0.at, start) < 3) this.pair = { partner: pp.partner, partnerUid: p0.uid, gap: pp.gap, name: pp.name, last: p0.at };
    }
    this.app.highlightNet(net);
    app.emit('mode');
    app.say(`Routing ${this.status()} · click to place, V via, / corner, M mode, W width, Esc stop`);
    this.hover(world, false);
    return true;
  }

  hover(world: Vec2, freeAngle: boolean): void {
    if (!this.active || !this.last) return;
    this.target = this.findTarget(world);
    this.rebuildPreview(freeAngle);
  }

  private findTarget(world: Vec2): Target {
    const app = this.app;
    const net = this.net;
    // Snap to a same-net pad/via centre, or a same-net trace end.
    const hit = app.pickRaw(world, (uid) => app.netOf(uid) === net && uid !== this.startUid);
    if (hit) {
      const n = app.node(hit.uid)!;
      if (hit.anchor) return { p: hit.anchor, uid: hit.uid };
      if (n.type === 'trace') {
        const s = app.engine!.get(n.uid, 'start')?.value as Vec2;
        const e = app.engine!.get(n.uid, 'end')?.value as Vec2;
        const p = dist(world, s) < dist(world, e) ? s : e;
        if (dist(world, p) < 8 / app.view.scale) return { p, uid: hit.uid };
        return { p: projectOnSegment(world, s, e), uid: hit.uid };
      }
    }
    return { p: snapToGrid(world, app.gridStep() / 2), uid: null };
  }

  /** The partner's end for a target of the main net: its pad nearest to the target pad. */
  private partnerTarget(): Vec2 | null {
    const pr = this.pair;
    const t = this.target;
    if (!pr || !t?.uid || this.app.node(t.uid)?.type !== 'pad') return null;
    const pads = netPads(this.app.doc!, this.app.engine!, this.app.copper, pr.partner).sort((a, b) => dist(a.at, t.p) - dist(b.at, t.p));
    return pads[0] && dist(pads[0].at, t.p) < 3 ? pads[0].at : null;
  }

  private rebuildPreview(freeAngle = false): void {
    this.blocked = null;
    this.partnerPreview = [];
    const app = this.app;
    const layer = app.activeLayer;
    if (!this.last || !this.target || !app.doc) {
      this.preview = [];
    } else if (this.pair) {
      this.pairPreview(layer);
    } else if (freeAngle || this.mode === 'free') {
      this.preview = freeAngle ? [this.last, this.target.p] : route45(this.last, this.target.p, this.diagonalFirst);
      const w = this.world();
      for (let i = 0; i + 1 < this.preview.length && !this.blocked; i++) {
        const hit = segmentHit(w, layer, this.preview[i]!, this.preview[i + 1]!);
        if (hit) this.blocked = this.preview[i + 1]!;
      }
    } else {
      const r = walkaround(this.world(), layer, this.last, this.target.p, { diagonalFirst: this.diagonalFirst, budgetMs: HOVER_MS });
      this.preview = r.path;
      if (!r.reached) this.blocked = this.target.p;
    }
    const tris: number[] = [];
    if (this.preview.length > 1) polyline(tris, this.preview, this.width(), false);
    if (this.partnerPreview.length > 1) polyline(tris, this.partnerPreview, this.width(), false);
    app.renderer.setLayer('__preview', new Float32Array(tris));
    if (this.mode === 'shove') this.scheduleShovePreview();
    app.requestRender();
  }

  /** Both traces of a pair: a centre line walked around with the pair's full width, then offset each side. */
  private pairPreview(layer: string): void {
    const pr = this.pair!;
    const w = this.width();
    const half = (w + pr.gap) / 2;
    const cs = mid(this.last!, pr.last);
    const pt = this.partnerTarget();
    const ct = pt ? mid(this.target!.p, pt) : this.target!.p;
    const world = this.world(this.net!, 2 * w + pr.gap, [pr.partner]);
    const r = this.mode === 'free' ? { path: route45(cs, ct, this.diagonalFirst), reached: true } : walkaround(world, layer, cs, ct, { diagonalFirst: this.diagonalFirst, budgetMs: HOVER_MS });
    if (!r.reached) this.blocked = this.target!.p;
    const centre = r.path.length > 1 ? r.path : [cs, cs];
    // The side of the centre line the main net's start lies on.
    const a = offsetPath(centre, half);
    const b = offsetPath(centre, -half);
    const mainSide = dist(a[0]!, this.last!) <= dist(b[0]!, this.last!) ? a : b;
    const otherSide = mainSide === a ? b : a;
    // Each trace joins its pad at the first point of its side of the pair it can reach legally (for its own
    // net, the partner's pads in the way), and leaves the pair the same way at the far end.
    const join = (net: string, from: Vec2, pts: Vec2[], end: Vec2 | null): Vec2[] | null => {
      const wn = this.world(net, w, []);
      const head = reachAlong(wn, layer, from, pts, this.diagonalFirst);
      if (!head) return null;
      let out = head;
      if (end && r.reached) {
        const tail = reachAlong(wn, layer, end, [...out].reverse(), !this.diagonalFirst);
        if (!tail) return null;
        out = tail.reverse();
      }
      return out;
    };
    const m = join(this.net!, this.last!, mainSide, pt ? this.target!.p : null);
    const n = join(pr.partner, pr.last, otherSide, pt);
    if (!m || !n) {
      // No legal breakout: show the plain offset paths, marked as blocked.
      this.blocked = this.target!.p;
      this.preview = [this.last!, ...mainSide];
      this.partnerPreview = [pr.last, ...otherSide];
      this.pairBlocked = true;
    } else {
      this.preview = m;
      this.partnerPreview = n;
      this.pairBlocked = false;
    }
    // Lengths so far plus the preview, and the skew.
    const lp = routedLength(this.app.doc!, this.app.engine!, this.net!) + pathLength(this.preview);
    const ln = routedLength(this.app.doc!, this.app.engine!, pr.partner) + pathLength(this.partnerPreview);
    this.app.say(`Pair ${pr.name}: ${this.net} ${lp.toFixed(2)} mm · ${pr.partner} ${ln.toFixed(2)} mm · skew ${Math.abs(lp - ln).toFixed(3)} mm`);
  }

  /** In shove mode, show where the other traces would go (after the mouse rests a moment). */
  private scheduleShovePreview(): void {
    clearTimeout(this.shoveTimer);
    this.app.renderer.setLayer('__shove', new Float32Array());
    if (!this.net || this.preview.length < 2) return;
    const traces = this.newTraces();
    this.shoveTimer = window.setTimeout(() => {
      const app = this.app;
      if (!app.doc || !this.net) return;
      const r = planShove(app.doc, app.engine!, app.copper, { net: this.net, traces });
      const tris: number[] = [];
      for (const op of r.ops) {
        if (op.op !== 'add') continue;
        const n = op.tree.nodes[0]!;
        if (n.type !== 'trace') continue;
        const get = (k: string) => n.rules.find((x) => x.name === k)?.value as Vec2 | undefined;
        const a = get('start');
        const b = get('end');
        if (a && b) polyline(tris, [a, b], Number(n.rules.find((x) => x.name === 'traceWidth')?.value ?? 0.25), false);
      }
      app.renderer.setLayer('__shove', new Float32Array(tris));
      // When the traces cannot be pushed, show the walkaround the click will lay instead.
      if (r.error && !this.pair && this.last && this.target) {
        const wa = walkaround(this.world(this.net, this.width(), [], false), app.activeLayer, this.last, this.target.p, { diagonalFirst: this.diagonalFirst, budgetMs: HOVER_MS });
        this.preview = wa.path;
        this.blocked = wa.reached ? null : this.target.p;
        const pt: number[] = [];
        if (wa.path.length > 1) polyline(pt, wa.path, this.width(), false);
        app.renderer.setLayer('__preview', new Float32Array(pt));
        app.say(`Cannot shove here (${r.error}); walking around instead.`);
      }
      app.requestRender();
    }, 180);
  }

  private newTraces(): { layer: string; a: Vec2; b: Vec2; width: number }[] {
    const out: { layer: string; a: Vec2; b: Vec2; width: number }[] = [];
    for (const path of [this.preview, this.partnerPreview])
      for (let i = 0; i + 1 < path.length; i++) if (dist(path[i]!, path[i + 1]!) > 1e-6) out.push({ layer: this.app.activeLayer, a: path[i]!, b: path[i + 1]!, width: this.width() });
    return out;
  }

  private traceOps(netUid: string, path: Vec2[], start: number): Op[] {
    const ops: Op[] = [];
    let index = start;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      if (dist(a, b) < 1e-6) continue;
      ops.push({
        op: 'add',
        parent: netUid,
        index: index++,
        tree: {
          nodes: [
            {
              uid: newUid('tr'),
              type: 'trace',
              name: '',
              props: {},
              rules: [{ name: 'start', value: a }, { name: 'end', value: b }, { name: 'layer', value: this.app.activeLayer }, ...(this.width0 !== null ? [{ name: 'traceWidth', value: this.width0 }] : [])],
              parent: netUid,
              children: [],
            },
          ],
        },
      });
    }
    return ops;
  }

  /** Another net's copper at the end point (a route may not end there). */
  private wrongNetAt(p: Vec2): string | null {
    const app = this.app;
    const own = new Set([this.net, this.pair?.partner].filter(Boolean));
    const hit = app.pickRaw(p, (uid) => {
      const n = app.netOf(uid);
      return !!n && !own.has(n);
    });
    return hit ? app.netOf(hit.uid) : null;
  }

  /** Lay the previewed segments. Returns true when the connection was completed. */
  click(world: Vec2, freeAngle: boolean): boolean {
    if (!this.active) return this.begin(world), false;
    this.hover(world, freeAngle);
    const app = this.app;
    const segs = this.preview;
    if (segs.length < 2 || !this.netUid || !this.target) {
      if (this.blocked) app.say('Other copper is in the way: move to where the preview can reach, or change mode (M).');
      return false;
    }
    if (this.pair && this.pairBlocked) {
      app.say('The pair cannot leave its pads here without breaking clearance: move further out first.');
      return false;
    }
    const end = segs[segs.length - 1]!;
    const wrong = this.wrongNetAt(end);
    if (wrong) {
      app.say(`Refused: the route would end on ${wrong}.`);
      return false;
    }
    const netNode = app.node(this.netUid)!;
    const ops = this.traceOps(this.netUid, segs, netNode.children.length);
    if (this.pair) {
      const pn = app.netNode(this.pair.partner);
      if (pn && this.partnerPreview.length > 1) ops.push(...this.traceOps(pn.uid, this.partnerPreview, pn.children.length));
    }
    if (!ops.length) return false;
    let laid = segs;
    if (this.mode === 'shove') {
      const r = planShove(app.doc!, app.engine!, app.copper, { net: this.net!, traces: this.newTraces() });
      if (!r.error) ops.push(...r.ops);
      else if (this.pair) {
        app.say(`Cannot shove: ${r.error}.`);
        return false;
      } else {
        // Walk around instead (the other traces stay where they are).
        const wa = walkaround(this.world(this.net!, this.width(), [], false), app.activeLayer, this.last!, this.target.p, { diagonalFirst: this.diagonalFirst, budgetMs: HOVER_MS });
        if (wa.path.length < 2) {
          app.say(`Cannot shove (${r.error}) and no way around.`);
          return false;
        }
        laid = wa.path;
        this.blocked = wa.reached ? null : this.target.p;
        ops.splice(0, ops.length, ...this.traceOps(this.netUid, laid, netNode.children.length));
        app.say(`Could not shove (${r.error}); walked around instead.`);
      }
    }
    if (!app.apply(this.pair ? 'Route pair' : 'Route', ops)) return false;
    const reached = !this.blocked;
    const endAt = laid[laid.length - 1]!;
    this.last = endAt;
    if (this.pair && this.partnerPreview.length) this.pair.last = this.partnerPreview[this.partnerPreview.length - 1]!;
    const done = reached && !!this.target.uid && app.node(this.target.uid)?.type !== 'trace' && dist(endAt, this.target.p) < 1e-6;
    if (done) {
      const net = this.net;
      this.cancel();
      app.say(`Connected ${net}. Refill pours (B) when the routing is done.`);
      return true;
    }
    this.startUid = null;
    this.rebuildPreview();
    return false;
  }

  /** Drop a via at the current end and continue on the other outer layer. */
  placeVia(): void {
    const app = this.app;
    if (!this.active || !this.last || !this.netUid) return app.say('Start routing first, then press V to drop a via.');
    if (app.copper.length < 2) return app.say('This board has only one copper layer.');
    const { d, h } = this.viaSize();
    const top = app.copper[0]!;
    const bottom = app.copper[app.copper.length - 1]!;
    const at = [{ net: this.net!, uid: this.netUid, p: this.last }];
    if (this.pair) {
      const pn = app.netNode(this.pair.partner);
      if (pn) at.push({ net: this.pair.partner, uid: pn.uid, p: this.pair.last });
    }
    const ops: Op[] = [];
    for (const v of at) {
      if (this.mode === 'walkaround' && !viaFree(this.world(v.net, this.width(), this.pair ? [this.net!, this.pair.partner].filter((n) => n !== v.net) : []), v.p, d)) {
        return app.say(`No room for a ${d.toFixed(2)} mm via here: other copper is too close (or press M for shove mode).`);
      }
      ops.push({
        op: 'add',
        parent: v.uid,
        index: app.node(v.uid)!.children.length,
        tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', props: {}, rules: [{ name: 'position', value: v.p }, { name: 'layers', value: [top, bottom] }, ...(this.via0 ? [{ name: 'viaDiameter', value: d }, { name: 'viaHole', value: h }] : [])], parent: v.uid, children: [] }] },
      });
    }
    if (this.mode === 'shove') {
      const r = planShove(app.doc!, app.engine!, app.copper, { net: this.net!, vias: [{ at: this.last, diameter: d }] });
      if (r.error) return app.say(`Cannot shove for the via: ${r.error}.`);
      ops.push(...r.ops);
    }
    if (!app.apply('Add via', ops)) return;
    app.activeLayer = app.activeLayer === top ? bottom : top;
    app.emit('mode');
    app.say(`Via ${d.toFixed(2)}/${h.toFixed(2)} mm placed · now on ${app.activeLayer}`);
    this.rebuildPreview();
  }

  // ---------- dragging a segment sideways (select mode) ----------

  /** Start dragging a straight trace segment; false when it cannot be dragged that way. */
  beginDrag(uid: string, at: Vec2): boolean {
    const app = this.app;
    const n = app.node(uid);
    if (n?.type !== 'trace' || app.engine!.get(uid, 'mid')?.value) return false;
    const a = app.engine!.get(uid, 'start')?.value as Vec2;
    const b = app.engine!.get(uid, 'end')?.value as Vec2;
    const L = dist(a, b);
    if (L < 1e-6) return false;
    this.drag = { uid, from: at, nrm: { x: (b.y - a.y) / L, y: -(b.x - a.x) / L }, plan: null };
    return true;
  }

  get dragging(): boolean {
    return !!this.drag;
  }

  dragTo(at: Vec2): void {
    const app = this.app;
    const d = this.drag;
    if (!d || !app.doc) return;
    let off = (at.x - d.from.x) * d.nrm.x + (at.y - d.from.y) * d.nrm.y;
    off = Math.round(off / (app.gridStep() / 4)) * (app.gridStep() / 4);
    const net = app.netOf(d.uid)!;
    const w = this.mode === 'walkaround' ? routeWorld(app.doc, app.engine!, app.copper, net, { width: Number(app.engine!.get(d.uid, 'traceWidth')?.value ?? 0.25) }) : undefined;
    d.plan = Math.abs(off) < 1e-6 ? null : planDragSegment(app.doc, app.engine!, app.copper, d.uid, off, w ? { world: w } : {});
    const tris: number[] = [];
    if (d.plan && !d.plan.error) for (const p of d.plan.pieces) polyline(tris, [p.a, p.b], p.w, false);
    const layer = String(app.engine!.get(d.uid, 'layer')?.value ?? app.activeLayer);
    const c = layerColor(layer);
    this.dragColor = [c[0], c[1], c[2], 0.85];
    app.renderer.setLayer('__preview', new Float32Array(tris));
    app.say(d.plan?.error ? `Cannot drag: ${d.plan.error}` : d.plan ? `Drag ${d.plan.offset.toFixed(3)} mm${Math.abs(d.plan.offset - off) > 1e-4 ? ' (stopped at other copper)' : ''}` : '');
    app.requestRender();
  }

  dragColor: RGBA | null = null;

  endDrag(): void {
    const app = this.app;
    const d = this.drag;
    this.drag = null;
    this.dragColor = null;
    app.renderer.setLayer('__preview', new Float32Array());
    app.requestRender();
    if (!d?.plan || d.plan.error || !d.plan.ops.length) return;
    const ops = [...d.plan.ops];
    if (this.mode === 'shove') {
      const net = app.netOf(d.uid)!;
      const r = planShove(app.doc!, app.engine!, app.copper, { net, traces: d.plan.pieces.map((p) => ({ layer: p.layer, a: p.a, b: p.b, width: p.w })) });
      if (r.error) return app.say(`Cannot shove: ${r.error}.`);
      ops.push(...r.ops);
    }
    app.apply('Drag trace', ops);
  }

  drawOverlay(ctx: CanvasRenderingContext2D, S: (p: Vec2) => Vec2): void {
    if (this.app.mode !== 'route') return;
    const p = this.target?.p ?? this.app.cursor;
    const s = S(p);
    // The part the preview could not reach, in red.
    if (this.blocked && this.preview.length) {
      const e = S(this.preview[this.preview.length - 1]!);
      const b = S(this.blocked);
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(e.x - 6, e.y - 6);
      ctx.lineTo(e.x + 6, e.y + 6);
      ctx.moveTo(e.x + 6, e.y - 6);
      ctx.lineTo(e.x - 6, e.y + 6);
      ctx.stroke();
    }
    ctx.strokeStyle = this.target?.uid ? 'rgba(120, 255, 170, 0.95)' : 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - 9, s.y);
    ctx.lineTo(s.x + 9, s.y);
    ctx.moveTo(s.x, s.y - 9);
    ctx.lineTo(s.x, s.y + 9);
    ctx.stroke();
    if (this.target?.uid) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // A small readout next to the cursor.
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(230, 235, 245, 0.85)';
    ctx.fillText(this.active ? `${this.mode} · ${this.width().toFixed(2)} mm` : this.mode, s.x + 12, s.y + 10);
  }
}

const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * A legal way from `from` onto the polyline `pts`: the first point along it (every 0.05 mm) that a 45°
 * path from `from` reaches without breaking clearance, then the rest of the polyline. Null when none does
 * or the rest is not legal.
 */
function reachAlong(w: RouteWorld, layer: string, from: Vec2, pts: Vec2[], diagonalFirst: boolean): Vec2[] | null {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const L = dist(a, b);
    const steps = Math.max(1, Math.ceil(L / 0.05));
    for (let k = 0; k <= steps; k++) {
      const q = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
      for (const d of [diagonalFirst, !diagonalFirst]) {
        const head = route45(from, q, d);
        const rest = [q, ...pts.slice(i + 1)];
        if (pathOk(w, layer, head) && pathOk(w, layer, rest)) return [...head, ...rest.slice(1)];
      }
    }
  }
  return null;
}

function pathOk(w: RouteWorld, layer: string, pts: Vec2[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (dist(pts[i]!, pts[i + 1]!) > 1e-9 && segmentHit(w, layer, pts[i]!, pts[i + 1]!)) return false;
  return true;
}

function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

