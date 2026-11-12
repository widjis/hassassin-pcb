/**
 * Footprint generator dialog (S19): fill in the datasheet numbers of a package, watch the land
 * pattern with its main dimensions, save it into the project (and assign it to a part).
 */
import { LEAD_MARGINS, footprintBox, generateFootprint, type FootprintParams, type FootprintSpec, type Op } from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';
import { drawFootprint } from './parts.ts';

type Family = FootprintParams['family'];
interface Field {
  key: string;
  label: string;
  kind?: 'number' | 'text' | 'select' | 'area';
  options?: string[];
  hint?: string;
  /** Shown only when this returns true for the current values. */
  when?: (v: Record<string, string>) => boolean;
}

const landOrLeads = (v: Record<string, string>) => v.source !== 'leads' && v.drill === '';
const leads = (v: Record<string, string>) => v.source === 'leads' && v.drill === '';

const FIELDS: Record<Family, Field[]> = {
  'two-row': [
    { key: 'pins', label: 'Pins' },
    { key: 'pitch', label: 'Pitch' },
    { key: 'numbering', label: 'Numbering', kind: 'select', options: ['around', 'zigzag'], hint: 'around: down the left, up the right (SOIC, DIP); zigzag: odd left, even right (headers)' },
    { key: 'drill', label: 'Drill (through-hole)', hint: 'empty for SMD' },
    { key: 'padDiameter', label: 'Pad diameter', when: (v) => v.drill !== '' },
    { key: 'source', label: 'Pads from', kind: 'select', options: ['land', 'leads'], when: (v) => v.drill === '' },
    { key: 'pad.length', label: 'Pad length', when: landOrLeads },
    { key: 'pad.width', label: 'Pad width', when: landOrLeads },
    { key: 'rowSpacing', label: 'Row spacing (pad centres)', when: (v) => v.source !== 'leads' || v.drill !== '' },
    { key: 'leads.span', label: 'Lead span E (tip to tip)', when: leads },
    { key: 'leads.length', label: 'Lead length L', when: leads },
    { key: 'leads.width', label: 'Lead width b', when: leads },
    { key: 'leads.type', label: 'Lead type', kind: 'select', options: ['gullwing', 'nolead', 'jlead'], when: leads },
  ],
  'four-side': [
    { key: 'pins', label: 'Pins' },
    { key: 'pitch', label: 'Pitch' },
    { key: 'pinsX', label: 'Pins per left side', hint: 'empty: a quarter of the pins' },
    { key: 'source', label: 'Pads from', kind: 'select', options: ['land', 'leads'] },
    { key: 'pad.length', label: 'Pad length', when: (v) => v.source !== 'leads' },
    { key: 'pad.width', label: 'Pad width', when: (v) => v.source !== 'leads' },
    { key: 'spanX', label: 'Span X (pad centres)', when: (v) => v.source !== 'leads' },
    { key: 'spanY', label: 'Span Y (pad centres)', hint: 'empty: same as X', when: (v) => v.source !== 'leads' },
    { key: 'leads.span', label: 'Lead span (tip to tip)', when: (v) => v.source === 'leads' },
    { key: 'leads.length', label: 'Lead length L', when: (v) => v.source === 'leads' },
    { key: 'leads.width', label: 'Lead width b', when: (v) => v.source === 'leads' },
    { key: 'leads.type', label: 'Lead type', kind: 'select', options: ['nolead', 'gullwing', 'jlead'], when: (v) => v.source === 'leads' },
  ],
  grid: [
    { key: 'rows', label: 'Rows' },
    { key: 'cols', label: 'Columns' },
    { key: 'pitch', label: 'Pitch' },
    { key: 'ball', label: 'Pad diameter' },
    { key: 'shape', label: 'Pad shape', kind: 'select', options: ['circle', 'rect'] },
    { key: 'skip', label: 'No ball at', kind: 'text', hint: 'e.g. A1, B2' },
  ],
  castellated: [
    { key: 'body.w', label: 'Module width' },
    { key: 'body.h', label: 'Module height' },
    { key: 'pitch', label: 'Pitch' },
    { key: 'left', label: 'Pads left' },
    { key: 'bottom', label: 'Pads bottom' },
    { key: 'right', label: 'Pads right', hint: 'empty: as left' },
    { key: 'top', label: 'Pads top' },
    { key: 'pad.length', label: 'Pad length (across the edge)' },
    { key: 'pad.width', label: 'Pad width' },
    { key: 'leftStart', label: 'Pad 1 below the top edge', hint: 'empty: column centred' },
    { key: 'bottomStart', label: 'First bottom pad from the left edge', hint: 'empty: row centred' },
    { key: 'outside', label: 'Pad reaches beyond the edge', hint: 'empty: half the pad length' },
    { key: 'drill', label: 'Half-hole drill', hint: 'only when designing the module itself' },
  ],
  pads: [{ key: 'padList', label: 'Pads (number x y w h [drill])', kind: 'area', hint: 'one pad per line, mm' }],
};

