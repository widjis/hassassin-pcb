/**
 * Source trust (docs/06-agent-plugins.md, A2): how far a web address may be relied on for a part's values.
 *
 *   manufacturer  the maker's own site: datasheets cited from here count as official
 *   distributor   a distributor's catalogue or API (data under their terms; their copy of a datasheet)
 *   unverified    anything else: may be read, values from it need the user's approval
 *   mirror        datasheet mirror and aggregator sites: never trusted, even when the file is the same
 *
 * The lists below are defaults; the owner extends or overrides them in `source-trust.json` (see
 * `mergeTrustLists`). A host matches a domain when it is that domain or a subdomain of it.
 */

export type TrustLevel = 'manufacturer' | 'distributor' | 'unverified' | 'mirror';

export interface TrustLists {
  manufacturer: string[];
  distributor: string[];
  mirror: string[];
}

export interface TrustResult {
  level: TrustLevel;
  /** The host of the address (lower case, without "www."). */
  host: string;
  /** The list entry that matched, if any. */
  matched?: string;
  /** Whether a value from here may be used without the user's approval. */
  trusted: boolean;
}

export const DEFAULT_TRUST: TrustLists = {
  manufacturer: [
    'ti.com', 'st.com', 'analog.com', 'microchip.com', 'nxp.com', 'onsemi.com', 'infineon.com', 'renesas.com', 'espressif.com',
    'nordicsemi.com', 'silabs.com', 'maximintegrated.com', 'diodes.com', 'vishay.com', 'rohm.com', 'toshiba.semicon-storage.com',
    'semiconductors.toshiba.com', 'murata.com', 'tdk.com', 'kemet.com', 'yageo.com', 'samsungsem.com', 'bourns.com', 'littelfuse.com',
    'molex.com', 'te.com', 'jst-mfg.com', 'jst.com', 'wurth-elektronik.com', 'we-online.com', 'amphenol.com', 'hirose.com',
    'nexperia.com', 'alpha-omega.com', 'aosmd.com', 'monolithicpower.com', 'richtek.com', 'raspberrypi.com', 'wch-ic.com', 'wch.cn',
    'gigadevice.com', 'winbond.com', 'macronix.com', 'issi.com', 'sensirion.com', 'bosch-sensortec.com', 'invensense.tdk.com',
    'semtech.com', 'qorvo.com', 'skyworksinc.com', 'cree.com', 'wolfspeed.com', 'lumileds.com', 'osram.com', 'ams-osram.com',
    'everlight.com', 'kingbright.com', 'cui.com', 'sameskydevices.com', 'u-blox.com', 'quectel.com', 'simcom.com', 'ftdichip.com',
    'silergy.com', 'torexsemi.com', 'ablic.com', 'mps.com', 'panasonic.com', 'industrial.panasonic.com', 'eaton.com', 'coilcraft.com',
    'sunlordinc.com', 'ckswitches.com', 'alps.com', 'alpsalpine.com', 'omron.com', 'nichicon.co.jp', 'lelon.com.tw', 'xkb.com.cn',
  ],
  distributor: [
    'lcsc.com', 'jlcpcb.com', 'mouser.com', 'mouser.co.id', 'mouser.sg', 'digikey.com', 'digikey.sg', 'farnell.com', 'element14.com',
    'newark.com', 'arrow.com', 'rs-online.com', 'rsdelivers.com', 'tme.eu', 'avnet.com', 'futureelectronics.com', 'szlcsc.com',
  ],
  mirror: [
    'alldatasheet.com', 'datasheetspdf.com', 'datasheet4u.com', 'datasheetarchive.com', 'datasheetcatalog.com', 'datasheets.com',
    'datasheet.octopart.com', 'octopart.com', 'findchips.com', 'alldatasheetpdf.com', 'pdf1.alldatasheet.com',
    'kynix.com', 'icdrex.com', 'utmel.com', 'componentsearchengine.com', 'snapeda.com', 'ultralibrarian.com', 'easyeda.com', 'scribd.com',
  ],
};

const norm = (d: string) => d.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');

/** The defaults with the owner's lists added; a domain the owner lists moves out of the other lists. */
export function mergeTrustLists(base: TrustLists, extra: Partial<Record<keyof TrustLists, unknown>> | null | undefined): TrustLists {
  const out: TrustLists = { manufacturer: base.manufacturer.map(norm), distributor: base.distributor.map(norm), mirror: base.mirror.map(norm) };
  if (!extra) return out;
  for (const level of ['manufacturer', 'distributor', 'mirror'] as const) {
    const add = Array.isArray(extra[level]) ? (extra[level] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map(norm) : [];
    for (const d of add) {
      for (const other of ['manufacturer', 'distributor', 'mirror'] as const) if (other !== level) out[other] = out[other].filter((x) => x !== d);
      if (!out[level].includes(d)) out[level].push(d);
    }
  }
  return out;
}

/** Host of an address, lower case, without "www."; null when it is not an http(s) address. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return norm(u.hostname);
  } catch {
    return null;
  }
}

/** The longest list entry the host equals or ends with (".domain"). */
function match(host: string, list: string[]): string | undefined {
  let best: string | undefined;
  for (const d of list) if ((host === d || host.endsWith(`.${d}`)) && (!best || d.length > best.length)) best = d;
  return best;
}

/** How far an address may be relied on. A more specific entry wins (e.g. a mirror subdomain of a distributor). */
export function trustOf(url: string, lists: TrustLists = DEFAULT_TRUST): TrustResult {
  const host = hostOf(url);
  if (!host) return { level: 'unverified', host: '', trusted: false };
  const hits = (['mirror', 'manufacturer', 'distributor'] as const)
    .map((level) => ({ level, d: match(host, lists[level].map(norm)) }))
    .filter((x): x is { level: 'mirror' | 'manufacturer' | 'distributor'; d: string } => !!x.d)
    .sort((a, b) => b.d.length - a.d.length);
  const hit = hits[0];
  if (!hit) return { level: 'unverified', host, trusted: false };
  return { level: hit.level, host, matched: hit.d, trusted: hit.level === 'manufacturer' || hit.level === 'distributor' };
}
