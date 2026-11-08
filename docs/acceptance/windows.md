# Detached desktop windows

Implementation in progress, 2026-11-08. Design intent is in
[the roadmap](../roadmap/windows.md). This document records delivered code and
verification; pending items are not support claims.

## Implemented foundation

- `desktop/src/windows/hosts/connections.ts` owns one cockpit connection per target and
  multiple independent window identities. Opening windows shares pending connects;
  closing the last window retires the connection. Refresh and retirement are
  serialised, including late connections during app quit.
- `desktop/src/main.ts` uses that registry for native windows, refresh, menu
  routing, prompt parents, and application teardown. Closing a host window leaves
  its sibling windows' connection alive.
- `desktop/src/reopen.ts` reads legacy target-only entries and new identified
  host/project/pane entries, preserving several windows on a host. Saved routes
  exclude queries, fragments, credentials, and external URLs. Native placement
  and SPA destinations are captured during use as well as orderly quit.
- `desktop/src/windows/persistence/state.ts` owns versioned working sets and dirty-buffer
  snapshots independently of renderer lifetime. Preparation retains the source;
  destination readiness followed by source confirmation commits both revisions
  in one atomic write.
  Startup cancels unaccepted preparations and retains committed outcomes.
- Private main-frame IPC resolves the window/host from the registered sender.
  Desktop workspace writes are serial and revisioned. Lost write replies are
  observed before another write is attempted. The profile seed for independent
  browsers combines the host workspace with its open detached workspaces.
- The existing shell/workspace now render host, project, and pane presentations.
  Detached windows use native title bars; pane windows keep their pane at narrow
  widths. Their profile is fixed by native identity. Editor buffers, untitled
  content, Monaco views, notebook/preview scroll, and PDF zoom have desktop capture
  hooks. Browser persistence retains its existing path.
- Native close and Command-Q request a bounded checkpoint from each registered
  renderer before teardown. The renderer fences interaction, drains loaded
  profiles and dirty buffers, and acknowledges only after durable writes finish.
  A failed or missing acknowledgement cancels closure and resumes editing;
  renderer reload/crash invalidates outstanding commands. Quitting retains the
  arrangement, while explicit closure removes its window from the reopen set.
- Native Reload/Force Reload, the refresh controller and the render-error reload
  action now checkpoint before replacing the renderer (application 26.10's
  optional reload bridge). Host refresh checkpoints all its windows before
  stopping the shared cockpit and resumes same-origin survivors. Navigation is
  serial per host, duplicate requests join one operation, and Command-Q drains
  it before checkpointing again. Failed saves preserve the original connection.
- `web/features/windows/transfers/content/transfer-content.ts` provides the pane extraction
  projection. It preserves tab order, active and
  preview selection, view state, and relevant dirty buffers; duplicate source
  views keep their recoverable text. Other project slices and orphaned recovery
  drafts stay with the source. Mixed-project panes move intact with the current
  project as their anchor.
- The pane tab-strip context menu now offers **Open pane in window** on native
  host/project windows. `desktop/windows/transfers/coordinator.ts` stages the destination,
  waits for its shared Workspace to mount, and then requires source confirmation.
  Source/destination renderers remain fenced during handoff. Failure or timeout
  rolls back; uncertain replies are observed without repeating the move. A dirty
  edit before confirmation cancels the move; one arriving afterward remains open
  in source recovery and is persisted. Application protocol 26.8 carries the
  capability-detected private lifecycle/transfer bridge.

- File-tree rows, editor tabs (including untitled/diff/preview tabs), and the
  shared session menu now open individual items in pane windows. An existing
  source view moves; unopened items create a view. Other duplicate views retain
  their dirty state. A same-host/profile pane that already contains the item is
  raised and its tab activated. Session moves retain the original session id.
  Cross-project actions preserve the source route. The private lookup/activation
  capability is application protocol 26.9.
- View-state handoff translates project-layout keys into the detached pane's
  scope. The preparatory docking projection keeps duplicate editor views,
  remaps colliding pane ids and their view keys, retains unrelated project slices,
  and moves an existing terminal view instead of creating two in one renderer.
  Different dirty text or saved baselines for the same file reject the merge.
  The pane context menu now offers **Return pane to …** for existing host/project
  windows on the same host/profile (application 26.11). The destination must have
  that profile selected. With no destination open, the menu explains that a host
  or project window must be opened; the detached pane remains usable independently.
- Existing destinations plan against their exact revision, then release their
  mounted views before staging the merged working set. The same Workspace,
  editor and terminal components remount and acknowledge readiness. Cancellation
  restores the original presentation and route; temporary navigation is not
  written into the reopen record before commit. An existing clean editor receives
  the incoming dirty text. Native view-state reads prefer the imported selection
  over a stale cache from an earlier presentation of the same pane.
- After docking commits, the source releases its models and checkpoints again.
  Its native window retires only if the exact committed source is empty, with no
  dirty buffers. Remaining tabs or late cleanup edits keep it open, with recovery
  drafts visible. Failure to retire leaves it editable and never repeats the move.
- Detached pane strips now support native drag to an existing host/project pane
  (application 26.12). Drag the blank strip area, or the thin top edge when there
  is one tab. Edge drops preserve placement; a centre drop places the whole pane
  to the right. The host's currently visible project receives the drop. The main
  process accepts only a registered, single-use source offer from the same
  host/profile; offers expire after a minute and are invalidated on renderer
  replacement. The payload contains identities and a nonce, never dirty text.
  Source commands start the same acknowledged handoff as menu return. A lost
  command acknowledgement cannot dispatch the offer again. Destination highlights
  expire when drag events cease, including cancellation in another window.
- Native file-tree and session-sidebar drags, and individual native tab-strip
  drags, now transfer into existing host/project/pane windows (application 26.13).
  Strip and centre drops merge into the chosen pane, pin and activate the item;
  edge drops split it. Existing destination tabs, drafts and their view positions
  survive staging. Different dirty copies reject the transfer. A matching source
  view moves; an unopened row creates a view, and other duplicate source views
  keep their dirty text. A following preview whose target changed after drag
  registration rejects the stale tab move. Fixed destination windows retain their
  project anchor; host destinations use the visible project. The source retains
  its project route, removing a moved session's URL suffix so it cannot reopen it.
- Native tab moves within one window use the existing layout operations and
  preserve move versus sidebar-copy behaviour. Strip drops include an insertion
  position; keyboard dragging retains dnd-kit. A detached single-tab window's thin
  top edge still offers its whole pane. Ordinary browser dragging is unchanged.
  File-move, multi-session archive and sidebar-reorder companion payloads now carry
  native window/host/profile scope; another window cannot treat those references
  as local operations. Cross-window tab offers alone enter the transfer coordinator.