const DEFAULTS: Record<Family, Record<string, string>> = {
  'two-row': { pins: '8', pitch: '1.27', numbering: 'around', drill: '', source: 'leads', 'pad.length': '1.95', 'pad.width': '0.6', rowSpacing: '4.95', 'leads.span': '6.2', 'leads.length': '1.27', 'leads.width': '0.51', 'leads.type': 'gullwing', 'body.w': '3.9', 'body.h': '4.9' },
  'four-side': { pins: '24', pitch: '0.5', source: 'land', 'pad.length': '0.85', 'pad.width': '0.28', spanX: '3.9', 'leads.span': '4', 'leads.length': '0.5', 'leads.width': '0.3', 'leads.type': 'nolead', 'body.w': '4', 'body.h': '4', 'ep.w': '2.6', 'ep.h': '2.6' },
  grid: { rows: '8', cols: '8', pitch: '0.8', ball: '0.4', shape: 'circle', 'body.w': '7', 'body.h': '7' },
  castellated: { 'body.w': '16', 'body.h': '24', pitch: '2', left: '8', bottom: '6', 'pad.length': '1.5', 'pad.width': '0.9', leftStart: '7.5' },
  pads: { padList: '1 -1 0 1 1.2\n2 1 0 1 1.2' },
};

/** Common fields shown for every family. */
const notModule = (v: Record<string, string>) => v.__family !== 'castellated';
const COMMON: Field[] = [
  { key: 'body.w', label: 'Body width', hint: 'for outlines and courtyard', when: notModule },
  { key: 'body.h', label: 'Body height', when: notModule },
  { key: 'ep.w', label: 'Exposed pad width', hint: 'empty: none' },
  { key: 'ep.h', label: 'Exposed pad height' },
  { key: 'ep.vias', label: 'Thermal vias', kind: 'text', hint: 'drill rows cols pitch, e.g. 0.3 3 3 1.0' },
  { key: 'holes', label: 'Mounting holes', kind: 'area', hint: 'x y drill [ring] per line' },
];

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? undefined : Number(s));

/** Parameters from the form values (only the keys of this family and the common ones). */
function paramsFrom(name: string, family: Family, v: Record<string, string>): FootprintParams {
  const out: Record<string, unknown> = { name, family };
  const set = (path: string, value: unknown) => {
    const keys = path.split('.');
    let o = out;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[keys.at(-1)!] = value;
  };
  for (const f of [...FIELDS[family], ...COMMON]) {
    if (f.when && !f.when(v)) continue;
    const raw = v[f.key] ?? '';
    if (f.key === 'source' || f.key === '__family' || raw.trim() === '') continue;
    if (f.key === 'skip') set('skip', raw.split(/[\s,]+/).filter(Boolean));
    else if (f.key === 'padList')
      set('pads', raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [n, x, y, w, hh, d] = l.split(/[\s,;]+/);
        return { number: n!, x: Number(x), y: Number(y), w: Number(w), h: Number(hh), ...(d ? { drill: Number(d), shape: 'circle' } : {}) };
      }));
    else if (f.key === 'holes')
      set('holes', raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [x, y, d, ring] = l.split(/[\s,;]+/).map(Number);
        return { x: x!, y: y!, drill: d!, ...(ring ? { pad: ring } : {}) };
      }));
    else if (f.key === 'ep.vias') {
      const [d, r, c, pitch] = raw.split(/[\s,;]+/).map(Number);
      set('ep.vias', { drill: d, rows: r, cols: c, pitch });
    } else if (f.kind === 'select' || f.kind === 'text') set(f.key, raw);
    else set(f.key, num(raw));
  }
  // An exposed pad needs both sides; a body needs both too.
  const ep = out.ep as { w?: number; h?: number } | undefined;
  if (ep && (ep.w === undefined || ep.h === undefined)) delete out.ep;
  const body = out.body as { w?: number; h?: number } | undefined;
  if (body && (body.w === undefined || body.h === undefined) && family !== 'castellated') delete out.body;
  return out as unknown as FootprintParams;
}

