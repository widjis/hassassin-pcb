# Roadmap — Hassassin AI PCB Designer

Delapan fase. Setiap fase berakhir dengan sesuatu yang bisa dicoba di browser.
Urutan disusun mengikuti ketergantungan: **mesin rules** dan **command layer** dibangun
paling awal karena renderer, DRC, kolaborasi, dan AI semuanya bergantung padanya.

| Fase | Nama | Hasil yang bisa dicoba |
|---|---|---|
| **0** ✅ | Fondasi & viewer | Buka `.kicad_pcb` di browser; pan/zoom WebGL2; layer on/off; object tree; inspector *Computed vs Specified* dari mesin rules |
| **1** ✅ | Editor PCB dasar | Pilih/geser/putar komponen, routing manual, via, ratsnest, undo/redo, simpan/buka format kita sendiri |
| **2** ✅ | Benar secara elektrik | DRC inkremental (clearance, unrouted, overlap), copper pour, panel Review, ekspor Gerber/drill/BOM/pick-and-place |
| **3** | Schematic + alur proyek | Editor schematic, netlist, ERC, sinkron schematic → PCB (satu sumber data), dokumen spesifikasi proyek, tahap & gerbang pemeriksaan |
| **4** | Kolaborasi | Edit multi-user real-time (CRDT), kursor kolaborator, komentar ber-pin, riwayat versi & restore, fork/clone, izin Edit/Comment/View |
| **5** | Library & part | Part sebagai dokumen yang bisa dipakai ulang, part generik parametrik, impor library KiCad, harga & stok |
| **6** | AI agent | Chat + mode agent dengan task list, AI pemandu per tahap proyek, semua aksi lewat command layer, DRC/ERC-fix, placement & routing berbantuan AI; MCP server + CLI untuk Claude Code / Codex |
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

## Di luar cakupan (untuk sekarang)
Simulasi SPICE, mekanik/enclosure, firmware, wire harness, pemesanan pabrikasi.
