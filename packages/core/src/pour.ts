/**
 * Copper pours. A pour is a `fill` node under its net. Pours are filled from:
 *   - their own outline (`points`) or, when absent, the board outline,
 *   - minus the board edge clearance,
 *   - minus every other-net copper object grown by the larger of the two keep-outs,
 *   - minus a gap around same-net pads, with the pad and its thermal spokes put back
 *     (per the `thermalRelief` rule: spokes | solid | none),
 *   - minus necks thinner than the minimum trace width,
 *   - keeping only islands that touch the pour's own net.
 *
 * Nets can ask for pours through the `pourLayers` rule; `planPours` creates or removes
 * the matching automatic pour nodes. Requires `setClipper()` to have been called.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import { boardOutline, clearanceFor, collectCopper, inArea, netNameOf, type CopperShape, type PolyWithHoles } from './copper.ts';
import { place, pointInPolygon } from './geom.ts';
import { ARC_MARGIN, difference, fromIPath, intersect, isOuter, offsetAreas, offsetLine, toIAreas, toIPath, union, type IPaths } from './clip.ts';

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const s = p[i]!;
    const t = p[(i + 1) % p.length]!;
    a += s.x * t.y - t.x * s.y;
  }
  return a / 2;
}

/** Group clipper output (outer rings and holes by orientation) into polygons with holes. */
export function groupRings(paths: IPaths): PolyWithHoles[] {
  const outers: Vec2[][] = [];
  const holes: Vec2[][] = [];
  for (const p of paths) {
    if (p.length < 3) continue;
    (isOuter(p) ? outers : holes).push(fromIPath(p));
  }
  const polys: PolyWithHoles[] = outers.map((o) => [o]);
  const areas = outers.map((o) => Math.abs(signedArea(o)));
  for (const h of holes) {
    let best = -1;
    for (let i = 0; i < polys.length; i++) {
      if ((best < 0 || areas[i]! < areas[best]!) && pointInPolygon(h[0]!, polys[i]![0]!)) best = i;
    }
    if (best >= 0) polys[best]!.push(h);
  }
  return polys;
}

/** A polygon that fully contains the circle (vertices pushed out so chords never cut in). */
function circleAround(c: Vec2, r: number): IPaths {
  const n = Math.max(16, Math.min(96, Math.ceil(r * 64)));
  const R = r / Math.cos(Math.PI / n);
  return toIAreas([Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos((i / n) * 2 * Math.PI) * R, y: c.y + Math.sin((i / n) * 2 * Math.PI) * R }))]);
}

function grow(shape: CopperShape, by: number): IPaths {
  if (shape.kind === 'pad') return offsetAreas(toIAreas(shape.areas.map((a) => a[0]!)), by);
  const out: IPaths = [];
  for (const [a, b, r] of shape.edges) {
    if (a.x === b.x && a.y === b.y) out.push(...circleAround(a, r + by));
    else for (const q of offsetLine(toIPath([a, b]), r + by)) out.push(q);
  }
  return out;
}

function rect(center: Vec2, w: number, h: number, rot: number): Vec2[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((p) => place(p, center, rot));
}

export interface PourResult {
  fills: Record<string, PolyWithHoles[]>;
  ms: number;
}

