# Work agreement: PCB layout improvements

| | |
|---|---|
| Document | `docs/05-pcb-improvements.md` |
| Version | 0.4 |
| Status | **Approved on 2026-11-12 (0.4) — in progress** |
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

    *First real-board run (2026-11-12, after P8e):* the owner's RGB Sleep Lamp, revision 6 (KiCad 10.0.7,
    2 layers, 60 parts, 38 nets, 46 vias, 5 pours, DRC clean in KiCad), run on a copy with
    `bench/autoroute.ts --kicad-rules`, which applies the `.kicad_pro` net classes (Default 0.3 / 0.3 mm,
    via 1.2 / 0.8 mm; VIN_BUCK and the buck switching node in their own class) and the 0.35 mm
    copper-to-edge clearance, since the importer does not bring them over yet. It imports with 0 ratsnest
    and 0 DRC errors. Traces and vias of every net without a pour are ripped up (380 items), the 4 poured
    power nets stay.
    | Router | Routed | Vias | Length | Time |
    |---|---|---|---|---|
    | Hand routing (same nets) | 59 / 59 | 38 | 901 mm | — |
    | v0.0.3 | 33 / 59 | 6 | 244 mm | 30 s (time limit) |
    | P8e + edge fix | 59 / 59 | 51 | 1037 mm | 10.6 s |

    The run found a board-edge bug, fixed with it: the router kept the trace *centre* 0.3 mm from the edge
    instead of the copper edge plus `boardEdgeClearance`; it now keeps a per-cell distance to the outline
    and cutouts. After routing, DRC shows 4 shorts between F.Cu pours, which appear on refill without any
    routing (pour priority, P6), none from the router; 1 corner of 90° is left. Still poor, for P8f: long
    detours along the board edge on B.Cu, 13 more vias and 15 % more length than the hand routing.
    `bench/compare.ts` draws the hand and the routed copper side by side (`--save` writes both boards).
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
- [x] **P8d. Rip-up and retry by negotiated congestion.**
  - Method: negotiated congestion routing as published by McMurchie and Ebeling (PathFinder, 1995),
    written from the paper. All nets are routed with cells allowed to be shared; shared cells get a present
    cost that rises each round and a history cost that accumulates; nets are ripped up and re-routed until
    no cell is shared or the round limit (default 30) or time limit is reached.
  - Nets that still share cells after the last round are ripped up one by one (least important first)
    until the result is legal; they are reported as unrouted with the reason `congestion`.
  - Locked traces and vias are fixed obstacles and are never ripped up.
  - The time limit stops between rounds and keeps the best legal result found so far.
  - *Done:* routes laid by the run are kept apart from the fixed copper (capsules in spatial buckets),
    so they can be ripped up. A connection that finds no free room is routed again with the routes of
    other nets allowed in its way at a price that rises each round, plus a history cost on cells fought
    over; the routes it crosses (checked exactly, segment against segment) are ripped up and wait for
    the next round, and routes that end on a ripped route go with it. Every committed route is legal,
    so a run stopped by the round or time limit leaves a legal board; what is left is reported as
    `congestion` or `time limit`. Copper on the board before the run is never moved. The `autoroute`
    tool takes `layers` and `rounds`. New fixture `channel` (one layer, net A blocks net B): 1 / 2
    without rip-up, 2 / 2 with it, 0 DRC errors. `reversed-bus` 1.9 s → 2.3 s. The benchmark boards are
    still to be measured.
