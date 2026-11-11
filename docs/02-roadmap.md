# Roadmap — Hassassin PCB

Nine phases (including 3.5), and every one of them now has a first version you can try. Each phase
ends with something usable in the browser. The order follows the dependencies: the **rule engine**
and the **command layer** come first, because the renderer, DRC, collaboration and AI all build on them.

| Phase | Name | What you can try |
|---|---|---|
| **0** ✅ | Foundation & viewer | Open a `.kicad_pcb` in the browser; WebGL2 pan/zoom; layers on/off; object tree; *Computed vs Specified* inspector backed by the rule engine |
| **1** ✅ | Basic PCB editor | Select/move/rotate parts, manual routing, vias, ratsnest, undo/redo, save/open our own format |
| **2** ✅ | Electrically correct | Incremental DRC (clearance, unrouted, overlap), copper pours, Review panel, Gerber/drill/BOM/pick-and-place export |
| **3** ✅ | Schematic + project flow | Schematic editor, netlist, ERC, schematic → PCB sync (one source of truth), requirements document, stages with gates |
| **3.5** ✅ | Agent access | `hassassin` CLI + MCP server (stdio) over `.hpcb`/KiCad files: query, inspect, change rules, add parts, wire, update PCB, DRC/ERC, refill pours, export fab — for Claude Code, Codex or any MCP client |
| **4** ✅ | Collaboration | Real-time multi-user editing, collaborator cursors, pinned comments, version history & restore, fork/clone, Edit/Comment/View access; **live MCP** (agents edit a project that is open) |
| **5** ✅ | Library & parts | Parts as reusable documents, generic parametric parts, KiCad library import, price & stock |
| **6** ✅ | AI agent | Chat and agent mode with a task list, AI guidance per project stage, the same tool definitions as the CLI/MCP (phase 3.5), DRC/ERC fixing, AI-assisted placement and routing |
| **7** ✅ (first version) | Advanced | Autorouter, 3D view, stackup & impedance, differential pairs / length tuning, flex / rigid-flex |

## The project-flow layer (across phases)

