import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = join(import.meta.dirname, '..', 'bin', 'hassassin.mjs');
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HASSASSIN_NO_KICAD: '1' } });
  return { code: r.status, json: r.stdout.trim().startsWith('{') || r.stdout.trim().startsWith('[') ? JSON.parse(r.stdout) : r.stdout, stderr: r.stderr };
};

describe('hassassin CLI', () => {
  it('builds a small design end to end', { timeout: 30000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcli-'));
    const f = join(dir, 'led.hpcb');
    expect(run('new', f).code).toBe(0);
    expect(run('add-part', f, 'resistor', '0', '0', '--value', '220').json.ref).toBe('R1');
    expect(run('add-part', f, 'led', '15.24', '7.62').json.ref).toBe('D1');
    expect(run('connect-pins', f, 'R1.2', 'D1.2').json.net).toBe('Net-(D1-A)');
    run('add-label', f, 'R1.1', 'VBUS', '--global');
    run('add-label', f, 'D1.1', 'GND', '--global');
    expect(run('run-erc', f).json.errors).toBe(0);
    expect(run('update-pcb', f).json.componentsAdded).toEqual(['R1', 'D1']);
    run('move-part', f, 'R1', '110', '120');
    run('move-part', f, 'D1', '120', '120', '90');
    expect(run('route', f, 'R1.2', 'D1.2').json.netFullyConnected).toBe(true);
    const drc = run('run-drc', f, '--fail-on-error');
    expect(drc.json.errors).toBe(0);
    expect(drc.code).toBe(0);
    const zip = join(dir, 'fab.zip');
    expect(run('export-fab', f, '-o', zip).json.bytes).toBeGreaterThan(1000);
    expect(existsSync(zip)).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8')).format).toBe('hassassin-pcb');
  });

  it('reports errors as JSON with a non-zero exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcli-'));
    const f = join(dir, 'p.hpcb');
    run('new', f);
    const r = run('connect-pins', f, 'R1.1', 'R2.1');
    expect(r.code).toBe(1);
    expect(r.json.error).toMatch(/Nothing matches "R1.1"/);
    expect(run('bogus-command', f).code).toBe(1);
  });

  it('fails CI on DRC errors with --fail-on-error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcli-'));
    const f = join(dir, 'p.hpcb');
    run('new', f);
    run('add-part', f, 'resistor', '0', '0');
    run('add-part', f, 'resistor', '10.16', '0');
    run('connect-pins', f, 'R1.2', 'R2.2');
    run('update-pcb', f); // parts stay parked outside the board: DRC errors
    expect(run('run-drc', f, '--fail-on-error').code).toBe(2);
  });
});

describe('hassassin MCP server', () => {
  it('speaks MCP over stdio and edits a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hmcp-'));
    const f = join(dir, 'm.hpcb');
    const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HASSASSIN_NO_KICAD: '1' } });
    const pending = new Map<number, (v: any) => void>();
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const rpc = (method: string, params?: unknown) =>
      new Promise<any>((res) => {
        const n = ++id;
        pending.set(n, res);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      });
    const call = async (name: string, args: Record<string, unknown>) => (await rpc('tools/call', { name, arguments: args })).result;

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.result.serverInfo.name).toBe('hassassin-pcb');
    expect(init.result.capabilities.tools).toBeTruthy();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list');
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['new_project', 'import_kicad', 'project_status', 'add_part', 'run_drc', 'update_pcb']));
    expect(list.result.tools.find((t: any) => t.name === 'add_part').inputSchema.required).toContain('project');

    expect((await call('new_project', { path: f })).isError).toBe(false);
    const add = await call('add_part', { project: f, kind: 'capacitor', x: 0, y: 0, value: '100n' });
    expect(add.structuredContent.ref).toBe('C1');
    // Undo works inside one MCP session (the project stays loaded).
    expect((await call('undo', { project: f })).structuredContent.undid).toBe('Add C');
    const status = await call('project_status', { project: f });
    expect(status.structuredContent.counts.symbols).toBe(0);
    const bad = await call('add_part', { project: f, kind: 'unicorn', x: 0, y: 0 });
    expect(bad.isError).toBe(true);
    const unknown = await rpc('does/not/exist');
    expect(unknown.error.code).toBe(-32601);
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  });
});
