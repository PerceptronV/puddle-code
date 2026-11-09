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

- Configure huddle trigger queue, coalesce and drop policies with per-trigger bounds, durable history and unchanged running work; require runtime admission-1 (application 28.29).

- Add Monthly / yearly huddle schedules with explicit month/day selection, skipped missing dates and durable catch-up, requiring runtime calendar-2 (application 28.28).

- Preview resolved huddle node settings with local sample variables, including missing/type errors, without saving samples or activating resources.

- Expose retained huddle graph/layout drafts when their placement is missing, and preserve discard review for tab-button and Close tab actions without a session row.

- Recover retained huddle graph/layout drafts when their project is unavailable, with downloads and grouped close review; label huddles correctly in CLI status and tab tooltips.

- Add Start and run for stopped huddles: review saved revision, variables and manual input together, then send once after confirming the active graph; uncertain replies require inspection.

- Preview huddle prompt settings with local sample JSON, showing missing fields and size errors before execution; share formatting with shipped agent and Format text scripts.

- Create huddles from Manual flow or Two-agent review starters, with editable scripts, layout, README and sample input. Review requires explicit agent choices and stops after five rounds; creation stays inactive (application 28.27, also CLI/MCP and authoring kit).

- Copy saved huddles from New huddle into fresh stopped placements, preserving scripts, layout, docs and fixtures without copying runtime state; expose the same reviewed operation through CLI/MCP (application 28.26).

- Add editable Transform, Format text, Condition, Merge and Join huddle nodes to the existing catalogue, with matching authoring-kit source and a runnable conditional/fan-out example (application 28.25).

- Add an editable Write report huddle node with explicit worktree/path settings, atomic creation that preserves existing files, and delivery observation through the existing readout machinery (application 28.22).

- Check uncertain readout deliveries after a huddle stops, using recorded History or CLI/MCP. Reuse the captured observation adapter without restarting the graph or sending another delivery (application 28.21).

- Add editable native-confirmed Prompt/Review agent nodes with a completion-trigger selector. Reuse existing agent lifecycle and native turn observation, continuing once within the original execution and feedback limits (application 28.20).

- Automatically recover armed Linux huddles from verified owner crashes through existing lifecycle reconciliation, respecting Stop/archive/maintenance and a retained three-replacement limit (application 28.19).

- Recover a crashed Linux systemd/cgroup-v2 huddle explicitly after its recorded script scope is confirmed empty, reusing existing queued-work recovery without replaying agent actions (application 28.18).

- Inspect huddle trigger health and accepted backlog from the IDE or CLI/MCP, including timer coalescing/skipping and one-off date disposition; reuse existing subscriptions and lifecycle feeds (application 28.17).

- Add an opt-in Auto-start after reboot setting for huddle runs, restoring only armed runs through existing recovery while preserving schedules/cursors; expose the same setting in CLI/MCP (application 28.16).

- Recover a huddle after a verified host reboot from the IDE or CLI/MCP, preserving its active graph, queued events and trigger cursors; interrupt in-flight scripts without replaying uncertain agent operations (application 28.15).

- Add editable Resume agent and Restart agent huddle nodes, reusing normal session controls, exact conversation/worktree bindings and retained replacement results; uncertain replies never repeat the lifecycle action (application 28.14).

- Configure huddle execution limits, owned-agent cleanup and node concurrency in the IDE, using the existing draft, undo, Save and explicit Start/Apply flow.

- Inspect a stopped huddle's recorded activation and an execution's original source from History; CLI/MCP also compare retained revisions with exact saved source without restarting owners (application 28.13).

- Inspect retained huddle executions, results and operation outcomes after Stop through the IDE and CLI/MCP; browse recorded runtimes without starting owners or treating recorded state as live evidence (application 28.12).

- Guard huddle graph/layout saves against captured source changes, retain baselines in browser/window drafts, and review changed dependencies before merging; preserve edits typed during saves and require review after uncertain replies.

- Read exact captured huddle source and save manifest/layout text against its reviewed digest through CLI/MCP (application 28.11), preserving formatting and rejecting stale saves without automatic retry.

- Cull off-screen huddle nodes and connections while preserving crossing wires, selection, keyboard focus and active gestures; retain full graph access through Node list and fit controls.

- Restore huddle pan/zoom, node and connection selection, and graph/list mode across tab reopening, browser reload and pane/window transfers. Keep duplicate views independent and navigation out of tracked source files.

- Read a packaged huddle authoring kit through CLI/MCP: structural JSON Schemas, generated wrapper types, editable script/trigger/readout examples and fake fixtures, without connecting to a host or changing project files.

- Inspect retained huddle source and bindings and compare saved files/contracts before Apply, through the IDE and CLI/MCP (application 28.10); preserve reviewed targets/digests, support missing project source and keep all review operations read-only.

- Inspect huddle session status and archive/unarchive placements through CLI/MCP, sharing sidebar shutdown and cleanup semantics; verify profile/kind before dispatch and leave restored huddles stopped.

