import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { downloadKicadLibraries, downloadedKicadLibraries, installKicadArchives, latestKicadVersion, untarGz } from '../../../packages/tools/src/kicadDownload.ts';
import { writeFileSync } from 'node:fs';
import { startServer } from '../src/server.ts';

/** A minimal ustar archive (with a pax long name when a path is over 100 characters). */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const add = (name: string, data: Buffer, type = '0') => {
    blocks.push(header(name, data.length, type), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  };
  add('pax_global_header', Buffer.from('52 comment=0123456789abcdef0123456789abcdef01234567\n'), 'g');
  for (const [name, text] of Object.entries(files)) {
    if (name.length > 99) {
      // pax record "<len> path=<name>\n", where <len> counts its own digits too.
      const body = ` path=${name}\n`;
      let len = body.length + 1;
      while (String(len).length + body.length !== len) len = String(len).length + body.length;
      add('PaxHeader/long', Buffer.from(`${len}${body}`), 'x');
    }
    add(name, Buffer.from(text));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// Laid out as KiCad writes its library files (tab indentation), which the indexer relies on.
const SYM = `(kicad_symbol_lib (version 20231120)
\t(symbol "TESTCHIP"
\t\t(property "Reference" "U" (at 0 0 0))
\t\t(property "Value" "TESTCHIP" (at 0 0 0))
\t\t(property "Footprint" "Pkg_Test:TEST-2" (at 0 0 0))
\t\t(property "Description" "Chip for the download test" (at 0 0 0))
\t\t(symbol "TESTCHIP_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))) (pin output line (at 5.08 0 180) (length 2.54) (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
\t)
)`;
const MOD = `(footprint "TEST-2" (layer "F.Cu") (descr "two pads")
  (pad "1" smd roundrect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25))
  (pad "2" smd roundrect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25)))`;
const LONG = `kicad-footprints-9.9.9/Pkg_Test.pretty/${'Very_Long_Footprint_Name_'.repeat(4)}.kicad_mod`;
const ARCHIVES: Record<string, Buffer> = {
  'kicad-symbols': gzipSync(tar({ 'kicad-symbols-9.9.9/Test_Lib.kicad_sym': SYM, 'kicad-symbols-9.9.9/LICENSE.md': 'license', 'kicad-symbols-9.9.9/README.md': 'not kept' })),
  'kicad-footprints': gzipSync(tar({ 'kicad-footprints-9.9.9/Pkg_Test.pretty/TEST-2.kicad_mod': MOD, [LONG]: MOD, 'kicad-footprints-9.9.9/.gitlab-ci.yml': 'not kept' })),
};
const requested: string[] = [];
const fakeFetch = async (url: string): Promise<Response> => {
  requested.push(url);
  if (url.includes('/repository/tags')) return new Response(JSON.stringify([{ name: '9.9.9' }, { name: '10.0.0-rc1' }, { name: '9.0.6' }]), { status: 200 });
  const repo = Object.keys(ARCHIVES).find((k) => url.includes(`/${k}/-/archive/`));
  return repo ? new Response(new Uint8Array(ARCHIVES[repo]!), { status: 200 }) : new Response('no', { status: 404 });
};

describe('S21: KiCad libraries on demand', () => {
  it('unpacks only library files from a .tar.gz, including pax long names', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'hkicad-tar-'));
    const n = await untarGz(Readable.from([ARCHIVES['kicad-footprints']!]), dest, (p) => /\.kicad_mod$/.test(p));
    expect(n).toBe(2);
    expect(existsSync(join(dest, 'Pkg_Test.pretty/TEST-2.kicad_mod'))).toBe(true);
    expect(readFileSync(join(dest, LONG.split('/').slice(1).join('/')), 'utf8')).toBe(MOD);
    expect(existsSync(join(dest, '.gitlab-ci.yml'))).toBe(false);
  });

  it('picks the newest stable release', async () => {
    expect(await latestKicadVersion(fakeFetch)).toBe('9.9.9');
    expect(await latestKicadVersion(async () => new Response('x', { status: 500 }))).toBe('9.0.6');
  });

  it('a refused download says how to fetch the archives by hand; install takes those files', async () => {
    const r2 = mkdtempSync(join(tmpdir(), 'hkicad-refused-'));
    const refuse = async () => new Response('{"message":"406 Not Acceptable"}', { status: 406 });
    await expect(downloadKicadLibraries({ version: '9.9.9', root: r2, fetchImpl: refuse })).rejects.toThrow(/refused.*406.*kicad-libraries install/);
    expect(await downloadedKicadLibraries(r2)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'hkicad-files-'));
    writeFileSync(join(dir, 'kicad-symbols-9.9.9.tar.gz'), ARCHIVES['kicad-symbols']!);
    writeFileSync(join(dir, 'kicad-footprints-9.9.9.tar.gz'), ARCHIVES['kicad-footprints']!);
    const got = await installKicadArchives([join(dir, 'kicad-footprints-9.9.9.tar.gz'), join(dir, 'kicad-symbols-9.9.9.tar.gz')], { root: r2 });
    expect(got.version).toBe('9.9.9');
    expect(existsSync(join(got.symbols, 'Test_Lib.kicad_sym'))).toBe(true);
    expect(existsSync(join(got.footprints, 'Pkg_Test.pretty/TEST-2.kicad_mod'))).toBe(true);
    await expect(installKicadArchives([join(dir, 'kicad-symbols-9.9.9.tar.gz')], { root: r2 })).rejects.toThrow(/kicad-footprints/);
  });

  const root = mkdtempSync(join(tmpdir(), 'hkicad-cache-'));
  let srv: Awaited<ReturnType<typeof startServer>>;
  afterAll(() => srv?.close());

  it('server: offers the download, fetches on request, then serves parts with source and license', async () => {
    srv = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'hsrv-')), kicad: false, kicadDownload: { root, fetchImpl: fakeFetch } });
    const base = `http://127.0.0.1:${srv.port}`;
    const before = (await (await fetch(`${base}/api/library/kicad`)).json()) as { available: boolean; canDownload: boolean; license: { name: string } };
    expect(before).toMatchObject({ available: false, canDownload: true });
    expect(before.license.name).toMatch(/CC BY-SA 4.0/);
    expect(requested.filter((u) => u.includes('/-/archive/'))).toHaveLength(0); // nothing downloaded without a request
    const start = await fetch(`${base}/api/library/kicad/download`, { method: 'POST', body: '{}' });
    expect(start.status).toBe(202);
    let st: { available: boolean; origin: string; download: { stage: string; files: number } };
    const end = Date.now() + 5000;
    do st = (await (await fetch(`${base}/api/library/kicad`)).json()) as typeof st;
    while (st.download?.stage !== 'done' && st.download?.stage !== 'error' && Date.now() < end && (await new Promise((r) => setTimeout(r, 30)), true));
    expect(st.download.stage).toBe('done');
    expect(st).toMatchObject({ available: true, origin: 'downloaded' });
    expect(st.download.files).toBe(4); // symbol lib and its licence, 2 footprints (README and CI files skipped)
    expect((await downloadedKicadLibraries(root))?.version).toBe('9.9.9');
    // Searchable and placeable, with source and license.
    const found = (await (await fetch(`${base}/api/library/parts?q=testchip`)).json()) as { id: string; source: string; license?: string }[];
    expect(found[0]).toMatchObject({ id: 'kicad:Test_Lib:TESTCHIP', source: 'kicad', license: expect.stringMatching(/CC BY-SA 4.0/) });
    const part = (await (await fetch(`${base}/api/library/part?id=kicad:Test_Lib:TESTCHIP`)).json()) as { units: unknown[]; license: string };
    expect(part.units).toHaveLength(1);
    expect(part.license).toMatch(/KiCad libraries exception/);
    const fp = (await (await fetch(`${base}/api/library/footprint?name=Pkg_Test:TEST-2`)).json()) as { pads: unknown[]; license: string };
    expect(fp.pads).toHaveLength(2);
    expect(fp.license).toMatch(/CC BY-SA 4.0/);
  });
});
