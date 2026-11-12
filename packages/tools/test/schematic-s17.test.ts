import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPinLevel, ERC_PIN_TYPES, kicadSchematic, runErc, type PinType } from '@hassassin/core';
import { newProject, openProject, runTool, saveProject, type Project } from '@hassassin/tools';

/** Two single-pin parts of the given types joined by a label (one pair per call). */
async function pair(p: Project, n: number, a: PinType, b: PinType, ids: Map<string, string>): Promise<string> {
  for (const t of [a, b]) if (!ids.has(t)) ids.set(t, ((await runTool(p, 'create_symbol', { name: `T_${t}`, pins: `1,P,${t}`, prefix: 'U' })) as { id: string }).id);
  const x = (n % 8) * 60.96;
  const y = Math.floor(n / 8) * 30.48;
  await runTool(p, 'place_part', { id: ids.get(a), x, y, ref: `U${2 * n + 1}` });
  await runTool(p, 'place_part', { id: ids.get(b), x: x + 10.16, y, ref: `U${2 * n + 2}` });
  await runTool(p, 'add_label', { pin: `U${2 * n + 1}.1`, name: `N${n}` });
  await runTool(p, 'add_label', { pin: `U${2 * n + 2}.1`, name: `N${n}` });
  return `/N${n}`;
}
const onNet = (p: Project, net: string) => runErc(p.doc, p.engine).violations.filter((v) => v.net === net).map((v) => `${v.kind}:${v.severity}`);

describe('S17: configurable ERC', () => {
  it('the pin-type matrix: drivers fighting, pins that should not meet, a no-connect pin connected', async () => {
    const p = newProject('m');
    const ids = new Map<string, string>();
    const oo = await pair(p, 0, 'output', 'output', ids);
    const tp = await pair(p, 1, 'tri_state', 'power_in', ids);
    const nc = await pair(p, 2, 'input', 'no_connect', ids);
    const ok = await pair(p, 3, 'input', 'passive', ids);
    expect(onNet(p, oo)).toContain('driverConflict:error');
    expect(onNet(p, tp)).toContain('pinConflict:warning');
    expect(onNet(p, nc)).toContain('noConnectConnected:warning');
    expect(onNet(p, ok).filter((k) => /Conflict|noConnect/.test(k))).toEqual([]);
    // The matrix is symmetric.
    for (const a of ERC_PIN_TYPES) for (const b of ERC_PIN_TYPES) expect(defaultPinLevel(a, b)).toBe(defaultPinLevel(b, a));
  });

  it('a project can change a matrix entry and how a check reports; undo takes it back', async () => {
    const p = newProject('m');
    const ids = new Map<string, string>();
    const ok = await pair(p, 0, 'input', 'input', ids);
    expect(onNet(p, ok)).toEqual([]);
    await runTool(p, 'set_erc_rule', { pin_a: 'input', pin_b: 'input', level: 'error' });
    expect(onNet(p, ok)).toEqual(['pinConflict:error']);
    await runTool(p, 'set_erc_check', { check: 'pinConflict', level: 'warning' });
    expect(onNet(p, ok)).toEqual(['pinConflict:warning']);
    await runTool(p, 'set_erc_check', { check: 'pinConflict', level: 'ignore' });
    expect(onNet(p, ok)).toEqual([]);
    p.history.undo();
    p.history.undo();
    expect(onNet(p, ok)).toEqual(['pinConflict:error']);
    await runTool(p, 'set_erc_rule', { pin_a: 'input', pin_b: 'input', level: 'default' });
    expect(onNet(p, ok)).toEqual([]);
    await expect(runTool(p, 'set_erc_rule', { pin_a: 'input', pin_b: 'nope', level: 'error' })).rejects.toThrow(/Pin types are/);
  });

  it('power symbols can be made to need a source, as in KiCad', async () => {
    const p = newProject('pw');
    await runTool(p, 'add_part', { kind: 'resistor', x: 0, y: 0 });
    await runTool(p, 'add_power', { pin: 'R1.1', net: '+3V3' });
    await runTool(p, 'add_power', { pin: 'R1.2', net: 'GND' });
    const pwr = () => runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'powerNotDriven').map((v) => v.net).sort();
    expect(pwr()).toEqual([]);
    await runTool(p, 'set_erc_option', { power_symbols_need_source: true });
    expect(pwr()).toEqual(['+3V3', 'GND']);
    await runTool(p, 'add_power', { pin: 'R1.2', net: 'GND', flag: true });
    expect(pwr()).toEqual(['+3V3']);
  });

  it('a waived violation keeps its reason, stops counting, is saved with the project, and can count again', async () => {
    const p = newProject('w');
    const ids = new Map<string, string>();
    const net = await pair(p, 0, 'output', 'output', ids);
    const v = runErc(p.doc, p.engine).violations.find((x) => x.net === net)!;
    const gate = async () => ((await runTool(p, 'project_status', {})) as { gates: { id: string; detail: string }[] }).gates.find((g) => g.id === 'schematic')!.detail;
    expect(await gate()).toMatch(/1 ERC error/);
    await expect(runTool(p, 'waive_violation', { id: v.id, reason: '  ' })).rejects.toThrow(/reason/);
    await runTool(p, 'waive_violation', { id: v.id, reason: 'Both outputs are open-drain in this circuit' });
    const r = runErc(p.doc, p.engine);
    expect(r.violations.some((x) => x.id === v.id)).toBe(false);
    expect(r.waived).toEqual([expect.objectContaining({ id: v.id, waiver: expect.objectContaining({ reason: 'Both outputs are open-drain in this circuit' }) })]);
    expect(await gate()).not.toMatch(/1 ERC error/);
    const erc = (await runTool(p, 'run_erc', {})) as { waived: { id: string; reason: string }[] };
    expect(erc.waived[0]).toMatchObject({ id: v.id, reason: 'Both outputs are open-drain in this circuit' });
    // Saved and opened again: still waived.
    const q = openProject([{ name: 'w.hpcb', text: saveProject(p) }]);
    expect(runErc(q.doc, q.engine).waived.map((x) => x.id)).toEqual([v.id]);
    await runTool(q, 'unwaive_violation', { id: v.id });
    expect(runErc(q.doc, q.engine).violations.some((x) => x.id === v.id)).toBe(true);
  });
});

