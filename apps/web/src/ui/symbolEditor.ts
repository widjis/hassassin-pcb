/**
 * Symbol editor dialog (S16): make or change a part's symbol from a pin table.
 * Paste the table from a datasheet, adjust names / types / sides / units in the grid, watch the
 * preview, then save into the project (placed copies are redrawn) and optionally place it.
 */
import {
  PIN_SIDES,
  PIN_TYPES,
  buildSymbolUnits,
  checkPinRows,
  parsePinTable,
  partPinRows,
  symbolPart,
  unitLabel,
  unitLetter,
  updatePlacedSymbolsOps,
  type PartDef,
  type PartUnit,
  type PinLayout,
  type PinOrder,
  type PinRow,
  type PinSide,
  type PinType,
  type SymbolOptions,
} from '@hassassin/core';
import type { App } from '../app.ts';
import { clear, h } from './dom.ts';

const EXAMPLE = 'Pin\tName\tType\n1\tVIN\tP\n2\tGND\tG\n3\tEN\tI\n4\tFB\tI\n5\tSW\tO';

/** Draw one unit with pin numbers and names, fitted into the canvas. */
function drawUnit(c: HTMLCanvasElement, u: PartUnit): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth || 220;
  const H = c.clientHeight || 180;
  c.width = W * dpr;
  c.height = H * dpr;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const dir = (a: number) => ({ x: Math.cos((a * Math.PI) / 180), y: -Math.sin((a * Math.PI) / 180) });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x: number, y: number) => ((x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y)));
  for (const p of u.pins) grow(p.at.x, p.at.y);
  for (const g of u.graphics) if (g.t === 'rect') (grow(g.a.x, g.a.y), grow(g.b.x, g.b.y));
  if (!Number.isFinite(x0)) return;
  const pad = 3;
  const s = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad));
  const P = (x: number, y: number): [number, number] => [(x - (x0 + x1) / 2) * s + W / 2, (y - (y0 + y1) / 2) * s + H / 2];
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--text').trim() || '#ddd';
  for (const g of u.graphics) {
    if (g.t !== 'rect') continue;
    const [a, b] = P(g.a.x, g.a.y);
    const [c2, d] = P(g.b.x, g.b.y);
    ctx.fillStyle = 'rgba(232,196,122,0.10)';
    ctx.strokeStyle = '#e8c47a';
    ctx.lineWidth = 1.5;
    ctx.fillRect(a, b, c2 - a, d - b);
    ctx.strokeRect(a, b, c2 - a, d - b);
  }
  const font = Math.max(7, Math.min(12, 1.2 * s));
  for (const p of u.pins) {
    const dv = dir(p.angle);
    const end = { x: p.at.x + dv.x * p.length, y: p.at.y + dv.y * p.length };
    ctx.strokeStyle = p.type === 'power_in' || p.type === 'power_out' ? '#ff8f8f' : '#4fd6a6';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(...P(p.at.x, p.at.y));
    ctx.lineTo(...P(end.x, end.y));
    ctx.stroke();
    ctx.font = `${font}px ui-monospace, Menlo, monospace`;
    // Number outside along the pin, name inside the body.
    ctx.fillStyle = '#8f96a3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const mid = P((p.at.x + end.x) / 2, (p.at.y + end.y) / 2);
    ctx.fillText(p.number, mid[0] + (dv.x === 0 ? font * 0.6 : 0), mid[1] - 1);
    if (p.name && p.name !== '~' && p.name !== p.number) {
      ctx.fillStyle = ink;
      ctx.textBaseline = 'middle';
      const inner = P(end.x + dv.x * 0.6, end.y + dv.y * 0.6);
      ctx.textAlign = dv.x > 0.5 ? 'left' : dv.x < -0.5 ? 'right' : 'center';
      ctx.fillText(p.name.replace(/~\{([^}]*)\}/g, '$1'), inner[0], inner[1] + (dv.y > 0.5 ? font * 0.6 : dv.y < -0.5 ? -font * 0.6 : 0));
    }
  }
}

export interface SymbolEditorOptions {
  /** Part to edit (its pin table is read back); none for a new symbol. */
  def?: PartDef | null;
  /** Called with the saved part when the user chose "Save and place". */
  onPlace?: (def: PartDef) => void;
}

