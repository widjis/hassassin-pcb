/**
 * Electrical rule check on the schematic netlist. Our own rule set:
 *   - pin left unconnected (unless marked with a no-connect),
 *   - no-connect marker on a pin that is connected,
 *   - two outputs (or power outputs) driving one net,
 *   - power-input pins on a net with no power source (power output, power flag),
 *   - wire ends touching nothing,
 *   - labels not attached to anything,
 *   - duplicate reference designators.
 */
import type { Doc, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import type { Severity } from './drc.ts';
import { dist, distToSegment } from './geom.ts';
import { extractNetlist, noConnectPins, type Netlist } from './netlist.ts';
import { allSheets, pinPoint, sheetItems } from './schematic.ts';

export type ErcKind = 'unconnectedPin' | 'noConnectConnected' | 'driverConflict' | 'powerNotDriven' | 'danglingWire' | 'danglingLabel' | 'duplicateRef';

export const ERC_LABEL: Record<ErcKind, string> = {
  unconnectedPin: 'Pin not connected',
  noConnectConnected: 'No-connect on a connected pin',
  driverConflict: 'Outputs driving each other',
  powerNotDriven: 'Power input not driven',
  danglingWire: 'Wire end not connected',
  danglingLabel: 'Label not connected',
  duplicateRef: 'Duplicate reference',
};

export interface ErcViolation {
  id: string;
  kind: ErcKind;
  severity: Severity;
  message: string;
  /** Sheet the marker belongs to, and where. */
  sheet: string;
  at: Vec2;
  uids: string[];
  net?: string;
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const EPS = 1e-3;

export function runErc(doc: Doc, engine: StyleEngine, netlist?: Netlist): { violations: ErcViolation[]; netlist: Netlist } {
  const nl = netlist ?? extractNetlist(doc, engine);
  const out: ErcViolation[] = [];
  const nc = noConnectPins(doc, engine);
  const sheetOfPin = new Map<string, string>();
  const pointOf = new Map<string, Vec2>();
  for (const sheet of allSheets(doc)) {
    for (const n of sheetItems(doc, sheet)) {
      if (n.type !== 'pin') continue;
      sheetOfPin.set(n.uid, sheet.uid);
      const p = pinPoint(doc, engine, n);
      if (p) pointOf.set(n.uid, p);
    }
  }
  const at = (pinUid: string) => pointOf.get(pinUid) ?? { x: 0, y: 0 };

  for (const net of nl.nets) {
    const real = net.items.length > 0 || net.pins.length > 1;
    for (const p of net.pins) {
      const marked = nc.has(p.pinUid);
      if (!real && !marked && p.pinType !== 'no_connect' && p.pinType !== 'unconnected') {
        out.push({ id: `unc:${p.pinUid}`, kind: 'unconnectedPin', severity: 'error', message: `${p.ref} pin ${p.pin}${p.pinName && p.pinName !== '~' ? ` (${p.pinName})` : ''} is not connected`, sheet: sheetOfPin.get(p.pinUid) ?? '', at: at(p.pinUid), uids: [p.symbolUid, p.pinUid] });
      }
      if (real && marked) {
        out.push({ id: `ncc:${p.pinUid}`, kind: 'noConnectConnected', severity: 'warning', message: `${p.ref} pin ${p.pin} has a no-connect marker but is connected to ${net.name}`, sheet: sheetOfPin.get(p.pinUid) ?? '', at: at(p.pinUid), uids: [p.symbolUid, p.pinUid], net: net.name });
      }
    }
    const outputs = net.pins.filter((p) => p.pinType === 'output' || p.pinType === 'power_out');
    if (outputs.length > 1) {
      const p = outputs[1]!;
      out.push({ id: `drv:${net.name}`, kind: 'driverConflict', severity: 'error', message: `${outputs.map((o) => `${o.ref}.${o.pin}`).join(', ')} all drive ${net.name}`, sheet: sheetOfPin.get(p.pinUid) ?? '', at: at(p.pinUid), uids: outputs.map((o) => o.symbolUid), net: net.name });
    }
    const powerIn = net.pins.filter((p) => p.pinType === 'power_in');
    if (powerIn.length && real) {
      const driven = net.pins.some((p) => p.pinType === 'power_out') || net.items.some((u) => doc.nodes.get(u)?.props.kind === 'flag');
      if (!driven) {
        const p = powerIn[0]!;
        out.push({ id: `pwr:${net.name}`, kind: 'powerNotDriven', severity: 'error', message: `${net.name} feeds power inputs (${powerIn.map((o) => `${o.ref}.${o.pin}`).slice(0, 4).join(', ')}) but nothing on it is a power source; add a power output or a power flag`, sheet: sheetOfPin.get(p.pinUid) ?? '', at: at(p.pinUid), uids: [p.symbolUid], net: net.name });
      }
    }
  }

  // Dangling wire ends and labels (per sheet, geometric).
  for (const sheet of allSheets(doc)) {
    const its = sheetItems(doc, sheet);
    const wires = its.filter((n) => n.type === 'wire').map((n) => ({ n, a: vec(engine.get(n.uid, 'start')?.value)!, b: vec(engine.get(n.uid, 'end')?.value)! })).filter((w) => w.a && w.b);
    const points: Vec2[] = [];
    for (const n of its) {
      if (n.type === 'pin') {
        const p = pointOf.get(n.uid);
        if (p) points.push(p);
      } else if (['label', 'junction', 'sheetPin', 'noconnect'].includes(n.type)) {
        const p = vec(engine.get(n.uid, 'position')?.value);
        if (p) points.push(p);
      }
    }
    for (const w of wires) {
      for (const end of [w.a, w.b]) {
        const touches = points.some((p) => dist(p, end) < EPS) || wires.some((v) => v !== w && distToSegment(end, v.a, v.b) < EPS);
        if (!touches) out.push({ id: `dw:${w.n.uid}:${end.x},${end.y}`, kind: 'danglingWire', severity: 'warning', message: 'Wire end is not connected to anything', sheet: sheet.uid, at: end, uids: [w.n.uid] });
      }
    }
    // Every connectable point on the sheet, tagged with its owner.
    const anchors: { uid: string; p: Vec2 }[] = [];
    for (const n of its) {
      const p = n.type === 'pin' ? pointOf.get(n.uid) : ['label', 'junction', 'sheetPin'].includes(n.type) ? vec(engine.get(n.uid, 'position')?.value) : undefined;
      if (p) anchors.push({ uid: n.uid, p });
    }
    for (const n of its) {
      if (n.type !== 'label' || n.props.kind === 'power' || n.props.kind === 'flag') continue;
      const p = vec(engine.get(n.uid, 'position')?.value);
      if (!p) continue;
      const touches = wires.some((w) => distToSegment(p, w.a, w.b) < EPS) || anchors.some((a) => a.uid !== n.uid && dist(p, a.p) < EPS);
      if (!touches) out.push({ id: `dl:${n.uid}`, kind: 'danglingLabel', severity: 'warning', message: `Label ${n.name} is not attached to a wire or pin`, sheet: sheet.uid, at: p, uids: [n.uid] });
    }
  }

  // Duplicate references (different symbols, same unit).
  const seen = new Map<string, string>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const key = `${n.props.ref ?? n.name}#${n.props.unit ?? 1}`;
    const prev = seen.get(key);
    if (prev) {
      const p = vec(engine.get(n.uid, 'position')?.value) ?? { x: 0, y: 0 };
      const sh = n.parent ? doc.nodes.get(n.parent) : undefined;
      out.push({ id: `dup:${n.uid}`, kind: 'duplicateRef', severity: 'error', message: `Reference ${n.props.ref ?? n.name} is used more than once`, sheet: sh?.type === 'sheet' ? sh.uid : '', at: p, uids: [prev, n.uid] });
    } else seen.set(key, n.uid);
  }
  return { violations: out, netlist: nl };
}