// The built-in matrix against KiCad's: every pair of the 12 pin types, judged by kicad-cli's ERC.
const KICAD_CLI = ['/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli', '/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli'].find((x) => existsSync(x));
describe.runIf(!!KICAD_CLI)('S17 against KiCad (kicad-cli)', { timeout: 300_000 }, () => {
  it('all 78 pairs of pin types: the same level as KiCad reports', async () => {
    const p = newProject('m');
    const ids = new Map<string, string>();
    const pairs: [PinType, PinType][] = [];
    for (let i = 0; i < ERC_PIN_TYPES.length; i++) for (let j = i; j < ERC_PIN_TYPES.length; j++) pairs.push([ERC_PIN_TYPES[i]!, ERC_PIN_TYPES[j]!]);
    for (const [n, [a, b]] of pairs.entries()) await pair(p, n, a, b, ids);
    const r = kicadSchematic(p.doc, p.engine, { project: 'm' });
    const dir = mkdtempSync(join(tmpdir(), 'hs17-'));
    for (const f of r.files) writeFileSync(join(dir, f.name), f.text);
    try {
      execFileSync(KICAD_CLI!, ['sch', 'erc', '--format', 'json', '-o', join(dir, 'e.json'), join(dir, r.root)], { stdio: 'ignore' });
    } catch {
      /* exits non-zero when it finds errors */
    }
    const k = JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8')) as { sheets: { violations: { type: string; severity: string; items: { description: string }[] }[] }[] };
    const kicad = new Map<number, string>();
    for (const s of k.sheets)
      for (const v of s.violations) {
        if (v.type !== 'pin_to_pin' && v.type !== 'no_connect_connected') continue;
        const ref = Number(/Symbol U(\d+)/.exec(v.items[0]?.description ?? '')?.[1]);
        if (ref) kicad.set(Math.floor((ref - 1) / 2), v.severity);
      }
    const ours = new Map<number, string>();
    for (const v of runErc(p.doc, p.engine).violations)
      if ((v.kind === 'pinConflict' || v.kind === 'driverConflict' || v.kind === 'noConnectConnected') && v.net) ours.set(Number(v.net.replace('/N', '')), v.severity);
    const differ = pairs.map(([a, b], n) => [`${a}+${b}`, kicad.get(n) ?? 'ok', ours.get(n) ?? 'ok'] as const).filter(([, x, y]) => x !== y);
    expect(differ).toEqual([]);
  });
});
