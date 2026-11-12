# Work agreement: PCB layout improvements

| | |
|---|---|
| Document | `docs/05-pcb-improvements.md` |
| Version | 0.2 |
| Status | **Approved on 2026-11-12 — in progress** |
| Owner | Repository owner (widjis) |
| Implementer | AI coding agent working in this repository |
| Based on | Hassassin PCB 0.0.3 (tag `v0.0.3`) |

This document is the proposed scope of the PCB layout work on Hassassin PCB, the "separate agreement"
named in section 4 of [04-schematic-improvements.md](04-schematic-improvements.md). Once approved
(see [Approval](#approval)), the implementer works through it in order, and changes to the scope only
happen through the [change process](#change-process). It runs next to the schematic agreement; neither
blocks the other, and both keep the same working rules.

## 1. Goal

Make the layout editor pleasant to use by hand, make the automatic tools (placement and routing) finish
real boards cleanly, and make the output trustworthy for a fabricator.

## 2. Background

- **What exists in v0.0.3 (layout):** select, move (grid snap, Alt = free) and rotate parts, vias and
  traces; interactive 45° routing (V = via, / = corner style, L = layer); ratsnest; pours with thermal
  reliefs (`pourLayers`, B = refill); DRC (shorts, clearance, board edge, outside board, trace width, hole
  size, unrouted, part outside board); autoplacer; grid autorouter; stackup and impedance; lengths,
  differential-pair skew and serpentines; 3D view; Gerber / Excellon / BOM / pick-and-place export;
  board outline tools for agents.
- **Known limits found in the code and in `docs/02-roadmap.md`:**
  - Dragging on an empty part of the board pans; there is no box selection, no copy / paste and no
    duplicate on the board (the schematic got these in S2 / S3).
  - Moving or rotating a part leaves its traces behind (no rubber-banding); traces must be fixed by hand.
  - The interactive router does not look at other copper: it lays segments through other nets' pads and
    traces, and DRC reports them afterwards. No walk-around, no push-and-shove, no segment drag.
  - Parts cannot be flipped to the bottom side in the editor (`F` only flips the view).
  - There are no drawing tools for the board outline, pour / zone outlines, keep-out areas, silkscreen
    text and lines, or mounting holes; the outline is set through the `set_board_outline` tool only.
  - No layout grid picker (the grid is the `gridSpacing` rule, default 0.5 mm), no measure tool, no
    align / distribute for parts, no locking of parts or traces.
  - **Autorouter** (`core/autoroute.ts`): no rip-up and retry; connections are routed shortest first,
    each to one fixed end point, never to the net's existing copper; one clearance zone (the widest trace
    plus the largest clearance of all routed nets) is used for every net, which closes gaps between
    fine-pitch pads; end points are rounded to the grid; traces keep the grid's stair steps; no layer
    direction preference and no cost for running close to other nets; the result is not checked with
    DRC. Phase 7 figure: solar MPPT board, signal nets ripped up and re-routed → 41 / 60 connections.
  - **Autoplacer:** greedy, does not use schematic blocks, does not put decoupling capacitors next to
    their IC pins, does not try rotations to shorten the ratsnest.
  - **DRC gaps:** no courtyard overlap, silkscreen over pads, annular ring, hole-to-hole distance,
    dangling traces / vias or keep-out area checks; violations cannot be waived.
  - **Output gaps:** silkscreen text is not in the Gerbers (no vector font); Gerbers were never checked
    in a third-party viewer; no pour priority (pours of two nets on one layer do not yield to each other);
    no teardrops; no `.kicad_pcb` export; DRC runs on the main thread.

## 3. Scope

Three milestones. Order approved by the owner: PM2 first, then PM1, then PM3. Each item has acceptance
criteria that can be checked; an item is done only when all of its criteria pass.

**Benchmark boards** (used for every measured item, always on copies, never on the `.data` projects in
place): the RGB sleep lamp (`.data/projects/c24cea4229c94047`) and the solar MPPT board
(`.data/projects/88c56ff7f07d47a1`). Baseline figures are measured on v0.0.3 and recorded in this
document before work on a measured item starts.

### Milestone PM1 — layout editor comfortable for manual work

- [ ] **P1. Box selection and panning on the board.**
  - Dragging on an empty part of the board draws a selection box: left-to-right selects items fully
    inside, right-to-left also items it touches (the same rule as the schematic, S2); Shift adds.
  - Panning moves to the middle mouse button, Space + drag and trackpad two-finger scroll, as in the
    schematic; on-screen hints are updated.
  - A layer filter decides what the box picks (parts, traces, vias, pours, graphics; active layer only
    or all layers).
  - A selection moves, rotates and deletes as one undo step.
- [ ] **P2. Rubber-banding: traces follow moved parts.**
  - Moving or rotating a part (or a group) keeps every trace that ends on one of its pads attached: the
    end moves with the pad and the last segments are adjusted, keeping 45° angles where possible.
  - Vias and traces inside the selection move with it unchanged.
  - Connectivity before and after is identical (automated test); a move that would create a short is
    shown in red while dragging and DRC reports it if dropped.
  - Available to agents through `move_part` (traces follow by default, `keep_traces: false` to leave them).
- [ ] **P3. Copy, paste and duplicate on the board.**
  - Cmd/Ctrl+C / V / D on parts, traces, vias, graphics and pours; traces and vias are copied only when
    both their ends are inside the copy (or with an option, all of them).
  - Pasted parts are matched to existing schematic parts that are not on the board yet, or get new
    references; the paste follows the mouse and is one undo step.
  - *Layout replication:* the placement and routing of one block (for example one channel) can be
    applied to another block made of the same schematic parts.
- [ ] **P4. Interactive router that respects clearance.**
  - While routing, the preview never passes through other nets' copper or their clearance: it walks
    around obstacles (or stops at the last legal point, shown in red), using the net's width and
    clearance rules.
  - Clicking a pad or trace of the same net finishes the route; a route ending on the wrong net is refused.
  - A trace segment can be dragged sideways; its neighbours stretch and keep 45° angles; the drag stops
    at other copper.
  - Width and via size can be switched while routing (from the net's rules or a list of presets).
- [ ] **P5. Bottom side, locking and grid.**
  - A selected part can be flipped to the other side (key and inspector): pads, silkscreen, courtyard and
    fabrication layers are mirrored to the bottom; the 3D view, Gerbers and pick-and-place follow.
  - Parts, traces and vias can be locked; locked items are not moved by dragging, the autoplacer or the
    autorouter's rip-up.
  - A layout grid picker in the toolbar (for example 0.05 / 0.1 / 0.25 / 0.5 / 1.27 mm and inch steps),
    saved in the project and reported by `project_status`, plus a `set_layout_grid` tool.
  - Align and distribute for a selection of parts (as S8 for the schematic).
- [ ] **P6. Drawing tools for board, pours, keep-outs and graphics.**
  - Draw and edit the board outline in the editor (rectangle, polygon, arcs, rounded corners; vertex drag).
  - Draw a pour / zone outline for a net and a layer; a pour priority decides which pour yields where
    two pours of different nets overlap on one layer.
  - Keep-out areas per layer: no traces, no vias, no pours and / or no parts; the autorouter, autoplacer,
    pour fill and DRC all respect them.
  - Silkscreen text and lines, mounting holes (plated or not) and fiducials can be placed.
  - Tools for agents: `add_pour`, `add_keepout`, `add_text`, `add_mounting_hole` (names may change).
- [ ] **P7. Measure tool.**
  - A measure tool shows distance and Δx / Δy between two points, snapping to pad centres, pad edges and
    trace centres; a clearance readout between two selected objects.

**PM1 done when:** every item above is checked.

### Milestone PM2 — automatic placement and routing that finish real boards

- [ ] **P8. Autorouter: rip-up and retry, and cleaner traces.**
  - Rip-up and retry (negotiated congestion or a similar method written from scratch): connections that
    fail are retried after ripping up the routes in their way, for a bounded number of rounds.
  - A connection may end on any copper of its net already on the board (pads, traces, vias), not only on
    its ratsnest end point.
  - Clearance zones are computed per net (each net's own width and clearance), so small nets fit between
    fine-pitch pads.
  - Off-grid pads are entered with a short exact segment; finished routes are smoothed (stair steps
    merged into straight and 45° runs, no needless bends), and checked against the obstacles again.
  - Cost tuning: a preferred direction per layer, a cost for running next to other nets, a via cost from
    the net's rules; net order by difficulty (fine-pitch and long nets first).
  - Every routed result is checked with DRC; a route that causes an error is removed and reported as
    unrouted, never left behind.
  - Locked traces (P5) and keep-out areas (P6) are respected; the `autoroute` tool, CLI and Board panel
    report the same figures (routed / unrouted, vias, length, time).
  - **Acceptance on the benchmark boards** (signal nets ripped up, power nets left as poured):
    | Board | Metric | Baseline (v0.0.3) | Target |
    |---|---|---|---|
    | Solar MPPT | Connections routed | to be measured (Phase 7: 41 / 60) | ≥ 95 % |
    | RGB sleep lamp | Connections routed | to be measured | 100 % |
    | Both | DRC errors after refill | to be measured | 0 |
    | Both | Vias, total length | to be measured | not worse than baseline for the same nets routed |
    | Both | Run time | to be measured | ≤ 30 s each |
- [ ] **P9. Push-and-shove.**
  - While routing or dragging a trace (P4), traces and vias of other nets in the way are pushed aside
    when there is room, keeping their clearance and connections; when they cannot move, the route stops
    at the last legal point.
  - Locked items are never pushed. One undo step restores everything that moved.
- [ ] **P10. Differential pairs and length tuning.**
  - Pairs found by name (as today) are routed together by hand and by the autorouter with the pair's
    width and gap; the pair's skew is shown while routing.
  - Serpentines with 45° or arc corners on any segment, staying inside the clearance; target length or
    length group (as today).
- [ ] **P11. Autoplacer that uses the schematic.**
  - Parts of a schematic block (sheet or group box) are placed together; decoupling capacitors are placed
    next to the IC power pins they share a net with; rotations are tried to shorten the ratsnest;
    connectors marked "edge" are placed at the board edge; locked parts stay.
  - On the benchmark boards (parts cleared from the board, then autoplaced): total ratsnest length at
    least 20 % shorter than with the v0.0.3 autoplacer, courtyards not overlapping, and P8's router
    reaching its targets on the result.

**PM2 done when:** every item above is checked.

### Milestone PM3 — manufacturing confidence

- [ ] **P12. More DRC checks and waivers.**
  - New checks: courtyard overlap, silkscreen over pads / exposed copper, annular ring minimum,
    hole-to-hole distance, dangling traces and unused vias (warnings), keep-out areas (P6).
  - Every limit comes from editable rules, as today; a violation can be waived with a recorded reason
    (shown in Review and kept in the project).
  - DRC runs in a Web Worker in the editor, so the canvas stays responsive.
  - The solar MPPT board (KiCad-clean) still gives 0 errors; each new check has a test board that fails it.
- [ ] **P13. Silkscreen text in the Gerbers and a third-party check.**
  - Reference and free texts are drawn with a vector stroke font written from scratch (or a permissively
    licensed one) and exported to the silkscreen Gerbers.
  - The Gerbers of both benchmark boards open in a third-party Gerber viewer installed on the owner's
    machine (for example `gerbv` or KiCad's Gerber viewer) with every layer aligned; screenshots attached.
- [ ] **P14. Teardrops and via stitching.**
  - Optional teardrops on pad and via entries (rule per net class), filled as copper and checked by DRC.
  - Via stitching for a pour (grid pitch, edge distance), avoiding other copper and keep-out areas.
- [ ] **P15. `.kicad_pcb` export.**
  - A board made in Hassassin opens in KiCad 9 / 10 with the same parts, footprints, traces, vias, pours
    and outline; KiCad's DRC on it agrees with ours for the benchmark boards (differences listed and
    explained). Written from the public file format documentation only.

**PM3 done when:** every item above is checked.

## 4. Out of scope

- Schematic work (covered by [04-schematic-improvements.md](04-schematic-improvements.md); S18
  back-annotation stays there).
- Blind / buried and micro vias, HDI stackups, per-area (rigid-flex) stackups.
- Signal and power integrity simulation, thermal simulation.
- Manufacturer STEP models and STEP export (the 3D view keeps its courtyard boxes).
- Panelization, ODB++ / IPC-2581 export.
- Import from or export to Altium, Eagle, EasyEDA, OrCAD.

## 5. Working rules (binding for the implementer)

The working rules of [04-schematic-improvements.md](04-schematic-improvements.md) section 5 apply
unchanged (clean room, permissive dependencies, English in the repository, every change through the
command layer, editor actions also as tools, no regressions, order of this document, honest reports),
plus:

1. **No regressions on real boards:** the solar MPPT board keeps 0 DRC errors, its drill files still match
   `kicad-cli` and its netlist still matches KiCad's; the RGB sleep lamp board keeps 0 DRC errors.
2. **Benchmark copies only:** measurements run on copies of the `.data` projects in a scratch folder.
3. **Algorithms written from scratch:** routing, shoving and placement methods are taken from published
   papers and textbooks only, never from the source of another PCB tool.

## 6. Verification

| Kind | Used for |
|---|---|
| Automated tests (Vitest) | Connectivity identity after moves (P2, P3, P9), router results and DRC on fixed boards (P4, P8–P11), new DRC checks (P12), file output (P13, P15) |
| Browser check | Every interactive item (P1–P7, P9, P10), with screenshots attached to the milestone notes |
| Benchmark run | P8, P11: the two benchmark boards, before / after table in this document |
| Third-party check | P13: Gerber viewer; P15: KiCad installed on the owner's machine |

## 7. Definition of done (per milestone)

- Every item of the milestone checked in this document, with its acceptance criteria met.
- `pnpm typecheck` clean, `pnpm test` passing, `pnpm build` succeeding.
- `docs/02-roadmap.md` and the README updated; a short demo (screenshots or video) added.
- A tagged release with notes listing what changed and what is still limited.

## 8. Progress tracking

The checkboxes in [section 3](#3-scope) are the status. The implementer ticks an item in the same commit
that completes it, and adds the commit id after the item name.

## 9. Change process

- Adding, removing or changing an item needs the owner's approval in writing (chat or commit).
- Every approved change is recorded below, with the date and a short reason, and the document version
  goes up (0.2, 0.3 …).

### Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1 | 2026-11-12 | First draft | — |
| 0.2 | 2026-11-12 | Approved as written, with milestone PM2 (automatic placement and routing) done before PM1. Reason: the autorouter was the first request and does not touch files of the schematic work running at the same time. | Owner (widjis), in chat: "Setuju, PM2 dulu" |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | widjis | 2026-11-12 | 0.2 |

Approval was given by the owner in the working chat ("Setuju, PM2 dulu" — "Agreed, PM2 first")
and recorded here by the implementer.
