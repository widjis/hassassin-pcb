/**
 * Convert a KiCad board file (.kicad_pcb, format versions 2021+) into our document tree.
 * The file format is read from KiCad's public file-format documentation and from
 * looking at files; no KiCad code is used.
 *
 * Coordinates stay in millimetres, Y pointing down (same as the file).
 */
import {
  addNode,
  createDoc,
  systemDefaults,
  type Doc,
  type DocNode,
  type NodeType,
  type PropValue,
  type RuleDecl,
  type Vec2,
} from '@hassassin/core';
import { child, children, flag, head, isList, num, parseSExpr, str, type SList } from './sexpr.ts';

export type LayerKind = 'copper' | 'silk' | 'mask' | 'paste' | 'fab' | 'courtyard' | 'edge' | 'adhesive' | 'user';

export interface LayerInfo {
  name: string;
  /** Position in the file's layer list (front-to-back for copper). */
  index: number;
  kind: LayerKind;
  side: 'front' | 'back' | 'inner' | 'none';
  userName?: string;
}

export interface ImportWarning {
  message: string;
}

export interface ImportResult {
  doc: Doc;
  layers: LayerInfo[];
  warnings: ImportWarning[];
  stats: Record<string, number>;
}

function layerKind(name: string): LayerKind {
  if (name.endsWith('.Cu')) return 'copper';
  if (name.endsWith('.SilkS')) return 'silk';
  if (name.endsWith('.Mask')) return 'mask';
  if (name.endsWith('.Paste')) return 'paste';
  if (name.endsWith('.Fab')) return 'fab';
  if (name.endsWith('.CrtYd')) return 'courtyard';
  if (name === 'Edge.Cuts') return 'edge';
  if (name.endsWith('.Adhes')) return 'adhesive';
  return 'user';
}

function layerSide(name: string): LayerInfo['side'] {
  if (name.startsWith('F.')) return 'front';
  if (name.startsWith('B.')) return 'back';
  if (/^In\d+\.Cu$/.test(name)) return 'inner';
  return 'none';
}

const xy = (l: SList | undefined): Vec2 | undefined => {
  if (!l) return undefined;
  const x = num(l[1]);
  const y = num(l[2]);
  return x === undefined || y === undefined ? undefined : { x, y };
};

/** Footprint-local point -> board coordinates (rotation in degrees, KiCad sense). */
function toBoard(local: Vec2, origin: Vec2, rotDeg: number): Vec2 {
  if (!rotDeg) return { x: origin.x + local.x, y: origin.y + local.y };
  const r = (rotDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: origin.x + local.x * c + local.y * s, y: origin.y - local.x * s + local.y * c };
}

const rule = (name: string, value: RuleDecl['value']): RuleDecl => ({ name, value });

function strokeWidth(l: SList): number | undefined {
  return num(child(child(l, 'stroke') ?? [], 'width')?.[1]) ?? num(child(l, 'width')?.[1]);
}

function isFilled(l: SList): boolean {
  const f = str(child(l, 'fill')?.[1]);
  return f === 'solid' || f === 'yes';
}

function pts(l: SList | undefined): Vec2[] {
  if (!l) return [];
  const out: Vec2[] = [];
  for (const e of l) {
    if (isList(e) && head(e) === 'xy') {
      const p = xy(e);
      if (p) out.push(p);
    } else if (isList(e) && head(e) === 'arc') {
      // Arc inside a polygon outline: keep its three points; good enough for display.
      for (const k of ['start', 'mid', 'end']) {
        const p = xy(child(e, k));
        if (p) out.push(p);
      }
    }
  }
  return out;
}

function guessNetClass(name: string): string | undefined {
  const base = name.split('/').pop() ?? name;
  if (/^(A|D|P|S)?GND|^VSS|^0V$/i.test(base)) return 'ground';
  if (/^(\+|-)?\d+V\d*|^V(CC|DD|IN|BAT|BUS|SYS|OUT|LOGIC)|^VBAT|^PWR|^\+/i.test(base)) return 'power';
  return undefined;
}

