/**
 * Via stitching for a pour (docs/05-pcb-improvements.md, P14): vias of the pour's net on a square grid
 * wherever the net's pour covers at least two copper layers, so the pours of both sides are tied together
 * and the return path stays short. As the stitching tools of production editors (grid pitch, distance from
 * the pour's edge), our own method:
 *
 * - grid points every `pitch` (rule `stitchSpacing`, or the tool's argument), aligned to the board origin;
 * - a point is used when a via there lies inside the net's filled pour on two or more layers, at least
 *   `edge` (rule `stitchEdge`, default 0.5 mm) from every edge of that copper, keeps its clearance from the
 *   copper of other nets, keeps off every pad (its own net's too), keeps `holeToHoleMin` from every drill
 *   and stays out of keep-outs that forbid vias;
 * - the stitching vias are marked `stitch: true`; stitching again replaces them.
 */
import type { Op } from './commands.ts';
import { clearanceFor, collectCopper, inArea, type CopperShape, type PolyWithHoles } from './copper.ts';
import { distToSegment, pointInPolygon } from './geom.ts';
import { keepoutAreas } from './keepout.ts';
import { newUid, type Doc, type DocNode, type Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export interface StitchOptions {
  /** Grid pitch (mm); default the net's `stitchSpacing` rule. */
  pitch?: number;
  /** Distance from the pour's copper edge (mm); default the net's `stitchEdge` rule, else 0.5 mm. */
  edge?: number;
}

export interface StitchResult {
  ops: Op[];
  added: number;
  /** Stitching vias of an earlier run that were taken away (replaced). */
  removed: number;
  /** Grid points inside the pour that had no room for a via. */
  blocked: number;
  pitch: number;
  edge: number;
}

export const isStitchVia = (n: DocNode | undefined) => n?.type === 'via' && n.props.stitch === true;

const num = (engine: StyleEngine, uid: string, name: string, fallback: number) => {
  const v = Number(engine.get(uid, name)?.value);
  return Number.isFinite(v) ? v : fallback;
};

/** Distance from p to the nearest edge of a polygon with holes. */
function edgeDistance(p: Vec2, poly: PolyWithHoles): number {
  let d = Infinity;
  for (const ring of poly) for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!));
  return d;
}

/** Stitching vias for the pours of one net. Throws when the net has no filled pour or no pitch is set. */
export function stitchOps(doc: Doc, engine: StyleEngine, copper: string[], netName: string, opts: StitchOptions = {}): StitchResult {
  const net = [...doc.nodes.values()].find((n) => n.type === 'net' && n.name === netName);
  if (!net) throw new Error(`No net named ${netName}`);
  const pitch = opts.pitch ?? num(engine, net.uid, 'stitchSpacing', 0);
  if (!(pitch > 0)) throw new Error(`Set a grid pitch: the pitch argument, or the stitchSpacing rule of ${netName} (e.g. 5mm).`);
  const edge = opts.edge ?? num(engine, net.uid, 'stitchEdge', 0.5);
  const viaD = num(engine, net.uid, 'viaDiameter', 0.6);
  const viaHole = num(engine, net.uid, 'viaHole', 0.3);
  const holeGap = num(engine, net.uid, 'holeToHoleMin', 0.25);
  const viaKeep = (engine.get(net.uid, 'keepOut')?.value as CopperShape['keepOut'] | undefined) ?? { byType: {} };

  // The net's filled copper per layer.
  const fills = new Map<string, PolyWithHoles[]>();
  for (const c of net.children) {
    const f = doc.nodes.get(c);
    if (f?.type !== 'fill') continue;
    for (const [layer, polys] of Object.entries((f.data?.fills ?? {}) as Record<string, PolyWithHoles[]>)) if (copper.includes(layer)) fills.set(layer, [...(fills.get(layer) ?? []), ...polys]);
  }
  if ([...fills.values()].filter((l) => l.length).length < 2) throw new Error(`${netName} has no filled pour on two layers; fill its pours first (refill_pours).`);

  const ops: Op[] = [];
  let removed = 0;
  for (const c of net.children) if (isStitchVia(doc.nodes.get(c))) (ops.push({ op: 'remove', uid: c }), removed++);

  const shapes = collectCopper(doc, engine, copper).filter((s) => s.kind !== 'fill' && !isStitchVia(doc.nodes.get(s.uid)));
  const holes: { c: Vec2; r: number }[] = [];
  const seen = new Set<string>();
  for (const s of shapes) if (s.hole && !seen.has(s.uid)) (seen.add(s.uid), holes.push({ c: s.hole.center, r: Math.max(s.hole.size.x, s.hole.size.y) / 2 }));
  const keepouts = keepoutAreas(doc, engine, copper).filter((k) => k.forbid.has('vias'));
  const R = viaD / 2;

  const room = (p: Vec2): boolean => {
    for (const h of holes) if (Math.hypot(p.x - h.c.x, p.y - h.c.y) < viaHole / 2 + h.r + holeGap - 1e-6) return false;
    for (const k of keepouts) if (pointInPolygon(p, k.poly) || k.poly.some((q, i) => distToSegment(p, q, k.poly[(i + 1) % k.poly.length]!) < R)) return false;
    for (const s of shapes) {
      const own = s.net === netName;
      // Its own net's traces may pass under a stitching via; pads never (a hole in a pad).
      if (own && s.kind !== 'pad') continue;
      const need = own ? 0.05 : Math.max(clearanceFor(viaKeep, s.kind), clearanceFor(s.keepOut, 'via'));
      if (p.x < s.box.minX - R - need || p.x > s.box.maxX + R + need || p.y < s.box.minY - R - need || p.y > s.box.maxY + R + need) continue;
      if (s.areas.some((a) => inArea(p, a))) return false;
      for (const [a, b, r] of s.edges) if (distToSegment(p, a, b) < r + R + need - 1e-6) return false;
    }
    return true;
  };

  // Grid over the pours' extent, aligned to the origin.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polys of fills.values()) for (const poly of polys) for (const q of poly[0]!) (minX = Math.min(minX, q.x)), (minY = Math.min(minY, q.y)), (maxX = Math.max(maxX, q.x)), (maxY = Math.max(maxY, q.y));
  let added = 0;
  let blocked = 0;
  const placed: Vec2[] = [];
  for (let y = Math.ceil(minY / pitch) * pitch; y <= maxY; y += pitch) {
    for (let x = Math.ceil(minX / pitch) * pitch; x <= maxX; x += pitch) {
      const p = { x: +x.toFixed(6), y: +y.toFixed(6) };
      let layers = 0;
      for (const polys of fills.values()) if (polys.some((poly) => inArea(p, poly) && edgeDistance(p, poly) >= edge + R)) layers++;
      if (layers < 2) continue;
      if (!room(p) || placed.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < viaHole + holeGap)) {
        blocked++;
        continue;
      }
      placed.push(p);
      added++;
      ops.push({
        op: 'add', parent: net.uid, index: net.children.length,
        tree: { nodes: [{ uid: newUid('via'), type: 'via', name: '', parent: net.uid, children: [], props: { stitch: true }, rules: [{ name: 'position', value: p }, { name: 'layers', value: [...copper] }] }] },
      });
    }
  }
  return { ops, added, removed, blocked, pitch, edge };
}
