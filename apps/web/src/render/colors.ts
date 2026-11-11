/** Our own layer palette. RGBA in 0..1. */
export type RGBA = [number, number, number, number];

const hex = (h: string, a = 1): RGBA => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

const INNER = ['#b07cf7', '#4fc3a1', '#e0c35c', '#f07ab2', '#62b6ff', '#c1d36a'];

export function layerColor(name: string): RGBA {
  switch (name) {
    case 'F.Cu': return hex('#ef6a4c', 0.82);
    case 'B.Cu': return hex('#3d8bff', 0.72);
    case 'F.SilkS': return hex('#f2efe6', 0.95);
    case 'B.SilkS': return hex('#d6b97a', 0.9);
    case 'F.Mask': return hex('#9a4fd0', 0.3);
    case 'B.Mask': return hex('#2e9a8a', 0.3);
    case 'F.Paste': return hex('#b8b8c2', 0.5);
    case 'B.Paste': return hex('#7e8794', 0.5);
    case 'F.Fab': return hex('#b0a37c', 0.75);
    case 'B.Fab': return hex('#7b8fb3', 0.75);
    case 'F.CrtYd': return hex('#e4e4e4', 0.5);
    case 'B.CrtYd': return hex('#9fb4d6', 0.5);
    case 'Edge.Cuts': return hex('#f2d36b', 1);
    case 'Margin': return hex('#d9a0e6', 0.8);
    case 'Holes': return hex('#08090c', 1);
    default: {
      const m = /^In(\d+)\.Cu$/.exec(name);
      if (m) return hex(INNER[(Number(m[1]) - 1) % INNER.length]!, 0.7);
      return hex('#8a90a0', 0.7);
    }
  }
}

export const HIGHLIGHT: RGBA = [1, 0.93, 0.55, 0.55];
export const QUERY_HIGHLIGHT: RGBA = [0.45, 0.95, 1, 0.45];

export function cssColor(c: RGBA): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
}
