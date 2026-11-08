# Detached desktop windows

Implementation in progress, 2026-11-07. Design intent is in
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

Named window arrangements and native OS acceptance are still
pending. Pane/project detachment and menu return do not deliver the whole roadmap. Undo-stack transfer
is not implemented; restored editors use
new Monaco models with recovered text.

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

Native acceptance has not run. Use an isolated UI preview for desktop interaction;
start any real daemon from a plain shell, never from a coding-agent session.

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
