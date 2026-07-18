<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- `puddle refresh [local | user@host]`: stop the target's cockpit (even a wedged one) and run the full start/connect flow again — daemon restart if needed, fresh tunnel, handshake — keeping the old UI port so open tabs survive. Target defaults to the sole running cockpit.
- The same refresh from the UI: a bottom-anchored connection banner (shown when the daemon WebSocket stays down) and a ⌘K "Refresh connection" command drive the cockpit-local `POST /cockpit/refresh` control endpoint (Host/Origin-guarded + daemon bearer token; outside `PROTOCOL_VERSION` — the UI and cockpit ship together); the page reloads once the cockpit is back.
- `--prefer-port` on `start`/`connect`: a non-strict starting point for the UI-port probe (what `refresh` passes through internally).
- On Mac, ⌥+drag selects text in terminals whose TUI captures the mouse (e.g. Claude Code), so ⌘C copy works there too; Shift+drag has always worked.
- Drag a file from the tree or a session from the right sidebar (row or collapsed dot) onto a tiling pane to open it as a permanent tab, positioned in one gesture — centre inserts, an edge splits, same zones as tab drags.

### Changed

- Creating an agent is now labelled "New agent" everywhere (sidebar buttons, ⌘K, the modal's title and submit, the profile panel's account rows), with a robot icon instead of a plus — "session" stays the umbrella term over agents and terminals.
- "New terminal" joined the ⌘K palette alongside "New agent".
- Settings: the "Terminal & Editor" section is gone — the daemon agent search path and terminal scrollback moved into Sessions (order: permission gate, agent path, scrollback, launch text, tab title); tab size, word wrap, and the editor-link SSH host live in a new Editor section directly below Sessions. Old `#settings/terminal` links resolve to Sessions.
- The Files/Search worktree header ~-compresses the daemon home directory (`/home/…`, `/Users/…`) so the identifying tail of the path gets the width.
- File-tree icons are monochrome in the heading colour (navy in light, white in dark; per-type glyph shapes kept): colour on a tree icon now always means git status — default folders were gold, indistinguishable from the modified tint.

### Fixed

- Reloading a workspace no longer leaves every pane blank ("Loading editor…" / an empty terminal) until a tab click: the restored layout now mounts only after the Monaco/xterm chunks its tabs need are warm, so nothing suspends mid-restore — terminal-only workspaces still load no Monaco.
- Clicking inside a terminal now activates its tab (re-binding the left sidebar and claiming the URL), matching editor clicks: the kept-alive terminal's DOM is portal-rendered and physically adopted into the pane, so React's synthetic events never reached the pane's handlers — a native capture listener follows the real DOM instead.

- The settings button opens the dialog reliably: its open state is one `useSyncExternalStore` snapshot consumed by an always-mounted dialog (the profile panel's structure) — the previous per-consumer state copies behind a conditional mount could desync, turning the next click into a deduped no-op.
- Worktree directory names in the Worktrees navigator get the same hover-scroll as branch names (full path stays on the tooltip), and hovering a row no longer makes it jump — the appearing prune control used to exceed the row's resting height.
- Double-clicking a session in the right sidebar (row or collapsed dot) now pins its terminal tab, exactly like double-clicking a file — SPEC promised this; a single click still opens it as an italic preview tab.
- The left sidebar (file tree, search, changes) now follows the FOCUSED tab's worktree: every file/diff tab binds the worktree it was opened from, and clicking into an editor or terminal body activates that tab — previously the sidebar only tracked the URL-bound session, so file tabs never re-bound it and clicking inside a session changed nothing.
