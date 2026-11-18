/**
 * A3 (docs/06-agent-plugins.md): the bundled datasheets plugin keeps a project's datasheets (downloaded once,
 * under their SHA-256) and reads them: the pages with a phrase, the text of pages with table cells apart.
 * The PDFs are made here and served locally (no network in the tests).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { newProject, runTool } from '@hassassin/tools';
import { McpClient, PluginHost } from '../src/plugins.ts';
import { startServer } from '../src/server.ts';
import { layoutLines } from '../../../plugins/datasheets/server.ts';

const BUILTIN = join(import.meta.dirname, '..', '..', '..', 'plugins');

/** A small PDF: each page a list of [x, y, text] in Helvetica 10 pt. */
function makePdf(pages: [number, number, string][][], title = 'XYZ123 datasheet'): Buffer {
  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + 1 + pages.length * 2; // after the page and content objects
  const kids: number[] = [];
  for (const lines of pages) {
    const body = lines.map(([x, y, t]) => `BT /F1 10 Tf ${x} ${y} Td (${t.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const info = add(`<< /Title (${title}) /Producer (tests) >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PDF = makePdf([
  [[72, 720, 'XYZ123 300 mA Low-Dropout Regulator'], [72, 700, '1 Features'], [72, 680, 'Input 2.5 V to 6 V, output 3.3 V']],
  [
    [72, 720, 'Table 5-1. Pin Functions'],
    [72, 700, 'NAME'], [150, 700, 'PIN'], [220, 700, 'I/O'], [300, 700, 'DESCRIPTION'],
    [72, 685, 'EN'], [150, 685, '3'], [220, 685, 'Input'], [300, 685, 'Enable pin'],
    [72, 670, 'GND'], [150, 670, '2'], [220, 670, '-'], [300, 670, 'Ground'],
    [72, 655, 'OUT'], [150, 655, '5'], [220, 655, 'Output'], [300, 655, 'Regulated output'],
  ],
  [[72, 720, '9 Typical Application'], [72, 700, 'Use a 1 uF input capacitor and a 1 uF output capacitor.']],
]);
const SHA = createHash('sha256').update(PDF).digest('hex');

let web: Server;
let port = 0;
let hits = 0;
beforeAll(async () => {
  web = createServer((req, res) => {
    if (req.url === '/ds/xyz123.pdf') return (hits++, res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF));
    if (req.url === '/product') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>product</body></html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  port = (web.address() as { port: number }).port;
});
afterAll(() => web.close());

async function plugin(data: string, project = 'p1') {
  const host = new PluginHost(data, BUILTIN);
  const { plugins, skipped } = await host.active(['datasheets'], 'ask', project);
  expect(skipped).toEqual([]);
  const p = plugins[0]!;
  const c = new McpClient(p.command, p.args, { ...p.env, WEB_ALLOW_PRIVATE: '1' }, 20000);
  await c.start();
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await c.callTool(tool, args);
    return r.isError ? { error: r.text } : (JSON.parse(r.text) as Record<string, unknown>);
  };
  return { host, p, c, call };
}

describe('the datasheets plugin (A3)', () => {
  it('lays a table out as cells: wide gaps become " | ", lines in reading order', () => {
    const lines = layoutLines([
      { str: 'GND', x: 72, y: 670, w: 20, h: 10 },
      { str: 'EN', x: 72, y: 685, w: 12, h: 10 },
      { str: '3', x: 150, y: 685, w: 6, h: 10 },
      { str: 'Enable', x: 300, y: 685.4, w: 30, h: 10 },
      { str: 'pin', x: 333, y: 685, w: 14, h: 10 },
      { str: '2', x: 150, y: 670, w: 6, h: 10 },
    ]);
    expect(lines).toEqual(['EN | 3 | Enable pin', 'GND | 2']);
  });

  it('keeps a datasheet once per project, finds the pin table and reads it; offline from the stored copy', async () => {
    const data = mkdtempSync(join(tmpdir(), 'hds-'));
    const { host, p, c, call } = await plugin(data);
    expect(p.env.HASSASSIN_PLUGIN_DATA).toBe(host.pluginData('datasheets', 'p1'));
    const url = `http://127.0.0.1:${port}/ds/xyz123.pdf`;
    const g = await call('get_datasheet', { url, mpn: 'xyz123-dbv' });
    expect(g).toMatchObject({ sha256: SHA, pages: 3, title: 'XYZ123 datasheet', trust: 'unverified', cached: false, mpns: ['XYZ123-DBV'] });
    expect(hits).toBe(1);
    // Asked again by address or by part number: the stored copy, no download.
    expect(await call('get_datasheet', { url })).toMatchObject({ sha256: SHA, cached: true });
    expect(await call('get_datasheet', { mpn: 'XYZ123-DBV' })).toMatchObject({ sha256: SHA, cached: true });
    expect(hits).toBe(1);
    const f = (await call('find_in_datasheet', { mpn: 'XYZ123-DBV', words: ['Pin Functions', 'Pin Configuration'] })) as { pages: { page: number; matches: Record<string, number> }[] };
    expect(f.pages[0]).toMatchObject({ page: 2, matches: { 'Pin Functions': 1 } });
    expect(((await call('find_in_datasheet', { sha256: SHA.slice(0, 12), words: ['Typical Application'] })) as { pages: { page: number }[] }).pages.map((x) => x.page)).toEqual([3]);
    const r = (await call('read_datasheet', { mpn: 'XYZ123-DBV', pages: '2' })) as { notice: string; pages: { page: number; text: string }[] };
    expect(r.notice).toMatch(/not instructions/);
    expect(r.pages[0]!.text).toContain('EN | 3 | Input | Enable pin');
    expect(r.pages[0]!.text).toContain('OUT | 5 | Output | Regulated output');
    expect(((await call('list_datasheets', {})) as { datasheets: unknown[] }).datasheets).toHaveLength(1);
    // Not a PDF, an unknown part, a page out of range.
    expect((await call('get_datasheet', { url: `http://127.0.0.1:${port}/product` })).error).toMatch(/not a PDF/);
    expect((await call('get_datasheet', { mpn: 'NOPE' })).error).toMatch(/Find the datasheet's address first/);
    expect((await call('read_datasheet', { mpn: 'XYZ123-DBV', pages: '9' })).error).toMatch(/between 1 and 3/);
    c.close();
    // Another project has its own storage; this one works without the network.
    const other = await plugin(data, 'p2');
    expect((await other.call('get_datasheet', { mpn: 'XYZ123-DBV' })).error).toMatch(/No stored datasheet/);
    other.c.close();
    const again = await plugin(data, 'p1');
    web.close();
    expect(await again.call('read_datasheet', { mpn: 'XYZ123-DBV', pages: '1' })).toMatchObject({ pageCount: 3 });
    again.c.close();
  });
});

describe('stored datasheets on the collaboration server (A3)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  let data = '';
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'hdssrv-'));
    srv = await startServer({ port: 0, dataDir: data, kicad: false, agentModel: null });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  it('serves a stored copy to anyone with a link to the project, and the part records it', async () => {
    const r = await fetch(`${base}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'D', doc: toFile(newProject().doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { view: string } };
    const host = new PluginHost(data, BUILTIN);
    const dir = host.pluginData('datasheets', id);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SHA}.pdf`), PDF);
    const got = await fetch(`${base}/api/agent/${id}/datasheets/${SHA}?token=${tokens.view}`);
    expect(got.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await got.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await fetch(`${base}/api/agent/${id}/datasheets/${'0'.repeat(64)}?token=${tokens.view}`)).status).toBe(404);
    expect((await fetch(`${base}/api/agent/${id}/datasheets/${SHA}?token=nope`)).status).toBe(403);
    // The bundled plugins: web and datasheets.
    const list = (await (await fetch(`${base}/api/agent/${id}/plugins?token=${tokens.view}`)).json()) as { plugins: { id: string }[] };
    expect(list.plugins.map((x) => x.id)).toEqual(['datasheets', 'web']);
    // set_part_info records the stored copy on the part.
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await expect(runTool(p, 'set_part_info', { ref: 'R1', datasheet_sha256: 'abc' })).rejects.toThrow(/64-character SHA-256/);
    await runTool(p, 'set_part_info', { ref: 'R1', datasheet: 'https://www.ti.com/x.pdf', datasheet_sha256: SHA });
    expect([...p.doc.nodes.values()].find((n) => n.type === 'symbol')!.props).toMatchObject({ Datasheet: 'https://www.ti.com/x.pdf', DatasheetSha256: SHA });
  });
});
