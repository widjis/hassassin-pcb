/**
 * A4 (docs/06-agent-plugins.md): the bundled Mouser plugin. Mouser's terms forbid recording its data, so the
 * responses here are made up in Mouser's format (fictional parts "TST…"), served locally: no network.
 * Checked: the common result shape, what is missing without a key, limits and errors (the key never shown),
 * nothing stored on disk, the key filled in on the server, and live BOM prices that never reach the project.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toFile } from '@hassassin/core';
import { newProject, runTool } from '@hassassin/tools';
import { McpClient } from '../src/plugins.ts';
import { startServer } from '../src/server.ts';
import { parsePrice, toCommon } from '../../../plugins/mouser/server.ts';

const PLUGIN = join(import.meta.dirname, '..', '..', '..', 'plugins', 'mouser', 'server.ts');
const BUILTIN = join(import.meta.dirname, '..', '..', '..', 'plugins');
const KEY = 'test-key-0123456789abcdef';

/** A made-up part in the format of Mouser's Search API (not Mouser data). */
const part = (mpn: string, over: Record<string, unknown> = {}) => ({
  Availability: '1,234 In Stock',
  AvailabilityInStock: '1234',
  DataSheetUrl: `https://example.com/ds/${mpn}.pdf`,
  Description: 'LDO Voltage Regulators 3.3V 500mA test part',
  Category: 'LDO Voltage Regulators',
  LeadTime: '42 Days',
  LifecycleStatus: null,
  Manufacturer: 'Test Semi',
  ManufacturerPartNumber: mpn,
  Min: '1',
  Mult: '1',
  MouserPartNumber: `999-${mpn}`,
  ProductAttributes: [
    { AttributeName: 'Packaging', AttributeValue: 'Reel' },
    { AttributeName: 'Packaging', AttributeValue: 'Cut Tape' },
    { AttributeName: 'Package / Case', AttributeValue: 'SOT-23-5' },
  ],
  PriceBreaks: [
    { Quantity: 10, Price: '$0.40', Currency: 'USD' },
    { Quantity: 1, Price: '$0.52', Currency: 'USD' },
    { Quantity: 100, Price: '$0.31', Currency: 'USD' },
  ],
  ProductDetailUrl: `https://example.com/p/${mpn}`,
  ROHSStatus: 'RoHS Compliant',
  IsDiscontinued: 'false',
  ...over,
});

let fake: Server;
let base = '';
const seen: { path: string; key: string | null; body: unknown }[] = [];
let mode: 'ok' | 'limit' | 'badkey' = 'ok';

const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => r(s));
});

beforeAll(async () => {
  fake = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const body = JSON.parse((await readBody(req)) || '{}');
    seen.push({ path: u.pathname, key: u.searchParams.get('apiKey'), body });
    if (mode === 'limit') return void (res.writeHead(429), res.end());
    if (mode === 'badkey') return void (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ Errors: [{ Code: 'Invalid', Message: `Invalid unique identifier ${u.searchParams.get('apiKey')}` }], SearchResults: null })));
    let parts: unknown[] = [];
    if (u.pathname === '/api/v1/search/keyword') parts = [part('TSTLDO33A'), part('TSTLDO33B', { AvailabilityInStock: null, Availability: 'None', LifecycleStatus: 'End of Life', PriceBreaks: [{ Quantity: 1, Price: '0,61 €', Currency: 'EUR' }] })];
    if (u.pathname === '/api/v1/search/partnumber') parts = String(body.SearchByPartRequest?.mouserPartNumber ?? '').split('|').filter((p) => p.startsWith('TST')).map((p) => part(p));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Errors: [], SearchResults: { NumberOfResult: parts.length, Parts: parts } }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(() => fake.close());

const start = async (env: Record<string, string>) => {
  const c = new McpClient(process.execPath, [PLUGIN], { MOUSER_ENDPOINT: base, ...env });
  await c.start();
  return c;
};

