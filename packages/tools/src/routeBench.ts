/**
 * Autorouter measurement (docs/05-pcb-improvements.md, P8a): the figures the benchmark and the
 * autorouter tests report, and small synthetic boards that exercise known weak spots of the router.
 *
 * Shared by `apps/cli/bench/autoroute.ts` (real boards, on copies) and the Vitest fixtures, so both
 * measure the same way.
 */
import { collectCopper, computeRatsnest, inArea, runDrc, type Doc, type Op, type StyleEngine, type Vec2 } from '@hassassin/core';
import { newProject, type Project } from './project.ts';
import { runTool } from './tools.ts';

export interface RouteFigures {
  connections: number;
  routed: number;
  failed: number;
  vias: number;
  /** mm, autorouted copper only. */
  length: number;
  ms: number;
  /** Ratsnest lines left after routing. */
  unroutedAfter: number;
  /** DRC errors other than `unrouted`, after refilling pours. */
  drcErrors: number;
  drcByKind: Record<string, number>;
  /** Failure reasons of the autorouter, counted. */
  reasons: Record<string, number>;
  /** Joints between two autorouted segments of one net whose turn is 90° or more (right or acute corners). */
  sharpCorners: number;
  /** Direction changes of autorouted copper per routed connection. */
  bendsPerConnection: number;
  /** Autorouted segments that are not at a multiple of 45° (off-angle stubs). */
  offAngle: number;
  /** Joints of autorouted segments sharper than 90° (never wanted, whatever the corner style). */
  acuteCorners: number;
  /** Joints of two autorouted segments that run on in the same direction (should have been one segment). */
  collinear: number;
  /** Autorouted arcs (corner style `arc`). */
  arcs: number;
}

