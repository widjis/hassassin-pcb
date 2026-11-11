# Spesifikasi Perilaku — Referensi: Flux (flux.ai)

> **Status clean room:** dokumen ini disusun **hanya** dari materi publik yang terlihat
> oleh pengunjung — landing page `flux.ai` dan dokumentasi publik `docs.flux.ai` —
> diamati pada 2026-11-11 lewat browser biasa. Tidak ada kode, bundle JavaScript,
> API privat, atau aset Flux yang dibaca/disalin. Semua kalimat ditulis ulang dengan
> kata-kata kita sendiri. Implementasi kita **hanya boleh** merujuk dokumen ini,
> bukan produk Flux.
>
> Nama, logo, warna, teks UI, dan istilah merek Flux **tidak** boleh dipakai di produk kita.

---

## 1. Gambaran produk (yang terlihat dari luar)

- Aplikasi ECAD lengkap yang berjalan **sepenuhnya di browser**, tanpa instalasi.
- Rendering kanvas memakai **WebGL2 dengan akselerasi hardware** (docs menyuruh
  pengguna memastikan WebGL2 aktif). Ini wajib untuk performa board besar multi-layer.
- **Kolaborasi real-time**: semua perubahan langsung tersimpan ke cloud; indikator
  "sedang menyimpan" muncul sebentar setiap perubahan di-commit ke riwayat.
- Cakupan: schematic → PCB (hingga ~8 layer, termasuk flex/rigid-flex) → 3D →
  ekspor manufaktur. Versi terbaru meluas ke mekanik, firmware, wire harness, simulasi.
- **AI agent** sebagai pusat: pengguna menjelaskan tujuan perangkat, agent bertanya,
  merencanakan, memilih part, membuat schematic, menempatkan komponen, me-routing,
  menjalankan pengecekan, dan menyiapkan file pabrikasi. Agent selalu meminta izin
  sebelum mengubah copper atau rules.

## 2. Tata letak UI (konseptual)

| Area | Fungsi |
|---|---|
| Panel kiri | Chat dengan AI agent · Library part · Object Tree · daftar Rulesets |
| Kanvas tengah | Schematic editor / PCB editor / 3D view (tersinkron satu sama lain) |
| Panel kanan | Inspector kontekstual: properti, harga & stok (dari MPN), layout rules objek |
| Kiri-bawah kanvas | Panel layer: tampil/sembunyi tiap layer dan fill copper |
| Menu proyek | Undo/Redo, Change History, Fork, Clone, Export |
| Tabel proyek | Nets, Components, BOM, Pins, Knowledge — tampilan tabular data proyek |

Interaksi seleksi: klik = pilih objek; drag kotak = multi-select; Shift+klik = tambah
ke seleksi; Cmd/Ctrl+klik = *deep select* (memilih sub-elemen dalam objek). Seleksi
di kanvas dan Object Tree saling sinkron.

## 3. Model data — pohon objek

Seluruh dokumen layout adalah **pohon** (tree). Setiap node punya `uid` internal,
`type`, nama/designator, dan properti.

| Kategori | Tipe |
|---|---|
| Puncak | `root`, `layout` (sebuah board), `element` (komponen, tertaut ke padanannya di schematic) |
| Kontainer | `container` (folder sistem, mis. "Components", "Nets"), `group` (folder buatan pengguna), `footprint`, `model` (2D/3D), `net` |
| Copper | `pad`, `via`, `trace`, `fill` |
| Silkscreen | `text`, `line`, `circle`, `rectangle` |
| Utilitas | `zone` (keep-out copper) |

Model schematic (API publik) memakai node: `element` (part, punya `terminals`),
`route` (kabel antar terminal), `elementTerminal`, `routeTerminal`, `property`,
`asset`, `control`.

**Catatan desain untuk kita:** schematic dan PCB berbagi identitas komponen
(`element`) dan net; satu sumber kebenaran, dua tampilan.

## 4. Sistem Layout Rules — fitur pembeda utama

Nilai-nilai layout (lebar trace, clearance, posisi, rotasi, bentuk pad, dll.) **tidak
disimpan langsung** sebagai atribut mentah; mereka hasil **resolusi rules**,
mirip CSS.

