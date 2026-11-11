import { VIOLATION_LABEL, type Violation, type ViolationKind } from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const ORDER: ViolationKind[] = ['short', 'clearance', 'outsideBoard', 'edgeClearance', 'traceWidth', 'holeSize', 'unrouted', 'noOutline'];

export function mountReview(app: App, root: HTMLElement, badge: HTMLElement): void {
  const open = new Set<ViolationKind>(['short', 'clearance']);
  let showWarnings = true;

  const render = () => {
    clear(root);
    const r = app.drc;
    const errs = r?.violations.filter((v) => v.severity === 'error').length ?? 0;
    const warns = (r?.violations.length ?? 0) - errs;
    badge.textContent = r ? String(errs) : '';
    badge.className = `badge${errs ? ' bad' : r ? ' ok' : ''}`;
    if (!app.doc) {
      root.append(h('div', { class: 'empty' }, 'No board open.'));
      return;
    }
    root.append(
      h(
        'div',
        { class: 'review-head' },
        h('div', {}, r ? h('span', { class: errs ? 'err-text' : 'ok-text' }, errs ? `${errs} error${errs > 1 ? 's' : ''}` : 'No errors') : 'Checking…', warns ? h('span', { class: 'dim' }, ` · ${warns} warning${warns > 1 ? 's' : ''}`) : null),
        h('div', { class: 'dim', style: 'font-size:11px' }, r ? `${r.checkedShapes} copper shapes · ${Math.round(r.ms)} ms` : ''),
        h(
          'div',
          { style: 'display:flex;gap:6px;flex-wrap:wrap' },
          h('button', { onclick: () => app.runDrcNow(), title: 'Run the design rule check now' }, 'Re-check'),
          h('button', { onclick: () => app.refillPours(), title: 'Create pours from net rules and refill all pours (B)' }, 'Refill pours'),
          h(
            'label',
            { class: 'dim', style: 'display:flex;gap:4px;align-items:center;font-size:12px' },
            (() => {
              const c = h('input', { type: 'checkbox', style: 'width:auto' });
              c.checked = showWarnings;
              c.addEventListener('change', () => ((showWarnings = c.checked), render()));
              return c;
            })(),
            'warnings',
          ),
        ),
      ),
    );
    if (!r) return;
    const groups = new Map<ViolationKind, Violation[]>();
    for (const v of r.violations) {
      if (!showWarnings && v.severity === 'warning') continue;
      const g = groups.get(v.kind) ?? [];
      g.push(v);
      groups.set(v.kind, g);
    }
    if (!groups.size) root.append(h('div', { class: 'empty' }, 'The board passes every check.'));
    for (const kind of ORDER) {
      const list = groups.get(kind);
      if (!list) continue;
      const isOpen = open.has(kind);
      const sev = list[0]!.severity;
      root.append(
        h(
          'div',
          { class: 'rv-group', onclick: () => (isOpen ? open.delete(kind) : open.add(kind), render()) },
          h('span', { class: 'twisty' }, isOpen ? '▾' : '▸'),
          h('span', { class: `dot ${sev}` }),
          h('span', {}, VIOLATION_LABEL[kind]),
          h('span', { class: 'count' }, String(list.length)),
        ),
      );
      if (!isOpen) continue;
      for (const v of list.slice(0, 300)) {
        root.append(
          h(
            'div',
            { class: `rv-item${app.focusedViolation === v.id ? ' selected' : ''}`, title: 'Show on the board', onclick: () => app.focusViolation(v) },
            h('div', {}, v.message),
            v.layer ? h('div', { class: 'dim', style: 'font-size:11px' }, `${v.layer} · ${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)} mm`) : null,
          ),
        );
      }
      if (list.length > 300) root.append(h('div', { class: 'dim', style: 'padding:4px 8px' }, `…and ${list.length - 300} more`));
    }
  };
  app.on('drc', render);
  app.on('doc', render);
  render();
}
