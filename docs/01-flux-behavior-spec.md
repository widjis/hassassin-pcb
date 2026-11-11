# Behaviour specification — reference: Flux (flux.ai)

> **Clean-room status:** this document is written **only** from public material visible to a
> visitor — the `flux.ai` landing page and the public documentation at `docs.flux.ai` —
> observed on 2026-11-11 with an ordinary browser. No Flux code, JavaScript bundles, private
> APIs or assets were read or copied. Every sentence is in our own words. Our implementation
> **may only** refer to this document, not to the Flux product.
>
> Flux's name, logo, colours, UI text and brand terms must **not** be used in our product.

---

## 1. The product (as seen from outside)

- A complete ECAD application that runs **entirely in the browser**, with nothing to install.
- The canvas renders with **hardware-accelerated WebGL2** (the docs ask users to make sure
  WebGL2 is enabled). This is a must for the performance of large multi-layer boards.
- **Real-time collaboration**: every change is saved to the cloud straight away; a short
  "saving" indicator appears each time a change is committed to the history.
- Scope: schematic → PCB (up to about 8 layers, including flex / rigid-flex) → 3D →
  manufacturing export. Newer versions extend to mechanical design, firmware, wire harnesses and simulation.
- An **AI agent** at the centre: the user describes the device's purpose, and the agent asks
  questions, plans, picks parts, draws the schematic, places components, routes, runs checks and
  prepares the fabrication files. The agent always asks permission before changing copper or rules.

## 2. UI layout (conceptual)

| Area | Purpose |
|---|---|
| Left panel | Chat with the AI agent · part library · Object Tree · list of rulesets |
| Centre canvas | Schematic editor / PCB editor / 3D view (kept in sync with each other) |
| Right panel | Contextual inspector: properties, price & stock (from the MPN), the object's layout rules |
| Bottom-left of the canvas | Layer panel: show / hide each layer and copper fills |
| Project menu | Undo/Redo, Change History, Fork, Clone, Export |
| Project tables | Nets, Components, BOM, Pins, Knowledge — tabular views of project data |

Selection: click = select an object; drag a box = multi-select; Shift+click = add to the
selection; Cmd/Ctrl+click = *deep select* (pick a sub-element inside an object). Selection on the
canvas and in the Object Tree stays in sync.

## 3. Data model — the object tree

The whole layout document is a **tree**. Every node has an internal `uid`, a `type`, a
name / designator, and properties.

| Category | Types |
|---|---|
| Top | `root`, `layout` (a board), `element` (a component, linked to its counterpart in the schematic) |
| Containers | `container` (system folders such as "Components", "Nets"), `group` (user folders), `footprint`, `model` (2D/3D), `net` |
| Copper | `pad`, `via`, `trace`, `fill` |
| Silkscreen | `text`, `line`, `circle`, `rectangle` |
| Utility | `zone` (copper keep-out) |

The schematic model (public API) uses the nodes `element` (a part, with `terminals`),
`route` (a wire between terminals), `elementTerminal`, `routeTerminal`, `property`,
`asset`, `control`.

**Design note for us:** schematic and PCB share the component identity (`element`) and the
nets; one source of truth, two views.

## 4. The layout rule system — the main distinguishing feature

Layout values (trace width, clearance, position, rotation, pad shape and so on) are **not stored
directly** as raw attributes; they are the result of **resolving rules**, much like CSS.

### 4.1 Two kinds of rules
- **Object-specific**: attached to one object (like an inline `style=""`).
- **Selector-based (rulesets)**: apply to every object that matches a selector.

### 4.2 Selector syntax (modelled on the CSS selector concept)
- Type: `trace`, `pad`, `element`, … (case-sensitive)
- Designator: `#R2`
- Properties: `[prop]`, `[prop=value]`, plus partial-match variants (word, prefix, suffix,
  substring), with a case-sensitivity option
- UID: `[uid=...]`
- Combinators and pseudo-classes: universal `*`, descendant, child `>`, siblings `+ ~`, `:not()`
- While a selector is being typed, matching objects are **highlighted** on the canvas and in the Object Tree.

### 4.3 Resolving a value
1. A rule directly on the object beats an inherited rule.
2. Object-specific beats selector-based.
3. Specificity: type < attribute < ID. (`*`, combinators and `:not()` add no weight.)
4. With equal specificity, the rule **further down** the list wins (the cascade).
5. Some rules are **inheritable** (for example the pad shape passes down to child pads), others
   are not (for example the size).
