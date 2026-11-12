/**
 * Parts panel: search the library (project, generic, team, installed KiCad libraries),
 * preview symbol + footprint, place parts, and manage the project's parts as a BOM
 * (footprint, MPN, supplier offers, cost for N boards).
 */
import {
  applyOffersOps,
  arcPoints,
  buildBom,
  footprintBox,
  fpKey,
  parseOffersCsv,
  partKey,
  setPartPropsOps,
  storePartOps,
  type FootprintSpec,
  type FpPad,
  type Op,
  type PartDef,
  type PartSummary,
  type PartUnit,
  type Vec2,
} from '@hassassin/core';
import { parseKicadFootprint, parseKicadSymbolLib } from '@hassassin/kicad-import';
import type { App } from '../app.ts';
import { library, serverLibrary } from '../library.ts';
import { clear, h } from './dom.ts';
import { openSymbolEditor } from './symbolEditor.ts';
import { openFootprintGenerator } from './footprintGen.ts';

const SRC_LABEL: Record<string, string> = { generic: 'generic', project: 'project', kicad: 'KiCad', team: 'team' };

function fit(c: HTMLCanvasElement, box: { minX: number; minY: number; maxX: number; maxY: number }) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 140;
  const hgt = c.clientHeight || 120;
  c.width = w * dpr;
  c.height = hgt * dpr;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const bw = Math.max(0.5, box.maxX - box.minX);
  const bh = Math.max(0.5, box.maxY - box.minY);
  const s = Math.min((w - 16) / bw, (hgt - 16) / bh);
  const ox = w / 2 - ((box.minX + box.maxX) / 2) * s;
  const oy = hgt / 2 - ((box.minY + box.maxY) / 2) * s;
  return { ctx, s, P: (p: Vec2) => [ox + p.x * s, oy + p.y * s] as const };
}