export function openSymbolEditor(app: App, opts: SymbolEditorOptions = {}): void {
  const doc = app.doc;
  if (!doc) return app.say('Open or create a project first.');
  const editing = opts.def ?? null;
  const start = editing ? partPinRows(editing) : { rows: [] as PinRow[], options: { layout: 'auto' } as SymbolOptions };
  let rows: PinRow[] = start.rows;
  const options: SymbolOptions = { layout: 'auto', order: 'table', ...start.options };

  const dlg = h('dialog', { class: 'annotate-dialog symbol-editor' });
  const field = (label: string, value: string, placeholder = '') => {
    const i = h('input', { value, placeholder, autocomplete: 'off' }) as HTMLInputElement;
    return { el: h('label', {}, label, ' ', i), i };
  };
  const name = field('Name', editing?.name ?? '', 'e.g. TPS54302');
  const prefix = field('Prefix', editing?.prefix ?? 'U');
  const value = field('Value', editing?.value ?? '', 'default: name');
  const footprint = field('Footprint', editing?.footprint ?? '', 'e.g. sot-23-6');
  if (editing) name.i.readOnly = true;
  const paste = h('textarea', { rows: '5', placeholder: `Paste the pin table from the datasheet (tab, comma or space separated; a header line is fine). For example:\n${EXAMPLE}` }) as HTMLTextAreaElement;
  const readBtn = h('button', { type: 'button' }, 'Read table');
  const readNote = h('span', { class: 'dim' });
  const layoutSel = h('select', {}, ...(['auto', 'package', 'table'] as PinLayout[]).map((k) => h('option', { value: k }, k === 'auto' ? 'By function (supplies top, grounds bottom, in left, out right)' : k === 'package' ? 'As on the package (left down, right up)' : 'Sides from the table'))) as HTMLSelectElement;
  layoutSel.value = options.layout ?? 'auto';
  const orderSel = h('select', {}, ...(['table', 'number', 'name'] as PinOrder[]).map((k) => h('option', { value: k }, k === 'table' ? 'Order as in the table' : k === 'number' ? 'Order by pin number' : 'Order by name'))) as HTMLSelectElement;
  orderSel.value = options.order ?? 'table';
  const powerUnit = h('input', { type: 'checkbox' }) as HTMLInputElement;
  powerUnit.checked = !!options.powerUnit;
  const grid = h('tbody', {});
  const previews = h('div', { class: 'sym-previews' });
  const problems = h('div', { class: 'err-text' });

  const renderPreview = () => {
    clear(previews);
    problems.textContent = '';
    if (!rows.length) {
      previews.append(h('div', { class: 'dim' }, 'Paste a pin table or add pins to see the symbol.'));
      return;
    }
    let units: PartUnit[];
    try {
      units = buildSymbolUnits(rows, options);
    } catch (e) {
      problems.textContent = (e as Error).message;
      return;
    }
    const fake = { units } as PartDef;
    units.forEach((u, i) => {
      const c = h('canvas', {}) as HTMLCanvasElement;
      previews.append(h('figure', {}, c, units.length > 1 ? h('figcaption', {}, `Unit ${unitLabel(fake, i + 1)}`) : null));
      requestAnimationFrame(() => drawUnit(c, u));
    });
  };

  const renderGrid = () => {
    clear(grid);
    rows.forEach((r, i) => {
      const num = h('input', { value: r.number, 'aria-label': 'Pin number' }) as HTMLInputElement;
      const nm = h('input', { value: r.name, 'aria-label': 'Pin name' }) as HTMLInputElement;
      const ty = h('select', { 'aria-label': 'Pin type' }, ...PIN_TYPES.map((t) => h('option', { value: t }, t.replace('_', ' ')))) as HTMLSelectElement;
      ty.value = r.type;
      const sd = h('select', { 'aria-label': 'Side' }, h('option', { value: '' }, 'auto'), ...PIN_SIDES.map((t) => h('option', { value: t }, t))) as HTMLSelectElement;
      sd.value = r.side ?? '';
      const un = h('input', { value: r.unit === undefined ? '' : r.unit === 0 ? 'power' : unitLetter(r.unit), placeholder: 'A', size: '4', 'aria-label': 'Unit' }) as HTMLInputElement;
      const update = () => {
        const u = un.value.trim();
        let unit: number | undefined;
        if (/^(power|pwr)$/i.test(u)) unit = 0;
        else if (/^\d+$/.test(u)) unit = Number(u) || undefined;
        else if (/^[A-Za-z]{1,2}$/.test(u)) unit = [...u.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
        rows[i] = { number: num.value.trim(), name: nm.value.trim(), type: ty.value as PinType, ...(sd.value ? { side: sd.value as PinSide } : {}), ...(unit !== undefined ? { unit } : {}) };
        // A side chosen by hand only counts with "Sides from the table".
        if (sd.value && layoutSel.value !== 'table') ((layoutSel.value = 'table'), (options.layout = 'table'));
        renderPreview();
      };
      for (const el of [num, nm, un]) el.addEventListener('change', update);
      for (const el of [ty, sd]) el.addEventListener('change', update);
      const del = h('button', { type: 'button', title: 'Remove this pin', onclick: () => (rows.splice(i, 1), renderGrid(), renderPreview()) }, '×');
      grid.append(h('tr', {}, h('td', {}, num), h('td', {}, nm), h('td', {}, ty), h('td', {}, sd), h('td', {}, un), h('td', {}, del)));
    });
  };

  const read = () => {
    const r = parsePinTable(paste.value);
    if (!r.rows.length) {
      readNote.textContent = 'No pin rows found: each line should start with a pin number.';
      return;
    }
    rows = r.rows;
    readNote.textContent = `${r.rows.length} pins read${r.skipped.length ? `, ${r.skipped.length} lines skipped` : ''}.`;
    // A table with sides uses them.
    if (rows.some((x) => x.side)) ((layoutSel.value = 'table'), (options.layout = 'table'));
    renderGrid();
    renderPreview();
  };
  readBtn.addEventListener('click', read);
  paste.addEventListener('paste', () => setTimeout(read, 0));
  layoutSel.addEventListener('change', () => ((options.layout = layoutSel.value as PinLayout), renderPreview()));
  orderSel.addEventListener('change', () => ((options.order = orderSel.value as PinOrder), renderPreview()));
  powerUnit.addEventListener('change', () => ((options.powerUnit = powerUnit.checked || undefined), renderPreview()));

  const save = (place: boolean) => {
    const problemsNow = checkPinRows(rows);
    if (!name.i.value.trim()) problemsNow.unshift('The symbol needs a name');
    if (problemsNow.length) {
      problems.textContent = problemsNow.join('; ');
      return;
    }
    let def: PartDef;
    try {
      def = symbolPart({
        ...(editing ? { id: editing.id, version: (editing.version ?? 1) + 1 } : {}),
        name: name.i.value,
        prefix: prefix.i.value,
        value: value.i.value,
        footprint: footprint.i.value,
        ...(editing?.description ? { description: editing.description } : {}),
        ...(editing?.properties ? { properties: editing.properties } : {}),
        rows,
        options,
      });
    } catch (e) {
      problems.textContent = (e as Error).message;
      return;
    }
    if (!editing && doc.meta[`part:${def.id}`] && !confirm(`The project already has a part "${def.name}". Replace it?`)) return;
    const upd = updatePlacedSymbolsOps(doc, app.engine!, def);
    if (!app.apply(editing ? `Edit symbol ${def.name}` : `New symbol ${def.name}`, [{ op: 'setMeta', key: `part:${def.id}`, value: def }, ...upd.ops])) return;
    dlg.close();
    app.say(`Saved symbol ${def.name}${upd.updated ? `; ${upd.updated} placed cop${upd.updated > 1 ? 'ies' : 'y'} redrawn` : ''}${upd.orphans.length ? `; ${upd.orphans.join(', ')} no longer exist in the symbol` : ''}. It is in the project's part list; publish it to the team from the Parts panel.`);
    app.emit('parts');
    if (place) opts.onPlace?.(def);
  };

  dlg.append(
    h('h3', {}, editing ? `Edit symbol ${editing.name}` : 'New symbol'),
    h('div', { class: 'sym-fields' }, name.el, prefix.el, value.el, footprint.el),
    h('div', { class: 'sym-body' },
      h('div', { class: 'sym-left' },
        paste,
        h('div', { class: 'row-left' }, readBtn, readNote),
        h('div', { class: 'sym-opts' }, h('label', {}, 'Sides ', layoutSel), h('label', {}, 'Order ', orderSel), h('label', {}, powerUnit, ' Power pins in a unit of their own')),
        h('div', { class: 'sym-grid' },
          h('table', {}, h('thead', {}, h('tr', {}, ...['No.', 'Name', 'Type', 'Side', 'Unit', ''].map((t) => h('th', {}, t)))), grid),
          h('button', { type: 'button', onclick: () => { rows.push({ number: String(rows.length + 1), name: '', type: 'passive' }); renderGrid(); renderPreview(); } }, '+ Add pin'),
        ),
      ),
      h('div', { class: 'sym-right' }, previews, problems),
    ),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'button', onclick: () => save(false) }, 'Save'),
      opts.onPlace ? h('button', { type: 'button', class: 'primary', onclick: () => save(true) }, editing ? 'Save and place another' : 'Save and place') : null,
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  renderGrid();
  renderPreview();
  dlg.showModal();
}
