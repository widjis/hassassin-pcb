# Work agreement: desktop app, local-first projects and chats

| | |
|---|---|
| Document | `docs/07-desktop-app.md` |
| Version | 0.3 |
| Status | **Draft 0.3 with the owner's answers, waiting for approval; to start after every item of [06-agent-plugins.md](06-agent-plugins.md) is done (AM1–AM3)** |
| Owner | Repository owner (widjis) |
| Implementer | AI coding agent working in this repository |
| Based on | Hassassin PCB 0.4.0 (tag `v0.4.0`) and the fixes after it |

This document proposes turning Hassassin into an installable desktop app that works **local-first**: the
editor, the server and the agent run on the user's machine; projects and their agent chats are files on the
user's disk; a collaboration server is only needed to work with other people, and it never stores chats or
runs agents for them. Once approved (see [Approval](#approval)), the implementer works through it in order;
changes only happen through the [change process](#9-change-process).

## 1. Goal

Install Hassassin like any desktop program, open or create a project, and work with the agent at once: no
"Share" step, no browser storage, nothing leaving the machine unless the user shares a project or the agent
uses a model or plugin. Each project keeps its own chats next to it, so opening a project opens its
conversations, and a new project starts with none.

## 2. Background

- **How it runs in v0.4.0:** `pnpm dev` (web app on 5178) plus `pnpm run server` (collaboration server on
  5179), or `pnpm start` (both in one process on 5179). Both need the repository, Node and pnpm.
- **Where things are stored today:**
  - A project opened from a file lives in the browser tab; autosave is one slot in the browser's
    `localStorage` (`hassassin:autosave:v1`); saving downloads a `.hpcb`.
  - A shared project lives on the server (`.data/projects/<id>/`: snapshot, transaction log, versions).
  - Agent chats: the visible history in the browser's `localStorage`, per shared project (last 200
    items); the running conversation in the server's memory (last 1200 events, dropped after 20 minutes
    idle); the CLI backends keep their own session files in their folders on the machine.
- **Problems this causes** (some found by the owner while using it):
  - The agent only works on a shared project, so a new or opened project needs "Share" first, and the
    agent's work is tied to a server project, not to the file the user opened.
  - Until `cc49148`, New project / Open kept the tab on the old shared project, so the agent read the old
    project; now the tab leaves it, but the user still has to share again to use the agent.
  - Chats live in one browser's storage: lost with the browser's data, not on another machine, not with the
    project file.
  - A hosted server that kept everyone's chats and ran everyone's agents would carry all that load; the
    subscription backends (Claude Code, Codex) may only run on the user's own machine anyway.
- **Owner's rules that apply:** Hassassin is a personal project; a release is GitHub only, never a
  deployment to office servers. The desktop app is therefore published as downloads on GitHub Releases, and
  any collaboration server is run by whoever wants one.

## 3. Scope

Three milestones, in order, started once [06-agent-plugins.md](06-agent-plugins.md) is done. DM1 makes the existing web app local-first (useful with `pnpm start` too), DM2
wraps it as a desktop app, DM3 keeps collaboration working between desktop apps. Each item has acceptance
criteria that can be checked; an item is done only when all of them pass.

### Milestone DM1 — local-first projects and chats

- [ ] **D1. The agent works on a project without sharing it.**
  - Every project open in the app is also open on the local server as a **private local project** (no share
    link, no tokens shown, reachable only from this machine), so the agent joins it as today's collaborator
    does: edits live, undoable, visible in History.
  - "Share" becomes "Invite others": it publishes the project to a collaboration server (DM3); until then
    nothing about the project leaves the machine.
  - New project / Open start a new local project; the previous one stays as it was (saved or autosaved).
  - Acceptance: File → New project, then a message to the agent: the agent reads the new, empty project and
    edits it, with no Share step; the old project is untouched; nothing is sent to another host (checked
    with the server's request log).
- [ ] **D2. A project on disk with its own data.**
  - A project is a `.hpcb` file with a companion folder (owner's choice) next to it (`<name>.hassassin/`) holding what belongs
    to the project but not to the design: agent chats (D3), the plugin call log (A1), stored datasheets (A3),
    saved versions, the undo history since opening, and the autosave.
  - Opening a `.hpcb` without a companion folder works as today; the folder is made on first save. A KiCad
    project opened directly gets its folder next to the `.kicad_pcb` once saved as `.hpcb`.
  - Acceptance: a project saved, closed and opened again comes back with its chats, versions and plugin log;
    copying the file and its folder to another machine carries all of it; the `.hpcb` alone still opens.
- [ ] **D3. Chats belong to their project.**
  - Each project can hold several chats (list, new, rename, delete), stored in its folder as one file per
    chat (the full transcript, append-only); opening a project shows its chats, a new project has none.
  - The server keeps only the running conversation in memory; finished turns are written to the project's
    folder at once, so nothing is lost when the app closes.
  - Long chats stay usable: the transcript on disk keeps everything, while the model gets the recent turns
    plus a summary of the earlier ones (the summary is stored with the chat and shown on request).
  - Chats from the browser's storage (v0.4.0) are offered for import into the project they belong to.
  - Acceptance: two projects with their own chats, switching between them shows each one's chats only; a chat
    of 500 turns opens in under a second and the agent still answers with its context; closing the app in the
    middle of a reply keeps every finished turn.
- [ ] **D4. Saving and autosave on disk.**
  - Save writes the `.hpcb` in place (no download); Save as; a list of recent projects.
  - Autosave writes to the project's folder every few seconds after a change; after a crash the app offers to
    restore it, per project (not one slot for all).
  - Acceptance: edits survive killing the app; two projects edited one after the other each restore their
    own work.

### Milestone DM2 — desktop app

- [ ] **D5. The app shell.**
  - The shell is **Electron** (owner's choice; it carries Node, which the server and the agent CLIs need). It
    starts the local server (on a free `127.0.0.1` port, with a secret per launch so other
    programs on the machine cannot use it) and opens the editor in its window. One instance; opening a file
    while it runs opens it in the running app.
  - Native menus (File: New, Open, Open recent, Save, Save as, Export; Edit; View; Help), file associations
    for `.hpcb` and `.kicad_pcb`, drag-and-drop of files onto the window.
  - The browser version (`pnpm dev`, `pnpm start`) keeps working from the same code.
  - Acceptance: double-clicking a `.hpcb` opens it in the app; a second launch focuses the first; the
    server refuses requests without the launch secret and from other hosts.
- [ ] **D6. Files through the system.**
  - Open and save through the system dialogs; exports (Gerber ZIP, KiCad board and schematic, netlist, PDF
    / SVG) written to a folder the user picks, with "Show in Finder / Explorer".
  - The KiCad libraries (S21) are found where KiCad installs them, or downloaded into the app's own data
    folder.
  - Acceptance: every export of v0.4.0 works from the app's menus and writes real files.
- [ ] **D7. Agent backends and secrets on the desktop.**
  - The Claude Code and Codex backends come with the app (installed as today's server dependencies) and sign
    in from the Agent tab as today; the Claude API key and plugin secrets (A1) are kept in the system's
    keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux), not in `.env` files.
  - Acceptance: a fresh install signs in to Claude Code and runs the agent on a new project; an API key typed
    once is used after a restart and is not found in any file of the app or the project.
- [ ] **D8. Packages and releases.**
  - **macOS first** (owner's choice): builds for Apple silicon and Intel, made by a script in the repository
    and attached to a GitHub Release; versions follow the repository's tags. Windows (x64) and Linux
    (AppImage) builds come once the app is ready for version 1.0.0; until then the code keeps them possible
    (no macOS-only calls outside the shell's small interfaces), but they are not built or tested.
  - The app checks GitHub Releases for a newer version and says so (it does not update itself).
  - **Unsigned builds for now** (no Apple Developer account yet): the release notes say how to open them
    (right-click → Open, or System Settings → Privacy & Security → Open Anyway). Signing and notarisation
    are added when an account exists, as a change to this document.
  - Acceptance: the macOS builds install and open the solar sample on the owner's Mac (Apple silicon) and on
    an Intel Mac or under Rosetta; the Windows and Linux checks are part of the 1.0.0 release.

### Milestone DM3 — collaboration between desktop apps

- [ ] **D9. Invite others through a collaboration server.**
  - A project can be published to a collaboration server the user names (one they or a colleague run with
    `pnpm run server` or a container); the link invites others, who open it in their own app or browser.
  - The collaboration server keeps the shared document, its versions, presence and comments only: **no agent
    chats and no agent runs.** An agent always runs in the app of the person who asks it, joins the shared
    project as their collaborator, and keeps its chat in that person's project folder.
  - The local copy stays in sync while online and can be saved as a file at any time.
  - Acceptance: two apps on two machines edit one project through a collaboration server; each person's agent
    edits it live for both; the server's data folder holds no chat and its process starts no agent.

## 4. Out of scope

- A hosted service: accounts, billing, a public collaboration server run by this project.
- Mobile and tablet apps.
- Automatic updates that replace the app by themselves (the app only tells about a new version).
- App store distribution (Mac App Store, Microsoft Store).
- Offline models (the agent needs Claude Code, Codex or the Claude API as today).

## 5. Working rules (binding for the implementer)

The working rules of [04-schematic-improvements.md](04-schematic-improvements.md) section 5 apply
unchanged (clean room, permissive dependencies, English in the repository, every change through the
command layer, editor actions also as tools, no regressions, order of this document, honest reports),
plus:

1. **Local-first:** nothing about a project leaves the machine unless the user invites others (D9) or the
   agent uses a model or a plugin; each of those is shown in the app.
2. **One code base:** the desktop app and the browser version share the editor and server code; desktop-only
   parts (shell, keychain, dialogs) sit behind small interfaces with a browser fallback.
3. **No hosting:** releases are GitHub downloads; nothing is deployed to any server by this work (the
   owner's rule for this personal project).
4. **Secrets in the keychain:** API keys and plugin secrets are never written to project files, the app's
   data files or logs.
5. **Old projects keep opening:** every `.hpcb` of v0.4.0 opens unchanged; chats in the browser's storage
   can be imported (D3).

## 6. Verification

| Kind | Used for |
|---|---|
| Automated tests (Vitest) | Local projects without sharing (D1), project folder round trip (D2), chats per project, summaries and crash safety (D3), autosave per project (D4), server secret and host checks (D5), no chats on the collaboration server (D9) |
| Browser / app check | D1–D7 and D9 with screenshots in the milestone notes |
| Install check | D8: the macOS packages on the owner's Mac (Windows and Linux at 1.0.0) |

## 7. Definition of done (per milestone)

- Every item of the milestone checked in this document, with its acceptance criteria met.
- `pnpm typecheck` clean, `pnpm test` passing, `pnpm build` succeeding (and the packages building, DM2).
- `docs/02-roadmap.md`, `docs/03-agents.md` and the README updated; a short demo added.
- A tagged release with notes listing what changed and what is still limited.

## 8. Progress tracking

The checkboxes in [section 3](#3-scope) are the status. The implementer ticks an item in the same commit
that completes it, and adds the commit id after the item name.

## 9. Change process

- Adding, removing or changing an item needs the owner's approval in writing (chat or commit).
- Every approved change is recorded below, with the date and a short reason, and the document version
  goes up (0.2, 0.3 …).

### Owner's answers to the open questions (2026-11-16)

1. Desktop shell: Electron (D5).
2. Systems: macOS first; Windows and Linux when the app reaches 1.0.0 (D8).
3. Code signing: no Apple Developer account yet, so unsigned builds for now (D8).
4. Project on disk: a `.hpcb` with a companion folder (D2).
5. Order: after every item of [06-agent-plugins.md](06-agent-plugins.md) is done.

### Change log

| Version | Date | Change | Approved by |
|---|---|---|---|
| 0.1 | 2026-11-16 | First draft | — |
| 0.2 | 2026-11-16 | Owner's answer on systems: macOS first, Windows and Linux at 1.0.0 (D8, verification). Other open questions still open. | Answer by the owner in chat |
| 0.3 | 2026-11-16 | Owner's answers: Electron (D5), unsigned macOS builds until there is an Apple Developer account (D8), `.hpcb` with a companion folder (D2), work after all of 06 (AM1–AM3). | Answers by the owner in chat; approval pending |

## Approval

By approving, the owner agrees to the scope, the acceptance criteria and the working rules above.

| Role | Name | Date | Version approved |
|---|---|---|---|
| Owner | | | |
