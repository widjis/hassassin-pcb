# Benchmarks

Fixed inputs used to check the work agreement ([../04-schematic-improvements.md](../04-schematic-improvements.md))
the same way every time.

- `rgb-sleep-lamp.prompt.txt` — the requirements-only prompt (in Indonesian, as the owner wrote it) for the
  RGB sleep lamp end-to-end test. S7 and S8 compare a fresh agent run with this prompt against the v0.0.1 run:
  the agent works through Claude Code on an empty shared project and is stopped after the schematic stage
  (when it calls `update_pcb`).

v0.0.1 schematic reference figures: 52 parts, 133 wires, 5 wire pieces through part bodies, 30 short jogs,
sheet bounding box 284 × 179 mm (50 896 mm²), ERC 0.