- Create/open inactive huddles and inspect, start, apply, run, interrupt, resume, stop and read their history through CLI/MCP tools. Require reviewed JSON requests and preserve exact targets without automatic mutation retries; expose readout observation on supporting hosts.
- Inspect and validate saved huddles with `pudl huddle list|inspect|validate` and matching MCP source tools, using explicit project/worktree scope without running scripts or activating graphs.
- Add Edit with agent to huddles, with an explicit authoring account, exact worktree/task context and bundled huddle skill. Preserve ordinary permissions, block unsaved source and keep activation separate from agent edits.
- Add Prompt spawned agent and Review spawned agent nodes with explicit worktrees and handles retained across feedback rounds. Explain retained inputs in the inspector and gate the templates on supporting hosts.
- Add an editable Spawn agent huddle node with explicit project, worktree, provider and account choices, input substitution, session mode/title and reply/handle outputs. Preserve unavailable selections and gate authoring on supporting hosts.
- Add Session lifecycle huddle nodes with explicit worktrees, optional stopped/archived session selection and event/status filters. Saving remains inactive.
- Add Git huddle nodes with explicit worktree/repository selection, ref globs, HEAD observation and debounce settings. Saving remains inactive.
- Add Filetree huddle nodes with explicit worktrees, directories, glob filters, output exclusions and debounce settings. Saving remains inactive.
- Add Calendar and Date and time huddle nodes with explicit timezone, weekday, missed-event and past-date settings. Saved edits stay inactive; Apply/Start create fresh activation intent.
- Add Interval huddle nodes with duration and missed-occurrence settings. Start/Resume arm automatic triggers; editing and saving remain inactive.
- Build huddles with editable Prompt agent and Review agent nodes, project worktree/agent selectors, input variables in prompts and bounded feedback settings. Templates save ordinary source files; graph editing and execution remain separate.
- Start and apply saved huddle graphs, send manual input, interrupt/resume/stop execution and inspect paged results in the IDE on supporting local/SSH hosts. Failed replies require observation before another action; reconnect never resends input.
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

- Resolve huddle integration secrets from exact private host grants, keeping references in source and values in worker memory; check availability before activation and redact worker diagnostics (application 28.23).

- Observe retained readouts only after confirmed clean owner shutdown, under existing runtime/writer claims. Bound observation to one worker and drain it for maintenance/shutdown; retain outcomes in the original ledger.

- Support opt-in huddle `askNative()` confirmation through existing asks and completion feeds, retaining exact native evidence atomically with source cursors. Suppress automated roots and reject changed subscriptions without resending prompts; gate source on `nativeFeedback: 1`.

- Retain explicitly scoped huddle inputs once per execution, joining them with later feedback activations without creating new agents or mixing root events. Reject competing deliveries and commit newly ready joins atomically within execution/storage budgets.
- Advertise huddle spawn support after integrating admission, dispatch, cleanup and authoring. Honor each execution’s captured stop-owned/retain-owned policy across Apply; retained agents stay under ordinary session controls.
- Clean up exact huddle-owned agents on Interrupt, Stop and execution failure/deadline, retaining cleanup intent across controller loss and lost replies. Keep Stop pending until exit is confirmed and leave attached or replacement agents under their existing lifecycle rules.
- Resolve huddle account/provider/project resources at Start and Apply, rechecking profile, login, provider support and registered worktrees before dispatch. Reject spawn-resource graphs on unsupported owners without changing their active revision.
- Automatically dispatch huddle spawns and subsequent agent prompts through one bounded daemon queue, recovering accepted creation across controller replacement without replay. Preserve agents during maintenance/controller loss and distinguish definite admission refusal from uncertain outcomes.
- Connect the independent huddle owner to bounded private spawn messages, preserving claims and readiness across controller reconnection. Reject unsupported commands without dropping older-owner connections.
- Add an owner-local huddle spawn outbox with retained claims/readiness, declared resource checks and execution-scoped handles for subsequent agent prompts. Share bounded worker waits with attach/ask and verify an isolated node-to-agent round trip after a lost spawn reply.
- Add host-side huddle agent creation, retained readiness receipts and exact-runtime cleanup through existing session/runtime services. Database schema 49 preserves readiness and consumed stop attempts across lost replies; cleanup leaves replacement agents untouched.
- Retain huddle spawn placement and exact runtime admission atomically in database schema 48, preserving consumed identities across lost replies and excluding undispatched placements from automatic boot resume. Keep ownership tied to the original runtime after a placement is resumed.

