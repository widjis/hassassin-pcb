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
| export_fab | tulis file | ZIP Gerber, drill, BOM, pick-and-place |
| undo / redo / apply_ops | tulis | Riwayat, operasi mentah |