/** Remove traces and vias of every net that has no pour (pads, pours and poured nets stay). */
export function ripUpUnpoured(p: Project): number {
  const poured = new Set<string>();
  for (const n of p.doc.nodes.values()) if (n.type === 'fill' && n.parent) poured.add(n.parent);
  const ops: Op[] = [];
  for (const n of p.doc.nodes.values()) {
    if (n.type !== 'trace' && n.type !== 'via') continue;
    const net = n.parent ? p.doc.nodes.get(n.parent) : undefined;
    if (net?.type === 'net' && poured.has(net.uid)) continue;
    ops.push({ op: 'remove', uid: n.uid });
  }
  if (ops.length) p.history.apply('Rip up', ops);
  return ops.length;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const key = (p: Vec2) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;

/**
 * Corner figures of autorouted copper: where exactly two autorouted segments of one net on one layer
 * meet (and nothing else does: not at a via, not inside a pad, where separate connections meet), the turn
 * between them. Returns the number of turns of 90° or more, of any size, and the other counts.
 */
export function cornerFigures(doc: Doc, engine: StyleEngine, copper: string[] = []): { sharp: number; bends: number; offAngle: number; acute: number; collinear: number; arcs: number } {
  const ends = new Map<string, { dir: Vec2; auto: boolean }[]>();
  const blocked = new Set<string>();
  let offAngle = 0;
  let arcs = 0;
  for (const n of doc.nodes.values()) {
    if (n.type === 'via') {
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (p) blocked.add(key(p));
      continue;
    }
    if (n.type !== 'trace') continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    if (!a || !b) continue;
    if (engine.get(n.uid, 'mid')?.value) {
      if (n.props.autorouted === true) arcs++;
      continue;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const layer = String(engine.get(n.uid, 'layer')?.value ?? '');
    const auto = n.props.autorouted === true;
    if (auto) {
      const deg = (((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 45 + 45) % 45;
      if (Math.min(deg, 45 - deg) > 0.01) offAngle++;
    }
    // Direction pointing away from the joint, for each end.
    const add = (at: Vec2, to: Vec2) => {
      const k = `${n.parent}|${layer}|${key(at)}`;
      const list = ends.get(k) ?? ends.set(k, []).get(k)!;
      list.push({ dir: { x: (to.x - at.x) / len, y: (to.y - at.y) / len }, auto });
    };
    add(a, b);
    add(b, a);
  }
  let sharp = 0;
  let bends = 0;
  let acute = 0;
  let collinear = 0;
  const pads = copper.length ? collectCopper(doc, engine, copper).filter((s) => s.kind === 'pad') : [];
  for (const [k, list] of ends) {
    if (list.length !== 2 || !list[0]!.auto || !list[1]!.auto || blocked.has(k.slice(k.lastIndexOf('|') + 1))) continue;
    const [, layer, at] = k.split('|');
    const [px, py] = at!.split(',').map((v) => Number(v) / 1e4);
    if (pads.some((s) => s.layer === layer && s.areas[0] && inArea({ x: px!, y: py! }, s.areas[0]))) continue;
    const [u, v] = [list[0]!.dir, list[1]!.dir];
    // Straight through: the two directions are opposite (dot = -1). Turn angle = 180° - angle between them.
    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const turn = 180 - (Math.acos(dot) * 180) / Math.PI;
    if (turn < 0.5) {
      collinear++;
      continue;
    }
    bends++;
    if (turn >= 90 - 0.5) sharp++;
    if (turn > 90 + 0.5) acute++;
  }
  return { sharp, bends, offAngle, acute, collinear, arcs };
}

/** Autoroute what is unrouted, refill pours, run DRC and measure. Changes the project. */
export async function measureAutoroute(p: Project, args: Record<string, unknown> = {}): Promise<RouteFigures> {
  await runTool(p, 'refill_pours', {});
  const connections = computeRatsnest(p.doc, p.engine, p.copper).lines.length;
  const r = (await runTool(p, 'autoroute', args)) as { routed: number; failed: { reason: string }[]; vias: number; totalLength: number; ms: number };
  await runTool(p, 'refill_pours', {});
  const errors = runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');
  const drcByKind: Record<string, number> = {};
  for (const v of errors) drcByKind[v.kind] = (drcByKind[v.kind] ?? 0) + 1;
  const reasons: Record<string, number> = {};
  for (const f of r.failed) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
  const c = cornerFigures(p.doc, p.engine, p.copper);
  return {
    connections,
    routed: r.routed,
    failed: r.failed.length,
    vias: r.vias,
    length: r.totalLength,
    ms: r.ms,
    unroutedAfter: computeRatsnest(p.doc, p.engine, p.copper).lines.length,
    drcErrors: errors.length,
    drcByKind,
    reasons,
    sharpCorners: c.sharp,
    bendsPerConnection: r.routed ? Math.round((c.bends / r.routed) * 100) / 100 : 0,
    offAngle: c.offAngle,
    acuteCorners: c.acute,
    collinear: c.collinear,
    arcs: c.arcs,
  };
}

// ---------------------------------------------------------------------------------------------
// Synthetic boards. Built through the tools (as an agent would), deterministic, two copper layers.

async function wire(p: Project, net: string, ...pins: string[]) {
  for (const pin of pins) await runTool(p, 'add_label', { pin, name: net, global: true });
}

async function finish(p: Project, outline: { x: number; y: number; width: number; height: number }, places: [string, number, number, number?][]) {
  await runTool(p, 'update_pcb', {});
  await runTool(p, 'set_board_outline', outline);
  for (const [ref, x, y, rotation] of places) await runTool(p, 'move_part', { ref, x, y, ...(rotation !== undefined ? { rotation } : {}) });
  return p;
}

/**
 * A 0.5 mm pitch QFN-24 whose left-side pins go to a header, next to a 0.5 mm wide supply net on the
 * same part. On v0.0.3 the single shared clearance zone (sized for the supply net) closes the gaps
 * between the QFN pads, so the signal pins cannot get out (P8b).
 */
export async function fixtureQfnEscape(): Promise<Project> {
  const p = newProject('fixture-qfn-escape');
  await runTool(p, 'add_part', { kind: 'ic', pins: 24, x: 60, y: 0, package: 'qfn-24-4x4-p0.5' });
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 0, y: 0 });
  for (let i = 1; i <= 6; i++) await wire(p, `S${i}`, `U1.${i}`, `J1.${i}`);
  await wire(p, 'VCC', `U1.7`, 'J1.7');
  await wire(p, 'GND', `U1.19`, 'J1.8');
  return finish(p, { x: 100, y: 100, width: 30, height: 24 }, [['U1', 120, 112], ['J1', 106, 112]]);
}

/**
 * P8b's acceptance board: a 0.4 mm pitch QFN-24 with 0.15 mm signal nets and 0.15 mm clearances,
 * next to a 0.5 mm supply net on the same part. With one clearance zone for all nets (v0.0.3) the
 * zone sized for the supply net closes the gaps between the pads.
 */
export async function fixtureQfnFine(): Promise<Project> {
  const p = newProject('fixture-qfn-fine');
  await runTool(p, 'add_part', { kind: 'ic', pins: 24, x: 60, y: 0, package: 'qfn-24-4x4-p0.4' });
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 0, y: 0 });
  for (let i = 1; i <= 6; i++) await wire(p, `S${i}`, `U1.${i}`, `J1.${i}`);
  await wire(p, 'VCC', `U1.7`, 'J1.7');
  await wire(p, 'GND', `U1.19`, 'J1.8');
  await finish(p, { x: 100, y: 100, width: 30, height: 24 }, [['U1', 120, 112], ['J1', 106, 112]]);
  for (const target of ['net', 'pad', 'trace', 'via']) await runTool(p, 'set_rule', { target, rule: 'keepOut', value: '0.15mm' });
  await runTool(p, 'set_rule', { target: 'net', rule: 'traceWidth', value: '0.15mm' });
  await runTool(p, 'set_rule', { target: 'net', rule: 'traceWidthMin', value: '0.1mm' });
  return p;
}

