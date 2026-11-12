/**
 * Netlist extraction from the schematic.
 *
 * On each sheet, wires, pins, labels, junctions and sheet pins are joined where they touch:
 *   - a wire end, pin, label or sheet pin lying on a wire (end or middle) joins that wire,
 *   - two wires that merely cross do not join unless a junction sits on the crossing,
 *   - coincident pins/labels/sheet pins join.
 * Across the design:
 *   - local and hierarchical labels with the same name join within one sheet,
 *   - global labels and power ports join everywhere by name,
 *   - a hierarchical label joins the matching sheet pin on its parent's sheet symbol.
 */
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { dist, distToSegment } from './geom.ts';
import { allSheets, pinPoint, sheetItems, sheetPath } from './schematic.ts';

export interface NetPin {
  ref: string;
  pin: string;
  pinName: string;
  pinType: string;
  pinUid: string;
  symbolUid: string;
}

export interface SchNet {
  name: string;
  /** How the name was chosen (for display). */
  named: 'global' | 'label' | 'auto';
  pins: NetPin[];
  /** Uids of wires, labels, junctions and sheet pins in the net. */
  items: string[];
}

export interface Netlist {
  nets: SchNet[];
  /** Lookup: `${ref}.${pin}` → net name. */
  byPin: Map<string, string>;
}

const EPS = 1e-3;

class DSU {
  p: number[] = [];
  add(): number {
    this.p.push(this.p.length);
    return this.p.length - 1;
  }
  find(i: number): number {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]!]!;
      i = this.p[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);

interface Item {
  id: number;
  node: DocNode;
  sheet: DocNode;
  kind: 'wire' | 'pin' | 'label' | 'junction' | 'sheetPin' | 'noconnect';
  a: Vec2;
  b?: Vec2;
}

