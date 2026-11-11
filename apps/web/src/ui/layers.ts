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
  };
  app.on('doc', render);
  app.on('layers', render);
  render();
}
