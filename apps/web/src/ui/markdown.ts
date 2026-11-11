/**
 * Small Markdown renderer for agent replies: headings, paragraphs, lists (nested by
 * indentation), task lists, block quotes, fenced code, tables, rules, and inline code,
 * bold, italic, strike-through and links. Builds DOM nodes directly (text is never parsed
 * as HTML), so model output cannot inject markup.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

const SAFE_URL = /^(https?:|mailto:)/i;

/** Inline spans: `code`, **bold**, *italic* / _italic_, ~~strike~~, [text](url), bare URLs. */
export function inline(text: string, into: HTMLElement): void {
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<![\w_])_([^_\s][^_]*?)_(?![\w_])|~~([^~]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) into.append(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== undefined) {
      const c = el('code');
      c.textContent = m[2].trim() || m[2];
      into.append(c);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const b = el('strong');
      inline(m[3] ?? m[4]!, b);
      into.append(b);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const i = el('em');
      inline(m[5] ?? m[6]!, i);
      into.append(i);
    } else if (m[7] !== undefined) {
      const s = el('del');
      inline(m[7], s);
      into.append(s);
    } else if (m[8] !== undefined) {
      const url = m[9]!;
      if (SAFE_URL.test(url)) {
        const a = el('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(m[8], a);
        into.append(a);
      } else into.append(m[8]);
    } else if (m[10] !== undefined) {
      const a = el('a');
      a.href = m[10];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[10];
      into.append(a);
    }
  }
  if (last < text.length) into.append(text.slice(last));
}

interface ListItem {
  indent: number;
  ordered: boolean;
  start: number;
  task: boolean | null;
  text: string[];
}

function renderList(items: ListItem[], into: HTMLElement): void {
  // Build nested lists from indentation.
  const stack: { indent: number; list: HTMLOListElement | HTMLUListElement; last: HTMLLIElement | null }[] = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1]!.indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const list = it.ordered ? el('ol') : el('ul');
      if (it.ordered && it.start !== 1) (list as HTMLOListElement).start = it.start;
      if (it.task !== null) list.className = 'tasklist';
      if (top?.last) top.last.append(list);
      else into.append(list);
      stack.push((top = { indent: it.indent, list, last: null }));
    }
    const li = el('li');
    if (it.task !== null) {
      const box = el('span', `check${it.task ? ' on' : ''}`);
      box.textContent = it.task ? '✓' : '';
      li.append(box);
    }
    it.text.forEach((t, k) => {
      if (k) li.append(el('br'));
      inline(t, li);
    });
    top.list.append(li);
    top.last = li;
  }
}

export function renderMarkdown(src: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const p = el('p');
    para.forEach((t, k) => {
      if (k) p.append(el('br'));
      inline(t, p);
    });
    out.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(close)) body.push(lines[i++]!);
      i++;
      const pre = el('pre', 'code-block');
      if (fence[2]) pre.dataset.lang = fence[2];
      const code = el('code');
      code.textContent = body.join('\n');
      pre.append(code);
      const copy = el('button', 'copy');
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => void navigator.clipboard?.writeText(code.textContent ?? '').then(() => ((copy.textContent = 'Copied'), setTimeout(() => (copy.textContent = 'Copy'), 1200))));
      pre.append(copy);
      out.append(pre);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const hd = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) {
      flush();
      const hEl = el(`h${Math.min(6, hd[1]!.length + 2)}` as 'h3');
      inline(hd[2]!, hEl);
      out.append(hEl);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.append(el('hr'));
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      const q = el('blockquote');
      q.append(renderMarkdown(body.join('\n')));
      out.append(q);
      continue;
    }
    // Table: header row, separator row.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const table = el('table', 'md-table');
      const head = el('tr');
      cells(line).forEach((c, k) => {
        const th = el('th');
        if (align[k]) th.style.textAlign = align[k]!;
        inline(c, th);
        head.append(th);
      });
      const thead = el('thead');
      thead.append(head);
      table.append(thead);
      const tbody = el('tbody');
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const tr = el('tr');
        cells(lines[i++]!).forEach((c, k) => {
          const td = el('td');
          if (align[k]) td.style.textAlign = align[k]!;
          inline(c, td);
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(tbody);
      const wrap = el('div', 'table-wrap');
      wrap.append(table);
      out.append(wrap);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      flush();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(lines[i]!);
        if (m) {
          items.push({ indent: m[1]!.replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]!), start: parseInt(m[2]!, 10) || 1, task: m[3] ? /x/i.test(m[3]) : null, text: [m[4]!] });
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!) && items.length) {
          items[items.length - 1]!.text.push(lines[i++]!.trim()); // continuation line
        } else break;
      }
      renderList(items, out as unknown as HTMLElement);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}