- Execute project-local HuddleReadout adapters with captured inputs, durable delivery intent, idempotency keys and retained delivered/failed/unknown outcomes. Share bounded workers and cancellation, and release outputs only after acknowledged delivery and worker exit. Application 28.5 adds delivery declarations; runtime `readouts: 1` gates support.
- Check uncertain readout deliveries from history with their original captured adapters, without resending or resuming ended graphs. Application 28.6 and runtime `readoutObservation: 1` gate exact-owner observation, sharing worker limits and lifecycle cancellation; known receipts survive lost replies. Offline-owner reconciliation remains pending.
- Run project-local HuddleTrigger adapters in independent bounded workers, with durable event/cursor admission, explicit resume policy and source health in the IDE. Application 28.7 and runtime `customTriggers: 1` gate support; healthy sources continue after another adapter fails. Subscriptions survive controller disconnection, while Interrupt/Stop/Apply fence callbacks and await worker exit. Managed secrets and automatic owner-crash recovery remain pending.
- Add Turn completed nodes with explicit worktree/live-agent settings and automatic exact native completion delivery. Preserve durable cursors through reconnects and lost acknowledgements; bound active polling, fence maintenance reads and fail visibly on confirmed source changes.
- Capture exact native-agent baselines after queued huddle Arm/Apply review, using optional `completionPlans: 1` read-only owner plans and runtime/provider availability checks. Recheck authority and targets before dispatch.
- Retain bounded session lifecycle/status observations atomically with their source writes (database schema 47), with scoped private pages and explicit cursor gaps. Deliver lifecycle/status pages to supporting huddle owners with durable cursors, reconnect catch-up, fresh Start/Resume/Apply baselines and visible gap failures.

- Observe Git refs and worktree HEAD in independent huddle owners with durable net-change batches, common-directory deduplication and optional `git: 1` support. Retain old/new OIDs and symbolic targets through force updates and branch switches.
- Observe Filetree changes in independent huddle owners, using bounded metadata reconciliation and durable batches with optional `filetree: 1` support. Controller loss leaves observation running; interruption and failure fence scans before admission.
- Run calendar and one-off date triggers in independent huddle owners with durable consumption and optional `calendar: 1` support. Calendar schedules skip nonexistent local times, fire once during repeated times and bound missed-event recovery; completed dates stay consumed through Resume.
- Run huddle interval triggers in their independent owner through controller disconnection, with durable occurrence tracking, coalesce/skip/bounded catch-up and explicit `timers: 1` runtime support. Interrupt/Stop disarm timers; resource failures remain visible. Reboot recovery remains pending.

- Support guarded creation of absent worktree files through `expected_mtime_ms: -1` (application 28.4). Concurrent creations and existing symlinks return a conflict without replacement.
- Dispatch huddle attach/ask scripts to explicitly bound live agents, sharing ordinary puddlang busy admission and preserving accepted turns through daemon handoff. Surface unsent refusals, retain uncertain sends, and persist exact cancellation attempts (database schema 46); agent graphs require huddle operation capability 2.
- Add internal huddle agent-turn admission with durable caller identities, shared result-capacity accounting and explicit owner acknowledgement before result reclamation (database schema 45). Custom scripts and shipped prompt/review nodes can attach to declared live agents; resume/restart remains pending.
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

#### Fixed

- Recover huddle snapshots left in WAL mode by a real crash, converting only the private serialized copy before opening it in memory and preserving committed queued work.

- Preserve byte-order marks in captured huddle scripts and digest checks; reject BOM-prefixed JSON documents instead of silently changing their source bytes.

### Runtime

#### Added

- Recover crashed macOS launchd huddles after recorded kernel coalition evidence confirms all script descendants have ended; reuse normal service retirement and the existing queued-work recovery path (application 28.24).

- Retain exact huddle ask/spawn caller identities with durable intent, preserving receipt and cleanup scopes across mailbox reconstruction without replaying consumed operations; owner replacement remains unfinished.

- Add a huddle completion-subscription ledger with exact native targets, atomic page/cursor admission and suppression of automated feedback echoes. Optional `completionEvents: 1` adds private owner delivery, lifecycle baselines and captured-script execution.
- Retain exact hook-based interactive, structured Codex and command-correlated headless turn observations in a bounded independent stream across controller disconnection (runtime protocol 1.2), with explicit gaps, persistence status and originating ask/huddle identities. Headless completion requires native identity binding, a successful result and exit 0. Codex preserves RPC attribution through early events and cancellation, and keeps conversation scope ordered within native batches. Keep older controllers compatible.

- Queue huddle script asks durably through an optional private operation capability, with declared agent/worktree bindings, single-consumption dispatch claims and retained exact-result receipts. Preserve waiting workers across controller disconnect and refuse replay after lost replies.
- Define huddle event/readout contracts and an internal node execution boundary with validated ports, immutable inputs and acknowledged emissions, ahead of independent owner integration.
- Add a private huddle execution ledger with atomic trigger cursors, node routing, retained budgets and outcome reservations; preserve consumed operations through process loss without redispatch.
- Add durable huddle graph routing with correlated joins, explicit event fan-out and bounded coder/reviewer feedback; keep worker/service integration pending.
- Add isolated huddle script workers with captured multi-file imports, shared puddlang agent calls, bounded transport and cancellation; include the helper modules and smoke check in host archives.
- Persist immutable huddle revisions and exact activation bindings, and schedule manual graphs through isolated workers with bounded feedback, durable results and cancellation; independent owner-service integration remains pending.
- Compose an independent huddle owner with authenticated private control, shared ownership/memory admission and controllerless script completion; keep production creation gated pending capability, maintenance and daemon integration.
- Declare huddle runtime contracts in separate passive release metadata, validate pinned helpers/selection before admission, and verify required capabilities during owner startup/adoption without changing ordinary agent runtime selection.
