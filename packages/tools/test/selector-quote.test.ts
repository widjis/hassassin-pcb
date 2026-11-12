import { describe, expect, it } from 'vitest';
import { newProject, runTool } from '@hassassin/tools';
import { quoteSelectorIds } from '../src/tools.ts';

describe('selectors with KiCad-style names', () => {
  it('quotes only the ids that need it', () => {
    expect(quoteSelectorIds('net#Net-(U1-SW1) > trace')).toBe('net#"Net-(U1-SW1)" > trace');
    expect(quoteSelectorIds('net#GND > trace')).toBe('net#GND > trace');
    expect(quoteSelectorIds('net#"Net-(U1-SW1)" > trace')).toBe('net#"Net-(U1-SW1)" > trace');
    expect(quoteSelectorIds('net#/Host:SDA, net#Net-(R1-Pad2)')).toBe('net#"/Host:SDA", net#"Net-(R1-Pad2)"');
  });

  it('a bare name with parentheses: the error shows the quoted selector to use', async () => {
    const p = newProject('t');
    await expect(runTool(p, 'query', { selector: 'net#Net-(U1-SW1) > trace' })).rejects.toThrow(/must be quoted: net#"Net-\(U1-SW1\)" > trace/);
    // The quoted form parses.
    expect(await runTool(p, 'query', { selector: 'net#"Net-(U1-SW1)" > trace' })).toEqual({ total: 0, results: [] });
  });
});
