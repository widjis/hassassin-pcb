/**
 * Live check of the agent's web research (docs/06-agent-plugins.md, A2): for each part number the in-app
 * agent (on a running Hassassin server, with the bundled `web` plugin switched on in the project) is asked
 * to find the manufacturer's datasheet by itself. Each answer is checked here: the address it gives, its
 * trust level, whether it is really a PDF, and the steps the agent took.
 *
 *   node apps/cli/bench/research.ts --server http://127.0.0.1:5193 --project <id> --token <edit token>
 *        [--backend claude|codex|api] [--parallel 2] [--out results.json] [MPN …]
 *
 * Runs on the owner's agent backend (subscription or API), so only when the owner asks for it. The project
 * is only read (Ask mode).
 */
import { writeFileSync } from 'node:fs';
import { trustOf } from '@hassassin/core';

const PARTS: [string, string][] = [
  ['TPS7A02', 'Texas Instruments'], ['STM32G031K8T6', 'STMicroelectronics'], ['ATTINY1616-SNR', 'Microchip'], ['PCA9685PW', 'NXP'],
  ['NCP1117ST33T3G', 'onsemi'], ['IRLML6344TRPBF', 'Infineon'], ['ISL28022', 'Renesas'], ['ESP32-C3-MINI-1', 'Espressif'],
  ['nRF52832-QFAA', 'Nordic Semiconductor'], ['ADM3065E', 'Analog Devices'], ['CP2102N-A02-GQFN24', 'Silicon Labs'], ['AP2112K-3.3TRG1', 'Diodes Inc.'],
  ['SI2302CDS-T1-GE3', 'Vishay'], ['BME280', 'Bosch Sensortec'], ['SHT40-AD1B', 'Sensirion'], ['CH340C', 'WCH'],
  ['RP2040', 'Raspberry Pi'], ['SY8089AAAC', 'Silergy'], ['XC6206P332MR', 'Torex'], ['BD9G341AEFJ', 'ROHM'],
];

const args = process.argv.slice(2);
const opt = (k: string, d = '') => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1]! : d;
};
const server = opt('server', 'http://127.0.0.1:5193');
const project = opt('project');
const token = opt('token');
const backend = opt('backend', 'claude');
const parallel = Math.max(1, Number(opt('parallel', '2')));
const out = opt('out', 'research-results.json');
if (!project || !token) throw new Error('--project and --token are required');
const flagged = new Set(['--server', '--project', '--token', '--backend', '--parallel', '--out']);
const named = args.filter((a, i) => !a.startsWith('--') && !flagged.has(args[i - 1] ?? ''));
const parts = named.length ? named.map((m) => [m, PARTS.find((p) => p[0] === m)?.[1] ?? ''] as [string, string]) : PARTS;

interface Result {
  mpn: string;
  maker: string;
  url: string | null;
  trust: string;
  claimedTrust: string | null;
  /** Whether the address gives a PDF; "blocked" when the site refuses automated access (403 / 429); null when unreachable. */
  pdf: boolean | 'blocked' | null;
  steps: { tool: string; input: string; ok: boolean | undefined }[];
  seconds: number;
  error?: string;
  answer: string;
}

async function isPdf(url: string): Promise<boolean | 'blocked' | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'HassassinPCB-research/0.4 (component datasheet lookup)' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (r.status === 403 || r.status === 429) return 'blocked';
    const b = Buffer.from(await r.arrayBuffer());
    return b.subarray(0, 5).toString('latin1') === '%PDF-';
  } catch {
    return null;
  }
}

async function one(mpn: string, maker: string): Promise<Result> {
  const t0 = Date.now();
  const prompt = `Find the official datasheet of the part ${mpn} on the web by yourself (search, open pages, follow links). Prefer the manufacturer's own site. Do not change the project. At the end, list the steps you took, then give exactly one line:\nDATASHEET: <address of the datasheet PDF> | TRUST: <trust level from the web tools>`;
  const steps: Result['steps'] = [];
  let answer = '';
  let error: string | undefined;
  try {
    const res = await fetch(`${server}/api/agent/${project}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, mode: 'ask', backend, user: { name: 'research bench' } }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const byId = new Map<string, Result['steps'][number]>();
    for (const chunk of (await res.text()).split('\n\n')) {
      if (!chunk.startsWith('data: ')) continue;
      const e = JSON.parse(chunk.slice(6)) as { type: string; id?: string; name?: string; input?: unknown; ok?: boolean; text?: string; message?: string };
      if (e.type === 'tool' && e.name !== 'update_tasks') {
        const s = { tool: e.name!, input: JSON.stringify(e.input ?? {}).slice(0, 160), ok: undefined as boolean | undefined };
        steps.push(s);
        byId.set(e.id!, s);
      } else if (e.type === 'tool_result' && byId.has(e.id!)) byId.get(e.id!)!.ok = e.ok;
      else if (e.type === 'text') answer += e.text;
      else if (e.type === 'error') error = e.message;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  const m = /DATASHEET:\s*<?(\S+?)>?\s*\|\s*TRUST:\s*([a-z]+)/i.exec(answer);
  const url = m?.[1] ?? null;
  return { mpn, maker, url, trust: url ? trustOf(url).level : 'none', claimedTrust: m?.[2]?.toLowerCase() ?? null, pdf: url ? await isPdf(url) : null, steps, seconds: Math.round((Date.now() - t0) / 1000), ...(error ? { error } : {}), answer: answer.slice(-1500) };
}

const results: Result[] = [];
const queue = [...parts];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const r = await one(p[0], p[1]);
      results.push(r);
      console.log(`${r.mpn.padEnd(20)} ${r.trust.padEnd(12)} pdf=${r.pdf} steps=${r.steps.length} ${r.seconds}s ${r.url ?? r.error ?? '(no answer line)'}`);
      writeFileSync(out, JSON.stringify(results, null, 2));
    }
  }),
);
const ok = results.filter((r) => r.trust === 'manufacturer' && r.pdf === true);
console.log(`\n${ok.length} / ${results.length} found the manufacturer's datasheet PDF (checked); manufacturer address the site would not let us check: ${results.filter((r) => r.trust === 'manufacturer' && r.pdf === 'blocked').length}`);
console.log(`${ok.length} / ${results.length} found the manufacturer's datasheet PDF; mirror used as source: ${results.filter((r) => r.trust === 'mirror').length}; claimed trust differs from the address: ${results.filter((r) => r.url && r.claimedTrust && r.claimedTrust !== r.trust).length}`);
