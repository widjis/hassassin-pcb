# Work agreement: schematic improvements

| | |
|---|---|
| Document | `docs/04-schematic-improvements.md` |
| Version | 0.4 |
| Status | **Approved on 2026-11-11 — in progress** |
| Owner | Repository owner (widjis) |
| Implementer | AI coding agent working in this repository |
| Based on | Hassassin PCB 0.0.1 (tag `v0.0.1`) |

This document is the agreed scope of the next piece of work on Hassassin PCB. Once approved
(see [Approval](#approval)), the implementer works through it in order, and changes to the scope
only happen through the [change process](#change-process).

## 1. Goal

Make the schematic editor pleasant to use by hand and make schematics — whether drawn by a person
or by the agent — easy for people to read and trace.

## 2. Background

- **Owner's schematic style rules:** parts are connected with wires (not labels alone), every ground and
  supply connection uses a power symbol, and net labels are kept for signals that run between blocks.
  The agent already follows these rules; the editor and tools should make them easy to keep.
- **End-to-end test (RGB sleep lamp, v0.0.1):** the agent produced a correct schematic (52 parts, ERC 0),
  but the sheet was spread out with large gaps between blocks, and its L-shaped wires can cross other pins.
- **Known editor limits in v0.0.1:** wires do not follow a symbol when it is moved, there is no box
  selection, copy/paste, junction handling, annotation, sheet frame or schematic export, and multi-unit
  symbols cannot switch units.

## 3. Scope

Three milestones, done in order. Each item has acceptance criteria that can be checked; an item is done
only when all of its criteria pass.

### Milestone M1 — editor comfortable for manual work

- [x] **S1. Wires follow moved symbols.** — `34ebd5a`
  - Delivered: drag, R, X / Y in the editor and the `move_symbol` tool (CLI, MCP, agent). The chain of
    wires from a moved pin up to the next branch point is re-routed at right angles, avoiding symbol
    bodies and other nets; pieces left dangling are removed. Every result is checked against the netlist
    before it is used: a rotate / mirror / `move_symbol` that would still change connections is refused
    with a message, and a drag that does so warns. A wire that cannot be routed cleanly stays slanted.
  - Tests: `packages/tools/test/schematic-s1.test.ts` (netlist identity for moves, all 8 orientations of
    each part, 60 random edits, undo, the tool). Browser check: drag, rotate, mirror and undo on a test sheet.
  - Adds a mirror command for symbols (X / Y keys; the model already stores mirroring, the editor has
    no command for it yet).
  - Moving, rotating or mirroring a symbol keeps every wire that ends on one of its pins attached:
    the wire end moves with the pin, and the segment next to it is adjusted so the wire stays orthogonal
    where possible.
  - The netlist before and after the move is identical (checked by an automated test).
  - One undo step restores the symbol and the wires together; collaborators see the same result live.
- [x] **S2. Box selection.** — `b319db7`
  - Delivered: left→right box selects items fully inside, right→left also items it touches (dashed green
    box); Shift adds. Pan: middle drag, Space + drag, two-finger trackpad scroll; mouse wheel / pinch zoom.
    A selection moves, rotates (R, around its centre), mirrors (X / Y) and deletes as one undo step;
    wires outside it that end on its pins or wires follow. Schematic hints in the side panel updated.
  - Limit: telling a trackpad scroll from a mouse wheel is a heuristic (browsers do not say which device
    sent the event); Ctrl / pinch always zooms.
  - Tests: `packages/tools/test/schematic-s2.test.ts`. Browser check: box select, group rotate, group
    drag, Space + drag, trackpad pan.
  - Dragging on an empty part of the sheet draws a selection box; objects inside it are selected
    (left-to-right = fully inside, right-to-left = touching, a common convention, or one documented rule).
  - Panning, which uses that drag today, moves to the middle mouse button, Space + drag, and trackpad
    two-finger scroll; the keyboard hints on screen are updated.
  - Shift adds to the selection; the selection can then be moved, rotated, mirrored or deleted as one step.
- [x] **S3. Copy, paste and duplicate.** — `dba98df`
  - Delivered: Cmd/Ctrl+C / V / D on symbols (with power symbols), wires, labels, junctions and
    no-connects. Pasted parts get the next free references (units of one part share the new one); the
    paste follows the mouse, a click drops it as one undo step, Esc cancels. The copy is also kept in
    browser storage, so another tab of the app can paste it. Agents: the `duplicate` tool copies parts
    with their wires, power symbols and labels and refuses an offset where the copy would touch anything.
  - Tests: `packages/tools/test/schematic-s3.test.ts`. Browser check: duplicate following the mouse,
    drop, undo / redo, copy + paste + Esc.
  - Cmd/Ctrl+C, Cmd/Ctrl+V and Cmd/Ctrl+D work on symbols, wires, labels, power symbols and junctions.
  - Pasted parts get the next free references (R7 → R8 …); connections inside the copied group are kept;
    labels keep their names, so pasted global labels join the same nets.
  - Paste follows the mouse until clicked, then is one undo step.
- [x] **S4. Wire editing and junctions.** — `f618086`
  - Delivered: dragging a single wire segment moves it across its own direction; wires running along
    the drag stretch, and where its end sits on a pin, label or another wire a short new wire keeps it
    connected. A wire may start or end on the middle of another wire (the wire tool stops there).
    Junction dots are added where three or more connections meet and removed when no longer needed,
    by every editor edit and every tool (`connect_pins`, `add_power`, …); a plain crossing stays
    unconnected, as the netlist already treated it.
  - Tests: `packages/tools/test/schematic-s4.test.ts`. Browser check: segment drag with a stretched
    neighbour and a new wire at the pin, netlist unchanged, junctions on branch points.
  - A wire segment can be dragged; its neighbours stretch to stay connected.
  - A wire can start or end on the middle of another wire, which connects them.
  - A junction dot is added automatically wherever three or more wire ends / pins meet, and removed when
    it is no longer needed; crossing wires without a junction stay unconnected (and the netlist agrees).
  - Tools (`connect_pins`, `add_power`) create junctions the same way.
- [x] **S5. Edit values and properties in place.** — `3769076`
  - Delivered: double-clicking a reference or value on the sheet opens a text box over it (Enter or
    clicking away saves, Esc cancels). The inspector shows a Part form for schematic symbols: reference,
    value, MPN, manufacturer, datasheet, footprint and DNP. A new reference is checked (valid, not used)
    and renames every unit and the board component, so Update PCB keeps matching; value / MPN /
    manufacturer / datasheet / DNP go to the symbols and the board component; a footprint goes to the
    symbols and reaches the board on Update PCB. Agents: `set_part_info` gained `rename`.
  - Tests: `packages/tools/test/schematic-s5.test.ts`. Browser check: in-place value edit, inspector
    rename, duplicate reference refused, undo.
  - Double-clicking a reference or value on the sheet edits it in place; Enter saves, Esc cancels.
  - The inspector shows and edits the part's properties (value, MPN, manufacturer, footprint, datasheet,
    DNP) for schematic symbols; changes reach the board on Update PCB as today.
- [x] **S6. Annotation (renumbering references).** — `5731010`
  - Delivered: Annotate button in the schematic toolbar (whole design or this sheet; keep existing
    numbers or renumber from 1) and the `annotate` tool. Order: sheet by sheet, top to bottom, then
    left to right; units of a part share a reference; duplicates and unnumbered parts ("R?") get new
    numbers; numbers used by board-only components are skipped. Board components are renamed with
    their symbols; Update PCB then renames the nets and routed copper follows (tested on an
    autorouted board: 0 unrouted, same DRC result).
  - Tests: `packages/tools/test/schematic-s6.test.ts`. Browser check: Annotate dialog, renumber from 1.
  - A command renumbers references per prefix, ordered by sheet then position (top-to-bottom,
    left-to-right), with options: whole design or one sheet, keep existing numbers or reset.
  - The board's components are renamed to match, and routed copper keeps its nets.
  - Available as a tool (`annotate`) for agents too.

**M1 done when:** every item above is checked; release `v0.0.2`.

### Milestone M2 — tidy, shareable schematics

- [x] **S7. Wires that avoid symbols and pins.** — `93fd6ab`
  - Delivered: `connect_pins` and the wire tool route at right angles around symbol bodies and never
    touch pins, wires or labels of other nets (straight / one bend first, then two, then a grid search);
    with no clean path, `connect_pins` fails and suggests labels, and the wire tool shows a red preview.
    New ERC warning `wireOverPin` (a pin in the middle of a wire).
  - Agent re-run (same prompt as v0.0.1, Claude Code, stopped after the schematic stage):
    | | v0.0.1 | v0.0.2 + S7 |
    |---|---|---|
    | Parts / wires | 52 / 133 | 49 / 132 |
    | Wire pieces through a part body | 5 (J1, F1 ×2, TP1, TP2) | **0** |
    | Pins in the middle of a wire | 0 | 0 |
    | ERC errors / warnings | 0 / 0 | 0 / 0 |
  - Seen in the re-run, left to S8: wires still jog where the agent placed two connected pins slightly
    off one line (for example the EN divider and the R8 pull-up), and some texts overlap.
  - `connect_pins` and the wire tool find an orthogonal path that does not pass through symbol bodies
    or over unrelated pins, with as few bends as practical; when no clean path exists they say so and
    suggest a label instead.
  - Re-running the RGB sleep lamp prompt (same prompt as in v0.0.1): no wire crosses a pin it is not
    connected to.
- [x] **S8. Compact, aligned layout of blocks.** — `0bc28bf`
  - Align and distribute commands for a selection (left / right / top / bottom / centre, even spacing).
  - A tool for agents to place a block of parts relative to an anchor part (for example "decoupling
    capacitors below U1, 2.54 mm apart").
  - Re-running the RGB sleep lamp prompt: the sheet area used is clearly smaller than in v0.0.1
    (target: at least 40 % less bounding-box area), with blocks still separated.
  - *(added in 0.3)* **Jog removal:** a command and a tool (`tidy_wires` for agents) move small parts
    (for example a resistor divider or a pull-up) so that the pins they connect to line up and the wire
    between them becomes straight; connections are checked with the netlist and never change. On the
    RGB sleep lamp re-run, wires with a short jog (an offset of up to 5.08 mm that could be removed by
    moving one part) drop by at least 80 %.
  - *(added in 0.3)* **No overlapping text:** references, values, power-symbol names, net labels and
    PWR_FLAG texts are placed so they do not overlap each other, symbol bodies or wires; when a text
    cannot fit next to its owner it moves to a free spot nearby. On the RGB sleep lamp re-run: no two
    texts overlap.
  - *(added in 0.4)* **Configurable schematic grid:** the pin grid (where part pins land: 1.27, 2.54 or
    5.08 mm, default 2.54) and the wire grid (1.27 or 2.54 mm, never coarser than the pin grid) are
    project settings, saved in the project and shared with collaborators. A picker in the schematic
    toolbar and a `set_schematic_grid` tool change them; placing, dragging, rotating, pasting,
    `add_part`, `move_symbol`, `duplicate` and `tidy_wires` all follow them; `project_status` reports
    them.
  - Delivered in `56d41a7`, `a2d1e4c`, `3e16644`, `2463e76`, `c968dd1`, `9f3e442` and `0bc28bf` (fix below).
    Agent re-runs (benchmark prompt `docs/benchmarks/rgb-sleep-lamp.prompt.txt`, Claude Code, stopped after
    the schematic stage):
    | | v0.0.1 | Re-run 1 | Re-run 2 (final) | Target |
    |---|---|---|---|---|
    | Sheet bounding-box area | 50 896 mm² | 31 213 mm² (−38.7 %) | **25 560 mm² (−49.8 %)** | ≥ 40 % less — met |
    | Short jogs | 30 | 1 | **3 (−90 %)** | ≥ 80 % less — met |
    | Overlapping texts | — | 0 | **0** | 0 — met |
    | ERC errors / warnings | 0 / 0 | 0 / 0 | 0 / 0 | — |
    Re-run 1 missed the area target because the agent did not use `place_relative` / `align`; `compact_blocks`
    and a required finishing step (compact_blocks → tidy_wires → run_erc) were added before re-run 2.
  - Finding in re-run 2, fixed: two wires crossed a part body (R1, C4) without shorting it. Router, ERC
    (`wireThroughPart`) and `tidy_wires` were fixed; on that sheet `tidy_wires` now leaves 0 wires through
    bodies and 0 ERC warnings (jogs 5, still −83 %). Not yet confirmed by a new agent run.
- [x] **S9. Sheet frame, title block, notes and group boxes.** — `7a0fcdb`
  - Delivered: frame A4…A0 landscape (or the smallest that fits), centred on the drawing, title block with
    title, project, revision, date, author and sheet n / m (project name and date filled in automatically);
    notes (T, double-click to edit) and titled group boxes (G around the selection); tools
    `set_sheet_frame`, `add_note`, `add_group_box` (sized from the parts of a block). Boxes and notes move
    with their block in `compact_blocks`, and part texts keep clear of them and the title block.
  - Tests: `packages/tools/test/schematic-s8.test.ts` (S9 section). Browser check: frame dialog, A3 frame
    and title block, group box around the power block, note with T.
  - Each sheet can have a frame with a title block (title, revision, date, author, sheet number), filled
    from project data where possible.
  - Free text notes and rectangles for grouping blocks ("Power", "MCU", "Sensors"), also available as tools.
- [x] **S10. PDF and SVG export of the schematic.** — `00ca5ca`
  - Delivered: **Export…** in the schematic toolbar and the `export_schematic` tool / CLI command. PDF has one
    page per sheet (built-in Courier font, nothing embedded); SVG is one file per sheet (a ZIP for several).
    Colours: light (default, for printing), black and white, or dark as on screen. The page is the sheet
    frame (S9) or the drawing plus a margin; "fit to A4 … A0" scales a sheet to that paper.
  - Tests: `packages/tools/test/schematic-s10.test.ts` (PDF structure and cross-reference offsets, pages and
    sizes, escaping, themes, tool output). Checked on the RGB sleep lamp project: PDF rendered by macOS,
    SVG in the browser, both downloads from the dialog.
  - Export of one sheet or all sheets, vector output, readable when printed on A4 / A3, light background
    option.
- [x] **S11. Create hierarchical sub-sheets in the editor.** — `3c0412b`
  - Delivered: **Sub-sheet** button (block at the cursor, or right of the drawing), double-click to enter,
    U to go up; the label dialog offers local, global and hierarchical (with direction). Each hierarchical
    label adds a sheet pin on the block edge (inputs left, outputs right, block grows as needed); a pin
    whose label is gone is removed, unless a wire still ends on it. Blocks move with their pins and wires,
    and can be deleted (with confirmation). Wires route around blocks and never run along their edges.
    ERC `hierMismatch`: label without pin, pin without label, hierarchical label on a top-level sheet.
    Tools: `add_sheet`, `add_label kind=hier shape=…`, block pins as `Block:NAME` in `connect_pins`.
  - Tests: `packages/tools/test/schematic-s11.test.ts` (pins follow labels, nets across levels, orphan pins,
    nested sheets, imported pins untouched); the existing KiCad hierarchy import test still passes.
    Browser check: sub-sheet with C1 and label IN, pin IN on the block, wire from R1, ERC clean for it.
  - Create a sub-sheet block, enter it, add hierarchical labels; matching sheet pins appear on the block.
  - Netlist and ERC behave as for imported KiCad hierarchies (existing tests keep passing).
- [x] **S12. Switch units of multi-unit symbols.** — `447645a`
  - Delivered: the inspector of a multi-unit symbol has a **Unit** choice (A, B, C (power) …; placed units
    cannot be picked) and a **Place** button for every unit not placed yet. Placing a multi-unit part in
    the editor puts down unit A and says which units are left. References show the unit letter (U1A, U1B).
    Switching keeps the symbol's place, rotation and properties; wires stay where they are, as in KiCad.
    Multi-unit symbols imported from KiCad keep their library definition, so they can be switched too.
    ERC `unitNotPlaced`: an error for a missing power unit, a warning for a spare unit. Tools:
    `switch_unit`, `place_unit`, `place_part units=…`.
  - Tests: `packages/tools/test/schematic-s12.test.ts` (partial placement, ERC, switching and undo,
    refusals, KiCad import). Browser check: dual op-amp, place C (power), switch A to B, ERC warning for A.
  - A placed unit can be changed (A, B, power unit …); placing one unit offers the remaining units.
  - ERC reports units that were never placed when their pins matter (for example the power unit).

- [x] **S16. Symbol editor** (moved from M3 in version 0.2). — `3e9b495`
  - Delivered: **New symbol…** in the Parts panel and **Edit symbol…** in the Parts panel and the
    inspector. Paste a pin table (tab, comma, semicolon, `|` or space separated, header optional, datasheet
    type words I / O / I/O / P / G / OD understood, missing types guessed from names), adjust number, name,
    type, side and unit per pin, choose sides (by function, as on the package, from the table), order
    (table, number, name) and a separate power unit; live preview of every unit. Bodies are sized to the pin
    names, every pin on the 2.54 mm grid. The part is stored in the project with its pin table; saving an
    edit redraws every placed copy; Publish to team works as for other project parts (checked against the
    server). Tools: `create_symbol` (text or list, same options), `add_part kind=ic pin_layout / pin_sides`.
    Also: new parts are placed clear of existing symbols.
  - Tests: `packages/tools/test/schematic-s16.test.ts`. Browser check: datasheet table pasted, package and
    by-function layouts, save and place, edit with the placed copy redrawn.
  - Create or edit a symbol: body, pins (number, name, type, side), from a pin table that can be pasted
    (for example from a datasheet); the result is stored with the project and can be published to the
    team library.
  - Pin side and order can be set when pasting a pin table; pins can be split into units (for example
    A, B and a power unit); `add_part` gets the same pin-side option for agents.
- [x] **S19. Footprint generator.** — `b415546`
  - Delivered: `packages/core/src/footprintGen.ts` (written from scratch; no KiCad code). Families two-row
    (around / zigzag numbering, SMD or through-hole), four-side, grid (JEDEC row letters, depopulated
    positions), castellated module (optional half-hole drills) and free pad lists; exposed pad with
    thermal vias; mounting holes; fab, silk, courtyard, pin-1 mark, reference and value. Pads from the
    land pattern, or derived from lead dimensions with documented margins (gull-wing toe / heel / side
    0.35 / 0.35 / 0.05, no-lead 0.30 / 0 / 0, J-lead 0.10 / 0.60 / 0.05 mm; pads kept 0.2 mm apart).
    **New footprint…** in the Parts panel and the inspector (with Edit for generated ones): form per
    family, live preview with pad-centre spans, pitch, pad sizes and courtyard. Stored in the project
    with its parameters; published with its part as before. Tool `create_footprint` (with `ref`).
  - Tests: `packages/tools/test/footprint-s19.test.ts`: ESP-12F module, QFN-24 with exposed pad and vias,
    2 × 20 header (every pad within 0.01 mm of the datasheet numbers); a board with all three passes DRC
    (0 errors); SOIC-8, TSSOP-20 and QFN-24 generated from JEDEC lead dimensions match the installed KiCad
    footprints (same pads and numbering, positions and sizes within 0.1 mm); KiCad is read at test time
    only. Browser check: castellated module and a QFN from lead dimensions, saved into the project.
  - Makes a footprint from datasheet dimensions when no library footprint exists: rows / grids of pads
    (count, pitch, pad size and shape, row spacing), an exposed / thermal pad, castellated edge pads,
    through-hole pins with drill, and mounting holes. It also adds the courtyard, silkscreen outline,
    fabrication outline, pin-1 mark and reference / value text.
  - Package families generated from parameters: two-row (SOIC / SOP / TSSOP / DIP / headers),
    four-side (QFP / QFN), grid (BGA / LGA), castellated module (ESP-12F style) and free pad lists.
  - Pad sizes come from the datasheet's recommended land pattern; when a datasheet only gives lead
    dimensions, they are derived with documented toe / heel / side margins.
  - Shows a live preview with the dimensions; the result is stored with the project and can be published
    to the team library. Available as the tool `create_footprint` for agents.
  - Written from scratch on the existing generator in `packages/core/src/footprints.ts`; no KiCad
    code is ported (KiCad's footprint generators are GPL).
  - Acceptance: an ESP-12F-style module, a QFN-24 with an exposed pad and a 2×20 header are generated
    from their datasheet numbers. Each pad's position and size matches the datasheet within 0.01 mm,
    and a board using them passes DRC.
  - Reference check: for standard packages (for example SOIC-8, TSSOP-20, QFN-24), a test compares the
    generated pads with the matching footprint in the KiCad libraries installed on the machine. The
    libraries are read only while the test runs and never copied into the repository; the test is
    skipped when KiCad is not installed.
- [x] **S20. Pin ↔ pad check.** — `49b5b34`
  - Delivered: `packages/core/src/pinPad.ts`. All units of a part count together; one pad number may have
    several pads (exposed pad with vias); unnumbered pads, bare holes and pads named MP… / SH… / MH… / TAB…
    are mechanical; others can be listed in the part's **Mechanical pads** (inspector,
    `set_part_info mechanical_pads`). The board's copy is checked when the part is on the board, the
    schematic's footprint when it was changed and not synced yet. ERC `pinPadMismatch`: error for pins
    without a pad, warning for pads without a pin, both with the pin and pad counts; Review lists them.
    Update PCB reports it (tool result `pinPad`, message in the editor); `assign_footprint` returns the
    check at once and the agent is told to read and fix it.
  - Tests: `packages/tools/test/schematic-s20.test.ts`. Browser check: Review shows a 10-pin symbol on
    SOIC-8 (error) and a QFN exposed pad without a pin (warning); Mechanical pads = 25 clears the warning;
    Update PCB names the part.
  - ERC (and Update PCB) reports symbol pins with no matching footprint pad, pads with no pin (unless
    marked mechanical / no-connect), and pin counts that differ.
  - The agent runs it after `assign_footprint`; Review lists the findings.
- [x] **S21. Official KiCad libraries on demand.** — `e19906c`
  - Delivered: `packages/tools/src/kicadDownload.ts` (Node only). When the server has no KiCad libraries,
    the Parts panel offers **Download KiCad libraries…**; the confirmation names both repositories
    (gitlab.com/kicad/libraries/kicad-symbols and kicad-footprints), the size class and the license.
    Only then the newest stable release is fetched (one archive each) and unpacked into
    `~/.cache/hassassin/kicad-libraries/<version>/` (only `.kicad_sym`, `.kicad_mod` and the license files;
    `gzip` from Node, our own small tar reader); the server uses it at once, later starts find it too.
    Only the computer the server runs on can start it (`POST /api/library/kicad/download`); the CLI has
    `hassassin kicad-libraries [status|download]`. An installed KiCad always wins. Every KiCad part and
    footprint carries its license; the part detail shows source and license. The agent is told to tell
    the user, never to download.
  - Tests: `apps/server/test/kicadDownload.test.ts` with a local fake of the repositories (no network):
    tar with pax long names, release choice, the whole flow on the server (nothing fetched before the
    request; parts and footprints searchable with source and license afterwards). Browser check: a server
    without KiCad shows the offer and the confirmation (declined: nothing fetched); with KiCad installed,
    the part detail shows "From: KiCad library Regulator_Linear · License: CC BY-SA 4.0 …".
    Real download (owner's go-ahead, 2026-11-12): gitlab.com answered `406 Not Acceptable` to Node's
    built-in fetch for both the archive link and the archive API, while the same link works in a browser
    and with curl. We do not work around a site's bot protection, so a refused download now explains how
    to fetch the two archives in a browser, and `hassassin kicad-libraries install <archives>` installs
    them (tested with local archives). Open: how the automatic download should identify itself to
    gitlab.com is the owner's decision.
    Real archives (2026-11-12, KiCad 10.0.8, fetched with curl): the symbol sources keep one file per
    symbol in `<Lib>.kicad_symdir/` (KiCad's own build joins them for its installers), so the first
    install had footprints but no symbols. Install now joins each folder into one `<Lib>.kicad_sym`
    (`794658d`). Checked with the real archives: 155 footprint libraries, 223 symbol libraries with
    22,911 symbols; `search-parts AMS1117` finds it, and AMS1117-3.3 (an `extends` symbol) places with
    its pins and the SOT-223 footprint.
  - Without KiCad installed, the app can download the official symbol and footprint libraries from
    KiCad's public repository into a local cache, after the user agrees.
  - They are never stored in this repository. The UI shows where each part came from and its license
    (CC BY-SA 4.0 with KiCad's exception for designs that use the libraries).

**M2 done when:** every item above is checked; release `v0.0.3`.

### Milestone M3 — compatibility and advanced features

- [x] **S13. KiCad netlist export (`.net`).** — `9eafd2b`
  - Delivered: `packages/core/src/kicadNetlist.ts`, written from KiCad's netlist files (S-expression,
    version "E"): the sheets with their title blocks, one component per reference (all units together,
    power and flag symbols left out, stable UUIDs; imported sheets keep their KiCad UUID) and every net
    with its pins, pin functions and pin types (`+no_connect` on pins with a marker). Generic footprints
    map to KiCad library footprints where the match is clear (`chip-0603` on a resistor →
    `Resistor_SMD:R_0603_1608Metric`, SOIC, TSSOP, DIP, SOT-23, diodes, pin headers, mounting holes);
    the rest are listed as not found. **File → Export KiCad netlist (.net)**, the `export_netlist` tool
    and `hassassin export-netlist`.
  - Unnamed nets are now named as KiCad names them (seen across real projects): a pin with a name first,
    then the first reference, whatever the pin types; a "/" in a pin name is written `{slash}`. This also
    applies to Update PCB.
  - Tests: `packages/tools/test/schematic-s13.test.ts` (a design made here, naming, the tool). Against
    KiCad: with `KICAD_PROJECT_DIR` set and KiCad installed, the test compares our netlist with
    `kicad-cli sch export netlist`; run on 16 local projects (solar MPPT r3/r4, GPS tracker and backups,
    battery carrier, Pico BQ40Z50 adapter rev b–f, and others): components, net names, pins and pin
    types identical in all of them.
  - KiCad check (KiCad 10.0.7 PCB Editor, File → Import → Netlist, on an empty board): the RGB sleep lamp
    netlist exported from Hassassin loads with 0 warnings and 0 errors; Update PCB adds all 53 footprints
    with 146 pads and 35 nets. The test board was not saved.
  - The exported netlist opens in KiCad's PCB editor ("Update PCB from netlist" / import netlist) for a
    test project, with every component and net present.
- [x] **S14. `.kicad_sch` export.** — `c350665`
  - Delivered: `packages/core/src/kicadSchematic.ts`, written from KiCad's file format documentation and
    example files: one `.kicad_sch` per sheet (format 20250114, KiCad 9 and 10) with symbols, wires,
    junctions, no-connects, local / global / hierarchical labels, sheet blocks with their pins, power
    symbols, notes, group boxes, paper size and title block, plus a `.kicad_pro`. Each placed symbol's
    drawing and pins go into `lib_symbols`; library symbols imported from KiCad and unchanged since are
    written back exactly as they came (the importer now keeps them), and symbols made here go into a
    bundled `hassassin.kicad_sym` with a `sym-lib-table`, so KiCad finds every library and sees no
    changed symbols. Generic footprints are mapped to KiCad's (as in S13). **File → Export KiCad
    schematic (.zip)**, the `export_kicad_schematic` tool and `hassassin export-kicad-schematic`.
  - Found on the way and fixed: unnamed nets on a hierarchical label are named after it (`/Filter/IN`),
    as KiCad does; new ERC warning `labelSinglePin` (a label on only one pin), matching KiCad's.
  - Tests: `packages/tools/test/schematic-s14.test.ts`: round trip (export → import gives the same nets
    and names), the files and the tool; with KiCad installed, kicad-cli reads a design made here with the
    same nets, no library or footprint warnings and the same unconnected-pin error; with
    `KICAD_PROJECT_DIR`, a real project round trip.
  - KiCad check (kicad-cli 10.0.7, the program behind the editor): on 16 local KiCad projects, imported
    into Hassassin and exported again, KiCad's netlist and ERC of our files are identical to those of the
    originals (components, net names, pins, every error and warning; the original project's library
    tables copied next to the export). The RGB sleep lamp made by the agent: same 53 components and 35
    nets; KiCad's ERC finds the two labels on a single pin that our ERC now finds too
    ([render by KiCad](media/m3-s14-kicad-render.jpg)). Not checked: opening the files in the KiCad
    Schematic Editor window (access to it was not granted this time) and KiCad 9.
  - Left for S17: KiCad treats a power symbol as a power input (a net with power symbols but no source
    or PWR_FLAG is an error there, not here), and checks pin types against each other (`pin_to_pin`).
  - A schematic made in Hassassin opens in KiCad 9/10 with the same symbols, wires, labels and power
    symbols; KiCad's ERC on it matches ours for the test projects.
  - Round trip: import → export → import gives the same netlist.
- [x] **S15. Buses.** — `86cb61f`
  - Delivered: `packages/core/src/bus.ts`. Buses (`bus` segments) named by a label: vectors
    `DATA[0..7]` (also descending, `A[3..0]`) and groups `I2C{SDA SCL}` / `{SDA SCL}` (members `I2C.SDA`,
    `SDA`; vectors inside groups); bus entries (`busEntry`). What connects, as KiCad decides it (found
    first with small test schematics read by kicad-cli): a wire is a member through its net label;
    within a sheet, members connect by name; through a sheet pin the parent bus and the sheet's bus join
    member by member in order, named from the parent (`X[0..1]` on the parent, `D[0..1]` inside → `/X0`,
    `/X1`); a global label on a bus makes its members global. Bus labels are not nets. Editor: **Bus** (B)
    and **Entry** (E) tools; buses drawn thick and blue; they select, move, copy and delete like wires;
    PDF / SVG export draws them. ERC: bus labels count as attached, wires on entries are not dangling, and
    `netNotBusMember` warns about a wire on an entry that is not a member (KiCad's `net_not_bus_member`).
    KiCad import and export of `bus` and `bus_entry`. Tools `add_bus` (name, corners, kind, optional pins
    labelled with the members in order) and `add_bus_entry`.
  - Tests: `packages/tools/test/schematic-s15.test.ts` (names, hierarchy by position, global bus, ERC,
    KiCad round trip; with KiCad installed, kicad-cli's netlist of our export equals ours). Probe: eight
    hand-written KiCad schematics with buses (one sheet, hierarchy with the same and another name, a
    wider parent bus, groups with and without a prefix, global bus labels, a sub-sheet without one),
    imported here: our nets equal kicad-cli's in all eight. Browser check: a bus drawn with two clicks,
    two entries with E, on the grid, undoable.
  - Bus wires and bus labels such as `DATA[0..7]`, with bus entries; the netlist connects the members.
- [ ] **S17. Configurable ERC.**
  - A pin-type matrix that can be changed per project, and the ability to waive a specific violation
    with a recorded reason (shown in Review and kept in the project).
- [ ] **S18. PCB → schematic back-annotation.**
  - Pin swaps and gate swaps made on the board (within groups allowed by the part) are written back to
    the schematic; reference changes on the board are reflected too.

**M3 done when:** every item above is checked; release `v0.1.0`.

## 4. Out of scope

- PCB layout editor improvements (box selection on the board, rubber-banding traces, push-and-shove,
  autorouter rip-up and retry) — a separate agreement.
- SPICE simulation, firmware, enclosure / mechanical work.
- Import from or export to Altium, Eagle, EasyEDA, OrCAD.
- Accounts and login.

## 5. Working rules (binding for the implementer)

1. **Clean room:** no code, assets, UI text or branding from KiCad, Flux or other products. File formats
   are implemented from public documentation and example files only. *Exception:* published component
   libraries (symbols, footprints, 3D models) may be read or downloaded at run time as data, under their
   own licenses. They are never copied into this repository, and their source and license are shown to
   the user. Code under a copyleft license (such as KiCad's GPL) is only used, if ever, as a separate
   program with its own license, never inside the MIT / Apache code.
2. Third-party libraries must be permissively licensed (MIT, BSD, Apache, BSL).
3. Repository content (code, comments, docs, commit messages) is in English.
4. Every change goes through the command layer, so it is undoable and works for collaborators and agents.
5. New editor actions that make sense for agents are also exposed as tools (CLI, MCP, built-in agent).
6. No regressions: all existing tests keep passing, and the real-project checks still hold (the solar MPPT
   project's netlist matches KiCad's `netlist.xml` 100 %, ERC 0).
7. Work happens in the order of this document unless the owner approves a different order.
8. The implementer reports honestly: what passed, what was not verified, and what is left.

## 6. Verification

| Kind | Used for |
|---|---|
| Automated tests (Vitest) | Netlist identity after edits, junction rules, annotation, exports, round trips |
| Browser check | Every interactive item (S1–S5, S8–S12, S16), with screenshots attached to the milestone notes |
| Agent re-run | S7, S8: the RGB sleep lamp prompt from v0.0.1, results compared before / after |
| KiCad check | S13, S14: opening the exported files in the KiCad installed on the owner's machine |

## 7. Definition of done (per milestone)

- Every item of the milestone checked in this document, with its acceptance criteria met.
- `pnpm typecheck` clean, `pnpm test` passing, `pnpm build` succeeding.
- `docs/02-roadmap.md` and the README updated; a short demo (screenshots or video) added.
- A tagged release with notes listing what changed and what is still limited.

## 8. Progress tracking

The checkboxes in [section 3](#3-scope) are the status. The implementer ticks an item in the same commit
that completes it, and adds the commit id after the item name. Optional: mirrored as a GitHub milestone with
one issue per item, if the owner asks for it.

## 9. Change process

- Adding, removing or changing an item needs the owner's approval in writing (chat or commit).
- Every approved change is recorded below, with the date and a short reason, and the document version
  goes up (0.2, 0.3 …).

### Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1 | 2026-11-11 | First draft | — |
| 0.1 | 2026-11-11 | Approved as written | Owner (widjis), in chat: "Setuju, tanda tangani" |
| 0.2 | 2026-11-11 | Added S19 footprint generator (with a KiCad reference check in tests), S20 pin ↔ pad check and S21 KiCad libraries on demand to M2; moved S16 symbol editor from M3 to M2 and extended it; exception for component libraries and copyleft code added to working rule 1. Reason: parts missing from every library were the weakest link for real boards. | Owner (widjis), in chat: "oke setuju v0.2 semua, tambahkan catatannya" |
| 0.3 | 2026-11-11 | S8 extended with jog removal (`tidy_wires`) and non-overlapping texts, each with a check on the RGB sleep lamp re-run. Reason: the S7 re-run showed wires that jog because connected pins were placed slightly off one line, and texts that overlap. | Owner (widjis), in chat: "Yes, add to v0.3" |
| 0.4 | 2026-11-11 | S8 extended with a configurable schematic grid (pin grid 1.27 / 2.54 / 5.08 mm, wire grid), as a project setting with a toolbar picker and a tool. Reason: the owner asked whether the grid can be changed. | Owner (widjis), in chat: "oke masukkan ke S8 sebagai v0.4" |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | widjis | 2026-11-11 | 0.1 |
| Owner | widjis | 2026-11-11 | 0.2 |
| Owner | widjis | 2026-11-11 | 0.3 |
| Owner | widjis | 2026-11-11 | 0.4 |

Approval was given by the owner in the working chat ("Setuju, tanda tangani" — "Agreed, sign it" for
0.1; "oke setuju v0.2 semua, tambahkan catatannya" — "OK, agree to all of v0.2, add the notes" for 0.2; "Yes, add to v0.3" for 0.3; "oke masukkan ke S8 sebagai v0.4" for 0.4)
and recorded here by the implementer.
