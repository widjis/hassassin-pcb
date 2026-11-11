import { newUid } from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

export function mountRules(app: App, root: HTMLElement): void {
  const render = () => {
    clear(root);
    const doc = app.doc;
    const engine = app.engine;
    if (!doc || !engine) {
      root.append(h('div', { class: 'empty' }, 'No board open.'));
      return;
    }
    const counts = new Map(engine.rulesetMatches().map((m) => [m.ruleset.id, m]));
    const current = app.inspected.kind === 'ruleset' ? app.inspected.id : null;

    const row = (id: string, name: string, selector: string, enabled: boolean) => {
      const m = counts.get(id);
      return h(
        'div',
        { class: `rs-row${current === id ? ' selected' : ''}${m?.error ? ' err' : ''}`, onclick: () => app.inspectRuleset(id) },
        h('div', { class: 'meta' }, h('span', {}, name, enabled ? '' : ' (off)'), h('span', { class: 'dim' }, m?.error ? 'error' : `${m?.count ?? 0} matched`)),
        h('div', { class: 'sel' }, selector || '(empty selector)'),
      );
    };

    root.append(
      h(
        'div',
        { class: 'section-title' },
        h('span', {}, 'Project rulesets'),
        h(
          'button',
          {
            onclick: () => {
              const id = newUid('rs');
              app.updateRulesets('New ruleset', (list) =>
                list.push({ id, name: `Ruleset ${list.length + 1}`, selector: 'trace', rules: [], enabled: true, origin: 'project' }),
              );
              app.inspectRuleset(id);
            },
          },
          '+ New',
        ),
      ),
    );
    if (!doc.rulesets.length) root.append(h('div', { class: 'dim', style: 'padding:2px 4px 8px' }, 'None yet. Rulesets apply rules to every object their selector matches.'));
    for (const rs of doc.rulesets) root.append(row(rs.id, rs.name, rs.selector, rs.enabled));

    root.append(h('div', { class: 'section-title' }, h('span', {}, 'Defaults (read-only)')));
    for (const rs of doc.defaults) root.append(row(rs.id, rs.name, rs.selector, rs.enabled));
  };
  app.on('doc', render);
  app.on('rules', render);
  app.on('change', render);
  app.on('inspect', render);
  render();
}