export function importKicadPcb(text: string, fileName = 'board.kicad_pcb'): ImportResult {
  const root = parseSExpr(text);
  if (head(root) !== 'kicad_pcb') throw new Error('Not a KiCad board file (expected "(kicad_pcb ...").');

  const warnings: ImportWarning[] = [];
  const stats: Record<string, number> = { footprints: 0, pads: 0, traces: 0, arcs: 0, vias: 0, zones: 0, graphics: 0, texts: 0, nets: 0 };
  const doc = createDoc(systemDefaults());
  doc.meta.source = fileName;
  doc.meta.kicadVersion = str(child(root, 'version')?.[1]);

  // Layers.
  const layers: LayerInfo[] = [];
  const layerList = child(root, 'layers');
  if (layerList) {
    for (const e of layerList.slice(1)) {
      if (!isList(e)) continue;
      const name = str(e[1]);
      if (!name) continue;
      const userName = str(e[3]);
      layers.push({ name, index: layers.length, kind: layerKind(name), side: layerSide(name), ...(userName ? { userName } : {}) });
    }
  }
  const copper = layers.filter((l) => l.kind === 'copper').map((l) => l.name);
  doc.meta.layers = layers;

  const expandLayers = (names: string[]): string[] => {
    const out = new Set<string>();
    for (const n of names) {
      if (n === '*.Cu') copper.forEach((c) => out.add(c));
      else if (n === 'F&B.Cu') ['F.Cu', 'B.Cu'].forEach((c) => out.add(c));
      else if (n.startsWith('*.')) ['F', 'B'].forEach((s) => out.add(`${s}${n.slice(1)}`));
      else out.add(n);
    }
    return [...out];
  };
  const layersOf = (l: SList): string[] => expandLayers((child(l, 'layers') ?? []).slice(1).map((e) => str(e) ?? '').filter(Boolean));

  const title = str(child(child(root, 'title_block') ?? [], 'title')?.[1]);
  const layout = addNode(doc, doc.rootId, {
    type: 'layout',
    name: title || fileName.replace(/\.kicad_pcb$/i, ''),
    props: { Thickness: num(child(child(root, 'general') ?? [], 'thickness')?.[1]) ?? 1.6 },
  });
  const board = addNode(doc, layout.uid, { type: 'container', name: 'Board' });
  const comps = addNode(doc, layout.uid, { type: 'container', name: 'Components' });
  const netsC = addNode(doc, layout.uid, { type: 'container', name: 'Nets' });
  const zonesC = addNode(doc, layout.uid, { type: 'container', name: 'Keep-out zones' });

  // Nets: older files declare (net <code> "name") at top level and refer by code.
  const netByCode = new Map<string, string>();
  for (const n of children(root, 'net')) {
    const code = str(n[1]);
    const name = str(n[2]);
    if (code !== undefined && name !== undefined) netByCode.set(code, name);
  }
  const netNodes = new Map<string, DocNode>();
  const netName = (l: SList): string | undefined => {
    const n = child(l, 'net');
    if (!n) return undefined;
    const a = n[1];
    const b = n[2];
    let name: string | undefined;
    if (b !== undefined) name = str(b);
    else if (a !== undefined && typeof a !== 'string') name = str(a); // quoted -> name
    else if (a !== undefined) name = netByCode.get(str(a)!) ?? str(a);
    return name || undefined;
  };
  const netNode = (name: string): DocNode => {
    let n = netNodes.get(name);
    if (!n) {
      const cls = guessNetClass(name);
      n = addNode(doc, netsC.uid, { type: 'net', name, props: cls ? { netClass: cls } : {} });
      netNodes.set(name, n);
      stats.nets!++;
    }
    return n;
  };
  for (const name of netByCode.values()) if (name) netNode(name);

  const uidOf = (l: SList): string | undefined => str(child(l, 'uuid')?.[1]) ?? str(child(l, 'tstamp')?.[1]);

  /** Graphics (fp_* or gr_*) -> node, transformed by `tf`. */
  const addGraphic = (parentUid: string, g: SList, kind: string, tf: (p: Vec2) => Vec2, rotOffset: number) => {
    const layer = str(child(g, 'layer')?.[1]);
    if (!layer) return;
    const common: RuleDecl[] = [rule('layer', layer)];
    const w = strokeWidth(g);
    if (w !== undefined) common.push(rule('strokeWidth', w));
    if (isFilled(g)) common.push(rule('filled', true));
    const id = uidOf(g);
    const mk = (type: NodeType, rules: RuleDecl[], name = '') =>
      addNode(doc, parentUid, { ...(id ? { uid: id } : {}), type, name, rules: [...common, ...rules] });

    const P = (k: string) => {
      const p = xy(child(g, k));
      return p ? tf(p) : undefined;
    };
    switch (kind) {
      case 'line': {
        const s = P('start');
        const e = P('end');
        if (s && e) mk('line', [rule('start', s), rule('end', e)]);
        break;
      }
      case 'rect': {
        const s = xy(child(g, 'start'));
        const e = xy(child(g, 'end'));
        if (s && e) {
          const corners = [s, { x: e.x, y: s.y }, e, { x: s.x, y: e.y }].map(tf);
          mk('rectangle', [rule('points', corners)]);
        }
        break;
      }
      case 'circle': {
        const c = xy(child(g, 'center'));
        const e = xy(child(g, 'end'));
        if (c && e) mk('circle', [rule('center', tf(c)), rule('radius', Math.hypot(e.x - c.x, e.y - c.y))]);
        break;
      }
      case 'arc': {
        const s = P('start');
        const m = P('mid');
        const e = P('end');
        if (s && m && e) mk('arc', [rule('start', s), rule('mid', m), rule('end', e)]);
        else warnings.push({ message: 'Skipped an arc in the old (center/angle) form.' });
        break;
      }
      case 'poly': {
        const p = pts(child(g, 'pts')).map(tf);
        if (p.length >= 2) mk('polygon', [rule('points', p)]);
        break;
      }
      case 'text': {
        const at = child(g, 'at');
        const p = xy(at);
        if (!p) return;
        const font = child(child(g, 'effects') ?? [], 'font');
        const size = child(font ?? [], 'size');
        const text = g[0] && str(g[0]) === 'property' ? str(g[2]) : str(g[0]) === 'fp_text' ? str(g[2]) : str(g[1]);
        if (!text) return;
        const node = mk(
          'text',
          [
            rule('position', tf(p)),
            rule('rotation', (num(at?.[3]) ?? 0) + rotOffset),
            rule('text', text),
            ...(num(size?.[1]) !== undefined ? [rule('fontSize', num(size?.[1])!)] : []),
          ],
          text,
        );
        if (flag(g, 'hide') || flag(child(g, 'effects') ?? [], 'hide')) node.rules.push(rule('visible', false));
        stats.texts!++;
        return;
      }
    }
    stats.graphics!++;
  };

  const graphicKind: Record<string, string> = {
    fp_line: 'line', gr_line: 'line', fp_rect: 'rect', gr_rect: 'rect', fp_circle: 'circle', gr_circle: 'circle',
    fp_arc: 'arc', gr_arc: 'arc', fp_poly: 'poly', gr_poly: 'poly', fp_text: 'text', gr_text: 'text',
  };

  // Footprints.
  for (const fp of children(root, 'footprint').concat(children(root, 'module'))) {
    stats.footprints!++;
    const at = child(fp, 'at');
    const origin = xy(at) ?? { x: 0, y: 0 };
    const rot = num(at?.[3]) ?? 0;
    const fpLayer = str(child(fp, 'layer')?.[1]) ?? 'F.Cu';
    const props: Record<string, PropValue> = { Footprint: str(fp[1]) ?? '' };
    let reference = '';
    for (const p of children(fp, 'property')) {
      const k = str(p[1]);
      const v = str(p[2]);
      if (!k || v === undefined) continue;
      if (k === 'Reference') reference = v;
      else props[k] = v;
    }
    for (const t of children(fp, 'fp_text')) {
      if (str(t[1]) === 'reference') reference ||= str(t[2]) ?? '';
      if (str(t[1]) === 'value' && props.Value === undefined) props.Value = str(t[2]) ?? '';
    }
    const descr = str(child(fp, 'descr')?.[1]);
    if (descr) props.Description = descr;

    const el = addNode(doc, comps.uid, {
      ...(uidOf(fp) ? { uid: uidOf(fp)! } : {}),
      type: 'element',
      name: reference || `?${stats.footprints}`,
      props,
      rules: [rule('position', origin), rule('rotation', rot), rule('side', fpLayer.startsWith('B.') ? 'bottom' : 'top')],
    });
    const tf = (p: Vec2) => toBoard(p, origin, rot);

    for (const e of fp) {
      if (!isList(e)) continue;
      const h = head(e)!;
      if (h === 'pad') {
        stats.pads!++;
        const padAt = child(e, 'at');
        const local = xy(padAt) ?? { x: 0, y: 0 };
        const size = xy(child(e, 'size')) ?? { x: 0, y: 0 };
        const typeRaw = str(e[2]) ?? 'smd';
        const shape = str(e[3]) ?? 'rect';
        const padType = typeRaw === 'thru_hole' ? 'through' : typeRaw === 'np_thru_hole' ? 'npth' : typeRaw === 'connect' ? 'edge' : 'smd';
        const shapeMap: Record<string, string> = { circle: 'circle', rect: 'rect', roundrect: 'roundrect', oval: 'oval', trapezoid: 'trapezoid', custom: 'custom' };
        const rules: RuleDecl[] = [
          rule('position', tf(local)),
          rule('rotation', num(padAt?.[3]) ?? rot),
          rule('size', size),
          rule('padShape', shapeMap[shape] ?? 'rect'),
          rule('padType', padType),
          rule('layers', layersOf(e)),
        ];
        const rr = num(child(e, 'roundrect_rratio')?.[1]);
        if (rr !== undefined) rules.push(rule('cornerRatio', rr));
        const drill = child(e, 'drill');
        if (drill) {
          if (str(drill[1]) === 'oval') {
            const a = num(drill[2]) ?? 0;
            rules.push(rule('holeSize', { x: a, y: num(drill[3]) ?? a }));
          } else {
            const d = num(drill[1]);
            if (d !== undefined) rules.push(rule('holeSize', d));
          }
        }
        if (shape === 'custom') {
          const prims: Vec2[][] = [];
          for (const gp of children(child(e, 'primitives') ?? [], 'gr_poly')) {
            const ring = pts(child(gp, 'pts')).map((p) => {
              // primitives are relative to the pad, in the pad's own rotation
              const pr = num(padAt?.[3]) ?? rot;
              return toBoard(toBoard(p, { x: 0, y: 0 }, pr - rot), tf(local), 0);
            });
            if (ring.length >= 3) prims.push(ring);
          }
          if (prims.length) rules.push(rule('points', prims[0]!));
        }
        const net = netName(e);
        const padProps: Record<string, PropValue> = { number: str(e[1]) ?? '' };
        if (net) {
          padProps.net = net;
          netNode(net);
        }
        addNode(doc, el.uid, { ...(uidOf(e) ? { uid: uidOf(e)! } : {}), type: 'pad', name: str(e[1]) ?? '', props: padProps, rules });
      } else if (h === 'property' && str(e[1]) === 'Reference') {
        addGraphic(el.uid, e, 'text', tf, 0);
      } else if (graphicKind[h] && h !== 'fp_text') {
        addGraphic(el.uid, e, graphicKind[h]!, tf, 0);
      } else if (h === 'fp_text' && str(e[1]) !== 'value') {
        addGraphic(el.uid, e, 'text', tf, 0);
      }
    }
  }

  // Board-level graphics.
  for (const e of root) {
    if (!isList(e)) continue;
    const h = head(e)!;
    if (h.startsWith('gr_') && graphicKind[h]) addGraphic(board.uid, e, graphicKind[h]!, (p) => p, 0);
  }

  // Tracks and vias.
  for (const e of root) {
    if (!isList(e)) continue;
    const h = head(e);
    if (h !== 'segment' && h !== 'arc' && h !== 'via') continue;
    const net = netName(e);
    const parent = net ? netNode(net) : netNode('(no net)');
    const id = uidOf(e);
    if (h === 'via') {
      stats.vias!++;
      const rules: RuleDecl[] = [rule('position', xy(child(e, 'at')) ?? { x: 0, y: 0 }), rule('layers', layersOf(e))];
      const size = num(child(e, 'size')?.[1]);
      const drill = num(child(e, 'drill')?.[1]);
      if (size !== undefined) rules.push(rule('viaDiameter', size));
      if (drill !== undefined) rules.push(rule('viaHole', drill));
      const kind = str(e[1]);
      if (kind === 'blind' || kind === 'micro') rules.push(rule('viaKind', kind));
      addNode(doc, parent.uid, { ...(id ? { uid: id } : {}), type: 'via', rules });
    } else {
      h === 'arc' ? stats.arcs!++ : stats.traces!++;
      const rules: RuleDecl[] = [
        rule('start', xy(child(e, 'start')) ?? { x: 0, y: 0 }),
        rule('end', xy(child(e, 'end')) ?? { x: 0, y: 0 }),
        rule('layer', str(child(e, 'layer')?.[1]) ?? 'F.Cu'),
      ];
      const w = num(child(e, 'width')?.[1]);
      if (w !== undefined) rules.push(rule('traceWidth', w));
      if (h === 'arc') {
        const m = xy(child(e, 'mid'));
        if (m) rules.push(rule('mid', m));
      }
      addNode(doc, parent.uid, { ...(id ? { uid: id } : {}), type: 'trace', rules });
    }
  }

  // Zones.
  for (const z of children(root, 'zone')) {
    stats.zones!++;
    const net = netName(z);
    const zoneLayers = child(z, 'layers') ? layersOf(z) : [str(child(z, 'layer')?.[1]) ?? 'F.Cu'];
    const outline = pts(child(child(z, 'polygon') ?? [], 'pts'));
    const fills: Record<string, Vec2[][]> = {};
    for (const fpoly of children(z, 'filled_polygon')) {
      const layer = str(child(fpoly, 'layer')?.[1]) ?? zoneLayers[0] ?? 'F.Cu';
      (fills[layer] ??= []).push(pts(child(fpoly, 'pts')));
    }
    const isKeepout = !!child(z, 'keepout') || !net;
    const name = str(child(z, 'name')?.[1]) ?? '';
    addNode(doc, isKeepout ? zonesC.uid : netNode(net!).uid, {
      ...(uidOf(z) ? { uid: uidOf(z)! } : {}),
      type: isKeepout ? 'zone' : 'fill',
      name,
      rules: [rule('layers', zoneLayers), rule('points', outline)],
      data: { fills },
    });
  }

  if (!stats.footprints && !stats.traces) warnings.push({ message: 'The board has no footprints or tracks.' });
  return { doc, layers, warnings, stats };
}
