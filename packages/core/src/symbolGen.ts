/**
 * Built-in schematic symbols for quick part placement (our own simple drawings).
 * Coordinates are symbol-local, millimetres, Y down; pins sit on a 2.54 mm grid.
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import { newUid } from './model.ts';

export type SymGraphicSpec =
  | { t: 'poly'; pts: Vec2[]; fill: boolean; w: number }
  | { t: 'rect'; a: Vec2; b: Vec2; fill: boolean; w: number }
  | { t: 'circle'; c: Vec2; r: number; fill: boolean; w: number }
  | { t: 'arc'; s: Vec2; m: Vec2; e: Vec2; w: number }
  | { t: 'text'; at: Vec2; text: string; size: number };

export interface PinSpec {
  number: string;
  name: string;
  type: string;
  /** Connection point. */
  at: Vec2;
  /** Direction from the connection point toward the body, degrees (0 = +X, 90 = up). */
  angle: number;
  length: number;
  hidden?: boolean;
  /** What the pin needs on the board (signal class, PCB agreement P16), e.g. rf or switching. */
  signal?: string;
}

export interface SymbolSpec {
  prefix: string;
  value: string;
  graphics: SymGraphicSpec[];
  pins: PinSpec[];
  footprint?: string;
}

export type PartKind = 'resistor' | 'capacitor' | 'inductor' | 'diode' | 'led' | 'connector' | 'ic';

export const PART_KINDS: { kind: PartKind; label: string; prefix: string }[] = [
  { kind: 'resistor', label: 'Resistor', prefix: 'R' },
  { kind: 'capacitor', label: 'Capacitor', prefix: 'C' },
  { kind: 'inductor', label: 'Inductor', prefix: 'L' },
  { kind: 'diode', label: 'Diode', prefix: 'D' },
  { kind: 'led', label: 'LED', prefix: 'D' },
  { kind: 'connector', label: 'Connector', prefix: 'J' },
  { kind: 'ic', label: 'IC (generic)', prefix: 'U' },
];

const W = 0.254;
const twoPin = (a = '1', b = '2'): PinSpec[] => [
  { number: a, name: '', type: 'passive', at: { x: 0, y: -3.81 }, angle: 270, length: 1.27 },
  { number: b, name: '', type: 'passive', at: { x: 0, y: 3.81 }, angle: 90, length: 1.27 },
];

export function makeSymbol(kind: PartKind, opts: { pins?: number; value?: string; pinNames?: string[] } = {}): SymbolSpec {
  switch (kind) {
    case 'resistor':
      return { prefix: 'R', value: opts.value ?? '10k', pins: twoPin(), graphics: [{ t: 'rect', a: { x: -0.9, y: -2.54 }, b: { x: 0.9, y: 2.54 }, fill: false, w: W }] };
    case 'capacitor':
      return {
        prefix: 'C',
        value: opts.value ?? '100n',
        pins: [
          { number: '1', name: '', type: 'passive', at: { x: 0, y: -3.81 }, angle: 270, length: 3.3 },
          { number: '2', name: '', type: 'passive', at: { x: 0, y: 3.81 }, angle: 90, length: 3.3 },
        ],
        graphics: [
          { t: 'poly', pts: [{ x: -1.8, y: -0.5 }, { x: 1.8, y: -0.5 }], fill: false, w: 0.4 },
          { t: 'poly', pts: [{ x: -1.8, y: 0.5 }, { x: 1.8, y: 0.5 }], fill: false, w: 0.4 },
        ],
      };
    case 'inductor': {
      const g: SymGraphicSpec[] = [];
      for (let i = 0; i < 4; i++) {
        const cy = -1.905 + i * 1.27;
        const pts = Array.from({ length: 9 }, (_, k) => {
          const a = -Math.PI / 2 + (k / 8) * Math.PI;
          return { x: Math.cos(a) * 0.9, y: cy + Math.sin(a) * 0.635 };
        });
        g.push({ t: 'poly', pts, fill: false, w: W });
      }
      return { prefix: 'L', value: opts.value ?? '10u', pins: twoPin(), graphics: g };
    }
    case 'diode':
    case 'led': {
      const g: SymGraphicSpec[] = [
        { t: 'poly', pts: [{ x: -1.27, y: -1.0 }, { x: 1.27, y: -1.0 }, { x: 0, y: 1.0 }, { x: -1.27, y: -1.0 }], fill: false, w: W },
        { t: 'poly', pts: [{ x: -1.27, y: 1.0 }, { x: 1.27, y: 1.0 }], fill: false, w: W },
      ];
      if (kind === 'led') {
        g.push({ t: 'poly', pts: [{ x: 1.6, y: -0.6 }, { x: 2.6, y: -1.4 }], fill: false, w: W }, { t: 'poly', pts: [{ x: 1.6, y: 0.2 }, { x: 2.6, y: -0.6 }], fill: false, w: W });
      }
      return {
        prefix: 'D',
        value: opts.value ?? (kind === 'led' ? 'LED' : 'D'),
        graphics: g,
        pins: [
          { number: '2', name: 'A', type: 'passive', at: { x: 0, y: -3.81 }, angle: 270, length: 2.81 },
          { number: '1', name: 'K', type: 'passive', at: { x: 0, y: 3.81 }, angle: 90, length: 2.81 },
        ],
      };
    }
    case 'connector': {
      const n = Math.max(1, Math.min(64, opts.pins ?? 4));
      const pins: PinSpec[] = [];
      for (let i = 0; i < n; i++) pins.push({ number: String(i + 1), name: opts.pinNames?.[i] ?? `Pin_${i + 1}`, type: 'passive', at: { x: -5.08, y: (i - (n - 1) / 2) * 2.54 }, angle: 0, length: 3.81 });
      const h = (n * 2.54) / 2 + 1.27;
      return { prefix: 'J', value: opts.value ?? `Conn_${n}`, pins, graphics: [{ t: 'rect', a: { x: -1.27, y: -h }, b: { x: 1.27, y: h }, fill: false, w: W }] };
    }
    case 'ic': {
      const n = Math.max(2, Math.min(128, opts.pins ?? 8));
      const perSide = Math.ceil(n / 2);
      const h = (perSide * 2.54) / 2 + 1.27;
      const pins: PinSpec[] = [];
      for (let i = 0; i < n; i++) {
        const left = i < perSide;
        const k = left ? i : i - perSide;
        const y = left ? (k - (perSide - 1) / 2) * 2.54 : ((perSide - 1) / 2 - k) * 2.54;
        pins.push({ number: String(i + 1), name: opts.pinNames?.[i] ?? `P${i + 1}`, type: 'bidirectional', at: { x: left ? -10.16 : 10.16, y }, angle: left ? 0 : 180, length: 2.54 });
      }
      return { prefix: 'U', value: opts.value ?? 'IC', pins, graphics: [{ t: 'rect', a: { x: -7.62, y: -h }, b: { x: 7.62, y: h }, fill: true, w: W }] };
    }
  }
}

