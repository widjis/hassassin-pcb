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
| query | read | Find objects with a selector |
| inspect | read | Every computed rule and where its value comes from |
| list_parts | read | Parts in the schematic and on the board |
| netlist | read | Schematic nets with their pins |
| run_erc / run_drc | read | Schematic / board checks |
| list_rules | read | Available rules, project rulesets, defaults |
| set_rule | write | A ruleset (default) or a rule on specific objects |
| set_property / set_spec | write | Part properties / project requirements |
| add_part / connect_pins / add_label | write | Schematic editing |
| add_power | write | Power symbol (GND, a rail) with a short wire, or a PWR_FLAG |
| move_symbol | write | Move / rotate / mirror a symbol; wires follow; refused if connections would change |
| duplicate | write | Copy parts with their wires, power symbols and labels to an offset; new references |
| annotate | write | Renumber references in reading order (keep or reset, whole design or one sheet) |
| update_pcb | write | Schematic → board sync |
| move_part / route / refill_pours | write | Board editing |
| search_parts / get_part | read | Find parts (project, generic, team library, installed KiCad libraries) |
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