### 4.1 Dua jenis rule
- **Object-specific**: menempel pada satu objek (seperti `style=""` inline).
- **Selector-based (Ruleset)**: berlaku untuk semua objek yang cocok dengan selector.

### 4.2 Sintaks selector (meniru konsep CSS selector)
- Tipe: `trace`, `pad`, `element`, … (case-sensitive)
- Designator: `#R2`
- Properti: `[prop]`, `[prop=value]`, plus varian partial match (kata, prefix,
  suffix, substring), dengan opsi case sensitivity
- UID: `[uid=...]`
- Kombinator & pseudo-class: universal `*`, descendant, child `>`, sibling `+ ~`,
  `:not()`
- Saat mengetik selector, objek yang cocok **di-highlight** di kanvas dan Object Tree.

### 4.3 Resolusi nilai
1. Rule langsung pada objek > rule warisan (inherited).
2. Object-specific > selector-based.
3. Specificity: tipe < atribut < ID. (`*`, kombinator, `:not()` tidak menambah bobot.)
4. Specificity sama → rule yang **lebih bawah** di daftar menang (cascade).
5. Sebagian rule **inheritable** (mis. bentuk pad diturunkan ke pad anak),
   sebagian tidak (mis. ukuran).
6. Flag `!important` memaksa override, termasuk ke dalam part/modul/sub-layout yang
   dipakai ulang; memicu peringatan DRC "override komponen".
7. Ada **System Defaults** (rule set dasar board & net: arus, impedansi,
   diff-pair) di bawah semua rule proyek.

### 4.4 Nilai bisa berupa ekspresi
Properti dan rule menerima **ekspresi seperti spreadsheet** (`= 22mm + 1`) dengan
satuan & konversi satuan, fungsi matematika, string, dan referensi ke properti/rule
objek lain. Dievaluasi ulang otomatis saat input berubah.

### 4.5 Contoh rule yang ada
Keep Out (clearance, dua arah, bisa per-tipe target mis. hanya terhadap fill),
Board Inset Margin, Auto Layout Gravity (0–1), Asset (mis. logo SVG ke silkscreen),
Trace Width, Preferred Trace Widths, Trace Shape (lurus/lengkung), Connected Layers
(mengaktifkan pour per layer untuk net), Fill Stitching Density/Offset, Position X/Y,
Rotation, Pad Shape, Size, Enable.

## 5. Fitur editor PCB

- **Net vs trace**: net = koneksi logis (dari schematic), trace = jalur copper fisik.
  Lebar trace diatur di level net atau via ruleset.
- **Copper fill / pour**: pour dinamis per net per layer. GND fill aktif di semua
  layer secara default (tapi disembunyikan), power fill nonaktif default. Stitching
  via tidak otomatis — dikonfigurasi via rule.
- **Via**, smart via, curved traces, polygons, custom pad shapes, silkscreen,
  pengukuran jarak, manajemen satuan, locking objek, stackup editor, impedance control,
  length/skew tuning, diff-pair.
- **Auto Layout**: menempatkan dan me-routing otomatis.
- **DRC real-time**: berjalan terus saat mengedit; hasil tampil di panel pesan.
  Contoh: trace overlap, net belum ter-routing, footprint hilang, copper mengambang,
  clearance. Ada review EMC (trace melintasi split plane, via tanpa return via, dll.).
- **3D view** tersinkron.

## 6. Kolaborasi & versi

- **Autosave + Change History**: setiap perubahan jadi versi; bisa dilihat dan
  di-*restore*. Undo/Redo standar.
- **Fork** (salinan dengan riwayat) dan **Clone** (salinan bersih). Agent bisa
  mencoba alternatif di fork lalu **merge** hasil yang lebih baik kembali, dengan
  catatan keputusan merge.
- **Komentar** dipin ke titik di kanvas, bisa dibalas, di-resolve, di-pin, disembunyikan;
  ada daftar semua komentar.
- **Izin bertingkat**: Edit / Comment / View / None, ditumpuk di empat lapisan
  (anonim/publik, …, organisasi, enterprise). Default privat.

