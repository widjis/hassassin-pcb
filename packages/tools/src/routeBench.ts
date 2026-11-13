/**
 * Autorouter measurement (docs/05-pcb-improvements.md, P8a): the figures the benchmark and the
 * autorouter tests report, and small synthetic boards that exercise known weak spots of the router.
 *
 * Shared by `apps/cli/bench/autoroute.ts` (real boards, on copies) and the Vitest fixtures, so both
 * measure the same way.
 */
import { collectCopper, computeRatsnest, inArea, runDrc, type AutorouteSummary, type Doc, type Op, type StyleEngine, type Vec2 } from '@hassassin/core';
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
  /** Grid pitch the router used (mm). */
  grid: number;
  /** Connections the DRC check took out of the plan (P8g), and the check's time in ms. */
  removedByDrc: number;
  checkMs: number;
  /** Pads fanned out before routing (P8f). */
  fanouts: number;
  /** Connections in a bundle (neighbouring pins at both ends, P8f). */
  bundled: number;
  /** Connections routed by shoving others aside (P9). */
  shoved: number;
  /** Differential pairs routed together (P10). */
  pairs: number;
  /**
   * Share of the straight autorouted length (0–1) that runs against its layer's default direction (P8f:
   * even copper layers horizontal, odd ones vertical); 45° pieces count half.
   */
  againstDirection: number;
  /**
   * Share of the straight autorouted length (0–1) with no pour under it on a neighbouring copper layer
   * (P8f, reference plane), after refilling; 0 when no neighbouring layer has a pour.
   */
  offPlane: number;
}

/** Share of the straight autorouted length against the default layer directions (see `RouteFigures.againstDirection`). */
export function againstDirection(doc: Doc, engine: StyleEngine, copper: string[]): number {
  let total = 0;
  let against = 0;
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' || n.props.autorouted !== true || engine.get(n.uid, 'mid')?.value) continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    const k = copper.indexOf(String(engine.get(n.uid, 'layer')?.value ?? ''));
    if (!a || !b || k < 0) continue;
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const len = Math.hypot(dx, dy);
    total += len;
    if (dx > 1e-6 && dy > 1e-6) against += len / 2;
    else if ((k % 2 === 0 ? dy : dx) > 1e-6) against += len;
  }
  return total ? Math.round((against / total) * 1000) / 1000 : 0;
}

/** Share of the straight autorouted length over no pour on a neighbouring copper layer (see `RouteFigures.offPlane`), sampled every 0.1 mm. */
export function offPlane(doc: Doc, engine: StyleEngine, copper: string[]): number {
  const fills = collectCopper(doc, engine, copper).filter((s) => s.kind === 'fill');
  let total = 0;
  let off = 0;
  for (const n of doc.nodes.values()) {
    if (n.type !== 'trace' || n.props.autorouted !== true || engine.get(n.uid, 'mid')?.value) continue;
    const a = vec(engine.get(n.uid, 'start')?.value);
    const b = vec(engine.get(n.uid, 'end')?.value);
    const k = copper.indexOf(String(engine.get(n.uid, 'layer')?.value ?? ''));
    if (!a || !b || k < 0) continue;
    const near = fills.filter((f) => Math.abs(copper.indexOf(f.layer) - k) === 1);
    if (!near.length) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 0.1));
    for (let t = 0; t < steps; t++) {
      const q = { x: a.x + ((b.x - a.x) * (t + 0.5)) / steps, y: a.y + ((b.y - a.y) * (t + 0.5)) / steps };
      total += len / steps;
      if (!near.some((f) => f.box.minX <= q.x && f.box.maxX >= q.x && f.box.minY <= q.y && f.box.maxY >= q.y && f.areas.some((ar) => inArea(q, ar)))) off += len / steps;
    }
  }
  return total ? Math.round((off / total) * 1000) / 1000 : 0;
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
  const r = (await runTool(p, 'autoroute', args)) as AutorouteSummary & { removedByDrc: number; checkMs: number };
  await runTool(p, 'refill_pours', {});
  const errors = runDrc(p.doc, p.engine, p.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted');
  const drcByKind: Record<string, number> = {};
  for (const v of errors) drcByKind[v.kind] = (drcByKind[v.kind] ?? 0) + 1;
  const reasons = r.reasons;
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
    grid: Math.round(r.grid * 1000) / 1000,
    removedByDrc: r.removedByDrc ?? 0,
    checkMs: r.checkMs ?? 0,
    fanouts: r.fanouts,
    bundled: r.bundled,
    shoved: r.shoved ?? 0,
    pairs: r.pairs ?? 0,
    againstDirection: againstDirection(p.doc, p.engine, p.copper),
    offPlane: offPlane(p.doc, p.engine, p.copper),
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
 * A bus: two 8-pin headers, the second one lower and to the right, pin i to pin i. A person draws the eight
 * traces as one bundle at a constant spacing round the bend (P8f, bundles).
 */
export async function fixtureBus(): Promise<Project> {
  const p = newProject('fixture-bus');
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 8, x: 40, y: 0 });
  for (let i = 1; i <= 8; i++) await wire(p, `B${i}`, `J1.${i}`, `J2.${i}`);
  return finish(p, { x: 100, y: 100, width: 40, height: 40 }, [['J1', 106, 112], ['J2', 134, 126]]);
}

