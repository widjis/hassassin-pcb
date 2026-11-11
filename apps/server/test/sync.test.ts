import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addNode, createDoc, History, systemDefaults, toFile, type Doc } from '@hassassin/core';
import { SyncClient, type Role } from '@hassassin/sync';
import { startServer } from '../src/server.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';
beforeAll(async () => {
  srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hsrv-')) });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv.close());

function seedDoc(): Doc {
  const doc = createDoc(systemDefaults());
  const layout = addNode(doc, doc.rootId, { type: 'layout', name: 'Board' });
  const comps = addNode(doc, layout.uid, { type: 'container', name: 'Components' });
  addNode(doc, comps.uid, { uid: 'el-r1', type: 'element', name: 'R1', rules: [{ name: 'position', value: { x: 0, y: 0 } }] });
  return doc;
}

async function createProject(): Promise<{ id: string; tokens: Record<Role, string> }> {
  const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'T', doc: toFile(seedDoc()) }) });
  expect(r.status).toBe(201);
  return r.json();
}

/** A minimal client: its own doc + history, driven by SyncClient. */
function makeClient(id: string, token: string, name: string) {
  const state: { doc: Doc; history: History; changes: number } = { doc: createDoc(), history: null as unknown as History, changes: 0 };
  state.history = new History(state.doc);
  const sc = new SyncClient({
    url: `ws://127.0.0.1:${srv.port}/ws`,
    project: id,
    token,
    user: { id: name, name, color: '#123456' },
    reconnect: false,
    target: {
      doc: () => state.doc,
      history: () => state.history,
      replace: (d) => {
        state.doc = d;
        state.history = new History(d);
      },
      changed: () => state.changes++,
    },
  });
  return { state, sc };
}

