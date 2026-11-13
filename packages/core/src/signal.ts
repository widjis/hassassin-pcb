/**
 * Signal classes (docs/05-pcb-improvements.md, P16): what a pin needs from the layout, and the class a
 * net gets from its pins.
 *
 * A pin's class comes, in this order, from its `signal` property (set by hand or by a tool, on the board
 * pad or on the schematic pin), or else from a guess over pin, net and part names. A net gets the
 * strictest class of its pins, unless the net itself carries a `signal` set by hand.
 *
 * This module only computes; nothing here is stored by the netlist sync. The `classify_nets` tool writes
 * the result onto the nets (`signal`, with `signalSource` = `pin` or `guess`) so the default rulesets
 * (`net[signal=rf]` …) and the router pick it up; a net's `signal` without `signalSource` (or with
 * `signalSource=net`) is the owner's and is never overwritten.
 */
import type { Doc, DocNode } from './model.ts';
import { diffPairs } from './lengths.ts';

export const SIGNAL_CLASSES = ['general', 'analog', 'sensitive', 'clock', 'switching', 'high-speed', 'diff-pair', 'rf', 'power', 'high-current', 'high-voltage', 'ground'] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

/** Strictness: a net takes the class with the highest rank among its pins (the order of SIGNAL_CLASSES). */
export const signalRank = (s: SignalClass): number => SIGNAL_CLASSES.indexOf(s);
export const isSignalClass = (s: unknown): s is SignalClass => typeof s === 'string' && (SIGNAL_CLASSES as readonly string[]).includes(s);

export type SignalSource = 'net' | 'pin' | 'guess' | 'default';

export interface NetSignal {
  net: string;
  signal: SignalClass;
  /** `net` = set by hand on the net; `pin` = a pin's `signal` property; `guess` = from names; `default` = general. */
  source: SignalSource;
  /** Why, in a few words (e.g. "U1.12 (XTAL1)" or "net name CLK"). */
  why: string;
  /** The other half of a differential pair. */
  pair?: string;
}

const base = (name: string) => name.split('/').pop() ?? name;

/** Name patterns, tried on pin names and net names (without a sheet path). First match wins. */
const NAME_GUESSES: [SignalClass, RegExp][] = [
  ['rf', /(^|[_\W])(RF|ANT|ANTENNA)(\d|[_\W]|$)/i],
  ['high-speed', /(^|[_\W])(USB|ETH|RGMII|RMII|MDI|HDMI|TMDS|MIPI|LVDS|DDR|PCIE|SATA|QSPI|SDIO)/i],
  ['clock', /(^|[_\W])(CLK|SCLK|SCK|MCLK|BCLK|LRCLK|CLOCK|CLKOUT|OSC_?OUT)(\d|[_\W]|$)/i],
  ['sensitive', /(^|[_\W])(FB|VFB|XTAL\d*|XIN|XOUT|XI|XO|OSC_?IN|OSC32\w*|VREF|REF|ADJ|COMP|TRIM|FREQ|RT)(\d|[_\W]|$)/i],
  ['switching', /(^|[_\W])(SW|LX|PH|PHASE)(\d|[_\W]|$)/i],
  ['analog', /(^|[_\W])(AIN\d*|ADC\d*|ANALOG|SENSE|VSENSE|ISENSE|MIC|AUDIO|DAC\d*)(\d|[_\W]|$)/i],
];

/** A class guessed from one name, or null. */
export function guessFromName(name: string): SignalClass | null {
  const b = base(name);
  if (!b || b === '~') return null;
  for (const [cls, re] of NAME_GUESSES) if (re.test(b)) return cls;
  return null;
}

interface PinRef {
  ref: string;
  pin: string;
  pinName: string;
  net: string;
  /** `signal` set on the pad or the schematic pin. */
  set?: SignalClass;
  part: DocNode;
}

