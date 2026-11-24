/**
 * First-party agent plugin "mouser" (docs/06-agent-plugins.md, A4): Mouser's Search API, with the user's own
 * key (MOUSER_API_KEY, a setting kept on the server).
 *
 *   search_parts  keyword search (for example "LDO 3.3 V 500 mA SOT-23-5"), up to 50 parts
 *   get_offers    live price breaks, stock, lifecycle and links for up to 10 part numbers (manufacturer's or
 *                 Mouser's), as `bom` needs them
 *
 * Mouser's Search API terms (checked 2026-11-25) forbid caching, recording or storing its data and building
 * a database from it, and ask for clear attribution: this plugin keeps nothing (no files, no memory between
 * messages), every result names Mouser Electronics as its source with its retrieval time and Mouser's links
 * unchanged, and the agent is told not to write Mouser's prices or stock into the project. Calls stay
 * within Mouser's limits (30 a minute; a budget per message, MOUSER_MAX_CALLS).
 *
 * Every result has the common shape of A4: MPN, manufacturer, description, parameters, package, lifecycle,
 * stock, price breaks with currency, datasheet URL, product URL, source and retrieval time.
 *
 * An MCP server over stdio (newline-delimited JSON-RPC 2.0), written from the MCP specification; no
 * dependencies. MOUSER_ENDPOINT replaces Mouser's address (tests only).
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const env = process.env;
const ENDPOINT = (env.MOUSER_ENDPOINT || 'https://api.mouser.com').replace(/\/+$/, '');
const MAX_CALLS = Number(env.MOUSER_MAX_CALLS) > 0 ? Math.floor(Number(env.MOUSER_MAX_CALLS)) : 20;
const PER_MINUTE = 30;
const SOURCE = 'Mouser Electronics';
const ATTRIBUTION = 'Data from Mouser Electronics (mouser.com), retrieved live. Name Mouser as the source when you show it and keep its links as given. Do not store its prices, stock or other data in the project (no import_offers, no copies into properties): only the part the user chooses (MPN, manufacturer, Mouser part number, links).';

const INSTRUCTIONS = `Mouser catalogue (live, through the user's Mouser Search API key).
- search_parts for a keyword (function, key values, package); get_offers for the current price breaks and stock of part numbers you already have (up to 10 per call).
- Results are live data from Mouser Electronics: say so when you show them ("Mouser, <time>"). Mouser's terms forbid storing them: never put Mouser prices or stock into the project (no import_offers, no properties with prices). When a part is chosen, set_part_info with its mpn, manufacturer, datasheet link and mouser part number is fine.
- Parameters are as Mouser gives them; a value Mouser does not give is unknown, never assumed. Check key values in the datasheet.
- There is a budget of calls per message and Mouser allows 30 a minute and 1,000 a day: search with specific words, and ask for offers of several part numbers in one call.`;

export class ToolError extends Error {}

/** One part in the common shape of A4. */
export interface DistributorPart {
  source: string;
  mpn: string;
  manufacturer: string;
  description: string;
  distributorPartNumber: string | null;
  parameters: Record<string, string>;
  package: string | null;
  category: string | null;
  lifecycle: string | null;
  rohs: string | null;
  stock: number | null;
  leadTime: string | null;
  moq: number | null;
  multiple: number | null;
  priceBreaks: { qty: number; price: number; currency: string }[];
  datasheetUrl: string | null;
  productUrl: string | null;
  suggestedReplacement: string | null;
  retrievedAt: string;
}

interface MouserPart {
  ManufacturerPartNumber?: string;
  Manufacturer?: string;
  Description?: string;
  MouserPartNumber?: string;
  Category?: string;
  LifecycleStatus?: string | null;
  IsDiscontinued?: string;
  ROHSStatus?: string;
  Availability?: string;
  AvailabilityInStock?: string | null;
  LeadTime?: string;
  Min?: string;
  Mult?: string;
  DataSheetUrl?: string;
  ProductDetailUrl?: string;
  SuggestedReplacement?: string;
  ProductAttributes?: { AttributeName?: string; AttributeValue?: string }[];
  PriceBreaks?: { Quantity?: number; Price?: string; RawPrice?: number; Currency?: string }[];
}