- [x] **P8e. Clean traces and corner styles (human-like routing).**
  - *Owner's finding (2026-11-12):* routed traces still bend sharply. Today the search may turn by 45°,
    90° or 135° at one cell for the same small cost (0.1), so right-angle and acute corners come out of it.
  - *Owner's revision (0.4):* the corner style is a choice, as layout editors commonly offer (behaviour
    observed as a user; nothing copied). New rule `cornerStyle`, settable for the board, per net or per
    signal class (P16):
    | `cornerStyle` | Result |
    |---|---|
    | `45` (default) | Every turn is at most 45°; a change of 90° is two 45° turns with a straight piece of at least `cornerSetback` between them. |
    | `arc` | Every turn is a tangent arc whose straight cut-back is `cornerSetback` (for RF and fast signals). |
    | `90` | Right angles are allowed as they come (orthogonal style). |
    In every style an acute corner (sharper than 90°) is never made. `cornerSetback` defaults to 2 × the
    trace width.
  - The search knows the direction it came from: acute turns are not allowed, and a turn costs more the
    larger it is (with `90`, right angles cost little).
  - Finished paths are smoothed against the real copper, in 0° / 45° / 90° directions only: grid stair
    steps become straight and 45° runs, needless bends are removed, and every new piece is checked
    against the obstacles before it replaces the old ones.
  - A final corner pass by style: `45` chamfers every remaining corner of 90° with a 45° piece; `arc`
    replaces every corner with an arc. If the full setback does not fit the clearance, a shorter one is
    tried; a corner that cannot be softened at all is left and counted (reported by the benchmark).
  - Pad entry as a person would draw it: the trace leaves a pad straight, preferably along the pad's long
    axis, and never meets a pad edge at an acute angle.
  - Acceptance on the fixtures (and the benchmark boards when measured): with `45`, 0 corners of 90° or
    sharper; with `arc`, every bend of autorouted copper is an arc; with `90`, no corner sharper than 90°;
    in all styles no autorouted segment off the 45° directions and no two consecutive collinear segments,
    and the bends per routed connection lower than at P8d.
  - Method sources: direction-aware A* and octilinear (45°) routing as described in the published
    gridless and shape-based routing literature (e.g. Schiele et al., "A gridless router for industrial
    design rules", DAC 1990). Fully topological "rubber-band" routing (Dayan, UCSC thesis 1997; the SURF
    system by Staepelaere, Jue, Dayan and Dai), which gives the most hand-drawn look, is a rewrite of the
    router and stays out of PM2; it is noted for a later agreement.
  - *Done:* the search keeps the direction of the last step (acute turns refused, 90° turns cost a little
    more than 45°) and now expands each state once (a closed set: the search had been expanding stale
    heap entries again and again; `reversed-bus` 2.3 s → 0.36 s). Paths are smoothed into long 0° / 45° /
    90° runs; the corner pass chamfers (`45`) or rounds (`arc`, trace `mid` point) corners, shortens the
    setback when it does not fit, turns a short Z jog into one 45° piece, and drops a short end piece
    that only joins a grid cell already inside the net's pad to the pad's centre. Pad entries prefer the
    pad's long axis. Rules `cornerStyle` and `cornerSetback`; option `cornerStyle` for the whole run.
    Fixtures, style `45`: sharp corners 0 on all six (P8d: 15 in all), acute, off-angle and collinear 0;
    style `arc`: every bend an arc; style `90`: no acute corner; all routed with 0 DRC errors in every
    style. Bends per connection vs P8d: qfn-escape 3.75 → 2.5, qfn-fine 3 → 2.38, reversed-bus 6 → 4.5,
    off-grid 2.5 → 1.75, tee 2.33 → 1.67, channel 3 → 3 (equal). The benchmark boards are still to be
    measured.
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
  - *Progress (2026-11-13), first part:* done: core module `signal.ts` (`netSignals`): the twelve classes
    in order of strictness, a pin's `signal` from the board pad or the schematic pin, and guesses from pin
    names (via the schematic pin of the same designator and number), net names (without the sheet path),
    pair partners (the `net_lengths` pairing: X_P / X_N, X+ / X-, DP / DM), crystals (designator Y / X or
    "crystal" / "XTAL" in the value; a frequency alone is not enough, since timing resistors carry one) and
    a converter's inductor whose other end is a supply. KiCad's one-pad `unconnected-(…)` nets are not
    guessed. A net takes its strictest pin class; a pin set by hand beats any guess; a class set on the net
    (`signalSource` absent or `net`) beats its pins and is never overwritten. New tools `classify_nets`
    (lists class, source and reason per net for review; `apply=true` writes `signal` and `signalSource`
    onto the nets) and `set_pin_signal` (a part, a pin, or a net with `net=true`; sets both the board pad
    and the schematic pin through ordinary ops, no schematic file changed). `net_lengths` shows each net's
    class. Default rulesets per class appended to `defaults.ts` (the one file outside the PM2 list this
    needed, as the item asks for default rules): power / ground as before, `high-current` 1 mm width and
    0.8 / 0.4 mm vias, `high-voltage` 0.6 mm clearance, `switching` 0.6 mm width and via cost 8 mm, `clock`
    0.3 mm clearance, via cost 8 mm and plane-gap cost 1, `high-speed` 0.3 mm, 10 mm and 2, `diff-pair`
    10 mm and 2, `rf` 0.5 mm, 20 mm, 3 and `cornerStyle: arc`, `analog` / `sensitive` 0.3 mm clearance.
    The router already reads every one of these rules per net, so nothing changed in `autoroute.ts`.
    Benchmark flag `--classify` applies the classes before routing.
  - Measured: the RGB lamp is guessed as 4 power, 1 ground, 1 switching (the buck's SW node, from U3's
    SW pin), 3 sensitive (FB, COMP, FREQ of the buck controller) and 1 analog (ADC), 28 general; with the
    classes applied it routes exactly as without (59/59, 35 vias, 882.4 mm). The mcu fixture has no
    hints in its names and stays general. Tests (`signal.test.ts`): the guesses on a board with one net of
    each kind; the rules each class gets once applied; a pin set by hand and a net set by hand winning;
    an RF class on two bus nets giving arc corners with no DRC errors.
  - *Dropped:* a via cost on `analog` (6 mm) and `sensitive` (8 mm) nets. On the RGB lamp it took the ADC
    net from 3 vias to 1, but the nets around it lost their paths: 51 vias and 1048 mm in all (UART_TX
    54 → 178 mm, GPIO15 30 → 148 mm), the same for any value from 5 to 8 mm, and routing those classes
    first (`autoPlacePriority`) gave 48 vias and 1090 mm. This is the rip-up instability noted for the mcu
    bus: a small change on a few nets moves many others. The classes that keep a via cost (clock,
    high-speed, diff-pair, rf, switching) do not occur on the RGB lamp; their effect on a real board is
    still to be measured, after the negotiation is reworked.
  - *Progress (2026-11-13), second part:* current and voltage. `set_pin_signal` takes `current` (A) and
    `voltage` (V) for a part, a pin or a net (`signalCurrent` / `signalVoltage`; 0 removes). A net takes
    the largest of its pins and its own; from 1 A it is at least `high-current`, from 50 V at least
    `high-voltage` (our own thresholds). `classify_nets apply=true` (now `planSignalClasses` in core)
    also writes the net's own `traceWidth` from the current (IPC-2221 chart fit for outer layers, 10 °C
    rise, the outer copper thickness from the stackup, rounded up to 0.05 mm: 1 A → 0.35 mm, 3 A →
    1.4 mm on 1 oz) and `keepOut` from the voltage (IPC-2221 spacing, uncoated outer layer: ≤ 30 V
    0.1 mm, ≤ 150 V 0.6 mm, ≤ 300 V 1.25 mm, ≤ 500 V 2.5 mm, then 0.005 mm/V). Rules written this way
    are listed in the net's `signalRules`, so a later run changes or removes them; a `traceWidth` /
    `keepOut` set by hand, on the net or by a project ruleset that matches it, is kept and reported
    under `kept`. Three more tests; the RGB lamp is unchanged (no currents or voltages given yet).
  - *Progress (2026-11-13), third part:* impedance. `set_pin_signal` takes `impedance` (Ω, single-ended,
    `signalImpedance`); a net takes the smallest given and is at least `high-speed`. `classify_nets`
    sets the net's `traceWidth` for it on the stackup's outer layer with the existing calculator
    (`lineGeometry`, `widthForImpedance`); the impedance width wins over a current width, and the result
    says so (`note`) when the current would need more, when the target cannot be reached, or when the
    width is over 1.5 mm (50 Ω needs 2.66 mm on a 1.6 mm two-layer board, 1.21 mm on 0.8 mm, 0.50 mm
    on 0.4 mm). One width per net, from the outer layer: an inner layer of a four-layer board would need
    its own width (a per-layer width rule does not exist yet). Differential impedance stays with P10.
  - *Progress (2026-11-13), fourth part:* the Board panel has a "Signal classes" section: the count per
    class, every net that is not general with its class (italic when guessed, dim while not applied, the
    reason and any current / voltage / impedance in the row), a select to set the class by hand ("auto"
    returns it to the pins and guesses), and a button that applies the classes (with the same computed
    widths and clearances as `classify_nets`; notes and kept rules go to the status line). Checked in
    the browser on the RGB lamp: 10 classes listed, applied in one undoable step, a hand-set class
    shown as such. Fixed on the way: the panel's lists (`len-list`, also the routed lengths) shrank to
    zero height inside the panel's flex column, so the lengths list had never shown; they no longer
    shrink (inline style in `board.ts`, `styles.css` left alone).
  - *Progress (2026-11-13), fifth part:* spacing between classes. New rule `classClearance` (keepout
    syntax, e.g. `analog(1mm) sensitive(1mm)`; hyphenated classes are written without the hyphen,
    `highspeed`), added at the end of `ruleDefs.ts`; the `switching` default sets
    `analog(1mm) sensitive(1mm)`. The router keeps the larger of the two nets' values between their
    traces and vias: in the search against the routes of this run, when a piece is placed or tidied,
    in the fanout stubs, and in the proximity cost. Pads are left out (two neighbouring header pins of a
    switching and a sensitive net could never be routed otherwise), and copper that was on the board
    before routing keeps the ordinary clearance (the distance field has no room for a per-pair value);
    DRC does not check it yet (PM3). Test: on the bus fixture with a switching net between an analog
    and a sensitive one and 2 mm asked, both neighbours stay at least 2 mm away (1.55 mm without the
    rule), with no DRC errors. On the RGB lamp, with classes applied, the buck's switch node now keeps
    1 mm from FB / COMP / FREQ: 59/59, 35 vias, 881.9 mm (882.4 mm without).
  - *Progress (2026-11-13), sixth part:* the remaining parameters. `set_pin_signal` takes `frequency`
    (MHz; from 50 MHz the net is at least `high-speed`) and `interface` (presets `usb2`, `usb3`,
    `ethernet`, `lvds`, `hdmi`, `mipi`, `pcie`, `can`, `rs485` with the differential impedance design
    guides commonly give: 90, 90, 100, 100, 100, 100, 85, 120, 120 Ω; the part's datasheet decides). An
    interface makes the net a `diff-pair` and carries its `diffImpedance` for P10's pair width and gap.
    For a net (`net=true`) also `pair` (net property `pairWith`, set on both nets; it beats the name
    pairing, and "" removes it from both) and `length_group` (the existing `lengthGroup`). `netSignals`
    returns frequency, interface, diffImpedance and lengthGroup; the Board panel row shows them with
    the partner. One more test. Skew limits per interface are left to P10, which owns pair tuning.
  - *Progress (2026-11-13), seventh part:* `project_status` (outside the PM2 list; changed with the
    owner's permission, in chat: "Ya, ubah") lists `signalClasses`: the count per class, each net that
    is not general with its class and source, and how many classes are not written onto the nets yet,
    with a hint to review and apply them. One more test.
  - Still open in P16: the owner's review of the benchmark boards' classes (in the Board panel's
    "Signal classes" section).
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
    the main routing then starts from those escape points. Vias never sit in or touch a pad (as today),
    except vias of a large pad's own net inside it (thermal vias in an exposed pad).
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
  - *Progress (2026-11-12), first part:* done: rule `routeDirection` (`alternate` = top horizontal, next
    vertical …, `alternate-v`, `any`; layers are not nodes, so the rule gives the pattern over the stackup
    and the tool option `directions` sets single layers), a step against the direction costs
    `direction_cost` (default 1.5) times more, a 45° step half as much extra; rule `viaCost` (a length of
    trace, default 4 mm, so the price no longer shrinks with the grid; it was 12 grid steps = 1.2 mm on a
    0.1 mm grid); `proximity_cost` (default 0.3 per step right next to other nets' copper, fading out one
    trace pitch away); `autoPlacePriority` routes first; `order=difficulty` (fine-pitch pads, then long
    connections) as an option. All are `autoroute` arguments and `bench/autoroute.ts --opt key=value`;
    the benchmark also reports the share of length against the layer directions.
    Measured on the RGB lamp copy (P8a), the defaults chosen from about 20 runs: shortest-first beat
    difficulty order on every pair (e.g. 35 vs 49 vias), a 4 mm via cost cut vias by a quarter, direction
    cost 2 or more cost length and vias (55–89 vias), 1.5 kept them at the hand-routing level. Results
    swing about ±10 % between nearby weights. With the defaults: 59 / 59 routed, **35 vias, 883 mm**
    (hand routing 38 vias, 901 mm; P8e 51 vias, 1037 mm), 0 DRC errors from routing, 2 corners of 90°
    left, 44 % of the length against the layer directions (the hand routing: 54 %), 22 s (P8e: 10.6 s;
    proximity and the dearer vias make the search wider, P8g moves it off the UI thread).
    The runs found three bugs, fixed here, where the router counted a connection as made that the
    ratsnest still showed open: (1) its grid flood joined copper of two layers wherever both lay over one
    another (an SMD pad over a bottom trace), (2) it joined copper that only touches (a trace grazing a
    pad's edge), while the connectivity check needs a trace end in the pad or the trace over its centre,
    (3) a route ending in a via on another route did not record that it rests on it, so ripping that
    route left it dangling. The flood is replaced by islands built with the connectivity check's own
    rules; fixture `graze` reproduces (2). Also: route ends never sit on a pad's very edge.
    The long B.Cu runs round the left board edge are still there, though shorter in total than the hand
    routing.
  - *Progress (2026-11-13), fanout:* done for SMD parts with a row of elongated pads: a part with 8 or more
    SMD pads on a layer and pad centres closer than 0.85 mm is dense; each of its pads with a connection
    leaving the part gets a straight stub from the pad centre along the pad's long axis, out of the row by
    max(0.4 mm, 1.5 × (width + clearance)), its end on a grid line. The stubs are laid as fixed copper of
    their net before routing (so other nets keep clear of the escapes), and a connection at such a pad
    starts or ends at the stub's end, carrying on straight or at 45° (never a 90° turn onto the stub); the
    first route there takes the stub in as its first piece, so the corner styles apply to it. A stub with
    no room is not laid, and a connection that cannot leave a stub's end starts from the pad as before.
    Option `fanout` (default on), the report counts `fanouts`. On the QFN fixtures every pin now leaves
    its row straight (before: hooks into the side of a pad, 45° runs across the pad ends, GND run under
    the part); a test checks it. The RGB lamp has no fine-pitch part, so its figures are unchanged.
    Not done: BGA dog-bones (square pads, a via per ball between the balls), regular fan patterns
    (alternating stub lengths, vias placed in a ring), and a run on a real board with a QFN / QFP (the
    solar-mppt board, P8a, waits for the owner's leave).
  - *Progress (2026-11-13), reference plane:* done: rule `planeGapCost` (per net) and option
    `plane_gap_cost`: a cost per grid step where the trace has no pour under it on a neighbouring copper
    layer (the pours as filled before routing), or where a trace laid by this run on that layer cuts the
    pour. The benchmark reports `offPlane`, the share of autorouted length with no pour on a neighbouring
    layer after refilling. Fixture `plane-slot` (a GND pour on B.Cu slotted by a trace right under the
    straight line of a signal): with cost 0.5 or more the signal moves off the slot, 59 % → 5 % of its
    length off the plane, for 0.2 mm more copper; a test checks the option and the rule.
    On the RGB lamp copy it did not help: off-plane share 0.389 without the cost, 0.37–0.48 with it
    (0.25–2, and two other forms tried: only traces on the other layer as gaps, or a cost for cutting a
    pour on the trace's own layer), always with more vias (38–50) and length (+10–20 %). The board pours
    four nets on F.Cu and GND on B.Cu, and both layers carry signals, so what decides the plane is how the
    B.Cu routes split the GND pour (islands removed on refill), which a cost per cell does not see.
    So the default is 0 (off); the rule is there for nets that need it, which P16's classes (high-speed,
    RF, diff-pair) will set. A whole-plane view (keep one layer for the plane, count the pour islands a
    route would cut off) is left for later. (The `fill … clearance` error some runs show is pour against
    pour, P6, not the router.)
  - *Progress (2026-11-13), bundles and short pieces:* connections whose pads are neighbours on one part at
    one end and on one part at the other (centres at most 1.25 × the pad's closest neighbour apart, and at
    most 2.6 mm) are found as bundle mates and counted (`bundled`; 12 on the RGB lamp), for P16's classes.
    They get no cost of their own. A bonus for running beside a mate at the bundle's spacing was tried and
    removed: on fixture `bus` (two 8-pin headers, offset, pin i to pin i) it pulled the routes tighter than the
    pins' pitch, crossed them and took 3 vias (the owner: "jelek banget"), and on the RGB lamp copy it cost
    +10 % length at 0.1, 58 vias and +24 % at 0.3, and even as a bare exemption from the proximity cost it
    ran into the time limit on 3 connections. Proximity and the layer directions already lay the bus side by
    side at the pins' pitch, so that is what the test checks: 8 bundled, 0 vias, one bend per trace.
    Owner's findings on the samples: a turn off a fanout stub was still sharp (a 45° piece of 0.07 mm at the
    grid offset, the stub's end lying between grid lines), and every bus trace had a short jog at the
    pad it ends on (its 45° run met the pad centre off its line). A clean-up step after smoothing now
    removes short pieces (shorter than the corner setback) between two long runs:
    - runs at 45° or 90° to each other: the short pieces go, and the runs meet at their corner; at 90° that
      corner gets a 45° chamfer as large as fits (the setback, smaller where a neighbouring pad is in the
      way; GND on `qfn-escape`: 0.67 mm instead of 0.07 mm);
    - parallel runs with a small offset: the corner before (or after) moves along its run so that one run
      lies on the other's line; where that corner is a via or the pad itself, the run goes on along its line
      and ends in the pad off its centre (no more than a quarter of the pad's size from it).
    Tests check that no 45° piece on `qfn-escape` is shorter than 0.15 mm and that each bus trace is two
    pieces. RGB lamp: 59 / 59, 35 vias, 882.4 mm, bends per connection 3.36 → 3.10, one sharp corner left
    (was 2), no new DRC errors. `bench/compare.ts` takes the panel titles as arguments (the fixture samples
    were labelled as hand routing).
  - *Progress (2026-11-13), fixture `mcu`:* at the owner's request, a busier board: a 0.5 mm QFN-32 with
    its exposed pad, a 2×5 header (pins numbered across the rows) and a reversed 1×6 header on the QFN's
    sides, an SOIC-8 EEPROM on I2C with two pull-ups, two decoupling capacitors, an LED and its resistor, VCC
    routed and GND poured on B.Cu. It found four faults, fixed here:
    - a pour whose net still had connections to make was painted as an obstacle for every other net, so
      the whole poured layer was closed (all routes on F.Cu, VCC round half the board, 387 mm); pours are
      no obstacles now (they are refilled after routing), and still count as their net's copper to end on;
    - an SMD pad over its own net's pour on the other layer counted as joined to it (the island of a
      ratsnest end was looked up on every layer), so the six GND pads were reported routed with no copper;
      an end on a pad now belongs to that pad's island, and a connection leaves the pad on the pad's layer;
    - the exposed pad could not be reached at all (vias never sit in a pad, and the QFN's pins fence it in
      on F.Cu); a large SMD pad (at least 2 mm and twice the widest via across) now takes vias of its own
      net inside, the usual thermal vias, and other nets' pads still keep their distance;
    - the clean-up step above cut the corner inside a fanout stub, so a second connection that starts at the
      stub's end was left open (VCC, 0.9 mm); a stub's end is now never removed or moved.
    Pours are tested by a raster made once per run instead of their polygons, which took GND from 14.8 s to
    0.65 s and the board from 21.5 s to 2.3 s. Result: 30 / 32 connections, 15 vias, 323 mm, no DRC errors,
    every GND pad joined to the pour; a test checks it. The RGB lamp copy is unchanged (35 vias, 882.4 mm).
    Open, found on this board (both fixed since, see below):
    - two IO nets of the left bus stay open: the router lays the odd pins' traces through the gaps *below*
      the header's right-hand pads, which reverses the order against the QFN's pins, so the traces must
      cross and two even pads are fenced in; rip-up then swaps the same two nets for 30 rounds (each one's
      route crosses the other's stub exit). Passing *above* those pads keeps the order and needs no via. This
      wants a view of the bus as a whole (the order of the nets along it), not one connection at a time;
      more rounds, `order=difficulty` or no proximity cost do not help;
    - a second connection at a fanned pad starts at the stub's end even when its target lies behind it, so
      it turns back in two short pieces (a sharp-looking U-turn, GND at U1.16). *Fixed (2026-11-13):* a
      connection from a fanned pad to a pad of the same part that has no stub of its own (the exposed pad)
      leaves from the pad inwards, not from the stub's end; a pin on the far side of the part still goes
      round through both stubs. The check whether a stub is already taken now looks for a piece running
      out along it (the inward route starts at the pad's centre too and had counted as taking it, so the
      next connection ended next to the stub, 0.05 mm off, with a 90° jog). A stub that a route ends on
      without taking it in is written anyway, so the copper reaches the pad. mcu: 30 / 32, 14 vias,
      320.6 mm (15 and 323 before), no corner of 90° or sharper; the 45° corner test now includes it (the
      arc and 90 tests still leave it out, as they expect every connection routed). RGB lamp unchanged.
      Tried and dropped on the way: folding micrometre pieces left by the corner passes into the next piece
      (it moved a joint off the stub's end and made a new 90° corner at VCC).
    Tried for the left bus and dropped (2026-11-13), none kept in the code:
    - an exit lane, a short straight run in front of each stub's end kept for its own net: three nets open
      instead of two (IO4, IO5, P3);
    - a cost for crossing the straight ratsnest line of another net's pending connection (2 mm of trace per
      crossing; 1 and 4 tried too): the mcu result unchanged (IO4, IO6 open), and on the RGB lamp copy 47 vias
      and 976 mm instead of 35 and 882;
    - a history cost that grows with the present cost (PathFinder style) instead of by 1 per round: the
      searches spread over the whole board and ran out of memory.
    The log of the rip-up rounds shows why: from round 4 on IO5 and IO6 only rip each other (the present
    cost grows 1.6× per round and the history by 1, so the history never decides). A real fix wants the bus
    planned as a whole (the order of its nets at the header, which side of each pad a trace passes), or a
    negotiation that re-routes all nets each round with a bounded present cost.
    The per-class costs came with P16 (default rulesets per signal class; the router reads `viaCost`,
    `cornerStyle`, `planeGapCost`, `keepOut`, `traceWidth` and `classClearance` per net).
  - *Progress (2026-11-13), bus lanes:* the left bus of the mcu fixture is fixed by planning where each
    bus net leaves a part with more than one row of pins. For every group of bundled connections between
    two parts (three or more), seen from each part in turn: the row nearest the other part is the front
    row; the nets are ordered by their pins at the other part (either way round, whichever the front-row
    nets already follow; nothing is planned if they follow neither); each net whose pin sits in a rear
    row then gets the gap in the front row that keeps that order (between the last net placed and the
    next front-row net, with room for one more trace: width plus clearance), the gap nearest its pin.
    While routing, such a net may cross the front row's band only through its gap, on every layer; if it
    cannot be routed that way (also after rip-up), it is routed without the lane. On the 2 × 5 header the
    odd pins now pass above their even neighbours: mcu 32 / 32 routed (30 before), 15 vias, 355.5 mm
    (14 and 320.6 for 30), no corner of 90° or sharper, no DRC errors; a test checks the order IO1 … IO8
    where the bus passes the header's front row, and that every connection is routed. The RGB lamp and
    the other fixtures are unchanged (no bus there leaves a part with two rows). With `arc` or `90` corners
    mcu still leaves one or two connections open, so those two style tests leave it out.
    With arc corners the odd nets turn down right after passing above their even neighbour and fence it
    in (IO4, IO6 open); with 90 corners the same happens to IO4. Tried for that and dropped (2026-11-13):
    running the lanes on past the front row by one pitch, alone or with lanes for the front-row nets too
    (the default style then lost IO4 as well); routing the bus nets one after the other in bus order, or
    the front-row nets first and the rear ones after (two nets open in every style). In each case the
    rip-up rounds swap the same nets until the end, as before the lanes: what is left wants the reworked
    negotiation (all nets re-routed each round with a bounded present cost).
  - *Tried and dropped (2026-11-13): negotiation by sharing (PathFinder style).* A second mode, kept out
    of the code: a connection that cannot get through in free room is laid over the routes in its way at
    a price, those stay, and after each round every overlapping route (later: every route) is routed
    again with a history cost on the contested cells; what still overlaps at the end is ripped and tried
    once more in free room. On the mcu fixture it never converged: 7 to 11 routes kept overlapping in all
    30 rounds, and the result was 24 – 29 of 32 connections in every corner style (the rip-up mode gives
    32 / 32 with 45° corners), at 24 – 28 s instead of 2 s. Variants tried: re-routing only the overlapping
    routes or all routes; a present-cost cap of 16, 100, 1000 and 2000 grid steps; history on the shared
    cells only, on a disc around them, or on the shared cells plus the overlapped route's cells near them;
    a history step of 1, 5 and 20 per round. Found on the way, for a later attempt:
    - in soft mode the pieces laid around the search (pad entries, smoothing, tidy) are not checked
      against other routes, so a route can overlap another with no contested cell at all; harmless while
      the overlapped route is ripped at once, but with sharing such overlaps never go away;
    - every connection is first tried in free room, so whichever comes first in the order never feels the
      present cost and only moves when the history on its cells outweighs a detour; on this board the
      detours are vias (8 mm of trace for two), which a history of 1 – 20 per round does not reach within
      30 rounds;
    - the right-hand reversed header (P2, P3) needs vias, and an overlap of a few cells stays cheaper than
      two vias until the present cost is far above the cap that keeps the search from spreading.
    A negotiation that works here likely needs costs on resources rather than on cells (a pad gap, a
    channel between two pins has a capacity), or routing without the free-room first try.
    Still open in P8f: arc / 90 corners on the mcu bus (above); lanes for a bus that turns (the front row is
    taken along the straight line between the two parts' pins) and for parts with pins on several sides.
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
  - *Progress (2026-11-13):* done:
    - **DRC check before applying.** New core module `routeCheck.ts`, `checkAutoroute`: the plan is put
      on the board for a moment, pours are planned and refilled, DRC runs, and every connection whose new
      copper takes part in an error is taken out of the plan and listed as failed with reason
      `DRC: <kind> (<message>)`; repeated (up to 4 rounds) until nothing new is found; the document and
      engine are restored exactly (a test compares the saved text). The router now records the uids of
      each connection's copper (`routed[].uids`); a stub written for routes that end on it belongs to all
      of them, and is kept while one of them stays. The `autoroute` tool checks by default (`check=false`
      skips it) and reports `checked`, `removedByDrc`, `checkMs`. Cost: 4.3 s on the RGB lamp (routing
      21.9 s, so 26 s in all), under 50 ms on the fixtures; nothing was taken out on any benchmark board.
      Tests: a plan spoiled on purpose (a trace run through another net's pad) loses that connection, the
      rest applies with no DRC errors, and the board is unchanged by the check.
    - **One set of figures.** `autorouteSummary` (routed, failed with reasons, reasons counted, vias,
      length, time, grid, fanouts, bundled) is what the tool returns, what the bench reads (plus the check
      time and the connections taken out, now on its line) and what the Board panel shows.
    - **Web Worker.** `apps/web/src/routeWorker.ts` gets the board as text, loads the polygon engine,
      routes with a progress callback (new router option `onProgress`: round, connections holding a
      route, total; at most every 150 ms), checks, and sends back the ops and the summary. The Board
      panel's Autoroute button starts it and turns into Cancel; the status line shows
      "Routing: 27/32 connections, round 2 · 1 s", then "Checking the result with DRC…", then the
      summary. Cancel terminates the worker and leaves the board as it was; if the board changes while
      routing, nothing is applied and the panel says so; a finished run is one undo step. Checked in
      the browser on the mcu fixture: progress, Cancel, and the same result as the CLI (30 connections,
      14 vias, 320.57 mm). The panel's status lines no longer shrink in its flex column.
  - Still open in P8g: the acceptance run on the solar MPPT board (needs the owner's permission) and a
    progress report from the tool / CLI (they wait for the result as before).
- [x] **P9. Shove engine (core).**
  - A core function that, given a new trace or via, moves traces and vias of other nets in its way aside
    (walk-around first, then push), keeping their clearance and connections, and refuses when they cannot
    move. Written from published descriptions of shove routing, not from another tool's source.
  - Locked items are never moved. The result is one list of operations (one undo step).
  - The autorouter uses it before ripping up: a failing connection first tries to shove its neighbours.
  - Tests on fixture boards: connectivity identical before and after, 0 DRC errors.
  - *Moved to PM1 (with P4):* shoving while routing or dragging a trace by hand.
  - *Progress (2026-11-13), first part:* core module `shove.ts`, `planShove(doc, engine, copper,
    { net, traces, vias })`: returns the operations that move other nets' traces out of the way of the new
    copper (not the new copper itself), the moved uids and nets, or an error.
    - The pusher is wrapped in an octagon with sides at 0°, 45° and 90° (`boundOctagon`: the box cut by
      the x + y and x − y bounds), grown by the clearance and the pushed trace's half width.
    - A trace of another net that comes too close is followed along its chain (same net and layer,
      joined end to end) while the joints lie inside the octagon; that stretch is replaced by the walk
      round the octagon on the shorter side. A joint at a pad or via, an end or a branch is never moved.
    - The way round may not touch the new copper or other pieces of the net that pushes (no pushing
      back): those pieces join the octagon and the way is found again (up to 8 times).
    - The new pieces push in their turn (step limit 60).
    - Refused: a locked trace (`locked` on the trace or its net), an arc, a via of another net in the way
      (vias are not moved yet), a pad / via / branch inside the octagon, too many steps, and any result
      that, put on the board for a moment with the new copper, makes DRC report an error it did not
      report before or changes the islands of any other net. The board is left as it was.
    Tests (`shove.test.ts`, bus fixture after autorouting): a new trace beside or on top of B4 pushes it
    aside with no DRC error and every other net's connectivity unchanged, undo puts it back; a 2.5 mm
    trace pushes B4 and B4 pushes B5; planning leaves the board unchanged; a locked trace and copper
    laid on a pad are refused. Found on the way: the first octagon (sides along the pusher) could not hold
    a group of pieces, and B5 then pushed B4 back into the new copper; the board-axes octagon round the
    group fixed both.
  - *Progress (2026-11-13), second part:* the autorouter uses it. The walk round is now `shoveChains`, on
    any set of segments with the clearance and the fixed points given by the caller; `planShove` wraps
    it for the board's traces. In the rip-up loop, a connection whose route runs into routes of other
    nets first tries to shove them (`tryShove`): their segments are walked round the new route, the
    moved routes are checked like any piece of route (fixed copper, board edge, every other route, pads
    entered only by their own net) and every route resting on a moved one must still touch it;
    otherwise all goes back and the routes in the way are ripped as before. Option `shove` (default
    true; `shove=false` turns it off), count `shoved` in the report, the tool's summary and the bench
    line. Where the way round meets the hull at 90° or more, the corner is cut with a short 45° piece on
    the outer side (without it the RGB lamp got one more sharp corner).
    Measured: mcu with 90 corners now routes 32 / 32 (31 without), 4 connections shoved, no DRC error;
    with 45° and arc corners unchanged (32 / 32, and 30 / 32: there the routes in the way end on pads or
    stubs inside the hull, which do not move). RGB lamp 59 / 59, 35 vias, 882.2 mm (882.4), 1 sharp
    corner, bends per connection 3.2 (3.1). Other fixtures unchanged. Tests: mcu with 90 corners fails a
    connection with `shove=false` and routes all with the shove; mcu is back in the 90-corner style test.
    A first try that shoved only after the rip-up rounds, for connections still open, never succeeded
    (the same pad-bound chains).
  - *Progress (2026-11-14), third part:* vias move. In `planShove` a via of another net in the way of the
    new copper steps aside: the shortest step along one of the 8 directions (up to 3 mm) that clears the
    new copper by its clearance, a step along one of its own traces preferred (that trace keeps its
    angle). The ends of its traces on it follow; the via and those pieces then push in turn like any
    pushed trace, and the board check (no new DRC error, every other net's islands unchanged) decides as
    before. A locked via (on the via or its net), or a via with a locked trace or an arc on it, refuses
    the shove. The via keeps its uid (one `position` change), so undo puts it back. Tests: on the routed
    mcu fixture a 3 mm trace of another net laid 0.15 mm too close to each via in turn: where the shove
    goes through (2 of the 16 vias; the others are refused with the reason, mostly because the via's own
    trace crosses the new copper or the trace runs into a pad), the via has moved, DRC is clean, every
    other net keeps its islands, and undo puts the via back; a locked via is refused.
  - Left for later (not required above): pushing a trace whose pad end lies inside the hull (it would
    need its pad entry re-laid, not walked round); vias moved by the autorouter's own shove (`tryShove`
    walks routes round, its vias stay).
- [x] **P10. Differential pairs and length tuning (automatic).**
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
  - *Progress (2026-11-13), first part:* the pair's numbers, before routing it.
    - Rules `diffImpedance` (Ω) and `diffGap` (mm), added at the end of `ruleDefs.ts`.
    - `pairGeometry` in `stackup.ts`: the gap is kept at the nets' clearance (at least 0.15 mm) and the
      width solved for the differential impedance with the existing calculator. On the outer layer, 90 Ω
      at a 0.2 mm gap needs 1.08 mm traces on a 1.6 mm two-layer board, 0.60 mm on 0.8 mm, and 0.27 mm on a
      1.6 mm four-layer board (0.23 mm on its inner layer); 100 Ω needs 0.83, 0.47 and 0.22 mm.
    - `classify_nets apply=true` writes `traceWidth` and `diffGap` onto both halves of a pair (partner by
      name or `pairWith`, or class `diff-pair`) from the net's `diffImpedance` rule, else its interface
      preset; an interface given on one half counts for both. The width is noted when over 1 mm. These
      computed rules follow the same bookkeeping as the others (`signalRules`; a rule set by hand stays).
    - **Skew in time.** `effectivePermittivity` and `propagationDelay` (ps/mm) in `stackup.ts`: 5.7 – 5.8
      ps/mm on outer layers, 7.0 ps/mm on an FR-4 inner layer. `netLengths(doc, engine, stackup)` adds each
      net's `delay` (every trace with its own layer and width); `diffPairs` gives `skewPs`, `lengthGroups`
      `spreadPs`; pairs set by hand (`pairWith`) are found before the name patterns. `net_lengths` and the
      Board panel show them.
    Tests (`diffpair.test.ts`): stripline slower than microstrip (≈ 7.0 ps/mm); the pair geometry meets
    90 Ω within 1 Ω; a USB 2.0 preset on one half sizes both halves, and a `diffImpedance` rule set by
    hand wins; delays and the skew in length and time of a pair set by hand.
  - *Progress (2026-11-14), second part:* pairs routed together.
    - Before the rip-up loop, every pair (partner by `pairWith` or by name, both nets with a `diffGap`)
      whose two connections end side by side (ends at most 5 mm apart) is routed as one: its own A*
      over (layer, cell, direction) finds a centre path between the middles of the two pad pairs for a
      body of half width w + gap / 2, both nets' copper counting as its own. Only straight steps and 45°
      turns; a turn or a via only after a straight run of about (w + gap) / 2, so the two traces' corners
      do not fold; near either end (half the pad spacing + 1.5 mm) the path runs straight and square to
      the line between the two pads; starting or ending away from the middle costs 4 × the distance; a
      layer change is a pair of vias (cost of two), with room for both on every layer.
    - The path is split into two lines offset by ±(w + gap) / 2 (corners where the offset lines meet).
      Each pad joins its line with a mirrored 45° breakout; at a via the line steps out at 45° to its via,
      which sits across the direction of travel at (via diameter + max(gap, clearance)) / 2 from the centre.
    - Every piece and via is checked like any route piece, and the halves keep their gap; otherwise the
      two connections are routed one by one as before. Committed routes are ordinary routes from then on.
    - Found on the way: the distance field did not reach far enough for a pair's body or its via pair
      (it was sized for single traces), so a wall 0.7 mm away went unseen; it now reaches far enough for
      the pairs on the board. The pair search first ran out of steps (no closed set, stale heap entries
      expanded again); with a closed set it finds a path with a layer change in about 0.4 M steps.
    - Option `pairs` (default true), count `pairs` in the report, the summary and the bench line.
    New fixture `pairs` (a USB 2.0 pair and an LVDS pair between two 1 × 6 headers, 0.8 mm board, classes
    applied): both pairs routed together, 6 / 6, no DRC error, no sharp corner, skew 0.03 and 0.07 mm
    (0.2 and 0.4 ps), > 20 mm of each pair side by side at its gap. With S1 copper across the board on
    B.Cu at x = 115 and F.Cu at x = 125, both pairs change layer between them with two vias side by side
    (0.8 mm apart), still no sharp corner. Other fixtures and the RGB lamp unchanged.
  - *Progress (2026-11-14), third part:* spacing to other nets.
    - Rule `diffPairClearance` (length): edge-to-edge clearance from a pair's traces and vias to other
      nets' traces and vias, never to its partner; the larger of the two nets' values wins. `classify_nets`
      writes 2 × the pair's width (3 W centre to centre), with the same bookkeeping as its other rules.
    - The router counts it like `classClearance` (between traces and vias of this run, and in the check of
      each piece against copper already on the board; pads are exempt). The pair search now also keeps it
      from copper already on the board, as the check of its pieces asks (the distance field does not tell
      pads from traces, so near other nets' pads the pair search is a little stricter than the check).
    - Found on the way: the straight run that a pair needs before turning was counted across a via pair,
      so a pair could turn right after its vias and the inner half folded back behind its via; the run now
      counts on the current layer only.
    Test (`diffpair.test.ts`): on the `pairs` fixture the rule is 2 × w and larger than the gap; after
    routing, every other net's trace (pair or not) is at least that far from each pair half between the
    headers. The via case still routes both pairs together. Other fixtures and the RGB lamp unchanged.
  - *Progress (2026-11-14), fourth part:* uncoupled length.
    - `pairCoupling(doc, engine, p, n)` in `lengths.ts`: per half, the length of its pieces that run
      parallel to a piece of the partner on the same layer at the pair gap (`diffGap` edge to edge, within
      10 % or 0.02 mm), measured as the overlap along the piece; `coupled` is the smaller of the two halves,
      `uncoupled` the longer remainder. Arcs count as their polyline. `withCoupling` adds both to the pairs.
    - Rule `diffUncoupledMax` (length); the built-in diff-pair ruleset sets 6 mm (two breakouts of a pair at
      a 2.54 mm pitch take about 3.2 mm). `net_lengths` gives `coupled`, `uncoupled` and `uncoupledMax` per
      pair; the Board panel shows the uncoupled length, in red when over the rule. The router does not
      enforce it yet: its pair search already keeps the breakouts short and mirrored.
    Test (`diffpair.test.ts`): on the routed `pairs` fixture both pairs run 28.8 – 28.9 mm coupled and
    3.2 – 3.3 mm uncoupled (under 6 mm); taking out the longest trace of USB_N makes the coupled length
    shorter and the uncoupled length longer.
  - *Progress (2026-11-14), fifth part:* length tuning.
    - `planTune` in `lengths.ts` replaces the old serpentine on the longest trace (`planMeander` stays as a
      wrapper): candidates on every straight trace long enough, longest first, each side, best first.
      A bump is a rectangle with 45° chamfered corners (chamfer up to the trace width), so the trace never
      turns more than 45° at once; it adds 2·A − (8 − 4√2)·c. The fewest bumps under the height limit
      (rule `tuneAmplitude`, default 1.5 mm); legs `tuneSpacing` apart edge to edge (default 3 × width);
      small mismatches get one small bump (chamfer A / 3), below one trace width nothing is added. The bumps
      sit at the end of the trace that meets another trace of the net, else in its middle; where the trace
      runs beside a partner at the pair gap, only on the side away from it. Tuned pieces keep the
      original trace's properties (the first version lost the autorouter's mark, seen in the picture).
    - Rules `diffSkewMax` (length) and `diffSkewMaxPs` (time, wins); the USB 2.0 preset gives 1.27 mm
      and `classify_nets` writes it as a computed rule.
    - Tools: `tune_length` uses the candidates (first without a new DRC error); `match` compares in time
      when the stackup gives delays, its bumps away from that net. New `tune_pairs`: pairs over their
      limit (in time, from each half's delay per mm) get the shorter half tuned; `all` tunes every pair
      with a skew over 0.02 mm. `autoroute` tunes pairs over their limit afterwards (`tune=false` leaves
      them; the result lists them as `tuned`). The Board panel's Match button uses the same candidates.
    Tests (`tuning.test.ts`): a pair drawn by hand 3 mm apart in length with a 0.5 mm limit is tuned to
    < 0.02 mm (< 0.2 ps), corners ≤ 45°, legs ≥ 3 W apart, bumps on the side away from the partner and
    under 1.5 mm, a second run leaves it; a 0.6 mm `tuneAmplitude` spreads it over more bumps; on the
    routed `pairs` fixture the USB 2.0 limit is set, autoroute has nothing to tune (skew 0.03 mm), and
    +2 mm on USB_N keeps DRC clean, corners ≤ 45°, legs 3 W apart and the gap to USB_P. Picture:
    `samples/tune.html`.
  - *Progress (2026-11-14), sixth part:* length groups, longer tuning and the uncoupled limit.
    - **Length groups.** Rules `lengthMatch` (length) and `lengthMatchPs` (time, wins). New tool
      `tune_groups`: in every group (net property `lengthGroup`) the nets that lag its slowest net by more
      than the tolerance (in time when every net has a delay) get a serpentine up to it; a pair's half in
      a group keeps its bumps away from its partner; `all=true` tunes a group with no rule to 0.05 mm. The
      Board panel shows a group's spread in time too and has a Match button for it.
    - **Tuning sections and several traces.** Rule `tuneSectionMax` limits the run of bumps on one trace
      (no limit by default). When no single trace can take the length, `planTune` spreads it over the
      fewest traces that can, each in proportion to what it can take at full height.
    - **Next to the sharper bend.** When both ends of a trace meet the net, the bumps go next to the
      sharper of the two bends (before: in the middle).
    - **Uncoupled limit.** The pair router already keeps the breakouts short (pairs leave and enter
      their pads square to them, starting and ending away from the middle costs extra). `autoroute` now
      lists every pair whose halves still run apart longer than `diffUncoupledMax` as `uncoupledOver`,
      with a hint.
    Tests: a group 30 / 28 / 26 mm with a 0.2 mm tolerance is tuned to its slowest net (spread < 0.2 mm,
    corners ≤ 45°, legs ≥ 3 W), and a second run leaves it; with no rule the tool says so. With a 6 mm
    section limit, 10 mm goes onto both pieces of a net, each section under 6 mm. A trace with a 45° turn
    at one end and a 90° turn at the other gets its bumps at the 90° end (this test fails with the old
    middle placement). On the `pairs` fixture nothing is over the default 6 mm, and with 0.1 mm the USB
    pair is listed. The layer-change test now also checks the P10 acceptance in full: USB 2.0 and the
    100 Ω LV pair cross to the other layer coupled (over 20 mm at the gap), with vias side by side, skew
    within 1.27 mm and no corner of 90° or sharper. 224 tests pass. Not checked in the browser: the
    group Match button (the pair Match button and the picture were).
  - Left out of P10 (optional in the text above, or for later): arc corners for a pair and for serpentines
    (45° chosen; with `cornerStyle: arc` a pair keeps 45° corners); ground return vias next to a pair's
    vias; small bumps on both halves at once; a pair whose halves swap sides between its ends (routed
    one by one today); DRC reporting pairs outside their rules is PM3 (P12).
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
  - *Progress (2026-11-14):* the improvement pass, in `autoplace.ts` (`improvePlacement`).
    - **Greedy start** as before, now faster on an outline of many points (a distance grid of the board,
      0.25 mm cells, rejects most places before the exact test; the RGB lamp's round outline has 1160
      points and took 32 s, now 0.7 s), and a part that does not fit is tried turned by 90° steps.
    - **Simulated annealing** (from the textbook description): moves (range shrinking as it cools),
      swaps and 90° turns of the parts that are not locked. Cost: half-perimeter of every net, courtyard
      overlap (its weight grows from 0.5 to 60 with the cube of the progress, so parts may pass each
      other early and end apart; a higher start packs worse, a lower one leaves overlaps), reaching past
      the board edge (on the distance grid), and the terms below. Seeded pseudo-random moves (`seed`), so
      a run can be repeated; 20 000 moves per part (at most 1.5 million) per run, 3 runs from the greedy
      start (`restarts`), each made legal, the one that places the most parts with the shortest
      ratsnest wins. Then every part is put on its nearest legal place (spiral search, also turned);
      the result is kept only when it places more parts than the greedy start, or as many with a
      shorter ratsnest.
    - **Room for the traces:** each part's box grows by about one 0.5 mm track per connected pad spread
      round its outline, twice that for fine pitch (≤ 0.65 mm). Without it the mcu fixture's QFN could
      not be routed out (28 / 32); twice as much everywhere cost the RGB lamp most of its gain.
    - **Blocks:** parts whose symbols lie in one schematic group box, or on one sheet when the design has
      several, are a cluster; the half-perimeter of each cluster's part origins is added (weight 0.5).
    - **Decoupling:** a two-pad capacitor (reference C…) on a supply net and ground is tied to an IC on
      the same two nets (several ICs on one supply share the capacitors: each goes to the IC with the
      fewest per supply pin); the distance from its supply pad to the IC's supply pin costs 3 per mm, it
      moves and turns with its IC, and only small moves of its own are tried.
    - **Edge connectors:** a part with the property `placeAtEdge` (on the part or its symbol) pays 20 per
      mm from the nearest board edge and, when its pads lie off its origin, for not facing that edge
      with the side away from its pads.
    - `auto_place` takes `improve` (false = greedy only), `seed`, `iterations`, `restarts` and reports
      the ratsnest before and after, the decoupling pairs, the blocks and the edge connectors. The Board
      panel runs one shorter run (5000 moves per part) on the main thread and shows the figures.
    - Benchmark: new `apps/cli/bench/autoplace.ts` (board loading shared with the autoroute bench in
      `bench/boards.ts`): rips up every trace and via, places every part twice from scratch (greedy
      only = the v0.0.3 placer, and improved), refills the pours and autoroutes each.
      | Board | Ratsnest greedy → improved | Overlaps | Routed | Vias | Length | DRC errors | Time (place / route) |
      |---|---|---|---|---|---|---|---|
      | mcu fixture | 251.8 → 168.3 mm (−33 %) | 0 | 32 / 32 (greedy 26 / 32) | 5 (23) | 166 mm | 0 | 1.5 s / 0.9 s |
      | RGB lamp (copy), seed 1 | 945.3 → 662.9 mm (−30 %) | 0 (greedy 1, J4 not placed) | 88 / 88 (greedy 90 / 90) | 30 (44) | 603 mm (911) | 4 (greedy 8) | 17.3 s / 11.9 s |
      Every other fixture is 6–74 % shorter and routes fully with 0 DRC errors. The RGB lamp's DRC errors
      are all pour against pour on F.Cu (the pour priority of P8a / P6), none from parts or traces. The
      RGB figure depends on the seed: seeds 2 and 3 give −24 % and −15 % (both routed fully).
    Tests (`autoplace.test.ts`, mcu fixture cleared): at least 20 % shorter than the greedy start,
    courtyards apart and on the board, some parts turned, and the router finishes it with 0 DRC errors;
    C1 and C2 within 4 mm of a supply pin of U1 and U2 (one each); a group box keeps its parts at most
    as spread as without it, and is reported; a connector marked `placeAtEdge` ends under 1.5 mm from the
    edge; a locked part stays and the same seed gives the same operations. 231 tests pass.
  - Still open in P11: the acceptance on the solar MPPT board (needs the owner's permission); the RGB
    lamp meets it with the default seed but not with every seed; "facing out" is not covered by a test
    (the fixtures' connectors have their pads round their origin); keep-out areas wait for P6.

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
| 0.4 | 2026-11-12 | P8e: the corner style becomes a choice, rule `cornerStyle` = `45` (default) / `arc` / `90`, with acute corners never made in any style; acceptance per style. | Owner (widjis), in chat: "harusnya itu optional … pilihan belokan melengkung, 90 degree atau 45 degree", then "ok, lanjut P8e" |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | widjis | 2026-11-12 | 0.2 |
| Owner | widjis | 2026-11-12 | 0.3 |
| Owner | widjis | 2026-11-12 | 0.4 |

Approval was given by the owner in the working chat ("Setuju, PM2 dulu" — "Agreed, PM2 first")
and recorded here by the implementer. Version 0.3 was approved in the same chat ("Setuju, commit" —
"Agreed, commit").
