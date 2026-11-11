# Roadmap — Hassassin AI PCB Designer

Delapan fase. Setiap fase berakhir dengan sesuatu yang bisa dicoba di browser.
Urutan disusun mengikuti ketergantungan: **mesin rules** dan **command layer** dibangun
paling awal karena renderer, DRC, kolaborasi, dan AI semuanya bergantung padanya.

| Fase | Nama | Hasil yang bisa dicoba |
|---|---|---|
| **0** | Fondasi & viewer | Buka `.kicad_pcb` di browser; pan/zoom WebGL2; layer on/off; object tree; inspector *Computed vs Specified* dari mesin rules |
| **1** | Editor PCB dasar | Pilih/geser/putar komponen, routing manual, via, ratsnest, undo/redo, simpan/buka format kita sendiri |
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

## Di luar cakupan (untuk sekarang)
Simulasi SPICE, mekanik/enclosure, firmware, wire harness, pemesanan pabrikasi.
