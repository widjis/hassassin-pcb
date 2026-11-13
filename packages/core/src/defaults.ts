/**
 * Built-in default rulesets, one per node type. They sit below every project rule.
 * Values are our own engineering choices (roughly a common 2-layer, 6/6 mil process).
 */
import type { RuleDecl, Ruleset } from './model.ts';
import { parseRuleValue } from './ruleDefs.ts';

function decls(rules: Record<string, string>): RuleDecl[] {
  return Object.entries(rules).map(([name, v]) => ({ name, value: parseRuleValue(name, v) }));
}

function def(id: string, selector: string, description: string, rules: Record<string, string>): Ruleset {
  return { id: `default:${id}`, name: id, description, selector, rules: decls(rules), enabled: true, origin: 'default' };
}

export function systemDefaults(): Ruleset[] {
  return [
    def('Root', 'root', 'Project-wide settings', { displayUnit: 'mm', gridSpacing: '0.5mm', enabled: 'true', visible: 'true', holeSizeMin: '0.2mm' }),
    def('Layout', 'layout', 'Every board', { boardEdgeClearance: '0.3mm' }),
    def('Element', 'element', 'Every component', { rotation: '0deg', side: 'top', keepOut: '0.2mm' }),
    def('Pad', 'pad', 'Every pad', {
      padShape: 'rect',
      padType: 'smd',
      cornerRatio: '0.25',
      keepOut: '0.2mm',
      thermalRelief: 'spokes',
      thermalSpokeWidth: '0.3mm',
    }),
    def('Net', 'net', 'Every net', {
      traceWidth: '0.25mm',
      traceWidthMin: '0.15mm',
      preferredWidths: '0.15mm 0.25mm 0.4mm 0.6mm 1mm',
      viaDiameter: '0.6mm',
      viaHole: '0.3mm',
      viaKind: 'through',
      keepOut: '0.2mm',
    }),
    def('Power net', 'net[netClass=power]', 'Nets marked as power', { traceWidth: '0.5mm', viaDiameter: '0.8mm', viaHole: '0.4mm' }),
    def('Ground net', 'net[netClass=ground]', 'Nets marked as ground', { traceWidth: '0.5mm', stitchSpacing: '0mm' }),
    // Signal classes (P16): `signal` on a net, from its pins (see signal.ts and the classify_nets tool).
    def('Power signal', 'net[signal=power]', 'Nets of class power', { traceWidth: '0.5mm', viaDiameter: '0.8mm', viaHole: '0.4mm' }),
    def('Ground signal', 'net[signal=ground]', 'Nets of class ground', { traceWidth: '0.5mm' }),
    def('High-current net', 'net[signal=high-current]', 'Nets that carry more than about 1 A', { traceWidth: '1mm', viaDiameter: '0.8mm', viaHole: '0.4mm' }),
    def('High-voltage net', 'net[signal=high-voltage]', 'Nets above about 50 V', { keepOut: '0.6mm' }),
    def('Switching net', 'net[signal=switching]', 'Switch nodes of converters: short and wide', { traceWidth: '0.6mm', viaDiameter: '0.8mm', viaHole: '0.4mm', viaCost: '8mm', classClearance: 'analog(1mm) sensitive(1mm)' }),
    def('Clock net', 'net[signal=clock]', 'Clocks: few vias, over a solid plane', { keepOut: '0.3mm', viaCost: '8mm', planeGapCost: '1' }),
    def('High-speed net', 'net[signal=high-speed]', 'Fast interfaces: few vias, over a solid plane', { keepOut: '0.3mm', viaCost: '10mm', planeGapCost: '2' }),
    def('Differential pair', 'net[signal=diff-pair]', 'Halves of a differential pair', { viaCost: '10mm', planeGapCost: '2' }),
    def('RF net', 'net[signal=rf]', 'RF: no vias if possible, rounded corners, solid plane', { keepOut: '0.5mm', viaCost: '20mm', planeGapCost: '3', cornerStyle: 'arc' }),
    def('Analog net', 'net[signal=analog]', 'Analog signals: some air from other nets', { keepOut: '0.3mm' }),
    def('Sensitive net', 'net[signal=sensitive]', 'Feedback, crystal and reference nodes: some air from other nets', { keepOut: '0.3mm' }),
    // Trace width and via size are not set here: traces and vias inherit them from their net.
    def('Trace', 'trace', 'Every trace segment', { keepOut: '0.2mm' }),
    def('Via', 'via', 'Every via', { keepOut: '0.2mm' }),
    def('Fill', 'fill, zone', 'Copper pours and keep-out zones', { keepOut: '0.3mm', thermalRelief: 'spokes' }),
    def('Text', 'text', 'Every text', { fontSize: '1mm', strokeWidth: '0.15mm', rotation: '0deg' }),
    def('Graphics', 'line, circle, arc, polygon, rectangle', 'Lines and shapes', { strokeWidth: '0.15mm', filled: 'false' }),
  ];
}