- The project handoff foundation now has a pure extraction/return projection and
  a private `plan-project` destination command (application 26.14). Project-based
  layouts move the selected tree intact, including mixed-project tabs. Profile-wide
  layouts partition by session ownership; untitled files follow the current
  project, and unknown sessions remain with the source. Return preserves other
  workspace trees, duplicate editor views, remapped view positions and sidebar
  state. Conflicting dirty text rejects the merge; orphaned incoming drafts become
  visible recovery tabs.
- The durable store now distinguishes a returned project from an open project.
  Returned records remain outside native reopen state but inside the combined
  profile seed. The coordinator can restore one into a host renderer using the
  existing staged handoff, without a live source renderer. Commit consumes the
  return record atomically; cancellation or interrupted preparation retains it.
  Reopening preserves its exact workspace.
- Project menus on dashboard cards and sidebar headers now use that handoff
  (application 26.15). The native registry enforces one dedicated project owner;
  repeated opens focus it. Shared routing mediates links, imperative navigation
  and initial/history visits, including session destinations. A detached window
  can request another project through its host, opening that host if needed.
  Explicit project close checkpoints and retains its return state without needing
  a host window; Command-Q preserves its open arrangement. With no host open,
  **Return project to host** uses the same close policy. The next host visit restores the workspace;
  a new-window request can instead reopen it. Failed native creation leaves the
  return record intact. Moved views are removed from inactive historical slices,
  and mode changes after return derive the project's latest workspace.

- Dedicated project labels now register native project drag offers in expanded
  and collapsed sidebars (application 26.16). A same-host host window accepts the
  drop across its workspace or dashboard; select the matching profile first.
  The menu return action uses the same live handoff when a host is open. Source
  models unmount before final capture, including cleanup edits; the host accepts
  the complete project merge before the source confirms. Commit atomically closes
  project ownership and preserves destination content, then dismisses the source.
  Interrupted preparations retain the source; committed moves cannot reopen an
  empty dedicated owner. Cancellation remounts the original project; an uncertain
  outcome remains fenced for recovery. Drag payloads carry no document content.
- Native reload preserves saved active editor tabs when the URL still carries
  the last session binding. Explicit session/notification activation still opens
  its terminal and is consumed so a subsequent reload does not repeat it.
- Window implementation and tests are grouped by responsibility. Web modules
  use `state/`, `transfers/content/`, `drag/`, `navigation/`, `lifecycle/` and
  `menus/`; context and renderer composition stay at the root. Desktop modules
  use `hosts/`, `persistence/`, `lifecycle/` and `transfers/`, with registry/IPC
  composition at the root. Private shared contracts live in
  `shared/src/desktop/windows/` and retain the public package exports. Browser
  fixtures and current documentation reference the new paths directly.

- Named layout storage now accepts an optional version-1 window arrangement
  alongside its ordinary tree (application 26.17, migration 42). Logical slots
  contain only pane structure, project anchors and session bindings. Legacy rows
  stay single-tree layouts; rename preserves an arrangement, while an explicit
  tree overwrite without the field replaces it. Null also clears it. Scope and
  unique window/project ownership are validated on write and read. A new pure
  capture projection under `web/features/windows/arrangements/` reuses project
  extraction: anchored mixed-project panes move into project saves intact, a
  profile-wide host contributes its matching tabs, and a project-based host
  contributes its whole selected slice. The browser fallback preserves editor
  duplicates, deduplicates terminal viewers and repairs colliding pane ids.
  Dirty text, view caches and native geometry are not named-layout data.
  Native coordination and popover save/apply use these records as described below.

- Native host-only layout capture now serialises with refresh/reload and uses
  the existing checkpoint command for every live participant (application 26.18).
  It waits for all acknowledgements, rejects changed membership/routes or an
  unavailable/closing participant, and resumes survivors before returning. Closed
  returned projects contribute their saved snapshot without a renderer. The reply
  excludes buffer text, view caches, native placement and host transport targets.
- Desktop recovery format 3 migrates format-2 working sets and adds prepared
  multi-window arrangements with bounded outcomes. One atomic commit updates all
  participant revisions, opens destinations, retires sources and consumes returned
  projects. Original ownership remains visible before commit; staged native
  registration cannot overwrite it. Every original dirty buffer must survive in
  an open destination. Scope, revision and duplicate-owner checks reject stale or
  invalid plans. Other hosts/profiles and unrelated project-mode slices remain
  intact. Interrupted preparations cancel on restart; committed outcomes survive
  and repeated commit does not write again. The native apply planner/coordinator
  uses these storage primitives.
- Renderer arrangement participation now uses `windows/arrangements/participant.ts`
  with separate seal, stage, verify and finish commands (application 26.19).
  Sealing checkpoints and releases models before returning the original revision.
  Staging requires an exact durable prepared version and the shared
  Workspace/dashboard's mounted acknowledgement; it times out after eight seconds.
  Verification releases the prepared models and checks the profile, route and
  captured buffers again. Every participant remains fenced until its exact durable
  outcome is observed. Cancellation restores original content/routes and retains
  late drafts visibly. A new/replaced renderer has no in-memory original and
  stays sealed for the coordinator to close or reload. Prepared windows use
  `stagingArrangement`, not the earlier transfer acknowledgement, and cannot
  participate in native drags. The matching/apply coordinator and named-layout
  controls below use this handshake.
- Native apply/observe now drives that handshake through `desktop/windows/arrangements/`
  (application 26.20). Main reserves exact native matches, reuses compatible panes
  and project owners, creates stable missing slots, and coordinates all participants
  under the host navigation lock. The renderer planner lives alongside the shared
  arrangement operations, retains chrome, moves matching drafts/view positions and
  adds recovery tabs for omitted dirty files. Ambiguous dirty merges reject before
  preparation. Project loads preserve unrelated slices and native layout modes;
  anchored mixed-project panes stay whole. Fresh and retired sources must confirm
  their versions before one commit changes ownership. Lost replies observe recorded
  outcomes; failed planning records cancellation as well. Late new-window edits
  during cancellation keep a durable recovery window instead of being discarded.
  Restored native layout mode survives remount/reload without changing client
  preferences; new seeds and explicit preference changes still use the existing
  layout conversion.
- The host Layouts popover now uses coordinated capture/apply, gated on native
  bridge support and host application 26.17 storage support. A native-only scope
  selector can save the whole profile or a selected project from the dashboard,
  including detached projects. Its native dashboard path uses the desktop owner;
  it does not read or overwrite browser sessionStorage. Returned closed projects
  are folded into logical host content. Saving updates the saved-name reference
  without reloading panes; it does not reset editor models or selection.
- Dirty comparison includes the full scoped arrangement, including inactive
  slices and duplicate window presentations. Native ids, window ordering and
  transient focus do not count as drift. Same-scope duplication retains the
  arrangement; cross-scope duplication copies the ordinary fallback tree. Native
  legacy loads consolidate their scope into one host presentation through the
  same draft-preserving coordinator. Other project slices remain unaffected.
