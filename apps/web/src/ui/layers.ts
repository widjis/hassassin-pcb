import { classColors, NET_COLOR_MODES, netColorMap, netColorMode, netSignals, type NetColorMode, type SignalClass } from '@hassassin/core';
import type { App } from '../app.ts';
import { cssColor, layerColor } from '../render/colors.ts';
import { HOLES } from '../render/scene.ts';
import { clear, h } from './dom.ts';

const GROUPS: { title: string; test: (kind: string) => boolean }[] = [
  { title: 'Copper', test: (k) => k === 'copper' },
  { title: 'Silkscreen & outline', test: (k) => k === 'silk' || k === 'edge' },
  { title: 'Mask & paste', test: (k) => k === 'mask' || k === 'paste' || k === 'adhesive' },
  { title: 'Fabrication', test: (k) => k === 'fab' || k === 'courtyard' },
  { title: 'Other', test: (k) => k === 'user' },
];

export function mountLayers(app: App, root: HTMLElement): void {
  const render = () => {
    clear(root);
    if (!app.layers.length) {
      root.append(h('div', { class: 'empty' }, 'Open a board to see its layers.'));
      return;
    }
    const row = (name: string, label: string) => {
      const on = app.visible.has(name);
      return h(
        'div',
        { class: `layer-row${on ? '' : ' off'}`, title: name, onclick: () => app.setLayerVisible(name, !on) },
        h('span', { class: 'swatch', style: `background:${cssColor(layerColor(name === HOLES ? 'Edge.Cuts' : name))}` }),
        h('span', { class: 'name' }, label),
        h('span', { class: 'eye' }, on ? 'shown' : 'hidden'),
      );
    };
    for (const g of GROUPS) {
      const ls = app.layers.filter((l) => g.test(l.kind));
      if (!ls.length) continue;
      root.append(h('div', { class: 'layer-group' }, g.title));
      for (const l of ls) root.append(row(l.name, l.userName && l.userName !== l.name ? `${l.name} · ${l.userName}` : l.name));
      if (g.title === 'Copper') root.append(row(HOLES, 'Drill holes'));
    }
    // ---- Net colours (P17): mode, a colour per signal class and per net.
    const doc = app.doc;
    if (!doc) return;
    const mode = netColorMode(doc);
    root.append(h('div', { class: 'layer-group' }, 'Net colours'));
    const modeSel = h('select', { style: 'width:100%', title: 'Layer colours: copper in its layer colour. Net colours on copper: tracks, vias, pads and pours of a coloured net in its colour (other layers dimmed). Ratsnest only: just the unrouted connections.' }, ...NET_COLOR_MODES.map((m) => h('option', { value: m.mode, ...(m.mode === mode ? { selected: true } : {}) }, m.label)));
    modeSel.addEventListener('change', () => app.setNetColorMode(modeSel.value as NetColorMode));
    root.append(
      h('div', { style: 'display:grid;gap:6px;padding:4px 2px 8px' }, modeSel, h('button', { title: 'Give every net without a colour one from a palette of easily told apart colours, and show them on the copper', onclick: () => app.colourEveryNet() }, 'Colour every net')),
    );
    const swatch = (value: string | undefined, on: (c: string | null) => void, title: string) => {
      const inp = h('input', { type: 'color', value: value ?? '#888888', title, style: `width:26px;height:18px;padding:0;border:none;background:none;${value ? '' : 'opacity:0.35'}` }) as HTMLInputElement;
      inp.addEventListener('change', () => on(inp.value));
      const clr = h('button', { title: 'No colour of its own', style: 'padding:0 5px;font-size:11px', onclick: () => on(null) }, '×');
      return [inp, value ? clr : null];
    };
    const cls = classColors(doc);
    const sigs = netSignals(doc);
    const used = [...new Set(sigs.map((x) => x.signal))].filter((c) => c !== 'general').sort();
    if (used.length) {
      root.append(h('div', { class: 'dim', style: 'font-size:11px;padding:2px' }, 'Signal classes'));
      for (const c of used) root.append(h('div', { class: 'layer-row', style: 'cursor:default' }, ...swatch(cls[c as SignalClass], (v) => app.setClassColor(c as SignalClass, v), `Colour of the ${c} class`), h('span', { class: 'name' }, c), h('span', { class: 'eye' }, `${sigs.filter((x) => x.signal === c).length} net(s)`)));
    }
    const own = new Map([...doc.nodes.values()].filter((n) => n.type === 'net' && n.name !== '(no net)').map((n) => [n.name, n.props.color] as const));
    const shown = netColorMap(doc);
    root.append(h('div', { class: 'dim', style: 'font-size:11px;padding:2px' }, `Nets (${own.size})`));
    const list = h('div', { style: 'max-height:260px;overflow:auto' });
    for (const name of [...own.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const mine = typeof own.get(name) === 'string' ? (own.get(name) as string) : undefined;
      const [inp, clr] = swatch(mine ?? shown.get(name), (v) => app.setNetColor(name, v), mine ? `Colour of ${name}` : shown.get(name) ? `${name} takes its class colour; pick one of its own` : `Give ${name} a colour`);
      list.append(h('div', { class: 'layer-row', style: 'cursor:default' }, inp!, h('span', { class: 'name', title: name }, name), mine ? clr! : h('span', { class: 'eye' }, shown.get(name) ? 'class' : '')));
    }
    root.append(list);
  };
  app.on('doc', render);
  app.on('layers', render);
  // Net colours change with the board (a colour set, a net added).
  let t = 0;
  app.on('change', () => (clearTimeout(t), (t = window.setTimeout(render, 300))));
  render();
}
