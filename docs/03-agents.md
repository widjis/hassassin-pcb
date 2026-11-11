# Agent access: CLI and MCP (Fase 3.5)

Satu daftar tool (`packages/tools`) dipakai oleh CLI `hassassin`, MCP server, dan nanti
agent bawaan di aplikasi (Fase 6). Setiap perubahan lewat command layer yang sama dengan UI.

## CLI

Butuh Node ≥ 23.6 (TypeScript dijalankan langsung). Dari root repo:

```sh
pnpm hassassin help
pnpm hassassin import "board.kicad_pcb" -o board.hpcb      # file .kicad_sch di folder yang sama ikut terbaca
pnpm hassassin project-status board.hpcb
pnpm hassassin query board.hpcb "net[netClass=power] > trace"
pnpm hassassin set-rule board.hpcb "net#GND" pourLayers "F.Cu B.Cu"
pnpm hassassin refill-pours board.hpcb
pnpm hassassin run-drc board.hpcb --fail-on-error           # exit 2 bila ada error (untuk CI)
pnpm hassassin export-fab board.hpcb -o fab.zip
```

Output selalu JSON. Tool yang mengubah proyek menyimpan kembali ke `.hpcb` (file KiCad
hanya dibaca; pakai `-o file.hpcb`). Setiap panggilan CLI adalah sesi terpisah, jadi `undo`
hanya berguna di sesi MCP.

## MCP server

```sh
node /path/to/hassassin-ai-pcb-designer/apps/cli/bin/hassassin.mjs mcp
```

Semua tool menerima `project` (path `.hpcb`). Tambahan: `new_project`, `import_kicad`.

### Claude Code

```sh
claude mcp add hassassin -- node /ABS/PATH/hassassin-ai-pcb-designer/apps/cli/bin/hassassin.mjs mcp
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.hassassin]
command = "node"
args = ["/ABS/PATH/hassassin-ai-pcb-designer/apps/cli/bin/hassassin.mjs", "mcp"]
```

### Proyek live (Fase 4)

Selain path `.hpcb`, `project` boleh berupa **link berbagi** dari tombol Share, misalnya
`http://localhost:5178/?p=<id>&t=<token>`. Agent lalu bergabung ke sesi live sebagai kolaborator
berlabel *agent* (nama bisa diatur dengan env `HASSASSIN_AGENT_NAME`): editnya langsung terlihat
oleh semua orang yang membuka proyek, dan link *view*/*comment* tidak bisa dipakai untuk mengedit.
CLI juga menerima link yang sama: `pnpm hassassin run-drc "http://…?p=…&t=…"`.

### Alur yang disarankan untuk agent

`project_status` → `set_spec` → `add_part` / `connect_pins` / `add_label` → `run_erc` →
`update_pcb` → `move_part` / `route` / `set_rule` / `refill_pours` → `run_drc` → `export_fab`.

## Daftar tool

| Tool | Baca/Tulis | Fungsi |
|---|---|---|
| project_status | baca | Ringkasan, hasil cek, gerbang tahap, spesifikasi |
| query | baca | Cari objek dengan selector |
| inspect | baca | Semua rule computed + asal nilainya |
| list_parts | baca | Part di schematic dan board |
| netlist | baca | Net schematic beserta pin |
| run_erc / run_drc | baca | Pemeriksaan schematic / board |
| list_rules | baca | Rule yang tersedia, ruleset proyek, default |
| set_rule | tulis | Ruleset (default) atau rule per objek |
| set_property / set_spec | tulis | Properti part / kebutuhan proyek |
| add_part / connect_pins / add_label | tulis | Edit schematic |
| update_pcb | tulis | Sinkron schematic → board |
| move_part / route / refill_pours | tulis | Edit board |
| search_parts / get_part | baca | Cari part (proyek, generik, team, library KiCad terpasang) |
| search_footprints | baca | Cari footprint (generik, proyek, KiCad) |
| bom | baca | BOM + harga untuk N board, part tanpa MPN/harga/stok |
| place_part | tulis | Pasang part library (semua unit) di schematic |
| assign_footprint | tulis | Ganti footprint; board diperbarui di tempat |
| set_part_info | tulis | MPN, pabrikan, datasheet, LCSC, nilai, DNP |
| import_offers / set_offer | tulis | Data harga & stok (CSV / manual) |
| import_kicad_library | tulis | Salin `.kicad_sym` / `.kicad_mod` ke proyek |
| auto_place / autoroute | tulis | Penempatan & routing otomatis |
| get_stackup / set_stackup | baca / tulis | Stackup lapisan (termasuk preset flex) |
| impedance | baca | Impedansi dari lebar, atau lebar untuk target impedansi |
| net_lengths / tune_length | baca / tulis | Panjang net, diff-pair & skew, serpentine |
| export_fab | tulis file | ZIP Gerber, drill, BOM, pick-and-place |
| undo / redo / apply_ops | tulis | Riwayat, operasi mentah |


## Agent bawaan (Fase 6)

Selain lewat Claude Code/Codex (MCP), Hassassin punya agent sendiri yang memakai tool yang sama:

- **Di web**: tab *Agent* pada proyek yang sudah di-*Share*. Server harus punya kredensial Anthropic:
  `ANTHROPIC_API_KEY=... pnpm run server` (atau `ant auth login` di mesin server).
- **Di CLI**: `hassassin agent board.hpcb "tambahkan LED indikator di 3V3" -o board.hpcb`, atau dengan link
  berbagi supaya editnya live. `--mode ask` untuk jawaban tanpa mengubah proyek.

### Pakai langganan, bukan API (Claude Code / Codex)

Tab *Agent* bisa memakai CLI yang login dengan akun langganan Anda, jadi tidak perlu kredit API:

| Pilihan | Butuh |
|---|---|
| Claude Code | Langganan Claude (Pro/Max), login sekali lewat tombol **Sign in** |
| Codex | Langganan ChatGPT, login sekali lewat tombol **Sign in** |
| Claude API | `ANTHROPIC_API_KEY` di file `.env` (bayar per pemakaian) |

Kedua CLI ikut terpasang dengan `pnpm install` (dependency `apps/server`). Saat Anda mengirim pesan, server
menjalankan CLI tersebut di Mac Anda dengan MCP server Hassassin yang sudah terikat ke proyek yang terbuka:
tool bawaan Claude Code dimatikan, Codex berjalan di sandbox read-only di folder kosong, dan mode *Ask*
hanya mendapat tool baca. Editnya muncul live seperti kolaborator lain.

Catatan:
- Hanya untuk server di mesin Anda sendiri (permintaan dari luar mesin ditolak): langganan bersifat pribadi.
- Claude Code adalah perangkat lunak Anthropic dengan lisensinya sendiri (bukan open source); Codex berlisensi
  Apache-2.0. Keduanya dipasang dari npm, tidak disalin ke repo ini.
