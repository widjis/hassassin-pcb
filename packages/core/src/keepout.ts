/**
 * Keep-out areas (docs/05-pcb-improvements.md, P6): `zone` nodes with an outline (`points`), the layers
 * they apply to (`layers`, `*` = every copper layer) and what they forbid there (`keepoutOf`: traces,
 * vias, pours, parts; default traces vias pours, as in KiCad). The autorouter, the interactive router, the
 * autoplacer, the pour fill and DRC read them through this module.
 */
import { componentExtent } from './autoplace.ts';
import type { CopperShape } from './copper.ts';
import { padGeom } from './frames.ts';
import { distToSegment, emptyBox, growBox, pointInPolygon, segSegDist } from './geom.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';

export const KEEPOUT_KINDS = ['traces', 'vias', 'pours', 'parts'] as const;
export type KeepoutKind = (typeof KEEPOUT_KINDS)[number];
export const KEEPOUT_DEFAULT: KeepoutKind[] = ['traces', 'vias', 'pours'];

export interface KeepoutArea {
  uid: string;
  name: string;
  layers: string[];
  poly: Vec2[];
  forbid: Set<KeepoutKind>;
}

export function keepoutAreas(doc: Doc, engine: StyleEngine, copper: string[]): KeepoutArea[] {
  const out: KeepoutArea[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'zone' || engine.get(n.uid, 'enabled')?.value === false) continue;
    const poly = (engine.get(n.uid, 'points')?.value as Vec2[] | undefined) ?? [];
    if (poly.length < 3) continue;
    const raw = engine.get(n.uid, 'layers')?.value;
    const layers = (Array.isArray(raw) ? (raw as string[]) : ['*']).flatMap((l) => (l === '*' || l === '*.Cu' ? copper : [l]));
    const k = engine.get(n.uid, 'keepoutOf')?.value;
    const forbid = new Set<KeepoutKind>((Array.isArray(k) ? (k as string[]) : KEEPOUT_DEFAULT).filter((x): x is KeepoutKind => (KEEPOUT_KINDS as readonly string[]).includes(x)));
    out.push({ uid: n.uid, name: n.name, layers, poly, forbid });
  }
  return out;
}

/** Whether a segment (grown by `r`) touches the area: crosses or comes within r of its edge, or lies inside. */
export function segmentInArea(a: Vec2, b: Vec2, r: number, poly: Vec2[]): boolean {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segSegDist(a, b, poly[i]!, poly[(i + 1) % poly.length]!) < r) return true;
  return false;
}

/** Whether the closed polygon `q` overlaps the area (an edge crossing or one inside the other). */
export function polygonsOverlap(q: Vec2[], poly: Vec2[]): boolean {
  if (q.some((p) => pointInPolygon(p, poly)) || poly.some((p) => pointInPolygon(p, q))) return true;
  for (let i = 0; i < q.length; i++) for (let j = 0; j < poly.length; j++) if (segSegDist(q[i]!, q[(i + 1) % q.length]!, poly[j]!, poly[(j + 1) % poly.length]!) < 1e-9) return true;
  return false;
}

/** Whether a polygon with holes (a filled pour) overlaps the area: an area corner in the copper, a copper
 *  corner inside the area, or edges crossing. A hole cut around the area does not count. */
export function areaOverlaps(area: Vec2[][], poly: Vec2[]): boolean {
  const [outer, ...holes] = area;
  if (!outer) return false;
  const inCopper = (p: Vec2) => pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h));
  if (poly.some(inCopper)) return true;
  for (const ring of area) {
    if (ring.some((p) => pointInPolygon(p, poly))) return true;
    for (let i = 0; i < ring.length; i++) for (let j = 0; j < poly.length; j++) if (segSegDist(ring[i]!, ring[(i + 1) % ring.length]!, poly[j]!, poly[(j + 1) % poly.length]!) < 1e-9) return true;
  }
  return false;
}

/**
 * The areas that forbid traces, as copper-like shapes that belong to no net (each its own owner): the
 * autorouter keeps traces out of them on their layers, with the clearance of the net that routes, and no via
 * sits in them (a via is copper on every layer). Areas that forbid vias only are handled by the router's via
 * check (`viaKeepouts`).
 */