/**
 * A small MCU board, closer to a real one: a 0.5 mm QFN-32 with its exposed pad, a 2×5 header whose
 * pin order makes the left-side nets cross, a 1×6 header wired in reverse, an SOIC-8 EEPROM on I2C with
 * two pull-ups, two decoupling capacitors, an LED with its resistor, VCC as a routed net and GND poured on
 * B.Cu. For looking at the router's choices on something busier than one bus (P8f).
 */
export async function fixtureMcu(): Promise<Project> {
  const p = newProject('fixture-mcu');
  await runTool(p, 'add_part', { kind: 'ic', pins: 33, x: 60, y: 0, package: 'qfn-32-5x5-p0.5-ep3.5' });
  await runTool(p, 'add_part', { kind: 'connector', pins: 10, x: 0, y: 0, package: 'header-2x05-p2.54' });
  await runTool(p, 'add_part', { kind: 'connector', pins: 6, x: 120, y: 0, package: 'header-1x06-p2.54' });
  await runTool(p, 'add_part', { kind: 'ic', pins: 8, x: 60, y: -40, package: 'soic-8' });
  for (let i = 0; i < 2; i++) await runTool(p, 'add_part', { kind: 'resistor', x: 90 + i * 10, y: -40, package: 'chip-0603' });
  for (let i = 0; i < 2; i++) await runTool(p, 'add_part', { kind: 'capacitor', x: 90 + i * 10, y: 40, package: 'chip-0603' });
  await runTool(p, 'add_part', { kind: 'led', x: 60, y: 60, package: 'chip-0603' });
  await runTool(p, 'add_part', { kind: 'resistor', x: 80, y: 60, package: 'chip-0603' });
  // Left header: J1.1…J1.8 to U1.1…U1.8 (a 2×5 header numbers its pins across the rows, so neighbours swap).
  for (let i = 1; i <= 8; i++) await wire(p, `IO${i}`, `U1.${i}`, `J1.${i}`);
  await wire(p, 'VCC', 'J1.9', 'U1.9', 'U1.25', 'U2.8', 'R1.2', 'R2.2', 'C1.1', 'C2.1');
  await wire(p, 'GND', 'J1.10', 'U1.33', 'U1.16', 'U2.4', 'C1.2', 'C2.2', 'D1.1', 'J2.6');
  // Right header, reversed: J2.1…J2.5 to U1.21…U1.17.
  for (let i = 1; i <= 5; i++) await wire(p, `P${i}`, `J2.${i}`, `U1.${22 - i}`);
  await wire(p, 'SDA', 'U1.28', 'U2.5', 'R1.1');
  await wire(p, 'SCL', 'U1.29', 'U2.6', 'R2.1');
  await wire(p, 'LED', 'U1.12', 'R3.1');
  await wire(p, 'LEDK', 'R3.2', 'D1.2');
  await finish(p, { x: 100, y: 100, width: 44, height: 34 }, [
    ['U1', 122, 118], ['J1', 106, 113], ['J2', 139, 111], ['U2', 122, 105, 90], ['R1', 128, 104, 90], ['R2', 130, 104, 90],
    ['C1', 117, 121, 90], ['C2', 126, 122], ['D1', 120, 129], ['R3', 124, 128],
  ]);
  await runTool(p, 'set_rule', { target: 'net#"GND"', rule: 'pourLayers', value: 'B.Cu' });
  return p;
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

/**
 * As `tee`, but net T is already joined J1.1–J2.1 by a hand-drawn trace that runs along the left edge of
 * the SMD pad R1.1 without ending in it or crossing its centre. Copper touches, but the connectivity check
 * (and so the ratsnest) does not count it as joined: the router must still route R1.1 (P8f: before, its
 * grid flood took the touching copper as one group and reported the connection as made).
 */
export async function fixtureGraze(): Promise<Project> {
  const p = newProject('fixture-graze');
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 20, y: 0 });
  await runTool(p, 'add_part', { kind: 'resistor', value: '1k', x: 40, y: 0 });
  await wire(p, 'T', 'J1.1', 'J2.1', 'R1.1');
  await wire(p, 'U', 'J1.2', 'J2.2', 'R1.2');
  await finish(p, { x: 100, y: 100, width: 40, height: 20 }, [['J1', 104, 108], ['J2', 136, 108], ['R1', 120, 113]]);
  const net = [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === 'T')!;
  const pads = collectCopper(p.doc, p.engine, p.copper).filter((s) => s.kind === 'pad' && s.net === 'T' && s.layer === 'F.Cu');
  const mid = (b: { minX: number; minY: number; maxX: number; maxY: number }) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  const tht = pads.filter((s) => pads.filter((o) => o.uid === s.uid).length === 1 && collectCopper(p.doc, p.engine, p.copper).some((o) => o.uid === s.uid && o.layer === 'B.Cu'));
  const smd = pads.find((s) => !tht.includes(s))!;
  const [a, b] = tht.map((s) => mid(s.box)).sort((u, v) => u.x - v.x) as [Vec2, Vec2];
  const x0 = smd.box.minX;
  const pts: Vec2[] = [a, { x: x0, y: a.y }, { x: x0, y: smd.box.maxY + 2.5 }, { x: b.x + 2.5, y: smd.box.maxY + 2.5 }, { x: b.x + 2.5, y: b.y }, b];
  const ops: Op[] = [];
  for (let k = 0; k + 1 < pts.length; k++)
    ops.push({ op: 'add', parent: net.uid, index: net.children.length + k, tree: { nodes: [{ uid: `trgraze${k}`, type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: pts[k]! }, { name: 'end', value: pts[k + 1]! }, { name: 'layer', value: 'F.Cu' }], parent: net.uid, children: [] }] } });
  p.history.apply('Graze trace', ops);
  return p;
}

