/**
 * Project stages and their gates (requirements → schematic → components → layout →
 * review → fabrication). Pure: computed from the document and check results.
 */
import type { Doc, DrcResult, ErcViolation, Ratsnest } from '@hassassin/core';

export interface Spec {
  goal?: string;
  supply?: string;
  current?: string;
  interfaces?: string;
  size?: string;
  environment?: string;
  quantity?: string;
  notes?: string;
}

export const SPEC_FIELDS: { key: keyof Spec; label: string; hint: string; required: boolean; multiline?: boolean }[] = [
  { key: 'goal', label: 'What it does', hint: 'One or two sentences about the device and who uses it', required: true, multiline: true },
  { key: 'supply', label: 'Power supply', hint: 'e.g. USB-C 5 V, 1S Li-ion 3.0–4.2 V', required: true },
  { key: 'current', label: 'Max current', hint: 'e.g. 500 mA on 3V3, 2 A on VBUS', required: true },
  { key: 'interfaces', label: 'Interfaces', hint: 'Connectors, buses, radios, buttons…', required: true, multiline: true },
  { key: 'size', label: 'Board size / enclosure', hint: 'e.g. ≤ 50 × 40 mm, 2 mounting holes M3', required: false },
  { key: 'environment', label: 'Environment', hint: 'Temperature, moisture, vibration…', required: false },
  { key: 'quantity', label: 'Quantity', hint: 'Prototype count and expected production volume', required: false },
  { key: 'notes', label: 'Other requirements', hint: 'Certifications, cost target, anything else', required: false, multiline: true },
];

export type GateState = 'ok' | 'todo' | 'blocked' | 'override';

export interface Gate {
  id: string;
  title: string;
  state: GateState;
  detail: string;
  reason?: string;
}

export interface GateInputs {
  doc: Doc;
  erc: { violations: ErcViolation[] } | null;
  drc: DrcResult | null;
  ratsnest: Ratsnest;
  /** Unresolved comments marked as blocking (phase 4). */
  blockingComments?: number;
}

export function computeGates({ doc, erc, drc, ratsnest, blockingComments }: GateInputs): Gate[] {
  const spec = (doc.meta.spec ?? {}) as Spec;
  const overrides = (doc.meta.gateOverrides ?? {}) as Record<string, string>;
  const nodes = [...doc.nodes.values()];
  const hasSch = nodes.some((n) => n.type === 'sheet');
  const elements = nodes.filter((n) => n.type === 'element');
  const missingReq = SPEC_FIELDS.filter((f) => f.required && !(spec[f.key] ?? '').trim()).map((f) => f.label);
  const ercErr = erc?.violations.filter((v) => v.severity === 'error').length ?? 0;
  const drcErr = drc?.violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length ?? 0;
  const unrouted = ratsnest.lines.length;
  const placeholders = elements.filter((e) => e.props.placeholder).length;
  const noMpn = elements.filter((e) => !e.props.MPN && !e.props['Manufacturer Part Number'] && !e.props.LCSC).length;
  const g = (id: string, title: string, ok: boolean, okText: string, todoText: string): Gate => {
    if (ok) return { id, title, state: 'ok', detail: okText };
    if (overrides[id]) return { id, title, state: 'override', detail: todoText, reason: overrides[id] };
    return { id, title, state: 'todo', detail: todoText };
  };
  const gates: Gate[] = [
    g('requirements', '1 · Requirements', missingReq.length === 0, 'All required fields filled', `Missing: ${missingReq.join(', ')}`),
    g('schematic', '2 · Schematic', hasSch && ercErr === 0, 'ERC clean', hasSch ? `${ercErr} ERC error(s)` : 'No schematic yet'),
    g('components', '3 · Components', elements.length > 0 && placeholders === 0 && noMpn === 0, 'Every part has a footprint and part number', `${placeholders} placeholder footprint(s), ${noMpn} part(s) without MPN`),
    g('layout', '4 · Layout', elements.length > 0 && drcErr === 0 && unrouted === 0, 'DRC clean and fully routed', `${drcErr} DRC error(s), ${unrouted} unrouted connection(s)`),
    blockingComments === undefined
      ? g('review', '5 · Review', false, '', 'Open the project on a collaboration server to review it with others')
      : g('review', '5 · Review', blockingComments === 0, 'No open blocking comments', `${blockingComments} open blocking comment(s)`),
  ];
  const earlier = gates.every((x) => x.state === 'ok' || x.state === 'override');
  gates.push({ id: 'fabrication', title: '6 · Fabrication', state: earlier ? 'ok' : 'todo', detail: earlier ? 'Ready to export' : 'Earlier stages still open (export is still allowed)' });
  return gates;
}