describe('the Mouser plugin (A4)', () => {
  it('prices and records in the common shape', () => {
    expect(parsePrice('$0.52')).toBe(0.52);
    expect(parsePrice('0,52 €')).toBe(0.52);
    expect(parsePrice('1.234,50 €')).toBe(1234.5);
    expect(parsePrice('1,234.50')).toBe(1234.5);
    const c = toCommon(part('TSTLDO33A'), '2026-11-25T00:00:00.000Z');
    expect(c).toMatchObject({ source: 'Mouser Electronics', mpn: 'TSTLDO33A', manufacturer: 'Test Semi', distributorPartNumber: '999-TSTLDO33A', package: 'SOT-23-5', lifecycle: null, stock: 1234, moq: 1, datasheetUrl: 'https://example.com/ds/TSTLDO33A.pdf', productUrl: 'https://example.com/p/TSTLDO33A', retrievedAt: '2026-11-25T00:00:00.000Z' });
    expect(c.parameters.Packaging).toBe('Reel, Cut Tape');
    expect(c.priceBreaks).toEqual([{ qty: 1, price: 0.52, currency: 'USD' }, { qty: 10, price: 0.4, currency: 'USD' }, { qty: 100, price: 0.31, currency: 'USD' }]);
    expect(toCommon(part('X', { IsDiscontinued: 'true' }), 'now').lifecycle).toBe('Discontinued');
  });

  it('searches and gets offers live, keeping nothing', async () => {
    const store = mkdtempSync(join(tmpdir(), 'hmouser-'));
    const c = await start({ MOUSER_API_KEY: KEY, HASSASSIN_PLUGIN_DATA: join(store, 'p') });
    try {
      seen.length = 0;
      const s = await c.callTool('search_parts', { keyword: 'LDO 3.3 V 500 mA SOT-23-5', limit: 5, in_stock: true });
      expect(s.isError).toBe(false);
      const j = JSON.parse(s.text);
      expect(j.attribution).toMatch(/Mouser Electronics.*Do not store/);
      expect(j.parts).toHaveLength(2);
      for (const p of j.parts) for (const k of ['mpn', 'manufacturer', 'description', 'parameters', 'package', 'lifecycle', 'stock', 'priceBreaks', 'datasheetUrl', 'productUrl', 'source', 'retrievedAt']) expect(p).toHaveProperty(k);
      expect(j.parts[1]).toMatchObject({ stock: 0, lifecycle: 'End of Life', priceBreaks: [{ qty: 1, price: 0.61, currency: 'EUR' }] });
      expect(seen[0]).toEqual({ path: '/api/v1/search/keyword', key: KEY, body: { SearchByKeywordRequest: { keyword: 'LDO 3.3 V 500 mA SOT-23-5', records: 5, startingRecord: 0, searchOptions: 'InStock', searchWithYourSignUpLanguage: 'false' } } });
      const o = JSON.parse((await c.callTool('get_offers', { part_numbers: ['TSTLDO33A', 'NOPE-1'] })).text);
      expect(seen[1]!.body).toEqual({ SearchByPartRequest: { mouserPartNumber: 'TSTLDO33A|NOPE-1', partSearchOptions: 'Exact' } });
      expect(o.results[0].parts[0]).toMatchObject({ mpn: 'TSTLDO33A', stock: 1234 });
      expect(o.notFound).toEqual(['NOPE-1']);
      expect((await c.callTool('get_offers', { part_numbers: Array.from({ length: 11 }, (_, i) => `TST${i}`) })).text).toMatch(/At most 10/);
    } finally {
      c.close();
    }
    // Nothing from Mouser is written anywhere (the plugin has no storage of its own).
    expect(existsSync(join(store, 'p'))).toBe(false);
    expect(readdirSync(store)).toEqual([]);
  });

  it('says what is missing without a key; limits and errors never show the key', async () => {
    const none = await start({});
    expect((await none.callTool('search_parts', { keyword: 'LDO' })).text).toMatch(/no API key \(MOUSER_API_KEY\).*mouser\.com\/api-search.*Plugins section/);
    none.close();
    const c = await start({ MOUSER_API_KEY: KEY, MOUSER_MAX_CALLS: '2' });
    try {
      mode = 'badkey';
      const bad = await c.callTool('search_parts', { keyword: 'LDO' });
      expect(bad).toMatchObject({ isError: true });
      expect(bad.text).toMatch(/refused the API key/);
      expect(bad.text).not.toContain(KEY);
      mode = 'limit';
      expect((await c.callTool('search_parts', { keyword: 'LDO' })).text).toMatch(/too many calls.*30 a minute, 1,000 a day/);
      mode = 'ok';
      expect((await c.callTool('search_parts', { keyword: 'LDO' })).text).toMatch(/Limit reached: 2 Mouser calls/);
    } finally {
      mode = 'ok';
      c.close();
    }
  });
});