export function drawFootprint(c: HTMLCanvasElement, fp: FootprintSpec): void {
  const { ctx, s, P } = fit(c, footprintBox(fp));
  const css = getComputedStyle(document.documentElement);
  const silk = css.getPropertyValue('--text').trim() || '#ddd';
  for (const g of fp.graphics) {
    if (!/SilkS|Fab|CrtYd/.test(g.layer)) continue;
    ctx.strokeStyle = g.layer.includes('Silk') ? silk : g.layer.includes('CrtYd') ? '#c6a' : '#777';
    ctx.globalAlpha = g.layer.includes('Silk') ? 1 : 0.6;
    ctx.lineWidth = Math.max(1, ('w' in g ? g.w : 0.1) * s);
    ctx.beginPath();
    if (g.kind === 'line') (ctx.moveTo(...P(g.a)), ctx.lineTo(...P(g.b)));
    else if (g.kind === 'rect') {
      const [x0, y0] = P(g.a);
      const [x1, y1] = P(g.b);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    } else if (g.kind === 'circle') ctx.arc(...P(g.c), g.r * s, 0, Math.PI * 2);
    else if (g.kind === 'arc') arcPoints(g.s, g.m, g.e).forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    else if (g.kind === 'poly') g.pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    else continue;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const pad = (p: FpPad) => {
    ctx.save();
    ctx.translate(...P(p.at));
    ctx.rotate((-(p.rot ?? 0) * Math.PI) / 180);
    const w = p.size.x * s;
    const hh = p.size.y * s;
    ctx.fillStyle = p.type === 'npth' ? '#555' : p.layers.some((l) => l.startsWith('B.')) && !p.layers.some((l) => l.startsWith('F.') || l.startsWith('*')) ? '#5b8de0' : '#d8a03a';
    ctx.beginPath();
    if (p.shape === 'circle') ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    else if (p.shape === 'oval' || p.shape === 'roundrect') ctx.roundRect(-w / 2, -hh / 2, w, hh, p.shape === 'oval' ? Math.min(w, hh) / 2 : Math.min(w, hh) * (p.cornerRatio ?? 0.25));
    else if (p.shape === 'custom' && p.points?.length) p.points.forEach((q, i) => (i ? ctx.lineTo(q.x * s, q.y * s) : ctx.moveTo(q.x * s, q.y * s)));
    else ctx.rect(-w / 2, -hh / 2, w, hh);
    ctx.fill();
    if (p.drill !== undefined) {
      const d = typeof p.drill === 'number' ? { x: p.drill, y: p.drill } : p.drill;
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.ellipse(0, 0, (d.x / 2) * s, (d.y / 2) * s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (p.number && Math.min(w, hh) > 9) {
      ctx.fillStyle = '#111';
      ctx.font = `${Math.min(11, Math.min(w, hh) * 0.6)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.number, 0, 0);
    }
    ctx.restore();
  };
  fp.pads.forEach(pad);
}

export function drawSymbol(c: HTMLCanvasElement, u: PartUnit): void {
  const pts: Vec2[] = [];
  const dir = (a: number) => ({ x: Math.cos((a * Math.PI) / 180), y: -Math.sin((a * Math.PI) / 180) });
  for (const p of u.pins) {
    const d = dir(p.angle);
    pts.push(p.at, { x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length });
  }
  for (const g of u.graphics) {
    if (g.t === 'rect') pts.push(g.a, g.b);
    else if (g.t === 'poly') pts.push(...g.pts);
    else if (g.t === 'circle') pts.push({ x: g.c.x - g.r, y: g.c.y - g.r }, { x: g.c.x + g.r, y: g.c.y + g.r });
    else if (g.t === 'arc') pts.push(g.s, g.m, g.e);
  }
  const box = pts.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  if (!Number.isFinite(box.minX)) return;
  const { ctx, s, P } = fit(c, box);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--text').trim() || '#ddd';
  ctx.strokeStyle = ink;
  ctx.fillStyle = 'rgba(242,169,59,0.12)';
  for (const g of u.graphics) {
    ctx.lineWidth = Math.max(1, ('w' in g ? g.w : 0.15) * s);
    ctx.beginPath();
    if (g.t === 'rect') {
      const [x0, y0] = P(g.a);
      const [x1, y1] = P(g.b);
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
    } else if (g.t === 'poly') g.pts.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    else if (g.t === 'circle') ctx.arc(...P(g.c), g.r * s, 0, Math.PI * 2);
    else if (g.t === 'arc') arcPoints(g.s, g.m, g.e).forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
    else continue;
    if ('fill' in g && g.fill) ctx.fill();
    ctx.stroke();
  }
  ctx.strokeStyle = '#4fd6a6';
  ctx.lineWidth = 1;
  for (const p of u.pins) {
    if (p.hidden) continue;
    const d = dir(p.angle);
    ctx.beginPath();
    ctx.moveTo(...P(p.at));
    ctx.lineTo(...P({ x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length }));
    ctx.stroke();
  }
}

function pickFile(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const i = h('input', { type: 'file', accept, ...(multiple ? { multiple: true } : {}) });
    i.addEventListener('change', () => resolve([...(i.files ?? [])]));
    i.click();
  });
}

export interface PartsHooks {
  place: (part: PartDef, extra: Op[]) => void;
  /** Edit link of the shared project, for publishing to the team library. */
  shareAuth: () => { project: string; token: string; author: string } | null;
}

export function mountParts(app: App, root: HTMLElement, hooks: PartsHooks): void {
  let query = '';
  let results: PartSummary[] = [];
  let selected: PartDef | null = null;
  let selFp: FootprintSpec | null = null;
  let boards = 10;
  let seq = 0;

  const search = async () => {
    const my = ++seq;
    results = await library.searchParts(app.doc, query, 40);
    if (my === seq) renderResults();
  };

  const searchBox = h('input', { placeholder: 'Search parts: "ldo 3.3", "esp32", "resistor"…', type: 'search' });
  let t = 0;
  searchBox.addEventListener('input', () => {
    query = searchBox.value;
    clearTimeout(t);
    t = window.setTimeout(search, 200);
  });
  const status = h('div', { class: 'dim', style: 'font-size:11px;margin:2px 0 6px' });
  const resultsEl = h('div', { class: 'part-results' });
  const detailEl = h('div', {});
  const bomEl = h('div', {});
  root.append(
    h('div', { class: 'section-title' }, h('span', {}, 'Library'), h('button', { class: 'btn', title: 'Make a symbol from a pin table (e.g. pasted from a datasheet)', onclick: () => openSymbolEditor(app, { onPlace: (def) => hooks.place(def, []) }) }, 'New symbol…'), h('button', { class: 'btn', title: 'Make a footprint from datasheet dimensions (two rows, four sides, grid, castellated module, pad list)', onclick: () => openFootprintGenerator(app) }, 'New footprint…')),
    searchBox,
    status,
    resultsEl,
    detailEl,
    bomEl,
  );

  serverLibrary.check().then((ok) => {
    status.textContent = ok ? `Sources: project · generic · ${serverLibrary.sources.map((s) => SRC_LABEL[s] ?? s).join(' · ')}` : 'Sources: project · generic (start the server for the team library and installed KiCad libraries)';
  });

  const select = async (s: PartSummary) => {
    selected = await library.getPart(app.doc, s.id);
    selFp = selected?.footprint ? await library.getFootprint(app.doc, selected.footprint) : null;
    renderDetail();
  };

  function renderResults() {
    clear(resultsEl);
    for (const r of results) {
      resultsEl.append(
        h(
          'div',
          { class: `part-row${selected?.id === r.id ? ' on' : ''}`, onclick: () => select(r), title: r.description ?? '' },
          h('span', { class: `src src-${r.source.split(':')[0]}` }, SRC_LABEL[r.source.split(':')[0]!] ?? r.source),
          h('strong', {}, r.name),
          h('span', { class: 'dim ellipsis' }, r.description ?? r.footprint ?? ''),
        ),
      );
    }
    if (!results.length) resultsEl.append(h('div', { class: 'empty' }, 'No parts found.'));
  }

  function renderDetail() {
    clear(detailEl);
    if (!selected) return;
    const p = selected;
    const symC = h('canvas', { class: 'preview' });
    const fpC = h('canvas', { class: 'preview' });
    const fpSel = h('select', {});
    for (const f of [...new Set([p.footprint, ...(p.footprints ?? [])].filter(Boolean))] as string[]) {
      const o = h('option', { value: f }, f);
      if (f === selFp?.name || f === p.footprint) o.selected = true;
      fpSel.append(o);
    }
    fpSel.addEventListener('change', async () => {
      selFp = await library.getFootprint(app.doc, fpSel.value);
      if (selFp) drawFootprint(fpC, selFp);
    });
    detailEl.append(
      h(
        'div',
        { class: 'part-detail' },
        h('div', {}, h('strong', {}, p.name), p.units.length > 1 ? h('span', { class: 'dim' }, ` · ${p.units.length} units`) : null),
        p.description ? h('div', { class: 'dim', style: 'font-size:11.5px' }, p.description) : null,
        h('div', { class: 'previews' }, symC, fpC),
        h('div', { class: 'dim', style: 'font-size:11.5px' }, `${p.units.reduce((n, u) => n + u.pins.length, 0)} pins · footprint `, fpSel.options.length ? fpSel : h('em', {}, 'none')),
        p.footprint && !selFp ? h('div', { class: 'err-text', style: 'font-size:11.5px' }, 'Footprint not found here; the board will get a placeholder until you choose one.') : null,
        p.properties?.Datasheet && /^https?:/.test(p.properties.Datasheet) ? h('a', { href: p.properties.Datasheet, target: '_blank', rel: 'noopener', style: 'font-size:11.5px' }, 'Datasheet ↗') : null,
        h(
          'div',
          { style: 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap' },
          h('button', {
            class: 'btn primary',
            onclick: () => {
              const fpName = fpSel.value || p.footprint;
              const part = { ...p, ...(fpName ? { footprint: fpName } : {}) };
              hooks.place(part, app.doc ? storePartOps(app.doc, p, selFp ? { ...selFp, name: fpName! } : null) : []);
            },
          }, 'Place on schematic'),
          app.doc?.meta[`part:${p.id}`]
            ? h('button', { title: 'Change pins, sides and units of this symbol; placed copies follow', onclick: () => openSymbolEditor(app, { def: app.doc!.meta[`part:${p.id}`] as PartDef, onPlace: (def) => hooks.place(def, []) }) }, 'Edit symbol…')
            : null,
          hooks.shareAuth() && p.source !== 'generic'
            ? h('button', {
                onclick: async () => {
                  const auth = hooks.shareAuth()!;
                  const r = await fetch('/api/library/parts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...auth, part: p, footprint: selFp }) });
                  const d = await r.json().catch(() => ({}));
                  app.say(r.ok ? `Published ${d.part.id} (v${d.part.version}) to the team library.` : `Could not publish: ${d.error ?? r.status}`);
                },
                title: 'Share this part (and its footprint) with everyone on this server',
              }, 'Publish to team')
            : null,
        ),
      ),
    );
    requestAnimationFrame(() => {
      if (p.units[0]) drawSymbol(symC, p.units[0]);
      if (selFp) drawFootprint(fpC, selFp);
    });
    renderResults();
  }

  const assignFootprint = async (ref: string, name: string) => {
    const doc = app.doc;
    if (!doc || !name) return;
    const fp = await library.getFootprint(doc, name);
    if (!fp) return app.say(`Footprint “${name}” not found. Try a generic name like chip-0603, soic-8, header-1x04-p2.54.`);
    const ops: Op[] = [];
    if (fp.source !== 'generic' && !doc.meta[fpKey(name)]) ops.push({ op: 'setMeta', key: fpKey(name), value: { ...fp, name } });
    const hasSym = [...doc.nodes.values()].some((n) => n.type === 'symbol' && String(n.props.ref ?? n.name) === ref);
    ops.push(...setPartPropsOps(doc, ref, { Footprint: name }).filter((o) => !(hasSym && o.op === 'setProp' && doc.nodes.get(o.uid)?.type === 'element')));
    if (app.apply(`Footprint ${ref} → ${name}`, ops) && hasSym) await app.syncToPcb();
  };

  function renderBom() {
    clear(bomEl);
    const doc = app.doc;
    if (!doc) return;
    const bom = buildBom(doc, boards);
    const boardsIn = h('input', { type: 'number', min: '1', value: String(boards), style: 'width:64px' });
    boardsIn.addEventListener('change', () => ((boards = Math.max(1, Number(boardsIn.value) || 1)), renderBom()));
    const total = Object.entries(bom.total).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ') || '—';
    bomEl.append(
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, `Parts in this project (${bom.lines.reduce((n, l) => n + l.qty, 0)})`)),
      h('div', { style: 'display:flex;gap:6px;align-items:center;font-size:12px;flex-wrap:wrap' }, 'Boards', boardsIn, h('span', { class: 'dim' }, `parts cost ${total}`)),
      h(
        'div',
        { class: 'dim', style: 'font-size:11px;margin:4px 0' },
        [bom.missingMpn && `${bom.missingMpn} without MPN`, bom.noOffer && `${bom.noOffer} without price data`, bom.shortStock && `${bom.shortStock} short on stock`].filter(Boolean).join(' · ') || 'Every line has an MPN and a priced offer.',
      ),
    );
    const fpList = h('datalist', { id: 'fpNames' });
    bomEl.append(fpList);
    for (const line of bom.lines) {
      const ref0 = line.refs[0]!;
      const fpIn = h('input', { value: line.footprint, list: 'fpNames', title: 'Footprint (generic name, project footprint, or Lib:Name)' });
      fpIn.addEventListener('focus', async () => {
        clear(fpList);
        for (const f of await library.searchFootprints(doc, fpIn.value.split(':').pop()?.split(/[_-]/)[0] ?? '', 40)) fpList.append(h('option', { value: f.name }));
      });
      fpIn.addEventListener('change', async () => {
        for (const r of line.refs) await assignFootprint(r, fpIn.value.trim());
      });
      const mpnIn = h('input', { value: line.mpn, placeholder: 'MPN' });
      mpnIn.addEventListener('change', () => app.apply(`MPN ${line.refs.join(',')}`, line.refs.flatMap((r) => setPartPropsOps(doc, r, { MPN: mpnIn.value.trim() || null }))));
      const best = line.best;
      bomEl.append(
        h(
          'div',
          { class: `bom-line${line.issues.length ? ' issue' : ''}` },
          h('div', { class: 'bom-head' }, h('strong', { title: line.refs.join(', ') }, line.refs.length > 3 ? `${line.refs.slice(0, 3).join(', ')} +${line.refs.length - 3}` : line.refs.join(', ')), h('span', {}, line.value), h('span', { class: 'dim' }, `×${line.qty}`)),
          h('div', { class: 'bom-fields' }, fpIn, mpnIn),
          best
            ? h('div', { class: 'dim', style: 'font-size:11px' }, `${best.supplier}${best.sku ? ` ${best.sku}` : ''}: ${best.unit} ${best.currency}/pc · ${best.total.toFixed(2)} ${best.currency}${best.stock !== undefined ? ` · stock ${best.stock}` : ''}${best.updatedAt ? ` · as of ${best.updatedAt}` : ''}`)
            : null,
          line.issues.length ? h('div', { class: 'err-text', style: 'font-size:11px' }, line.issues.join(' · ')) : null,
        ),
      );
      void ref0;
    }
    bomEl.append(
      h(
        'div',
        { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px' },
        h('button', {
          title: 'CSV with MPN, Supplier, SKU, Stock, Currency and Price@qty columns (e.g. a distributor BOM-tool export)',
          onclick: async () => {
            const [f] = await pickFile('.csv,text/csv', false);
            if (!f) return;
            try {
              const { ops, matched, unmatched } = applyOffersOps(doc, parseOffersCsv(await f.text()));
              app.apply('Import supplier offers', ops);
              app.say(`Offers for ${matched.length} part number(s)${unmatched.length ? `; ${unmatched.length} not used in this project` : ''}.`);
            } catch (e) {
              app.say(`Could not read CSV: ${(e as Error).message}`);
            }
          },
        }, 'Import offers (CSV)'),
        h('button', {
          title: 'Copy symbols (.kicad_sym) and footprints (.kicad_mod) into this project',
          onclick: async () => {
            const files = await pickFile('.kicad_sym,.kicad_mod', true);
            const ops: Op[] = [];
            let parts = 0;
            let fps = 0;
            for (const f of files) {
              try {
                const text = await f.text();
                if (/\.kicad_sym$/i.test(f.name)) {
                  for (const p of parseKicadSymbolLib(text, f.name.replace(/\.kicad_sym$/i, '')).parts) {
                    ops.push({ op: 'setMeta', key: partKey(p.id), value: { ...p, source: 'project' } });
                    parts++;
                  }
                } else {
                  const fp = parseKicadFootprint(text, 'Local');
                  ops.push({ op: 'setMeta', key: fpKey(fp.name), value: { ...fp, source: 'project' } });
                  fps++;
                }
              } catch (e) {
                app.say(`${f.name}: ${(e as Error).message}`);
              }
            }
            if (ops.length && app.apply('Import KiCad library', ops)) app.say(`Imported ${parts} part(s) and ${fps} footprint(s) into the project.`);
            search();
          },
        }, 'Import KiCad library'),
      ),
    );
  }

  let bomTimer = 0;
  const later = () => {
    clearTimeout(bomTimer);
    bomTimer = window.setTimeout(renderBom, 150);
  };
  app.on('doc', () => (search(), renderBom()));
  app.on('change', later);
  app.on('parts', () => (searchBox.focus(), search()));
  search();
  renderBom();
}
