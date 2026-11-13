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
import type { Doc, DocNode, KeepOut, RuleDecl } from './model.ts';
import type { Op } from './commands.ts';
import { diffPairs } from './lengths.ts';
import { parseRuleValue } from './ruleDefs.ts';
import { matches } from './selector.ts';
import { lineGeometry, pairGeometry, widthForImpedance, type Stackup } from './stackup.ts';
import { clearanceFor } from './copper.ts';
import type { StyleEngine } from './style.ts';

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
  /** Largest current (A) given on the net or its pins (`signalCurrent`). */
  current?: number;
  /** Largest voltage (V) given on the net or its pins (`signalVoltage`). */
  voltage?: number;
  /** Single-ended target impedance (Ω) given on the net or its pins (`signalImpedance`; the smallest). */
  impedance?: number;
  /** Highest frequency (MHz) given on the net or its pins (`signalFrequency`). */
  frequency?: number;
  /** Interface preset given on the net or its pins (`signalInterface`), see SIGNAL_INTERFACES. */
  interface?: string;
  /** Differential impedance (Ω) of the interface preset, for the pair rules of P10. */
  diffImpedance?: number;
  /** The net's length-match group (net property `lengthGroup`). */
  lengthGroup?: string;
}

/**
 * Interface presets: the differential impedance their cables and connectors are commonly designed for
 * (typical values from design guides; the part's datasheet decides). They make a net a `diff-pair`; the
 * pair width, gap and skew from them are P10.
 */
export const SIGNAL_INTERFACES: Record<string, { label: string; diffImpedance: number }> = {
  usb2: { label: 'USB 2.0', diffImpedance: 90 },
  usb3: { label: 'USB 3.x', diffImpedance: 90 },
  ethernet: { label: 'Ethernet (10/100/1000BASE-T, MDI)', diffImpedance: 100 },
  lvds: { label: 'LVDS', diffImpedance: 100 },
  hdmi: { label: 'HDMI (TMDS)', diffImpedance: 100 },
  mipi: { label: 'MIPI D-PHY', diffImpedance: 100 },
  pcie: { label: 'PCI Express', diffImpedance: 85 },
  can: { label: 'CAN', diffImpedance: 120 },
  rs485: { label: 'RS-485', diffImpedance: 120 },
};
export const isSignalInterface = (s: unknown): s is string => typeof s === 'string' && s in SIGNAL_INTERFACES;

/** From this frequency (MHz) a net is at least `high-speed` (our own threshold). */
export const HIGH_SPEED_MHZ = 50;

/** Above these a net is at least `high-current` / `high-voltage` (our own thresholds). */
export const HIGH_CURRENT_A = 1;
export const HIGH_VOLTAGE_V = 50;

/**
 * Outer-layer trace width (mm) for a current, from the IPC-2221 chart fit I = 0.048 · ΔT^0.44 · A^0.725
 * (A in mil²), for a temperature rise of `rise` °C over copper `thicknessMm` thick. Rounded up to 0.05 mm.
 */
export function widthForCurrent(amps: number, thicknessMm = 0.035, rise = 10): number {
  if (!(amps > 0)) return 0;
  const areaMil2 = (amps / (0.048 * rise ** 0.44)) ** (1 / 0.725);
  const mm = (areaMil2 / (thicknessMm / 0.0254)) * 0.0254;
  return +(Math.ceil(mm / 0.05 - 1e-9) * 0.05).toFixed(2);
}

/** Conductor spacing (mm) for a voltage, outer layer without coating (IPC-2221 table, column B2). */
export function clearanceForVoltage(volts: number): number {
  if (!(volts > 0)) return 0;
  if (volts <= 30) return 0.1;
  if (volts <= 150) return 0.6;
  if (volts <= 300) return 1.25;
  if (volts <= 500) return 2.5;
  return Math.ceil((2.5 + (volts - 500) * 0.005) * 100) / 100;
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
  current?: number;
  voltage?: number;
  impedance?: number;
  frequency?: number;
  iface?: string;
  part: DocNode;
}

