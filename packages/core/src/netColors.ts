/**
 * Copper coloured by net (docs/05-pcb-improvements.md, P17). References: the KiCad 8 PCB Editor manual
 * (Appearance panel: a colour per net and per net class; net colours applied to "All" copper, to the
 * "Ratsnest" only, or "None") and the Pulsonix help, Colours > Nets ("Use Own Colour", applied to a net
 * class), the tool family Easy-PC belongs to.
 *
 * A net's own colour is its `color` property; a signal class colour (P16 classes) is kept in the project
 * meta `netClassColors`; the display mode in the meta `netColorMode`.
 */
import type { Op } from './commands.ts';
import type { Doc } from './model.ts';
import { netSignals, type SignalClass } from './signal.ts';

export type NetColorMode = 'layer' | 'net' | 'ratsnest';
export const NET_COLOR_MODES: { mode: NetColorMode; label: string }[] = [
  { mode: 'layer', label: 'Layer colours' },
  { mode: 'net', label: 'Net colours on copper' },
  { mode: 'ratsnest', label: 'Net colours on ratsnest only' },
];

/**
 * Colours that are easy to tell apart on a dark board, in an order where neighbours differ in hue and
 * lightness (a qualitative palette; the darkest shades left out, they vanish on the board).
 */
export const NET_PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#b04fd6', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#13a3a3', '#e6beff', '#c08a4a', '#aaffc3', '#ffd8b1', '#a9a9a9',
];

/** Default class colours: ground grey, power deep orange (only when the project sets none). */
export const CLASS_COLOR_DEFAULTS: Partial<Record<SignalClass, string>> = { ground: '#8c96a3', power: '#ff7043' };

const HEX = /^#[0-9a-f]{6}$/i;
export const isHexColor = (s: unknown): s is string => typeof s === 'string' && HEX.test(s);

export function netColorMode(doc: Doc): NetColorMode {
  const m = doc.meta.netColorMode;
  return m === 'net' || m === 'ratsnest' || m === 'layer' ? m : 'ratsnest';
}

export function classColors(doc: Doc): Partial<Record<SignalClass, string>> {
  const own = (doc.meta.netClassColors ?? {}) as Record<string, string>;
  return { ...CLASS_COLOR_DEFAULTS, ...Object.fromEntries(Object.entries(own).filter(([, v]) => isHexColor(v))) } as Partial<Record<SignalClass, string>>;
}

/** The colour of every net that has one: its own, else its signal class's. */
export function netColorMap(doc: Doc): Map<string, string> {
  const out = new Map<string, string>();
  const cls = classColors(doc);
  const sig = new Map(netSignals(doc).map((s) => [s.net, s.signal] as const));
  for (const n of doc.nodes.values()) {
    if (n.type !== 'net' || n.name === '(no net)') continue;
    const own = n.props.color;
    if (isHexColor(own)) out.set(n.name, own);
    else {
      const c = cls[sig.get(n.name) as SignalClass];
      if (c) out.set(n.name, c);
    }
  }
  return out;
}

/** Set (or with null clear) a net's own colour. */
export function setNetColorOps(doc: Doc, net: string, color: string | null): Op[] {
  const n = [...doc.nodes.values()].find((x) => x.type === 'net' && x.name === net);
  if (!n) throw new Error(`No net ${net} on the board`);
  if (color !== null && !isHexColor(color)) throw new Error('A colour is written #rrggbb');
  return [{ op: 'setProp', uid: n.uid, key: 'color', value: color }];
}

export function setClassColorOp(doc: Doc, cls: SignalClass, color: string | null): Op {
  const cur = { ...((doc.meta.netClassColors ?? {}) as Record<string, string>) };
  if (color === null) delete cur[cls];
  else cur[cls] = color;
  return { op: 'setMeta', key: 'netClassColors', value: cur };
}

export function setNetColorModeOp(mode: NetColorMode): Op {
  return { op: 'setMeta', key: 'netColorMode', value: mode };
}

/**
 * "Colour every net": each net without a colour of its own or of its class gets the next palette colour
 * (in name order, so the same board gets the same colours).
 */
export function autoNetColorOps(doc: Doc): Op[] {
  const have = netColorMap(doc);
  const ops: Op[] = [];
  const nets = [...doc.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)' && !have.has(n.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  nets.forEach((n, i) => ops.push({ op: 'setProp', uid: n.uid, key: 'color', value: NET_PALETTE[i % NET_PALETTE.length]! }));
  return ops;
}