/** Board pads with their designator, pin number, the schematic pin name (if any) and net. */
function pinsOf(doc: Doc): PinRef[] {
  const schPins = new Map<string, DocNode>();
  for (const n of doc.nodes.values()) {
    if (n.type !== 'pin' || !n.parent) continue;
    const sym = doc.nodes.get(n.parent);
    if (sym?.type === 'symbol') schPins.set(`${sym.name}.${String(n.props.number ?? n.name)}`, n);
  }
  const out: PinRef[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'pad' || typeof n.props.net !== 'string' || !n.props.net) continue;
    const el = n.parent ? doc.nodes.get(n.parent) : undefined;
    if (!el) continue;
    const pin = String(n.props.number ?? n.name);
    const sp = schPins.get(`${el.name}.${pin}`);
    const set = isSignalClass(n.props.signal) ? n.props.signal : isSignalClass(sp?.props.signal) ? (sp!.props.signal as SignalClass) : undefined;
    out.push({ ref: el.name, pin, pinName: String(sp?.props.pinName ?? n.props.pinName ?? ''), net: n.props.net, ...(set ? { set } : {}), part: el });
  }
  return out;
}

// A frequency in the value alone is not enough: timing resistors are often labelled "100k / ~900kHz".
const isCrystal = (el: DocNode) => /^(Y|X|XTAL)\d/i.test(el.name) || /\b(XTAL|crystal|resonator)\b/i.test(String(el.props.Value ?? el.props.value ?? ''));
const isInductor = (el: DocNode) => /^L\d/i.test(el.name);

/** The signal class of every net (except "(no net)"), with where it came from. */
export function netSignals(doc: Doc): NetSignal[] {
  const nets = [...doc.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)');
  const names = nets.map((n) => n.name);
  const partner = new Map<string, string>();
  for (const d of diffPairs(names.map((net) => ({ net, length: 0, segments: 0, vias: 0 })))) partner.set(d.p, d.n), partner.set(d.n, d.p);
  const pins = pinsOf(doc);
  const byNet = new Map<string, PinRef[]>();
  for (const p of pins) byNet.set(p.net, [...(byNet.get(p.net) ?? []), p]);
  const structural = (n: DocNode): SignalClass | null => (n.props.netClass === 'ground' ? 'ground' : n.props.netClass === 'power' ? 'power' : null);
  const netByName = new Map(nets.map((n) => [n.name, n]));
  const out: NetSignal[] = [];
  for (const n of nets) {
    const own = n.props.signal;
    const src = n.props.signalSource;
    if (isSignalClass(own) && (src === undefined || src === 'net')) {
      out.push({ net: n.name, signal: own, source: 'net', why: 'set on the net', ...(partner.has(n.name) ? { pair: partner.get(n.name)! } : {}) });
      continue;
    }
    const ps = byNet.get(n.name) ?? [];
    let best: { signal: SignalClass; source: SignalSource; why: string } = { signal: 'general', source: 'default', why: 'no hint' };
    const take = (signal: SignalClass, source: SignalSource, why: string) => {
      // A pin set by hand beats any guess; otherwise the stricter class wins.
      const better = best.source === 'default' || (source === 'pin' && best.source === 'guess') || (source === best.source && signalRank(signal) > signalRank(best.signal));
      if (better) best = { signal, source, why };
    };
    for (const p of ps) if (p.set) take(p.set, 'pin', `${p.ref}.${p.pin}${p.pinName ? ` (${p.pinName})` : ''}`);
    // KiCad names a pin's own one-pad net "unconnected-(U1-SCLK-Pad14)": nothing to route, no guess.
    if (best.source !== 'pin' && !/^unconnected-/i.test(base(n.name))) {
      const st = structural(n);
      if (st) take(st, 'guess', `net class ${st}`);
      else {
        if (partner.has(n.name)) take('diff-pair', 'guess', `pair with ${partner.get(n.name)}`);
        const fromNet = guessFromName(n.name);
        if (fromNet) take(fromNet, 'guess', `net name ${base(n.name)}`);
        for (const p of ps) {
          const g = p.pinName && p.pinName !== p.pin ? guessFromName(p.pinName) : null;
          if (g) take(g, 'guess', `${p.ref}.${p.pin} (${p.pinName})`);
          if (isCrystal(p.part)) take('sensitive', 'guess', `crystal ${p.ref}`);
          if (isInductor(p.part)) {
            // The node of an inductor whose other end is a supply is a converter's switch node.
            const other = pins.find((q) => q.part === p.part && q.pin !== p.pin);
            const on = other ? netByName.get(other.net) : undefined;
            if (on && structural(on) === 'power') take('switching', 'guess', `inductor ${p.ref} to ${other!.net}`);
          }
        }
      }
    }
    out.push({ net: n.name, ...best, ...(partner.has(n.name) ? { pair: partner.get(n.name)! } : {}) });
  }
  return out.sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
}
