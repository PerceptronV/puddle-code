# Detached desktop windows

Status: proposed, 2026-11-07. This document describes planned work; no detached
window implementation or native acceptance is claimed. This concerns multiple
native app windows, independently of the Windows operating-system work in
[windows-cockpit.md](windows-cockpit.md).

**Instruction to the implementing agent:** document the implemented version in
[`docs/acceptance/windows.md`](../acceptance/windows.md). Create that document
during implementation and keep it current with the actual behavior, implementation
seams, migration choices, limitations, and reproducible acceptance procedures.
Record automated and native checks separately, including platform, result, and
anything not run. Do not copy this proposal there and describe it as delivered.
Update the relevant SPEC sections and changelog when behavior ships. This roadmap
remains the design intent; the acceptance document describes what was implemented.

## Outcome

Add two window types to the native desktop application while reusing the existing
workspace, pane, editor, terminal, sidebar, and tab components:

1. **Pane windows.** Right-click a file or session to open it in a dedicated
   window containing a pane. Right-click an existing pane to detach that entire
   pane, including its tabs. Omit the header island, both sidebar areas, and all
   other panes from the new window. Additional files/sessions can be dragged into
   its tab strip. A detached pane can be dragged back into an existing host or
   project window.
2. **Project windows.** Right-click a project to open its workspace in a dedicated
   window. Omit only the header island; retain the workspace sidebars and panes.
   While that project has a dedicated window, clicking the project in the host
   window focuses the dedicated window. Closing the project window or dragging it
   back returns the project to ordinary host-window navigation with its latest
   state.

All windows belong to a host and share its existing connection and recovery
process. A host window is optional: closing it must leave project and pane windows
usable. Command-Q, app restart, and interruptions restore the saved window set
through the normal host reconnection flow. Existing layout management gains the
ability to save/load these window arrangements and remains accessible only from
host windows initially.

Read [HUMANS.md](../../HUMANS.md) before UI work and [SPEC.md](../../SPEC.md),
especially §§8, 10, and 11, before changing architecture. Preserve the existing
browser/mobile experience. Do not require a new daemon or runtime ownership model.

## Assessment and existing seams

This is a moderate architectural extension. Rendering changes should be small;
most work is in connection lifetime, state ownership, transfer, and persistence.
It should not become a second implementation of the editor or workspace.

| Existing code | Reuse or required change |
| --- | --- |
| `packages/desktop/src/main.ts` | Currently combines one target, one cockpit, and one BrowserWindow. Separate the host connection from its windows. |
| `packages/desktop/src/reopen.ts`, `window-bounds.ts`, `refresh-navigation.ts` | Extend existing restore, placement, and refresh logic to several windows per host. |
| `packages/desktop/src/preload.ts`, `packages/web/src/lib/desktop.ts` | Add bounded desktop window capabilities and window context. |
| `packages/web/src/features/shell/ShellLayout.tsx` | Select chrome by window type while retaining connection/theme/error infrastructure. |
| `packages/web/src/features/workspace/Workspace.tsx` | Share workspace behavior; compose the full workspace or an isolated pane. |
| `workspace/layout/`, `workspace/panes/`, `workspace/tabs/` | Reuse layout operations, tab rendering, and file/session identities. |
| `workspace/use-ui-state.ts`, `features/layouts/` | Separate detached working sets from profile seeds; extend layout capture/apply. |
| `features/editor/buffers/`, `lib/persistence/drafts.ts` | Reuse buffers and draft recovery; add explicit transfer of unsaved state. |
| `workspace/keep-alive.tsx`, `features/terminal/Terminal.tsx` | Reuse viewer detach/attach and replay; do not move or restart host processes. |

Editor coordination already reports saves and dirty state through BroadcastChannel,
but deliberately supports independent editing rather than live text mirroring.
Terminal keep-alive moves DOM within one renderer. Neither mechanism transfers a
live component/model into another BrowserWindow. Cross-window continuity must be
implemented as state handoff and remounting the same components.

## Host connections and window identity

