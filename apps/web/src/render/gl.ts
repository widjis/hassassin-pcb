/**
 * WebGL2 renderer: one vertex buffer per layer, one tiny shader, world coords in mm.
 */
import type { RGBA } from './colors.ts';

const VS = `#version 300 es
in vec2 a_pos;
uniform vec4 u_view; // cx, cy, sx, sy
void main() {
  gl_Position = vec4((a_pos.x - u_view.x) * u_view.z, (a_pos.y - u_view.y) * u_view.w, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = vec4(u_color.rgb * u_color.a, u_color.a); }`;

interface Batch {
  buf: WebGLBuffer;
  count: number;
}

export interface View {
  cx: number;
  cy: number;
  /** CSS pixels per mm. */
  scale: number;
  /** Mirror X (looking at the board from the bottom). */
  flipped: boolean;
}

export class GLRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private loc: { pos: number; view: WebGLUniformLocation; color: WebGLUniformLocation };
  private vao: WebGLVertexArrayObject;
  private batches = new Map<string, Batch>();

  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('This browser does not support WebGL2.');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    this.prog = p;
    this.loc = { pos: gl.getAttribLocation(p, 'a_pos'), view: gl.getUniformLocation(p, 'u_view')!, color: gl.getUniformLocation(p, 'u_color')! };
    this.vao = gl.createVertexArray()!;
  }

  setLayer(key: string, tris: Float32Array): void {
    const { gl } = this;
    let b = this.batches.get(key);
    if (!b) {
      b = { buf: gl.createBuffer()!, count: 0 };
      this.batches.set(key, b);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
    gl.bufferData(gl.ARRAY_BUFFER, tris, gl.STATIC_DRAW);
    b.count = tris.length / 2;
  }

  clearLayers(): void {
    for (const b of this.batches.values()) this.gl.deleteBuffer(b.buf);
    this.batches.clear();
  }

  resize(): { w: number; h: number; dpr: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    return { w, h, dpr };
  }

  /** Draw the given layer keys in order (first = bottom). */
  draw(view: View, order: { key: string; color: RGBA }[], background: RGBA): void {
    const { gl } = this;
    const { w, h } = this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const sx = ((2 * view.scale) / w) * (view.flipped ? -1 : 1);
    const sy = (-2 * view.scale) / h;
    gl.uniform4f(this.loc.view, view.cx, view.cy, sx, sy);
    gl.enableVertexAttribArray(this.loc.pos);
    for (const { key, color } of order) {
      const b = this.batches.get(key);
      if (!b || !b.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
      gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(this.loc.color, color[0], color[1], color[2], color[3]);
      gl.drawArrays(gl.TRIANGLES, 0, b.count);
    }
  }
}

/** Screen (CSS px) -> world (mm). */
export function screenToWorld(view: View, w: number, h: number, sx: number, sy: number): { x: number; y: number } {
  const dx = (sx - w / 2) / view.scale;
  return { x: view.cx + (view.flipped ? -dx : dx), y: view.cy + (sy - h / 2) / view.scale };
}

export function worldToScreen(view: View, w: number, h: number, x: number, y: number): { x: number; y: number } {
  const dx = (x - view.cx) * view.scale;
  return { x: w / 2 + (view.flipped ? -dx : dx), y: h / 2 + (y - view.cy) * view.scale };
}