export function keepoutShapes(areas: KeepoutArea[]): CopperShape[] {
  const out: CopperShape[] = [];
  for (const k of areas) {
    if (!k.forbid.has('traces')) continue;
    const box = emptyBox();
    for (const p of k.poly) growBox(box, p.x, p.y);
    const edges: [Vec2, Vec2, number][] = k.poly.map((p, i) => [p, k.poly[(i + 1) % k.poly.length]!, 0]);
    for (const layer of k.layers) {
      out.push({ uid: k.uid, kind: 'pad', net: `__keepout:${k.uid}`, layer, edges, areas: [[k.poly]], box, keepOut: { byType: {} }, edgeClearance: 0, probe: k.poly[0]! });
    }
  }
  return out;
}

export interface KeepoutHit {
  zone: string;
  uid: string;
  layer: string;
  what: KeepoutKind;
  at: Vec2;
}

/** Everything that lies where a keep-out forbids it. */
export function keepoutHits(doc: Doc, engine: StyleEngine, copper: string[], shapes: CopperShape[], areas = keepoutAreas(doc, engine, copper)): KeepoutHit[] {
  const hits: KeepoutHit[] = [];
  if (!areas.length) return hits;
  const done = new Set<string>();
  const hit = (k: KeepoutArea, uid: string, layer: string, what: KeepoutKind, at: Vec2) => {
    const key = `${k.uid}|${uid}`;
    if (done.has(key)) return;
    done.add(key);
    hits.push({ zone: k.name || k.uid, uid, layer, what, at });
  };
  for (const s of shapes) {
    for (const k of areas) {
      if (!k.layers.includes(s.layer)) continue;
      if (s.kind === 'trace' && k.forbid.has('traces')) {
        for (const [a, b, r] of s.edges) if (segmentInArea(a, b, r, k.poly)) hit(k, s.uid, s.layer, 'traces', a);
      } else if (s.kind === 'via' && k.forbid.has('vias')) {
        const [a, , r] = s.edges[0]!;
        if (pointInPolygon(a, k.poly) || k.poly.some((p, i) => distToSegment(a, p, k.poly[(i + 1) % k.poly.length]!) < r)) hit(k, s.uid, s.layer, 'vias', a);
      } else if (s.kind === 'fill' && k.forbid.has('pours')) {
        for (const area of s.areas) if (area[0] && areaOverlaps(area, k.poly)) hit(k, s.uid, s.layer, 'pours', area[0][0]!);
      }
    }
  }
  // Parts: their pads and courtyard box on their side.
  const partZones = areas.filter((k) => k.forbid.has('parts'));
  if (partZones.length)
    for (const el of doc.nodes.values()) {
      if (el.type !== 'element') continue;
      const pos = engine.get(el.uid, 'position')?.value as Vec2 | undefined;
      if (!pos) continue;
      const e = componentExtent(doc, engine, el, copper);
      const box = [
        { x: pos.x + e.minX, y: pos.y + e.minY },
        { x: pos.x + e.maxX, y: pos.y + e.minY },
        { x: pos.x + e.maxX, y: pos.y + e.maxY },
        { x: pos.x + e.minX, y: pos.y + e.maxY },
      ];
      const side = partSide(doc, engine, el, copper);
      for (const k of partZones) if (k.layers.some((l) => side.includes(l)) && polygonsOverlap(box, k.poly)) hit(k, el.uid, side[0] ?? '', 'parts', pos);
    }
  return hits;
}

/** Copper layers a part sits on: its own layer, and the layers of its pads. */
export function partSide(doc: Doc, engine: StyleEngine, el: DocNode, copper: string[]): string[] {
  const out = new Set<string>();
  const own = engine.get(el.uid, 'layer')?.value;
  if (typeof own === 'string' && copper.includes(own)) out.add(own);
  for (const c of el.children) {
    const p = doc.nodes.get(c);
    if (p?.type === 'pad') for (const l of padGeom(doc, engine, p, copper)?.layers ?? []) if (copper.includes(l)) out.add(l);
  }
  if (!out.size) out.add(copper[0] ?? 'F.Cu');
  return [...out];
}
