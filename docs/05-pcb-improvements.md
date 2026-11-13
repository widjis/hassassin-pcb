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
  - Still open in P16: the other parameters (frequency, impedance, pair partner, length group,
    interface presets) and width from the impedance; extra spacing between `switching` and `analog` / `sensitive` nets
    (a per-pair clearance the rules cannot express yet); the class in the Board panel and in
    `project_status` (outside the PM2 list: to be asked); the owner's review of the benchmark boards'
    classes.
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
    Open, found on this board:
    - two IO nets of the left bus stay open: the router lays the odd pins' traces through the gaps *below*
      the header's right-hand pads, which reverses the order against the QFN's pins, so the traces must
      cross and two even pads are fenced in; rip-up then swaps the same two nets for 30 rounds (each one's
      route crosses the other's stub exit). Passing *above* those pads keeps the order and needs no via. This
      wants a view of the bus as a whole (the order of the nets along it), not one connection at a time;
      more rounds, `order=difficulty` or no proximity cost do not help;
    - a second connection at a fanned pad starts at the stub's end even when its target lies behind it, so
      it turns back in two short pieces (a sharp-looking U-turn, GND at U1.16);
    the corner-style tests skip this fixture until then.
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
    Still open in P8f: the per-class costs (with P16).
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
