/**
 * Schematic → PCB update. The schematic is the source of truth for connectivity:
 *   - every pad of a component that is in the schematic takes its net from the netlist,
 *   - PCB nets are renamed when their pads all moved to a new name (so routed copper
 *     follows), created when missing, and removed when empty,
 *   - components only in the schematic get their footprint (from the library) next to the
 *     board, or a placeholder when the footprint is not known,
 *   - a component whose footprint changed in the schematic (or that still has a
 *     placeholder) is rebuilt in place with the new footprint, keeping position/rotation,
 *   - part properties (value, MPN, manufacturer…) are copied onto the component,
 *   - components only on the PCB are reported, never deleted.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';
import type { StyleEngine } from './style.ts';
import type { Netlist } from './netlist.ts';
import { emptyBox, growBox } from './geom.ts';
import { boardOutline } from './copper.ts';
import { footprintNodes, type FootprintSpec } from './footprints.ts';

/** Properties copied from schematic symbols onto PCB components. */
export const SYNCED_PROPS = ['Value', 'MPN', 'Manufacturer', 'LCSC', 'Datasheet', 'partId'] as const;

export interface SyncReport {
  padChanges: number;
  netsCreated: string[];
  netsRenamed: [string, string][];
  netsRemoved: string[];
  orphanNets: string[];
  componentsAdded: string[];
  onlyOnPcb: string[];
  missingPads: string[];
  footprintsChanged: string[];
  /** Footprint names that could not be found (those parts keep or get a placeholder). */
  footprintsMissing: string[];
  propChanges: number;
}

export interface SyncOptions {
  resolveFootprint?: (name: string) => FootprintSpec | null;
  copper?: string[];
}

function netClassOf(name: string): string | undefined {
  const base = name.split('/').pop() ?? name;
  if (/^(A|D|P|S)?GND|^VSS|^0V$/i.test(base)) return 'ground';
  if (/^(\+|-)?\d+V\d*|^V(CC|DD|IN|BAT|BUS|SYS|OUT|LOGIC)|^VBAT|^PWR|^\+/i.test(base)) return 'power';
  return undefined;
}

interface SymInfo {
  ref: string;
  value: string;
  footprint: string;
  props: Record<string, string>;
  pins: { number: string; name: string }[];
}

function symbolsByRef(doc: Doc): Map<string, SymInfo> {
  const out = new Map<string, SymInfo>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' || n.props.power) continue;
    const ref = String(n.props.ref ?? n.name);
    const info = out.get(ref) ?? { ref, value: String(n.props.Value ?? ''), footprint: String(n.props.Footprint ?? ''), props: {}, pins: [] };
    for (const k of SYNCED_PROPS) if (n.props[k] !== undefined && n.props[k] !== '' && info.props[k] === undefined) info.props[k] = String(n.props[k]);
    for (const c of n.children) {
      const p = doc.nodes.get(c);
      if (p?.type === 'pin') info.pins.push({ number: String(p.props.number ?? p.name), name: String(p.props.pinName ?? '') });
    }
    out.set(ref, info);
  }
  return out;
}

