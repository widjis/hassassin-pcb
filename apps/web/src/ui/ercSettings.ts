/**
 * ERC settings dialog (S17): the project's pin-type matrix, how each check reports, and the option
 * that makes power symbols need a source. Every change is one undoable step, shared with collaborators.
 */
import { defaultPinLevel, ERC_LABEL, ERC_PIN_TYPES, ercSettings, PIN_TYPE_LABEL, setErcOptionOp, setErcSeverityOp, setPinLevelOp, type ErcLevel, type ErcSeverityOverride, type Op } from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const NEXT: Record<ErcLevel, ErcLevel> = { ok: 'warning', warning: 'error', error: 'ok' };
const SHORT: Record<ErcLevel, string> = { ok: '', warning: 'W', error: 'E' };

export function openErcSettings(app: App): void {
  if (!app.doc) return app.say('Open or create a project first.');
  const dlg = h('dialog', { class: 'annotate-dialog erc-dialog' });
  const body = h('div', {});
  const apply = (label: string, ops: Op[]) => {
    if (app.apply(label, ops)) render();
  };
  const render = () => {
    clear(body);
    const doc = app.doc!;
    const st = ercSettings(doc);
    // Pin-type matrix (lower triangle; both orders are the same rule).
    const table = h('table', { class: 'erc-matrix' });
    const head = h('tr', {}, h('th', {}));
    ERC_PIN_TYPES.forEach((t, i) => head.append(h('th', { title: PIN_TYPE_LABEL[t] }, h('span', {}, String(i + 1)))));
    table.append(head);
    ERC_PIN_TYPES.forEach((a, i) => {
      const row = h('tr', {}, h('th', { class: 'row-head' }, `${i + 1} ${PIN_TYPE_LABEL[a]}`));
      ERC_PIN_TYPES.forEach((b, j) => {
        if (j > i) return void row.append(h('td', { class: 'blank' }));
        const level = st.level(a, b);
        const changed = level !== defaultPinLevel(a, b);
        const cell = h('td', { class: `lv ${level}${changed ? ' changed' : ''}`, title: `${PIN_TYPE_LABEL[a]} + ${PIN_TYPE_LABEL[b]}: ${level}${changed ? ` (default ${defaultPinLevel(a, b)})` : ''} — click to change` }, SHORT[level]);
        cell.addEventListener('click', () => apply(`ERC: ${a} + ${b}`, [setPinLevelOp(doc, a, b, NEXT[level])]));
        row.append(cell);
      });
      table.append(row);
    });
    // Checks
    const checks = h('div', { class: 'erc-checks' });
    for (const [kind, label] of Object.entries(ERC_LABEL)) {
      const sel = h('select', {}) as HTMLSelectElement;
      for (const [v, l] of [['default', 'As built in'], ['error', 'Error'], ['warning', 'Warning'], ['ignore', 'Ignore']] as const) sel.append(h('option', { value: v }, l));
      sel.value = st.severity[kind] ?? 'default';
      sel.addEventListener('change', () => apply(`ERC: ${kind}`, [setErcSeverityOp(doc, kind, sel.value === 'default' ? null : (sel.value as ErcSeverityOverride))]));
      checks.append(h('label', {}, h('span', {}, label), sel));
    }
    const power = h('input', { type: 'checkbox', style: 'width:auto' }) as HTMLInputElement;
    power.checked = st.powerSymbolsNeedSource;
    power.addEventListener('change', () => apply('ERC option', [setErcOptionOp(doc, 'powerSymbolsNeedSource', power.checked)]));
    const reset = h('button', { title: 'Back to the built-in matrix and checks (the defaults match KiCad)' }, 'Reset to defaults');
    reset.addEventListener('click', () => apply('ERC defaults', [{ op: 'setMeta', key: 'ercPinMatrix', value: null }, { op: 'setMeta', key: 'ercSeverity', value: null }, { op: 'setMeta', key: 'ercOptions', value: null }]));
    body.append(
      h('h3', {}, 'ERC settings'),
      h('div', { class: 'dim', style: 'font-size:12px;margin-bottom:6px' }, 'Pins of two types on one net: click a cell to change it (blank = ok, W = warning, E = error; underlined = changed). The defaults match KiCad.'),
      table,
      h('label', { class: 'erc-option' }, power, ' Power symbols need a source (a power output or PWR_FLAG on their net), as in KiCad'),
      h('div', { class: 'section-title', style: 'margin-top:10px' }, h('span', {}, 'Checks')),
      checks,
      h('div', { class: 'row', style: 'display:flex;gap:8px;justify-content:space-between;margin-top:12px' }, reset, h('button', { class: 'primary', onclick: () => dlg.close() }, 'Done')),
    );
  };
  dlg.append(body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  render();
  dlg.showModal();
}