6. An `!important` flag forces an override, including into reused parts / modules / sub-layouts;
   it raises a DRC warning about overriding a component.
7. **System Defaults** (base rule sets for the board and nets: current, impedance, differential
   pairs) sit below every project rule.

### 4.4 Values can be expressions
Properties and rules accept **spreadsheet-like expressions** (`= 22mm + 1`) with units and unit
conversion, maths functions, strings, and references to other objects' properties or rules. They
are re-evaluated automatically when their inputs change.

### 4.5 Examples of existing rules
Keep Out (clearance, both ways, can be per target type, for example only against fills),
Board Inset Margin, Auto Layout Gravity (0–1), Asset (for example an SVG logo on the silkscreen),
Trace Width, Preferred Trace Widths, Trace Shape (straight / curved), Connected Layers
(turns on pours per layer for a net), Fill Stitching Density / Offset, Position X/Y,
Rotation, Pad Shape, Size, Enable.

## 5. PCB editor features

- **Net vs trace**: a net is a logical connection (from the schematic); a trace is a physical copper
  path. Trace width is set at the net level or through a ruleset.
- **Copper fills / pours**: dynamic pours per net per layer. A GND fill is on for every layer by
  default (but hidden); power fills are off by default. Stitching vias are not automatic — they are
  configured through a rule.
- **Vias**, smart vias, curved traces, polygons, custom pad shapes, silkscreen, distance measurement,
  unit management, object locking, stackup editor, impedance control, length / skew tuning,
  differential pairs.
- **Auto Layout**: automatic placement and routing.
- **Real-time DRC**: runs continuously while editing; results appear in a messages panel.
  Examples: overlapping traces, unrouted nets, missing footprints, floating copper, clearance.
  There is an EMC review (traces crossing a split plane, vias without a return via, and so on).
- A synchronised **3D view**.

## 6. Collaboration and versions

- **Autosave + Change History**: every change becomes a version that can be viewed and *restored*.
  Standard undo/redo.
- **Fork** (a copy with history) and **Clone** (a clean copy). The agent can try alternatives in a
  fork and then **merge** the better result back, with notes on the merge decision.
- **Comments** pinned to a point on the canvas; they can be replied to, resolved, pinned and hidden;
  there is a list of all comments.
- **Layered permissions**: Edit / Comment / View / None, stacked over four levels
  (anonymous / public, …, organisation, enterprise). Private by default.

## 7. Library and parts

- A public library (community parts) + personal / organisation libraries.
- A part carries a symbol, a footprint, a 3D model, properties (MPN, value), and live price /
  availability from distributors.
- The AI can create a part from a datasheet, verify it, and enrich its data.

## 8. Import / export

- Import: KiCad, Altium, Eagle, EasyEDA, OrCAD/Allegro, PADS, DipTrace, IPC-2581, IDF and more.
- Export: Gerber, drill, BOM, pick-and-place, standard netlists.

## 9. AI agent (observed behaviour)

- Chat mode and agent mode; several parallel threads; a choice of model.
- Works on the project context + the current selection on the canvas.
- Flow: ask about requirements → plan → carry out step by step → re-check after each step →
  report. Asks for confirmation before large changes.
- Every editor operation (rules, renaming a net, routing, DRC fixes, restoring a version, forking)
  can also be triggered in natural language → this means **every editor action is a structured
  operation that can be called as a tool**.

---

## 9b. Direct observation in the editor (2026-11-11)

Observed while signed in as the user, on a public example project ("ESP32 BMS", owned by a Flux demo
account) and on the user's own empty project. Only the visible UI was noted; no design was changed.

### App structure and URLs
- One page per project: `/<owner>/<project-slug>~<id>/<tab>`; tabs are `files`, `schematic`,
  `pcb/2d`, `pcb/3d`, plus `?thread=<uuid>` for the active chat thread. More tabs can be opened with
  a "+" button.
- Three-column layout: **agent chat** (can be hidden / full width) · **work area** (Files / Schematic /
  Layout / 3D tabs) · right panel (onboarding / inspector).
- A new project starts *chat-first*: the work area is empty ("no schematic yet") until the agent or the
  user adds components. **Chat** mode (answers only) vs **Agent** mode (works autonomously, using an
  "ACU" quota); the chat input has a capability picker, file upload, an MCP server picker, markup and
  voice input; the agent can be stopped.