## 7. Library & part

- Library publik (part komunitas) + library pribadi/organisasi.
- Part membawa simbol, footprint, model 3D, properti (MPN, nilai), dan
  harga/ketersediaan live dari distributor.
- AI bisa membuat part dari datasheet, memverifikasi, dan memperkaya data part.

## 8. Impor / ekspor

- Impor: KiCad, Altium, Eagle, EasyEDA, OrCAD/Allegro, PADS, DipTrace, IPC-2581, IDF, dll.
- Ekspor: Gerber, drill, BOM, pick-and-place, netlist standar.

## 9. AI agent (perilaku yang diamati)

- Mode chat dan mode agent; bisa beberapa thread paralel; pilihan model.
- Bekerja di atas konteks proyek + seleksi saat ini di kanvas.
- Alur: tanya kebutuhan → rencana → eksekusi bertahap → cek ulang setelah tiap
  langkah → laporkan. Meminta konfirmasi sebelum perubahan besar.
- Semua operasi editor (rule, rename net, route, DRC fix, restore versi, fork) juga
  bisa dipicu lewat bahasa alami → artinya **setiap aksi editor adalah operasi
  terstruktur yang bisa dipanggil sebagai tool**.

---

## 9b. Pengamatan langsung di editor (2026-11-11)

Diamati dengan login pengguna sendiri, pada proyek publik contoh ("ESP32 BMS", milik
akun demo Flux) dan proyek kosong milik pengguna. Hanya UI yang terlihat yang dicatat;
tidak ada desain yang diubah.

### Struktur aplikasi & URL
- Satu halaman per proyek: `/<pemilik>/<slug-proyek>~<id>/<tab>`; tab =
  `files`, `schematic`, `pcb/2d`, `pcb/3d`, ditambah `?thread=<uuid>` untuk thread
  chat aktif. Tab tambahan bisa dibuka lewat tombol "+".
- Tata letak tiga kolom: **chat agent** (bisa disembunyikan / full width) ·
  **area kerja** (tab Files/Schematic/Layout/3D) · panel kanan (onboarding/inspector).
- Proyek baru dimulai *chat-first*: area kerja kosong ("belum ada schematic") sampai
  agent atau pengguna menambah komponen. Mode **Chat** (hanya menjawab) vs **Agent**
  (bekerja otonom, memakai kuota "ACU"); di input chat ada pilihan kemampuan,
  upload file, pemilih MCP server, markup, dan input suara; agent bisa dihentikan.

### Editor layout (PCB 2D)
- Rail ikon vertikal kiri membuka panel yang **ditumpuk (docked)**, bisa dibuka bersamaan:
  **Profile**, **Library**, **Objects**, **View**, **Review** (badge jumlah error & warning).
- Bawah kanvas: pilih sisi papan (**Top**/Bottom), Zoom to Fit, Zoom to Actual Size,
  tombol **Auto-Layout** + opsi lanjutan.
- Warna: copper top merah, bottom biru, outline board hijau, objek terpilih di-highlight
  hijau terang; latar gelap dengan grid.
- **Klik komponen** → muncul *toolbar mengambang* di dekat objek (designator, posisi,
  rotasi, layer, visibilitas, kunci) dan inspector kanan; Object Tree otomatis
  membuka cabang ke objek itu.

### Panel Profile
- Manufacturing Profile (preset, bisa "Save As"), Description, **Stackup** (mis.
  "Standard 2 Layer"), **Rulesets** (milik proyek), **Overrides** (rule ber-`!important`),
  **System Defaults**.
- **System Defaults = satu ruleset read-only per tipe objek**, seperti stylesheet
  bawaan browser: Circle, Container, Cutout, Component, Fill, Flex Joint, Footprint,
  Group, Layout, Line, Model, Nets (dengan sub-kelas: High/Medium/Low Speed Nets,
  Power Nets, Net), Pad, Polygon, Rectangle, Root, Trace, Silk, Smart Via,
  Stackup Area, Text, Via, Zone.

