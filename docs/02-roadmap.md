# Roadmap — Hassassin AI PCB Designer

Sembilan fase (termasuk 3.5). Setiap fase berakhir dengan sesuatu yang bisa dicoba di browser.
Urutan disusun mengikuti ketergantungan: **mesin rules** dan **command layer** dibangun
paling awal karena renderer, DRC, kolaborasi, dan AI semuanya bergantung padanya.

| Fase | Nama | Hasil yang bisa dicoba |
|---|---|---|
| **0** ✅ | Fondasi & viewer | Buka `.kicad_pcb` di browser; pan/zoom WebGL2; layer on/off; object tree; inspector *Computed vs Specified* dari mesin rules |
| **1** ✅ | Editor PCB dasar | Pilih/geser/putar komponen, routing manual, via, ratsnest, undo/redo, simpan/buka format kita sendiri |
| **2** ✅ | Benar secara elektrik | DRC inkremental (clearance, unrouted, overlap), copper pour, panel Review, ekspor Gerber/drill/BOM/pick-and-place |
| **3** ✅ | Schematic + alur proyek | Editor schematic, netlist, ERC, sinkron schematic → PCB (satu sumber data), dokumen spesifikasi proyek, tahap & gerbang pemeriksaan |
| **3.5** ✅ | Akses untuk agent | CLI `hassassin` + MCP server (stdio) di atas file `.hpcb`/KiCad: query, inspect, ubah rule, tambah part, kabel, update PCB, DRC/ERC, refill pour, ekspor fab — dipakai Claude Code, Codex, atau klien MCP lain |
| **4** ✅ | Kolaborasi | Edit multi-user real-time, kursor kolaborator, komentar ber-pin, riwayat versi & restore, fork/clone, izin Edit/Comment/View; **MCP live** (agent mengedit proyek yang sedang terbuka) |
| **5** ✅ | Library & part | Part sebagai dokumen yang bisa dipakai ulang, part generik parametrik, impor library KiCad, harga & stok |
| **6** | AI agent | Chat + mode agent dengan task list, AI pemandu per tahap proyek, memakai definisi tool yang sama dengan CLI/MCP (Fase 3.5), DRC/ERC-fix, placement & routing berbantuan AI |
| **7** | Lanjutan | Autorouter, 3D view, stackup & impedansi, diff-pair/length tuning, flex/rigid-flex |

## Lapisan alur proyek (lintas fase)

Mesin dibangun dari bawah (Fase 0–2), tetapi pengguna bekerja dari atas: kebutuhan →
schematic → komponen → layout → review → fabrikasi. Lapisan ini menyatukan keduanya.
Tampilan dirancang sendiri (bukan meniru kartu onboarding produk lain).

| Tahap | Isi | Gerbang sebelum lanjut | Fase |
|---|---|---|---|
| 1. Kebutuhan | Dokumen spesifikasi: tujuan, suplai, arus, antarmuka, ukuran, lingkungan, jumlah produksi | Kolom wajib terisi | 3 (dokumen), 6 (AI bertanya & mengisi) |
| 2. Schematic | Blok rangkaian, netlist | ERC bersih | 3 |
| 3. Komponen | Part dengan MPN, footprint, stok/harga | Semua part punya footprint & MPN | 5 |
| 4. Layout | Placement, routing, pour | DRC bersih, ratsnest 0 | 1–2 |
| 5. Review | Komentar kolaborator + review AI (EMC, DFM) | Tidak ada komentar terbuka berstatus blocker | 4, 6 |
| 6. Fabrikasi | Gerber, drill, BOM, pick-and-place | Semua gerbang di atas hijau (atau di-*override* dengan alasan) | 2 |

Prinsip:
- **Spesifikasi adalah data**, bukan sekadar teks: nilai seperti arus per net bisa menjadi
  rule (mis. lebar trace minimum) dan konteks untuk AI.
- **Ketertelusuran**: komponen dan rule bisa mencatat kebutuhan yang mereka penuhi.
- **Gerbang tidak mengunci paksa**: pengguna boleh lanjut dengan alasan yang dicatat.
- AI (Fase 6) bekerja per tahap dengan task list yang terlihat, lewat command layer yang sama.

## Fase 0 — rincian

**Tujuan:** fondasi data dan tampilan, belum ada pengeditan.

1. **Monorepo** — pnpm workspace, TypeScript strict, Vite, Vitest.
2. **`@hassassin/core`**
   - Pohon dokumen: node ber-UID, bertipe (`root`, `layout`, `element`, `footprint`,
     `pad`, `trace`, `via`, `fill`, `zone`, `net`, `text`, `line`, …), properti, anak.
   - Satuan: parse & konversi panjang (`mm`, `mil`, `in`, `um`) dan sudut (`deg`, `rad`).
   - Selector: parser + matcher (tipe, `#designator`, `[prop]`, `[prop=v]`, `*`,
     descendant, child `>`, `:not()`), specificity.
   - Resolver rules: system defaults per tipe → ruleset (specificity, urutan) →
     rule per objek → `!important`; inheritance untuk rule yang ditandai inheritable;
     mengembalikan **nilai efektif + asal nilai**.
