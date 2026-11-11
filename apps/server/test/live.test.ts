import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDoc, History, toFile, type Doc } from '@hassassin/core';
import { SyncClient } from '@hassassin/sync';
import { newProject } from '@hassassin/tools';
import { startServer } from '../src/server.ts';

const BIN = join(import.meta.dirname, '..', '..', 'cli', 'bin', 'hassassin.mjs');
let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';
beforeAll(async () => {
  srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hlive-')) });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => srv.close());

async function shared() {
  const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'Live', doc: toFile(newProject().doc) }) });
  const j = (await r.json()) as { id: string; tokens: { edit: string; view: string } };
  return { ...j, link: `${base}/?p=${j.id}&t=${j.tokens.edit}` };
}

function observer(id: string, token: string) {
  const st: { doc: Doc; history: History } = { doc: createDoc(), history: null as unknown as History };
  st.history = new History(st.doc);
  const sc = new SyncClient({
    url: `ws://127.0.0.1:${srv.port}/ws`, project: id, token, user: { id: 'obs', name: 'Observer', color: '#fff' }, reconnect: false,
    target: { doc: () => st.doc, history: () => st.history, replace: (d) => ((st.doc = d), (st.history = new History(d))), changed: () => {} },
  });
  return { st, sc };
}
const symbols = (d: Doc) => [...d.nodes.values()].filter((n) => n.type === 'symbol').map((n) => n.name).sort();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agents on live projects', () => {
  it('CLI edits a shared project through its link', async () => {
    const s = await shared();
    const o = observer(s.id, s.tokens.view);
    await o.sc.connect();
    // Async spawn: the server runs in this process, so it must keep serving meanwhile.
    const out = await new Promise<string>((res) => {
      const c = spawn(process.execPath, [BIN, 'add-part', s.link, 'resistor', '0', '0', '--value', '1k'], { env: { ...process.env, HASSASSIN_NO_KICAD: '1' } });
      let o = '';
      c.stdout.on('data', (d) => (o += d));
      c.on('close', () => res(o));
    });
    expect(JSON.parse(out).ref).toBe('R1');
    await wait(150);
    expect(symbols(o.st.doc)).toEqual(['R1']);
    o.sc.close();
  });

  it('MCP agent joins live, shows up as an agent, and its edits reach everyone', async () => {
    const s = await shared();
    const o = observer(s.id, s.tokens.view);
    await o.sc.connect();
    const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HASSASSIN_NO_KICAD: '1' } });
    const pending = new Map<number, (v: any) => void>();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(msg.id)?.(msg);
      }
    });
    let n = 0;
    const rpc = (method: string, params?: unknown) => new Promise<any>((res) => { const id = ++n; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const add = await rpc('tools/call', { name: 'add_part', arguments: { project: s.link, kind: 'led', x: 10, y: 0 } });
    expect(add.result.isError).toBe(false);
    const status = await rpc('tools/call', { name: 'project_status', arguments: { project: s.link } });
    expect(status.result.structuredContent.counts.symbols).toBe(1);
    await wait(150);
    expect(symbols(o.st.doc)).toEqual(['D1']);
    expect([...o.sc.peers.values()].some((p) => p.user.kind === 'agent')).toBe(true);
    // A viewer link cannot be used to edit.
    const denied = await rpc('tools/call', { name: 'add_part', arguments: { project: `${base}/?p=${s.id}&t=${s.tokens.view}`, kind: 'resistor', x: 0, y: 0 } });
    await wait(100);
    expect(symbols(o.st.doc)).toEqual(['D1']);
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toMatch(/view/i);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    o.sc.close();
  });
});