- Apply state survives React remounts. Lost replies observe the same operation
  id; an unresolved result never automatically dispatches another application.
  Controls wait for capture/save/apply, and the existing inline confirmation
  covers replacing a different or unobserved arrangement. Browser workspace
  saves adopt the name without reapplying their tree; browser loading retains
  its existing single-tree behaviour.

- Native host effects now have main-process ownership (`windows/effects/`,
  application 26.21). One ready renderer runs each host's automatic update offers
  and polling; one renderer presents the app-wide desktop-update offer. A detached
  successor takes over when the host renderer closes, reloads or crashes. Explicit
  Settings views still observe status independently. Offer dismissal survives
  ordinary React remounts; losing ownership removes the former owner's toast.
- Notification delivery and sound share one bounded host claim, selected in the
  focused native renderer when available so recent terminal interaction still
  controls focused-delivery suppression. Modern event ids are consumed until
  bounded eviction; legacy status-only events have a two-second duplicate window.
  Lost replies suppress delivery rather than producing an uncoordinated duplicate.
  Native notifications belong to the host window set and survive closing their
  original window. Click routing resolves the target project's profile, prefers
  an existing detached session pane, then uses shared project-window routing.

Native macOS UI-only lifecycle acceptance has now run, as recorded below. Packaged
and Linux acceptance, native drag gestures, live host/process continuity and the
remaining full-roadmap audits are still pending. Undo-stack transfer is not
implemented; restored editors use new Monaco models with recovered text.

## Verification record

2026-11-07, macOS development checkout:

- Desktop tests and web workspace/editor/window tests:
  446 tests passed across 60 files. SSH askpass fixtures required loopback access outside the
  restricted sandbox; no production daemon was started.
- Desktop and web TypeScript checks passed after rebuilding shared declarations.
- Targeted ESLint and whitespace checks passed; the production web build passed
  with its large-chunk advisory.
- UI-only Chromium preview on port 5186, `web/test/dev/windows.mjs`: all three
  presentations and unsaved-editor text restoration across reload passed,
  including a 600px-wide pane window. This uses a synthetic desktop bridge and
  is not evidence of native window dragging or live transfer correctness.

These are intermediate results. Rerun appropriate checks after remaining changes
and replace this record with the final verified scope.

The subsequent close/quit checkpoint increment passed 49 focused desktop/web tests,
including withheld/failed acknowledgements, sibling admission, renderer replacement,
late buffer notifications, and quit cancellation. Native OS acceptance remains
pending. The UI-only Chromium check also passed immediate unsaved-editor
checkpointing before the debounce timer, interaction fencing, cancellation, and
reload recovery in all three presentations. Host refresh/reload checkpointing
was added in the later increment below. A renderer crash can only recover the
last durable snapshot.

The pane projection increment passed all 17 web window tests and the web
TypeScript/targeted ESLint checks. Coverage includes dirty duplicate views,
unrelated project slices, stale pane selection, and preventing inactive historical
layout trees from recapturing a moved buffer during React cleanup.

The live pane increment passed 468 tests across 65 desktop/web test files,
including destination failure, both handoff acknowledgements, source disconnection,
timeout, wrong-window/profile replies, lost commit replies, and overlapping quit.
The shared API contract suite separately passed all 18 tests. The final late-draft
recovery adjustment also passed all 21 web window tests.
Desktop/web type checks, targeted lint, and the production web build passed.
`web/test/dev/window-transfer.mjs` uses real desktop state/transfer modules with
isolated Chromium pages: context-menu detachment, dirty text, source view removal,
closing the host, and independent pane reload all passed. The screenshot is
`/tmp/puddle-live-pane-transfer.png`. This is integrated renderer coverage, not
native OS drag, title-bar, or process-restart acceptance.

To repeat the integrated check, run the UI-only preview, then
`PREVIEW_URL=http://127.0.0.1:5174/ pnpm --filter @puddle/web exec node test/dev/window-transfer.mjs`.
The script builds the desktop state/transfer modules into an isolated temporary
directory and cleans up its browser and state afterwards. It never calls host
bootstrap or starts a daemon.

The same integrated check now accepts `WINDOW_TRANSFER_KIND=file` and
`WINDOW_TRANSFER_KIND=session`. Both passed against the UI-only preview; the file
case additionally repeats its open action and verifies reuse of the existing
window, while the session case checks the unchanged terminal session reference
and removal of the source terminal. This increment also passed 113 focused
desktop/window/explorer tests across 19 files, the 18 shared API contract tests,
desktop/web TypeScript checks and targeted ESLint. Untitled, diff and preview
menu wiring is implemented; their integrated transfer acceptance remains pending.

The docking-projection and view-key increment passed 106 window/layout tests
across eight files, web TypeScript and targeted ESLint. The integrated pane and
file checks also passed restored editor selection as well as dirty text, including
an independent destination reload. These runs still exercise Chromium renderers,
not native drag/dock gestures.

The navigation-checkpoint increment passed 77 tests across 11 files, including
sibling save failure, duplicate refresh requests, native reload/force-reload,
Command-Q during refresh, bounded navigation failure, the renderer refresh
controller and the shared API contract. Desktop/web TypeScript and targeted
ESLint passed. The integrated pane script also edited immediately before its
native-style reload, ahead of the normal persistence timer, then recovered the
latest text and selection with its host window closed. Its reload bridge uses
the actual command/checkpoint modules in isolated Chromium; Electron menu and
OS acceptance remain separate and pending.

The live menu-return increment passed 231 tests across 24 window/layout/lifecycle
and shared-contract files, desktop/web TypeScript and targeted ESLint. The
production web build passed with its existing large-chunk advisory. Tests cover
destination planning/staging/rollback, cancellation during an asynchronous plan,
route retention before commit, dirty conflicts, stale revisions, late cleanup
drafts, and source retirement failure without replay.
The integrated Chromium script passed with `WINDOW_DOCK_BACK=1`: detach a dirty
editor, reopen a clean view in the host, change selection in the detached pane,
return through the context menu, retain both editor views, retire the source and
reload the host with the latest text/selection. Combining that option with
`WINDOW_TRANSFER_KIND=session` passed terminal return with an unchanged session
reference. These are UI-only checks using the real desktop coordinator and state
modules through a synthetic native bridge; they do not prove OS drag/focus,
live PTY continuity, crash recovery or project-window return acceptance.