/** Main dimensions over the preview: pad-centre spans and the pitch. */
function drawDimensions(c: HTMLCanvasElement, fp: FootprintSpec, pitch: number | undefined): void {
  const box = footprintBox(fp);
  const W = c.clientWidth || 300;
  const H = c.clientHeight || 260;
  const s = Math.min((W - 16) / Math.max(0.5, box.maxX - box.minX), (H - 16) / Math.max(0.5, box.maxY - box.minY));
  const ox = W / 2 - ((box.minX + box.maxX) / 2) * s;
  const oy = H / 2 - ((box.minY + box.maxY) / 2) * s;
  const ctx = c.getContext('2d')!;
  const pads = fp.pads.filter((p) => p.number && p.type !== 'npth');
  if (!pads.length) return;
  const xs = pads.map((p) => p.at.x);
  const ys = pads.map((p) => p.at.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  ctx.strokeStyle = '#4fd6a6';
  ctx.fillStyle = '#4fd6a6';
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, Menlo, monospace';
  const dim = (ax: number, ay: number, bx: number, by: number, text: string) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    for (const [x, y] of [[ax, ay], [bx, by]] as const) ctx.fillRect(x - 2, y - 2, 4, 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, (ax + bx) / 2, (ay + by) / 2 - 3);
  };
  if (x1 - x0 > 0.01) dim(ox + x0 * s, 18, ox + x1 * s, 18, `${(x1 - x0).toFixed(2)} mm`);
  if (y1 - y0 > 0.01) {
    ctx.save();
    ctx.translate(W - 10, oy + ((y0 + y1) / 2) * s);
    ctx.rotate(-Math.PI / 2);
    dim(-((y1 - y0) / 2) * s, 0, ((y1 - y0) / 2) * s, 0, `${(y1 - y0).toFixed(2)} mm`);
    ctx.restore();
  }
  if (pitch) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`pitch ${pitch} mm`, 6, H - 6);
  }
}

export interface FootprintDialogOptions {
  /** Part to assign the footprint to after saving. */
  ref?: string;
  /** Generated footprint to edit. */
  fp?: FootprintSpec | null;
  /** Called after saving, e.g. to rebuild the board part. */
  onSaved?: (fp: FootprintSpec) => void;
}