const int = (s: unknown): number | null => {
  const m = String(s ?? '').replace(/[,.\s](?=\d{3}\b)/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

/** "$0.52", "0,52 €", "1.234,50 €", "1,234.50" → a number. */
export function parsePrice(s: string): number | null {
  let t = s.replace(/[^\d.,]/g, '');
  if (!t) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Mouser's part record in the common shape. */
export function toCommon(p: MouserPart, retrievedAt: string): DistributorPart {
  const parameters: Record<string, string> = {};
  for (const a of p.ProductAttributes ?? []) {
    const k = String(a.AttributeName ?? '').trim();
    const v = String(a.AttributeValue ?? '').trim();
    if (k && v) parameters[k] = parameters[k] ? `${parameters[k]}, ${v}` : v;
  }
  const pkg = Object.entries(parameters).find(([k]) => /^(package|package \/ case|case)$/i.test(k))?.[1] ?? null;
  const lifecycle = p.LifecycleStatus ? String(p.LifecycleStatus) : p.IsDiscontinued === 'true' ? 'Discontinued' : null;
  const stock = p.AvailabilityInStock != null && p.AvailabilityInStock !== '' ? int(p.AvailabilityInStock) : /in stock/i.test(p.Availability ?? '') ? int(p.Availability) : p.Availability ? 0 : null;
  const priceBreaks = (p.PriceBreaks ?? [])
    .map((b) => ({ qty: Number(b.Quantity) || 0, price: typeof b.RawPrice === 'number' ? b.RawPrice : parsePrice(String(b.Price ?? '')), currency: String(b.Currency ?? '') }))
    .filter((b): b is { qty: number; price: number; currency: string } => b.qty > 0 && b.price !== null && b.price > 0)
    .sort((a, b) => a.qty - b.qty);
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    source: SOURCE,
    mpn: String(p.ManufacturerPartNumber ?? ''),
    manufacturer: String(p.Manufacturer ?? ''),
    description: String(p.Description ?? ''),
    distributorPartNumber: s(p.MouserPartNumber),
    parameters,
    package: pkg,
    category: s(p.Category),
    lifecycle,
    rohs: s(p.ROHSStatus),
    stock,
    leadTime: s(p.LeadTime),
    moq: int(p.Min),
    multiple: int(p.Mult),
    priceBreaks,
    datasheetUrl: s(p.DataSheetUrl),
    productUrl: s(p.ProductDetailUrl),
    suggestedReplacement: s(p.SuggestedReplacement),
    retrievedAt,
  };
}

// ------------------------------------------------------------------ calls to Mouser

const used = { calls: 0, recent: [] as number[] };

async function call(path: string, body: unknown): Promise<MouserPart[]> {
  const key = env.MOUSER_API_KEY;
  if (!key) throw new ToolError('The Mouser plugin has no API key (MOUSER_API_KEY). The user applies for their own key at mouser.com/api-search and fills it in in the Plugins section on the server; go on without Mouser meanwhile.');
  if (used.calls >= MAX_CALLS) throw new ToolError(`Limit reached: ${MAX_CALLS} Mouser calls for this message. Stop and tell the user what you found so far.`);
  // Mouser allows 30 calls a minute: wait when this process made that many in the last minute.
  const now = Date.now();
  used.recent = used.recent.filter((t) => now - t < 60_000);
  if (used.recent.length >= PER_MINUTE) await new Promise((r) => setTimeout(r, 60_000 - (now - used.recent[0]!) + 50));
  used.calls++;
  used.recent.push(Date.now());
  let r: Response;
  try {
    // The key goes in the query string, as Mouser asks; it never appears in a result or an error.
    r = await fetch(`${ENDPOINT}${path}?apiKey=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'HassassinPCB/0.4' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new ToolError(`Mouser could not be reached (${(e as Error).name === 'TimeoutError' ? 'no answer within 20 s' : (e as Error).message.replace(key, '[key]')}).`);
  }
  if (r.status === 429) throw new ToolError('Mouser says too many calls (30 a minute, 1,000 a day per key). Stop and tell the user; try again later.');
  if (r.status === 401 || r.status === 403) throw new ToolError('Mouser refused the API key. The user checks it in the Plugins section (a Search API key, not a Cart or Order key).');
  if (!r.ok) throw new ToolError(`Mouser answered ${r.status}.`);
  const j = (await r.json().catch(() => null)) as { Errors?: { Code?: string; Message?: string }[]; SearchResults?: { NumberOfResult?: number; Parts?: MouserPart[] } } | null;
  if (!j) throw new ToolError('Mouser sent an answer that is not JSON.');
  const errs = (j.Errors ?? []).filter((e) => e && (e.Message || e.Code));
  if (errs.length) {
    const msg = errs.map((e) => e.Message || e.Code).join('; ').replace(key, '[key]');
    if (/key|invalid.*api|unauthori/i.test(msg)) throw new ToolError(`Mouser refused the API key (${msg}). The user checks it in the Plugins section.`);
    if (/limit|exceed|too many/i.test(msg)) throw new ToolError(`Mouser's call limit was reached (${msg}). Stop and tell the user; try again later.`);
    throw new ToolError(`Mouser: ${msg}`);
  }
  return j.SearchResults?.Parts ?? [];
}

export async function searchParts(args: Record<string, unknown>): Promise<unknown> {
  const keyword = String(args.keyword ?? args.query ?? '').trim();
  if (!keyword) throw new ToolError('Give "keyword", for example "LDO 3.3V 500mA SOT-23-5".');
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const opt = args.in_stock && args.rohs ? 'RohsAndInStock' : args.in_stock ? 'InStock' : args.rohs ? 'Rohs' : 'None';
  const parts = await call('/api/v1/search/keyword', { SearchByKeywordRequest: { keyword, records: limit, startingRecord: 0, searchOptions: opt, searchWithYourSignUpLanguage: 'false' } });
  const at = new Date().toISOString();
  return { source: SOURCE, attribution: ATTRIBUTION, retrievedAt: at, keyword, parts: parts.slice(0, limit).map((p) => toCommon(p, at)) };
}

export async function getOffers(args: Record<string, unknown>): Promise<unknown> {
  const raw = Array.isArray(args.part_numbers) ? args.part_numbers : String(args.part_numbers ?? args.mpn ?? '').split(/[|,\n]/);
  const pns = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  if (!pns.length) throw new ToolError('Give "part_numbers": manufacturer or Mouser part numbers, up to 10.');
  if (pns.length > 10) throw new ToolError('At most 10 part numbers per call: split them.');
  if (pns.some((p) => p.includes('|'))) throw new ToolError('Part numbers may not contain "|".');
  const exact = args.exact !== false;
  const parts = await call('/api/v1/search/partnumber', { SearchByPartRequest: { mouserPartNumber: pns.join('|'), partSearchOptions: exact ? 'Exact' : 'None' } });
  const at = new Date().toISOString();
  const common = parts.map((p) => toCommon(p, at));
  const norm = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
  const found = pns.map((pn) => ({ partNumber: pn, parts: common.filter((c) => norm(c.mpn) === norm(pn) || norm(c.distributorPartNumber ?? '') === norm(pn) || (!exact && norm(c.mpn).startsWith(norm(pn)))) }));
  return { source: SOURCE, attribution: ATTRIBUTION, retrievedAt: at, results: found, notFound: found.filter((f) => !f.parts.length).map((f) => f.partNumber) };
}

const TOOLS = [
  {
    name: 'search_parts',
    description: 'Search Mouser\'s catalogue by keyword (function, key values, package, manufacturer or part number). Each part: MPN, manufacturer, description, parameters, package, lifecycle, stock, price breaks with currency, datasheet and product links, retrieval time. Live data from Mouser Electronics: show it as such and never store it in the project.',
    inputSchema: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number', description: 'Parts, 1–50 (default 20)' }, in_stock: { type: 'boolean', description: 'Only parts in stock' }, rohs: { type: 'boolean', description: 'Only RoHS-compliant parts' } }, required: ['keyword'] },
  },
  {
    name: 'get_offers',
    description: 'Live price breaks, stock, lifecycle and links at Mouser for up to 10 part numbers (manufacturer\'s or Mouser\'s) in one call. For the BOM and for comparing candidates. Never store the result in the project.',
    inputSchema: { type: 'object', properties: { part_numbers: { type: 'array', items: { type: 'string' }, description: 'Up to 10' }, exact: { type: 'boolean', description: 'Exact part numbers only (default true)' } }, required: ['part_numbers'] },
  },
];

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
async function handle(m: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }): Promise<void> {
  const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return void reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hassassin-mouser', version: '0.4.0' }, instructions: INSTRUCTIONS });
  if (m.method === 'ping') return void reply({});
  if (m.method === 'tools/list') return void reply({ tools: TOOLS });
  if (m.method === 'tools/call') {
    const args = m.params?.arguments ?? {};
    try {
      const name = m.params?.name;
      const out = name === 'search_parts' ? await searchParts(args) : name === 'get_offers' ? await getOffers(args) : null;
      if (out === null) throw new ToolError(`Unknown tool ${name}`);
      return void reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false });
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `Could not complete it: ${(e as Error).message}`;
      return void reply({ content: [{ type: 'text', text: env.MOUSER_API_KEY ? msg.split(env.MOUSER_API_KEY).join('[key]') : msg }], isError: true });
    }
  }
  if (m.method?.startsWith('notifications/')) return;
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createInterface({ input: process.stdin }).on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    void handle(m);
  });
}