### Inspector ruleset
Field: Designator, toggle Enabled, Description, **Selector** (kriteria + jumlah objek
yang cocok, mis. "721 objek", sambil di-highlight di kanvas), lalu daftar **Layout Rules**.
Contoh nilai default yang terlihat (dicatat sebagai *jenis* rule, bukan untuk ditiru angkanya):
- Umum: Enabled, Dimension Unit, Rotation Unit, Position, Rotation, Size (+ min/max X/Y),
  Scale for 3D models, Keep Out (min/max), Keep In (min/max), Corner radius minimum,
  Silk Color, Layer.
- Trace: Trace Width, Trace Corner minimum, Preferred Trace Widths, **Shape Start /
  Shape End** (titik ujung segmen relatif).
- Pad: Pad Shape, Pad Type (SMD/TH), Thermal Relief (+ jumlah, lebar, sudut konduktor),
  Connected Layers, Hole Size (+ min/max), Hole Position.
- Nilai bercampur satuan (`10mil`, `500um`, `1.6mm`) → mesin satuan wajib.
- Nilai Keep Out bisa **per jenis target**: bentuk seperti `net(0.5mm) polygon(0.5mm)`.

### Inspector komponen
- Header: nama part + ikon; Designator, Component Name, Description.
- **Layout Rules dengan toggle "Computed" vs "Specified"** — nilai efektif hasil
  cascade vs nilai yang ditulis langsung (konsep sama dengan "computed style" di
  DevTools). Rotasi 3 sumbu (mis. `0° 0° 90°`).
- Properties: Part Type, Manufacturer Name/Part Number, Datasheet URL, Designator Prefix.
- Pricing & Availability (kosong bila tidak ditemukan), Controls.

### Panel View (layer)
Layer dikelompokkan: Mechanical Layers, Top Layers (Silkscreen, Solder Paste,
Solder Mask, Copper…), dst.; tombol tampil/sembunyi per layer dan per grup.

### Panel Review (DRC)
Filter Severity dan Relevance (mis. hanya Layout). Kategori dengan jumlah:
Airwires (koneksi belum di-routing), Redundant Traces, Copper Clearance, Missing Pins,
plus kelompok Manufacturing. Ikon merah = error, kuning = warning.

### Schematic
Kanvas gelap, simbol putih; label nilai di bawah designator (mis. `R2 51 Ω`);
net tanpa nama diberi nama otomatis dari terminal (pola "Net (D2 - K)");
port/label net untuk sinyal bernama.
- Panel View di schematic: opsi tampilan — semua label pin, komentar,
  **kursor kolaborator**, bar shortcut keyboard.
- Panel Review di schematic: **Electrical Rule Checks** (mis. Floating Pin, Missing
  Power) terpisah dari Design Rule Checks dan Manufacturing; filter "Relevance"
  mengikuti tab aktif.

### Seleksi net (PCB)
- Object Tree bisa difilter teks (designator/nama part/selector); baris net menampilkan
  ringkasan terminal yang terhubung (`C1:P2, C2:P2, …`).
- Memilih net → **semua trace net itu di-highlight** di kanvas.
- Inspector net: Designator, daftar Connected Components (terminal), Layout Rules
  (Trace Width, Connected Layers untuk pour, **Auto-Layout Priority**, Fill Stitching
  Density/Offset, Keep Out, Preferred Widths, Trace Width minimum, **Via Type**
  mis. through-hole), Properties (**Net Type** mis. Ground, **Current**).

### Inspector level proyek
- Tanpa seleksi: nama, deskripsi, thumbnail proyek; rules proyek (mis. Grid Spacing,
  satuan, layer aktif); **estimasi harga BOM per distributor** untuk qty 1
  (beberapa distributor sekaligus); Controls.
- Proyek contoh tidak punya ruleset/override sendiri → semua nilai dari System Defaults
  + rule per objek. Artinya default harus cukup baik untuk board sederhana.

### Tab 3D
- View-cube dengan tombol orbit/putar/home dan tombol screenshot.
- Panel View berganti konteks: kamera (Materials: realistis…, Projection: perspektif…),
  layer model 3D (top/bottom).