/** Compute the copper of one pour node. */
export function fillPour(doc: Doc, engine: StyleEngine, pour: DocNode, copper: string[], shapes?: CopperShape[]): PourResult {
  const t0 = performance.now();
  const net = netNameOf(doc, pour);
  const raw = engine.get(pour.uid, 'layers')?.value;
  const layers = (Array.isArray(raw) ? (raw as string[]) : []).flatMap((l) => (l === '*' ? copper : [l])).filter((l) => copper.includes(l));
  const all = shapes ?? collectCopper(doc, engine, copper);
  const keep = engine.get(pour.uid, 'keepOut')?.value as { all?: number; byType: Record<string, number> } | undefined;
  const own = keep ?? { byType: {} };
  const relief = String(engine.get(pour.uid, 'thermalRelief')?.value ?? 'spokes');
  const spoke = Number(engine.get(pour.uid, 'thermalSpokeWidth')?.value ?? 0.3);
  const minWidth = Number(engine.get(pour.uid, 'traceWidthMin')?.value ?? 0.15);
  const edgeCl = Number(engine.get(pour.uid, 'boardEdgeClearance')?.value ?? 0.3);

  // Base area: own outline ∩ (board outline − cutouts − edge clearance).
  const outline = boardOutline(doc, engine);
  const ownPts = engine.get(pour.uid, 'points')?.value as Vec2[] | undefined;
  let base: IPaths = ownPts && ownPts.length >= 3 ? toIAreas([ownPts]) : [];
  if (outline.loops[0]) {
    let board = toIAreas([outline.loops[0]]);
    if (outline.loops.length > 1) board = difference(board, toIAreas(outline.loops.slice(1)));
    board = offsetAreas(board, -(edgeCl + ARC_MARGIN));
    base = base.length ? intersect(base, board) : board;
  }
  const fills: Record<string, PolyWithHoles[]> = {};
  if (!base.length) return { fills, ms: performance.now() - t0 };

  for (const layer of layers) {
    const cut: IPaths = []; // everything to remove (all positively wound)
    const back: IPaths = []; // same-net pads + spokes to put back afterwards
    const keepOut: IPaths = []; // grown other-net copper (spokes must respect it)
    const anchors: Vec2[] = [];
    for (const s of all) {
      if (s.uid === pour.uid) continue;
      // Unplated holes cut every layer.
      if (s.hole && !s.hole.plated) {
        const c = Math.max(clearanceFor(own, 'pad'), 0.2) + ARC_MARGIN;
        cut.push(...circleAround(s.hole.center, Math.max(s.hole.size.x, s.hole.size.y) / 2 + c));
      }
      if (s.layer !== layer || s.kind === 'fill') continue;
      if (net !== null && s.net === net) {
        anchors.push(s.probe);
        if (s.kind === 'pad' && relief !== 'solid') {
          const gap = clearanceFor(own, 'pad') + ARC_MARGIN;
          const padPaths = toIAreas(s.areas.map((a) => a[0]!));
          const grown = offsetAreas(padPaths, gap);
          cut.push(...grown);
          if (relief === 'spokes') {
            const big = Math.max(s.box.maxX - s.box.minX, s.box.maxY - s.box.minY) + gap * 4;
            const rot = s.rot ?? 0;
            back.push(...padPaths, ...intersect(toIAreas([rect(s.probe, big, spoke, rot), rect(s.probe, spoke, big, rot)]), grown));
          }
        }
        continue;
      }
      const c = Math.max(clearanceFor(own, s.kind), clearanceFor(s.keepOut, 'fill')) + ARC_MARGIN;
      const g = grow(s, c);
      cut.push(...g);
      keepOut.push(...g);
    }
    let res = difference(base, union(cut));
    if (back.length) {
      // Put pads and spokes back, but never closer to other nets than allowed.
      const spokes = difference(intersect(union(back), base), union(keepOut));
      res = union([...res, ...spokes]);
    }
    // Remove necks and crumbs thinner than the minimum width.
    const h = minWidth / 2;
    res = offsetAreas(offsetAreas(res, -h), h);
    let polys = groupRings(res);
    if (net !== null) polys = polys.filter((p) => anchors.some((a) => inArea(a, p)));
    fills[layer] = polys;
  }
  return { fills, ms: performance.now() - t0 };
}

/** Ops that create/remove automatic pours so they match each net's `pourLayers` rule. */
export function planPours(doc: Doc, engine: StyleEngine, copper: string[]): Op[] {
  const ops: Op[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'net') continue;
    const c = engine.get(n.uid, 'pourLayers');
    const raw = c && c.source.kind !== 'default' ? c.value : undefined;
    const want = (Array.isArray(raw) ? (raw as string[]) : []).flatMap((l) => (l === '*' ? copper : [l])).filter((l) => copper.includes(l));
    const autos = n.children.map((u) => doc.nodes.get(u)!).filter((x) => x?.type === 'fill' && x.props.auto === true);
    if (!want.length) {
      for (const a of autos) ops.push({ op: 'remove', uid: a.uid });
      continue;
    }
    const existing = autos[0];
    if (existing) {
      const cur = engine.get(existing.uid, 'layers')?.value as string[] | undefined;
      if (JSON.stringify(cur) !== JSON.stringify(want)) ops.push({ op: 'setRule', uid: existing.uid, name: 'layers', decl: { name: 'layers', value: want } });
      for (const extra of autos.slice(1)) ops.push({ op: 'remove', uid: extra.uid });
    } else {
      ops.push({
        op: 'add',
        parent: n.uid,
        index: n.children.length,
        tree: { nodes: [{ uid: newUid('pour'), type: 'fill', name: `${n.name} pour`, props: { auto: true }, rules: [{ name: 'layers', value: want }], parent: n.uid, children: [] }] },
      });
    }
  }
  return ops;
}

/** Ops that refill every pour (store the result in node data). */
export function refillOps(doc: Doc, engine: StyleEngine, copper: string[]): { ops: Op[]; ms: number; pours: number } {
  const t0 = performance.now();
  const shapes = collectCopper(doc, engine, copper);
  const ops: Op[] = [];
  let pours = 0;
  for (const n of doc.nodes.values()) {
    if (n.type !== 'fill') continue;
    pours++;
    const { fills } = fillPour(doc, engine, n, copper, shapes);
    ops.push({ op: 'setData', uid: n.uid, key: 'fills', value: fills });
  }
  return { ops, ms: performance.now() - t0, pours };
}
