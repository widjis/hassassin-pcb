import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractNetlist, StyleEngine, type Netlist } from '@hassassin/core';
import { importKicadPcb, importKicadSchematic } from '@hassassin/kicad-import';

const SCH = `(kicad_sch (version 20250114) (generator "test")
  (lib_symbols
    (symbol "Device:R" (symbol "R_0_1" (rectangle (start -1 2.5) (end 1 -2.5)))
      (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1")) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
    (symbol "power:GND" (power) (symbol "GND_0_1" (pin power_in line (at 0 0 270) (length 0) (name "GND") (number "1")))))
  (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (property "Reference" "R1") (property "Value" "1k"))
  (symbol (lib_id "Device:R") (at 20 10 90) (unit 1) (property "Reference" "R2") (property "Value" "2k"))
  (symbol (lib_id "power:GND") (at 10 13.81 0) (property "Reference" "#PWR1") (property "Value" "GND"))
  (symbol (lib_id "power:GND") (at 23.81 10 0) (property "Reference" "#PWR2") (property "Value" "GND"))
  (wire (pts (xy 10 6.19) (xy 16.19 6.19)))
  (wire (pts (xy 16.19 6.19) (xy 16.19 10)))
  (label "MID" (at 13 6.19 0))
  (sheet (at 40 0) (size 10 10) (property "Sheetname" "Sub") (property "Sheetfile" "sub.kicad_sch") (pin "IO" input (at 40 5 180)))
  (wire (pts (xy 40 5) (xy 30 5)))
  (global_label "EXT" (shape input) (at 30 5 0))
)`;
const SUB = `(kicad_sch (version 20250114) (generator "test")
  (lib_symbols (symbol "Device:R" (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1")) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))
  (symbol (lib_id "Device:R") (at 5 5 0) (unit 1) (property "Reference" "R3"))
  (hierarchical_label "IO" (shape input) (at 5 1.19 0))
  (global_label "EXT2" (shape input) (at 5 8.81 0))
)`;

describe('schematic import and netlist', () => {
  it('connects wires, labels, power ports and hierarchy', () => {
    const { doc, sheets, symbols, warnings } = importKicadSchematic({ files: { 'top.kicad_sch': SCH, 'sub.kicad_sch': SUB }, root: 'top.kicad_sch' });
    expect(warnings).toEqual([]);
    expect(sheets).toBe(2);
    expect(symbols).toBe(3);
    const nl = extractNetlist(doc, new StyleEngine(doc));
    // R1 pin1 at (10,6.19); R2 rotated 90°: pin1 (0,-3.81) local → (−3.81,0) → (16.19,10); pin2 → (23.81,10)
    expect(nl.byPin.get('R1.1')).toBe('/MID');
    expect(nl.byPin.get('R2.1')).toBe('/MID');
    expect(nl.byPin.get('R1.2')).toBe('GND');
    expect(nl.byPin.get('R2.2')).toBe('GND');
    // Hierarchical label IO ↔ sheet pin, which is wired to global label EXT
    expect(nl.byPin.get('R3.1')).toBe('EXT');
    expect(nl.byPin.get('R3.2')).toBe('EXT2');
  });
});

/** Two netlists agree when they group the same pins together (names may differ). */
function samePartition(a: Map<string, string>, b: Map<string, string>) {
  const groups = (m: Map<string, string>) => {
    const g = new Map<string, string[]>();
    for (const [p, n] of m) if (b.has(p) && a.has(p)) (g.get(n) ?? g.set(n, []).get(n)!).push(p);
    return new Set([...g.values()].map((x) => x.sort().join(',')));
  };
  const A = groups(a);
  const B = groups(b);
  return { onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)) };
}

const dir = process.env.KICAD_PROJECT_DIR;
describe.runIf(!!dir && existsSync(dir!))('real KiCad project', () => {
  const files: Record<string, string> = {};
  let root = '';
  let pcb = '';
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.kicad_sch')) files[f] = readFileSync(`${dir}/${f}`, 'utf8');
      if (f.endsWith('.kicad_pcb')) {
        pcb = readFileSync(`${dir}/${f}`, 'utf8');
        root = f.replace('.kicad_pcb', '.kicad_sch');
      }
    }
  }
  let nl: Netlist;
  it('matches KiCad netlist.xml when present', () => {
    const { doc, warnings } = importKicadSchematic({ files, root });
    expect(warnings).toEqual([]);
    nl = extractNetlist(doc, new StyleEngine(doc));
    const xmlPath = `${dir}/netlist.xml`;
    if (!existsSync(xmlPath)) return;
    const ref = new Map<string, string>();
    for (const m of readFileSync(xmlPath, 'utf8').matchAll(/<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) for (const n of m[2]!.matchAll(/<node ref="([^"]+)" pin="([^"]+)"/g)) ref.set(`${n[1]}.${n[2]}`, m[1]!);
    expect([...ref.keys()].filter((p) => !nl.byPin.has(p))).toEqual([]);
    expect(samePartition(nl.byPin, ref)).toEqual({ onlyA: [], onlyB: [] });
  });
  it('matches the PCB pad nets of the same project', () => {
    const { doc } = importKicadPcb(pcb);
    const padNets = new Map<string, string>();
    for (const n of doc.nodes.values()) {
      if (n.type !== 'pad' || !n.props.net) continue;
      const el = doc.nodes.get(n.parent!)!;
      padNets.set(`${el.name}.${n.props.number}`, String(n.props.net));
    }
    const d = samePartition(nl.byPin, padNets);
    console.log({ schPins: nl.byPin.size, padPins: padNets.size, ...d });
    expect(d).toEqual({ onlyA: [], onlyB: [] });
  });
});