const numProp = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(x) && x > 0) return x;
  }
  return undefined;
};

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
    const current = numProp(n.props.signalCurrent, sp?.props.signalCurrent);
    const voltage = numProp(n.props.signalVoltage, sp?.props.signalVoltage);
    const impedance = numProp(n.props.signalImpedance, sp?.props.signalImpedance);
    const frequency = numProp(n.props.signalFrequency, sp?.props.signalFrequency);
    const iface = [n.props.signalInterface, sp?.props.signalInterface].find(isSignalInterface);
    out.push({ ref: el.name, pin, pinName: String(sp?.props.pinName ?? n.props.pinName ?? ''), net: n.props.net, ...(set ? { set } : {}), ...(current ? { current } : {}), ...(voltage ? { voltage } : {}), ...(impedance ? { impedance } : {}), ...(frequency ? { frequency } : {}), ...(iface ? { iface } : {}), part: el });
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
  // A partner set by hand (net property `pairWith`, either side) beats the name pairing.
  const nameSet = new Set(names);
  for (const n of nets) {
    const w = n.props.pairWith;
    if (typeof w !== 'string' || !nameSet.has(w) || w === n.name) continue;
    for (const [a, b] of [[n.name, w], [w, n.name]] as const) {
      const old = partner.get(a);
      if (old && old !== b) partner.delete(old);
      partner.set(a, b);
    }
  }
  const handPair = new Set<string>();
  for (const n of nets) if (typeof n.props.pairWith === 'string' && nameSet.has(n.props.pairWith)) handPair.add(n.name), handPair.add(n.props.pairWith);
  const pins = pinsOf(doc);
  const byNet = new Map<string, PinRef[]>();
  for (const p of pins) byNet.set(p.net, [...(byNet.get(p.net) ?? []), p]);
  const structural = (n: DocNode): SignalClass | null => (n.props.netClass === 'ground' ? 'ground' : n.props.netClass === 'power' ? 'power' : null);
  const netByName = new Map(nets.map((n) => [n.name, n]));
  const out: NetSignal[] = [];
  for (const n of nets) {
    const ps = byNet.get(n.name) ?? [];
    const valsOf = (k: 'current' | 'voltage' | 'impedance' | 'frequency', prop: string) => [numProp(n.props[prop]), ...ps.map((p) => p[k])].filter((x): x is number => x !== undefined);
    const maxOf = (k: 'current' | 'voltage' | 'frequency', prop: string) => {
      const vals = valsOf(k, prop);
      return vals.length ? Math.max(...vals) : undefined;
    };
    const current = maxOf('current', 'signalCurrent');
    const voltage = maxOf('voltage', 'signalVoltage');
    const zs = valsOf('impedance', 'signalImpedance');
    const impedance = zs.length ? Math.min(...zs) : undefined;
    const frequency = maxOf('frequency', 'signalFrequency');
    const iface = [n.props.signalInterface, ...ps.map((p) => p.iface)].find(isSignalInterface);
    const group = typeof n.props.lengthGroup === 'string' && n.props.lengthGroup ? n.props.lengthGroup : undefined;
    const extra = {
      ...(partner.has(n.name) ? { pair: partner.get(n.name)! } : {}),
      ...(current ? { current } : {}),
      ...(voltage ? { voltage } : {}),
      ...(impedance ? { impedance } : {}),
      ...(frequency ? { frequency } : {}),
      ...(iface ? { interface: iface, diffImpedance: SIGNAL_INTERFACES[iface]!.diffImpedance } : {}),
      ...(group ? { lengthGroup: group } : {}),
    };
    const own = n.props.signal;
    const src = n.props.signalSource;
    if (isSignalClass(own) && (src === undefined || src === 'net')) {
      out.push({ net: n.name, signal: own, source: 'net', why: 'set on the net', ...extra });
      continue;
    }
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
    // A current or voltage given on a pin raises the class (a set pin class counts as given, so the
    // raise is a `pin` source too).
    const given = current !== undefined || voltage !== undefined || impedance !== undefined || frequency !== undefined || iface !== undefined || handPair.has(n.name);
    const raise = (cls: SignalClass, why: string) => {
      if (signalRank(cls) > signalRank(best.signal)) best = { signal: cls, source: given ? 'pin' : best.source, why };
    };
    if (current !== undefined && current >= HIGH_CURRENT_A) raise('high-current', `${current} A`);
    if (voltage !== undefined && voltage >= HIGH_VOLTAGE_V) raise('high-voltage', `${voltage} V`);
    // A target impedance means a controlled-impedance line: at least high-speed.
    if (impedance !== undefined) raise('high-speed', `${impedance} Ω`);
    if (frequency !== undefined && frequency >= HIGH_SPEED_MHZ) raise('high-speed', `${frequency} MHz`);
    if (iface) raise('diff-pair', SIGNAL_INTERFACES[iface]!.label);
    else if (handPair.has(n.name)) raise('diff-pair', `pair with ${partner.get(n.name)}`);
    out.push({ net: n.name, ...best, ...extra });
  }
  // The two halves of a pair share the interface preset given on either of them (P10).
  const sigOf = new Map(out.map((x) => [x.net, x]));
  for (const x of out) {
    const o = x.pair ? sigOf.get(x.pair) : undefined;
    if (!o || x.interface || !o.interface) continue;
    x.interface = o.interface;
    x.diffImpedance = o.diffImpedance;
    if (x.source !== 'net' && signalRank('diff-pair') > signalRank(x.signal)) Object.assign(x, { signal: 'diff-pair', source: 'pin', why: `pair with ${o.net} (${SIGNAL_INTERFACES[o.interface]!.label})` });
  }
  return out.sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
}

