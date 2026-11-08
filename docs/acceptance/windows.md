# Detached desktop windows

Implementation in progress, 2026-11-07. Design intent is in
[the roadmap](../roadmap/windows.md). This document records delivered code and
verification; pending items are not support claims.

## Implemented foundation

- `desktop/src/windows/connections.ts` owns one cockpit connection per target and
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
- `desktop/src/windows/state.ts` owns versioned working sets and dirty-buffer
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
- `web/features/windows/transfer-content.ts` provides the pane extraction
  projection. It preserves tab order, active and
  preview selection, view state, and relevant dirty buffers; duplicate source
  views keep their recoverable text. Other project slices and orphaned recovery
  drafts stay with the source. Mixed-project panes move intact with the current
  project as their anchor.
- The pane tab-strip context menu now offers **Open pane in window** on native
  host/project windows. `desktop/windows/transfers.ts` stages the destination,
  waits for its shared Workspace to mount, and then requires source confirmation.
  Source/destination renderers remain fenced during handoff. Failure or timeout
  rolls back; uncertain replies are observed without repeating the move. A dirty
  edit before confirmation cancels the move; one arriving afterward remains open
  in source recovery and is persisted. Application protocol 26.8 carries the
  capability-detected private lifecycle/transfer bridge.

Individual file/session context actions, project detachment and redirects, docking,
and named window arrangements are still pending. Whole-pane detachment alone does
not deliver the roadmap. Undo-stack transfer is not implemented; restored editors use
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
reload recovery in all three presentations. Host refresh/reload still needs the
same checkpoint integration; a renderer
crash can only recover the last durable snapshot.

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