/** Next free reference with the given prefix (R1, R2, …). */
export function nextRef(doc: Doc, prefix: string): string {
  const used = new Set<number>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'symbol' && n.type !== 'element') continue;
    const ref = String(n.props.ref ?? n.name);
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(ref);
    if (m) used.add(Number(m[1]));
  }
  let i = 1;
  while (used.has(i)) i++;
  return `${prefix}${i}`;
}

/** Op that places a new symbol on a sheet. */
export function addSymbolOp(doc: Doc, sheetUid: string, spec: SymbolSpec, at: Vec2, ref = nextRef(doc, spec.prefix)): { op: Op; uid: string } {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) throw new Error('No such sheet');
  const uid = newUid('sym');
  const pins: DocNode[] = spec.pins.map((p) => ({
    uid: newUid('pin'),
    type: 'pin',
    name: p.number,
    props: { number: p.number, pinName: p.name, pinType: p.type },
    rules: [
      { name: 'position', value: p.at },
      { name: 'rotation', value: p.angle },
      { name: 'pinLength', value: p.length },
    ],
    parent: uid,
    children: [],
  }));
  const sym: DocNode = {
    uid,
    type: 'symbol',
    name: ref,
    props: { ref, Value: spec.value, unit: 1, ...(spec.footprint ? { Footprint: spec.footprint } : {}) },
    rules: [
      { name: 'position', value: at },
      { name: 'rotation', value: 0 },
      { name: 'mirror', value: 'none' },
    ],
    parent: sheetUid,
    children: pins.map((p) => p.uid),
    data: { graphics: spec.graphics },
  };
  return { op: { op: 'add', parent: sheetUid, index: sheet.children.length, tree: { nodes: [sym, ...pins] } }, uid };
}

