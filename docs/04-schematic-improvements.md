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
- [ ] **S8. Compact, aligned layout of blocks.**
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
- [ ] **S9. Sheet frame, title block, notes and group boxes.**
  - Each sheet can have a frame with a title block (title, revision, date, author, sheet number), filled
    from project data where possible.
  - Free text notes and rectangles for grouping blocks ("Power", "MCU", "Sensors"), also available as tools.
- [ ] **S10. PDF and SVG export of the schematic.**
  - Export of one sheet or all sheets, vector output, readable when printed on A4 / A3, light background
    option.
- [ ] **S11. Create hierarchical sub-sheets in the editor.**
  - Create a sub-sheet block, enter it, add hierarchical labels; matching sheet pins appear on the block.
  - Netlist and ERC behave as for imported KiCad hierarchies (existing tests keep passing).
- [ ] **S12. Switch units of multi-unit symbols.**
  - A placed unit can be changed (A, B, power unit …); placing one unit offers the remaining units.
  - ERC reports units that were never placed when their pins matter (for example the power unit).

- [ ] **S16. Symbol editor** (moved from M3 in version 0.2).
  - Create or edit a symbol: body, pins (number, name, type, side), from a pin table that can be pasted
    (for example from a datasheet); the result is stored with the project and can be published to the
    team library.
  - Pin side and order can be set when pasting a pin table; pins can be split into units (for example
    A, B and a power unit); `add_part` gets the same pin-side option for agents.
- [ ] **S19. Footprint generator.**
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
- [ ] **S20. Pin ↔ pad check.**
  - ERC (and Update PCB) reports symbol pins with no matching footprint pad, pads with no pin (unless
    marked mechanical / no-connect), and pin counts that differ.
  - The agent runs it after `assign_footprint`; Review lists the findings.
- [ ] **S21. Official KiCad libraries on demand.**
  - Without KiCad installed, the app can download the official symbol and footprint libraries from
    KiCad's public repository into a local cache, after the user agrees.
  - They are never stored in this repository. The UI shows where each part came from and its license
    (CC BY-SA 4.0 with KiCad's exception for designs that use the libraries).

**M2 done when:** every item above is checked; release `v0.0.3`.

### Milestone M3 — compatibility and advanced features

- [ ] **S13. KiCad netlist export (`.net`).**
  - The exported netlist opens in KiCad's PCB editor ("Update PCB from netlist" / import netlist) for a
    test project, with every component and net present.
- [ ] **S14. `.kicad_sch` export.**
  - A schematic made in Hassassin opens in KiCad 9/10 with the same symbols, wires, labels and power
    symbols; KiCad's ERC on it matches ours for the test projects.
  - Round trip: import → export → import gives the same netlist.
- [ ] **S15. Buses.**
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
