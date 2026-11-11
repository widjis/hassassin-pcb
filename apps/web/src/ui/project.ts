/**
 * Project panel: the requirements document and the stage gates
 * (requirements → schematic → components → layout → review → fabrication).
 */
import { computeGates, SPEC_FIELDS as FIELDS, type Spec } from '@hassassin/tools';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

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
    for (const gate of computeGates({ doc, erc: app.erc, drc: app.drc, ratsnest: app.ratsnest, ...(app.collab ? { blockingComments: app.comments().filter((c) => c.props.blocking && !c.props.resolved).length } : {}) })) {
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
  for (const ev of ['doc', 'change', 'drc', 'collab', 'comments'] as const) app.on(ev, render);
  render();
}
