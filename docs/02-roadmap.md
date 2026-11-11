# Roadmap — Hassassin AI PCB Designer

Delapan fase. Setiap fase berakhir dengan sesuatu yang bisa dicoba di browser.
Urutan disusun mengikuti ketergantungan: **mesin rules** dan **command layer** dibangun
paling awal karena renderer, DRC, kolaborasi, dan AI semuanya bergantung padanya.

| Fase | Nama | Hasil yang bisa dicoba |
|---|---|---|
| **0** ✅ | Fondasi & viewer | Buka `.kicad_pcb` di browser; pan/zoom WebGL2; layer on/off; object tree; inspector *Computed vs Specified* dari mesin rules |
| **1** ✅ | Editor PCB dasar | Pilih/geser/putar komponen, routing manual, via, ratsnest, undo/redo, simpan/buka format kita sendiri |
| **2** | Benar secara elektrik | DRC inkremental (clearance, unrouted, overlap), copper pour, panel Review, ekspor Gerber/drill/BOM/pick-and-place |
| **3** | Schematic | Editor schematic, netlist, ERC, sinkron schematic ↔ PCB (satu sumber data) |
| **4** | Kolaborasi | Edit multi-user real-time (CRDT), kursor kolaborator, komentar ber-pin, riwayat versi & restore, fork/clone, izin Edit/Comment/View |
| **5** | Library & part | Part sebagai dokumen yang bisa dipakai ulang, part generik parametrik, impor library KiCad, harga & stok |
| **6** | AI agent | Chat + mode agent dengan task list, semua aksi lewat command layer, DRC-fix, placement & routing berbantuan AI |
| **7** | Lanjutan | Autorouter, 3D view, stackup & impedansi, diff-pair/length tuning, flex/rigid-flex |

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

## Di luar cakupan (untuk sekarang)
Simulasi SPICE, mekanik/enclosure, firmware, wire harness, pemesanan pabrikasi.