/** A simple stand-in footprint until a real one is chosen (Phase 5). */
function placeholderFootprint(info: SymInfo, origin: Vec2, netOf: (pin: string) => string | null): DocNode[] {
  const uid = newUid('el');
  const nodes: DocNode[] = [];
  const pins = [...new Map(info.pins.map((p) => [p.number, p])).values()].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  const pad = (number: string, x: number, y: number, w: number, h: number): DocNode => {
    const net = netOf(number);
    return {
      uid: newUid('pad'),
      type: 'pad',
      name: number,
      props: { number, ...(net ? { net } : {}) },
      rules: [
        { name: 'position', value: { x, y } },
        { name: 'size', value: { x: w, y: h } },
        { name: 'padShape', value: 'roundrect' },
        { name: 'layers', value: ['F.Cu', 'F.Paste', 'F.Mask'] },
      ],
      parent: uid,
      children: [],
    };
  };
  const padNodes: DocNode[] = [];
  let hw = 1.5;
  let hh = 1;
  if (pins.length <= 2) {
    pins.forEach((p, i) => padNodes.push(pad(p.number, i === 0 ? -1 : 1, 0, 1, 1.25)));
    hw = 1.8;
    hh = 1;
  } else {
    const perSide = Math.ceil(pins.length / 2);
    const pitch = 1.27;
    const rowX = 2.7;
    pins.forEach((p, i) => {
      const left = i < perSide;
      const k = left ? i : i - perSide;
      const y = left ? (k - (perSide - 1) / 2) * pitch : ((perSide - 1) / 2 - k) * pitch;
      padNodes.push(pad(p.number, left ? -rowX : rowX, y, 1.5, 0.6));
    });
    hw = 3.8;
    hh = (perSide * pitch) / 2 + 0.6;
  }
  const silk: DocNode = {
    uid: newUid('gr'),
    type: 'rectangle',
    name: '',
    props: {},
    rules: [
      { name: 'layer', value: 'F.SilkS' },
      { name: 'points', value: [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }] },
      { name: 'strokeWidth', value: 0.12 },
    ],
    parent: uid,
    children: [],
  };
  const text: DocNode = {
    uid: newUid('tx'),
    type: 'text',
    name: info.ref,
    props: {},
    rules: [
      { name: 'layer', value: 'F.SilkS' },
      { name: 'position', value: { x: 0, y: -hh - 0.9 } },
      { name: 'text', value: info.ref },
      { name: 'fontSize', value: 0.8 },
    ],
    parent: uid,
    children: [],
  };
  const el: DocNode = {
    uid,
    type: 'element',
    name: info.ref,
    props: { Value: info.value, Footprint: info.footprint || '(placeholder)', placeholder: true },
    rules: [
      { name: 'position', value: origin },
      { name: 'rotation', value: 0 },
      { name: 'side', value: 'top' },
    ],
    parent: null,
    children: [...padNodes.map((p) => p.uid), silk.uid, text.uid],
  };
  nodes.push(el, ...padNodes, silk, text);
  return nodes;
}

const fpBase = (s: string) => s.split(':').pop() ?? s;

export function planSync(doc: Doc, engine: StyleEngine, netlist: Netlist, opts: SyncOptions = {}): { ops: Op[]; report: SyncReport } {
  const report: SyncReport = { padChanges: 0, netsCreated: [], netsRenamed: [], netsRemoved: [], orphanNets: [], componentsAdded: [], onlyOnPcb: [], missingPads: [], footprintsChanged: [], footprintsMissing: [], propChanges: 0 };
  const resolved = new Map<string, FootprintSpec | null>();
  const resolve = (name: string): FootprintSpec | null => {
    if (!name || !opts.resolveFootprint) return null;
    if (!resolved.has(name)) {
      const fp = opts.resolveFootprint(name);
      resolved.set(name, fp);
      if (!fp && !report.footprintsMissing.includes(name)) report.footprintsMissing.push(name);
    }
    return resolved.get(name)!;
  };
  const ops: Op[] = [];
  const layout = [...doc.nodes.values()].find((n) => n.type === 'layout');
  if (!layout) return { ops, report };
  const container = (name: string) => layout.children.map((c) => doc.nodes.get(c)!).find((n) => n?.type === 'container' && n.name === name);
  const comps = container('Components');
  const netsC = container('Nets');
  if (!comps || !netsC) return { ops, report };

  const syms = symbolsByRef(doc);
  const elements = new Map<string, DocNode>();
  for (const c of comps.children) {
    const n = doc.nodes.get(c);
    if (n?.type === 'element') elements.set(n.name, n);
  }
  const want = (ref: string, pin: string) => netlist.byPin.get(`${ref}.${pin}`) ?? null;

  // 1) Pad nets. Track old → new name votes to rename nets in place.
  const votes = new Map<string, Map<string, number>>();
  const padsOnNet = new Map<string, number>(); // final pad count per new name
  for (const [ref, el] of elements) {
    if (!syms.has(ref)) {
      report.onlyOnPcb.push(ref);
      for (const c of el.children) {
        const p = doc.nodes.get(c);
        if (p?.type === 'pad' && p.props.net) padsOnNet.set(String(p.props.net), (padsOnNet.get(String(p.props.net)) ?? 0) + 1);
      }
      continue;
    }
    const sym = syms.get(ref)!;
    // Properties from the schematic.
    for (const [k, v] of Object.entries(sym.props)) {
      if (String(el.props[k] ?? '') !== v) {
        ops.push({ op: 'setProp', uid: el.uid, key: k, value: v });
        report.propChanges++;
      }
    }
    // Footprint swap: placeholder, or the schematic names a different footprint.
    const differs = sym.footprint && fpBase(String(el.props.Footprint ?? '')) !== fpBase(sym.footprint);
    if (el.props.placeholder || differs) {
      const fp = resolve(sym.footprint);
      if (fp) {
        const parent = el.parent ? doc.nodes.get(el.parent) : undefined;
        const nodes = footprintNodes(fp, { uid: el.uid, ref, value: sym.value, copper: opts.copper, netOf: (pin) => want(ref, pin) });
        const root = nodes[0]!;
        root.rules = el.rules.filter((r) => ['position', 'rotation', 'side'].includes(r.name) || !root.rules.some((x) => x.name === r.name)).concat(root.rules.filter((r) => !el.rules.some((x) => x.name === r.name)));
        const { placeholder: _ph, ...keep } = el.props;
        root.props = { ...keep, ...sym.props, Footprint: sym.footprint };
        ops.push({ op: 'remove', uid: el.uid }, { op: 'add', parent: el.parent!, index: parent ? parent.children.indexOf(el.uid) : 0, tree: { nodes } });
        report.footprintsChanged.push(ref);
        const pads = new Set<string>();
        for (const n of nodes) {
          if (n.type !== 'pad') continue;
          pads.add(String(n.props.number));
          if (n.props.net) padsOnNet.set(String(n.props.net), (padsOnNet.get(String(n.props.net)) ?? 0) + 1);
        }
        // Old pads' nets still vote, so routed copper is renamed rather than orphaned.
        for (const c of el.children) {
          const p = doc.nodes.get(c);
          const cur = p?.type === 'pad' && typeof p.props.net === 'string' ? p.props.net : null;
          const next = p ? want(ref, String(p.props.number ?? p.name)) : null;
          if (cur && next) {
            const v = votes.get(cur) ?? new Map<string, number>();
            v.set(next, (v.get(next) ?? 0) + 1);
            votes.set(cur, v);
          }
        }
        for (const pin of sym.pins) if (!pads.has(pin.number)) report.missingPads.push(`${ref}.${pin.number}`);
        continue;
      }
    }
    const padNumbers = new Set<string>();
    for (const c of el.children) {
      const p = doc.nodes.get(c);
      if (p?.type !== 'pad') continue;
      const num = String(p.props.number ?? p.name);
      padNumbers.add(num);
      const cur = typeof p.props.net === 'string' && p.props.net ? p.props.net : null;
      const next = num ? want(ref, num) : cur; // unnumbered (mechanical) pads keep their net
      if (next) padsOnNet.set(next, (padsOnNet.get(next) ?? 0) + 1);
      if (cur && next) {
        const v = votes.get(cur) ?? new Map<string, number>();
        v.set(next, (v.get(next) ?? 0) + 1);
        votes.set(cur, v);
      }
      if (cur !== next) {
        ops.push({ op: 'setProp', uid: p.uid, key: 'net', value: next });
        report.padChanges++;
      }
    }
    for (const pin of sym.pins) if (!padNumbers.has(pin.number)) report.missingPads.push(`${ref}.${pin.number}`);
  }

  // 2) New components (placed in a column left of the board).
  const box = emptyBox();
  for (const el of elements.values()) {
    const p = engine.get(el.uid, 'position')?.value as Vec2 | undefined;
    if (p) growBox(box, p.x, p.y);
  }
  // Include the board outline, so a fresh board gets its parts parked right next to it.
  for (const loop of boardOutline(doc, engine).loops) for (const p of loop) growBox(box, p.x, p.y);
  let slot = 0;
  const left = Number.isFinite(box.minX) ? box.minX - 12 : 0;
  const top = Number.isFinite(box.minY) ? box.minY : 0;
  for (const [ref, info] of syms) {
    if (elements.has(ref)) continue;
    const origin = { x: left - Math.floor(slot / 12) * 12, y: top + (slot % 12) * 8 };
    slot++;
    const fp = resolve(info.footprint);
    const nodes = fp
      ? footprintNodes(fp, { ref, value: info.value, copper: opts.copper, props: { ...info.props, Footprint: info.footprint }, position: origin, netOf: (pin) => want(ref, pin) })
      : placeholderFootprint(info, origin, (pin) => want(ref, pin));
    if (!fp) for (const [k, v] of Object.entries(info.props)) nodes[0]!.props[k] = v;
    if (fp) {
      const pads = new Set(nodes.filter((n) => n.type === 'pad').map((n) => String(n.props.number)));
      for (const pin of info.pins) if (!pads.has(pin.number)) report.missingPads.push(`${ref}.${pin.number}`);
    }
    nodes[0]!.parent = comps.uid;
    ops.push({ op: 'add', parent: comps.uid, index: comps.children.length + slot, tree: { nodes } });
    for (const n of nodes) if (n.type === 'pad' && n.props.net) padsOnNet.set(String(n.props.net), (padsOnNet.get(String(n.props.net)) ?? 0) + 1);
    report.componentsAdded.push(ref);
  }

  // 3) Net objects: rename, create, remove.
  const existing = new Map<string, DocNode>();
  for (const c of netsC.children) {
    const n = doc.nodes.get(c);
    if (n?.type === 'net') existing.set(n.name, n);
  }
  const taken = new Set<string>();
  for (const name of padsOnNet.keys()) if (existing.has(name)) taken.add(name);
  for (const [old, v] of votes) {
    const node = existing.get(old);
    if (!node || padsOnNet.has(old)) continue;
    const [best] = [...v.entries()].sort((a, b) => b[1] - a[1]);
    if (!best || taken.has(best[0])) continue;
    ops.push({ op: 'setName', uid: node.uid, name: best[0] });
    const cls = netClassOf(best[0]);
    if (cls !== node.props.netClass) ops.push({ op: 'setProp', uid: node.uid, key: 'netClass', value: cls ?? null });
    taken.add(best[0]);
    report.netsRenamed.push([old, best[0]]);
    existing.delete(old);
  }
  let idx = netsC.children.length;
  for (const name of padsOnNet.keys()) {
    if (taken.has(name)) continue;
    const cls = netClassOf(name);
    ops.push({ op: 'add', parent: netsC.uid, index: idx++, tree: { nodes: [{ uid: newUid('net'), type: 'net', name, props: cls ? { netClass: cls } : {}, rules: [], parent: netsC.uid, children: [] }] } });
    report.netsCreated.push(name);
  }
  for (const [name, node] of existing) {
    if (padsOnNet.has(name) || name === '(no net)') continue;
    if (node.children.length) report.orphanNets.push(name);
    else {
      ops.push({ op: 'remove', uid: node.uid });
      report.netsRemoved.push(name);
    }
  }
  return { ops, report };
}
