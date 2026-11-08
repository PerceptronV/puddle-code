<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Frontend

#### Added

- Add Filetree huddle nodes with explicit worktrees, directories, glob filters, output exclusions and debounce settings. Saving remains inactive.
- Add Calendar and Date and time huddle nodes with explicit timezone, weekday, missed-event and past-date settings. Saved edits stay inactive; Apply/Start create fresh activation intent.
- Add Interval huddle nodes with duration and missed-occurrence settings. Start/Resume arm automatic triggers; editing and saving remain inactive.
- Build huddles with editable Prompt agent and Review agent nodes, project worktree/agent selectors, input variables in prompts and bounded feedback settings. Templates save ordinary source files; graph editing and execution remain separate.
- Start and apply saved huddle graphs, send manual input, interrupt/resume/stop execution and inspect paged results in the IDE on supporting local/SSH hosts. Failed replies require observation before another action; reconnect never resends input. Agent spawning and external triggers remain pending.
- Add New huddle to the session tray, collapsed rail and project menus, with explicit worktree selection and saved-huddle opening. Huddles open as separate pane content; creating/opening stays inactive.
- Edit huddle nodes, connections, parameter bindings, colours and icons using shared source drafts. Move nodes with mouse, touch, arrow keys or position fields; pan and fit the graph. Drag between sockets or use click/keyboard controls to connect nodes, and select wires to disconnect them. Manifest and layout drafts follow pane/window transfers, with separate undo histories and save-conflict review.
- Preserve huddle tabs through layouts and native window content. Application protocol 28 and desktop recovery format 4 require supporting clients; existing agent/terminal runtime contracts remain unchanged.

#### Changed

- Enabling Ripple starts its handle at the bottom with output and input covered; disabling it starts at the top for full CLI. Manual placement remains available on desktop and mobile.
- Use frontend terminology throughout the application, documentation and future releases while retaining compatibility with published versions.

#### Fixed

- Detach a conflict comparison before adopting shorter disk content, avoiding stale Monaco gutter ranges while retaining retryable comparison after a failed read.
- Cover the native terminal's leftmost column in Ripple so prompt markers and input do not appear twice when the handle is dragged to the bottom, on desktop and mobile.
- Refresh cached website favicons, installed web app icons and notification icons to use the new Puddle logo set.

### Daemon

#### Added

- Observe Filetree changes in independent huddle owners, using bounded metadata reconciliation and durable batches with optional `filetree: 1` support. Controller loss leaves observation running; interruption and failure fence scans before admission.
- Run calendar and one-off date triggers in independent huddle owners with durable consumption and optional `calendar: 1` support. Calendar schedules skip nonexistent local times, fire once during repeated times and bound missed-event recovery; completed dates stay consumed through Resume.
- Run huddle interval triggers in their independent owner through controller disconnection, with durable occurrence tracking, coalesce/skip/bounded catch-up and explicit `timers: 1` runtime support. Interrupt/Stop disarm timers; resource failures remain visible. Git/session subscriptions and reboot recovery remain pending.

- Support guarded creation of absent worktree files through `expected_mtime_ms: -1` (application 28.4). Concurrent creations and existing symlinks return a conflict without replacement.
- Dispatch huddle attach/ask scripts to explicitly bound live agents, sharing ordinary puddlang busy admission and preserving accepted turns through daemon handoff. Surface unsent refusals, retain uncertain sends, and persist exact cancellation attempts (database schema 46); agent graphs require huddle operation capability 2.
- Add internal huddle agent-turn admission with durable caller identities, shared result-capacity accounting and explicit owner acknowledgement before result reclamation (database schema 45). Custom scripts and shipped prompt/review nodes can attach to declared live agents; spawn/resume remains pending.
- Expose local/SSH huddle Start, Apply, Rearm, Run, Interrupt, Stop and live-history APIs (application 28.2). Run saved manual-input/local-script graphs in independent owners with reviewed activation targets; unsupported selectors and custom adapters remain gated.

- Bind internal huddle commands to the inspected owner and activation, rejecting stale queued actions. Add bounded live-owner history reads for execution, node and operation outcomes; IDE execution controls remain pending.
- Add revision-checked huddle manifest/layout saves over local/SSH connections. Detected concurrent source edits return a conflict; saves preserve unrelated files and stay inactive.
- Add local/SSH huddle creation, discovery, inspection and opening APIs. New huddles save as inactive graphs under separate random-id directories; creation requires a capable installed runtime. The IDE and IDE execution controls remain pending.

- Add preparatory huddle document validation and bounded source discovery for independent project definitions, including typed settings and bounded feedback graphs; runtime and UI enablement remain pending.
- Persist huddle session identities per project/worktree/definition and record their owners without terminal segments. Application protocol 27.0 requires a coordinated frontend/daemon update for the third session kind; huddle creation and lifecycle UI remain pending. Existing agent/terminal runtime protocol 1.1 is unchanged.
- Adopt surviving huddle owners alongside ordinary runtimes, update session status from bounded owner notifications, and retain unresolved resources after a crash. Daemon replacement observes completed work without replay; public creation and lifecycle UI remain pending.
- Check retained huddle contracts before selected-daemon startup, preserving read-only inspection and allowing compatible controllers to inspect interrupted huddles without replaying their work.
- Extend host runtime removal and release collection to huddles, rechecking Stop impact and retaining pinned software until clean shutdown and the existing later-boot barrier are proven.
- Preserve huddle identity and contract requirements through host-update preflight, shutdown checkpoints and fresh adoption/recovery. Candidate daemons must explicitly advertise huddle adoption support; existing agent/terminal metadata stays compatible.
- Add pinned huddle launch admission and exact-owner lifecycle controls, with durable Stop intent and ordinary session kill/archive integration. New owners start inactive; public Start/Run and the UI remain pending.

### Runtime

#### Added

- Queue huddle script asks durably through an optional private operation capability, with declared agent/worktree bindings, single-consumption dispatch claims and retained exact-result receipts. Preserve waiting workers across controller disconnect and refuse replay after lost replies.
- Define huddle event/readout contracts and an internal node execution boundary with validated ports, immutable inputs and acknowledged emissions, ahead of independent owner integration.
- Add a private huddle execution ledger with atomic trigger cursors, node routing, retained budgets and outcome reservations; preserve consumed operations through process loss without redispatch.
- Add durable huddle graph routing with correlated joins, explicit event fan-out and bounded coder/reviewer feedback; keep worker/service integration pending.
- Add isolated huddle script workers with captured multi-file imports, shared puddlang agent calls, bounded transport and cancellation; include the helper modules and smoke check in host archives.
- Persist immutable huddle revisions and exact activation bindings, and schedule manual graphs through isolated workers with bounded feedback, durable results and cancellation; independent owner-service integration remains pending.
- Compose an independent huddle owner with authenticated private control, shared ownership/memory admission and controllerless script completion; keep production creation gated pending capability, maintenance and daemon integration.
- Declare huddle runtime contracts in separate passive release metadata, validate pinned helpers/selection before admission, and verify required capabilities during owner startup/adoption without changing ordinary agent runtime selection.