/**
 * Two 8-pin headers wired in reverse order (1→8, 2→7, …): every net crosses every other, so two layers
 * and vias are needed and early routes block later ones without rip-up and retry (P8d).
 */
export async function fixtureReversedBus(): Promise<Project> {
  const p = newProject('fixture-reversed-bus');
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 40, y: 0 });
  for (let i = 1; i <= 8; i++) await wire(p, `D${i}`, `J1.${i}`, `J2.${9 - i}`);
  return finish(p, { x: 100, y: 100, width: 30, height: 26 }, [['J1', 106, 113], ['J2', 124, 113]]);
}

/**
 * Small parts at positions off any routing grid, joined in a chain: the router rounds pad centres to its
 * grid and leaves short off-angle stubs (P8c, P8e).
 */
export async function fixtureOffGrid(): Promise<Project> {
  const p = newProject('fixture-off-grid');
  for (let i = 0; i < 4; i++) await runTool(p, 'add_part', { kind: 'resistor', value: '10k', x: i * 15, y: 0 });
  await wire(p, 'A', 'R1.2', 'R2.1');
  await wire(p, 'B', 'R2.2', 'R3.1');
  await wire(p, 'C', 'R3.2', 'R4.1');
  await wire(p, 'E', 'R4.2', 'R1.1');
  return finish(p, { x: 100, y: 100, width: 30, height: 20 }, [
    ['R1', 106.137, 104.913],
    ['R2', 117.071, 107.329, 90],
    ['R3', 123.483, 113.161],
    ['R4', 109.917, 115.047, 45],
  ]);
}

/**
 * A net already routed between two headers, and a third pad of the same net 3 mm beside that trace.
 * The ratsnest joins the third pad to a far pad; a router that may end on any copper of the net joins
 * it to the trace next to it instead (P8c).
 */
export async function fixtureTee(): Promise<Project> {
  const p = newProject('fixture-tee');
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 20, y: 0 });
  await runTool(p, 'add_part', { kind: 'resistor', value: '1k', x: 40, y: 0 });
  await wire(p, 'T', 'J1.1', 'J2.1', 'R1.1');
  await wire(p, 'U', 'J1.2', 'J2.2', 'R1.2');
  await finish(p, { x: 100, y: 100, width: 40, height: 20 }, [['J1', 104, 108], ['J2', 136, 108], ['R1', 120, 113]]);
  await runTool(p, 'route', { from: 'J1.1', to: 'J2.1' });
  return p;
}

/**
 * One copper layer. Net A (13.2 mm, edge to edge) is routed first and runs straight across; net B
 * (15.6 mm) must cross A's straight line to reach a pad by the bottom edge. Without rip-up B fails; with it, A gives way and
 * goes round above B's upper pad (P8d). Route with `layers: ['F.Cu']` (see FIXTURE_ARGS).
 */
export async function fixtureChannel(): Promise<Project> {
  const p = newProject('fixture-channel');
  for (let i = 0; i < 4; i++) await runTool(p, 'add_part', { kind: 'connector', pins: 1, x: i * 15, y: 0 });
  await wire(p, 'A', 'J1.1', 'J2.1');
  await wire(p, 'B', 'J3.1', 'J4.1');
  return finish(p, { x: 100, y: 100, width: 16, height: 20 }, [['J1', 101.4, 110], ['J2', 114.6, 110], ['J3', 108, 103], ['J4', 108, 118.6]]);
}

/** Extra `autoroute` arguments per fixture. */
export const FIXTURE_ARGS: Record<string, Record<string, unknown>> = { channel: { layers: ['F.Cu'] } };

export const ROUTE_FIXTURES = { 'qfn-escape': fixtureQfnEscape, 'qfn-fine': fixtureQfnFine, 'reversed-bus': fixtureReversedBus, 'off-grid': fixtureOffGrid, tee: fixtureTee, channel: fixtureChannel } as const;
