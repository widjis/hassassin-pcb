/**
 * Side-by-side picture of two routings of one board (docs/05-pcb-improvements.md, P8a): signal traces,
 * vias, pads and the board edge, without the pours that hide them in the editor.
 *
 *   node apps/cli/bench/compare.ts <original.hpcb> <routed.hpcb> <out.html>
 *
 * Use the files `autoroute.ts --save <dir>` writes. Left: every trace of the nets without a pour; right:
 * the autorouted traces of the same nets.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { arcPoints, boardOutline, collectCopper, type Vec2 } from '@hassassin/core';
import { openProject } from '@hassassin/tools';
import { loadGeometry } from '../src/io.ts';
await loadGeometry();
const [origPath, routedPath, out] = process.argv.slice(2) as [string, string, string];
const svgOf = async (path: string, title: string, onlyAuto: boolean) => {
  const p = openProject([{ name: 'x.hpcb', text: await readFile(path, 'utf8') }]);
  const ob = boardOutline(p.doc, p.engine);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [a, b] of ob.segments) for (const q of [a, b]) (x0 = Math.min(x0, q.x)), (y0 = Math.min(y0, q.y)), (x1 = Math.max(x1, q.x)), (y1 = Math.max(y1, q.y));
  const poured = new Set<string>();
  for (const n of p.doc.nodes.values()) if (n.type === 'fill' && n.parent) poured.add(n.parent);
  const parts: string[] = [];
  const pt = (q: Vec2) => `${(q.x - x0 + 2).toFixed(3)},${(q.y - y0 + 2).toFixed(3)}`;
  for (const [a, b] of ob.segments) parts.push(`<line x1="${pt(a).split(',')[0]}" y1="${pt(a).split(',')[1]}" x2="${pt(b).split(',')[0]}" y2="${pt(b).split(',')[1]}" class="edge"/>`);
  const shapes = collectCopper(p.doc, p.engine, p.copper);
  for (const s of shapes) if (s.kind === 'pad' && s.areas[0]?.[0]) parts.push(`<polygon points="${s.areas[0][0].map(pt).join(' ')}" class="pad"/>`);
  const layerCls = (l: string) => (l === 'F.Cu' ? 'top' : 'bot');
  const order = [...p.doc.nodes.values()].filter((n) => n.type === 'trace').sort((a, b) => (String(p.engine.get(a.uid, 'layer')?.value) === 'B.Cu' ? -1 : 1) - (String(p.engine.get(b.uid, 'layer')?.value) === 'B.Cu' ? -1 : 1));
  let n = 0;
  for (const t of order) {
    const net = t.parent ? p.doc.nodes.get(t.parent) : undefined;
    if (net && poured.has(net.uid)) continue;
    if (onlyAuto && !t.props.autorouted) continue;
    const a = p.engine.get(t.uid, 'start')?.value as Vec2;
    const b = p.engine.get(t.uid, 'end')?.value as Vec2;
    const m = p.engine.get(t.uid, 'mid')?.value as Vec2 | undefined;
    const w = Number(p.engine.get(t.uid, 'traceWidth')?.value ?? 0.25);
    const pts = m ? arcPoints(a, m, b) : [a, b];
    parts.push(`<polyline points="${pts.map(pt).join(' ')}" class="${layerCls(String(p.engine.get(t.uid, 'layer')?.value))}" stroke-width="${w}"/>`);
    n++;
  }
  let v = 0;
  for (const x of p.doc.nodes.values()) {
    if (x.type !== 'via') continue;
    const net = x.parent ? p.doc.nodes.get(x.parent) : undefined;
    if (net && poured.has(net.uid)) continue;
    const c = p.engine.get(x.uid, 'position')?.value as Vec2;
    const d = Number(p.engine.get(x.uid, 'viaDiameter')?.value ?? 0.6);
    const [cx, cy] = pt(c).split(',');
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${d / 2}" class="via"/>`);
    v++;
  }
  const W = x1 - x0 + 4, H = y1 - y0 + 4;
  return { svg: `<svg viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`, title, n, v };
};
const a = await svgOf(origPath, 'Original (hand-routed in KiCad)', false);
const b = await svgOf(routedPath, 'Hassassin autorouter', true);
await writeFile(out, `<!doctype html><meta charset="utf-8"><title>RGB lamp r6 routing</title><style>
body{margin:0;background:#111;color:#ddd;font:13px system-ui} .row{display:flex;gap:12px;padding:12px} .col{flex:1;min-width:0}
h2{font-size:14px;margin:4px 0} svg{width:100%;height:auto;background:#1a1a1a;border:1px solid #333}
.edge{stroke:#e8c547;stroke-width:.15;fill:none} .pad{fill:#777;stroke:none;opacity:.8}
.top{stroke:#e5533d;fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.9} .bot{stroke:#3d7be5;fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.85}
.via{fill:#d9d9d9;stroke:#555;stroke-width:.1} p{margin:2px 0;color:#aaa}
</style><div class="row"><div class="col"><h2>${a.title}</h2><p>${a.n} trace segments, ${a.v} vias (signal nets; poured power nets hidden)</p>${a.svg}</div><div class="col"><h2>${b.title}</h2><p>${b.n} trace segments, ${b.v} vias (same nets, ripped up and autorouted)</p>${b.svg}</div></div><p style="padding:0 12px">Red = top (F.Cu), blue = bottom (B.Cu), grey = pads, yellow = board edge.</p>`);
console.log('ok', out);