export function extractNetlist(doc: Doc, engine: StyleEngine): Netlist {
  const dsu = new DSU();
  const items: Item[] = [];
  const byNode = new Map<string, Item>();

  for (const sheet of allSheets(doc)) {
    const local: Item[] = [];
    for (const n of sheetItems(doc, sheet)) {
      if (engine.get(n.uid, 'enabled')?.value === false) continue;
      let it: Item | null = null;
      if (n.type === 'wire') {
        const a = vec(engine.get(n.uid, 'start')?.value);
        const b = vec(engine.get(n.uid, 'end')?.value);
        if (a && b) it = { id: dsu.add(), node: n, sheet, kind: 'wire', a, b };
      } else if (n.type === 'pin') {
        const p = pinPoint(doc, engine, n);
        if (p) it = { id: dsu.add(), node: n, sheet, kind: 'pin', a: p };
      } else if (n.type === 'label' || n.type === 'junction' || n.type === 'sheetPin' || n.type === 'noconnect') {
        const p = vec(engine.get(n.uid, 'position')?.value);
        if (p) it = { id: dsu.add(), node: n, sheet, kind: n.type, a: p };
      }
      if (it) {
        items.push(it);
        local.push(it);
        byNode.set(n.uid, it);
      }
    }
    // Geometric connections within the sheet.
    const wires = local.filter((i) => i.kind === 'wire');
    const points = local.filter((i) => i.kind !== 'wire' && i.kind !== 'noconnect');
    const onWire = (p: Vec2, w: Item) => distToSegment(p, w.a, w.b!) < EPS;
    for (let i = 0; i < wires.length; i++) {
      const w = wires[i]!;
      for (let j = i + 1; j < wires.length; j++) {
        const v = wires[j]!;
        if (onWire(v.a, w) || onWire(v.b!, w) || onWire(w.a, v) || onWire(w.b!, v)) dsu.union(w.id, v.id);
      }
      for (const p of points) if (onWire(p.a, w)) dsu.union(w.id, p.id);
    }
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        if (dist(points[i]!.a, points[j]!.a) < EPS) dsu.union(points[i]!.id, points[j]!.id);
      }
    }
    // Local and hierarchical labels with the same name on this sheet.
    const byName = new Map<string, number>();
    for (const l of local) {
      const k = l.node.props.kind ?? 'local';
      if (l.kind !== 'label' || (k !== 'local' && k !== 'hier')) continue;
      const prev = byName.get(l.node.name);
      if (prev === undefined) byName.set(l.node.name, l.id);
      else dsu.union(prev, l.id);
    }
  }

  // Global labels / power ports by name.
  const globals = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== 'label') continue;
    const kind = it.node.props.kind;
    if (kind !== 'global' && kind !== 'power') continue;
    const prev = globals.get(it.node.name);
    if (prev === undefined) globals.set(it.node.name, it.id);
    else dsu.union(prev, it.id);
  }
  // Hierarchical labels ↔ sheet pins of the block that holds the sheet.
  for (const it of items) {
    if (it.kind !== 'label' || it.node.props.kind !== 'hier') continue;
    const block = it.sheet.parent ? doc.nodes.get(it.sheet.parent) : undefined;
    if (!block || block.type !== 'block') continue;
    for (const c of block.children) {
      const sp = doc.nodes.get(c);
      if (sp?.type === 'sheetPin' && sp.name === it.node.name) {
        const spi = byNode.get(sp.uid);
        if (spi) dsu.union(spi.id, it.id);
      }
    }
  }

  // Collect nets.
  const groups = new Map<number, Item[]>();
  for (const it of items) {
    if (it.kind === 'noconnect' || it.kind === 'junction') continue;
    const r = dsu.find(it.id);
    const g = groups.get(r) ?? [];
    g.push(it);
    groups.set(r, g);
  }
  const nets: SchNet[] = [];
  const usedNames = new Map<string, number>();
  for (const g of groups.values()) {
    const pins: NetPin[] = [];
    for (const it of g) {
      if (it.kind !== 'pin') continue;
      const sym = it.node.parent ? doc.nodes.get(it.node.parent) : undefined;
      if (!sym) continue;
      pins.push({
        ref: String(sym.props.ref ?? sym.name),
        pin: String(it.node.props.number ?? it.node.name),
        pinName: String(it.node.props.pinName ?? ''),
        pinType: String(it.node.props.pinType ?? 'passive'),
        pinUid: it.node.uid,
        symbolUid: sym.uid,
      });
    }
    // Name: global/power label > shallowest local label > automatic.
    let name = '';
    let named: SchNet['named'] = 'auto';
    const glob = g.filter((i) => i.kind === 'label' && (i.node.props.kind === 'global' || i.node.props.kind === 'power')).map((i) => i.node.name).sort();
    if (glob.length) {
      name = glob[0]!;
      named = 'global';
    } else {
      const labels = g
        .filter((i) => i.kind === 'label' && (i.node.props.kind ?? 'local') === 'local')
        .map((i) => sheetPath(doc, i.sheet) + i.node.name)
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      if (labels.length) {
        name = labels[0]!;
        named = 'label';
      } else {
        // Then a hierarchical label (as KiCad does): /Filter/IN for the IN label inside sheet Filter.
        const hier = g
          .filter((i) => i.kind === 'label' && i.node.props.kind === 'hier')
          .map((i) => sheetPath(doc, i.sheet) + i.node.name)
          .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
        if (hier.length) {
          name = hier[0]!;
          named = 'label';
        }
      }
    }
    if (!name) {
      if (!pins.length) continue; // wire fragments with nothing on them
      // As KiCad names them: a pin with a real name first (U1-SW1 over C3-Pad2), then the first
      // reference (D2-K over U2-D1, whatever the pin types), then the pin number.
      const named = (x: NetPin) => !!x.pinName && x.pinName !== '~' && x.pinName !== x.pin;
      const p = [...pins].sort((a, b) => Number(named(b)) - Number(named(a)) || a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.pin.localeCompare(b.pin, undefined, { numeric: true }))[0]!;
      const hasName = named(p);
      // A "/" in a pin name would read as a sheet separator, so KiCad writes it as {slash}.
      const pn = hasName ? p.pinName.replace(/\//g, '{slash}') : `Pad${p.pin}`;
      name = pins.length === 1 ? `unconnected-(${p.ref}-${hasName ? `${pn}-Pad${p.pin}` : `Pad${p.pin}`})` : `Net-(${p.ref}-${pn})`;
    }
    const n = usedNames.get(name) ?? 0;
    usedNames.set(name, n + 1);
    if (n) name = `${name}_${n}`;
    nets.push({ name, named, pins, items: g.filter((i) => i.kind !== 'pin').map((i) => i.node.uid) });
  }
  nets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const byPin = new Map<string, string>();
  for (const n of nets) for (const p of n.pins) byPin.set(`${p.ref}.${p.pin}`, n.name);
  return { nets, byPin };
}

/** Pin connection points of pins that have a no-connect marker on them. */
export function noConnectPins(doc: Doc, engine: StyleEngine): Set<string> {
  const out = new Set<string>();
  for (const sheet of allSheets(doc)) {
    const its = sheetItems(doc, sheet);
    const ncs = its.filter((n) => n.type === 'noconnect').map((n) => vec(engine.get(n.uid, 'position')?.value)).filter((p): p is Vec2 => !!p);
    if (!ncs.length) continue;
    for (const n of its) {
      if (n.type !== 'pin') continue;
      const p = pinPoint(doc, engine, n);
      if (p && ncs.some((q) => dist(p, q) < EPS)) out.add(n.uid);
    }
  }
  return out;
}