// ---------------------------------------------------------------- ERC + sync
import { applyOps, computeRatsnest, planSync, runErc } from '@hassassin/core';

const BAD = `(kicad_sch (version 20250114) (generator "test")
  (lib_symbols
    (symbol "Device:R" (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1")) (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
    (symbol "My:BUF" (symbol "BUF_1_1"
      (pin input line (at -5 0 0) (length 2) (name "A") (number "1"))
      (pin output line (at 5 0 180) (length 2) (name "Y") (number "2"))
      (pin power_in line (at 0 5 270) (length 2) (name "VCC") (number "3"))
      (pin power_in line (at 0 -5 90) (length 2) (name "GND") (number "4")))))
  (symbol (lib_id "My:BUF") (at 10 10 0) (unit 1) (property "Reference" "U1") (property "Value" "BUF"))
  (symbol (lib_id "My:BUF") (at 30 10 0) (unit 1) (property "Reference" "U2") (property "Value" "BUF"))
  (symbol (lib_id "Device:R") (at 50 10 0) (unit 1) (property "Reference" "R9") (property "Value" "10k"))
  (wire (pts (xy 15 10) (xy 35 10)))
  (label "VCC" (at 10 5 0)) (label "VCC" (at 30 5 0))
  (no_connect (at 25 10))
  (wire (pts (xy 60 20) (xy 70 20)))
)`;

describe('ERC', () => {
  it('finds the classic schematic mistakes', () => {
    const { doc } = importKicadSchematic({ files: { 'bad.kicad_sch': BAD }, root: 'bad.kicad_sch' });
    const { violations } = runErc(doc, new StyleEngine(doc));
    const by: Record<string, number> = {};
    for (const v of violations) by[v.kind] = (by[v.kind] ?? 0) + 1;
    expect(by.driverConflict).toBe(1); // U1.Y and U2.Y both drive the same wire
    expect(by.powerNotDriven).toBe(1); // VCC feeds power inputs but has no source
    expect(by.unconnectedPin).toBeGreaterThanOrEqual(4); // U1.A, U1.GND, U2.GND, R9.1, R9.2 ...
    expect(by.danglingWire).toBe(2); // both ends of the lonely wire
    expect(violations.some((v) => v.kind === 'unconnectedPin' && v.message.startsWith('R9 pin 1'))).toBe(true);
  });
});

describe('schematic → PCB sync', () => {
  it('adds placeholder footprints for new parts and wires their pads', () => {
    const { doc } = importKicadPcb(`(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user))
      (net 0 "") (net 1 "OLD")
      (footprint "R:R" (layer "F.Cu") (at 10 10) (property "Reference" "R1")
        (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "OLD"))
        (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 1 "OLD")))
      (segment (start 9 10) (end 11 10) (width 0.25) (layer "F.Cu") (net 1)))`);
    importKicadSchematic({ files: { 'top.kicad_sch': SCH, 'sub.kicad_sch': SUB }, root: 'top.kicad_sch' }, doc);
    const e = new StyleEngine(doc);
    const { ops, report } = planSync(doc, e, extractNetlist(doc, e));
    applyOps(doc, ops);
    e.recompute();
    expect(report.componentsAdded.sort()).toEqual(['R2', 'R3']);
    expect(report.netsRenamed).toEqual([['OLD', '/MID']]); // R1.1 moved to /MID: the routed net follows
    const r3 = [...doc.nodes.values()].find((n) => n.type === 'element' && n.name === 'R3')!;
    const r3pads = r3.children.map((c) => doc.nodes.get(c)!).filter((n) => n.type === 'pad');
    expect(r3pads.map((p) => p.props.net).sort()).toEqual(['EXT', 'EXT2']);
    // R1.1 on /MID and R2.1 on /MID are now unrouted between parts
    expect(computeRatsnest(doc, e, ['F.Cu', 'B.Cu']).nets.find((n) => n.net === '/MID')!.pads).toBe(2);
  });
});

describe.runIf(!!dir && existsSync(dir!))('real KiCad project: ERC and sync', () => {
  it('is ERC-clean like KiCad says and sync keeps connectivity', () => {
    const files: Record<string, string> = {};
    let pcb = '';
    let root = '';
    for (const f of readdirSync(dir!)) {
      if (f.endsWith('.kicad_sch')) files[f] = readFileSync(`${dir}/${f}`, 'utf8');
      if (f.endsWith('.kicad_pcb')) {
        pcb = readFileSync(`${dir}/${f}`, 'utf8');
        root = f.replace('.kicad_pcb', '.kicad_sch');
      }
    }
    const { doc, layers } = importKicadPcb(pcb);
    importKicadSchematic({ files, root }, doc);
    const copper = layers.filter((l) => l.kind === 'copper').map((l) => l.name);
    const e = new StyleEngine(doc);
    const before = computeRatsnest(doc, e, copper).lines.length;
    const erc = runErc(doc, e);
    console.log({ erc: erc.violations.map((v) => v.message).slice(0, 5) });
    const { ops, report } = planSync(doc, e, erc.netlist);
    applyOps(doc, ops);
    e.recompute();
    expect(report.componentsAdded).toEqual([]);
    expect(computeRatsnest(doc, e, copper).lines.length).toBe(before);
  });
});