3. **`@hassassin/kicad-import`** — parser S-expression dan konversi `.kicad_pcb`
   (outline, footprint, pad, trace, via, zone, net, teks) ke pohon dokumen.
   Format dibaca dari dokumentasi format file KiCad yang publik, bukan dari kode KiCad.
4. **`apps/web`** — renderer WebGL2 sendiri (garis tebal, lingkaran, poligon,
   per layer dengan warna), pan/zoom, panel layer, object tree, inspector.

**Selesai bila:** board KiCad nyata terbuka dan terlihat benar, dan memilih objek
menampilkan nilai computed/specified beserta asal rule-nya.

## Fase 1 — yang sudah dibangun

- **Command layer** (`core/commands.ts`): semua perubahan = daftar operasi kecil yang bisa
  dibalik (`setRule`, `setProp`, `setName`, `add`, `remove`, `setRulesets`); `History`
  dengan undo/redo, penggabungan langkah drag, dan rollback bila satu operasi gagal.
  Jalur yang sama nanti dipakai kolaborasi (Fase 4) dan AI agent (Fase 6).
- **Frame komponen**: pad, grafik, dan teks footprint disimpan relatif terhadap komponen,
  sehingga geser/putar komponen membawa isinya.
- **Konektivitas & ratsnest** (`core/connectivity.ts`): pulau tembaga per net (pad, trace,
  via, pour) lalu MST antar pulau. Board yang sudah ter-routing penuh menghasilkan 0.
- **Editor**: pilih, geser (snap grid, Alt = bebas), putar (R / Shift+R), hapus, undo/redo.
- **Routing**: X, klik pad/via/trace untuk mulai, preview 45° (`/` ganti gaya sudut,
  Shift = sudut bebas), klik untuk menaruh segmen, V = via + pindah layer, L = ganti layer,
  Esc/klik kanan = berhenti. Trace & via baru **tidak** membawa ukuran sendiri: mereka
  mewarisi dari net (termasuk default kelas net power/ground), jadi ruleset tetap berlaku.
- **Format `.hpcb`** (JSON berversi) untuk simpan/buka, plus autosave lokal dan tombol restore.
- **Perubahan cascade**: nilai default parent kini ikut diwariskan, dan antar ruleset
  default berlaku specificity (mis. `net[netClass=ground]` mengalahkan `net`).

Belum termasuk (masuk Fase 2): DRC/cegah tabrakan saat routing, push-and-shove,
rubber-band trace saat komponen digeser, flip komponen ke sisi bawah.

## Fase 2 — yang sudah dibangun

- **Bentuk tembaga bersama** (`core/copper.ts`): pad, trace, via, pour per layer sebagai
  segmen-ber-radius + area; outline board dirangkai dari Edge.Cuts. Dipakai DRC, pour, dan Gerber.
- **DRC** (`core/drc.ts`): short, clearance (keepOut per jenis objek), jarak ke tepi board,
  tembaga di luar board, lebar trace minimum, lubang minimum, koneksi belum ter-routing.
  Semua batas dibaca dari rules (jadi bisa diatur lewat ruleset). Grid spasial untuk kandidat.
  Board solar (KiCad-clean): 0 pelanggaran, ±0,15–0,35 s.
- **Pour** (`core/pour.ts`): isi dari outline zone/board, potong tembaga net lain + clearance,
  thermal relief (spokes/solid/none dari rule), buang leher sempit & pulau tanpa koneksi.
  Net bisa minta pour lewat rule `pourLayers` → node pour otomatis. Mesin poligon: Clipper 6
  (WASM, `js-angusj-clipper`, MIT). Refill pour board solar: ±0,1–0,3 s, hasilnya DRC 0 & ratsnest 0.
- **Fabrikasi** (`packages/fab`): Gerber RS-274X + atribut X2 (tembaga, mask, paste, silk, outline),
  Excellon PTH/NPTH (slot G85), BOM CSV, pick-and-place CSV, README, dibungkus ZIP.
  Drill dibandingkan dengan `kicad-cli`: 54/54 lubang PTH & 4/4 NPTH cocok (1 beda 1 µm pembulatan).
- **UI**: tab Review (kelompok per jenis, klik = zoom & pilih), penanda di kanvas, tombol Pour (B),
  Export fab.