The engine is built from the bottom up (phases 0–2), but people work from the top down:
requirements → schematic → components → layout → review → fabrication. This layer joins the two.
Its interface is our own design (not modelled on another product's onboarding cards).

| Stage | Contents | Gate before moving on | Phase |
|---|---|---|---|
| 1. Requirements | Specification: purpose, supply, current, interfaces, size, environment, production quantity | Required fields filled in | 3 (document), 6 (AI asks and fills in) |
| 2. Schematic | Circuit blocks, netlist | ERC clean | 3 |
| 3. Components | Parts with MPN, footprint, stock/price | Every part has a footprint and an MPN | 5 |
| 4. Layout | Placement, routing, pours | DRC clean, ratsnest 0 | 1–2 |
| 5. Review | Collaborator comments + AI review (EMC, DFM) | No open comment marked as blocking | 4, 6 |
| 6. Fabrication | Gerber, drill, BOM, pick-and-place | Every gate above is green (or *overridden* with a reason) | 2 |

Principles:
- **The specification is data**, not just text: values such as the current on a net can become
  rules (for example a minimum trace width) and context for the AI.
- **Traceability**: parts and rules can record which requirement they satisfy.
- **Gates do not lock you in**: you can move on with a recorded reason.
- The AI (phase 6) works stage by stage with a visible task list, through the same command layer.

## Phase 0 — plan

**Goal:** the data and display foundation, no editing yet.

1. **Monorepo** — pnpm workspace, strict TypeScript, Vite, Vitest.
2. **`@hassassin/core`**
   - Document tree: typed nodes with UIDs (`root`, `layout`, `element`, `footprint`,
     `pad`, `trace`, `via`, `fill`, `zone`, `net`, `text`, `line`, …), properties, children.
   - Units: parsing and conversion of lengths (`mm`, `mil`, `in`, `um`) and angles (`deg`, `rad`).
   - Selectors: parser and matcher (type, `#designator`, `[prop]`, `[prop=v]`, `*`,
     descendant, child `>`, `:not()`), specificity.
   - Rule resolver: system defaults per type → rulesets (specificity, order) →
     rules on the object → `!important`; inheritance for rules marked inheritable;
     returns **the effective value and where it came from**.
3. **`@hassassin/kicad-import`** — S-expression parser and conversion of `.kicad_pcb`
   (outline, footprints, pads, traces, vias, zones, nets, text) into the document tree.
   The format is read from KiCad's public file-format documentation, not from KiCad's code.
4. **`apps/web`** — our own WebGL2 renderer (thick lines, circles, polygons, per layer with
   colours), pan/zoom, layer panel, object tree, inspector.

**Done when:** a real KiCad board opens and looks right, and selecting an object shows its
computed and specified values together with the rule they come from.

## Phase 1 — what was built

- **Command layer** (`core/commands.ts`): every change is a list of small invertible operations
  (`setRule`, `setProp`, `setName`, `add`, `remove`, `setRulesets`); `History` with undo/redo,
  merging of drag steps, and rollback when one operation fails. Collaboration (phase 4) and the AI
  agent (phase 6) use the same path.
- **Component frames**: footprint pads, graphics and text are stored relative to the component,
  so moving or rotating a component carries its contents.
- **Connectivity & ratsnest** (`core/connectivity.ts`): copper islands per net (pads, traces, vias,
  pours), then a minimum spanning tree between islands. A fully routed board gives 0.
- **Editor**: select, move (grid snap, Alt = free), rotate (R / Shift+R), delete, undo/redo.
- **Routing**: X, click a pad/via/trace to start, 45° preview (`/` changes the corner style,
  Shift = any angle), click to place a segment, V = via and change layer, L = change layer,
  Esc / right click = stop. New traces and vias carry **no** size of their own: they inherit it from
  their net (including the power/ground net-class defaults), so rulesets keep applying.
- **`.hpcb` format** (versioned JSON) for save/open, plus local autosave and a restore button.
- **Cascade changes**: parent default values are inherited too, and specificity applies between
  default rulesets (for example `net[netClass=ground]` beats `net`).

Not included (moved to phase 2): DRC / collision prevention while routing, push-and-shove,
rubber-band traces while moving parts, flipping parts to the bottom side.

## Phase 2 — what was built

- **Shared copper shapes** (`core/copper.ts`): pads, traces, vias and pours per layer as segments
  with a radius plus areas; the board outline is chained from Edge.Cuts. Used by DRC, pours and Gerber.
- **DRC** (`core/drc.ts`): shorts, clearance (keepOut per object type), distance to the board edge,
  copper outside the board, part bodies outside the board (warning), minimum trace width, minimum hole,
  unrouted connections. Every limit is read from rules (so rulesets control it). Spatial grid for
  candidates. Solar board (KiCad-clean): 0 violations, about 0.15–0.35 s.
- **Pours** (`core/pour.ts`): filled from the zone or board outline, other nets' copper cut out with
  clearance, thermal relief (spokes / solid / none from a rule), narrow necks and unconnected islands
  removed. A net can request a pour with the `pourLayers` rule → a pour node is created automatically.
  Polygon engine: Clipper 6 (WASM, `js-angusj-clipper`, MIT). Refilling the solar board's pours takes
  about 0.1–0.3 s and gives DRC 0 and ratsnest 0.
- **Fabrication** (`packages/fab`): Gerber RS-274X with X2 attributes (copper, mask, paste, silk,
  outline), Excellon PTH/NPTH (G85 slots), BOM CSV, pick-and-place CSV, a README, wrapped in a ZIP.
  Drill output compared with `kicad-cli`: 54/54 PTH and 4/4 NPTH holes match (one differs by 1 µm of rounding).
- **UI**: Review tab (grouped by kind, click = zoom and select), markers on the canvas, Pour button (B),
  Export fab.

Notes and known limitations:
- Gerbers have not yet been checked in a third-party Gerber viewer; only structure validation and drill vs KiCad.
- Silkscreen text is not in the Gerbers yet (needs a vector font).
- Pours of different nets on the same layer do not yet yield to each other (no pour priority).
- DRC runs on the main thread (about 1 s after refilling the solar board's pours); to move to a Web Worker later.
- Not yet: collision prevention while routing, push-and-shove, rubber-banding, flipping parts to the bottom side.
- The `clipper2-js` library was tried and dropped: its union created false holes (shorts in the
  pour result) and its offset was very slow.

## Phase 3 — what was built

- **Schematic model** in the same document tree as the PCB: `schematic`, `sheet`, `block`
  (sub-sheet symbol), `sheetPin`, `symbol`, `pin`, `wire`, `label` (local / global / hierarchical /
  power / flag), `junction`, `noconnect`. Symbols are placed with position / rotation / mirror as rules.
- **Netlist** (`core/netlist.ts`): geometric connections per sheet + local / hierarchical labels per
  sheet, global and power labels across the design, hierarchical labels ↔ sheet pins. Automatic net
  naming is our own.
- **`.kicad_sch` import** (hierarchical, embedded library symbols, `extends`, power symbols, PWR_FLAG).
  Verified on two real projects: a solar MPPT charger (3 sheets, 154 pins) matches KiCad's `netlist.xml`
  100 % and the pad nets in the PCB; a GPS tracker (130 pins, power symbols + sub-sheets) matches its PCB.
- **ERC** (`core/erc.ts`): unconnected pins, no-connect on a connected pin, two outputs driving each other,
  power inputs without a source, dangling wire ends, dangling labels, duplicate references.
  Solar MPPT: 0 findings, the same as KiCad's ERC report.
- **Schematic → PCB sync** (`core/sync.ts`): pad nets updated, PCB nets *renamed* so traces follow,
  new nets created, empty nets removed, new parts get a footprint next to the board, parts that exist
  only on the PCB are reported (not deleted). A real board's ratsnest is unchanged after syncing.
- **Built-in symbols** (R, C, L, D, LED, connector, generic N-pin IC), power symbols (ground, supply
  rails, PWR_FLAG), and an empty new project.
- **Schematic editor** (Canvas 2D): switch sheets, select / move / rotate / delete, wires (W, L-shaped
  corners), labels (L, `*` = global), add parts, enter a sub-sheet (double click) / go up (U), ERC markers,
  cross-probing to PCB components, Tab to switch Schematic ↔ Layout, **Update PCB** button.
- **Project flow**: the Project tab holds the requirements document (stored as project metadata,
  undoable) and the 6 stages with automatic gates (requirements, ERC, components, DRC + routing,
  review, fabrication) plus reasoned *overrides*. ERC shows in the Review tab.

Known limitations:
- Multi-unit symbols are imported per unit; the editor cannot switch units yet. Buses are not supported.
- Automatic net names do not always match KiCad's (the connectivity is the same).
- No back-annotation PCB → schematic yet (for example pin / gate swaps).

## Phase 3.5 — what was built

See [03-agents.md](03-agents.md). `packages/tools` (tools with schemas and descriptions for agents; the
stage-gate logic moved here), the `hassassin` CLI (JSON, `--fail-on-error` for CI), and an MCP server over
stdio written without an SDK (initialize, tools/list, tools/call, ping). The core packages run directly in
Node (erasable TypeScript syntax only). Tested end to end: an LED circuit from an empty project to a
fabrication ZIP through the CLI, and an MCP session over stdio (including undo within the session).

## Phase 4 — what was built

- **Sync model**: the server decides the order of transactions (an operation log from the command
  layer). A client applies its own edit immediately and sends it; when someone else's transaction
  arrives it rolls back its unconfirmed edits → applies the remote transaction → re-applies its own.
  The result is identical on every client and the server (tested with simultaneous edits to the same object).
- **`packages/sync`**: protocol, role rules, `SyncClient` (optimistic, rebase, reject, reconnect with
  replay of offline edits, presence, `flush()`).
- **`apps/server`**: HTTP API + WebSocket (`ws`); storage as a snapshot + JSONL log + a checkpoint every
  200 transactions; automatic versions (every 100 transactions / 10 minutes) and named ones; restore (the
  current state is saved first); fork (with history) and clone; links per role (edit / comment / view) +
  public access; it can also serve the built web app (`pnpm start`).
- **Web**: Share button + link dialog, avatars and live status, collaborators' cursors and selection in
  layout and schematic, pinned comments (C) with replies / resolve / blocking, Comments and History tabs,
  roles enforced in the UI; the "Review" gate is computed from open blocking comments.
- **Live MCP/CLI**: `project` can be a share link; the agent appears as an *agent* collaborator.
- Tested: 6 server/live tests (convergence, roles, versions / restore / fork, restart, live CLI and MCP) +
  a two-tab browser test (moving parts, cursors, comments, an MPN set by a CLI agent, restore, view-only).

Known limitations:
- No accounts / login yet: access is by the token in the link (anyone with the link can join).
- Conflicts are resolved "last to reach the server wins" per operation; no character-level merging of text.
- Undo after someone else's edit can be refused when the object has changed since (a message is shown).
- A single server without horizontal scaling; file-based storage.

## Phase 5 — what was built

- **Footprints as data** (`core/footprints.ts`): `FootprintSpec` + our own parametric generators
  (chip 0201–2512, SOD/SMA/SMB/SMC, SOT-23/-5/-6, SOIC, TSSOP, MSOP, QFN with exposed pad, DIP, 1×N/2×N
  headers, 5.08 terminals, M2–M3 holes). Common KiCad names map to a generic equivalent when the library
  is not available.
- **Parts** (`core/parts.ts`): symbol (multi-unit), footprint + alternatives, properties (MPN,
  manufacturer, datasheet, LCSC), supplier offers (stock, MOQ, price breaks, date). Generic parametric
  parts (`generic:resistor?value=4k7&package=chip-0402`). A project keeps a copy of every part and
  footprint it uses (`meta["part:…"]`, `meta["fp:…"]`), so the project file is self-contained and safe
  for simultaneous editing.
- **KiCad library import**: `.kicad_sym` (units, `extends`, power symbols skipped) and `.kicad_mod`.
  The CLI and server read the installed KiCad libraries automatically (about 22,800 symbols and 15,400
  footprints on the development machine) through a cached index (built once in about 0.6 s). The libraries
  are not bundled.
- **Schematic → PCB sync**: new parts get their footprint from the library straight away; a changed
  footprint or a placeholder is rebuilt in place (position / rotation kept, nets follow); part properties
  are copied.
- **BOM & sourcing**: grouped by MPN / value / footprint, priced for N boards (the cheapest offer with
  enough stock), CSV import from a distributor's BOM-tool export, manual entry. The "3 · Components" gate
  uses this.
- **Team library** on the server (`/api/library/*`): search (team + installed KiCad), fetch a part or
  footprint, publish a part from a project (needs an edit link), versioned.
- **New tools** for the CLI / MCP / agent: `search_parts`, `get_part`, `search_footprints`, `place_part`,
  `assign_footprint`, `set_part_info`, `bom`, `import_offers`, `set_offer`, `import_kicad_library`.
- **Web**: *Parts* tab (search, symbol + footprint preview, place, publish to the team), the project's
  parts list with editable footprint / MPN, cost for N boards, CSV and KiCad library import; *Library*
  button (P).

Known limitations:
- Price and stock are **not fetched live** from distributors: their APIs need account keys. Data comes
  in by CSV or by hand and is dated. Distributor API connectors will follow once keys are available.
- Generic land-pattern dimensions are our own nominal values; for production, choose footprints from
  the manufacturer's datasheet or library.
- No 3D models yet, and no pin ↔ pad mapping other than equal numbers.

## Phase 6 — what was built

- **Agent loop** (`tools/agent.ts`): Claude (`claude-opus-5-5`, adaptive thinking, streaming, automatic
  prompt caching, server-side *fallback* when the model declines) using **the same tool definitions**
  as the CLI / MCP. The conversation history is append-only, all tool results of one turn are sent in one
  message, tool errors go back as `is_error` so the model can correct itself, and there is a step limit
  per request.
- **Subscription backends** (`apps/server/src/cliAgents.ts`): the agent can also run on the Claude Code
  CLI (Claude subscription) or the Codex CLI (ChatGPT subscription), with the Hassassin MCP server bound
  to the open project, built-in CLI tools off (Claude) or a read-only sandbox (Codex). Sign-in is started
  from the Agent tab. Only for a server on the user's own machine.
- **Visible task list** (`update_tasks` tool) and **stage guidance**: every message carries the latest
  project status (stage gates, ERC/DRC results, requirements); the system prompt describes how to work
  in each stage, sets the schematic style (wires between parts, power symbols for every rail, labels only
  between blocks), and forbids inventing MPNs, prices or stock.
- **Agent / Ask modes**: Ask only gets read tools; view / comment links are always Ask.
- **Server** (`/api/agent/:id`, SSE): the agent joins the shared project as an "AI agent (for …)"
  collaborator, so its edits are live, undoable and in the history. API keys stay on the server. Stop
  button. Every agent conversation is mirrored to everyone who has the project open, with the transcript
  available to people who join later.
- **Web**: *Agent* tab laid out like a chat app: Markdown replies, tool steps folded into one expandable
  row per run with inputs and results, a task card with progress, a composer that grows as you type,
  token usage, a suggested prompt for the next stage. Side panels can be resized by dragging their edge.
- **CLI**: `hassassin agent <project | link> "request" [--mode ask]`.
- Tested with a scripted model (loop, tool errors, Ask mode, server + SSE + edits reaching the shared
  project), with fake Claude Code / Codex event streams, and live with Claude Code and Codex
  subscriptions. The Claude API backend has not been exercised against the real API yet.

Known limitations:
- The API backend needs Anthropic credentials on the server machine (`ANTHROPIC_API_KEY` in `.env`); API use is billed.
- Chat history is kept in the server's memory (lost on restart); no compaction for very long chats yet.

## Phase 7 — what was built (first version)

- **Autorouter** (`core/autoroute.ts`): A* on a grid per copper layer (8 directions → 45° traces),
  through vias, each net's clearance kept (a "copper core" grid + a "clearance zone" grid), traces neck
  down automatically on fine-pitch pads narrower than the trace, vias never on or touching a pad, other
  nets' pours ignored (refilled afterwards). Connections it cannot finish are reported, never forced.
  One undo step. Tested on the real solar board (0.4 mm QFN): rip up every signal net, then autoroute →
  41/60 connections, **0 DRC errors** after refilling pours, about 14 seconds.
- **Autoplacer** (`core/autoplace.ts`): parts outside the board are moved in, connected parts are kept
  close, courtyards do not overlap, distance to the board edge is kept.
- **Board outline tools**: `set_board_outline` (rectangle with optional rounded corners, or any polygon)
  and `get_board_outline` (size, area and simplified points).
- **Stackup & impedance** (`core/stackup.ts`): default 1/2/4/6+ layer stackups or custom ones (thickness,
  material, Er), a flex preset (polyimide + coverlay). Microstrip impedance (Hammerstad–Jensen), symmetric
  and offset stripline (IPC-2141), edge-coupled differential pairs, width for a target impedance.
- **Lengths & differential pairs** (`core/lengths.ts`): routed length per net, differential pairs by name
  (`_P/_N`, `+/-`, `DP/DM`) with skew, length-match groups (net property `lengthGroup`), automatic
  serpentines to match lengths (undone automatically if they cause DRC errors).
- **3D view** (three.js, loaded when opened): the board extruded to the stackup thickness with drill
  holes, top/bottom pads and traces, component bodies as boxes from their courtyards. **3D** button / key `3`.
- **New tools**: `auto_place`, `autoroute`, `get_board_outline`, `set_board_outline`, `delete`, `add_power`,
  `get_stackup`, `set_stackup`, `impedance`, `net_lengths`, `tune_length` (CLI, MCP and agent).
  **Web**: *Board* tab.

Known limitations:
- The autorouter has no rip-up-and-retry and no push-and-shove; on a dense board some connections are
  left to route by hand. No coupled routing of differential pairs yet (routed as two nets).
- Impedance formulas are estimates (±5–10 %); use the fabricator's calculator for production.
- Simple serpentines (90° corners) on the longest straight segment only.
- 3D uses boxes, not manufacturer STEP models; no STEP export yet.
- Flex / rigid-flex is limited to the stackup (polyimide material); no bend zones or per-area stackups yet.

## End-to-end test: an RGB sleep lamp from a requirements prompt

A real project (an ESP8266 RGB lamp with a 20 V → 5 V buck, a 3.3 V LDO, a level-shifted WS2812B
output and three sensor modules; the owner's own KiCad design is the reference) was rebuilt by the
agent through Claude Code from a prompt that describes requirements only — no part numbers, values or
netlist:

- **Schematic**: 52 parts, ERC 0, power symbols and wires as required, flash pins of the ESP module
  correctly marked no-connect. The agent found and fixed one wiring mistake of its own.
- **Layout** inside the original curved board outline (71.5 × 78.8 mm): everything routed, GND poured
  on both sides with a cut-out under the antenna, **DRC 0 errors**.
- The test exposed tool gaps that were then fixed: no way to resize the board, no delete tool, the
  outline could not be read back, part bodies outside the board went unnoticed, and the autorouter could
  put vias in pads.

## Out of scope (for now)

SPICE simulation, mechanical / enclosure design, firmware, wire harnesses, ordering from fabricators.
