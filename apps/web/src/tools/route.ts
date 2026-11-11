/**
 * Interactive routing: click a pad/via/trace to start on its net, move to see a 45°
 * preview, click to lay segments, V for a via (switches layer), / flips the corner style,
 * Esc stops. Each click is one undoable step. New traces carry no width of their own,
 * so they take it from the net's rules.
 */
import { dist, newUid, route45, snapToGrid, type Op, type Vec2 } from '@hassassin/core';
import type { App } from '../app.ts';
import { layerColor, type RGBA } from '../render/colors.ts';
import { polyline } from '../render/geometry.ts';

interface Target {
  p: Vec2;
  /** The same-net pad/via under the cursor, if any (completes the connection). */
  uid: string | null;
}

export class RouteTool {
  net: string | null = null;
  private netUid: string | null = null;
  private last: Vec2 | null = null;
  private startUid: string | null = null;
  private diagonalFirst = true;
  private target: Target | null = null;
  private preview: Vec2[] = [];

  private app: App;
  constructor(app: App) {
    this.app = app;
  }

  get active(): boolean {
    return this.net !== null;
  }

  private width(): number {
    const v = this.netUid ? this.app.engine?.get(this.netUid, 'traceWidth')?.value : undefined;
    return typeof v === 'number' ? v : 0.25;
  }

  private viaSize(): { d: number; h: number } {
    const e = this.app.engine;
    const d = this.netUid ? e?.get(this.netUid, 'viaDiameter')?.value : undefined;
    const h = this.netUid ? e?.get(this.netUid, 'viaHole')?.value : undefined;
    return { d: typeof d === 'number' ? d : 0.6, h: typeof h === 'number' ? h : 0.3 };
  }

  previewColor(): RGBA {
    const c = layerColor(this.app.activeLayer);
    return [c[0], c[1], c[2], 0.75];
  }

  cancel(): void {
    const was = this.active;
    this.net = this.netUid = this.last = this.startUid = null;
    this.target = null;
    this.preview = [];
    this.app.renderer.setLayer('__preview', new Float32Array());
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
    this.app.highlightNet(net);
    app.emit('mode');
    app.say(`Routing ${net} on ${app.activeLayer} · width ${this.width().toFixed(3)} mm · click to place, V via, / corner, Esc stop`);
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

  private rebuildPreview(freeAngle = false): void {
    if (!this.last || !this.target) {
      this.preview = [];
    } else {
      this.preview = freeAngle ? [this.last, this.target.p] : route45(this.last, this.target.p, this.diagonalFirst);
    }
    const tris: number[] = [];
    if (this.preview.length) polyline(tris, this.preview, this.width(), false);
    this.app.renderer.setLayer('__preview', new Float32Array(tris));
    this.app.requestRender();
  }

  /** Lay the previewed segments. Returns true when the connection was completed. */
  click(world: Vec2, freeAngle: boolean): boolean {
    if (!this.active) return this.begin(world), false;
    this.hover(world, freeAngle);
    const segs = this.preview;
    if (segs.length < 2 || !this.netUid || !this.target) return false;
    const ops: Op[] = [];
    let index = this.app.node(this.netUid)!.children.length;
    for (let i = 0; i + 1 < segs.length; i++) {
      const a = segs[i]!;
      const b = segs[i + 1]!;
      if (dist(a, b) < 1e-6) continue;
      ops.push({
        op: 'add',
        parent: this.netUid,
        index: index++,
        tree: {
          nodes: [
            {
              uid: newUid('tr'),
              type: 'trace',
              name: '',
              props: {},
              rules: [
                { name: 'start', value: a },
                { name: 'end', value: b },
                { name: 'layer', value: this.app.activeLayer },
              ],
              parent: this.netUid,
              children: [],
            },
          ],
        },
      });
    }
    if (!ops.length) return false;
    this.app.apply('Route', ops);
    this.last = this.target.p;
    const done = !!this.target.uid && this.app.node(this.target.uid)?.type !== 'trace';
    if (done) {
      const net = this.net;
      this.cancel();
      this.app.say(`Connected ${net}.`);
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
    const ok = app.apply('Add via', [
      {
        op: 'add',
        parent: this.netUid,
        index: app.node(this.netUid)!.children.length,
        tree: {
          nodes: [
            {
              uid: newUid('via'),
              type: 'via',
              name: '',
              props: {},
              rules: [
                { name: 'position', value: this.last },
                { name: 'layers', value: [top, bottom] },
              ],
              parent: this.netUid,
              children: [],
            },
          ],
        },
      },
    ]);
    if (!ok) return;
    app.activeLayer = app.activeLayer === top ? bottom : top;
    app.emit('mode');
    app.say(`Via ${d.toFixed(2)}/${h.toFixed(2)} mm placed · now on ${app.activeLayer}`);
    this.rebuildPreview();
  }

  drawOverlay(ctx: CanvasRenderingContext2D, S: (p: Vec2) => Vec2): void {
    if (this.app.mode !== 'route') return;
    const p = this.target?.p ?? this.app.cursor;
    const s = S(p);
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
  }
}

function projectOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