/**
 * A GND pour on B.Cu, cut by net T's hand-drawn B.Cu trace that runs right under the straight line between
 * the two pads of net S. Routed straight on F.Cu, S runs over the slot in its reference plane for most of
 * its length; with a plane-gap cost (P8f) it moves off the slot.
 */
export async function fixturePlaneSlot(): Promise<Project> {
  const p = newProject('fixture-plane-slot');
  for (let i = 0; i < 5; i++) await runTool(p, 'add_part', { kind: 'connector', pins: 1, x: i * 15, y: 0 });
  await wire(p, 'S', 'J1.1', 'J2.1');
  await wire(p, 'T', 'J3.1', 'J4.1');
  await wire(p, 'GND', 'J5.1');
  await finish(p, { x: 100, y: 100, width: 40, height: 20 }, [['J1', 104, 110], ['J2', 136, 110], ['J3', 112, 104], ['J4', 128, 104], ['J5', 120, 117]]);
  await runTool(p, 'set_rule', { target: 'net#"GND"', rule: 'pourLayers', value: 'B.Cu' });
  const net = [...p.doc.nodes.values()].find((n) => n.type === 'net' && n.name === 'T')!;
  const pts: Vec2[] = [{ x: 112, y: 104 }, { x: 112, y: 110 }, { x: 128, y: 110 }, { x: 128, y: 104 }];
  const ops: Op[] = [];
  for (let k = 0; k + 1 < pts.length; k++)
    ops.push({ op: 'add', parent: net.uid, index: net.children.length + k, tree: { nodes: [{ uid: `trslot${k}`, type: 'trace', name: '', props: {}, rules: [{ name: 'start', value: pts[k]! }, { name: 'end', value: pts[k + 1]! }, { name: 'layer', value: 'B.Cu' }], parent: net.uid, children: [] }] } });
  p.history.apply('Slot trace', ops);
  return p;
}

/** Extra `autoroute` arguments per fixture. */
/**
 * Differential pairs (P10): a USB 2.0 pair and a 100 Ω pair between two 1 × 6 headers set apart and
 * offset, so the pairs must turn; a 0.8 mm board, so the pair widths stay modest. Classes applied.
 */
export async function fixturePairs(): Promise<Project> {
  const p = newProject('fixture-pairs');
  await runTool(p, 'add_part', { kind: 'connector', pins: 6, x: 0, y: 0 });
  await runTool(p, 'add_part', { kind: 'connector', pins: 6, x: 40, y: 0 });
  await wire(p, 'USB_P', 'J1.1', 'J2.1');
  await wire(p, 'USB_N', 'J1.2', 'J2.2');
  await wire(p, 'S1', 'J1.3', 'J2.3');
  await wire(p, 'LV_P', 'J1.4', 'J2.4');
  await wire(p, 'LV_N', 'J1.5', 'J2.5');
  await wire(p, 'S2', 'J1.6', 'J2.6');
  await finish(p, { x: 100, y: 100, width: 40, height: 34 }, [['J1', 106, 113], ['J2', 134, 121]]);
  await runTool(p, 'set_stackup', { thickness: 0.8 });
  await runTool(p, 'set_pin_signal', { target: 'USB_P', net: true, interface: 'usb2' });
  await runTool(p, 'set_pin_signal', { target: 'LV_P', net: true, interface: 'lvds' });
  await runTool(p, 'classify_nets', { apply: true });
  return p;
}

export const FIXTURE_ARGS: Record<string, Record<string, unknown>> = { channel: { layers: ['F.Cu'] } };

export const ROUTE_FIXTURES = { 'qfn-escape': fixtureQfnEscape, 'qfn-fine': fixtureQfnFine, 'reversed-bus': fixtureReversedBus, 'off-grid': fixtureOffGrid, tee: fixtureTee, channel: fixtureChannel, graze: fixtureGraze, 'plane-slot': fixturePlaneSlot, bus: fixtureBus, mcu: fixtureMcu, pairs: fixturePairs } as const;