The native pane-drag increment passed the 237-test window/layout/contract suite
across 25 files; a subsequent visible-project routing test also passed. Desktop/web
TypeScript, targeted ESLint and formatting passed; the production web build passed
with its existing large-chunk advisory. `WINDOW_DOCK_BACK=drag` in the integrated
Chromium script exercises the real source drag event, main-process offer, source
command and destination drop listener, then verifies text/selection and reload.
Both editor and terminal cases passed. This forwards the DataTransfer payload between isolated
pages; it does not simulate an OS drag between native windows. The ordinary
browser `web/test/dev/pane-drag.mjs` check passed tab splits, whole-pane swaps,
edge placement, all-tab preservation and Escape cancellation. Native single-tab
edge usability, cross-window Escape, iframe drop surfaces and OS focus remain
acceptance items.

The tab-transfer increment passed 334 tests across 40 desktop/window, web
window/layout/tab/session/explorer and shared-contract files, after correcting a
test fixture that attempted to mutate a durable window identity. Type checks,
targeted ESLint and the production web build passed. The later stale-preview
selection adjustment passed all 48 focused window tests across 11 files.
`WINDOW_ADD_TAB=file`, `session` and `tab` passed in the integrated Chromium
script: start with a dirty detached file, drop another file/session into its strip,
retain both tabs and drafts, and reload. The file cases check imported selection;
the session case checks the unchanged session reference. The `tab` case also
uses real Chromium mouse dragging within the receiving renderer to split the
second tab, verifying that it moves instead of leaving an extra copy. Whole-pane
drag return and the ordinary browser drag regression both passed again. Cross-window
payload forwarding still uses the synthetic native bridge; OS and live runtime
acceptance have not been inferred from these checks.

The project-handoff foundation passed 260 tests across 27 desktop lifecycle/window,
web window/layout and shared-contract files. Desktop/web TypeScript, targeted
ESLint and whitespace checks passed. New tests cover complete and mixed-project
extraction, independent dirty duplicates, unknown sessions, returned-project lookup
and restart state, duplicate owners, source reopening during planning, destination
failure and commit persistence failure. The existing destination controller also
stages and accepts a project with its requested session route. No new project UI
or native close integration was exercised, and no native acceptance is implied.
The following increment adds those controls and their navigation/close integration.

The project-controls increment passed 269 tests across 28 window/lifecycle/layout
and shared-contract files, desktop/web TypeScript and targeted ESLint. The web
production build passed with its existing chunk-size advisory. The new main-process
fixture distinguishes explicit project closure from successful Command-Q, including
dirty checkpoint retention with no host window. Registry tests cover repeated focus,
session routes, returned-state reopening, failed/cancelled native creation and
delegation from a detached window. Projection tests cover mode changes without
resurrecting moved views or overriding the latest returned slice.

`WINDOW_TRANSFER_KIND=project` passed in `web/test/dev/window-transfer.mjs`:
dashboard context-menu open, dirty text/selection handoff, preserved sidebars,
host link and history redirection without duplicates, native-style session-target
activation, closing the host, further unsaved editing, project-menu return with
no host open, and restoring that text when the host opens again. The screenshot
is `/tmp/puddle-live-project-return.png`. A first extended run clicked a tab's
hover action instead of its activation area; correcting the test's click position
made that session-navigation check pass. Existing native pane drag/return and
ordinary browser pane-drag checks also passed. These use isolated Chromium and
the real coordinators through a synthetic bridge. Platform focus/Space behaviour,
actual title bars, restart/SSH recovery and individual palette/notification UI
gestures still require acceptance; shared routing alone is not evidence for every
native gesture.

The project drag/return increment and directory reorganisation passed 275 tests
across 28 window, lifecycle, layout and shared-contract files. Shared, desktop and
web TypeScript, targeted ESLint, formatting and whitespace checks passed. The web
production build passed with its existing chunk-size advisory. Recovery tests
reload the durable store before and after live project commit, verifying original
ownership before confirmation and destination ownership after it. Source tests
include model-cleanup edits in the final capture and restore the original project
after a refused merge. Registered project drag tests reject foreign hosts,
profiles and invalid sources and prevent a consumed offer from dispatching twice.

`WINDOW_TRANSFER_KIND=project WINDOW_DOCK_BACK=drag` passed the Chromium handoff,
including native-style project reload, drop-highlight expiry, complete return,
source dismissal and host reload with the editor still selected. The menu-return
variant (`WINDOW_DOCK_BACK=1`), independent project closure/return with no host,
existing pane drag/return and ordinary browser pane-drag regressions also passed.
The inspected returned-workspace screenshot is
`/tmp/puddle-live-project-docking.png`. These fixtures use real coordinators and
synthetic bridge/DataTransfer delivery; native OS dragging, collapsed-label
gestures, monitor placement, live PTY continuity and restart remain unverified.

The named-arrangement storage/projection increment passed the 230-test window,
layout, database, saved-layout HTTP and shared-contract suite across 25 files.
After adding dashboard-untitled and project-only capture cases plus native-record
reopen validation, all seven focused capture/migration tests passed. Shared,
daemon and web TypeScript and targeted ESLint passed. Tests cover old-row migration,
native descriptor round trips, rename/duplicate, legacy tree overwrite, explicit
clear, unknown versions and transient-data rejection, project scope, mixed panes,
duplicate editor views, terminal deduplication and no mutation of source state.
No coordinated native capture/apply or save/load UI acceptance is claimed.

The coordinated capture/transaction increment passed 182 window, lifecycle and
shared-contract tests across 26 files, shared/desktop/web TypeScript and targeted
ESLint. After adding staged-placement coverage, all 11 arrangement-persistence
tests passed. The capture coordinator tests cover scoped checkpointed reads,
closed returned projects, all-reply waiting after failure, changed routes and
resumption failure. The main-process fixture exercises host-only capture IPC and
actual correlated checkpoint/resume commands for both renderers. Persistence tests
cover atomic commit/restart, interrupted preparation, dirty retention, stale
revisions, cross-scope rejection, foreign acknowledgements, competing handoffs,
membership exclusion, duplicate/project replacement ownership, local placement,
write failure and format-2 migration. The existing isolated Chromium project
drag/return fixture also passed with recovery format 3, including source closure
and host reload. No native apply handshake or named-layout UI acceptance is
established by these tests.

The renderer-participation increment passed 196 window/lifecycle/shared-contract
tests across 28 files, shared/desktop/web TypeScript and targeted ESLint. New
tests exercise the actual renderer command queue with the atomic native store:
all participants vote before ownership changes, a failed mount cancels the set,
and restart retains the chosen outcome and drafts. Focused cases cover a wrong
profile/route/nonce, stale prepared versions, unconfirmed outcomes, bounded
mounting, late source/destination cleanup edits, new-window cancellation, repeated
finish observations and retiring-source verification. A source which becomes a
destination must vote again after staging.

