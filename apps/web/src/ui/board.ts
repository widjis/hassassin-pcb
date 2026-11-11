/**
 * Board panel: automatic placement and routing, the stackup with an impedance calculator,
 * and routed lengths (differential pairs, length-match groups) with length tuning.
 */
import {
  defaultStackup,
  diffImpedance,
  diffPairs,
  impedance,
  lengthGroups,
  lineGeometry,
  netLengths,
  planAutoplace,
  planAutoroute,
  planMeander,
  runDrc,
  stackupOf,
  widthForImpedance,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

export function mountBoard(app: App, root: HTMLElement): void {
  let calc = { layer: '', width: 0.25, gap: 0.15, target: 50, diff: false };

  const render = () => {
    clear(root);
    const doc = app.doc;
    const engine = app.engine;
    if (!doc || !engine) {
      root.append(h('div', { class: 'empty' }, 'Open a board first.'));
      return;
    }
    // ---- automatic placement & routing
    const status = h('div', { class: 'dim', style: 'font-size:11.5px;min-height:1em' });
    root.append(
      h('div', { class: 'section-title' }, h('span', {}, 'Automatic')),
      h(
        'div',
        { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', {
          title: 'Move parts that are not on the board yet onto it, connected parts close together',
          onclick: () => {
            const { ops, report } = planAutoplace(doc, engine, app.copper);
            if (!ops.length) return (status.textContent = report.failed.length ? `No room for: ${report.failed.join(', ')}` : 'Every part is already on the board.');
            app.apply('Auto-place parts', ops);
            status.textContent = `Placed ${report.placed.length} part(s)${report.failed.length ? `; no room for ${report.failed.join(', ')}` : ''}.`;
          },
        }, 'Auto-place'),
        h('button', {
          title: 'Route the unrouted connections (45°, vias, clearances kept). Undo removes it in one step.',
          onclick: () => {
            status.textContent = 'Routing…';
            setTimeout(() => {
              const { ops, report } = planAutoroute(doc, engine, app.copper);
              if (ops.length) app.apply('Autoroute', ops);
              const vias = report.routed.reduce((s, r) => s + r.vias, 0);
              status.textContent = `Routed ${report.routed.length} connection(s), ${vias} via(s) in ${(report.ms / 1000).toFixed(1)} s${report.failed.length ? `; ${report.failed.length} could not be routed (see Review)` : ''}. Refill pours (B) next.`;
              app.runDrcSoon(0);
            }, 20);
          },
        }, 'Autoroute'),
      ),
      status,
    );

    // ---- stackup
    const st = stackupOf(doc, app.copper);
    const custom = !!doc.meta.stackup;
    const thick = h('select', {});
    for (const t of ['0.8', '1.0', '1.2', '1.6', '2.0']) thick.append(h('option', { value: t, ...(Math.abs(Number(t) - st.thickness) < 0.05 ? { selected: true } : {}) }, `${t} mm`));
    const flexBox = h('input', { type: 'checkbox', style: 'width:auto' });
    flexBox.checked = st.layers.some((l) => l.flex);
    const applyPreset = () => app.apply('Set stackup', [{ op: 'setMeta', key: 'stackup', value: defaultStackup(app.copper, Number(thick.value), { flex: flexBox.checked }) }]);
    thick.addEventListener('change', applyPreset);
    flexBox.addEventListener('change', applyPreset);
    const table = h('table', { class: 'stack' });
    for (const l of st.layers) {
      const er = h('input', { value: l.er !== undefined ? String(l.er) : '', style: 'width:42px', title: 'Relative permittivity' });
      const th = h('input', { value: String(l.thickness), style: 'width:54px', title: 'Thickness (mm)' });
      const edit = () => {
        const layers = st.layers.map((x) => (x === l ? { ...x, thickness: Number(th.value) || x.thickness, ...(er.value ? { er: Number(er.value) } : {}) } : x));
        app.apply('Edit stackup', [{ op: 'setMeta', key: 'stackup', value: { layers, thickness: +layers.reduce((s, x) => s + x.thickness, 0).toFixed(3) } }]);
      };
      th.addEventListener('change', edit);
      er.addEventListener('change', edit);
      table.append(h('tr', { class: l.kind }, h('td', {}, l.name), h('td', { class: 'dim' }, l.material ?? ''), h('td', {}, th), h('td', {}, l.kind === 'copper' ? '' : er)));
    }
    root.append(
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, `Stackup · ${st.thickness} mm${custom ? '' : ' (default)'}`)),
      h('div', { style: 'display:flex;gap:8px;align-items:center;font-size:12px' }, 'Preset', thick, h('label', { style: 'display:flex;gap:4px;align-items:center' }, flexBox, 'flex (polyimide)')),
      table,
    );

    // ---- impedance calculator
    if (!calc.layer || !app.copper.includes(calc.layer)) calc.layer = app.copper[0] ?? 'F.Cu';
    const layerSel = h('select', {});
    for (const c of app.copper) layerSel.append(h('option', { value: c, ...(c === calc.layer ? { selected: true } : {}) }, c));
    const wIn = h('input', { type: 'number', step: '0.01', value: String(calc.width), style: 'width:64px' });
    const gIn = h('input', { type: 'number', step: '0.01', value: String(calc.gap), style: 'width:64px' });
    const tIn = h('input', { type: 'number', step: '1', value: String(calc.target), style: 'width:56px' });
    const dIn = h('input', { type: 'checkbox', style: 'width:auto' });
    dIn.checked = calc.diff;
    const out = h('div', { style: 'font-size:12px' });
    const compute = () => {
      calc = { layer: layerSel.value, width: Number(wIn.value), gap: Number(gIn.value), target: Number(tIn.value), diff: dIn.checked };
      const g = lineGeometry(st, calc.layer);
      if (!g) return void (out.textContent = 'Layer not in stackup');
      const z = calc.diff ? diffImpedance(g, calc.width, calc.gap) : impedance(g, calc.width);
      const wt = widthForImpedance(g, calc.target, calc.diff ? calc.gap : undefined);
      out.textContent = `${g.kind}, h ${g.h.toFixed(3)} mm, Er ${g.er.toFixed(2)} → ${calc.diff ? 'Zdiff' : 'Z0'} ≈ ${z.toFixed(1)} Ω · for ${calc.target} Ω use ${wt === null ? '(out of range)' : `${wt} mm`}`;
    };
    for (const el of [layerSel, wIn, gIn, tIn, dIn]) el.addEventListener('input', compute);
    root.append(
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, 'Impedance (estimate ±10 %)')),
      h('div', { class: 'imp-grid' }, h('span', {}, 'Layer'), layerSel, h('span', {}, 'Width'), wIn, h('label', { style: 'display:flex;gap:4px;align-items:center' }, dIn, 'Pair, gap'), gIn, h('span', {}, 'Target Ω'), tIn),
      out,
    );
    compute();

    // ---- lengths
    const lens = netLengths(doc, engine).filter((l) => l.segments);
    const pairs = diffPairs(lens);
    const groups = lengthGroups(lens);
    root.append(h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, `Lengths · ${pairs.length} pair(s)`)));
    const tune = (net: string, target: number) => {
      const before = runDrc(doc, engine, app.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
      const cur = lens.find((l) => l.net === net)!.length;
      for (const side of [1, -1] as const) {
        const plan = planMeander(doc, engine, net, target - cur, { side });
        if (plan.error) return app.say(plan.error);
        app.apply(`Tune length ${net}`, plan.ops);
        const after = runDrc(doc, engine, app.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
        if (after <= before) return app.say(`${net}: +${plan.added} mm`);
        app.undo();
      }
      app.say(`A serpentine on ${net} would break clearance; tune it by hand.`);
    };
    for (const p of pairs) {
      const [short, long] = p.lengthP < p.lengthN ? [p.p, p.n] : [p.n, p.p];
      root.append(
        h(
          'div',
          { class: 'len-row' },
          h('strong', {}, p.name),
          h('span', { class: 'dim' }, `${p.lengthP.toFixed(2)} / ${p.lengthN.toFixed(2)} mm`),
          h('span', { class: p.skew > 0.15 ? 'err-text' : 'dim' }, `skew ${p.skew.toFixed(2)}`),
          p.skew > 0.05 ? h('button', { onclick: () => tune(short, Math.max(p.lengthP, p.lengthN)), title: `Add a serpentine to ${short} to match ${long}` }, 'Match') : null,
        ),
      );
    }
    for (const g of groups) root.append(h('div', { class: 'len-row' }, h('strong', {}, g.group), h('span', { class: 'dim' }, `${g.nets.length} nets`), h('span', { class: g.spread > 0.5 ? 'err-text' : 'dim' }, `spread ${g.spread.toFixed(2)} mm`)));
    const list = h('div', { class: 'len-list' });
    for (const l of lens.sort((a, b) => b.length - a.length).slice(0, 60)) list.append(h('div', { class: 'len-row' }, h('span', { class: 'ellipsis' }, l.net), h('span', { class: 'dim' }, `${l.length.toFixed(2)} mm${l.vias ? ` · ${l.vias} via` : ''}`)));
    root.append(list);
  };
  let t = 0;
  const later = () => {
    clearTimeout(t);
    t = window.setTimeout(() => root.offsetParent && render(), 300);
  };
  app.on('doc', render);
  app.on('change', later);
  render();
  (root as HTMLElement & { refresh?: () => void }).refresh = render;
}
