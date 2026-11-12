# Work agreement: PCB layout improvements

| | |
|---|---|
| Document | `docs/05-pcb-improvements.md` |
| Version | 0.3 |
| Status | **Approved on 2026-11-12 (0.3) — in progress** |
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
  - *Moved here from PM2 in 0.3:* shoving other nets aside while routing or dragging a trace, using the
    P9 shove engine; routing a differential pair together by hand with its skew shown while routing,
    using the P10 pair routing.
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

*Detailed in version 0.3 after a study of `core/autoroute.ts`, `core/autoplace.ts`, `core/lengths.ts` and
`apps/web/src/ui/board.ts` at v0.0.3; see [PM2 study notes](#pm2-study-notes) for what was found.*

**Order inside PM2:** P8a → P8b → P8c → P8d → P8e → P16 → P8f → P8g → P9 → P10 → P11 (P16 comes before
P8f because the router's costs per net come from the signal classes). Each sub-item is its own
commit (or small series) with its own tests, and the benchmark table is updated after every sub-item that
can change the figures, so a regression is seen at the step that caused it.

**Dependencies on PM1 (the milestone order was swapped in 0.2):** PM2 items use only data that exists
today. Locking uses the existing `locked` property (already honoured by the autoplacer) on parts, traces
and vias, with no UI; the lock UI stays in P5. Keep-out areas do not exist yet: the router and placer get
a hook for them, and the acceptance check that they are respected moves to P6. The interactive parts of
P9 and P10 (shoving and pair routing while routing by hand) move to PM1 next to P4, which they need.

- [ ] **P8a. Benchmark and test harness.**
  - `apps/cli/bench/autoroute.ts` reads a project folder (snapshot plus `log.jsonl`) as well as a single
    `.hpcb`, so the figures are for the board as it is, not as of the last snapshot; it records the reason
    of every failure, including `time limit`.
  - Baselines for both benchmark boards measured on v0.0.3 on the owner's machine and written into the
    table below before P8b starts.
  - Small synthetic boards committed as test fixtures (a 0.4 mm QFN fan-out, a narrow channel with more
    nets than tracks on one layer, a two-layer crossing that needs a via, an off-grid connector), with
    Vitest checks for routed count and 0 DRC errors. These run in `pnpm test`; the benchmark boards do not
    (they are not in the repository).
  - The stated time limit and the code agree (today the comment says 20 s, the code uses 30 s).
  - *Progress:* harness, fixtures and log replay done (`packages/tools/src/routeBench.ts`,
    `packages/tools/test/autoroute-fixtures.test.ts`, `apps/cli/bench/autoroute.ts --fixtures`); known gaps
    are recorded as `it.fails` tests that flip when an item fixes them. Still open: the baselines of the
    two benchmark boards (their `.data` folders are not on the implementer's machine yet). Fixture
    baselines on v0.0.3:
    | Fixture | Routed | Vias | Length | Sharp corners (≥ 90°) | Bends / connection | Failure reason |
    |---|---|---|---|---|---|---|
    | qfn-escape (0.5 mm QFN-24 + 0.5 mm supply net) | 0 / 8 | 0 | 0 mm | 0 | 0 | no free path × 8 |
    | reversed-bus (2 × 8-pin header, reversed) | 8 / 8 | 2 | 211.6 mm | 6 | 5.25 | — |
    | off-grid (4 resistors off grid, one at 45°) | 4 / 4 | 0 | 48.5 mm | 6 | 3 | — |

    On qfn-escape, routing only the signal nets gives 2 / 6, and all nets at 0.2 mm give 4 / 8: the shared
    clearance zone is the main blocker (P8b), the rest is pin escape (P8c, P8f).
- [x] **P8b. Per-net clearance (clearance field).**
  - The obstacle grid stores, per layer and cell, the distance to the nearest copper and the nearest copper
    of a *different* net than that one (a two-label distance transform, computed once and updated when a
    route is added or removed), plus that copper's own clearance.
  - A cell is usable for net *n* with width *w* when the distance to the nearest foreign copper is at least
    *w*/2 + max(clearance of *n*, clearance of the foreign copper). The single shared halo (widest trace
    plus largest clearance of all routed nets) is removed.
  - Via legality uses the same field with the via radius. The existing neck-down on narrow pads stays.
  - Test: two signal nets of 0.15 mm leave a 0.4 mm QFN between pads even when a 0.5 mm power net is
    routed on the same board (fails on v0.0.3).
  - *Done:* fixture `qfn-fine` (0.4 mm QFN-24, 0.15 mm signals and clearances, 0.5 mm supply): v0.0.3
    4 / 8 → 8 / 8, 0 DRC errors. `qfn-escape` (0.5 mm QFN, default rules): 0 / 8 → 4 / 8; the other 4
    route with a 0.05 mm grid, so what is left there is grid alignment at the pads (P8c). Pads narrower
    than the trace now get a neck-down zone (the pad grown by half the width plus the clearance) that
    the search checks at the neck width; segments touching it are emitted at that width. Run time on
    `reversed-bus` went from 1.7 s to 2.4 s (the distance field is heavier than the old halo); P8d / P8g
    look at speed again. The benchmark boards are still to be measured.
- [x] **P8c. Route per net, to any copper of the net.**
  - A net is routed as a set of connected copper groups (pads, traces, vias already on the board): the
    search starts from every cell of one group and ends on any cell of another, until the net is one group.
    This replaces routing each ratsnest line to its fixed end point.
  - Off-grid pads are entered with a short exact segment from the nearest legal grid cell; the entry is
    checked against the real geometry.
  - *Done:* a connection starts from every cell of the copper group at one end (flooded on the grid and
    checked against the real copper with the connectivity rules) and ends on any cell of the group at
    the other end; connections already joined by copper laid earlier in the run are counted as routed.
    Pad entries are exact 0° / 45° / 90° runs out of the pad with at most one 45° or straight jog onto the
    grid, each piece checked against the real copper. Fixtures: `qfn-escape` 4 / 8 → 8 / 8; `off-grid`
    off-angle stubs 6 → 0 (a new test keeps every autorouted segment on the 45° directions); new `tee`
    fixture, the third pad joins the routed trace beside it: 17.8 mm → 6.8 mm. The cell tests are memoised
    per connection (`reversed-bus` 3.2 s → 1.9 s). Note: the collaboration test "keeps two editors in step
    under concurrent edits" (`apps/server/test/sync.test.ts`, a fixed 10 s window) fails now and then when
    the whole suite runs, more often with the added routing tests; it passes on its own. Outside the PM2
    files, so left for the owner.
- [ ] **P8d. Rip-up and retry by negotiated congestion.**
  - Method: negotiated congestion routing as published by McMurchie and Ebeling (PathFinder, 1995),
    written from the paper. All nets are routed with cells allowed to be shared; shared cells get a present
    cost that rises each round and a history cost that accumulates; nets are ripped up and re-routed until
    no cell is shared or the round limit (default 30) or time limit is reached.
  - Nets that still share cells after the last round are ripped up one by one (least important first)
    until the result is legal; they are reported as unrouted with the reason `congestion`.
  - Locked traces and vias are fixed obstacles and are never ripped up.
  - The time limit stops between rounds and keeps the best legal result found so far.
- [ ] **P8e. Clean traces and soft corners (human-like routing).**
  - *Owner's finding (2026-11-12):* routed traces still bend sharply. Every change of direction must be
    soft: no 90° corners and no acute corners. Today the search may turn by 45°, 90° or 135° at one cell
    for the same small cost (0.1), so right-angle and acute corners come out of it.
  - The search keeps the direction it came from as part of its state and may turn by at most 45° at a
    vertex; a change of 90° is two 45° turns with a straight piece between them of at least the corner
    setback; acute turns are impossible. The cost of a turn grows with its angle.
  - Finished paths are smoothed by string-pulling against the clearance field, restricted to 0° / 45° /
    90° directions (octilinear): grid stair steps become straight and 45° runs, needless bends are
    removed, and every new segment is checked against the obstacles before it replaces the old ones.
  - A final corner pass: any remaining 90° corner is chamfered with a 45° piece, or rounded with an arc,
    following two new rules, `cornerStyle` (`45` default, `arc`) and `cornerSetback` (default: 2 × trace
    width), settable per net or net class (P16). If the chamfer or arc would break clearance, the corner
    is re-routed; if that fails, the connection is reported, never left with a right angle.
  - Pad entry as a person would draw it: the trace leaves a pad along the pad's long axis (or straight
    out of a fine-pitch row) for at least the setback before it turns, and never meets a pad edge at an
    acute angle.
  - Acceptance: on the benchmark boards and fixtures, autorouted copper has 0 corners of 90° or sharper
    (checked by a test over every pair of joined segments), no two consecutive segments of one trace are
    collinear, and the number of bends per routed connection is lower than at P8d.
  - Method sources: direction-aware A* and octilinear (45°) routing as described in the published
    gridless and shape-based routing literature (e.g. Schiele et al., "A gridless router for industrial
    design rules", DAC 1990). Fully topological "rubber-band" routing (Dayan, UCSC thesis 1997; the SURF
    system by Staepelaere, Jue, Dayan and Dai), which gives the most hand-drawn look, is a rewrite of the
    router and stays out of PM2; it is noted for a later agreement.
- [ ] **P16. Signal classes from pins (pin metadata that drives the layout rules).**
  - *Owner's request (2026-11-12):* a part should carry, per pin, what that pin needs (for example high
    frequency, so the high-frequency routing rules apply; a signal, so the signal rules apply), and the
    layout should follow it.
  - Today: pins carry `pinType` (the electrical type used by ERC) and nets get a `netClass` of `power` or
    `ground` guessed from the net name only; the default rules have one entry for each of those classes.
  - New pin property `signal` (on schematic pins and footprint pads), one of: `power`, `ground`,
    `high-current`, `high-voltage`, `switching` (noisy node such as a converter's SW / LX pin),
    `high-speed`, `diff-pair`, `clock`, `rf`, `analog`, `sensitive` (feedback, crystal, reference),
    `general` (default). Optional parameters: frequency or rise time, target impedance, current (A),
    voltage (V), pair partner, length group, and an interface preset (`usb2`, `ethernet`, `lvds`, …)
    that fills impedance and skew limits for P10.
  - Where it comes from, in this order: set by hand or by an agent (new tool `set_pin_signal`, also for a
    whole part); written in a symbol or footprint made by the symbol editor or footprint generator from a
    datasheet; otherwise guessed from pin and net names (`USB_D+/-`, `*_P/_N`, `CLK`, `XTAL`, `RF`, `ANT`,
    `SW`, `LX`, `FB`, `VREF` …) and from the part (crystal, inductor of a converter). Guesses are shown as
    guesses and can be overruled.
  - A net gets the strictest class of its pins (with the parameters), computed by a new core module, not
    stored by the netlist sync, so the schematic work's files are not changed. The net's class is shown in
    the Board panel and in `net_lengths` / `project_status`, and can be set by hand on the net.
  - Default rules per class, written as ordinary rules with selectors (`net[signal=rf]` …), so the owner can
    change them: for example `high-speed` / `rf` → width from the stackup for the target impedance (the
    impedance calculator exists), few or no vias, `cornerStyle: arc` for `rf`; `high-current` → width from
    the current (IPC-2221 estimate); `high-voltage` → clearance from the voltage (IPC-2221 table);
    `switching` → short and wide, kept away from `analog` / `sensitive` nets; `clock` / `diff-pair` →
    length matching (P10); `high-speed`, `rf`, `clock` → spacing to other nets of about 3 × the height to
    the reference plane, kept over a solid plane and on one layer per interface where possible.
  - The autorouter (P8f), the autoplacer (P11: e.g. crystals next to their IC, switching loops tight) and
    DRC (PM3) read these rules; nothing in this item routes by itself.
  - Acceptance: on the benchmark boards every net has a class (by hand, from parts or guessed) that the
    owner reviews once; a test board with one net of each class gets the expected width, clearance, via
    cost and corner style from the defaults; changing a rule changes what the router does.
  - Editing the `signal` property in the symbol editor and the footprint generator UI waits until the
    schematic agreement's S17 / S18 are merged (those files belong to that work); until then it is set
    with the tool, the inspector of a pad on the board, or the net.
- [ ] **P8f. Layer directions, fanout and cost tuning.**
  - *Owner's reference (2026-11-12): perpendicular (orthogonal) routing* — on a two-layer board the top
    layer runs horizontal and the bottom layer vertical, joined by vias where a net changes direction; on
    more layers the signal layers alternate. New rule `routeDirection` per copper layer (`horizontal`,
    `vertical`, `any`), defaulting to that pattern from the stackup. Moving against a layer's direction
    costs several times more than along it, and is only used for short pieces (pad entries, the 45°
    joints of P8e); a long run against the direction is changed to a via and a run on the other layer.
  - **Fanout first.** For dense parts (BGA, QFN / QFP with fine pitch, connectors with many pins) the
    router first escapes every pin: a short 45° stub (a "dog-bone") from the pad to a via just outside
    the pad row, or a straight run out of the row, all in one regular pattern under or around the part;
    the main routing then starts from those escape points. Vias never sit in or touch a pad (as today).
  - **Reference plane.** A cost for running over a gap in the pour or plane on the neighbouring layer
    (a split), and a stronger one for `high-speed`, `rf` and `diff-pair` nets (P16), so their return
    current has a solid path; nets of one interface keep to one layer where they can.
  - A cost for running next to other nets' copper (stronger for long parallel runs), a via cost from the
    net's rules.
  - Net order by difficulty: nets with fine-pitch pads and long nets first; the existing
    `autoPlacePriority` rule ("placed or routed first", unused today) overrides it.
  - Neighbouring nets that leave one part side by side (a bus, a row of pins) are routed as a bundle
    where possible: a small bonus for running parallel to the previous net of the bundle at its spacing,
    as a person would draw them.
  - The signal classes of P16 set the costs per net: e.g. a high via cost and arc corners for RF, extra
    spacing from switching nodes for analog and sensitive nets, impedance width for high-speed nets.
  - The weights are options of the `autoroute` tool and the CLI, so the owner can try values.
- [ ] **P8g. Verification, reporting and responsiveness.**
  - Every result is checked with DRC on the new copper (plus a pour refill where pours exist); a route that
    causes an error is removed and reported as unrouted, never left behind.
  - The `autoroute` tool, the CLI and the Board panel report the same figures (connections, routed,
    unrouted with reasons, vias, total length, time).
  - In the editor the autorouter runs in a Web Worker with a progress line and a Cancel button, so the
    canvas stays responsive (today it runs on the main thread for up to 30 s). Cancel keeps the board
    unchanged; a finished run is one undo step, as today.
  - **Acceptance on the benchmark boards** (signal nets ripped up, power nets left as poured; measured
    with `apps/cli/bench/autoroute.ts` on copies, on the owner's machine):
    | Board | Metric | Baseline (v0.0.3) | Target |
    |---|---|---|---|
    | Solar MPPT | Connections routed | to be measured (Phase 7: 41 / 60) | ≥ 95 % |
    | RGB sleep lamp | Connections routed | 79 / 108 (73 %) | 100 % |
    | Both | DRC errors after refill | RGB lamp 0, solar to be measured | 0 |
    | Both | Vias, total length | RGB lamp 23 vias, 680 mm (79 connections) | not worse per routed connection |
    | Both | Run time | RGB lamp 31.8 s | ≤ 30 s each |
- [ ] **P9. Shove engine (core).**
  - A core function that, given a new trace or via, moves traces and vias of other nets in its way aside
    (walk-around first, then push), keeping their clearance and connections, and refuses when they cannot
    move. Written from published descriptions of shove routing, not from another tool's source.
  - Locked items are never moved. The result is one list of operations (one undo step).
  - The autorouter uses it before ripping up: a failing connection first tries to shove its neighbours.
  - Tests on fixture boards: connectivity identical before and after, 0 DRC errors.
  - *Moved to PM1 (with P4):* shoving while routing or dragging a trace by hand.
- [ ] **P10. Differential pairs and length tuning (automatic).**
  - Pairs are found by name (as today) or set by the `diff-pair` class with a partner (P16).
  - **Width and gap from the impedance.** The pair's target differential impedance (rule `diffImpedance`,
    from an interface preset or set by hand) gives the width and gap per layer from the stackup with the
    existing calculator; the gap is kept constant along the whole coupled length.
  - **Routed together.** The autorouter routes a pair as one path of width 2·*w* + *gap* and splits it
    into two traces; both traces stay on the same layers, change layer at the same place with a pair of
    vias placed symmetrically (optionally with ground return vias next to them), and turn together with
    45° or arc corners (P8e).
  - **Symmetric breakout.** The two traces leave and enter their pads as mirror images; the uncoupled length
    at each end is kept as short as possible and limited by the rule `diffUncoupledMax`.
  - **Skew in time as well as length.** The allowed intra-pair mismatch (rule `diffSkewMax`, a length or a
    time) is checked as delay: each piece of trace is converted with the propagation delay of its layer,
    computed from the stackup (outer layers are faster than inner ones), so pairs that change layers are
    matched in time, not only in length. The same is used for length groups (buses).
  - **Tuning as a person would.** The shorter trace is tuned, close to where the mismatch arises (usually
    the bend that caused it), with small bumps or a serpentine with 45° or arc corners; amplitude and the
    length of each tuning section are limited by rules, and the edge-to-edge spacing between meander
    segments is at least 3 × the trace width, so the meander does not couple to itself.
  - **Spacing to other nets.** At least 3 × the trace width from other nets and other pairs by default
    (rule `diffPairClearance`), for crosstalk.
  - **Interface presets** (defaults that the owner can change, values from public vendor notes; the
    interface's own specification wins): USB 2.0 — 90 Ω ± 15 %, intra-pair mismatch ≤ 50 mil (1.27 mm);
    Ethernet 100BASE-TX / LVDS / CAN-FD style pairs — 100 Ω; others added as rules.
  - Serpentines for single nets (length groups) also get 45° / arc corners on any segment long enough, not
    only the longest straight one, staying inside the clearance; target length or length group (as today).
  - The Board panel and `net_lengths` show impedance, skew (length and time) and uncoupled length after
    routing; DRC (PM3) reports pairs outside their rules.
  - Acceptance: on a test board with a USB 2.0 pair and a 100 Ω pair crossing to the other layer, both are
    routed coupled at the computed width and gap, with symmetric vias, skew within the preset and no
    corner of 90° or sharper.
  - *Moved to PM1 (with P4):* routing a pair together by hand and showing its skew while routing.
- [ ] **P11. Autoplacer that uses the schematic.**
  - The greedy placement of today stays as the start; an improvement pass follows (simulated annealing or
    pairwise swaps, written from textbook descriptions) that minimises total ratsnest length (half-perimeter
    per net) with penalties for courtyard overlap and leaving the board.
  - Rotations 0 / 90 / 180 / 270° are tried.
  - Parts of a schematic block (sheet or group box) are kept together as a cluster.
  - Decoupling capacitors (a capacitor sharing a power net and ground with one IC) are placed next to that
    IC's power pin and moved as a pair with it.
  - Connectors with the new part property `placeAtEdge` are placed against the board edge, facing out.
  - Locked parts stay (as today); keep-out areas are respected once P6 exists.
  - Acceptance on the benchmark boards (parts cleared from the board, then autoplaced): total ratsnest
    length at least 20 % shorter than with the v0.0.3 autoplacer, courtyards not overlapping, and the P8
    router reaching its targets on the result.

**PM2 done when:** every item above is checked.

#### PM2 study notes

Findings in the v0.0.3 code that the items above answer:

| Finding | Where | Effect | Item |
|---|---|---|---|
| One clearance zone for all nets: widest trace plus largest clearance of all routed nets | `autoroute.ts` (halo) | Small nets cannot pass between fine-pitch pads; "endpoint is blocked" failures | P8b |
| Each ratsnest line routed once to one fixed end point; routes never ripped up | `autoroute.ts` (main loop) | Early routes block later ones; cannot join the net's existing copper | P8c, P8d |
| End points rounded to the grid; only collinear points merged | `autoroute.ts` (walk-back) | Small off-angle stubs at pads; stair-step traces | P8c, P8e |
| Cost is length + 0.1 per bend + fixed via cost 12; order is shortest first | `autoroute.ts` | No layer direction, no spacing from other nets; hard nets routed last | P8f |
| A turn of 45°, 90° or 135° at one cell costs the same 0.1; the search does not know its direction | `autoroute.ts` (A* step) | Right-angle and acute corners in routed traces (owner's finding) | P8e |
| Pins carry only `pinType` (ERC); nets get `power` / `ground` from their name only | `parts.ts`, `sync.ts`, `defaults.ts` | The router treats an RF, clock or switching net like any signal | P16 |
| Layer direction is not a rule; no escape (fanout) stage; plane splits under a trace are not seen | `autoroute.ts` | Traces wander on both layers instead of top horizontal / bottom vertical; dense parts block themselves | P8f |
| Pair skew is length only; no width / gap from impedance; no symmetric vias or breakout | `lengths.ts` | Pairs that change layer are mismatched in time; gap not kept | P10 |
| No DRC on the result before it is applied | `autoroute.ts`, `tools.ts` | Errors are found only by a later `run_drc` | P8g |
| Runs on the main thread from the Board panel | `ui/board.ts` | Editor freezes for up to 30 s | P8g |
| RGB lamp baseline takes 31.8 s with a 30 s limit | benchmark | Some failures may be time-outs, not real dead ends | P8a |
| Benchmark reads `snapshot.hpcb` only | `bench/autoroute.ts`, server store | Changes in `log.jsonl` are not measured | P8a |
| Greedy placement, no rotation, no improvement pass | `autoplace.ts` | Long ratsnest, decoupling far from pins | P11 |
| Pairs routed as two separate nets; serpentine only on the longest straight segment with 90° corners | `lengths.ts` | Pair gap not kept; tuning often impossible | P10 |

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
- Signal and power integrity simulation, thermal simulation; field-solver impedance (the calculator stays
  an estimate).
- Tabbed routing (small copper tabs on DDR traces in the pin field); it needs simulation to size the tabs.
- Fully topological (rubber-band) routing; noted for a later agreement (see P8e).
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
4. **Parallel work with the schematic agreement.** The schematic work (S17, S18) runs at the same time on
   another machine. To keep the two from getting in each other's way:
   - PM2 works on its own branch per item, rebased on `origin/main` before it starts and before it is
     merged; `pnpm typecheck` and `pnpm test` pass on the rebased branch before merging.
   - Files owned by PM2: `packages/core/src/autoroute.ts` (and new modules next to it, e.g.
     `packages/core/src/route/`), `autoplace.ts`, `lengths.ts`, `apps/web/src/ui/board.ts`, new worker
     files under `apps/web/src/`, `apps/cli/bench/`, new test files, and this document.
   - Shared files, changed as little as possible: `packages/tools/src/tools.ts` (only the `autoroute`,
     `auto_place`, `tune_length` and `net_lengths` entries), `packages/core/src/index.ts` (export lines
     added at the end), `packages/core/src/ruleDefs.ts` (new rules added at the end, only if needed).
   - Not touched by PM2: ERC, schematic, symbol, KiCad import / export and sync files
     (`erc.ts`, `schematic*.ts`, `sch/`, `sync.ts`, `kicad*`, `symbol*`), `inspector.ts`, and
     [04-schematic-improvements.md](04-schematic-improvements.md).
   - `docs/02-roadmap.md` and the README are updated once, at the end of PM2, in their own section.
   - P16 adds a pin property that schematic files will later show; until S17 / S18 are merged it is
     added without changing schematic files (a new core module computes net classes; `sync.ts`,
     `symbolEditor.ts` and the footprint generator are left alone).
   - If a PM2 item turns out to need a file outside these lists, the implementer asks the owner first.

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
| 0.3 | 2026-11-12 | PM2 detailed after a study of the v0.0.3 code: P8 split into P8a–P8g (harness, per-net clearance, per-net routing, negotiated congestion, smoothing, cost tuning, verification and Web Worker); P9 and P10 limited to the core and the autorouter, their hand-routing parts moved to P4; dependencies on P5 / P6 resolved; RGB lamp baseline recorded; study notes added; working rule 4 for parallel work with the schematic agreement. Owner's findings added: soft corners only (no 90° or acute corners, 45° or arc, human-like pad entry and bundles) in P8e / P8f; new item P16, signal classes from pin metadata driving the layout rules. Owner's revision: perpendicular routing (top horizontal, bottom vertical) with `routeDirection`, fanout first and reference-plane cost in P8f; P10 rewritten with differential-pair rules (impedance width / gap, coupled routing, symmetric vias and breakout, skew as delay per layer, tuning rules, 3W spacing, interface presets); tabbed routing and field solvers out of scope. | Owner (widjis), in chat: "Setuju, commit" |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | widjis | 2026-11-12 | 0.2 |
| Owner | widjis | 2026-11-12 | 0.3 |

Approval was given by the owner in the working chat ("Setuju, PM2 dulu" — "Agreed, PM2 first")
and recorded here by the implementer. Version 0.3 was approved in the same chat ("Setuju, commit" —
"Agreed, commit").