The isolated Chromium check
`WINDOW_TRANSFER_KIND=project WINDOW_DOCK_BACK=drag WINDOW_LAYOUT_HANDSHAKE=1 PREVIEW_URL=http://127.0.0.1:5186/ node test/dev/window-transfer.mjs`
(from `packages/web`) exercises the real Workspace/dashboard hooks. It stages a
new pane, verifies its dirty text and interaction fence, cancels back to both
original windows, then stages/verifies/commits the existing pair and checks text,
selection and resumed interaction. Project drag-back, atomic source closure and
host reload also pass. The inspected screenshot is
`/tmp/puddle-live-layout-handshake.png`. The fixture's arrangement sequence lives
under `test/dev/windows/arrangements/`; it supplies the plan directly, so this is
renderer handshake acceptance, not named-layout matching/apply UI or native OS
window acceptance.

The native apply increment passed 220 window/lifecycle/shared-contract tests across
32 files, shared/desktop/web TypeScript, targeted ESLint and formatting. Coverage
includes actual renderer planning and correlated commands, scoped matching,
repeated loads, retained closed slots, placement, cancellation before preparation,
failed mounts, replaced renderers, lost finish acknowledgements, failed atomic
commit, other project/profile/host isolation, mixed panes, divergent dirty copies,
orphan-draft recovery, duplicate editor views and view-key translation. Exceptional
new-window recovery also retains omitted drafts from a reopened closed slot.
The additional workspace-layout and client-settings regression suite passed all
136 tests across eight files.

The isolated Chromium command
`WINDOW_TRANSFER_KIND=project WINDOW_DOCK_BACK=drag WINDOW_LAYOUT_APPLY=1 PREVIEW_URL=http://127.0.0.1:5186/ node test/dev/window-transfer.mjs`
(from `packages/web`) passed with the real native coordinator and renderer planner.
It creates a missing pane slot, reapplies without duplicates, retires the superseded
pane after acceptance and preserves dirty text/selection. It then verifies project
drag-back and host reload, applies a different native layout mode, checks it survives
remount/reload without changing the client preference, and exercises the actual
Appearance switch when the default already equals the requested value. The inspected
screenshot is `/tmp/puddle-live-layout-apply.png`. The preview harness now disconnects
its old command registration on document navigation, matching Electron's lifecycle.
The ordinary native-pane drag/return and browser pane-drag regressions also passed.
These tests supply arrangements directly through the private capability; named-layout
popover save/load and native OS acceptance remain pending.

Native acceptance had not run at that increment; the later native record follows.
Use an isolated UI preview for desktop interaction;
start any real daemon from a plain shell, never from a coding-agent session.

### Layouts popover integration — 2026-11-07

- 342 focused tests passed across 38 desktop/web/shared files, including native
  capture/application, catalogue projection/signatures, lost-reply observation,
  project routing and the existing workspace layout suite.
- Web TypeScript, targeted ESLint, formatting and whitespace checks passed.
- UI-only Chromium, real coordinators with synthetic native bridge:
  `WINDOW_TRANSFER_KIND=project WINDOW_DOCK_BACK=drag WINDOW_LAYOUT_CATALOGUE=1
  PREVIEW_URL=http://127.0.0.1:5186/ node test/dev/window-transfer.mjs` from
  `packages/web` passed. The actual host popover saved profile/project arrangements
  from the dashboard, preserved the detached editor instance, dirty text and
  selection, duplicated the stored arrangement, and loaded it without creating
  duplicate windows. Project drag-back and host reload then passed. Screenshot
  `/tmp/puddle-live-layout-catalogue.png` was visually reviewed.
- Ordinary browser preview: `node test/dev/layouts/catalogue.mjs` with the same
  `PREVIEW_URL` passed saving without replacing the mounted dirty editor, storing
  a single-tree payload and loading through the browser path. The existing
  `test/dev/pane-drag.mjs` passed split, swap, tab retention, edge move and Escape
  cancellation checks.
- These checks do not establish Electron titlebar/focus behaviour, native OS
  dragging, Command-Q/restart recovery, live PTY continuity or resource overhead.
  Those checks and the remaining cross-window effects audit are still required.

### Native host effects — 2026-11-07

- 292 focused tests passed across 45 files covering desktop window lifecycle,
  host-effect election/claims/IPC, notification lifetime/click routing, renderer
  notification policy, update queries and existing window arrangements/transfers.
- Shared declarations rebuilt; desktop/web TypeScript and targeted lint checks
  passed. Private bridge capability is application 26.21; persisted window and
  named-arrangement versions remain unchanged.
- UI-only Chromium with real election, notification hooks and transfer coordinator:
  `WINDOW_TRANSFER_KIND=session WINDOW_EFFECTS=1
  PREVIEW_URL=http://127.0.0.1:5186/ node test/dev/window-transfer.mjs` from
  `packages/web` passed. A synthetic host-update operation produced repeated reads
  only in the elected window; its detached successor started reading after the
  host closed. The synthetic desktop-update offer appeared only in its elected
  window and survived unmount/remount. Shared attention events produced one sound
  and notification, retained consumed ids across focus changes, respected recent
  terminal-input suppression and focused the existing detached session on click.
  Independent session-window reload also passed afterward. The existing native
  Layouts catalogue plus project drag-return/reload preview regression passed.
- This fixture stubs OS notification delivery and uses an isolated preview socket;
  it neither sends real notifications nor starts a daemon. OS Notification Centre,
  click delivery during an app restart, native focus/drag and live process
  continuity still require the native acceptance below. Cross-profile routing and
  host isolation currently have focused unit evidence, not native OS evidence.

### Native macOS lifecycle and resource observations — 2026-11-07

Passed on macOS 26.5.2 arm64, Electron 43.2.0, Node 22.21.1, against the Vite UI
preview at `127.0.0.1:5186`. Run from the repository root:

```sh
PREVIEW_URL=http://127.0.0.1:5186/ \
PUDDLE_NATIVE_REPORT=/tmp/puddle-native-window-resources.json \
pnpm --filter @puddle-code/desktop test:native-windows
```

The fixture under `desktop/test/windows/native/` bundles the actual desktop main
process, preloads and native keyboard shim. Its build replaces the CLI library
with a preview-only host and asserts no CLI implementation enters the bundle.
Real Electron windows, IPC, menus, persistence and renderer components run with
temporary application data. The preview supplies synthetic projects/files/sessions;
no daemon, SSH connection, installer, PTY or host execution is invoked.

Observed results:

- Migrated a target-only reopen record and opened one host connection. Opened a
  session-backed file through the explorer, changed its Monaco buffer without
  saving, and detached its entire pane through a real right-click/menu gesture.
  The dirty text reached the native pane through the acknowledged transfer.
- Opened the project from its dashboard context menu. Clicking that project again
  focused its existing native window, retaining exactly three windows and one
  preview host connection. Detached panes and projects had no header controls;
  their content bounds sat below the real macOS title bar.