Catatan & batasan yang diketahui:
- Gerber belum diperiksa dengan viewer Gerber pihak ketiga; baru validasi struktur + drill vs KiCad.
- Teks silkscreen belum masuk Gerber (perlu font vektor).
- Antar-pour beda net di layer yang sama belum saling mengalah (belum ada prioritas pour).
- DRC berjalan di thread utama (±1 s setelah refill pour di board solar); pindah ke Web Worker nanti.
- Belum: cegah tabrakan saat routing, push-and-shove, rubber-band, flip komponen ke sisi bawah.
- Library `clipper2-js` sempat dicoba lalu ditinggalkan: union-nya membuat lubang palsu
  (short di hasil pour) dan offset-nya sangat lambat.

## Fase 3 — yang sudah dibangun

- **Model schematic** di pohon dokumen yang sama dengan PCB: `schematic`, `sheet`, `block`
  (simbol sub-sheet), `sheetPin`, `symbol`, `pin`, `wire`, `label` (lokal/global/hierarkis/power/flag),
  `junction`, `noconnect`. Simbol ditempatkan dengan posisi/rotasi/mirror sebagai rules.
- **Netlist** (`core/netlist.ts`): koneksi geometris per sheet + label lokal/hierarkis per sheet,
  label global & power lintas desain, label hierarkis ↔ pin sheet. Penamaan net otomatis milik kita sendiri.
- **Impor `.kicad_sch`** (hierarkis, simbol library tertanam, `extends`, simbol power, PWR_FLAG).
  Diverifikasi pada dua proyek nyata: solar MPPT (3 sheet, 154 pin) cocok 100 % dengan `netlist.xml`
  KiCad dan dengan net pad di PCB; GPS Tracker (130 pin, simbol power + sub-sheet) cocok dengan PCB.
- **ERC** (`core/erc.ts`): pin tak tersambung, no-connect pada pin tersambung, dua output bertabrakan,
  input power tanpa sumber, ujung kabel menggantung, label menggantung, referensi ganda.
  Solar MPPT: 0 temuan — sama dengan laporan ERC KiCad.
- **Sinkron schematic → PCB** (`core/sync.ts`): net pad diperbarui, net PCB di-*rename* agar trace ikut,
  net baru dibuat, net kosong dihapus, part baru mendapat footprint sementara di samping board,
  part yang hanya ada di PCB dilaporkan (tidak dihapus). Ratsnest board nyata tetap sama setelah sinkron.
- **Simbol bawaan** (R, C, L, D, LED, konektor, IC generik N-pin) dan proyek baru kosong.
- **Editor schematic** (Canvas 2D): pindah antar sheet, pilih/geser/putar/hapus, kabel (W, sudut L),
  label (L, `*` = global), tambah part, masuk sub-sheet (dobel-klik) / naik (U), penanda ERC,
  cross-probe ke komponen PCB, Tab untuk pindah Schematic ↔ Layout, tombol **Update PCB**.
- **Alur proyek**: tab Project berisi dokumen kebutuhan (disimpan sebagai meta proyek, bisa di-undo)
  dan 6 tahap dengan gerbang otomatis (kebutuhan, ERC, komponen, DRC + routing, review, fabrikasi)
  serta *override* beralasan. ERC tampil di tab Review.

Batasan yang diketahui:
- Simbol multi-unit diimpor per unit; editor belum bisa mengganti unit. Bus belum didukung.
- Penamaan net otomatis tidak selalu sama dengan KiCad (konektivitas sama).
- Footprint untuk part baru masih sementara (generik) sampai Fase 5 (library).
- Belum ada sinkron balik PCB → schematic (mis. *swap* pin/gate).

## Fase 3.5 — yang sudah dibangun

Lihat [03-agents.md](03-agents.md). `packages/tools` (20+ tool dengan skema & deskripsi untuk agent,
logika gerbang tahap dipindah ke sini), CLI `hassassin` (JSON, `--fail-on-error` untuk CI), MCP server
stdio tanpa SDK (initialize, tools/list, tools/call, ping). Paket inti kini berjalan langsung di Node
(sintaks TypeScript yang bisa dihapus saja). Diuji end-to-end: alur LED dari proyek kosong sampai ZIP
fabrikasi lewat CLI, dan sesi MCP lewat stdio (termasuk undo dalam sesi).

## Fase 4 — yang sudah dibangun

- **Model sinkronisasi**: server menentukan urutan transaksi (log operasi dari command layer).
  Klien menerapkan editnya langsung, mengirimnya, dan saat transaksi orang lain datang
  menggulung balik edit yang belum dikonfirmasi → menerapkan transaksi remote → menerapkan ulang.
  Hasilnya identik di semua klien dan server (diuji dengan edit bersamaan pada objek yang sama).
- **`packages/sync`**: protokol, aturan peran, `SyncClient` (optimis, rebase, reject, reconnect
  dengan replay edit offline, presence, `flush()`).
