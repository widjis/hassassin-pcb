# Work agreement: schematic improvements

| | |
|---|---|
| Document | `docs/04-schematic-improvements.md` |
| Version | 0.1 |
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

- [x] **S1. Wires follow moved symbols.** — done
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
- [ ] **S2. Box selection.**
  - Dragging on an empty part of the sheet draws a selection box; objects inside it are selected
    (left-to-right = fully inside, right-to-left = touching, a common convention, or one documented rule).
  - Panning, which uses that drag today, moves to the middle mouse button, Space + drag, and trackpad
    two-finger scroll; the keyboard hints on screen are updated.
  - Shift adds to the selection; the selection can then be moved, rotated, mirrored or deleted as one step.
- [ ] **S3. Copy, paste and duplicate.**
  - Cmd/Ctrl+C, Cmd/Ctrl+V and Cmd/Ctrl+D work on symbols, wires, labels, power symbols and junctions.
  - Pasted parts get the next free references (R7 → R8 …); connections inside the copied group are kept;
    labels keep their names, so pasted global labels join the same nets.
  - Paste follows the mouse until clicked, then is one undo step.
- [ ] **S4. Wire editing and junctions.**
  - A wire segment can be dragged; its neighbours stretch to stay connected.
  - A wire can start or end on the middle of another wire, which connects them.
  - A junction dot is added automatically wherever three or more wire ends / pins meet, and removed when
    it is no longer needed; crossing wires without a junction stay unconnected (and the netlist agrees).
  - Tools (`connect_pins`, `add_power`) create junctions the same way.
- [ ] **S5. Edit values and properties in place.**
  - Double-clicking a reference or value on the sheet edits it in place; Enter saves, Esc cancels.
  - The inspector shows and edits the part's properties (value, MPN, manufacturer, footprint, datasheet,
    DNP) for schematic symbols; changes reach the board on Update PCB as today.
- [ ] **S6. Annotation (renumbering references).**
  - A command renumbers references per prefix, ordered by sheet then position (top-to-bottom,
    left-to-right), with options: whole design or one sheet, keep existing numbers or reset.
  - The board's components are renamed to match, and routed copper keeps its nets.
  - Available as a tool (`annotate`) for agents too.

**M1 done when:** every item above is checked; release `v0.0.2`.

### Milestone M2 — tidy, shareable schematics

- [ ] **S7. Wires that avoid symbols and pins.**
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
- [ ] **S16. Symbol editor.**
  - Create or edit a symbol: body, pins (number, name, type, side), from a pin table that can be pasted
    (for example from a datasheet); the result is stored with the project and can be published to the
    team library.
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
   are implemented from public documentation and example files only.
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

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | widjis | 2026-11-11 | 0.1 |

Approval was given by the owner in the working chat ("Setuju, tanda tangani" — "Agreed, sign it") and
recorded here by the implementer.
