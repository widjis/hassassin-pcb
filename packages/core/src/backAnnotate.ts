/**
 * PCB → schematic back-annotation (S18): what was changed on the board is written back to the
 * schematic, the reverse of Update PCB.
 *   - References: a component renamed on the board renames its symbol (every unit). Board components
 *     are matched to symbols by the link an import keeps, else by value and the nets on their pads.
 *   - Gate swaps: two identical units of a part whose pads swapped nets on the board swap units in the
 *     schematic; the symbols stay where they are, so their wires now carry the right nets.
 *   - Pin swaps: pins of one symbol whose pads swapped (or rotated) nets on the board, within a group the
 *     part allows (`swapGroups`, e.g. "1 2; 3 4 5"; both pins of a two-pin passive part by default),
 *     trade their number and name in place, so each wire keeps its net and reaches the right pad.
 * Anything else that differs is reported, not changed (Update PCB is the other direction).
 */
import type { Op } from './commands.ts';
import type { Doc, DocNode, Vec2 } from './model.ts';
import type { StyleEngine } from './style.ts';
import { extractNetlist } from './netlist.ts';

export type BackChange =
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'gateSwap'; ref: string; units: [number, number] }
  | { kind: 'pinSwap'; ref: string; pins: string[]; to: string[] };

export interface BackAnnotation {
  changes: BackChange[];
  ops: Op[];
  /** Board and schematic disagree in a way that is not a rename or an allowed swap. */
  unexplained: string[];
}

const vec = (v: unknown): Vec2 | undefined => (v && typeof v === 'object' && 'x' in v ? (v as Vec2) : undefined);
const refOf = (n: DocNode) => String(n.props.ref ?? n.name);
const numOf = (p: DocNode) => String(p.props.number ?? p.name);

/** Pin groups a part allows swapping: its `swapGroups` property, or both pins of a two-pin passive part. */
export function swapGroups(doc: Doc, syms: DocNode[], el?: DocNode): string[][] {
  const text = String(syms.find((s) => s.props.swapGroups)?.props.swapGroups ?? el?.props.swapGroups ?? '').trim();
  if (text) return text.split(/[;|]/).map((g) => g.split(/[\s,]+/).filter(Boolean)).filter((g) => g.length > 1);
  const pins = syms.flatMap((s) => s.children.map((c) => doc.nodes.get(c)).filter((p): p is DocNode => p?.type === 'pin'));
  if (pins.length === 2 && pins.every((p) => (p.props.pinType ?? 'passive') === 'passive')) return [pins.map(numOf)];
  return [];
}

/** The board's components with their pads' nets. */
function boardParts(doc: Doc): { el: DocNode; pads: Map<string, string> }[] {
  const out: { el: DocNode; pads: Map<string, string> }[] = [];
  for (const n of doc.nodes.values()) {
    if (n.type !== 'element') continue;
    const pads = new Map<string, string>();
    for (const c of n.children) {
      const p = doc.nodes.get(c);
      if (p?.type === 'pad' && typeof p.props.net === 'string' && p.props.net) pads.set(String(p.props.number ?? p.name), p.props.net);
    }
    out.push({ el: n, pads });
  }
  return out;
}

const bag = (xs: Iterable<string>) => [...xs].sort().join('\u0001');

