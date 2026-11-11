/**
 * Collaboration UI: the top-bar presence strip with the Share button, the share dialog,
 * the Comments tab and the History tab.
 */
import type { DocNode } from '@hassassin/core';
import type { App } from '../app.ts';
import { shareLink, type Collab } from '../collab.ts';
import { clear, h } from './dom.ts';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export function mountCollabBar(app: App, collab: Collab, root: HTMLElement, onShare: () => void): void {
  const render = () => {
    clear(root);
    const c = app.collab;
    if (!c) {
      root.append(h('button', { class: 'share-btn', title: 'Put this project on the collaboration server and invite others', onclick: onShare }, 'Share'));
      return;
    }
    const dot = h('span', { class: `live-dot ${c.status}`, title: c.status === 'online' ? `Live · ${c.role}` : c.status });
    const avatars = h('div', { class: 'avatars' });
    const me = h('span', { class: 'avatar me', style: `background:${collab.user.color}`, title: `${collab.user.name} (you, ${c.role})` }, initials(collab.user.name));
    avatars.append(me);
    for (const p of c.peers.values()) {
      avatars.append(h('span', { class: `avatar${p.user.kind === 'agent' ? ' agent' : ''}`, style: `background:${p.user.color}`, title: `${p.user.name}${p.user.kind === 'agent' ? ' (agent)' : ''}` }, p.user.kind === 'agent' ? '⚙' : initials(p.user.name)));
    }
    root.append(dot, avatars);
    if (c.role !== 'edit') root.append(h('span', { class: 'role-tag' }, c.role === 'view' ? 'view only' : 'can comment'));
    root.append(h('button', { class: 'share-btn', onclick: onShare }, 'Share'));
  };
  for (const ev of ['collab', 'presence'] as const) app.on(ev, render);
  render();
}

export function openShareDialog(app: App, collab: Collab): void {
  const overlay = h('div', { class: 'modal-bg' });
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => e.target === overlay && close());
  const box = h('div', { class: 'modal' });
  overlay.append(box);
  document.body.append(overlay);

  const render = async () => {
    clear(box);
    box.append(h('div', { class: 'modal-head' }, h('strong', {}, 'Share project'), h('button', { onclick: close }, '×')));
    if (!app.collab || !collab.session) {
      box.append(
        h('p', { class: 'dim' }, 'Sharing puts a copy of this project on the collaboration server. Everyone with a link works on the same live project; every change is kept in its history.'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              try {
                box.append(h('div', { class: 'dim' }, 'Uploading…'));
                await collab.share();
                render();
              } catch (e) {
                box.append(h('div', { class: 'err-text' }, `Could not share: ${(e as Error).message}. Is the collaboration server running (pnpm run server)?`));
              }
            },
          },
          'Share this project',
        ),
      );
      return;
    }
    const s = collab.session;
    const tokens = s.tokens;
    const row = (label: string, desc: string, token: string | undefined) => {
      if (!token) return null;
      const url = shareLink(s.id, token);
      const input = h('input', { value: url, readonly: true });
      return h(
        'div',
        { class: 'share-row' },
        h('div', {}, h('strong', {}, label), h('div', { class: 'dim', style: 'font-size:11.5px' }, desc)),
        h('div', { class: 'share-link' }, input, h('button', { onclick: () => (navigator.clipboard?.writeText(url), input.select()) }, 'Copy')),
      );
    };
    if (tokens) {
      for (const r of [row('Can edit', 'Full access: schematic, layout, rules, versions', tokens.edit), row('Can comment', 'View everything and add comments', tokens.comment), row('Can view', 'Read-only', tokens.view)]) if (r) box.append(r);
    } else {
      const r = row('Your link', `You joined with “${app.collab.role}” access`, s.token);
      if (r) box.append(r);
    }
    if (app.collab.role === 'edit') {
      const info = await collab.info().catch(() => null);
      const sel = h('select', {});
      for (const [v, l] of [['none', 'Only people with a link'], ['view', 'Anyone with the project id can view'], ['comment', 'Anyone with the project id can comment']]) {
        const o = h('option', { value: v! }, l!);
        if (info?.project.publicRole === v) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => collab.setPublic(sel.value as 'none').then(() => app.say('Access updated.')));
      box.append(h('div', { class: 'share-row' }, h('strong', {}, 'General access'), sel));
    }
    box.append(h('div', { class: 'dim', style: 'font-size:11.5px' }, 'AI agents can join too: give the edit link to the Hassassin MCP server as the “project”.'));
  };
  render();
}

