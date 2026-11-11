# Hassassin AI PCB Designer

Editor PCB berbasis browser (schematic, layout, kolaborasi real-time, AI agent), dibangun secara clean room.

## Aturan clean room
- Tidak ada kode, aset, teks UI, atau merek dari produk lain (KiCad, Flux, dll.) yang disalin.
- Perilaku referensi hanya dari materi publik dan pengamatan sebagai pengguna; dicatat di `docs/`.
- Implementasi hanya merujuk dokumen di `docs/`, bukan produk aslinya.
- Library pihak ketiga hanya yang berlisensi permisif (MIT/BSD/Apache/BSL).

## Dokumen
- [docs/01-flux-behavior-spec.md](docs/01-flux-behavior-spec.md) — spesifikasi perilaku referensi.
- [docs/02-roadmap.md](docs/02-roadmap.md) — fase pengembangan.
- [docs/03-agents.md](docs/03-agents.md) — CLI `hassassin` dan MCP server untuk Claude Code / Codex.

## Menjalankan
```sh
pnpm install
pnpm dev        # http://localhost:5178 — buka file .kicad_pcb lewat tombol Open atau drag-and-drop
pnpm run server # server kolaborasi di :5179 (Vite mem-proxy /api dan /ws ke sini) — perlu untuk Share dan tab Agent
                # (pakai `pnpm run server`: `pnpm server` adalah perintah bawaan pnpm)
pnpm start      # produksi: build web lalu satu proses melayani aplikasi + kolaborasi di :5179
pnpm test       # unit test (set KICAD_SAMPLE=/path/board.kicad_pcb untuk uji board nyata)
pnpm typecheck
pnpm build
```
Board contoh bisa ditaruh di `apps/web/public/samples/` (diabaikan git) lalu dibuka dengan
`http://localhost:5178/?board=samples/<nama>.kicad_pcb`.

## Struktur
- `packages/core` — pohon dokumen, satuan, selector ala CSS, mesin cascade rules, default per tipe.
- `packages/kicad-import` — parser S-expression dan impor `.kicad_pcb`.
- `apps/web` — editor web (layout WebGL2, schematic Canvas2D, panel, kolaborasi).
- `packages/fab` — Gerber, drill, BOM, pick-and-place, ZIP.
- `packages/tools` — tool bersama untuk CLI, MCP, dan agent.
- `packages/sync` — protokol & klien kolaborasi.
- `apps/cli` — CLI `hassassin` + MCP server.
- `apps/server` — server kolaborasi (HTTP + WebSocket, penyimpanan di `.data/`).