- The title regression sends a synthetic status for an unrelated session through
  the actual WS manager, then checks both document and native window titles.
  Project/pane titles retain `puddle — UI preview`. Shared title ownership now
  prevents host notifications from replacing that identity; focused tests also
  cover host renaming and stale workspace cleanup.
- Closing the host left both detached windows alive and did not close the shared
  connection. The pane entered and left actual native fullscreen. App quit used
  Electron's `app.quit()` and the production checkpoint/quit handlers. Relaunch
  restored only the same project/pane identities, dirty text and one connection.
- Forced a renderer crash, invoked the actual native **Reload** menu, and observed
  the replacement renderer through Electron `webContents`. It recovered the same
  pane identity and unsaved text. Playwright retains its old Page's crashed flag,
  so that flag is not used as evidence of failed renderer recovery.
- Sent SIGKILL only to the isolated test app, relaunched it, and recovered both
  detached identities and dirty text from their durable snapshots. Explicitly
  closing the restored project created its returned workspace record without
  opening a host or closing the independent pane.
- The final run passed with no renderer page errors. 150 focused desktop
  lifecycle/ownership/bounds/reopen and web shell/title tests passed across 23
  files. Web TypeScript and targeted ESLint also passed.
  The existing `WINDOW_TRANSFER_KIND=session WINDOW_EFFECTS=1` Chromium check
  also passed notification suppression, consumed-event handling, host-update
  ownership handover and independent pane reload after the title change.

Resource observations use Electron's process inventory and memory/CPU counters,
following the existing preview-surfaces measurement approach. Each phase settles
for two seconds, samples three seconds of idle time, then performs twenty Monaco
insert/undo pairs at 100 ms intervals while retaining the original dirty text.
The active editor moves to the pane after detachment. Other windows are mostly
occluded; the project window starts empty. No terminal output is generated.

| Window set | Renderer processes | Idle summed working set (MiB) | Editing summed working set (MiB) | Idle CPU (%) | Editing CPU (%) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Host | 1 | 821.2 | 823.0 | 0.07 | 0.35 |
| Host + pane | 2 | 1308.4 | 1321.0 | 0.76 | 2.54 |
| Host + project + pane | 3 | 1639.4 | 1643.3 | 2.61 | 3.08 |

These are single-run development-preview observations (including Vite/debugger
and development React costs), not packaged-app budgets or unique physical-memory
measurements. Working sets sum all Electron processes and can count shared pages
more than once. CPU is the sum of Electron-reported interval percentages; the
workloads and focus differ between phases. The run confirms that each additional
window has its own renderer and material memory cost despite component reuse.
The optional JSON report contains the per-process readings for reproduction.

This does **not** establish physical Command-Q key delivery, actual cross-window
OS dragging, in-flight handoff crash/quit acceptance, monitor unplugging, machine
reboot, signed packaged-app notifications, live terminal/runtime continuity,
SSH/daemon recovery, Linux behaviour, or sustained production resource costs.
The complete checks below remain required; passing native lifecycle checks alone
is not completion of this roadmap.

### Missing resources and simplified titles — 2026-11-07

Implemented native recovery under `web/features/windows/recovery/`, reusing the
existing button, text field, download helper and editor query caches. Native
workspace remount no longer prunes tabs against the current session list. An
unavailable session keeps its tab and displays a placeholder. A failed file/draft
read with retained text displays that text read-only for selection/copy and local
download. It adds no background reads or polling; Retry uses the original query.
Failed project lookups retain the arrangement and show the available drafts with
a Retry action. Successful retries return to the normal editor. Existing file-tab
close confirmation recognises retained drafts even without a loaded Monaco model.
No recovery action recreates a host file or executes saved notebook contents.

Window titles now follow the requested naming: project name only for workspaces,
active file basename or session label for detached panes. They omit app/host
affixes and waiting counts. The shared title owner still prevents unrelated host
status events from overwriting those names. The native title assertions now expect
`puddle` for the preview project and `README.md` for its detached file pane.

The new native resource-loss fixture uses the actual main process/preloads and
synthetic missing-file/session/project responses. It remounts the pane against an
empty session list, verifies both tabs remain, checks the missing-session
placeholder, cancels file discard through the existing dialogue, downloads the
retained text into the fixture's temporary directory, and compares exact bytes.
File/project retries restore normal editing with the original dirty text, and
no file/untitled mutation is issued by these recovery actions. Electron's own
`will-download`/`done` events observe the download; Playwright's browser download
event does not fire for this native path.

The focused command is:

```sh
PUDDLE_NATIVE_RECOVERY_ONLY=1 PREVIEW_URL=http://127.0.0.1:5186/ \
pnpm --filter @puddle-code/desktop test:native-windows
```

The focused run passed on macOS 26.5.2 arm64 / Electron 43.2.0, including the
simplified document/native titles. The automated web window/workspace/editor/shell
suite passed 449 tests across 64 files, and the ordinary-browser pane-drag check
passed split, swap, tab preservation, edge move and cancellation. TypeScript and
targeted ESLint passed.

The full native run currently stops at its focus assertion: all three test
windows reported `isFocused() === false`, including after requesting app focus,
while project routing returned true. Its cause has not been established. The
focused mode explicitly omits OS focus and fullscreen; the default full mode
retains both assertions. Earlier successful native focus/fullscreen observations
above remain historical evidence, not a claim that this increment revalidated them.
The recovery surface screenshot at `/tmp/puddle-native-draft-recovery.png` was
inspected; it uses shared fields/actions inside the existing pane chrome.

Gap identified at this stage: native pane-window close bypassed individual tab discard
review, although its checkpoint retains closed-window drafts. Those closed pane
records need an accessible recovery/close policy before completion. The keyboard
file-tab close gap identified here is addressed by the increment below.
Untitled missing-resource/discard and notebook/preview recovery acceptance have
not run. Keep these gaps separate from the verified ordinary-file recovery path.

### Shared tab-close review — 2026-11-07

Keyboard editor-tab closure now invokes the mounted tab's existing close control
through a workspace-local registry under `workspace/tabs/close/`. Entries include
both pane and tab identity, so duplicate file views do not share a close callback.
Unmounted/loading controls cannot authorise closure; the lazy button is disabled
until its dirty-file policy is available. Untitled tabs go directly to their
workspace-owned draft-deletion dialogue, without first discarding through the
ordinary-file dialogue. Terminal tab closure remains view-only.

The browser regression also exposed a pending-write race in the existing file
discard path: tab cleanup could flush the latest debounced draft after deletion.
Approved discard now cancels local pending writers for that exact session/path/root
before deleting the cached draft. The editor's normal unmount still flushes pending
edits when no discard was approved. This does not discard independent peer-window
models or change file-save/conflict policy.