describe('Mouser on the server (A4)', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let url = '';
  let data = '';
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), 'hmsrv-'));
    // The bundled Mouser plugin, pointed at the made-up Mouser (an entry with its id replaces the bundled one).
    const m = JSON.parse(readFileSync(join(BUILTIN, 'mouser', 'plugin.json'), 'utf8'));
    writeFileSync(join(data, 'plugins.json'), JSON.stringify({ plugins: [{ ...m, command: PLUGIN, settings: [...m.settings, { key: 'MOUSER_ENDPOINT', label: 'tests' }] }] }));
    srv = await startServer({ port: 0, dataDir: data, kicad: false, builtinPlugins: BUILTIN });
    url = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  it('the key is filled in on the server, never sent back; BOM prices are live and never stored', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', x: 0, y: 0, ref: 'U1', pin_names: 'IN, GND, EN, NC, OUT' });
    await runTool(p, 'set_part_info', { ref: 'U1', mpn: 'TSTLDO33A', manufacturer: 'Test Semi', mouser: '999-TSTLDO33A' });
    const r = await fetch(`${url}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'M', doc: toFile(p.doc) }) });
    const { id, tokens } = (await r.json()) as { id: string; tokens: { edit: string; view: string } };
    const plugins = async () => (await (await fetch(`${url}/api/agent/${id}/plugins?token=${tokens.edit}&refresh=1`)).json()) as { plugins: { id: string; settings: { key: string; configured: boolean }[]; status: { ok: boolean; error?: string } }[] };
    const mouser = async () => (await plugins()).plugins.find((x) => x.id === 'mouser')!;
    expect((await mouser()).status).toMatchObject({ ok: false, error: expect.stringMatching(/Mouser Search API key/) });
    const live = () => fetch(`${url}/api/agent/${id}/live-offers?token=${tokens.view}`, { method: 'POST', body: JSON.stringify({ mpns: ['TSTLDO33A', 'GONE-2'], user: { name: 'Ana' } }) });
    expect((await live()).status).toBe(400);
    const set = await fetch(`${url}/api/agent/${id}/plugins/settings?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'mouser', values: { MOUSER_API_KEY: KEY, MOUSER_ENDPOINT: base } }) });
    expect(set.status).toBe(200);
    expect((await fetch(`${url}/api/agent/${id}/plugins/settings?token=${tokens.edit}`, { method: 'POST', body: JSON.stringify({ plugin: 'mouser', values: { NOT_A_SETTING: 'x' } }) })).status).toBe(400);
    expect(statSync(join(data, 'plugin-settings.json')).mode & 0o077).toBe(0);
    const listed = await (await fetch(`${url}/api/agent/${id}/plugins?token=${tokens.edit}&refresh=1`)).text();
    expect(listed).not.toContain(KEY);
    expect((await mouser()).status.ok).toBe(true);
    const lr = await live();
    expect(lr.status).toBe(200);
    const j = (await lr.json()) as { source: string; offers: Record<string, { supplier: string; sku: string; stock: number; currency: string; breaks: unknown[]; live: boolean; url: string }[]>; notFound: string[] };
    expect(j.source).toBe('Mouser Electronics');
    expect(j.offers.tstldo33a![0]).toMatchObject({ supplier: 'Mouser', sku: '999-TSTLDO33A', stock: 1234, currency: 'USD', live: true, url: 'https://example.com/p/TSTLDO33A' });
    expect(j.notFound).toEqual(['GONE-2']);
    // The project is unchanged: no offers stored; the call is in the plugin log without the key.
    const file = await (await fetch(`${url}/api/projects/${id}/file?token=${tokens.edit}`)).text();
    expect(file).not.toMatch(/0\.52|"offers"/);
    expect(file).toContain('999-TSTLDO33A');
    const log = readFileSync(join(data, 'plugin-log', `${id}.jsonl`), 'utf8');
    expect(log).toMatch(/"tool":"get_offers"/);
    expect(log).not.toContain(KEY);
  });
});