/** Rules `classify_nets` may compute per net from the parameters; listed in the net's `signalRules`. */
const COMPUTED_RULES = ['traceWidth', 'keepOut', 'diffGap', 'diffPairClearance'] as const;

export interface SignalPlan {
  ops: Op[];
  /** Per net: the computed rules written, and hand-set rules that were kept although smaller. */
  rules: { net: string; traceWidth?: number; keepOut?: number; diffGap?: number; diffPairClearance?: number; kept?: string[]; note?: string }[];
}

/**
 * Ops that write the classes onto the nets (`signal`, `signalSource`) and the rules computed from the
 * parameters: `traceWidth` from the current (IPC-2221, outer copper of `copperMm`) and `keepOut` from the
 * voltage, as the net's own rules. Rules written this way are listed in the net's `signalRules`, so a
 * later run may change or remove them; a rule of the same name set by hand is kept (and reported).
 */
export function planSignalClasses(doc: Doc, opts: { copperMm?: number; nets?: string[]; stackup?: Stackup; layer?: string; engine?: StyleEngine } = {}): SignalPlan {
  const geom = opts.stackup && opts.layer ? lineGeometry(opts.stackup, opts.layer) : null;
  const byName = new Map([...doc.nodes.values()].filter((n) => n.type === 'net').map((n) => [n.name, n]));
  const ops: Op[] = [];
  const rules: SignalPlan['rules'] = [];
  for (const s of netSignals(doc)) {
    if (opts.nets && !opts.nets.includes(s.net)) continue;
    const n = byName.get(s.net)!;
    if (s.source !== 'net') {
      const want = s.signal === 'general' ? null : s.signal;
      const wantSrc = want ? s.source : null;
      if ((n.props.signal ?? null) !== want) ops.push({ op: 'setProp', uid: n.uid, key: 'signal', value: want });
      if ((n.props.signalSource ?? null) !== wantSrc) ops.push({ op: 'setProp', uid: n.uid, key: 'signalSource', value: wantSrc });
    }
    const mine = new Set(String(n.props.signalRules ?? '').split(/\s+/).filter(Boolean));
    const value: Partial<Record<(typeof COMPUTED_RULES)[number], number>> = {};
    const notes: string[] = [];
    const w = s.current ? widthForCurrent(s.current, opts.copperMm) : 0;
    if (w) value.traceWidth = w;
    if (s.impedance) {
      // The impedance fixes the width; a current that needs more is reported, not silently widened.
      const zw = geom ? widthForImpedance(geom, s.impedance) : null;
      if (!geom) notes.push(`no stackup line geometry for ${opts.layer ?? 'the outer layer'}: width for ${s.impedance} Ω not set`);
      else if (zw === null) notes.push(`${s.impedance} Ω cannot be reached on ${opts.layer} with this stackup`);
      else {
        const zr = Math.round(zw * 1000) / 1000;
        if (w > zr) notes.push(`${s.current} A needs ${w} mm, wider than the ${zr} mm for ${s.impedance} Ω; the impedance width is used`);
        value.traceWidth = zr;
        if (zr > 1.5) notes.push(`${s.impedance} Ω needs ${zr} mm on ${opts.layer}: a thinner dielectric to the plane (more layers) would make it narrower`);
      }
    }
    // A differential pair (P10): width and gap for the pair's differential impedance (the net's
    // diffImpedance rule, else its interface preset), the gap kept at the nets' clearance.
    const zRule = opts.engine?.get(n.uid, 'diffImpedance')?.value;
    const zDiff = typeof zRule === 'number' && zRule > 0 ? zRule : s.diffImpedance;
    if (zDiff && (s.pair || s.signal === 'diff-pair')) {
      const ko = opts.engine?.get(n.uid, 'keepOut')?.value as KeepOut | undefined;
      const pg = geom ? pairGeometry(geom, zDiff, ko ? clearanceFor(ko, 'trace') : 0.2) : null;
      if (!geom) notes.push(`no stackup line geometry for ${opts.layer ?? 'the outer layer'}: pair width for ${zDiff} Ω not set`);
      else if (!pg) notes.push(`${zDiff} Ω differential cannot be reached on ${opts.layer} with this stackup`);
      else {
        value.traceWidth = pg.width;
        value.diffGap = pg.gap;
        // Other nets at least 3 × the width away, centre to centre (2 × w edge to edge), for crosstalk.
        value.diffPairClearance = Math.ceil(2 * pg.width * 100 - 1e-6) / 100;
        if (pg.width > 1) notes.push(`${zDiff} Ω differential needs ${pg.width} mm traces ${pg.gap} mm apart on ${opts.layer}: a thinner dielectric to the plane (more layers) would make them narrower`);
      }
    }
    const c = s.voltage ? clearanceForVoltage(s.voltage) : 0;
    if (c) value.keepOut = c;
    const nextMine = new Set<string>();
    const kept: string[] = [];
    // A project ruleset (not a built-in default) that sets the rule on this net is the owner's too.
    const byRuleset = (name: string) => doc.rulesets.some((rs) => rs.origin !== 'default' && rs.enabled !== false && rs.rules.some((r) => r.name === name) && matches(doc, n, rs.selector));
    for (const name of COMPUTED_RULES) {
      const have = n.rules.find((r) => r.name === name);
      const v = value[name];
      if (!have && byRuleset(name)) {
        if (v !== undefined) kept.push(name);
        continue;
      }
      if (have && !mine.has(name)) {
        if (v !== undefined) kept.push(name);
        continue;
      }
      if (v === undefined) {
        if (have) ops.push({ op: 'setRule', uid: n.uid, name, decl: null });
        continue;
      }
      const decl: RuleDecl = { name, value: parseRuleValue(name, `${+v.toFixed(3)}mm`) };
      if (!have || JSON.stringify(have.value) !== JSON.stringify(decl.value)) ops.push({ op: 'setRule', uid: n.uid, name, decl });
      nextMine.add(name);
    }
    const list = [...nextMine].join(' ') || null;
    if ((n.props.signalRules ?? null) !== list) ops.push({ op: 'setProp', uid: n.uid, key: 'signalRules', value: list });
    if (value.traceWidth || value.keepOut || value.diffGap || kept.length || notes.length)
      rules.push({ net: s.net, ...(nextMine.has('traceWidth') ? { traceWidth: value.traceWidth! } : {}), ...(nextMine.has('keepOut') ? { keepOut: value.keepOut! } : {}), ...(nextMine.has('diffGap') ? { diffGap: value.diffGap! } : {}), ...(nextMine.has('diffPairClearance') ? { diffPairClearance: value.diffPairClearance! } : {}), ...(kept.length ? { kept } : {}), ...(notes.length ? { note: notes.join('; ') } : {}) });
  }
  return { ops, rules };
}