The new `web/test/workspace/tabs/close/close.browser.mjs` check runs against the
daemon-free preview and is included in `test:preview`. It delays the close chunk,
checks that keyboard closure cannot bypass the disabled fallback, verifies both
keyboard/button cancellation preserve dirty text, discards during the writer's
debounce, reopens the clean disk content, and closes a clean tab without a dialogue.
It passed with `PREVIEW_URL=http://127.0.0.1:5186/`. The targeted editor, workspace,
draft-persistence and title unit suite passed 359 tests across 44 files.

The native recovery fixture additionally sends Command-W while the unavailable
file's recovered text has focus. It observes the existing discard dialogue,
cancels it and verifies both tabs and the exact retained text remain. The focused
native command above passed on macOS arm64, explicitly omitting native focus and
fullscreen. Native **window** closure was still separate at this stage; the next
increment adds pane-wide review. Untitled deletion,
duplicate-view discard and rapid dialogue reopening during exit animation have
not been established by these checks.

### Native pane close review — 2026-11-07

Application 26.22 adds a private `review-close` dispatch and optional
`closeReviewedPane` completion. The renderer acknowledges dispatch immediately,
then reviews dirty file and untitled tabs through their existing dialogues. The
shared asynchronous review controller coalesces repeated requests and rejects
stale approval callbacks after cancellation or unmount. App quit/checkpoint and
working-set locks cancel native review; they do not interpret it as discard
consent. Main validates completion against the registered pane/main-frame/origin,
checkpoints again and refuses to close while the authoritative working set still
contains dirty buffers or untitled tabs. No terminal stop, file save or execution
is performed by close review.

Approved untitled deletion cancels pending draft PUTs and awaits writes already
in flight, including writers from inactive/unmounted tabs, before DELETE. Failure
keeps the dialogue and draft available. Cancellation while an approved host request
is in flight retains local recovery text. Native close reviews one current tab at
a time; if a later tab is kept, earlier explicitly approved discards stay applied.
Dialogue clicks no longer bubble into an inactive file chip and resurrect its old
layout. Closing the last native window now excludes destroyed windows from the
quit snapshot, even if `window-all-closed` precedes the final `closed` handler.

The focused native fixture passed on macOS arm64 with synthetic host/draft storage:

- A clean file opened in its own pane closes without a dialogue, including immediate
  completion before review dispatch acknowledgement, while siblings retain the connection.
- Duplicate close requests show one file dialogue. App quit during that review
  restores the same pane and its dirty text on relaunch.
- A renderer completion request that skips review is rejected by the final dirty
  checkpoint and returns to the existing dialogue. Keep editing preserves the pane.
- Closing an inactive dirty file proceeds to the untitled draft's own dialogue.
  Cancelling that dialogue retains the draft. Discard waits for a held PUT;
  a synthetic DELETE denial keeps review open, and a subsequent approved retry
  closes the pane.
- The final window stays out of the reopen set, retained buffers are empty after
  approved discard, and the shared preview connection is stopped exactly once.

The fixture uses the actual main process and preloads with CLI implementation
excluded. Its fake cockpit now implements the real `stop()` contract; last-window
teardown is checked explicitly. The command remains
`PUDDLE_NATIVE_RECOVERY_ONLY=1 PREVIEW_URL=http://127.0.0.1:5186/ pnpm --filter @puddle-code/desktop test:native-windows`.
Native OS focus/fullscreen remain explicitly omitted by this mode. The ordinary
browser close regression passed, as did 606 tests across 83 shared, desktop-window,
web-window, workspace, editor, draft-persistence and title files. Targeted lint and
web/desktop TypeScript checks passed.

At this stage, orphaned buffers and unavailable project/tab controls kept the pane
open without an explicit recovery discard route. The increment below adds that
route and verifies missing-profile draft deletion. An unavailable renderer still
needs reload before review. Duplicate-view discard, notebook/preview-specific
close state, and native crash/transfer interruption during every review phase
remain unverified.

### Closing from draft recovery — 2026-11-08

Native panes now reuse the existing file and untitled discard dialogues from the
missing-project recovery surface. The fixed native profile remains selected when
the profile disappears, keeping its retained drafts accessible. Confirmed
`404/not_found` from an approved untitled DELETE allows the local draft to retire;
permission failures, other errors and lost replies still retain it.

Retained buffers without authoritative editable tabs appear in a collapsible
recovery area above the existing workspace. Its child position stays stable, so
showing recovery does not remount healthy editors. Recovery reads a cached buffer
snapshot rather than querying Monaco during render. Each orphan can be copied,
downloaded or explicitly discarded through the shared close dialogue. Orphan
discard removes only this window's retained copy: it neither deletes a host file
nor cancels/deletes an independently cached draft with the same identity. Native
close reviews these copies before ordinary tabs, then uses the existing final
main-process checkpoint.

The extended isolated native fixture passed on macOS arm64 with the actual main
process/preloads and synthetic host storage; CLI implementation remains excluded.
Its new scenario verifies:

- Revealing an orphan keeps the same Monaco editor ids and exact retained text.
- Keeping the orphan or file during close leaves the pane and text available.
- Removing both project and profile exposes file, untitled and orphan text in
  recovery, with all three discard controls still reachable.
- Approved orphan discard preserves independently stored IndexedDB text for the
  same file. No file or untitled mutation occurs before explicit untitled discard.
- Approved untitled discard receives canonical missing-profile confirmation,
  closes the pane and removes its retained buffers from the native working set.

The same run also passed existing host-independent lifetime, app quit/relaunch,
renderer crash/Reload, forced app interruption, missing-resource retry/download,
and last-window close checks. Run it with
`PUDDLE_NATIVE_RECOVERY_ONLY=1 PREVIEW_URL=http://127.0.0.1:5186/ pnpm --filter @puddle-code/desktop test:native-windows`.
This mode explicitly omits native focus/fullscreen and uses no live daemon or PTY.
The fixture retains sufficient Resource Timing entries to resolve the loaded Vite
modules and verifies injected recovery state through the native persistence bridge.

All 596 selected tests across 83 shared/desktop-window/web-window/workspace/editor,
untitled-query, draft-persistence and title files passed, as did web TypeScript,
targeted formatting/ESLint checks and the ordinary Chromium keyboard/button
tab-close regression. Recovery screenshots
`/tmp/puddle-native-close-recovery.png` and `/tmp/puddle-native-orphan-recovery.png`
were inspected; shared recovery actions stay grouped and the existing editor
remains visible below the orphan disclosure. The broader acceptance requirements
below remain open. The following increment adds duplicate-view and notebook
close coverage; native focus/fullscreen, other preview surfaces, real
transport/runtime recovery and interruption at every transfer phase remain open.

### Duplicate views and notebook close — 2026-11-08