Introduce a desktop-owned host connection record with its existing RunningCockpit,
connection/refresh state, and a collection of window records. A window record has
a stable ID, a kind (`host`, `project`, or `pane`), host association, profile/project
context, working-set identity, and placement. Exact names are implementation
choices; keep these responsibilities separate:

```text
Host connection: cockpit, authority, refresh/reconnect
  Host window, if open
  Project windows
  Pane windows
```

- Reuse one cockpit origin and transport per existing connection target. Do not
  create a new SSH tunnel or bootstrap a daemon for each detached window.
- Keep the connection alive while any of its windows need it. Stop it through
  existing teardown when the last window closes or the app quits. Preserve
  existing supervised-host and SSH-attached fallback lifetime semantics.
- Serialize connection establishment and refresh per host. Refresh all surviving
  windows with their own destinations and fresh invitations when necessary;
  closing the initiating window must not strand its siblings.
- Choose an available host-associated window for SSH authentication and update
  prompts; do not retain a mandatory or invisible host-window parent.
- Retain existing origin/main-frame checks for IPC. Resolve host association from
  registered window identity, not an arbitrary target supplied by a renderer.
- Keep host transport, bootstrap, and authority implementation in CLI library
  helpers. Window lifecycle and registry belong to desktop. Do not duplicate
  recovery or installation logic in renderer window actions.

Track one dedicated project window per host/profile/project. Repeated opens focus
that window. Resolve project navigation through this registry from the dashboard,
sidebar, palette, deep links, and notification destinations where applicable.
Treat routing as a shared action, avoiding separate ad hoc behavior in each menu.

## Reusable presentation

Add an explicit desktop window context consumed at shell/workspace composition
boundaries. Extract a shared workspace controller only where needed to provide
layout, editor, session, compilation, and draft behavior to both presentations.
Avoid copying Workspace into separate project/pane implementations.

| Kind | Header island | Workspace sidebars | Center |
| --- | --- | --- | --- |
| Host | Existing | Existing | Existing dashboard/workspace |
| Project | Omitted | Existing | Dedicated project's workspace |
| Pane | Omitted | Omitted | Detached pane with its tab strip |

Hidden surfaces should not remain mounted as invisible active workspaces. Detaching
one pane does not close unrelated source panes or stop any sessions; only the
selected pane is transferred. Keep connection/error feedback usable in every
window. Scope shortcuts and palette actions to the presentation: the Layouts
popover and its shortcut are host-window-only in this first version.

On macOS the current top bar also supplies the window drag region and traffic-light
inset. Provide these native affordances in the remaining chrome without restoring
the removed header island or covering tabs. Give project windows an identifiable
drag/dock affordance despite the missing header. Review titles, focus, fullscreen,
minimum sizes, keyboard navigation, themes, host accents, density, and reduced
motion using the existing tokens and shared controls.

Audit shell-wide effects when mounting several renderers for one host: notification
delivery, update offers, sync work, and focus handling must not multiply user-facing
events or cause conflicting actions. Reuse existing coordination where available;
elect or route a responsibility explicitly where it currently assumes one window.

## Ownership and transfer

Model detach/dock as a transfer of an identified pane or project workspace. Keep
the source state recoverable until the destination has accepted it. A cross-window
drag is not permission to terminate a session, save a file, or copy host files.

1. Capture a revisioned snapshot of the selected pane/project and its relevant
   buffers and view state. Assign a transfer ID tied to source, destination, and
   host/profile context.
2. Prepare the destination and restore the state using the existing components.
3. Acknowledge the exact accepted revision and persist ownership before retiring
   the source presentation. Fence or reconcile edits during handoff so changes
   made after capture cannot disappear.
4. On cancellation/failure leave the source usable. On lost acknowledgement,
   inspect the recorded transfer outcome rather than issuing a second move.

Use the same transfer operations for context-menu detach and drag/dock. Native
file/session drag payloads already exist in `tabs/tab-transfer.ts`; pane/tab strip
drags currently use an in-document dnd-kit context. Add a bridge for native
cross-window drags rather than expecting pointer sensors to cross renderers.
Carry bounded references/transfer IDs in drag data, not dirty document contents.
Validate host/profile compatibility at the destination. Cross-host transfer is
outside this feature; it must not accidentally interpret a path on another host.
Provide a menu-based return action as an accessible alternative to dragging.