### Layout editor (PCB 2D)
- A vertical icon rail on the left opens **docked, stacked** panels that can be open at the same time:
  **Profile**, **Library**, **Objects**, **View**, **Review** (badge with the number of errors and warnings).
- Below the canvas: choose the board side (**Top** / Bottom), Zoom to Fit, Zoom to Actual Size,
  an **Auto-Layout** button + advanced options.
- Colours: top copper red, bottom blue, board outline green, the selected object highlighted bright
  green; dark background with a grid.
- **Clicking a component** → a *floating toolbar* appears near it (designator, position, rotation,
  layer, visibility, lock) together with the right-hand inspector; the Object Tree opens the branch
  down to that object.

### Profile panel
- Manufacturing Profile (presets, "Save As"), Description, **Stackup** (for example "Standard 2 Layer"),
  **Rulesets** (the project's own), **Overrides** (rules with `!important`), **System Defaults**.
- **System Defaults = one read-only ruleset per object type**, like a browser's built-in stylesheet:
  Circle, Container, Cutout, Component, Fill, Flex Joint, Footprint, Group, Layout, Line, Model,
  Nets (with sub-classes: High / Medium / Low Speed Nets, Power Nets, Net), Pad, Polygon, Rectangle,
  Root, Trace, Silk, Smart Via, Stackup Area, Text, Via, Zone.

### Ruleset inspector
Fields: Designator, Enabled toggle, Description, **Selector** (criteria + the number of matching
objects, for example "721 objects", highlighted on the canvas), then a list of **Layout Rules**.
Default values seen (noted as *kinds* of rules, not as numbers to copy):
- General: Enabled, Dimension Unit, Rotation Unit, Position, Rotation, Size (+ min/max X/Y),
  Scale for 3D models, Keep Out (min/max), Keep In (min/max), minimum corner radius, Silk Color, Layer.
- Trace: Trace Width, minimum trace corner, Preferred Trace Widths, **Shape Start / Shape End**
  (relative segment end points).
- Pad: Pad Shape, Pad Type (SMD/TH), Thermal Relief (+ count, width, conductor angle),
  Connected Layers, Hole Size (+ min/max), Hole Position.
- Values mix units (`10mil`, `500um`, `1.6mm`) → a units engine is required.
- Keep Out values can be **per target type**: a form like `net(0.5mm) polygon(0.5mm)`.

### Component inspector
- Header: part name + icon; Designator, Component Name, Description.
- **Layout Rules with a "Computed" vs "Specified" toggle** — the effective value from the cascade vs
  the value written directly (the same idea as "computed style" in browser DevTools). Rotation on three
  axes (for example `0° 0° 90°`).
- Properties: Part Type, Manufacturer Name / Part Number, Datasheet URL, Designator Prefix.
- Pricing & Availability (empty when nothing is found), Controls.

### View panel (layers)
Layers are grouped: Mechanical Layers, Top Layers (Silkscreen, Solder Paste, Solder Mask, Copper…),
and so on; show / hide buttons per layer and per group.

### Review panel (DRC)
Severity and Relevance filters (for example Layout only). Categories with counts: Airwires (unrouted
connections), Redundant Traces, Copper Clearance, Missing Pins, plus a Manufacturing group. Red icon =
error, yellow = warning.

### Schematic
Dark canvas, white symbols; the value label below the designator (for example `R2 51 Ω`); unnamed nets
get an automatic name from their terminals (a "Net (D2 - K)" pattern); ports / net labels for named signals.
- The View panel in the schematic has display options — all pin labels, comments, **collaborator
  cursors**, a keyboard-shortcut bar.
- The Review panel in the schematic separates **Electrical Rule Checks** (for example Floating Pin,
  Missing Power) from Design Rule Checks and Manufacturing; the "Relevance" filter follows the active tab.

### Net selection (PCB)
- The Object Tree can be filtered by text (designator / part name / selector); a net row shows a
  summary of its connected terminals (`C1:P2, C2:P2, …`).
- Selecting a net → **every trace of that net is highlighted** on the canvas.
- Net inspector: Designator, the list of Connected Components (terminals), Layout Rules (Trace Width,
  Connected Layers for pours, **Auto-Layout Priority**, Fill Stitching Density / Offset, Keep Out,
  Preferred Widths, minimum Trace Width, **Via Type** such as through-hole), Properties
  (**Net Type** such as Ground, **Current**).

### Project-level inspector
- With nothing selected: name, description, project thumbnail; project rules (for example Grid Spacing,
  units, active layer); **BOM price estimates per distributor** for quantity 1 (several distributors at
  once); Controls.
- The example project has no rulesets or overrides of its own → every value comes from the System
  Defaults + per-object rules. So the defaults must be good enough for simple boards.

### 3D tab
- A view cube with orbit / rotate / home buttons and a screenshot button.
- The View panel changes context: camera (Materials: realistic…, Projection: perspective…), 3D model
  layers (top / bottom).

### Files tab
- **Documents**: the project's Markdown files (purpose, notes, simulation results) — also used by the
  agent as project memory.
- **Assets**: attached files with roles (for example an SVG "Default" for a logo, a PNG "Thumbnail"
  for the project cover).

### Part library
- Keyword / part-number search, filters: starred, owner, Part Type, available at distributors,
  manufacturer, package code, mount, terminal count, compliance, has a footprint, has a layout, has an MPN.
- **Every part is a "project" of its own** (it can be starred, has a creator, usage and star counts).
  A part is a document reused inside other documents (composition), not a record in a separate table.
- **Generic parametric parts**: one part (for example a generic resistor / capacitor / inductor) whose
  symbol and footprint adapt to the chosen package and value.

### Agent behaviour (observed in the user's empty project)
- Once Agent mode is chosen, the agent: thinks → consults internal guidance →
  **renames the project** to match its contents (the URL slug changes, the project id stays) →
  **creates a task list** (for example 3 tasks: specification & circuit; check connectivity, voltage
  levels, power supply, ERC; summary before layout) → runs the tasks as a *coordinator* with a status
  per task (running / waiting / done).
- The chat timeline shows short steps ("Thought for N sec", "Referenced guidance", "Renamed …",
  "Created 3 tasks") that can be expanded and collapsed; the total working time is shown.
- The user can type guidance while the agent works ("guide while it works") or stop it.
- **End result of the agent session** (the user's project, about 25 minutes, stopped because the trial
  quota ran out): a first schematic with 41 components / 24 nets, no layout yet. The closing report in
  the chat is structured: *what is available* (circuit blocks) → *check results* (number of ERC checks
  passed + technical review findings not yet fixed, for example polarity protection, supply tolerance,
  signal timing) → *connections that need attention* (pins per connector) → *documents and remaining
  work* (specification, test plan, compliance notes as downloads; layout, firmware, enclosure not yet).
- Agent quota is measured in work units; when it runs out the agent stops mid-way, the report says
  why, and an upgrade offer appears.
- Lesson for us: the agent must be **honest about status** (what passed, what is not verified yet), and
  long work must be able to stop cleanly and resume.

---

## 10. Implications for our architecture (our own decisions)

1. **Document = a tree of nodes with UIDs** in a CRDT (for example Yjs). Collaboration, autosave,
   change history and fork / merge all follow from this representation.
   *(As built: a server-ordered operation log instead of a CRDT — see the phase 4 notes in the roadmap.)*
2. **A CSS-like rule engine** at the core: selector parser → matcher on the tree → resolver
   (specificity, cascade, inheritance, `!important`) → effective value. The renderer, DRC and
   exporters only read **effective values**.
3. **An expression engine** with units (a permissive library such as mathjs could be used).
4. Our own **WebGL2 renderer**; layer visibility is view state, not data.
5. **Incremental DRC** in a Web Worker / WASM (geometry: Clipper2, an R-tree).
   *(As built: DRC on the main thread with a spatial grid, polygons with Clipper 6 WASM.)*
6. **A single command layer**: every UI action is a structured command → automatically usable by the
   AI agent (tool calling) and by undo/redo.
7. Our look, feature names and UI flow are redesigned — do not copy the layout pixel for pixel.
8. The rule resolver must answer two questions for every object: the **effective value** and **where
   it comes from** (which rule / ruleset won) — needed for the "computed vs specified" inspector and for
   the AI's explanations.
9. "Defaults per object type" are implemented as built-in rulesets with the lowest priority, not as
   values hard-coded in the renderer.
10. Rule values are typed: lengths with units, angles, 2D/3D vectors, enums, lists, and per-target maps
    (`net(…) polygon(…)`).
11. **Part = document** in the same format as a project; a project references parts (with a version)
    and can override them with `!important`. One format, one engine, one collaboration system for both.
12. The Review panel = one list of typed findings (category, severity, tab relevance, related objects),
    filled by ERC, DRC and manufacturing checks that run incrementally.
13. The agent works through an **explicit task list** visible to the user, and every step is the same
    editor command the UI uses.