export function planBackAnnotation(doc: Doc, engine: StyleEngine): BackAnnotation {
  const nl = extractNetlist(doc, engine);
  const changes: BackChange[] = [];
  const ops: Op[] = [];
  const unexplained: string[] = [];

  const symsByRef = new Map<string, DocNode[]>();
  for (const n of doc.nodes.values()) if (n.type === 'symbol' && !n.props.power) (symsByRef.get(refOf(n)) ?? symsByRef.set(refOf(n), []).get(refOf(n))!).push(n);
  const pinsOf = (syms: DocNode[]) => syms.flatMap((s) => s.children.map((c) => doc.nodes.get(c)).filter((p): p is DocNode => p?.type === 'pin'));
  const schNet = (ref: string, num: string) => nl.byPin.get(`${ref}.${num}`) ?? '';
  const schBag = (ref: string) => bag(pinsOf(symsByRef.get(ref)!).map((p) => schNet(ref, numOf(p))).filter(Boolean));
  const value = (ref: string) => String(symsByRef.get(ref)![0]!.props.Value ?? '');

  // A board net whose name the schematic no longer has (renamed there since the last Update PCB) stands
  // for the schematic net most of its pads are on, so a rename is not taken for a change on the board.
  const parts = boardParts(doc).filter((b) => b.pads.size);
  const votes = new Map<string, Map<string, number>>();
  for (const b of parts) {
    if (!symsByRef.has(b.el.name)) continue;
    for (const [num, net] of b.pads) {
      const want = schNet(b.el.name, num);
      if (!want) continue;
      const v = votes.get(net) ?? votes.set(net, new Map()).get(net)!;
      v.set(want, (v.get(want) ?? 0) + 1);
    }
  }
  const canon = new Map<string, string>();
  const schNames = new Set(nl.nets.map((n) => n.name));
  for (const [net, v] of votes) if (!schNames.has(net)) canon.set(net, [...v.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0]);
  for (const b of parts) for (const [num, net] of b.pads) b.pads.set(num, canon.get(net) ?? net);

  // 1) Which symbol each board component is.
  const refOfEl = new Map<string, string>();
  const taken = new Set<string>();
  for (const b of parts) {
    const linked = [...symsByRef.entries()].find(([, syms]) => syms.some((s) => s.props.element === b.el.uid))?.[0];
    const same = symsByRef.has(b.el.name) && schBag(b.el.name) === bag(b.pads.values()) ? b.el.name : undefined;
    const ref = linked ?? same;
    if (ref && !taken.has(ref)) (refOfEl.set(b.el.uid, ref), taken.add(ref));
  }
  for (const b of parts) {
    if (refOfEl.has(b.el.uid)) continue;
    const sig = bag(b.pads.values());
    const val = String(b.el.props.Value ?? '');
    const cands = [...symsByRef.keys()].filter((r) => !taken.has(r) && schBag(r) === sig && (!val || value(r) === val));
    if (cands.length === 1) (refOfEl.set(b.el.uid, cands[0]!), taken.add(cands[0]!));
    else if (cands.length > 1) unexplained.push(`${b.el.name} matches ${cands.join(', ')} equally; rename it on the board or in the schematic by hand`);
  }

  // A component that keeps its name but no longer matches is still that symbol (its pads are reported).
  for (const b of parts) if (!refOfEl.has(b.el.uid) && symsByRef.has(b.el.name) && !taken.has(b.el.name)) (refOfEl.set(b.el.uid, b.el.name), taken.add(b.el.name));

  for (const b of parts) {
    const ref = refOfEl.get(b.el.uid);
    if (!ref) continue;
    const syms = symsByRef.get(ref)!;
    const board = (num: string) => b.pads.get(num) ?? '';
    const wrong = (num: string) => board(num) !== '' && board(num) !== schNet(ref, num);

    // 2) Gate swaps: two identical units whose pads traded nets.
    const units = syms.filter((s) => Number(s.props.unit ?? 1) > 0);
    const swapped = new Set<string>();
    for (let i = 0; i < units.length; i++)
      for (let j = i + 1; j < units.length; j++) {
        const A = units[i]!;
        const B = units[j]!;
        if (swapped.has(A.uid) || swapped.has(B.uid)) continue;
        const pa = pinsOf([A]);
        const pb = pinsOf([B]);
        if (pa.length !== pb.length || !pa.length) continue;
        const at = (p: DocNode) => vec(engine.get(p.uid, 'position')?.value) ?? { x: NaN, y: NaN };
        const pairs = pa.map((p) => [p, pb.find((q) => Math.abs(at(q).x - at(p).x) < 1e-6 && Math.abs(at(q).y - at(p).y) < 1e-6 && q.props.pinName === p.props.pinName && q.props.pinType === p.props.pinType)] as const);
        if (pairs.some(([, q]) => !q)) continue;
        const anyWrong = pairs.some(([p, q]) => wrong(numOf(p)) || wrong(numOf(q!)));
        const fits = pairs.every(([p, q]) => board(numOf(q!)) === schNet(ref, numOf(p)) && board(numOf(p)) === schNet(ref, numOf(q!)));
        if (!anyWrong || !fits) continue;
        const ua = Number(A.props.unit ?? 1);
        const ub = Number(B.props.unit ?? 1);
        for (const [p, q] of pairs) {
          const np = numOf(p);
          const nq = numOf(q!);
          ops.push({ op: 'setProp', uid: p.uid, key: 'number', value: nq }, { op: 'setName', uid: p.uid, name: nq }, { op: 'setProp', uid: q!.uid, key: 'number', value: np }, { op: 'setName', uid: q!.uid, name: np });
        }
        ops.push({ op: 'setProp', uid: A.uid, key: 'unit', value: ub }, { op: 'setProp', uid: B.uid, key: 'unit', value: ua });
        changes.push({ kind: 'gateSwap', ref, units: [ua, ub] });
        swapped.add(A.uid).add(B.uid);
        for (const [p, q] of pairs) (swapped.add(`${ref}.${numOf(p)}`), swapped.add(`${ref}.${numOf(q!)}`));
      }

    // 3) Pin swaps within the part's groups: each pin takes the identity of the pin whose pad now
    //    carries its net.
    const pinByNum = new Map(pinsOf(syms).map((p) => [numOf(p), p] as const));
    const explained = new Set<string>();
    for (const g of swapGroups(doc, syms, b.el)) {
      const M = g.filter((n) => pinByNum.has(n) && wrong(n) && !swapped.has(`${ref}.${n}`));
      if (M.length < 2 || bag(M.map(board)) !== bag(M.map((n) => schNet(ref, n)))) continue;
      const used = new Set<string>();
      const to: string[] = [];
      for (const a of M) {
        const target = M.find((x) => !used.has(x) && board(x) === schNet(ref, a));
        if (!target) break;
        used.add(target);
        to.push(target);
      }
      if (to.length !== M.length) continue;
      const before = M.map((n) => pinByNum.get(n)!);
      const ident = before.map((p) => ({ number: numOf(p), pinName: p.props.pinName, pinType: p.props.pinType, hidden: p.props.hidden }));
      M.forEach((_, i) => {
        const p = before[i]!;
        const src = ident[M.indexOf(to[i]!)]!;
        ops.push({ op: 'setProp', uid: p.uid, key: 'number', value: src.number }, { op: 'setName', uid: p.uid, name: src.number });
        for (const k of ['pinName', 'pinType', 'hidden'] as const) if (p.props[k] !== src[k]) ops.push({ op: 'setProp', uid: p.uid, key: k, value: src[k] ?? null });
      });
      changes.push({ kind: 'pinSwap', ref, pins: M, to });
      for (const n of M) explained.add(n);
    }
    for (const [num] of b.pads)
      if (wrong(num) && !explained.has(num) && !swapped.has(`${ref}.${num}`))
        unexplained.push(`${b.el.name} pad ${num} is on ${board(num)} on the board but ${schNet(ref, num) || 'unconnected'} in the schematic${pinByNum.has(num) ? '' : ' (no such pin)'}`);

    // 4) Reference renamed on the board (applied last; the checks above use the old reference).
    if (b.el.name !== ref) {
      for (const s of syms) ops.push({ op: 'setProp', uid: s.uid, key: 'ref', value: b.el.name }, { op: 'setName', uid: s.uid, name: b.el.name });
      changes.push({ kind: 'rename', from: ref, to: b.el.name });
    }
  }
  return { changes, ops, unexplained };
}

export function describeBackChange(c: BackChange): string {
  if (c.kind === 'rename') return `${c.from} → ${c.to}`;
  if (c.kind === 'gateSwap') return `${c.ref}: units ${c.units.map((u) => String.fromCharCode(64 + u)).join(' ↔ ')} swapped`;
  return `${c.ref}: pins ${c.pins.join(', ')} now ${c.to.join(', ')}`;
}