const canon = (d: Doc) => {
  const f = toFile(d) as unknown as Record<string, unknown>;
  delete f.savedAt;
  return JSON.stringify(f);
};
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('collaboration server', () => {
  it('keeps two editors in step under concurrent edits', async () => {
    const { id, tokens } = await createProject();
    const a = makeClient(id, tokens.edit, 'Ana');
    const b = makeClient(id, tokens.edit, 'Budi');
    await a.sc.connect();
    await b.sc.connect();
    const comps = [...a.state.doc.nodes.values()].find((n) => n.name === 'Components')!.uid;
    // Both edit at the same time: same property, and appends to the same parent.
    a.state.history.apply('Move', [{ op: 'setRule', uid: 'el-r1', name: 'position', decl: { name: 'position', value: { x: 1, y: 1 } } }]);
    b.state.history.apply('Move', [{ op: 'setRule', uid: 'el-r1', name: 'position', decl: { name: 'position', value: { x: 2, y: 2 } } }]);
    a.state.history.apply('Add', [{ op: 'add', parent: comps, index: 1, tree: { nodes: [{ uid: 'el-a', type: 'element', name: 'RA', props: {}, rules: [], parent: comps, children: [] }] } }]);
    b.state.history.apply('Add', [{ op: 'add', parent: comps, index: 1, tree: { nodes: [{ uid: 'el-b', type: 'element', name: 'RB', props: {}, rules: [], parent: comps, children: [] }] } }]);
    await a.sc.flush();
    await b.sc.flush();
    await settle();
    expect(canon(a.state.doc)).toBe(canon(b.state.doc));
    // The server's copy agrees too.
    const file = await (await fetch(`${base}/api/projects/${id}/file?token=${tokens.view}`)).json();
    const server = JSON.parse(JSON.stringify(file));
    delete server.savedAt;
    expect(JSON.stringify(server)).toBe(canon(a.state.doc));
    // A third client joining later sees the same document.
    const c = makeClient(id, tokens.view, 'Citra');
    await c.sc.connect();
    expect(canon(c.state.doc)).toBe(canon(a.state.doc));
    // Presence is shared.
    a.sc.sendPresence({ space: 'layout', x: 5, y: 6 }, ['el-r1']);
    await settle();
    expect([...b.sc.peers.values()].find((p) => p.user.name === 'Ana')?.cursor).toEqual({ space: 'layout', x: 5, y: 6 });
    [a, b, c].forEach((x) => x.sc.close());
  });

  it('enforces roles: viewers cannot edit, commenters only comment', async () => {
    const { id, tokens } = await createProject();
    const v = makeClient(id, tokens.view, 'Viewer');
    const cm = makeClient(id, tokens.comment, 'Commenter');
    await v.sc.connect();
    await cm.sc.connect();
    const rejected: string[] = [];
    v.sc.on('rejected', (r) => rejected.push(r.reason));
    cm.sc.on('rejected', (r) => rejected.push(r.reason));
    v.state.history.apply('Move', [{ op: 'setRule', uid: 'el-r1', name: 'position', decl: { name: 'position', value: { x: 9, y: 9 } } }]);
    // rolled back locally
    expect(v.state.doc.nodes.get('el-r1')!.rules.find((r) => r.name === 'position')!.value).toEqual({ x: 0, y: 0 });
    const container = [...cm.state.doc.nodes.values()].find((n) => n.type === 'container' && n.name === 'Comments')!;
    cm.state.history.apply('Comment', [{ op: 'add', parent: container.uid, index: 0, tree: { nodes: [{ uid: 'cm1', type: 'comment', name: '', props: { text: 'Check this', author: 'Commenter' }, rules: [], parent: container.uid, children: [] }] } }]);
    await cm.sc.flush();
    expect(cm.sc.pendingCount).toBe(0);
    expect(rejected.length).toBe(1);
    expect(rejected[0]).toMatch(/view/);
    [v, cm].forEach((x) => x.sc.close());
  });

  it('saves and restores versions, and forks projects', async () => {
    const { id, tokens } = await createProject();
    const a = makeClient(id, tokens.edit, 'Ana');
    await a.sc.connect();
    const v = await (await fetch(`${base}/api/projects/${id}/versions?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ name: 'Before move', author: 'Ana' }) })).json();
    a.state.history.apply('Move', [{ op: 'setRule', uid: 'el-r1', name: 'position', decl: { name: 'position', value: { x: 5, y: 5 } } }]);
    await a.sc.flush();
    const resets: string[] = [];
    a.sc.on('reset', (r) => resets.push(r.reason));
    const r = await fetch(`${base}/api/projects/${id}/restore?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ versionId: v.id, author: 'Ana' }) });
    expect(r.status).toBe(200);
    await settle();
    expect(resets[0]).toMatch(/Before move/);
    expect(a.state.doc.nodes.get('el-r1')!.rules.find((x) => x.name === 'position')!.value).toEqual({ x: 0, y: 0 });
    const denied = await fetch(`${base}/api/projects/${id}/restore?token=${tokens.view}`, { method: 'POST', body: JSON.stringify({ versionId: v.id }) });
    expect(denied.status).toBe(403);
    const fork = await (await fetch(`${base}/api/projects/${id}/fork?token=${tokens.view}`, { method: 'POST', body: JSON.stringify({ name: 'Copy', history: true }) })).json();
    const info = await (await fetch(`${base}/api/projects/${fork.id}?token=${fork.tokens.edit}`)).json();
    expect(info.project.forkedFrom).toBe(id);
    expect(info.versions.length).toBeGreaterThanOrEqual(2);
    expect((await fetch(`${base}/api/projects/${id}?token=nope`)).status).toBe(403);
    a.sc.close();
  });

  it('survives a restart (snapshot + log replay)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsrv-'));
    let s2 = await startServer({ port: 0, dataDir: dir });
    const created = await (await fetch(`http://127.0.0.1:${s2.port}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'R', doc: toFile(seedDoc()) }) })).json();
    const lp = await s2.store.get(created.id);
    await s2.store.commit(lp, { id: 'x', name: 'x', color: '#000' }, 'Move', [{ op: 'setRule', uid: 'el-r1', name: 'position', decl: { name: 'position', value: { x: 7, y: 7 } } }]);
    await s2.close();
    s2 = await startServer({ port: 0, dataDir: dir });
    const again = await s2.store.get(created.id);
    expect(again.doc.nodes.get('el-r1')!.rules.find((x) => x.name === 'position')!.value).toEqual({ x: 7, y: 7 });
    expect(again.seq).toBe(1);
    await s2.close();
  });
});