export function openFootprintGenerator(app: App, opts: FootprintDialogOptions = {}): void {
  const doc = app.doc;
  if (!doc) return app.say('Open or create a project first.');
  const prev = (opts.fp?.generator ?? null) as (FootprintParams & Record<string, unknown>) | null;
  let family: Family = prev?.family ?? 'two-row';
  const values: Record<Family, Record<string, string>> = structuredClone(DEFAULTS);
  if (prev) {
    // Back into form values.
    const flat = (o: Record<string, unknown>, pre = ''): [string, unknown][] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && k !== 'vias' ? flat(v as Record<string, unknown>, `${pre}${k}.`) : [[`${pre}${k}`, v]]));
    const v = values[family];
    for (const [k, x] of flat(prev)) if (typeof x === 'number' || typeof x === 'string') v[k] = String(x);
    if (prev.family === 'two-row' || prev.family === 'four-side') v.source = prev.leads ? 'leads' : 'land';
    if (prev.family === 'two-row' && prev.drill === undefined) v.drill = '';
    const vias = (prev.ep as { vias?: { drill: number; rows: number; cols: number; pitch: number } } | undefined)?.vias;
    if (vias) v['ep.vias'] = `${vias.drill} ${vias.rows} ${vias.cols} ${vias.pitch}`;
    if (prev.holes) v.holes = prev.holes.map((q) => `${q.x} ${q.y} ${q.drill}${q.pad ? ` ${q.pad}` : ''}`).join('\n');
    if (prev.family === 'grid' && prev.skip) v.skip = prev.skip.join(', ');
    if (prev.family === 'pads') v.padList = prev.pads.map((q) => `${q.number} ${q.x} ${q.y} ${q.w} ${q.h}${q.drill !== undefined ? ` ${q.drill}` : ''}`).join('\n');
  }

  const dlg = h('dialog', { class: 'annotate-dialog symbol-editor footprint-gen' });
  const nameIn = h('input', { value: opts.fp?.name ?? '', placeholder: 'e.g. qfn-24-4x4-ep2.6', autocomplete: 'off' }) as HTMLInputElement;
  if (opts.fp) nameIn.readOnly = true;
  const famSel = h('select', {}, ...(['two-row', 'four-side', 'grid', 'castellated', 'pads'] as Family[]).map((f) => h('option', { value: f }, { 'two-row': 'Two rows (SOIC, TSSOP, DIP, header)', 'four-side': 'Four sides (QFP, QFN)', grid: 'Grid (BGA, LGA)', castellated: 'Castellated module (ESP-12F style)', pads: 'Free pad list' }[f]))) as HTMLSelectElement;
  famSel.value = family;
  const form = h('div', { class: 'fp-fields' });
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const info = h('div', { class: 'dim fp-info' });
  const problems = h('div', { class: 'err-text' });
  let current: FootprintSpec | null = null;

  const preview = () => {
    problems.textContent = '';
    try {
      current = generateFootprint(paramsFrom(nameIn.value.trim() || 'preview', family, values[family]));
    } catch (e) {
      current = null;
      problems.textContent = (e as Error).message;
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const fp = current;
    requestAnimationFrame(() => {
      drawFootprint(canvas, fp);
      drawDimensions(canvas, fp, num(values[family].pitch));
    });
    const cy = fp.graphics.find((g) => g.layer === 'F.CrtYd' && g.kind === 'rect') as { a: { x: number; y: number }; b: { x: number; y: number } } | undefined;
    const p1 = fp.pads.find((p) => p.number === '1' || p.number === 'A1');
    const sizes = [...new Set(fp.pads.filter((p) => p.number).map((p) => `${p.size.x}×${p.size.y}`))];
    info.textContent = `${fp.pads.filter((p) => p.number).length} pads · pad sizes ${sizes.slice(0, 3).join(', ')} mm${p1 ? ` · pad ${p1.number} at ${p1.at.x}, ${p1.at.y}` : ''}${cy ? ` · courtyard ${(cy.b.x - cy.a.x).toFixed(2)} × ${(cy.b.y - cy.a.y).toFixed(2)} mm` : ''}`;
  };

  const renderForm = () => {
    clear(form);
    const v = values[family];
    v.__family = family;
    for (const f of [...FIELDS[family], ...COMMON]) {
      if (f.when && !f.when(v)) continue;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (f.kind === 'select') input = h('select', {}, ...(f.options ?? []).map((o) => h('option', { value: o }, o === 'land' ? 'Land pattern (datasheet)' : o === 'leads' ? 'Lead dimensions' : o))) as HTMLSelectElement;
      else if (f.kind === 'area') input = h('textarea', { rows: '3' }) as HTMLTextAreaElement;
      else input = h('input', { inputmode: f.kind === 'text' ? 'text' : 'decimal', autocomplete: 'off' }) as HTMLInputElement;
      input.value = v[f.key] ?? (f.kind === 'select' ? (f.options?.[0] ?? '') : '');
      if (f.kind === 'select') v[f.key] = input.value;
      input.addEventListener('input', () => {
        v[f.key] = input.value;
        // Fields that show or hide others re-render the form.
        if (['source', 'drill'].includes(f.key) && f.kind === 'select') renderForm();
        preview();
      });
      if (f.key === 'drill') input.addEventListener('change', () => renderForm());
      form.append(h('label', { class: f.kind === 'area' ? 'wide' : '' }, h('span', {}, f.label, f.hint ? h('small', { class: 'dim' }, ` ${f.hint}`) : null), input));
    }
    if ((family === 'two-row' || family === 'four-side') && v.source === 'leads' && v.drill === '') {
      const m = LEAD_MARGINS[(v['leads.type'] as keyof typeof LEAD_MARGINS) || 'gullwing'];
      form.append(h('div', { class: 'dim wide', style: 'font-size:11px' }, `Pads derived with toe ${m.toe}, heel ${m.heel}, side ${m.side} mm (use maximum lead values).`));
    }
    preview();
  };
  famSel.addEventListener('change', () => ((family = famSel.value as Family), renderForm()));
  nameIn.addEventListener('input', preview);

  const save = () => {
    const name = nameIn.value.trim();
    if (!name) return void (problems.textContent = 'The footprint needs a name');
    let fp: FootprintSpec;
    try {
      fp = generateFootprint(paramsFrom(name, family, values[family]));
    } catch (e) {
      return void (problems.textContent = (e as Error).message);
    }
    if (!opts.fp && doc.meta[`fp:${name}`] && !confirm(`The project already has a footprint "${name}". Replace it?`)) return;
    const ops: Op[] = [{ op: 'setMeta', key: `fp:${name}`, value: fp }];
    if (opts.ref) for (const n of doc.nodes.values()) if (n.type === 'symbol' && String(n.props.ref ?? n.name) === opts.ref) ops.push({ op: 'setProp', uid: n.uid, key: 'Footprint', value: name });
    if (!app.apply(`Footprint ${name}`, ops)) return;
    dlg.close();
    app.say(`Saved footprint ${name}${opts.ref ? ` for ${opts.ref}; Update PCB puts it on the board` : ''}. It is in the project's footprints; publish it with its part from the Parts panel.`);
    app.emit('parts');
    opts.onSaved?.(fp);
  };

  dlg.append(
    h('h3', {}, opts.fp ? `Edit footprint ${opts.fp.name}` : `New footprint${opts.ref ? ` for ${opts.ref}` : ''}`),
    h('div', { class: 'sym-fields' }, h('label', {}, 'Name', nameIn), h('label', {}, 'Package family', famSel)),
    h('div', { class: 'sym-body' }, h('div', { class: 'sym-left' }, form), h('div', { class: 'sym-right' }, canvas, info, problems)),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'button', class: 'primary', onclick: save }, 'Save footprint')),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  renderForm();
  dlg.showModal();
}
