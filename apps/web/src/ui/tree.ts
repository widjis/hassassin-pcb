import type { DocNode } from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const LABEL: Partial<Record<DocNode['type'], string>> = {
  trace: 'trace', via: 'via', pad: 'pad', fill: 'pour', zone: 'zone', text: 'text', line: 'line',
  arc: 'arc', circle: 'circle', polygon: 'polygon', rectangle: 'rect', net: 'net', element: '', container: '',
};

function title(n: DocNode): string {
  if (n.type === 'pad') return `Pad ${n.props.number ?? n.name}${n.props.net ? ` · ${n.props.net}` : ''}`;
  if (n.type === 'element') return `${n.name}${n.props.Value ? `  ${n.props.Value}` : ''}`;
  return n.name || (LABEL[n.type] ?? n.type);
}

export function mountTree(app: App, root: HTMLElement, filter: HTMLInputElement): void {
  const expanded = new Set<string>();
  let filterText = '';

  const render = () => {
    clear(root);
    const doc = app.doc;
    if (!doc) {
      root.append(h('div', { class: 'empty' }, 'No board open.'));
      return;
    }
    if (filterText) {
      const q = filterText.toLowerCase();
      let shown = 0;
      for (const n of doc.nodes.values()) {
        if (!n.name.toLowerCase().includes(q) && !String(n.props.Value ?? '').toLowerCase().includes(q)) continue;
        root.append(rowFor(n, 0, false));
        if (++shown >= 400) break;
      }
      if (!shown) root.append(h('div', { class: 'empty' }, 'Nothing matches.'));
      return;
    }
    const walk = (uid: string, depth: number) => {
      const n = doc.nodes.get(uid);
      if (!n) return;
      const kids = n.children;
      root.append(rowFor(n, depth, kids.length > 0));
      if (kids.length && (expanded.has(uid) || n.type === 'root')) for (const c of kids) walk(c, depth + 1);
    };
    walk(doc.rootId, 0);
  };

  const rowFor = (n: DocNode, depth: number, hasKids: boolean) => {
    const open = expanded.has(n.uid) || n.type === 'root';
    const typeLabel = LABEL[n.type] ?? n.type;
    const el = h(
      'div',
      {
        class: `tree-row${app.selection.has(n.uid) ? ' selected' : ''}`,
        style: `padding-left:${4 + depth * 14}px`,
        'data-uid': n.uid,
        onclick: (ev: MouseEvent) => app.select([n.uid], ev.shiftKey || ev.metaKey || ev.ctrlKey),
      },
      h(
        'span',
        {
          class: 'twisty',
          onclick: (ev: MouseEvent) => {
            if (!hasKids) return;
            ev.stopPropagation();
            open ? expanded.delete(n.uid) : expanded.add(n.uid);
            render();
          },
        },
        hasKids ? (open ? '▾' : '▸') : '',
      ),
      h('span', {}, title(n)),
      typeLabel && n.type !== 'pad' ? h('span', { class: 'type' }, typeLabel) : null,
      hasKids ? h('span', { class: 'count' }, String(n.children.length)) : null,
    );
    return el;
  };

  let pending = 0;
  app.on('change', () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      render();
    });
  });

  filter.addEventListener('input', () => {
    filterText = filter.value.trim();
    render();
  });

  app.on('doc', () => {
    expanded.clear();
    const doc = app.doc;
    if (doc) for (const c of doc.nodes.get(doc.rootId)?.children ?? []) expanded.add(c);
    render();
  });
  app.on('selection', () => {
    const doc = app.doc;
    if (!doc) return;
    for (const uid of app.selection) {
      let p = doc.nodes.get(uid)?.parent;
      while (p) {
        expanded.add(p);
        p = doc.nodes.get(p)?.parent ?? null;
      }
    }
    render();
    const first = [...app.selection][0];
    if (first) root.querySelector(`[data-uid="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  render();
}