### Tab Files
- **Documents**: file Markdown proyek (tujuan, catatan, hasil simulasi) — juga
  dipakai agent sebagai memori proyek.
- **Assets**: file terlampir dengan peran (mis. SVG "Default" untuk logo, PNG
  "Thumbnail" untuk sampul proyek).

### Library part
- Pencarian kata kunci / part number, filter: berbintang, pemilik, Part Type,
  tersedia di distributor, manufaktur, kode package, mount, jumlah terminal,
  compliance, punya footprint, punya layout, punya MPN.
- **Setiap part adalah "proyek" sendiri** (bisa di-star, punya pembuat, jumlah
  pemakaian & bintang). Part = dokumen yang bisa dipakai ulang di dokumen lain
  (komposisi), bukan record di tabel terpisah.
- **Part generik parametrik**: satu part (mis. resistor/kapasitor/induktor generik)
  yang simbol & footprint-nya menyesuaikan pilihan package dan nilai.

### Perilaku agent (diamati di proyek kosong pengguna)
- Setelah mode Agent dipilih, agent: berpikir → merujuk panduan internal →
  **mengganti nama proyek** sesuai isi (slug URL ikut berubah, id proyek tetap) →
  **membuat daftar tugas** (mis. 3 tugas: spesifikasi & rangkaian; cek konektivitas,
  level tegangan, catu daya, ERC; ringkasan sebelum layout) → menjalankan tugas
  sebagai *koordinator* dengan status per tugas (berjalan / menunggu / selesai).
- Timeline chat menampilkan langkah ringkas ("Thought for N sec", "Referenced guidance",
  "Renamed …", "Created 3 tasks") yang bisa dibuka-tutup; durasi kerja total ditampilkan.
- Pengguna bisa mengetik arahan saat agent bekerja ("guide while it works") atau
  menghentikannya.

---

## 10. Implikasi untuk arsitektur kita (keputusan kita sendiri)

1. **Dokumen = pohon node ber-UID** dalam CRDT (mis. Yjs). Kolaborasi, autosave,
   change history, dan fork/merge semua turun dari representasi ini.
2. **Mesin rules ala CSS** sebagai inti: parser selector → matcher pada pohon →
   resolver (specificity, cascade, inheritance, `!important`) → nilai efektif.
   Renderer, DRC, dan exporter hanya membaca **nilai efektif**.
3. **Mesin ekspresi** dengan satuan (bisa memakai library permisif seperti mathjs).
4. **Renderer WebGL2** sendiri; layer visibility sebagai state tampilan, bukan data.
5. **DRC inkremental** di Web Worker / WASM (geometri: Clipper2, R-tree).
6. **Command layer tunggal**: setiap aksi UI = perintah terstruktur → otomatis bisa
   dipakai AI agent (tool calling) dan undo/redo.
7. Tampilan, nama fitur, dan alur UI kita didesain ulang — jangan meniru tata letak
   piksel per piksel.
8. Resolver rules harus bisa menjawab dua pertanyaan untuk tiap objek: **nilai
   efektif** dan **asal nilai** (rule/ruleset mana yang menang) — dibutuhkan untuk
   inspector "computed vs specified" dan untuk penjelasan AI.
9. "Default per tipe objek" diimplementasikan sebagai ruleset bawaan berprioritas
   terendah, bukan nilai hard-coded di kode renderer.
10. Nilai rule bertipe: panjang ber-satuan, sudut, vektor 2D/3D, enum, daftar, dan
    peta per-target (`net(…) polygon(…)`).
11. **Part = dokumen** dengan format yang sama dengan proyek; proyek mereferensikan
    part (dengan versi) dan bisa meng-override lewat `!important`. Satu format,
    satu engine, satu sistem kolaborasi untuk keduanya.
12. Panel Review = satu daftar temuan bertipe (kategori, severity, relevansi tab,
    objek terkait), diisi oleh ERC, DRC, dan cek manufaktur yang berjalan inkremental.
13. Agent bekerja lewat **task list eksplisit** yang terlihat pengguna, dan setiap
    langkahnya adalah command editor yang sama dengan yang dipakai UI.
