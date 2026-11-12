import { ERC_LABEL, unwaiveOp, VIOLATION_LABEL, waiveOp, type ErcKind, type ErcViolation, type Violation, type ViolationKind } from '@hassassin/core';
import { openErcSettings } from './ercSettings.ts';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const ORDER: ViolationKind[] = ['short', 'clearance', 'outsideBoard', 'edgeClearance', 'traceWidth', 'holeSize', 'unrouted', 'noOutline'];

export function mountReview(app: App, root: HTMLElement, badge: HTMLElement, focusErc: (v: ErcViolation) => void): void {
  const open = new Set<string>(['short', 'clearance', 'erc:unconnectedPin', 'erc:driverConflict', 'erc:powerNotDriven']);
  let showWarnings = true;

  const render = () => {
    clear(root);
    const r = app.drc;
    const erc = app.erc?.violations ?? [];
    const errs = (r?.violations.filter((v) => v.severity === 'error').length ?? 0) + erc.filter((v) => v.severity === 'error').length;
    const warns = (r?.violations.length ?? 0) + erc.length - errs;
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
          h('button', { onclick: () => openErcSettings(app), title: 'Pin-type matrix, how each check reports, power symbols' }, 'ERC settings…'),
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
    // Schematic (ERC)
    if (app.erc) {
      root.append(h('div', { class: 'section-title', style: 'margin-top:10px' }, h('span', {}, 'Schematic (ERC)'), h('span', { class: 'dim' }, erc.length ? String(erc.length) : 'clean')));
      const eg = new Map<ErcKind, ErcViolation[]>();
      for (const v of erc) {
        if (!showWarnings && v.severity === 'warning') continue;
        (eg.get(v.kind) ?? eg.set(v.kind, []).get(v.kind)!).push(v);
      }
      for (const [kind, list] of eg) {
        const key = `erc:${kind}`;
        const isOpen = open.has(key);
        root.append(
          h('div', { class: 'rv-group', onclick: () => (isOpen ? open.delete(key) : open.add(key), render()) }, h('span', { class: 'twisty' }, isOpen ? '▾' : '▸'), h('span', { class: `dot ${list[0]!.severity}` }), h('span', {}, ERC_LABEL[kind]), h('span', { class: 'count' }, String(list.length))),
        );
        if (!isOpen) continue;
        for (const v of list.slice(0, 300)) {
          const waive = h('button', { class: 'waive', title: 'Accept this one with a reason: it no longer counts, and the reason is kept in the project' }, 'Waive');
          waive.addEventListener('click', (e) => {
            e.stopPropagation();
            const reason = prompt(`Why is this acceptable?\n\n${v.message}`)?.trim();
            if (reason && app.doc) app.apply(`Waive ${ERC_LABEL[v.kind].toLowerCase()}`, [waiveOp(app.doc, v.id, reason, undefined, v.message)]);
          });
          root.append(h('div', { class: `rv-item${app.focusedViolation === v.id ? ' selected' : ''}`, onclick: () => focusErc(v) }, waive, h('div', {}, v.message)));
        }
      }
      // Waived: listed with their reason, and can be counted again.
      const waived = app.erc.waived ?? [];
      if (waived.length) {
        const key = 'erc:waived';
        const isOpen = open.has(key);
        root.append(h('div', { class: 'rv-group', onclick: () => (isOpen ? open.delete(key) : open.add(key), render()) }, h('span', { class: 'twisty' }, isOpen ? '▾' : '▸'), h('span', {}, 'Waived'), h('span', { class: 'count' }, String(waived.length))));
        if (isOpen)
          for (const v of waived) {
            const undo = h('button', { class: 'waive', title: 'Count this violation again' }, 'Unwaive');
            undo.addEventListener('click', (e) => {
              e.stopPropagation();
              if (app.doc) app.apply('Remove waiver', [unwaiveOp(app.doc, v.id)]);
            });
            root.append(h('div', { class: 'rv-item waived', onclick: () => focusErc(v) }, undo, h('div', {}, v.message), h('div', { class: 'reason' }, `Waived: ${v.waiver.reason}${v.waiver.by ? ` — ${v.waiver.by}` : ''}`)));
          }
      }
      root.append(h('div', { class: 'section-title', style: 'margin-top:10px' }, h('span', {}, 'Board (DRC)')));
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
