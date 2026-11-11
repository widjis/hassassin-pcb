/**
 * 3D board view (three.js): the board outline extruded to its stackup thickness with
 * drilled holes, copper pads and traces on both sides, and each component as a simple
 * body sized from its courtyard. Bodies are boxes, not vendor 3D models.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { boardOutline, componentExtent, padGeom, stackupOf, type Vec2 } from '@hassassin/core';
import type { App } from '../app.ts';

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

/** Rough body height from the footprint name (mm). */
function bodyHeight(fp: string): number {
  const s = fp.toLowerCase();
  if (/header|pinheader|pin_header/.test(s)) return 8.5;
  if (/terminal|screw/.test(s)) return 10;
  if (/usb|jack|barrel/.test(s)) return 3.5;
  if (/dip|to-220|to220/.test(s)) return 3.5;
  if (/hole|mounting/.test(s)) return 0;
  if (/0201|0402/.test(s)) return 0.35;
  if (/0603/.test(s)) return 0.5;
  if (/0805|1206|1210|chip/.test(s)) return 0.7;
  if (/qfn|dfn|son/.test(s)) return 0.9;
  if (/sot|sod|tssop|msop/.test(s)) return 1.1;
  if (/soic|so-|sop/.test(s)) return 1.6;
  if (/sma|smb|smc|to-252|dpak|sot-223/.test(s)) return 2.3;
  if (/inductor|l_|cd54|ihlp/.test(s)) return 3;
  return 1.5;
}

export class Board3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private host: HTMLElement;
  private frame = 0;
  private resize: ResizeObserver;
  private framed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x15171c);
    host.append(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.request());
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(80, -120, 200);
    this.scene.add(sun);
    const back = new THREE.DirectionalLight(0xffffff, 0.5);
    back.position.set(-80, 120, -200);
    this.scene.add(back);
    this.scene.add(this.group);
    this.resize = new ResizeObserver(() => this.fitSize());
    this.resize.observe(host);
    this.fitSize();
  }

  private fitSize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.request();
  }

  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.scene, this.camera);
    });
  }

  dispose() {
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Rebuild the model from the document. */
  build(app: App) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    const doc = app.doc;
    const engine = app.engine;
    if (!doc || !engine) return;
    const outline = boardOutline(doc, engine).loops;
    if (!outline.length) return;
    const st = stackupOf(doc, app.copper);
    const T = st.thickness;
    const P = (p: Vec2) => new THREE.Vector2(p.x, -p.y);

    // Board with holes (outline cutouts + drills).
    const shape = new THREE.Shape(outline[0]!.map(P));
    for (const cut of outline.slice(1)) shape.holes.push(new THREE.Path(cut.map(P)));
    const drills: { c: Vec2; r: number }[] = [];
    const pads: { pts: Vec2[]; top: boolean; bottom: boolean }[] = [];
    for (const n of doc.nodes.values()) {
      if (n.type === 'pad') {
        const g = padGeom(doc, engine, n, app.copper);
        if (!g) continue;
        if (g.hole) drills.push({ c: g.center, r: Math.min(g.hole.x, g.hole.y) / 2 });
        const top = g.layers.includes(app.copper[0]!);
        const bottom = g.layers.includes(app.copper[app.copper.length - 1]!);
        if (top || bottom) pads.push({ pts: g.outline, top, bottom });
      } else if (n.type === 'via') {
        const c = vec(engine.get(n.uid, 'position')?.value);
        const h = Number(engine.get(n.uid, 'viaHole')?.value ?? 0.3);
        if (c) drills.push({ c, r: h / 2 });
      }
    }
    for (const d of drills.slice(0, 4000)) {
      const path = new THREE.Path();
      path.absarc(d.c.x, -d.c.y, Math.max(0.05, d.r), 0, Math.PI * 2, true);
      shape.holes.push(path);
    }
    const flex = st.layers.some((l) => l.flex);
    const boardGeo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 12 });
    boardGeo.translate(0, 0, -T);
    const boardMesh = new THREE.Mesh(boardGeo, new THREE.MeshStandardMaterial({ color: flex ? 0xc98a2c : 0x1f6b3a, roughness: 0.7, metalness: 0.05 }));
    this.group.add(boardMesh);

    // Copper: pads (gold, as after ENIG) and traces on outer layers.
    const gold = new THREE.MeshStandardMaterial({ color: 0xd8b14a, roughness: 0.35, metalness: 0.8 });
    const cuTop = new THREE.MeshStandardMaterial({ color: 0x2e8b57, roughness: 0.5, metalness: 0.3 });
    const flat = (pts: Vec2[], z: number, mat: THREE.Material) => {
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(P)));
      g.translate(0, 0, z);
      this.group.add(new THREE.Mesh(g, mat));
    };
    for (const p of pads) {
      if (p.top) flat(p.pts, 0.02, gold);
      if (p.bottom) flat(p.pts, -T - 0.02, gold);
    }
    for (const n of doc.nodes.values()) {
      if (n.type !== 'trace') continue;
      const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
      const top = layer === app.copper[0];
      if (!top && layer !== app.copper[app.copper.length - 1]) continue;
      const a = vec(engine.get(n.uid, 'start')?.value);
      const b = vec(engine.get(n.uid, 'end')?.value);
      const w = Number(engine.get(n.uid, 'traceWidth')?.value ?? 0.25);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const geo = new THREE.PlaneGeometry(len + w, w);
      const m = new THREE.Mesh(geo, cuTop);
      m.position.set((a.x + b.x) / 2, -(a.y + b.y) / 2, top ? 0.012 : -T - 0.012);
      m.rotation.z = -Math.atan2(b.y - a.y, b.x - a.x);
      if (!top) m.rotation.x = Math.PI;
      this.group.add(m);
    }

    // Component bodies.
    const body = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.6 });
    const light = new THREE.MeshStandardMaterial({ color: 0xc9b38a, roughness: 0.5 });
    for (const el of doc.nodes.values()) {
      if (el.type !== 'element') continue;
      const fpName = String(el.props.Footprint ?? '');
      const hgt = bodyHeight(fpName);
      if (!hgt) continue;
      const pos = vec(engine.get(el.uid, 'position')?.value);
      if (!pos) continue;
      const e = componentExtent(doc, engine, el, app.copper);
      const shrink = 0.85;
      const w = (e.maxX - e.minX) * shrink;
      const d = (e.maxY - e.minY) * shrink;
      if (!(w > 0 && d > 0)) continue;
      const bottom = engine.get(el.uid, 'side')?.value === 'bottom';
      const mat = /0201|0402|0603|0805|1206|chip|c_|r_/i.test(fpName) ? light : body;
      const geo = new THREE.BoxGeometry(w, d, hgt);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(pos.x + (e.minX + e.maxX) / 2, -(pos.y + (e.minY + e.maxY) / 2), bottom ? -T - hgt / 2 : hgt / 2);
      this.group.add(m);
    }

    if (!this.framed) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of outline[0]!) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
      const cx = (x0 + x1) / 2;
      const cy = -(y0 + y1) / 2;
      const size = Math.max(x1 - x0, y1 - y0);
      this.controls.target.set(cx, cy, 0);
      this.camera.position.set(cx + size * 0.3, cy - size * 1.6, size * 1.3);
      this.camera.far = size * 20;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.framed = true;
    }
    this.request();
  }
}
