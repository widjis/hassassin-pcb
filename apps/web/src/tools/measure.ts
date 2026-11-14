/**
 * Measure tool (P7, docs/05-pcb-improvements.md): Q, then click two points; the distance and Δx / Δy are
 * shown, snapping to pad and via centres, pad edges and trace centre lines. A third click starts again;
 * Esc leaves. In select mode, two selected objects show the clearance between them.
 */
import { clearanceBetween, collectCopper, dist, measureSnap, type Clearance, type CopperShape, type Vec2 } from '@hassassin/core';
import type { App } from '../app.ts';

export class MeasureTool {
  private a: Vec2 | null = null;
  private b: Vec2 | null = null;
  private cursor: { at: Vec2; what: string } | null = null;
  private shapes: { version: number; s: CopperShape[] } | null = null;
  /** Clearance between the two selected objects (select mode). */
  private gap: { key: string; c: Clearance | undefined } | null = null;

  private app: App;
  constructor(app: App) {
    this.app = app;
  }

  start(): void {
    this.app.setMode('measure');
    this.a = this.b = null;
    this.app.say('Measure: click two points (snaps to pad centres and edges, via centres and trace centre lines). Esc leaves.');
  }

  cancel(): void {
    this.a = this.b = null;
    this.cursor = null;
    this.app.requestRender();
  }

  private snap(p: Vec2): { at: Vec2; what: string } {
    const app = this.app;
    if (!app.doc || !app.engine) return { at: p, what: 'free' };
    if (this.shapes?.version !== app.docVersion) this.shapes = { version: app.docVersion, s: collectCopper(app.doc, app.engine, app.copper).filter((s) => app.visible.has(s.layer)) };
    return measureSnap(app.doc, app.engine, app.copper, p, 8 / app.view.scale, this.shapes.s);
  }

  hover(p: Vec2): void {
    this.cursor = this.snap(p);
    if (this.a && !this.b) this.say(this.a, this.cursor.at);
    this.app.requestRender();
  }

  click(p: Vec2): void {
    const q = this.snap(p).at;
    if (!this.a || this.b) {
      this.a = q;
      this.b = null;
    } else {
      this.b = q;
      this.say(this.a, q);
    }
    this.app.requestRender();
  }

  private say(a: Vec2, b: Vec2): void {
    this.app.say(`Distance ${dist(a, b).toFixed(3)} mm · Δx ${(b.x - a.x).toFixed(3)} · Δy ${(b.y - a.y).toFixed(3)} mm`);
  }

  /** The clearance between the two selected objects, when exactly two copper objects are selected. */
  private selectionGap(): Clearance | undefined {
    const app = this.app;
    if (!app.doc || !app.engine || app.selection.size !== 2) return undefined;
    const [u, v] = [...app.selection];
    const key = `${app.docVersion}|${u}|${v}`;
    if (this.gap?.key !== key) {
      const c = clearanceBetween(app.doc, app.engine, app.copper, u!, v!);
      this.gap = { key, c };
      if (c) app.say(`Clearance ${c.gap.toFixed(3)} mm on ${c.layer} (needed ${c.required.toFixed(3)} mm)${c.gap + 1e-6 < c.required ? ' — too close' : ''}`);
    }
    return this.gap.c;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, S: (p: Vec2) => Vec2): void {
    const app = this.app;
    const label = (at: Vec2, text: string, bad = false) => {
      ctx.font = '11px ui-monospace, Menlo, monospace';
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(15,17,22,0.85)';
      ctx.fillRect(at.x + 8, at.y - 18, w, 16);
      ctx.fillStyle = bad ? 'rgba(255,120,120,1)' : 'rgba(150,230,255,1)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, at.x + 12, at.y - 10);
    };
    const line = (p: Vec2, q: Vec2, color: string) => {
      const s = S(p);
      const t = S(q);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      for (const e of [s, t]) {
        ctx.beginPath();
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    if (app.mode === 'select') {
      const c = this.selectionGap();
      if (c) {
        const bad = c.gap + 1e-6 < c.required;
        line(c.a, c.b, bad ? 'rgba(255,110,110,0.95)' : 'rgba(150,230,255,0.95)');
        label(S({ x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 }), `${c.gap.toFixed(3)} mm (≥ ${c.required.toFixed(3)})`, bad);
      }
      return;
    }
    if (app.mode !== 'measure') return;
    const cur = this.cursor;
    if (cur) {
      const s = S(cur.at);
      ctx.strokeStyle = cur.what === 'free' ? 'rgba(255,255,255,0.7)' : 'rgba(150,230,255,0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x - 7, s.y);
      ctx.lineTo(s.x + 7, s.y);
      ctx.moveTo(s.x, s.y - 7);
      ctx.lineTo(s.x, s.y + 7);
      ctx.stroke();
    }
    const end = this.b ?? cur?.at;
    if (this.a && end) {
      line(this.a, end, 'rgba(150,230,255,0.95)');
      // Δx and Δy legs.
      const s = S(this.a);
      const t = S(end);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(150,230,255,0.45)';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);
      label(t, `${dist(this.a, end).toFixed(3)} mm  Δx ${(end.x - this.a.x).toFixed(3)}  Δy ${(end.y - this.a.y).toFixed(3)}`);
    }
  }
}
