import { describe, expect, it } from 'vitest';
import { pinPadCheck, runErc } from '@hassassin/core';
import { newProject, runTool, type Project } from '@hassassin/tools';

const pp = (p: Project) => runErc(p.doc, p.engine).violations.filter((v) => v.kind === 'pinPadMismatch');

describe('S20: pin ↔ pad check', () => {
  it('matching pins and pads: nothing to report', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', pins: 8, x: 0, y: 0, package: 'soic-8' });
    await runTool(p, 'add_part', { kind: 'resistor', x: 30, y: 0 });
    expect(pinPadCheck(p.doc)).toEqual([]);
    expect(pp(p)).toEqual([]);
  });

  it('a symbol with more pins than the footprint has pads: error for the pins, with both counts', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', pins: 10, x: 0, y: 0, package: 'soic-8' });
    const [f] = pinPadCheck(p.doc);
    expect(f).toMatchObject({ ref: 'U1', footprint: 'soic-8', pinsWithoutPad: ['9', '10'], padsWithoutPin: [], pinCount: 10, padCount: 8 });
    const v = pp(p);
    expect(v.map((x) => [x.severity, x.message])).toEqual([['error', expect.stringMatching(/U1: pins 9, 10 have no pad.*symbol 10 pins, footprint soic-8 8 pads/)]]);
  });

  it('a footprint with more pads than the symbol has pins: warning, unless they are mechanical', async () => {
    const p = newProject('t');
    // QFN-24 with an exposed pad (25) and a 24-pin symbol.
    await runTool(p, 'add_part', { kind: 'ic', pins: 24, x: 0, y: 0 });
    await runTool(p, 'create_footprint', { name: 'qfn-24-test', family: 'four-side', pins: 24, pitch: 0.5, spanX: 3.9, pad: { length: 0.85, width: 0.28 }, ep: { w: 2.6, h: 2.6 }, holes: [{ x: 4, y: 4, drill: 1 }] });
    const r = (await runTool(p, 'assign_footprint', { ref: 'U1', footprint: 'qfn-24-test', update: false })) as { pinPad: string[] };
    // assign_footprint reports it at once; the bare hole never counts.
    expect(r.pinPad).toEqual([expect.stringMatching(/U1: pad 25 has no symbol pin/)]);
    expect(pp(p).map((x) => x.severity)).toEqual(['warning']);
    // Listing the pad as mechanical clears it.
    await runTool(p, 'set_part_info', { ref: 'U1', mechanical_pads: '25' });
    expect(pp(p)).toEqual([]);
    const ok = (await runTool(p, 'assign_footprint', { ref: 'U1', footprint: 'qfn-24-test', update: false })) as { pinPad: string };
    expect(ok.pinPad).toMatch(/every symbol pin has a pad/);
  });

  it('mounting tabs and shields (MP…, SH…) need no pin; multi-unit parts count every unit', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'connector', pins: 2, x: 0, y: 0 });
    await runTool(p, 'create_footprint', { name: 'usb-test', family: 'pads', pads: [{ number: '1', x: -1, y: 0, w: 0.6, h: 1.2 }, { number: '2', x: 1, y: 0, w: 0.6, h: 1.2 }, { number: 'MP1', x: -4, y: 1, w: 1.5, h: 2 }, { number: 'SH', x: 4, y: 1, w: 1.5, h: 2 }] });
    await runTool(p, 'assign_footprint', { ref: 'J1', footprint: 'usb-test', update: false });
    expect(pinPadCheck(p.doc)).toEqual([]);
    // A dual op-amp in SOIC-8: units A, B and the power unit together cover pins 1–8.
    await runTool(p, 'create_symbol', { name: 'Dual', power_unit: true, footprint: 'soic-8', pin_list: [
      { number: '1', name: 'OUTA', type: 'O', unit: 'A' }, { number: '2', name: '-INA', type: 'I', unit: 'A' }, { number: '3', name: '+INA', type: 'I', unit: 'A' },
      { number: '5', name: '+INB', type: 'I', unit: 'B' }, { number: '6', name: '-INB', type: 'I', unit: 'B' }, { number: '7', name: 'OUTB', type: 'O', unit: 'B' },
      { number: '4', name: 'V-', type: 'P' }, { number: '8', name: 'V+', type: 'P' },
    ] });
    await runTool(p, 'place_part', { id: 'project:dual', x: 60, y: 0 });
    expect(pinPadCheck(p.doc)).toEqual([]);
  });

  it('Update PCB reports the mismatch; the board copy is checked once the part is on the board', async () => {
    const p = newProject('t');
    await runTool(p, 'add_part', { kind: 'ic', pins: 10, x: 0, y: 0, package: 'soic-8' });
    const r = (await runTool(p, 'update_pcb', {})) as { pinPad?: string[]; missingPads: string[] };
    expect(r.pinPad).toEqual([expect.stringMatching(/U1: pins 9, 10 have no pad/)]);
    expect(r.missingPads).toEqual(['U1.9', 'U1.10']);
    // Still reported from the board component.
    expect(pinPadCheck(p.doc, { resolve: () => null })).toMatchObject([{ ref: 'U1', pinsWithoutPad: ['9', '10'] }]);
    // The schematic names a new footprint that is not on the board yet: that one is checked.
    await runTool(p, 'assign_footprint', { ref: 'U1', footprint: 'tssop-20', update: false });
    expect(pinPadCheck(p.doc)).toMatchObject([{ ref: 'U1', footprint: 'tssop-20', pinsWithoutPad: [], padsWithoutPin: ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20'] }]);
  });
});
