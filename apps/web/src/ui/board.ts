/**
 * Board panel: automatic placement and routing, signal classes of the nets (P16), the stackup with an
 * impedance calculator, and routed lengths (differential pairs, length-match groups) with length tuning.
 */
import {
  defaultStackup,
  diffImpedance,
  diffPairs,
  withCoupling,
  impedance,
  lengthGroups,
  lineGeometry,
  netLengths,
  netSignals,
  planAutoplace,
  planSignalClasses,
  SIGNAL_CLASSES,
  planAutoroute,
  planTune,
  runDrc,
  stackupOf,
  stringifyDoc,
  type Op,
  widthForImpedance,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';
import type { RouteMessage, RouteRequest } from '../routeWorker.ts';

export function mountBoard(app: App, root: HTMLElement): void {
  let calc = { layer: '', width: 0.25, gap: 0.15, target: 50, diff: false };
  // The autorouter runs in a Web Worker (P8g); the panel is redrawn on every change, so its state lives here.
  let job: { worker: Worker; changed: boolean } | null = null;
  let routeMsg = '';
  let statusEl: HTMLElement | null = null;
  const setMsg = (m: string) => {
    routeMsg = m;
    if (statusEl) statusEl.textContent = m;
  };
  const stopJob = () => {
    job?.worker.terminate();
    job = null;
  };
  const startRoute = () => {
    const doc = app.doc;
    if (!doc || job) return;
    const worker = new Worker(new URL('../routeWorker.ts', import.meta.url), { type: 'module' });
    job = { worker, changed: false };
    const t0 = performance.now();
    setMsg('Routing…');
    worker.onmessage = (e: MessageEvent<RouteMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        const s = ((performance.now() - t0) / 1000).toFixed(0);
        setMsg(m.stage === 'check' ? `Checking the result with DRC… ${s} s` : `Routing: ${m.routed}/${m.total} connections, round ${(m.round ?? 0) + 1} · ${s} s`);
        return;
      }
      const changed = job?.changed;
      stopJob();
      if (m.type === 'error') return void (setMsg(`Autoroute failed: ${m.message}`), render());
      if (changed) return void (setMsg('The board changed while routing, so nothing was applied. Run Autoroute again.'), render());
      const r = m.summary;
      if (m.ops.length) app.apply('Autoroute', m.ops as Op[]);
      const reasons = Object.entries(r.reasons).map(([k, n]) => `${n} × ${k}`).join('; ');
      setMsg(
        `Routed ${r.routed} connection(s), ${r.vias} via(s), ${r.totalLength} mm in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
          `${m.removed ? `; ${m.removed} left out after the DRC check` : ''}${r.failed.length ? `; ${r.failed.length} not routed (${reasons}, see Review)` : ''}. Refill pours (B) next.`,
      );
      app.runDrcSoon(0);
      render();
    };
    worker.onerror = (e) => {
      stopJob();
      setMsg(`Autoroute failed: ${e.message}`);
      render();
    };
    const req: RouteRequest = { doc: stringifyDoc(doc), copper: app.copper };
    worker.postMessage(req);
    render();
  };

  const render = () => {
    clear(root);
    const doc = app.doc;
    const engine = app.engine;
    if (!doc || !engine) {
      root.append(h('div', { class: 'empty' }, 'Open a board first.'));
      return;
    }
    // ---- automatic placement & routing
    const status = h('div', { class: 'dim', style: 'font-size:11.5px;min-height:1em;flex-shrink:0' }, routeMsg);
    statusEl = status;
    root.append(
      h('div', { class: 'section-title' }, h('span', {}, 'Automatic')),
      h(
        'div',
        { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', {
          title: 'Move parts that are not on the board yet onto it, connected parts close together',
          onclick: () => {
            // On the main thread: one shorter improvement run (the tool and the CLI do three full ones).
            const n = [...doc.nodes.values()].filter((x) => x.type === 'element').length;
            const { ops, report } = planAutoplace(doc, engine, app.copper, { restarts: 1, iterations: Math.min(300000, 5000 * n) });
            if (!ops.length) return setMsg(report.failed.length ? `No room for: ${report.failed.join(', ')}` : 'Every part is already on the board.');
            app.apply('Auto-place parts', ops);
            const r = report.ratsnest;
            setMsg(`Placed ${report.placed.length} part(s)${r ? `; ratsnest ${r.greedy} → ${r.improved} mm` : ''}${report.decoupling?.length ? `; ${report.decoupling.length} decoupling cap(s) at their IC` : ''}${report.failed.length ? `; no room for ${report.failed.join(', ')}` : ''}.`);
          },
        }, 'Auto-place'),
        job
          ? h('button', { title: 'Stop routing; the board stays as it is', onclick: () => (stopJob(), setMsg('Autoroute cancelled; nothing changed.'), render()) }, 'Cancel')
          : h('button', { title: 'Route the unrouted connections (45°, vias, clearances kept), checked with DRC before it is applied. Runs in the background; undo removes it in one step.', onclick: startRoute }, 'Autoroute'),
      ),
      status,
    );

    // ---- signal classes (P16)
    const st = stackupOf(doc, app.copper);
    const sigs = netSignals(doc);
    const netNode = new Map([...doc.nodes.values()].filter((n) => n.type === 'net').map((n) => [n.name, n]));
    const counts = new Map<string, number>();
    for (const x of sigs) counts.set(x.signal, (counts.get(x.signal) ?? 0) + 1);
    const pending = sigs.filter((x) => x.source !== 'net' && (netNode.get(x.net)?.props.signal ?? 'general') !== x.signal).length;
    const sigStatus = h('div', { class: 'dim', style: 'font-size:11.5px;min-height:1em;flex-shrink:0' });
    const applyClasses = () => {
      const top = st.layers.find((l) => l.kind === 'copper');
      const plan = planSignalClasses(doc, { stackup: st, engine, ...(top ? { copperMm: top.thickness, layer: top.name } : {}) });
      if (!plan.ops.length) return void (sigStatus.textContent = 'The nets already carry these classes.');
      app.apply('Classify nets', plan.ops);
      const notes = plan.rules.filter((r) => r.note || r.kept).map((r) => `${r.net}: ${r.note ?? `kept your ${r.kept!.join(', ')}`}`);
      app.say(`Classes applied${notes.length ? `. ${notes.join(' · ')}` : '.'}`);
    };
    const setNet = (net: string, cls: string) => {
      const n = netNode.get(net);
      if (!n) return;
      app.apply(`Signal class ${net}`, [
        { op: 'setProp', uid: n.uid, key: 'signal', value: cls || null },
        { op: 'setProp', uid: n.uid, key: 'signalSource', value: cls ? 'net' : null },
      ]);
    };
    root.append(
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, `Signal classes · ${[...counts].filter(([c]) => c !== 'general').map(([c, k]) => `${k} ${c}`).join(', ') || 'all general'}`)),
      h(
        'div',
        { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
        h('button', { title: 'Write the classes below onto the nets, so the per-class rules (width, clearance, via cost, corner style) apply. Classes you set here are kept.', onclick: applyClasses }, pending ? `Apply ${pending} class change(s)` : 'Apply classes'),
        h('span', { class: 'dim', style: 'font-size:11.5px' }, `${counts.get('general') ?? 0} general net(s) not listed`),
      ),
      sigStatus,
    );
    const sigList = h('div', { class: 'len-list', style: 'flex-shrink:0' });
    for (const x of sigs) {
      if (x.signal === 'general' && x.source !== 'net') continue;
      const sel = h('select', { title: 'Set the class by hand (overrides the pins); "auto" goes back to the pins and guesses' });
      sel.append(h('option', { value: '' }, 'auto'));
      for (const c of SIGNAL_CLASSES) sel.append(h('option', { value: c, ...(x.source === 'net' && c === x.signal ? { selected: true } : {}) }, c));
      if (x.source !== 'net') (sel as HTMLSelectElement).value = '';
      sel.addEventListener('change', () => setNet(x.net, (sel as HTMLSelectElement).value));
      const applied = (netNode.get(x.net)?.props.signal ?? 'general') === x.signal;
      const params = [x.current ? `${x.current} A` : '', x.voltage ? `${x.voltage} V` : '', x.impedance ? `${x.impedance} Ω` : '', x.frequency ? `${x.frequency} MHz` : '', x.interface ?? '', x.pair ? `↔ ${x.pair}` : ''].filter(Boolean).join(' ');
      sigList.append(
        h(
          'div',
          { class: 'len-row', title: `${x.source === 'net' ? 'Set by hand on the net' : `${x.source === 'guess' ? 'Guessed' : 'From a pin'}: ${x.why}`}${applied ? '' : ' (not applied yet)'}` },
          h('span', { class: 'ellipsis', style: 'flex:1' }, x.net),
          h('span', { class: applied ? '' : 'dim', style: x.source === 'guess' ? 'font-style:italic' : '' }, `${x.signal}${params ? ` · ${params}` : ''}`),
          sel,
        ),
      );
    }
    root.append(sigList);

    // ---- stackup
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
    const lens = netLengths(doc, engine, st).filter((l) => l.segments);
    const pairs = withCoupling(doc, engine, diffPairs(lens));
    const groups = lengthGroups(lens);
    root.append(h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, `Lengths · ${pairs.length} pair(s)`)));
    // Tune `net` with a serpentine to match `other` (in time when the stackup gives delays), bumps away
    // from it; the first candidate without a new DRC error is kept (P10).
    const tune = (net: string, other: string, partner: string | undefined = other) => {
      const before = runDrc(doc, engine, app.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
      const cur = lens.find((l) => l.net === net)!;
      const m = lens.find((l) => l.net === other)!;
      const extra = cur.delay !== undefined && m.delay !== undefined && cur.length > 0 ? (m.delay - cur.delay) / (cur.delay / cur.length) : m.length - cur.length;
      const plan = planTune(doc, engine, net, extra, partner ? { partner } : {});
      if (!plan.candidates.length) return app.say(plan.error ?? `Nothing to tune on ${net}`);
      for (const c of plan.candidates) {
        app.apply(`Tune length ${net}`, c.ops);
        const after = runDrc(doc, engine, app.copper).violations.filter((v) => v.severity === 'error' && v.kind !== 'unrouted').length;
        if (after <= before) return app.say(`${net}: +${c.added} mm`);
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
          h('span', { class: p.skew > 0.15 ? 'err-text' : 'dim', title: 'Skew in length, and in time from each layer\'s propagation delay' }, `skew ${p.skew.toFixed(2)} mm${p.skewPs !== undefined ? ` · ${p.skewPs.toFixed(1)} ps` : ''}`),
          p.uncoupled !== undefined ? h('span', { class: p.uncoupledMax !== undefined && p.uncoupled > p.uncoupledMax ? 'err-text' : 'dim', title: `Side by side at the pair gap: ${p.coupled!.toFixed(2)} mm. Uncoupled: the longer half's length apart from its partner${p.uncoupledMax !== undefined ? ` (rule diffUncoupledMax ${p.uncoupledMax} mm)` : ''}` }, `uncoupled ${p.uncoupled.toFixed(2)} mm`) : null,
          p.skew > 0.05 ? h('button', { onclick: () => tune(short, long), title: `Add a serpentine to ${short} to match ${long}` }, 'Match') : null,
        ),
      );
    }
    for (const g of groups) {
      // Match: every net of the group that lags its slowest net (in time when delays are known) is tuned up to it.
      const t = (n: { length: number; delay?: number }) => (g.spreadPs !== undefined ? n.delay! : n.length);
      const slow = g.nets.reduce((a, b) => (t(b) > t(a) ? b : a));
      const matchAll = () => {
        for (const n of g.nets) if (n.net !== slow.net && slow.length - n.length > 0.05) tune(n.net, slow.net, pairs.find((q) => q.p === n.net)?.n ?? pairs.find((q) => q.n === n.net)?.p);
      };
      root.append(
        h(
          'div',
          { class: 'len-row' },
          h('strong', {}, g.group),
          h('span', { class: 'dim' }, `${g.nets.length} nets`),
          h('span', { class: g.spread > 0.5 ? 'err-text' : 'dim' }, `spread ${g.spread.toFixed(2)} mm${g.spreadPs !== undefined ? ` · ${g.spreadPs.toFixed(1)} ps` : ''}`),
          g.spread > 0.05 ? h('button', { onclick: matchAll, title: `Add serpentines to the shorter nets to match ${slow.net}` }, 'Match') : null,
        ),
      );
    }
    const list = h('div', { class: 'len-list', style: 'flex-shrink:0' });
    for (const l of lens.sort((a, b) => b.length - a.length).slice(0, 60)) list.append(h('div', { class: 'len-row' }, h('span', { class: 'ellipsis' }, l.net), h('span', { class: 'dim' }, `${l.length.toFixed(2)} mm${l.vias ? ` · ${l.vias} via` : ''}`)));
    root.append(list);
  };
  let t = 0;
  const later = () => {
    clearTimeout(t);
    t = window.setTimeout(() => root.offsetParent && render(), 300);
  };
  app.on('doc', () => {
    if (job) job.changed = true;
    render();
  });
  app.on('change', () => {
    if (job) job.changed = true;
    later();
  });
  render();
  (root as HTMLElement & { refresh?: () => void }).refresh = render;
}
