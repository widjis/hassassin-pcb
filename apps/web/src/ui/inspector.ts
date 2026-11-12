import {
  formatRuleValue,
  parseRuleValue,
  parseSelector,
  RULE_DEFS,
  type Computed,
  type DocNode,
  type RuleDecl,
  type Ruleset,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { partDefOf, placeUnitOps, renameRefOps, setPartPropsOps, switchUnitOps, unitLetter, unitsOf, type FootprintSpec, type Op } from '@hassassin/core';
import { clear, h } from './dom.ts';
import { openSymbolEditor } from './symbolEditor.ts';
import { openFootprintGenerator } from './footprintGen.ts';

const ORDER = [...RULE_DEFS.keys()];
const label = (name: string) => RULE_DEFS.get(name)?.label ?? name;
const TYPE_NAME: Partial<Record<DocNode['type'], string>> = {
  element: 'Component', pad: 'Pad', trace: 'Trace', via: 'Via', net: 'Net', fill: 'Copper pour', zone: 'Keep-out zone',
  layout: 'Board', container: 'Folder', text: 'Text', line: 'Line', arc: 'Arc', circle: 'Circle', polygon: 'Polygon', rectangle: 'Rectangle', root: 'Project',
};

/** "Add a rule" row shared by rulesets and objects. */
function ruleAdder(onAdd: (decl: RuleDecl) => void): HTMLElement {
  const pick = h('select', {});
  for (const d of RULE_DEFS.values()) if (d.kind !== 'points') pick.append(h('option', { value: d.name }, d.label));
  pick.value = 'traceWidth';
  const val = h('input', { placeholder: 'e.g. 0.4mm', spellcheck: 'false' });
  const imp = h('input', { type: 'checkbox', title: '!important', style: 'width:auto' });
  const err = h('div', { class: 'err-text' });
  const help = h('div', { class: 'dim', style: 'font-size:11.5px' }, RULE_DEFS.get(pick.value)?.help ?? '');
  pick.addEventListener('change', () => (help.textContent = RULE_DEFS.get(pick.value)?.help ?? ''));
  const add = () => {
    try {
      const value = parseRuleValue(pick.value, val.value);
      onAdd({ name: pick.value, value, ...(imp.checked ? { important: true } : {}) });
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  val.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:4px' },
    h('div', { class: 'editable add-rule' }, pick, val, h('button', { onclick: add }, 'Set')),
    h('label', { class: 'dim', style: 'display:flex;gap:6px;align-items:center;font-size:12px' }, imp, 'Mark as !important'),
    help,
    err,
  );
}

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
      if (s.rulesetName) tags.push(` (${s.rulesetName} default)`);
    }
    return h('div', { class: 'src' }, ...tags);
  };

  /** Editable part properties of a schematic symbol (all units and the board component follow). */
  const partForm = (n: DocNode) => {
    const ref = String(n.props.ref ?? n.name);
    const form = h('div', { class: 'part-form' });
    const commit = (label: string, make: () => Op[]) => {
      try {
        const ops = make();
        if (ops.length) app.apply(label, ops);
        render();
      } catch (e) {
        app.say((e as Error).message);
        render();
      }
    };
    const field = (title: string, key: string, onSave: (v: string) => void) => {
      const input = h('input', { type: 'text', value: String(n.props[key] ?? ''), 'aria-label': title }) as HTMLInputElement;
      const save = () => {
        const v = input.value.trim();
        if (v !== String(n.props[key] ?? '')) onSave(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') ((input.value = String(n.props[key] ?? '')), input.blur());
      });
      input.addEventListener('change', save);
      form.append(h('label', { class: 'k' }, title), input);
    };
    const doc = app.doc!;
    field('Reference', 'ref', (v) => commit(`Rename ${ref} to ${v}`, () => renameRefOps(doc, ref, v)));
    for (const [title, key] of [['Value', 'Value'], ['MPN', 'MPN'], ['Manufacturer', 'Manufacturer'], ['Datasheet', 'Datasheet']] as const)
      field(title, key, (v) => commit(`${title} of ${ref}`, () => setPartPropsOps(doc, ref, { [key]: v || null })));
    // The footprint lives on the symbols; Update PCB swaps it on the board.
    field('Footprint', 'Footprint', (v) =>
      commit(`Footprint of ${ref}`, () => [...doc.nodes.values()].filter((x) => x.type === 'symbol' && String(x.props.ref ?? x.name) === ref).map((x): Op => ({ op: 'setProp', uid: x.uid, key: 'Footprint', value: v || null }))),
    );
    const dnp = h('input', { type: 'checkbox', 'aria-label': 'Do not populate' }) as HTMLInputElement;
    dnp.checked = !!n.props.dnp;
    dnp.addEventListener('change', () =>
      commit(`DNP ${ref}`, () =>
        [...doc.nodes.values()]
          .filter((x) => (x.type === 'symbol' && String(x.props.ref ?? x.name) === ref) || (x.type === 'element' && x.name === ref))
          .map((x): Op => ({ op: 'setProp', uid: x.uid, key: 'dnp', value: dnp.checked || null })),
      ),
    );
    form.append(h('label', { class: 'k' }, 'DNP'), h('label', {}, dnp, ' do not populate'));
    // Multi-unit parts: which unit this symbol is, and the units not placed yet (S12).
    const st = unitsOf(doc, n);
    if (st) {
      const current = Number(n.props.unit ?? 1) || 1;
      const sel = h('select', { 'aria-label': 'Unit' }) as HTMLSelectElement;
      for (const u of st.units) {
        const o = h('option', { value: String(u.unit) }, `${u.label}${u.placed && u.unit !== current ? ' · placed' : ''}`) as HTMLOptionElement;
        o.disabled = u.placed && u.unit !== current;
        o.selected = u.unit === current;
        sel.append(o);
      }
      sel.addEventListener('change', () => commit(`Switch ${ref} to unit ${unitLetter(Number(sel.value))}`, () => switchUnitOps(doc, app.engine!, n.uid, Number(sel.value))));
      form.append(h('label', { class: 'k' }, 'Unit'), sel);
      const missing = st.units.filter((u) => !u.placed);
      if (missing.length) {
        const row = h('div', { class: 'unit-buttons' });
        for (const u of missing)
          row.append(
            h('button', {
              title: `Place unit ${u.label} of ${ref} next to the placed units`,
              onclick: () => {
                try {
                  const r = placeUnitOps(doc, app.engine!, ref, u.unit);
                  if (app.apply(`Place unit ${unitLetter(u.unit)} of ${ref}`, r.ops)) app.select([r.uid]);
                } catch (e) {
                  app.say((e as Error).message);
                }
              },
            }, `Place ${u.label}`),
          );
        form.append(h('label', { class: 'k' }, 'Not placed'), row);
      }
    }
    // Footprint generator (S19): make one for this part, or edit the generated one it uses.
    const fpName = String(n.props.Footprint ?? '');
    const genFp = fpName ? (doc.meta[`fp:${fpName}`] as FootprintSpec | undefined) : undefined;
    form.append(
      h('label', { class: 'k' }, 'Land pattern'),
      h('div', { class: 'unit-buttons' },
        h('button', { title: 'Generate a footprint from datasheet dimensions and use it for this part', onclick: () => openFootprintGenerator(app, { ref }) }, 'New footprint…'),
        genFp?.generator ? h('button', { title: `Change the generated footprint ${fpName}`, onclick: () => openFootprintGenerator(app, { fp: genFp, ref }) }, 'Edit footprint…') : null,
      ),
    );
    const def = partDefOf(doc, n);
    if (def) form.append(h('label', { class: 'k' }, 'Symbol'), h('button', { title: 'Change pins, sides and units; every placed copy follows', onclick: () => openSymbolEditor(app, { def }) }, 'Edit symbol…'));
    return h('div', {}, h('strong', {}, 'Part'), form, h('div', { class: 'dim', style: 'font-size:11.5px;margin:-4px 0 8px' }, 'Changes apply to every unit and to the board component; a new footprint reaches the board on Update PCB.'));
  };

  const renderNode = (n: DocNode) => {
    const engine = app.engine!;
    const box = h('div', { class: 'insp' });
    box.append(h('div', {}, h('div', { class: 'kind' }, TYPE_NAME[n.type] ?? n.type), h('h2', {}, n.name || TYPE_NAME[n.type] || n.type)));

    const isPart = n.type === 'symbol' && !n.props.power;
    if (isPart) box.append(partForm(n));
    const EDITED = new Set(['ref', 'Value', 'MPN', 'Manufacturer', 'Footprint', 'Datasheet', 'dnp']);
    const props = Object.entries(n.props).filter(([k, v]) => v !== '' && !(isPart && EDITED.has(k)));
    const kv = h('div', { class: 'kv' });
    if (n.type === 'net' && app.doc) {
      let pads = 0;
      for (const x of app.doc.nodes.values()) if (x.type === 'pad' && x.props.net === n.name) pads++;
      const count = (t: string) => n.children.filter((c) => app.node(c)?.type === t).length;
      const st = app.ratsnest.nets.find((x) => x.net === n.name);
      props.push(['Pads', pads], ['Traces', count('trace')], ['Vias', count('via')], ['Pours', count('fill')], ['Status', st && st.islands > 1 ? `${st.islands - 1} connection(s) missing` : 'fully connected']);
    }
    if (n.type !== 'net') {
      const net = app.netOf(n.uid);
      if (net && n.type !== 'pad') props.unshift(['Net', net]);
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
      box.append(list);
    } else {
      for (const r of n.rules) {
        list.append(
          h(
            'div',
            { class: 'rule' },
            h('span', { class: 'label' }, label(r.name), r.important ? ' !important' : ''),
            h(
              'span',
              { class: 'val' },
              formatRuleValue(r.name, r.value, u),
              h('button', { style: 'margin-left:6px;padding:0 6px', title: 'Remove from this object', onclick: () => app.apply(`Remove ${label(r.name)}`, [{ op: 'setRule', uid: n.uid, name: r.name, decl: null }]) }, '×'),
            ),
          ),
        );
      }
      if (!n.rules.length) list.append(h('div', { class: 'dim' }, 'Nothing set directly on this object.'));
      box.append(list, h('div', { class: 'dim', style: 'font-size:11.5px' }, 'Set a rule on this object only (beats rulesets unless they are !important):'));
      box.append(ruleAdder((decl) => app.apply(`Set ${label(decl.name)}`, [{ op: 'setRule', uid: n.uid, name: decl.name, decl }])));
    }
    return box;
  };

  const renderRuleset = (rs: Ruleset) => {
    const engine = app.engine!;
    const editable = rs.origin === 'project';
    const edit = (lbl: string, fn: (r: Ruleset) => void) =>
      app.updateRulesets(lbl, (list) => {
        const r = list.find((x) => x.id === rs.id);
        if (r) fn(r);
      });
    const m = engine.rulesetMatches().find((x) => x.ruleset.id === rs.id);
    const box = h('div', { class: 'insp' });
    box.append(h('div', {}, h('div', { class: 'kind' }, editable ? 'Ruleset' : 'Default ruleset'), h('h2', {}, rs.name)));
    if (rs.description) box.append(h('div', { class: 'dim' }, rs.description));

    const kv = h('div', { class: 'kv editable' });
    if (editable) {
      const name = h('input', { value: rs.name, spellcheck: 'false' });
      name.addEventListener('change', () => edit('Rename ruleset', (r) => (r.name = name.value.trim() || r.name)));
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
      edit('Change selector', (r) => (r.selector = sel.value.trim()));
      app.inspectRuleset(rs.id);
    });
    kv.append(h('div', { class: 'k' }, 'Selector'), h('div', {}, sel, selErr));
    kv.append(h('div', { class: 'k' }, 'Matches'), h('div', {}, m?.error ? 'selector error' : `${m?.count ?? 0} objects (highlighted)`));
    if (editable) {
      const en = h('input', { type: 'checkbox', style: 'width:auto' });
      en.checked = rs.enabled;
      en.addEventListener('change', () => edit(en.checked ? 'Enable ruleset' : 'Disable ruleset', (r) => (r.enabled = en.checked)));
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
            editable ? h('button', { style: 'margin-left:6px;padding:0 6px', title: 'Remove', onclick: () => edit('Remove rule', (x) => x.rules.splice(i, 1)) }, '×') : null,
          ),
        ),
      );
    });
    if (!rs.rules.length) list.append(h('div', { class: 'dim' }, 'No rules yet.'));
    box.append(list);

    if (editable) {
      box.append(
        ruleAdder((decl) =>
          edit(`Set ${label(decl.name)}`, (r) => {
            const i = r.rules.findIndex((x) => x.name === decl.name);
            if (i >= 0) r.rules[i] = decl;
            else r.rules.push(decl);
          }),
        ),
        h(
          'button',
          {
            style: 'align-self:flex-start;color:var(--danger)',
            onclick: () => {
              app.inspected = { kind: 'none' };
              app.runQuery('', false);
              app.updateRulesets('Delete ruleset', (list) => {
                const i = list.findIndex((x) => x.id === rs.id);
                if (i >= 0) list.splice(i, 1);
              });
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
    const count = (t: string) => {
      let c = 0;
      for (const n of app.doc!.nodes.values()) if (n.type === t) c++;
      return c;
    };
    for (const [k, v] of [
      ['Components', count('element')], ['Pads', count('pad')], ['Nets', count('net')], ['Traces', count('trace')],
      ['Vias', count('via')], ['Pours', count('fill')], ['Copper layers', app.copper.length], ['Unrouted nets', app.ratsnest.unroutedNets],
      ['Missing connections', app.ratsnest.lines.length],
    ] as const) kv.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, String(v)));
    box.append(kv);
    box.append(
      app.space === 'schematic'
        ? h(
            'div',
            { class: 'dim', style: 'font-size:12px;line-height:1.6' },
            h('b', {}, 'Select'), ' click · Shift+click add · drag on empty sheet for a box (left→right: inside, right→left: touching)', h('br', {}),
            h('b', {}, 'Edit'), ' drag to move (a lone wire segment: neighbours stretch) · R rotate · X / Y mirror · Del delete · W wire (may end on a wire) · L label · A part', h('br', {}),
            h('b', {}, 'Copy'), ' Cmd/Ctrl+C copy · Cmd/Ctrl+V paste · Cmd/Ctrl+D duplicate (click to drop, Esc cancels)', h('br', {}),
            h('b', {}, 'Sheet'), ' T note at cursor · G titled box around the selection · Frame… title block · double-click a note or box title to edit', h('br', {}),
            h('b', {}, 'View'), ' middle drag or Space+drag to pan · two-finger scroll pans · wheel or pinch zooms · Home fit', h('br', {}),
            h('b', {}, 'History'), ' Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo · Cmd/Ctrl+S save',
          )
        : h(
            'div',
            { class: 'dim', style: 'font-size:12px;line-height:1.6' },
            h('b', {}, 'Select'), ' click · Cmd/Ctrl+click for a pad · drag to move · R rotate · Del delete', h('br', {}),
            h('b', {}, 'Route'), ' X · click a pad to start · V via · / corner · Esc stop · L switch layer', h('br', {}),
            h('b', {}, 'View'), ' drag empty space to pan · scroll to zoom · F flip · Home fit', h('br', {}),
            h('b', {}, 'Edit'), ' Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo · Cmd/Ctrl+S save',
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
  app.on('space', render);
  render();
}