Preserve tab order, active tab, preview mode, editor selection/scroll, dirty text,
untitled draft identity, and relevant notebook/preview state. Reattach terminals
to the same session/runtime with existing replay and size/focus arbitration.
Never replay terminal input or notebook execution during transfer or restore.
Do not claim DOM identity or perfect scrollback continuity across renderers.

Full Monaco undo history does not transfer automatically. Prototype and record
what can be preserved before promising it; unsaved text preservation is required.
Existing independent duplicate file views retain their conflict behavior. Avoid
inventing global live buffer synchronization solely to implement detachment.

Closing a project window returns its latest workspace to normal host navigation
without requiring a host window to be open. Independently detached pane windows
remain independent. Closing a pane window uses existing tab/draft close policy;
it does not end its sessions. Explicit docking restores the pane to the selected
destination and retires its native window after acceptance. A failed close or
transfer must not drop dirty state.

## Durable state, recovery, and saved layouts

Introduce one versioned arrangement description shared by automatic recovery and
named-layout capture/apply. It identifies windows and their host/profile/project
context, pane trees/active tabs, ownership/return destinations, and revisions.
Keep dirty content in a suitable draft store referenced by the arrangement; avoid
embedding transient buffers or credentials in named layout records. Native bounds
and monitor/workspace placement are client-specific metadata.

The current `useUiState` keeps a per-window sessionStorage working set and writes
a last-writer-wins profile seed to the daemon. Detached renderers must not each
write their partial workspace over that full seed. Introduce an arrangement-aware
owner/writer for desktop state, with window-specific updates, while retaining
existing browser behavior. Authority must survive closing the host window; it
cannot live only in that window's React tree. Coordinate independent browser
clients without making their ordinary layout changes commandeer desktop windows.

- Migrate existing target-only/placement reopen records to host-window records.
  Retain legacy saved layouts as single-tree layouts.
- Persist arrangement changes during operation, not solely in Command-Q handlers.
  Use atomic snapshots and durable transfer outcomes to recover interrupted moves.
  Stable window IDs must survive changed cockpit ports and new renderer sessions.
- On startup reconnect once per required host and recreate its remembered windows.
  Restore project/pane-only sets without creating a host window as a prerequisite.
  Keep offline/pending hosts' arrangements for retry.
- Distinguish explicit window closure from app-wide quit. Command-Q must not dock
  projects or erase windows just because teardown emits close events. Reconcile
  renderer crashes against durable ownership before creating replacement views.
- Reuse existing display/bounds fallback; missing monitors must not make restored
  windows inaccessible. Missing projects, sessions, or files need recoverable
  placeholders or explicit pruning that retains dirty drafts.

Extend the existing Layouts popover and bridge to capture/apply an arrangement
through the desktop coordinator, including windows whose host window is closed.
Keep the established profile/project save scopes: a project save captures that
project's workspace and associated detached panes; a profile save captures its
arrangement on the current host. Applying one does not alter other hosts/profiles.
Define deterministic treatment of mixed-project panes before implementing this
projection; do not silently discard or duplicate their tabs.

Layout application computes a change plan, reuses matching windows, creates
missing ones, and retires superseded presentations after state acceptance.
Preserve existing dirty-work confirmation/recovery behavior; cancelled or partial
application must not erase unrelated windows. Reapplying the same layout should
not keep spawning duplicates. Save logical arrangement through the established
layout storage where portable; keep machine-specific geometry local. If schemas
change, read `packages/shared/PROTOCOL.md`, version/gate the additive capability,
and specify old-client behavior before shipping.

## Implementation sequence

1. **Bound the design.** Verify current seams and prototype cross-window native
   drag, dirty-buffer transfer, and native title-bar placement in isolated UI-only
   windows. Resolve the choices below and create the acceptance document with
   pending checks. Never launch puddled from a coding-agent session.
