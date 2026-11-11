/**
 * Excellon drill files (metric, decimal coordinates, Y flipped like the Gerbers).
 * Round holes are hits; oval holes become G85 slots.
 */
import { place, type CopperShape, type Vec2 } from '@hassassin/core';

interface Hit {
  c: Vec2;
  size: Vec2;
  rot: number;
}

const f3 = (v: number) => v.toFixed(3);
const XY = (p: Vec2) => `X${f3(p.x)}Y${f3(-p.y)}`;

export function collectHoles(shapes: CopperShape[]): { plated: Hit[]; unplated: Hit[] } {
  const seen = new Set<string>();
  const plated: Hit[] = [];
  const unplated: Hit[] = [];
  for (const s of shapes) {
    if (!s.hole || seen.has(s.uid)) continue;
    seen.add(s.uid);
    (s.hole.plated ? plated : unplated).push({ c: s.hole.center, size: s.hole.size, rot: s.hole.rot });
  }
  return { plated, unplated };
}

export function excellon(hits: Hit[], plated: boolean, title: string): string {
  const tools = new Map<string, number>();
  const toolOf = (d: number) => {
    const k = f3(d);
    let t = tools.get(k);
    if (t === undefined) tools.set(k, (t = tools.size + 1));
    return t;
  };
  const byTool = new Map<number, string[]>();
  for (const h of [...hits].sort((a, b) => Math.min(a.size.x, a.size.y) - Math.min(b.size.x, b.size.y))) {
    const d = Math.min(h.size.x, h.size.y);
    const t = toolOf(d);
    const lines = byTool.get(t) ?? [];
    if (Math.abs(h.size.x - h.size.y) < 1e-6) lines.push(XY(h.c));
    else {
      // Slot: from one end of the long axis to the other.
      const half = (Math.max(h.size.x, h.size.y) - d) / 2;
      const along = h.size.x > h.size.y ? { x: half, y: 0 } : { x: 0, y: half };
      const a = place({ x: -along.x, y: -along.y }, h.c, h.rot);
      const b = place(along, h.c, h.rot);
      lines.push(`${XY(a)}G85${XY(b)}`);
    }
    byTool.set(t, lines);
  }
  const out = ['M48', `; ${title} — ${plated ? 'plated' : 'non-plated'} holes — Hassassin PCB`, `; #@! TF.FileFunction,${plated ? 'Plated' : 'NonPlated'},1,2,${plated ? 'PTH' : 'NPTH'}`, 'FMAT,2', 'METRIC'];
  for (const [d, t] of tools) out.push(`T${t}C${d}`);
  out.push('%', 'G90', 'G05');
  for (const [t, lines] of byTool) out.push(`T${t}`, ...lines);
  out.push('M30', '');
  return out.join('\n');
}
