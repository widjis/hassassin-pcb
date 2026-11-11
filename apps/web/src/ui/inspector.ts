import {
  formatRuleValue,
  parseRuleValue,
  parseSelector,
  RULE_DEFS,
  type Computed,
  type DocNode,
  type Ruleset,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const ORDER = [...RULE_DEFS.keys()];
const label = (name: string) => RULE_DEFS.get(name)?.label ?? name;
const TYPE_NAME: Partial<Record<DocNode['type'], string>> = {
  element: 'Component', pad: 'Pad', trace: 'Trace', via: 'Via', net: 'Net', fill: 'Copper pour', zone: 'Keep-out zone',
  layout: 'Board', container: 'Folder', text: 'Text', line: 'Line', arc: 'Arc', circle: 'Circle', polygon: 'Polygon', rectangle: 'Rectangle', root: 'Project',
};

export function mountInspector(app: App, root: HTMLElement): void {
  let mode: 'computed' | 'specified' = 'computed';

  const unit = () => {
    const u = app.engine?.get(app.doc?.rootId ?? '', 'displayUnit')?.value;
    return typeof u === 'string' ? u : 'mm';
  };

  const sourceLine = (c: Computed) => {
    const s = c.source;
    const tags: (HTMLElement | string)[] = [];
    if (s.important) tags.push(h('span', { class: 'tag important' }, '!important'));
    if (s.kind === 'object') tags.push(h('span', { class: 'tag object' }, 'this object'));
    if (s.kind === 'ruleset' || s.kind === 'default') {
      tags.push(h('span', { class: `tag ${s.kind}` }, s.kind === 'default' ? 'default' : 'ruleset'));
      tags.push(h('a', { onclick: () => s.rulesetId && app.inspectRuleset(s.rulesetId) }, s.rulesetName ?? ''), ` · ${s.selector ?? ''}`);
    }
    if (s.kind === 'inherited') {
      const from = s.fromUid ? app.node(s.fromUid) : undefined;
      tags.push(h('span', { class: 'tag inherited' }, 'inherited'), 'from ', h('a', { onclick: () => s.fromUid && app.select([s.fromUid]) }, from?.name || from?.type || '?'));
    }
    return h('div', { class: 'src' }, ...tags);
  };

  const renderNode = (n: DocNode) => {
    const engine = app.engine!;
    const box = h('div', { class: 'insp' });
    box.append(h('div', {}, h('div', { class: 'kind' }, TYPE_NAME[n.type] ?? n.type), h('h2', {}, n.name || TYPE_NAME[n.type] || n.type)));

    const props = Object.entries(n.props).filter(([, v]) => v !== '');
    const kv = h('div', { class: 'kv' });
    if (n.type === 'net' && app.doc) {
      let pads = 0;
      for (const x of app.doc.nodes.values()) if (x.type === 'pad' && x.props.net === n.name) pads++;
      const count = (t: string) => n.children.filter((c) => app.node(c)?.type === t).length;
      props.push(['Pads', pads], ['Traces', count('trace')], ['Vias', count('via')], ['Pours', count('fill')]);
    }
    for (const [k, v] of props) kv.append(h('div', { class: 'k', title: k }, k), h('div', { class: 'v' }, String(v)));
    kv.append(h('div', { class: 'k' }, 'UID'), h('div', { class: 'v dim', style: 'font-size:11px' }, n.uid));
    box.append(kv);

    const seg = h(
      'div',
      { class: 'seg' },
      h('button', { class: mode === 'computed' ? 'on' : '', onclick: () => ((mode = 'computed'), render()) }, 'Computed'),
      h('button', { class: mode === 'specified' ? 'on' : '', onclick: () => ((mode = 'specified'), render()) }, 'Specified'),
    );
    box.append(h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('strong', {}, 'Layout rules'), seg));

    const list = h('div', { class: 'rules' });
    const u = unit();
    if (mode === 'computed') {
      const computed = engine.of(n.uid);
      const names = [...computed.keys()].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
      for (const name of names) {
        const c = computed.get(name)!;
        list.append(h('div', { class: 'rule' }, h('span', { class: 'label' }, label(name)), h('span', { class: 'val' }, formatRuleValue(name, c.value, u)), sourceLine(c)));
      }
      if (!names.length) list.append(h('div', { class: 'dim' }, 'No rules apply.'));
    } else {
      for (const r of n.rules) {
        list.append(
          h('div', { class: 'rule' }, h('span', { class: 'label' }, label(r.name), r.important ? ' !important' : ''), h('span', { class: 'val' }, formatRuleValue(r.name, r.value, u))),
        );
      }
      if (!n.rules.length) list.append(h('div', { class: 'dim' }, 'Nothing set directly on this object.'));
    }
    box.append(list);
    return box;
  };

  const renderRuleset = (rs: Ruleset) => {
    const engine = app.engine!;
    const editable = rs.origin === 'project';
    const m = engine.rulesetMatches().find((x) => x.ruleset.id === rs.id);
    const box = h('div', { class: 'insp' });
    box.append(h('div', {}, h('div', { class: 'kind' }, editable ? 'Ruleset' : 'Default ruleset'), h('h2', {}, rs.name)));
    if (rs.description) box.append(h('div', { class: 'dim' }, rs.description));

    const kv = h('div', { class: 'kv editable' });
    if (editable) {
      const name = h('input', { value: rs.name, spellcheck: 'false' });
      name.addEventListener('change', () => {
        rs.name = name.value.trim() || rs.name;
        app.rulesChanged();
      });
      kv.append(h('div', { class: 'k' }, 'Name'), name);
    }
    const sel = h('input', { value: rs.selector, spellcheck: 'false', disabled: !editable });
    const selErr = h('div', { class: 'err-text' }, m?.error ?? '');
    sel.addEventListener('input', () => {
      try {
        parseSelector(sel.value);
        sel.classList.remove('bad');
        selErr.textContent = '';
        app.runQuery(sel.value, false);
      } catch (e) {
        sel.classList.add('bad');
        selErr.textContent = (e as Error).message;
      }
    });
    sel.addEventListener('change', () => {
      rs.selector = sel.value.trim();
      app.rulesChanged();
      app.inspectRuleset(rs.id);
    });
    kv.append(h('div', { class: 'k' }, 'Selector'), h('div', {}, sel, selErr));
    kv.append(h('div', { class: 'k' }, 'Matches'), h('div', {}, m?.error ? 'selector error' : `${m?.count ?? 0} objects (highlighted)`));
    if (editable) {
      const en = h('input', { type: 'checkbox', style: 'width:auto' });
      en.checked = rs.enabled;
      en.addEventListener('change', () => {
        rs.enabled = en.checked;
        app.rulesChanged();
      });
      kv.append(h('div', { class: 'k' }, 'Enabled'), h('div', {}, en));
    }
    box.append(kv);

    box.append(h('strong', {}, 'Rules'));
    const list = h('div', { class: 'rules' });
    const u = unit();
    rs.rules.forEach((r, i) => {
      list.append(
        h(
          'div',
          { class: 'rule' },
          h('span', { class: 'label' }, label(r.name), r.important ? ' !important' : ''),
          h(
            'span',
            { class: 'val' },
            formatRuleValue(r.name, r.value, u),
            editable
              ? h('button', { style: 'margin-left:6px;padding:0 6px', title: 'Remove', onclick: () => (rs.rules.splice(i, 1), app.rulesChanged()) }, '×')
              : null,
          ),
        ),
      );
    });
    if (!rs.rules.length) list.append(h('div', { class: 'dim' }, 'No rules yet.'));
    box.append(list);

    if (editable) {
      const pick = h('select', {});
      for (const d of RULE_DEFS.values()) if (d.kind !== 'points') pick.append(h('option', { value: d.name }, d.label));
      const val = h('input', { placeholder: 'e.g. 0.4mm', spellcheck: 'false' });
      const imp = h('input', { type: 'checkbox', title: '!important', style: 'width:auto' });
      const err = h('div', { class: 'err-text' });
      const add = () => {
        try {
          const value = parseRuleValue(pick.value, val.value);
          const decl = { name: pick.value, value, ...(imp.checked ? { important: true } : {}) };
          const i = rs.rules.findIndex((r) => r.name === pick.value);
          if (i >= 0) rs.rules[i] = decl;
          else rs.rules.push(decl);
          app.rulesChanged();
        } catch (e) {
          err.textContent = (e as Error).message;
        }
      };
      val.addEventListener('keydown', (e) => e.key === 'Enter' && add());
      const help = h('div', { class: 'dim', style: 'font-size:11.5px' }, RULE_DEFS.get(pick.value)?.help ?? '');
      pick.addEventListener('change', () => (help.textContent = RULE_DEFS.get(pick.value)?.help ?? ''));
      box.append(
        h('div', { class: 'editable add-rule' }, pick, val, h('button', { onclick: add }, 'Add')),
        h('label', { class: 'dim', style: 'display:flex;gap:6px;align-items:center;font-size:12px' }, imp, 'Mark as !important'),
        help,
        err,
        h(
          'button',
          {
            style: 'align-self:flex-start;color:var(--danger)',
            onclick: () => {
              const doc = app.doc!;
              doc.rulesets = doc.rulesets.filter((r) => r.id !== rs.id);
              app.inspected = { kind: 'none' };
              app.runQuery('', false);
              app.rulesChanged();
            },
          },
          'Delete ruleset',
        ),
      );
    }
    return box;
  };

  const renderNone = () => {
    const box = h('div', { class: 'insp' });
    if (!app.doc) {
      box.append(h('div', { class: 'empty' }, 'Open a board, then click anything to inspect it.'));
      return box;
    }
    box.append(h('div', {}, h('div', { class: 'kind' }, 'Board'), h('h2', {}, app.fileName)));
    const kv = h('div', { class: 'kv' });
    const s = app.stats;
    for (const [k, v] of [
      ['Components', s.footprints], ['Pads', s.pads], ['Nets', s.nets], ['Traces', (s.traces ?? 0) + (s.arcs ?? 0)],
      ['Vias', s.vias], ['Pours & zones', s.zones], ['Copper layers', app.copper.length], ['Objects', app.doc.nodes.size],
    ] as const) kv.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v ?? 0)));
    box.append(kv);
    box.append(
      h(
        'div',
        { class: 'dim', style: 'font-size:12px' },
        'Click to select a component, Cmd/Ctrl+click to pick a single pad or shape. Drag to pan, scroll to zoom, F flips the board, Home fits it. Type a selector in the top bar to highlight matches.',
      ),
    );
    return box;
  };

  const render = () => {
    clear(root);
    const i = app.inspected;
    if (i.kind === 'node') {
      const n = app.node(i.uid);
      root.append(n ? renderNode(n) : renderNone());
    } else if (i.kind === 'ruleset') {
      const rs = app.doc && [...app.doc.rulesets, ...app.doc.defaults].find((r) => r.id === i.id);
      root.append(rs ? renderRuleset(rs) : renderNone());
    } else root.append(renderNone());
  };
  app.on('doc', render);
  app.on('inspect', render);
  render();
}