- **`apps/server`**: HTTP API + WebSocket (`ws`), penyimpanan snapshot + log JSONL + checkpoint
  tiap 200 transaksi, versi otomatis (tiap 100 transaksi / 10 menit) dan bernama, restore (state saat
  ini disimpan dulu), fork (dengan riwayat) & clone, link per peran (edit/comment/view) + akses publik,
  bisa juga melayani hasil build web (`pnpm start`).
- **Web**: tombol Share + dialog link, avatar & status live, kursor dan seleksi kolaborator di layout
  dan schematic, komentar ber-pin (C) dengan balasan/resolve/blocking, tab Comments & History,
  penegakan peran di UI, gerbang "Review" kini dihitung dari komentar blocking yang terbuka.
- **MCP/CLI live**: `project` boleh berupa link berbagi; agent tampil sebagai kolaborator *agent*.
- Diuji: 6 test server/live (konvergensi, peran, versi/restore/fork, restart, CLI & MCP live) + uji
  dua tab di browser (geser komponen, kursor, komentar, MPN dari agent CLI, restore, view-only).

Batasan yang diketahui:
- Belum ada akun/login: akses lewat token di link (siapa pun yang punya link bisa masuk).
- Konflik diselesaikan "yang terakhir sampai di server menang" per operasi; tidak ada merge
  karakter-per-karakter untuk teks.
- Undo setelah edit orang lain bisa ditolak bila objeknya sudah berubah (pesan ditampilkan).
- Server tunggal tanpa skala horizontal; penyimpanan berbasis file.

## Fase 5 — yang sudah dibangun

- **Footprint sebagai data** (`core/footprints.ts`): `FootprintSpec` + generator parametrik milik sendiri
  (chip 0201–2512, SOD/SMA/SMB/SMC, SOT-23/-5/-6, SOIC, TSSOP, MSOP, QFN dengan EP, DIP, header 1×N/2×N,
  terminal 5.08, lubang M2–M3). Nama KiCad umum dipetakan ke padanan generik bila library tidak tersedia.
- **Part** (`core/parts.ts`): symbol (multi-unit), footprint + alternatif, properti (MPN, pabrikan,
  datasheet, LCSC), penawaran pemasok (stok, MOQ, harga bertingkat, tanggal). Part generik parametrik
  (`generic:resistor?value=4k7&package=chip-0402`). Proyek menyimpan salinan tiap part/footprint yang dipakai
  (`meta["part:…"]`, `meta["fp:…"]`) jadi file proyek mandiri dan aman untuk edit bersamaan.
- **Impor library KiCad**: `.kicad_sym` (unit, `extends`, simbol power dilewati) dan `.kicad_mod`.
  CLI/server otomatis membaca library KiCad yang terpasang (±22.800 simbol, ±15.400 footprint di Mac ini),
  dengan indeks ter-cache (~0,6 s dibangun sekali). Library tidak dibundel.
- **Sinkron schematic → PCB**: part baru langsung mendapat footprint dari library; footprint yang diganti
  atau placeholder dibangun ulang di tempat (posisi/rotasi tetap, net ikut); properti part disalin.
- **BOM & sourcing**: pengelompokan per MPN/nilai/footprint, harga untuk N board (penawaran termurah dengan
  stok cukup), impor CSV dari ekspor alat BOM distributor, input manual. Gerbang "3 · Komponen" memakai ini.
- **Team library** di server (`/api/library/*`): cari (team + KiCad terpasang), ambil part/footprint,
  publikasi part dari proyek (butuh link edit), berversi.
- **Tool baru** untuk CLI/MCP/agent: `search_parts`, `get_part`, `search_footprints`, `place_part`,
  `assign_footprint`, `set_part_info`, `bom`, `import_offers`, `set_offer`, `import_kicad_library`.
- **Web**: tab *Parts* (cari, pratinjau symbol + footprint, pasang, publikasi ke team), daftar part proyek
  dengan footprint/MPN yang bisa diedit, biaya untuk N board, impor CSV & library KiCad; tombol *Library* (P).

Batasan yang diketahui:
- Harga & stok **tidak diambil langsung** dari distributor: API mereka butuh kunci akun. Data masuk lewat
  CSV/manual dan diberi tanggal. Konektor API distributor menyusul bila ada kunci.
- Dimensi land pattern generik adalah nilai nominal kami sendiri; untuk produksi, pilih footprint dari
  datasheet/library pabrikan.
- Belum ada model 3D, dan belum ada pemetaan pin ↔ pad selain nomor yang sama.

## Di luar cakupan (untuk sekarang)
Simulasi SPICE, mekanik/enclosure, firmware, wire harness, pemesanan pabrikasi.