export function mountComments(app: App, collab: Collab, root: HTMLElement, focus: (c: DocNode) => void): void {
  let showResolved = false;
  const render = () => {
    clear(root);
    if (!app.collab) {
      root.append(h('div', { class: 'empty' }, 'Comments live with a shared project. Click Share in the top bar, then press C (or the button below) and click on the board or schematic.'));
      return;
    }
    const threads = app.comments();
    const open = threads.filter((t) => !t.props.resolved);
    root.append(
      h(
        'div',
        { class: 'section-title' },
        h('span', {}, `${open.length} open · ${threads.length - open.length} resolved`),
        h('button', { class: app.commentMode ? 'on' : '', onclick: () => ((app.commentMode = !app.commentMode), app.emit('comments'), app.say(app.commentMode ? 'Click on the canvas to place a comment.' : '')) }, app.commentMode ? 'Click canvas…' : '+ Comment (C)'),
      ),
      h(
        'label',
        { class: 'dim', style: 'display:flex;gap:6px;align-items:center;font-size:12px' },
        (() => {
          const c = h('input', { type: 'checkbox', style: 'width:auto' });
          c.checked = showResolved;
          c.addEventListener('change', () => ((showResolved = c.checked), render()));
          return c;
        })(),
        'show resolved',
      ),
    );
    const list = showResolved ? threads : open;
    list.forEach((t) => {
      const n = threads.indexOf(t) + 1;
      const replies = t.children.map((u) => app.node(u)).filter((x): x is DocNode => x?.type === 'comment');
      const box = h('div', { class: `thread${app.focusedComment === t.uid ? ' focused' : ''}${t.props.resolved ? ' resolved' : ''}` });
      box.append(
        h(
          'div',
          { class: 'thread-head', onclick: () => focus(t) },
          h('span', { class: 'pin-num', style: `background:${t.props.color ?? '#f2a93b'}` }, String(n)),
          h('strong', {}, String(t.props.author ?? '?')),
          t.props.blocking ? h('span', { class: 'role-tag' }, 'blocking') : null,
          h('span', { class: 'dim', style: 'margin-left:auto;font-size:11px' }, ago(String(t.props.createdAt ?? ''))),
        ),
        h('div', { class: 'thread-text' }, String(t.props.text ?? '')),
      );
      for (const r of replies) box.append(h('div', { class: 'reply' }, h('strong', {}, String(r.props.author ?? '?')), ' ', String(r.props.text ?? ''), h('span', { class: 'dim', style: 'font-size:11px' }, ` · ${ago(String(r.props.createdAt ?? ''))}`)));
      const input = h('input', { placeholder: 'Reply…' });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          app.reply(t.uid, input.value.trim(), collab.user.name, collab.user.color);
          input.value = '';
        }
      });
      box.append(
        h(
          'div',
          { class: 'thread-actions' },
          input,
          h('button', { onclick: () => app.setCommentProp(t.uid, 'resolved', !t.props.resolved) }, t.props.resolved ? 'Reopen' : 'Resolve'),
          t.props.author === collab.user.name ? h('button', { onclick: () => app.apply('Delete comment', [{ op: 'remove', uid: t.uid }]) }, 'Delete') : null,
        ),
      );
      root.append(box);
    });
    if (!list.length) root.append(h('div', { class: 'empty' }, 'No comments yet.'));
  };
  for (const ev of ['comments', 'collab', 'doc'] as const) app.on(ev, render);
  render();
}

export function mountHistory(app: App, collab: Collab, root: HTMLElement): void {
  const render = async () => {
    clear(root);
    if (!app.collab || !collab.session) {
      root.append(h('div', { class: 'empty' }, 'Version history is kept by the collaboration server. Share the project to start it. Undo/redo (Cmd/Ctrl+Z) always works locally.'));
      return;
    }
    const info = await collab.info().catch((e) => (root.append(h('div', { class: 'err-text' }, (e as Error).message)), null));
    if (!info) return;
    const edit = info.role === 'edit';
    root.append(
      h('div', { class: 'section-title' }, h('span', {}, 'Versions'), edit ? h('button', { onclick: async () => {
        const name = prompt('Name this version:', 'Checkpoint');
        if (!name) return;
        await collab.saveVersion(name);
        app.say(`Saved version “${name}”.`);
        render();
      } }, '+ Save version') : null),
    );
    if (info.project.forkedFrom) root.append(h('div', { class: 'dim', style: 'font-size:11.5px' }, `Forked from project ${info.project.forkedFrom}`));
    for (const v of info.versions) {
      root.append(
        h(
          'div',
          { class: 'version' },
          h('div', {}, h('strong', {}, v.name), v.auto ? h('span', { class: 'dim' }, ' (auto)') : null),
          h('div', { class: 'dim', style: 'font-size:11.5px' }, `${new Date(v.at).toLocaleString()} · ${v.author} · change #${v.seq}`),
          edit
            ? h('button', { onclick: async () => {
                if (!confirm(`Restore “${v.name}”? Everyone's view switches to it; the current state is saved as a version first.`)) return;
                await collab.restore(v.id);
                render();
              } }, 'Restore')
            : null,
        ),
      );
    }
    if (!info.versions.length) root.append(h('div', { class: 'dim' }, 'No saved versions yet (an automatic one is made every 100 changes).'));
    root.append(
      h('div', { class: 'section-title', style: 'margin-top:12px' }, h('span', {}, 'Copies')),
      h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
        h('button', { onclick: async () => {
          const s = await collab.fork(`${app.fileName} (fork)`, true);
          if (confirm('Fork created (with history). Open it now?')) location.href = shareLink(s.id, s.token);
        } }, 'Fork (keep history)'),
        h('button', { onclick: async () => {
          const s = await collab.fork(`${app.fileName} (copy)`, false);
          if (confirm('Clone created (fresh history). Open it now?')) location.href = shareLink(s.id, s.token);
        } }, 'Clone'),
      ),
    );
  };
  app.on('collab', render);
  render();
  root.addEventListener('focusin', () => {});
  (root as HTMLElement & { refresh?: () => void }).refresh = render;
}
