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
    def('Root', 'root', 'Project-wide settings', { displayUnit: 'mm', gridSpacing: '0.5mm', enabled: 'true', visible: 'true' }),
    def('Layout', 'layout', 'Every board', { boardEdgeClearance: '0.3mm' }),
    def('Element', 'element', 'Every component', { rotation: '0deg', side: 'top', keepOut: '0.2mm' }),
    def('Pad', 'pad', 'Every pad', {
      padShape: 'rect',
      padType: 'smd',
      cornerRatio: '0.25',
      keepOut: '0.2mm',
      thermalRelief: 'spokes',
      thermalSpokeWidth: '0.3mm',
      holeSizeMin: '0.2mm',
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
    def('Trace', 'trace', 'Every trace segment', { traceWidth: '0.25mm', keepOut: '0.2mm' }),
    def('Via', 'via', 'Every via', { viaDiameter: '0.6mm', viaHole: '0.3mm', viaKind: 'through', keepOut: '0.2mm' }),
    def('Fill', 'fill, zone', 'Copper pours and keep-out zones', { keepOut: '0.3mm', thermalRelief: 'spokes' }),
    def('Text', 'text', 'Every text', { fontSize: '1mm', strokeWidth: '0.15mm', rotation: '0deg' }),
    def('Graphics', 'line, circle, arc, polygon, rectangle', 'Lines and shapes', { strokeWidth: '0.15mm', filled: 'false' }),
  ];
}
