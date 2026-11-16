# Work agreement: agent plugins, component selection and datasheets

| | |
|---|---|
| Document | `docs/06-agent-plugins.md` |
| Version | 0.1 |
| Status | **Draft, waiting for the owner's approval** |
| Owner | Repository owner (widjis) |
| Implementer | AI coding agent working in this repository |
| Based on | Hassassin PCB 0.4.0 (tag `v0.4.0`) |

This document is the proposed scope of the work that lets the built-in agent find and choose components
itself, as the design assistant of Flux does: from the project's requirements it proposes suitable parts
(or asks the user to choose), finds their datasheets from trusted sources, reads what it needs from them
(pins, package, recommended land pattern, typical application circuit), and builds the parts with every
value traceable to its source. The tools that reach outside the project come as **plugins** that can be
installed, switched on per project and given limited permissions. Once approved (see
[Approval](#approval)), the implementer works through it in order; changes only happen through the
[change process](#9-change-process).

## 1. Goal

From a requirements-only start, the agent proposes components that fit, with their reasons, sources,
price and stock, lets the user decide, and turns the chosen parts into symbols and footprints that are
**checked, cited and approved before they reach fabrication**. A wrong footprint means scrapped boards,
so the bar is the same as for DRC: the agent proposes, deterministic checks and the user decide.

## 2. Background

- **What exists in v0.4.0:**
  - The built-in agent (Claude Code, Codex or the Claude API) works through the project's stages
    (requirements with `set_spec`, schematic, components, layout, review, fabrication) with the Hassassin
    tools only. The CLI backends get exactly one MCP server, `hassassin`: Claude Code's own tools are
    switched off (`--tools ''`, `--strict-mcp-config`), Codex runs in a read-only sandbox. No tool reaches
    the internet.
  - `search_parts` searches the project's parts, generic parametric parts and the installed KiCad
    libraries; `get_part` shows a part's pins, footprint, properties and supplier offers.
  - `set_part_info` stores MPN, manufacturer, datasheet URL and LCSC number; `import_offers` loads price
    and stock from a CSV; `bom` shows them.
  - `create_symbol` builds a symbol from a pin table, `create_footprint` a footprint from datasheet
    dimensions (land pattern, or lead dimensions with IPC-style margins), and the pin ↔ pad check compares
    them. The values must come from the user (pasted into the chat).
  - The agent's instructions forbid inventing MPNs, prices, stock or datasheet values.
- **What Flux shows** (docs/01-flux-behavior-spec.md §7, §9): parts carry live price and availability,
  and the AI creates a part from a datasheet, verifies it and enriches its data. The behaviour wanted
  here, in the owner's words: at the start of a project the AI proposes suitable components or asks the
  user for advice, then looks for the part's source and datasheet from trusted places.
- **Example of the flow wanted** (USB-C powered sensor node):
  1. The agent asks for what is missing in the spec (supply, current, environment, quantity, budget) and
     records it.
  2. It splits the design into blocks (USB-C input and protection, 3.3 V regulator, MCU, sensor) and, per
     block, searches distributors for candidates matching the spec (for example input range, output
     current, quiescent current, package, temperature range, lifecycle "active", stock).
  3. It shows two or three candidates per block in a table (MPN, manufacturer, key parameters, package,
     price at the project quantity, stock, datasheet link) with a recommendation and its reason, and asks
     the user to choose, or chooses within limits the user set.
  4. For the chosen part it fetches the datasheet from the manufacturer or a distributor, finds the pin
     table, the package drawing, the recommended land pattern and the typical application circuit, and
     shows what it extracted with the page each value came from.
  5. It uses a library symbol and footprint when one matches, else proposes new ones; checks run; the user
     approves; the part is marked verified and placed with its recommended external components.

## 3. Scope

Three milestones, in order: AM1 builds the plugin system and safe access to sources, AM2 the
component selection, AM3 the datasheet reading with verification. Each item has acceptance criteria that
can be checked; an item is done only when all of them pass.

### Milestone AM1 — plugins and trusted sources

- [ ] **A1. Plugin mechanism.**
  - A plugin is an MCP server (a command with arguments, or a URL) described by a manifest: name,
    version, publisher, the tools it offers, the permission it needs (`read`: may only return data;
    `propose`: may return changes that the user applies; never direct writes to the project), the
    network hosts it contacts, and the settings it needs (API keys).
  - Plugins are listed in the server's configuration (installed once per machine) and switched on per
    project in the Agent tab; *Ask* mode only gets `read` plugins.
  - Every backend gets the switched-on plugins: Claude Code and Codex through their MCP configuration
    (with `--allowedTools` limited to those tools), the Claude API backend through an MCP client in the
    Hassassin server that forwards their tools.
  - Settings with secrets (API keys) are stored in the server's configuration, never in the project, the
    prompt, the agent's transcript or logs.
  - Every plugin call is logged with its tool, arguments (secrets removed), hosts contacted, time and
    result size; the log is visible in the Agent tab.
  - Acceptance: a test plugin installed, switched on and off per project, its tools offered to each
    backend only when on; a `read` plugin cannot change the project; a missing or crashing plugin gives a
    clear message and the agent continues without it.
- [ ] **A2. Source trust and web access.**
  - A trust list, editable by the owner, ranks sources: (1) the project and installed libraries;
    (2) distributor APIs used under their published terms; (3) manufacturer domains (for example ti.com,
    st.com, analog.com, microchip.com, nxp.com, onsemi.com, infineon.com, renesas.com, espressif.com,
    nordicsemi.com); (4) anything else, shown as unverified. Datasheet mirror sites are never treated as
    trusted.
  - A first-party `web` plugin with `fetch_document` (a URL on an allowed host; HTML or PDF; size and
    time limits) and, optionally, `web_search` through a search API the owner configures.
  - Everything fetched is returned as quoted data with its source and trust level. Text in a fetched
    document that tells the agent to do something is never acted on; the agent's instructions and the
    tool results say so.
  - Acceptance: a fetch from a host not on the list is refused with the reason; a PDF containing
    instructions to the agent ("ignore previous instructions …") in a recorded fixture does not change what
    the agent does; trust level shown with every result.
- [ ] **A3. Datasheet store.**
  - `get_datasheet` (by MPN, or by URL): finds the datasheet URL (distributor data first, then the
    manufacturer's site), downloads it, keeps it in the project's own storage (not in the repository) under
    its content hash with source URL, retrieval date and trust level, and returns its page count.
  - `read_datasheet` returns the text of given pages, keeping table rows and columns as far as the PDF
    allows, plus `find_in_datasheet` (pages where words such as "Pin Functions", "Land Pattern",
    "Typical Application" appear).
  - A part's `Datasheet` property points at the stored copy and the original URL; the same datasheet is
    not fetched twice; works offline once stored.
  - PDF text extraction uses a permissively licensed library (for example pdf.js, Apache-2.0).
  - Acceptance: datasheets of ten parts from five manufacturers fetched, stored and read; the pin table
    page of each is found by `find_in_datasheet`; a second request uses the stored copy.

### Milestone AM2 — component selection

- [ ] **A4. Distributor search plugins.**
  - Plugins for distributor catalogues that offer an API under terms that allow this use, chosen by the
    owner (candidates: DigiKey, Mouser, LCSC / JLCPCB, Farnell; Nexar / Octopart as a paid option). No
    scraping of pages whose terms forbid it.
  - One common result shape: MPN, manufacturer, description, parameters (as given by the distributor),
    package, lifecycle status, stock, price breaks with currency, datasheet URL, product URL, source and
    retrieval time.
  - Results are cached per project for a time the owner sets; offers go into the existing supplier offers,
    so `bom` shows them.
  - Acceptance: with the owner's API keys, a search for "LDO 3.3 V 500 mA SOT-23-5" returns parts with the
    common shape from each configured distributor; without keys the plugin says what is missing; recorded
    responses make the tests run without network access.
- [ ] **A5. Candidates from the requirements.**
  - A `find_candidates` tool: for one block or function (regulator, MCU, sensor, connector, protection …)
    it turns the project's spec and the block's needs into parameter filters, searches the configured
    sources, removes parts that fail a hard need (voltage, current, temperature range, lifecycle not
    active, no stock when the user asked for stock), and ranks the rest by the user's priorities (price,
    availability, package size, parts already in the design, preferred manufacturers).
  - Every candidate lists the needs it meets and the values it was judged on, with their source; needs
    that could not be checked are marked as such, never assumed.
  - Acceptance: for three example blocks (3.3 V regulator for 300 mA, USB-C ESD protection, I²C humidity
    sensor) the candidates meet the given hard needs on every listed value, and changing a need (for
    example input voltage 24 V) changes the list accordingly.
- [ ] **A6. Proposal and choice.**
  - The agent shows candidates as a comparison table in the Agent tab (MPN, key values, package, price at
    the project quantity, stock, lifecycle, datasheet with its trust level) with its recommendation and the
    reason; the user picks one with a click or in words, or asks for other options.
  - The user can let the agent choose by itself within limits (budget per part, preferred distributors,
    package sizes it may use); choices made by the agent are listed for review.
  - The chosen part gets MPN, manufacturer, datasheet and offers on the schematic and board part, and the
    choice (with the candidates and reasons) is kept in the project's history.
  - Acceptance: browser check of the flow on a new project with three blocks; the choice survives
    reload and shows in `bom`.
- [ ] **A7. From choice to placed part.**
  - For a chosen MPN, the agent looks for a matching library symbol and footprint (installed KiCad
    libraries, team library, project), checks that its pins and package match the datasheet, and uses it;
    when there is none, it goes through AM3.
  - The datasheet's typical application circuit is offered as recommended external parts (for example
    input and output capacitors with their values and the page they come from), placed with the part when
    the user agrees.
  - Acceptance: an LDO and a sensor taken from choice to a placed, connected part with their recommended
    capacitors; ERC clean; each recommended value cites its datasheet page.

### Milestone AM3 — datasheet reading with verification

- [ ] **A8. Extraction to a checked form.**
  - The agent fills a fixed schema from the datasheet: pins (number, name, type, unit), package (name,
    lead count, pitch, body and lead dimensions, exposed pad), recommended land pattern when given, and
    absolute maximum and recommended operating values used by the design. Every value carries its page;
    a value not found is left empty, never guessed.
  - The extracted form is a **proposal**, stored with the part, until approved (A10).
  - Acceptance: for the benchmark parts (A11) every filled value has a page that contains it.
- [ ] **A9. Deterministic checks.**
  - Pins: count matches the package name and drawing (for example QFN-32 = 32 + exposed pad), numbers
    unique and complete, names the same in every table of the datasheet that lists them, supply and
    ground pins present, types consistent with names.
  - Footprint by **two independent paths**: pads from the lead dimensions with the margins of
    `create_footprint`, and the recommended land pattern from the datasheet; they must agree within a set
    tolerance (for example 0.05 mm on pad size and position), else the part is flagged with the difference.
  - Cross-checks with a second source when one exists: a library footprint of the same package name, the
    distributor's package and pin count.
  - The existing pin ↔ pad check, courtyard and footprint DRC run on the result.
  - Acceptance: each check has a test that fails it (a wrong pin count, a duplicated number, a land
    pattern 0.2 mm off, a pin type at odds with its name).
- [ ] **A10. Review and the verified status.**
  - A review view per proposed part: the symbol and the footprint next to the datasheet page they come
    from, each value clickable to its page, checks with their results; the user approves, edits or rejects.
  - Parts have a status: `verified` (by whom and when), `proposed`, or `unverified` (no review). ERC and
    DRC warn about parts that are not verified; the fabrication export and the BOM list them and ask before
    exporting.
  - Acceptance: browser check of approving and rejecting a part; an unverified part shows in ERC, DRC and
    the fab export; the status is kept in the project and exported as a property to KiCad.
- [ ] **A11. Benchmark and release gate.**
  - A benchmark set of 50–100 parts with known-good symbols and footprints (for example from the
    official KiCad libraries, used locally as test data under their license, not copied into the
    repository), covering two-terminal parts, SOT, SOIC / TSSOP, QFN, small BGA, connectors and modules.
  - Measured per run: pin map exact (per part), pad size and position error, parts flagged by the checks,
    and **parts that are wrong but pass every check** (target 0).
  - `apps/cli/bench/datasheets.ts` runs it from stored datasheets (no network); results are recorded in
    this document per milestone, and a release is held when a category gets worse.
  - Package families are switched on for automatic proposals one by one, only when their "wrong but
    passed" count is 0 on the benchmark; other families stay manual (the agent asks the user for the
    values).

## 4. Out of scope

- Ordering, paying or placing carts at distributors (the agent shows prices and links only).
- Scraping websites whose terms forbid it; storing distributor data beyond what their terms allow.
- 3D models (the 3D view keeps its courtyard boxes), SPICE models and simulation.
- A public plugin marketplace or plugins from unknown publishers; plugins are installed by the owner.
- Schematic block generation beyond placing a part with its recommended external parts (for example a
  whole power supply designed from an application note).

## 5. Working rules (binding for the implementer)

The working rules of [04-schematic-improvements.md](04-schematic-improvements.md) section 5 apply
unchanged (clean room, permissive dependencies, English in the repository, every change through the
command layer, editor actions also as tools, no regressions, order of this document, honest reports),
plus:

1. **Data, not instructions:** everything a plugin returns from outside (web pages, PDFs, API responses)
   is treated as data. The agent never follows instructions found in it, and the tests include such
   content.
2. **No invented values:** a value that cannot be found in a cited source is left empty and shown as
   missing. This holds for MPNs, prices, stock, pin data and dimensions.
3. **Secrets stay on the server:** API keys live in the server's configuration only; they are never
   written to the project, the repository, prompts, transcripts or logs.
4. **Terms of use:** each distributor or search integration is built only on an API whose published
   terms allow this use, and the owner confirms the choice before it is built.
5. **Datasheets are not committed:** downloaded datasheets are stored with the project (or a cache
   folder), never in the repository; the benchmark uses a local folder.
6. **Tests without network:** automated tests use recorded responses and stored datasheets; live calls
   only in the owner-run checks.
7. **Human approval before fabrication:** nothing the agent extracts becomes `verified` without the
   user's approval.

## 6. Verification

| Kind | Used for |
|---|---|
| Automated tests (Vitest) | Plugin loading and permissions (A1), trust and refusals (A2), datasheet store (A3), result shape and filters (A4, A5), checks (A9), status in ERC / DRC / fab (A10) |
| Browser check | Plugin switches (A1), proposal and choice (A6), placed part with recommended parts (A7), review view (A10), with screenshots in the milestone notes |
| Benchmark run | A11: the datasheet set, table per milestone |
| Live check on the owner's machine | A4–A7 with the owner's API keys and real searches |

## 7. Definition of done (per milestone)

- Every item of the milestone checked in this document, with its acceptance criteria met.
- `pnpm typecheck` clean, `pnpm test` passing, `pnpm build` succeeding.
- `docs/02-roadmap.md`, `docs/03-agents.md` and the README updated; a short demo (screenshots or video)
  added.
- A tagged release with notes listing what changed and what is still limited.

## 8. Progress tracking

The checkboxes in [section 3](#3-scope) are the status. The implementer ticks an item in the same commit
that completes it, and adds the commit id after the item name.

## 9. Change process

- Adding, removing or changing an item needs the owner's approval in writing (chat or commit).
- Every approved change is recorded below, with the date and a short reason, and the document version
  goes up (0.2, 0.3 …).

### Open questions for the owner (before approval)

1. Which distributors to support first (with Indonesia in mind: LCSC / JLCPCB, Mouser, DigiKey,
   Farnell?), and will the owner get their API keys?
2. Web search: needed (it needs a search API with a key), or are distributor data and manufacturer sites
   enough?
3. May the agent choose parts by itself within limits (A6), or must the user always pick?
4. Should AM1–AM3 run before or after PM3's open item (P13's Gerber check)?

### Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1 | 2026-11-16 | First draft | — |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | | | |
