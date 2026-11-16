# Agent access: CLI, MCP and the built-in agent

One list of tools (`packages/tools`) is used by the `hassassin` CLI, the MCP server and the
agent built into the app. Every change goes through the same command layer as the UI, so it is
undoable and, on a shared project, visible to everyone live.

## CLI

Needs Node ≥ 23.6 (TypeScript runs directly). From the repository root:

```sh
pnpm hassassin help
pnpm hassassin import "board.kicad_pcb" -o board.hpcb      # .kicad_sch files in the same folder are read too
pnpm hassassin project-status board.hpcb
pnpm hassassin query board.hpcb "net[netClass=power] > trace"
pnpm hassassin set-rule board.hpcb "net#GND" pourLayers "F.Cu B.Cu"
pnpm hassassin refill-pours board.hpcb
pnpm hassassin run-drc board.hpcb --fail-on-error           # exit code 2 when there are errors (for CI)
pnpm hassassin export-fab board.hpcb -o fab.zip
pnpm hassassin kicad-libraries status          # or: kicad-libraries download (official KiCad libraries into a local cache)
pnpm hassassin export-schematic board.hpcb -o schematic.pdf --paper A4   # or .svg / .zip; --theme light|mono|dark
```

Output is always JSON. Tools that change the project write it back to the `.hpcb` file (KiCad
files are only read; use `-o file.hpcb`). Each CLI call is its own session, so `undo` is only
useful in an MCP session.

## MCP server

```sh
node /path/to/hassassin-pcb/apps/cli/bin/hassassin.mjs mcp
```

Every tool takes `project` (a path to a `.hpcb` file). Extra tools: `new_project`, `import_kicad`.

### Claude Code

```sh
claude mcp add hassassin -- node /ABS/PATH/hassassin-pcb/apps/cli/bin/hassassin.mjs mcp
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.hassassin]
command = "node"
args = ["/ABS/PATH/hassassin-pcb/apps/cli/bin/hassassin.mjs", "mcp"]
```

### Live projects

Besides a `.hpcb` path, `project` can be a **share link** from the Share button, for example
`http://localhost:5178/?p=<id>&t=<token>`. The agent then joins the live session as a collaborator
labelled *agent* (set its name with the `HASSASSIN_AGENT_NAME` environment variable). Its edits
show up immediately for everyone who has the project open, and *view* / *comment* links cannot be
used to edit. The CLI accepts the same links: `pnpm hassassin run-drc "http://…?p=…&t=…"`.

### Suggested flow for agents

`project_status` → `set_spec` → `place_part` / `add_part` → `connect_pins` / `add_power` / `add_label` →
`run_erc` → `update_pcb` → `set_board_outline` → `auto_place` / `move_part` → `autoroute` / `route` →
`set_rule` / `refill_pours` → `run_drc` → `export_fab`.

Schematic style the built-in agent follows (and other agents should too): connect parts with wires,
use a power symbol for every ground and supply connection, and keep net labels for signals that run
between blocks.

## Tools

| Tool | Read/write | What it does |
|---|---|---|
| project_status | read | Overview, check results, stage gates, requirements, board size |
| query | read | Find objects with a selector; quote names with ( ) : , or spaces, e.g. `net#"Net-(U1-SW1)" > trace` |
| inspect | read | Every computed rule and where its value comes from |
| list_parts | read | Parts in the schematic and on the board |
| netlist | read | Schematic nets with their pins |
| run_erc / run_drc | read | Schematic / board checks; `run_erc` gives each violation an id and lists waived ones apart |
| set_erc_rule / set_erc_check / set_erc_option | write | The project's ERC: pin-type matrix entry (ok / warning / error), how a check reports (error / warning / ignore), power symbols needing a source |
| waive_violation / unwaive_violation | write | Accept one ERC violation with a reason (kept in the project, shown in Review), or count it again |
| list_rules | read | Available rules, project rulesets, defaults |
| set_rule | write | A ruleset (default) or a rule on specific objects |
| set_property / set_spec | write | Part properties / project requirements |
| add_part / connect_pins / add_label | write | Schematic editing |
| assign_footprint | write | Footprint of a part; reports the pin ↔ pad check (`pinPad`) at once |
| create_footprint | write | Footprint from datasheet dimensions: two-row, four-side, grid, castellated module or a pad list; exposed pad with vias, mounting holes; pads from the land pattern or derived from lead dimensions |
| create_symbol | write | Symbol from a pin table (pasted text or a list): sides by function, by package order or from the table; units and a power unit; updates placed copies when called again |
| place_unit / switch_unit | write | Place a unit of a multi-unit part that is missing (e.g. the power unit), or change which unit a symbol is |
| add_sheet | write | Hierarchical sub-sheet block with an empty sheet inside; `add_label kind=hier` inside adds a block pin, wired on the parent as `Block:NAME` |
| add_power | write | Power symbol (GND, a rail) with a short wire, or a PWR_FLAG |
| move_symbol | write | Move / rotate / mirror a symbol; wires follow; refused if connections would change |
| duplicate | write | Copy parts with their wires, power symbols and labels to an offset; new references |
| annotate | write | Renumber references in reading order (keep or reset, whole design or one sheet) |
| align / place_relative | write | Align or spread symbols; place a block of parts relative to an anchor (e.g. decoupling capacitors below U1) |
| compact_blocks | write | Pack the blocks of a sheet into rows, closer together; connections stay |
| tidy_wires | write | Move small parts so jogs straighten and re-route bends; connections are checked and never change |
| set_schematic_grid | write | Pin grid (1.27 / 2.54 / 5.08 mm) and wire grid of the project |
| add_bus / add_bus_entry | write | A bus named like `DATA[0..7]` or `I2C{SDA SCL}` (local, global or hierarchical), optionally labelling pins with its members in order; a bus entry beside a bus. Members connect by their net labels, across sheet pins in order, and by a global bus label everywhere, as in KiCad |
| set_sheet_frame / add_note / add_group_box | write | Drawing frame with title block; free text notes; titled boxes around a block of parts |
| update_pcb | write | Schematic → board sync |
| back_annotate | write | Board → schematic: renamed references, pin swaps and gate swaps written back (preview with `apply: false`) |
| swap_pads / swap_gates | write | On the board, swap the nets of two pads within the part's swap groups (`swapGroups`), or of two identical units |
| move_part / route / refill_pours | write | Board editing |
| search_parts / get_part | read | Find parts (project, generic, team library, KiCad libraries); `get_part` also takes a placed component's reference (U1) |
| search_footprints | read | Find footprints (generic, project, KiCad) |
| bom | read | BOM and price for N boards; parts without MPN, price or stock |
| place_part | write | Place a library part (every unit) on the schematic |
| assign_footprint | write | Change a footprint; the board is updated in place |
| set_part_info | write | MPN, manufacturer, datasheet, LCSC, value, DNP; `rename` for a new reference |
| import_offers / set_offer | write | Price and stock data (CSV / by hand) |
| import_kicad_library | write | Copy `.kicad_sym` / `.kicad_mod` into the project |
| auto_place / autoroute | write | Automatic placement and routing (vias never land on pads) |
| get_board_outline / set_board_outline | read / write | Board shape: read the (simplified) points / set a size or polygon |
| delete | write | Delete objects (uid, list, ref, selector); `purge_disabled` clears disabled leftovers |
| get_stackup / set_stackup | read / write | Layer stackup (including a flex preset) |
| impedance | read | Impedance from a width, or the width for a target impedance |
| net_lengths / tune_length | read / write | Net lengths, differential pairs and skew, serpentines |
| export_fab | writes a file | ZIP with Gerber, drill, BOM, pick-and-place |
| export_schematic | writes a file | Vector PDF (one page per sheet) or SVG of the schematic; light, black-and-white or dark; fit to a paper size |
| undo / redo / apply_ops | write | History, raw operations |

## Built-in agent

Besides Claude Code / Codex over MCP, Hassassin has its own agent that uses the same tools:

- **On the web:** the *Agent* tab of a project that has been *Shared*. It shows a task list, each tool
  step with its result, and formatted replies. Everyone who has the project open sees the agent's
  conversation live.
- **In the CLI:** `hassassin agent board.hpcb "add a status LED on 3V3" -o board.hpcb`, or with a share
  link so the edits are live. `--mode ask` answers without changing the project.

### Choosing the AI: subscription or API

| Choice | Needs |
|---|---|
| Claude Code | A Claude subscription (Pro/Max); sign in once with the **Sign in** button |
| Codex | A ChatGPT subscription; sign in once with the **Sign in** button |
| Claude API | `ANTHROPIC_API_KEY` in a `.env` file at the repository root (pay per use) |

Both CLIs are installed by `pnpm install` (dependencies of `apps/server`). When you send a message,
the server runs the chosen CLI on your machine with the Hassassin MCP server bound to the open
project: Claude Code's built-in tools are turned off, Codex runs in a read-only sandbox in an empty
folder, and *Ask* mode only gets read tools. Edits show up live like any other collaborator's.

Notes:
- The subscription backends are for a server on your own machine only (requests from other machines
  are refused): a subscription is personal. A server shared with other people should use the API.
- Claude Code is Anthropic software under its own license (not open source); Codex is Apache-2.0.
  Both are installed from npm and are not copied into this repository.

### Checklist, questions and AI Full

- The agent keeps a checklist of every piece of work (`update_tasks`), shown at the top of the Agent tab
  (spinner on the step in progress), and asks decisions with `ask_user`: questions with choices shown as a
  card with buttons and a free answer; the answers go back as the next message. Both work with every
  backend (the MCP server offers them to Claude Code and Codex).
- **New project** asks *AI Full* or *AI Assisted*. AI Full opens a wizard (what to build, requirements,
  limits for the agent's choices, the AI to use), shares the project and starts the agent, which works one
  stage at a time (requirements, schematic, components, layout, review) and stops after each with
  `finish_stage`; the Agent tab shows *Continue to <next stage>* and *Change something*. The mode is in the
  Project panel.

## Plugins

Plugins give the built-in agent tools from outside Hassassin (web research, distributor catalogues,
datasheets …; [docs/06-agent-plugins.md](06-agent-plugins.md)). A plugin is an MCP server that runs as
its own program over stdio. The owner of the server installs plugins once; each project switches them on
in the Agent tab (*Plugins*), and every backend (Claude Code, Codex, Claude API) gets the plugins that are
on, next to the Hassassin tools. The agent sees a plugin's tools as `<plugin>.<tool>`.

**Installing:** list the plugin in `plugins.json` in the server's data folder (`.data/` with
`pnpm run server`):

```json
{
  "plugins": [
    {
      "id": "echo",
      "name": "Echo (test plugin)",
      "version": "1.0.0",
      "publisher": "Hassassin tests",
      "description": "Returns the text it is given.",
      "permission": "read",
      "hosts": [],
      "command": "../apps/server/test/fixtures/echo-plugin.mjs",
      "args": [],
      "settings": [{ "key": "ECHO_KEY", "label": "Echo key", "secret": true, "required": true }]
    }
  ]
}
```

- `id`: lower-case letters, digits and `-` (not `hassassin`). `command`: a program, or a path relative to
  `plugins.json`; `.mjs` / `.js` files run with Node.
- `permission`: `read` (returns data only; also offered in *Ask* mode) or `propose` (may return proposed
  changes, which the agent applies with the Hassassin tools; *Agent* mode only). A plugin never gets a link
  to the project, so it cannot change it itself.
- `hosts`: the network hosts the plugin contacts, shown in the Agent tab and kept with every logged call
  (declared by the plugin; not enforced by Hassassin).
- `settings`: values the plugin needs (API keys …), given to it as environment variables. Their values go
  in `plugin-settings.json` next to `plugins.json`, never in a project:

  ```json
  { "echo": { "ECHO_KEY": "…" } }
  ```

  The Agent tab shows only whether each setting is filled in. A plugin gets its settings, `PATH` and
  `HOME`, not the server's own environment (no API keys of the server).

**Switching on:** Agent tab → *Plugins* → the switch of a plugin (editors only). The switches are part of
the project (`agentPlugins`), so they are one undoable step and travel with the file.

**Checks and failures:** before each agent message the server starts every plugin that is on, reads its
tools and stops it (cached for a minute; *Check again* in the Agent tab checks now). A plugin that is not
installed, not set up or not answering is left out with a note in the conversation, and the agent works
without it. A plugin that stops in the middle of a reply gives the agent an error for that call; the next
call starts it again (Claude API backend; the CLIs manage their own plugin processes).

**Log:** every plugin call is written to `plugin-log/<project>.jsonl` in the data folder (time, who asked,
plugin, tool, arguments with secret values replaced by `[secret]`, result size, the plugin's hosts); the
Agent tab shows the most recent calls.

### The bundled web plugin

Hassassin comes with one plugin, `web` (`plugins/web/`), listed on every server and off until a project
switches it on. It lets the agent research components on the web on its own: search, open pages, follow
links to the manufacturer's datasheet, try again with other words, and report the steps it took.

- Tools: `fetch_document` (a page: its readable text, or the text around given words, and its links with
  datasheet and PDF links first; a PDF: size, SHA-256 and approximate page count), `source_trust` (the trust
  level of an address without opening it) and `web_search` (through a Brave Search API key, optional).
- While it is on, the backend's own web search is switched on too: Claude Code's `WebSearch` tool, Codex's
  `--search`, the Claude API's web search tool (at most `WEB_MAX_SEARCHES` per message). Pages and documents
  are opened with `fetch_document`, so their trust level is known. Searches show as `web.search` in the
  Agent tab and the plugin log.
- **Source trust:** every result carries a level: `manufacturer` (the maker's own site), `distributor`,
  `unverified` (any other site: values from it need the user's approval) or `mirror` (datasheet mirror and
  aggregator sites: never trusted). The default lists are in `packages/core/src/sourceTrust.ts`; add or move
  domains in `source-trust.json` in the server's data folder:

  ```json
  { "manufacturer": ["acme-chips.com"], "distributor": [], "mirror": ["some-mirror.example"] }
  ```

- **Limits per message**, settings of the plugin in `plugin-settings.json` (`"web": { … }`):
  `WEB_MAX_SEARCHES` (10), `WEB_MAX_FETCHES` (25), `WEB_MAX_MB` (60, total download), `WEB_MAX_SECONDS`
  (600), `WEB_MAX_DOC_MB` (25 per document); `SEARCH_API_KEY` for `web_search`. When a limit is reached the
  tool says so and the agent reports what it found. The searches of Claude Code and Codex are not counted
  by Hassassin (only the Claude API's are limited).
- It only opens public http(s) addresses: an address that resolves to this machine or a private network is
  refused.
- Everything it returns carries a notice that it is data from the web, not instructions; the agent is told
  the same. Text on a page that addresses an AI agent ("ignore previous instructions", "note to the AI" …)
  is flagged in the result, and the agent tells the user about it.
- A site that refuses automated access (403 / 429) stays closed: the agent uses another official address
  or a distributor's copy, or gives the address to the user.
- `apps/cli/bench/research.ts` checks the research live: it asks a running server's agent for the
  datasheets of 20 parts and checks each answer (trust, a real PDF, the steps). It runs on the owner's
  agent backend, so only when the owner asks.