/** Ops for a fresh project: an empty schematic root sheet and a 50×40 mm board. */
export function newProjectOps(doc: Doc): Op[] {
  const layoutUid = newUid('layout');
  const mk = (uid: string, type: DocNode['type'], name: string, parent: string, children: string[] = [], extra: Partial<DocNode> = {}): DocNode => ({ uid, type, name, props: {}, rules: [], parent, children, ...extra });
  const board = newUid('c');
  const comps = newUid('c');
  const nets = newUid('c');
  const outline = newUid('gr');
  const schUid = newUid('sch');
  const rootSheet = newUid('sheet');
  return [
    {
      op: 'add',
      parent: doc.rootId,
      index: 0,
      tree: {
        nodes: [
          mk(layoutUid, 'layout', 'Board', doc.rootId, [board, comps, nets], { props: { Thickness: 1.6 } }),
          mk(board, 'container', 'Board', layoutUid, [outline]),
          mk(outline, 'rectangle', '', board, [], {
            rules: [
              { name: 'layer', value: 'Edge.Cuts' },
              { name: 'points', value: [{ x: 100, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 140 }, { x: 100, y: 140 }] },
              { name: 'strokeWidth', value: 0.1 },
            ],
          }),
          mk(comps, 'container', 'Components', layoutUid),
          mk(nets, 'container', 'Nets', layoutUid),
        ],
      },
    },
    { op: 'add', parent: doc.rootId, index: 1, tree: { nodes: [mk(schUid, 'schematic', 'Schematic', doc.rootId, [rootSheet]), mk(rootSheet, 'sheet', 'Root', schUid)] } },
  ];
}

// ---------------------------------------------------------------------------
// Power ports: GND, supply rails and PWR_FLAG as schematic symbols.

/** Ground-type net names get the ground symbol; everything else gets the supply bar. */
export const isGroundNet = (net: string) => /^(A|D|P|S|C)?GND|^VSS|^0V$|^EARTH/i.test(net.replace(/^[/]/, ''));

/**
 * Symbol graphics for a power port, symbol-local (Y down), connection point at (0,0).
 * Ground hangs below the point; supplies stand above it; a PWR_FLAG is a small diamond.
 */
export function powerGraphics(kind: 'ground' | 'supply' | 'flag'): SymGraphicSpec[] {
  const w = 0.254;
  if (kind === 'ground')
    return [
      { t: 'poly', pts: [{ x: 0, y: 0 }, { x: 0, y: 1.27 }], fill: false, w },
      { t: 'poly', pts: [{ x: -1.27, y: 1.27 }, { x: 1.27, y: 1.27 }], fill: false, w },
      { t: 'poly', pts: [{ x: -0.762, y: 1.778 }, { x: 0.762, y: 1.778 }], fill: false, w },
      { t: 'poly', pts: [{ x: -0.254, y: 2.286 }, { x: 0.254, y: 2.286 }], fill: false, w },
    ];
  if (kind === 'flag')
    return [
      { t: 'poly', pts: [{ x: 0, y: 0 }, { x: 0, y: -1.27 }], fill: false, w },
      { t: 'poly', pts: [{ x: 0, y: -1.27 }, { x: -1.016, y: -2.032 }, { x: 0, y: -2.794 }, { x: 1.016, y: -2.032 }, { x: 0, y: -1.27 }], fill: false, w },
    ];
  return [
    { t: 'poly', pts: [{ x: 0, y: 0 }, { x: 0, y: -1.27 }], fill: false, w },
    { t: 'poly', pts: [{ x: -0.762, y: -1.27 }, { x: 0, y: -2.286 }, { x: 0.762, y: -1.27 }, { x: -0.762, y: -1.27 }], fill: true, w },
  ];
}

/** Op that adds a power port symbol whose connection point is `at` (sheet coordinates). */
export function addPowerPortOp(doc: Doc, sheetUid: string, net: string, at: Vec2, opts: { flag?: boolean; down?: boolean } = {}): { op: Op; uid: string; ref: string } {
  const sheet = doc.nodes.get(sheetUid);
  if (!sheet) throw new Error('No such sheet');
  const kind = opts.flag ? 'flag' : isGroundNet(net) ? 'ground' : 'supply';
  const uid = newUid('sym');
  const ref = nextRef(doc, opts.flag ? '#FLG' : '#PWR');
  const label: DocNode = {
    uid: newUid('lbl'),
    type: 'label',
    name: opts.flag ? 'PWR_FLAG' : net,
    props: { kind: opts.flag ? 'flag' : 'power' },
    rules: [
      { name: 'position', value: at },
      { name: 'rotation', value: 0 },
    ],
    parent: uid,
    children: [],
  };
  const sym: DocNode = {
    uid,
    type: 'symbol',
    name: ref,
    props: { ref, Value: opts.flag ? 'PWR_FLAG' : net, power: true },
    rules: [
      { name: 'position', value: at },
      // A flag on a ground net hangs downward like the ground symbol.
      { name: 'rotation', value: opts.flag && opts.down ? 180 : 0 },
      { name: 'mirror', value: 'none' },
    ],
    parent: sheetUid,
    children: [label.uid],
    data: { graphics: powerGraphics(kind) },
  };
  return { op: { op: 'add', parent: sheetUid, index: sheet.children.length, tree: { nodes: [sym, label] } }, uid, ref };
}
