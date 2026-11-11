/**
 * Project panel: the requirements document and the stage gates
 * (requirements → schematic → components → layout → review → fabrication).
 */
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

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

const FIELDS: { key: keyof Spec; label: string; hint: string; required: boolean; multiline?: boolean }[] = [
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

export function computeGates(app: App): Gate[] {
  const doc = app.doc;
  if (!doc) return [];
  const spec = (doc.meta.spec ?? {}) as Spec;
  const overrides = (doc.meta.gateOverrides ?? {}) as Record<string, string>;
  const nodes = [...doc.nodes.values()];
  const hasSch = nodes.some((n) => n.type === 'sheet');
  const elements = nodes.filter((n) => n.type === 'element');
  const missingReq = FIELDS.filter((f) => f.required && !(spec[f.key] ?? '').trim()).map((f) => f.label);
  const ercErr = app.erc?.violations.filter((v) => v.severity === 'error').length ?? 0;
  const drcErr = app.drc?.violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length ?? 0;
  const unrouted = app.ratsnest.lines.length;
  const placeholders = elements.filter((e) => e.props.placeholder).length;
  const noMpn = elements.filter((e) => !e.props.MPN && !e.props['Manufacturer Part Number'] && !e.props.LCSC).length;
  const g = (id: string, title: string, ok: boolean, okText: string, todoText: string, blocked = false): Gate => {
    if (ok) return { id, title, state: 'ok', detail: okText };
    if (overrides[id]) return { id, title, state: 'override', detail: todoText, reason: overrides[id] };
    return { id, title, state: blocked ? 'blocked' : 'todo', detail: todoText };
  };
  const gates: Gate[] = [
    g('requirements', '1 · Requirements', missingReq.length === 0, 'All required fields filled', `Missing: ${missingReq.join(', ')}`),
    g('schematic', '2 · Schematic', hasSch && ercErr === 0, 'ERC clean', hasSch ? `${ercErr} ERC error(s)` : 'No schematic yet'),
    g('components', '3 · Components', elements.length > 0 && placeholders === 0 && noMpn === 0, 'Every part has a footprint and part number', `${placeholders} placeholder footprint(s), ${noMpn} part(s) without MPN`),
    g('layout', '4 · Layout', elements.length > 0 && drcErr === 0 && unrouted === 0, 'DRC clean and fully routed', `${drcErr} DRC error(s), ${unrouted} unrouted connection(s)`),
    g('review', '5 · Review', false, '', 'Design review with collaborators arrives with collaboration (phase 4)'),
  ];
  const earlier = gates.every((x) => x.state === 'ok' || x.state === 'override');
  gates.push({ id: 'fabrication', title: '6 · Fabrication', state: earlier ? 'ok' : 'todo', detail: earlier ? 'Ready to export' : 'Earlier stages still open (export is still allowed)' });
  return gates;
}

export function mountProject(app: App, root: HTMLElement): void {
  const render = () => {
    clear(root);
    const doc = app.doc;
    if (!doc) {
      root.append(h('div', { class: 'empty' }, 'No project open.'), h('button', { onclick: () => app.newProject() }, 'New project'));
      return;
    }
    const spec = (doc.meta.spec ?? {}) as Spec;
    root.append(h('div', { class: 'section-title' }, h('span', {}, 'Stages')));
    for (const gate of computeGates(app)) {
      const icon = gate.state === 'ok' ? '●' : gate.state === 'override' ? '◐' : '○';
      root.append(
        h(
          'div',
          { class: `gate ${gate.state}` },
          h('span', { class: 'gate-icon' }, icon),
          h(
            'div',
            { style: 'flex:1;min-width:0' },
            h('div', { class: 'gate-title' }, gate.title),
            h('div', { class: 'dim', style: 'font-size:11.5px' }, gate.detail),
            gate.reason ? h('div', { style: 'font-size:11.5px;color:var(--accent)' }, `Override: ${gate.reason}`) : null,
          ),
          gate.state === 'todo' && gate.id !== 'fabrication' && gate.id !== 'review'
            ? h('button', {
                style: 'padding:0 6px;font-size:11px',
                title: 'Move on anyway, with a reason that is kept in the project',
                onclick: () => {
                  const reason = prompt(`Why is it OK to move past “${gate.title}”?`);
                  if (!reason?.trim()) return;
                  app.apply('Override gate', [{ op: 'setMeta', key: 'gateOverrides', value: { ...((doc.meta.gateOverrides ?? {}) as object), [gate.id]: reason.trim() } }]);
                },
              }, 'override')
            : gate.state === 'override'
              ? h('button', {
                  style: 'padding:0 6px;font-size:11px',
                  onclick: () => {
                    const o = { ...((doc.meta.gateOverrides ?? {}) as Record<string, string>) };
                    delete o[gate.id];
                    app.apply('Clear override', [{ op: 'setMeta', key: 'gateOverrides', value: o }]);
                  },
                }, 'clear')
              : null,
        ),
      );
    }
    root.append(h('div', { class: 'section-title' }, h('span', {}, 'Requirements')));
    for (const f of FIELDS) {
      const input = f.multiline ? h('textarea', { rows: '2', placeholder: f.hint, spellcheck: 'true' }) : h('input', { placeholder: f.hint, spellcheck: 'true' });
      input.value = spec[f.key] ?? '';
      input.addEventListener('change', () => {
        const next = { ...spec, [f.key]: input.value };
        app.apply(`Edit ${f.label.toLowerCase()}`, [{ op: 'setMeta', key: 'spec', value: next }]);
      });
      root.append(h('label', { class: 'spec-field' }, h('span', {}, f.label, f.required ? h('span', { style: 'color:var(--accent)' }, ' *') : ''), input));
    }
  };
  for (const ev of ['doc', 'change', 'drc'] as const) app.on(ev, render);
  render();
}