Closing one duplicate file tab previously cancelled all writers and removed the
file's native recovery readers even while another view retained its dirty model.
The shared close control now counts the full renderer working set before discard:
inactive tabs and parked project slices count, obsolete slices from the other
layout mode do not. Session, path and root distinguish buffers; commit and
untitled models are separate. Closing a duplicate preserves the model and draft;
the final view uses the existing discard dialogue. Approval rechecks ownership
in case another view appeared while the dialogue was open. The policy lives under
`workspace/tabs/close/`, with the same scope around normal and recovery workspaces.

The Chromium duplicate-view regression passed: drag a file from the explorer into
a second pane, close one view without discard, verify the remaining model and
IndexedDB draft, reload, cancel final-view close, then approve discard and reopen
the clean disk content. The ordinary keyboard/button close regression also passed.
Both are included in `test:preview`. Pure coverage includes inactive source,
preview and diff references, root/session separation and authoritative project
versus profile trees.

The native recovery-only suite passed on macOS arm64 with two added scenarios:

- Edit the same file differently in a project and pane window. Cancel pane close,
  then discard its copy. The project's own text remains in its model and durable
  native state, survives checkpoint/reload and continues persisting later edits.
- Open a notebook in a pane, switch to notebook view and change the real cell
  model through its normal change handler. Cancel native close, checkpoint/reload,
  and verify the complete edited notebook JSON, saved output and execution count.
  Explicit discard closes the pane without an observed file save or kernel action.
  This is model/lifecycle coverage, not native OS keyboard-delivery verification.

The full run also passed its existing quit/relaunch, renderer crash/reload,
interruption, missing-resource and last-window-close checks, with no renderer
console errors. An earlier run passed the scenarios but failed that final console
check because the shared Vite dependency cache referenced a missing Python
highlighting chunk. The successful run used a UI-only Vite server on port 5188
with a separate temporary `cacheDir`, followed by
`PUDDLE_NATIVE_RECOVERY_ONLY=1 PREVIEW_URL=http://127.0.0.1:5188/ pnpm --filter @puddle-code/desktop test:native-windows`.
No console-error assertion was relaxed. No daemon or real kernel was started.

All 598 selected unit tests across 84 files passed, alongside web TypeScript,
targeted ESLint and formatting checks. Native focus/fullscreen remain explicitly
omitted in this mode. Source/preview-pair transfer is covered by the next increment.
Active notebook execution and widgets, every transfer interruption phase, real
host/runtime recovery and the other requirements below still need their own evidence.

### Source/preview transfers and native presentation prerequisite — 2026-11-08

The native source/locked-preview regression exposed a workspace crash while
detaching the source pane. Disposing its hidden dirty-diff editor left Monaco's
global hover factory pointing at that editor's disposed child service container.
Later suggest/hover construction failed with `InstantiationService has been
disposed`, including during sibling diff cleanup. The existing pinned Monaco
0.55.1 patch now resolves the renderer-wide standalone service inside this global
factory. Its existing cancellation/disposed-model fixes remain intact. pnpm's
patch hash and the lockfile changed together; no exception filter was added.

The extended native recovery-only suite passed on macOS arm64 using the isolated
UI preview at `127.0.0.1:5188`, including:

- Create a dirty Markdown source and locked preview in separate panes using the
  existing components. Prepare the split with an in-document drop; this is not
  evidence of an OS drag between windows.
- Detach the source with its pane context menu, retain the rendered dirty text
  in the project, then return the source through the pane context-menu action.
- Detach the preview itself, retain the source's dirty model in the project,
  and return the preview. After checkpoint/reload, both panes, the locked view
  mode and the exact unsaved text remain.
- Close one view without discarding the shared draft; the final view still asks
  for discard. Existing quit/relaunch, renderer crash, missing-resource recovery,
  duplicate-window edits, notebook close and last-window teardown checks also pass.

The production web build and 223 focused editor/window-transfer tests passed.
Dirty-diff and workspace-transition browser regressions passed with the patched
dependency. The latter's tab clicks now target the leading edge, inside collapsed
strips and clear of floating view controls; its previous centre click changed the
view instead of selecting the file. Targeted lint and formatting checks passed. An additional
native run while extending the scenario timed out awaiting docking closure with
both windows/text retained; the final run passed both handoffs. The fixture now
reports a visible docking rejection immediately rather than waiting only for
window closure. Stress/interruption acceptance remains required.

The current macOS console reports `CGSSessionScreenIsLocked: true` for the console
session. Full native presentation acceptance now checks this before launching and
fails with an explicit unlock prerequisite. The blocked full-mode command was
verified to exit unsuccessfully; it never silently substitutes recovery-only
coverage. Only console lock booleans are used, and no unlock action is performed.
Focus/fullscreen therefore remain unverified in this increment. Earlier successful
observations remain historical; rerun full mode on an unlocked desktop. Live OS
drag, active notebook/widget execution, real host/runtime recovery, monitor changes
and the remaining requirements below are still open.

## Required acceptance before completion

1. Open files, sessions, full panes, and projects using their context menus.
   Confirm exact chrome, tab order, active selection, and ordinary editor,
   terminal, notebook, preview, compilation, and sidebar actions.
2. Drag files/sessions into pane windows; dock panes into host/project windows;
   dock projects into their host. Cancel transfers and reject other hosts and
   incompatible profiles. Exercise the equivalent keyboard/menu return action.
3. Navigate to a detached project through cards, sidebars, palette, deep links,
   and notifications. Focus the existing window without duplicates. Close it,
   then navigate normally with its latest workspace state.
4. Close the host window, retaining only project/pane windows. Keep editing and
   terminal input working; refresh the connection and exercise authentication
   prompts. Reopen the host without another cockpit connection.
5. Transfer dirty and untitled files, duplicate views, notebook editors,
   source/preview pairs, and terminals. Verify text, view state, no accidental
   save, no repeated execution, and unchanged runtime identity. Record tested
   undo-history and terminal viewport continuity explicitly.
6. Interrupt each handoff phase: cancel, crash either renderer, lose an
   acknowledgement, and quit the app. Recover one ownership outcome without
   losing drafts or removing an unaccepted source.
7. Command-Q and relaunch, force interruption, machine restart, SSH disconnect,
   and daemon replacement with only detached windows open. Respect existing
   auto-resume and distinguish process survival from conversation recovery.
8. Save/load project and profile arrangements from a host window, including old
   layouts, repeated loads, mixed-project panes, dirty-work cancellation, offline
   hosts, missing resources, changed cockpit ports, and unrelated hosts/profiles.
9. Exercise notifications, update offers, menus, traffic lights, window drag,
   focus, fullscreen, monitor removal, keyboard navigation, themes, accents,
   density, and reduced motion on each supported desktop platform.
10. Confirm browser/mobile regressions are absent. Measure idle and active
    resource use as windows are added, including duplicate notifications/pollers.

Record platform/build, exact procedure, observed result, and anything untested for
each native run. Mocks and unit tests do not establish native drag or OS recovery.