2. **Separate host and window lifetime.** Extract desktop connection/window
   registries, migrate reopen state, and make refresh/teardown operate on all
   associated windows. Test project/pane-only recovery before adding menus.
3. **Add shared presentations and project windows.** Introduce window context,
   reuse workspace composition, route project focus, and implement return on
   project close/dock without dependence on a host window.
4. **Implement pane transfers.** Add file/session/pane context actions, explicit
   state handoff, rollback/recovery, cross-window drag, and menu-based docking.
   Verify dirty editors, untitled files, terminals, notebooks, and previews.
5. **Extend layout management.** Share the arrangement format with automatic
   restore, add scoped capture/apply, preserve legacy layouts, and keep management
   confined to host windows.
6. **Complete native acceptance and documentation.** Exercise failures and
   recovery on supported desktop platforms, measure additional-window overhead,
   and record the implemented contract and outstanding limitations in
   `docs/acceptance/windows.md`. Update SPEC and changelog to match delivery.

Each phase should leave existing host-window behavior working. Do not expose a
detach action before its state handoff and recovery are safe.

## Acceptance requirements

Add focused automated coverage for registry/lifetime behavior, migrations,
ownership revisions, duplicate/lost transfer messages, scoped layout projection,
and dirty-state retention. Extend existing desktop lifecycle and web layout tests
instead of building an unrelated test harness. Native drag and OS window behavior
require real acceptance in addition to mocks.

The acceptance document must cover at least:

- Open a file, session, full pane, and project through their context menus;
  verify exact chrome, tab order, active selection, and existing component actions.
- Drag files/sessions into pane windows; dock panes into host/project windows;
  dock a project into its host. Cancel drops and reject incompatible host targets.
- Click an already detached project from every navigation surface; focus its
  existing window without duplicates. Close it and navigate normally again.
- Close the host window while project/pane windows remain; keep editing, terminal
  input, refresh, authentication prompts, and recovery functional.
- Transfer dirty/untitled files, duplicate file views, notebooks, source/preview
  pairs, and active terminals. Verify no lost text, accidental save, repeated
  execution, restarted process, or unacknowledged source removal.
- Crash source/destination renderers or quit during each handoff phase. Lose an
  acknowledgement. Recover a single logical ownership outcome with drafts intact.
- Command-Q/relaunch, app interruption, machine restart, SSH disconnect, and
  daemon replacement with only detached windows open. Distinguish viewer recovery
  from host process survival and respect the existing auto-resume policy.
- Save/load project and profile arrangements from the host, including legacy
  layouts, repeated loads, offline hosts, missing resources, changed ports, and
  dirty-work cancellation. Other hosts/profiles remain unaffected.
- Verify notifications, native menus, title bars, window focus, fullscreen,
  monitor removal, keyboard navigation, themes, accents, and reduced motion.
- Verify ordinary browser/mobile behavior and measure idle/active resource costs
  as window count grows; component reuse does not mean renderer memory is shared.

## Choices to settle during the first phase

These are bounded implementation decisions, not reasons to redesign the workspace:

- Whether opening an already visible file/session focuses an existing dedicated
  pane or moves that view; define duplicate-view behavior explicitly. Whole-pane
  detach always moves the selected pane.
- Whether pane windows initially allow internal splits or remain one pane with
  multiple tabs. The requested baseline requires one pane and additional tabs.
- How dedicated project windows behave when profile-wide layout is enabled,
  including extraction of mixed-project trees and docking without overwriting
  stored project slices. Do not silently flip the user's global layout setting.
- How mixed-project panes participate in project-scoped saves, and which return
  destination is used when their original host/project presentation is absent.
- Supported transfer continuity for undo history, terminal viewport, notebook
  UI state, and previews; document any limits without weakening draft safety.
- Exact persisted arrangement ownership and portable-layout schema, including
  compatibility with older hosts and independent browser windows.

The target is extensive component reuse with a contained window/state coordination
layer. Merely hiding chrome and opening another BrowserWindow is a useful prototype,
but does not complete the requested ownership, recovery, and layout behavior.
