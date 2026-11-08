# Huddle implementation and acceptance

Status: foundation in progress, 2026-11-08. The full objective remains the
[huddle roadmap](../roadmap/huddle.md). Application 27.1 exposes inactive definition
creation/opening through local/SSH HTTP. Application 28.0 adds the sidebar entry
and graph panes. Manifest editing now shares ordinary editor drafts, undo and
conflict review; layout editing remains unfinished. The IDE now includes reviewed
manual execution controls and live history.
Application 28.2 exposes local/SSH manual execution and live-owner history APIs.
Runtime archives declare their internal huddle-role contracts;
application 27.0 now includes huddle session identity and migration 43 records
placements/owner roles. The daemon launcher and lifecycle controls now integrate
with session kill/archive; migration 44 retains Stop intent. Migration 45 adds
host-side agent-turn identities; the owner operation bridge remains pending. No user CLI command
is enabled yet.

## Implemented: host-side exact agent-turn admission (owner bridge pending)

`huddle/operations/turns/` now supplies a host-side ask/observe/acknowledge adapter
for huddle callers. It is an internal building block: the private huddle-owner
operation transport, source capability admission, spawn/attach/resume nodes and
production composition are still pending. Start/Apply continue rejecting
`sessions` capabilities; no graph can use this adapter through the application yet.

Migration **45** adds `huddle_runtime_turns`, independently of daemon-owned
`puddlang_runs`. An immutable admission binds the source owner identity,
execution/invocation/operation, revision/activation, exact destination runtime,
incarnation, placement/project/worktree and a canonical request digest. The row
retains the admitted agent turn, segment and native reference, plus an eventual
result receipt. Identity strings alone grant no authority: the private bridge
must supply a current dispatch/observation authority callback after validating
its owner, retained invocation, operation and declared resource bindings.
Database checks additionally enforce matching profiles, immutable source identity,
explicit worktree/placement, live dispatch targets and Stop/archive exclusion.
Observation and cancellation of an already admitted turn remain distinct from
permission to send another prompt.

`RuntimeProgrammeTurns.askFor` shares the existing busy gate, inspection,
one-send transport, correlated rejection handling and exact cancellation path
with ordinary puddlang asks. `db/stores/runtime-results/admission.ts` allocates
ordered identities across both caller tables and retained watermarks, and reserves
existing host/runtime result capacity in the same transaction as caller admission.
Failed mapping writes roll back the reservation. A positively unsent/rejected
request releases unused result capacity while retaining its non-reusable operation
identity; uncertain dispatch retains its debt. No ordinary agent IPC or protocol
version changes are required.

Huddle reads **do not mark replies consumed**. The host retains completed, failed
and cancelled outcomes until the private owner bridge confirms it durably stored
the exact result in the huddle ledger. An exact receipt then atomically records
acknowledgement and makes the agent result reclaimable. Repeated acknowledgement
is observation-only, even after result reclamation; a changed receipt/request or
binding is refused. Reconnection observes the admitted turn and never calls ask
again for that operation. Binding retention is bounded at 1,000 per execution,
16,384 per source owner and 65,536 per host; reaching a limit refuses new admission
without deleting replay protection. Safe operation-aware collection remains
unfinished, alongside the broader host resource accounting work.

Verification uses a synthetic source-huddle binding/authority and real isolated
agent owners with a test adapter. It covers a lost start-turn acknowledgement,
a replacement controller adopting the still-running agent's result without replay,
shared huddle/programme busy admission, revocation after inspection, positive
rejection cleanup and cancellation of the exact admitted turn after huddle Stop.
Database tests cover mixed-caller ordering, scope/worktree changes, request JSON
round trips, capacity rollback, retention bounds, unread results through pressure
and a separately reopened database, receipt/reclamation semantics and schema-44
migration preserving existing programme mappings/results. The older terminal
migration fixture now constructs an actual schema-31 database rather than
rewinding today's schema number while leaving newer tables behind.

Verified 2026-11-08: the expanded shared/huddle/puddlang, programme-turn,
runtime-lifecycle, database and startup run passed **536 tests in 80 files**;
three opt-in native/staged-runtime tests were skipped. The focused turn suites
then passed **26 tests in three files**, including the added controller-replacement
and canonical-request checks. After extracting scope checks into `authority.ts`,
all ten turn-store checks passed again. Shared/daemon/CLI TypeScript, repository
ESLint and Prettier passed. No production daemon, provider account or native
window was used.

This does not establish provider-native or full huddle graph integration, actual
huddle-owner receipt delivery, packaged daemon replacement, SSH or reboot survival.
The next bridge increment must durably record owner intent before dispatch,
revalidate declared bindings, settle/acknowledge outcomes only after owner storage,
wait through daemon absence within root limits, and reconcile consumed operations
without replay before enabling agent-capable graphs.

## Implemented: IDE execution controls and live history

`web/features/huddle/execution/` groups transport, shared command/query state,
input review and history presentation. Application 28.2, local/SSH transport and
the existing native huddle capability gate execution controls. Older supporting
hosts retain authoring without calls to these newer routes. No protocol or database
version changes were needed for this UI increment.

- Start and Apply inspect the owner and freshly capture saved source before
  showing its digest, definition worktree and editable JSON variables. Declared
  defaults are visible; missing required or invalid values fail before dispatch.
  Dirty local buffers under the definition directory and source conflicts block
  source activation. Start alone sends no manual event.
- Run uses the reviewed activation and a fresh per-dialog event UUID. Input is
  explicit bounded JSON, initially `null`. Saved manual-trigger nodes are only
  suggestions; an existing active trigger id can be entered when the revisions
  differ. Run never saves or applies source edits.
- Interrupt, Resume of the retained activation, and Stop use inspected owner
  targets. Runtime status distinguishes stopped, armed/idle, executing,
  interrupted and unavailable observations, and identifies host-session lifetime.
- Pending/error state is shared per placement in one renderer and survives view
  remounts. Mutations have no retry/reconnect queue. Any failed command requires
  explicit runtime/history observation before a subsequent command; failed
  observation retains that barrier. Separate native windows still rely on the
  server's exact-owner admission and event identity.
- Run acceptance opens live history at the returned execution id; it does not
  imply completion. History offers bounded execution pages and per-execution
  node/operation pages, showing states, inputs, results and consumed dispatch.
  Previous/Next and refresh retain cursor semantics; focused runtime and visible
  history pages poll every three seconds, stopping on errors. Value previews are
  visibly truncated at 16 KiB. Stopped/offline history, full-value export and active
  revision/binding inspection remain unfinished.

UI-only verification uses `test/huddle/execution.browser.mjs`, with synthetic
HTTP replies and no daemon or provider. It covers the 28.1 capability gate,
required variable validation, held Start without duplicate dispatch, explicit
Run/results, dirty source, saved Apply, Interrupt/Resume/Stop, stale source after
review, accepted Run with a lost reply, failed outcome observation, explicit next
input, pagination and narrow dialogs. Existing authoring/editing regressions cover
creation/opening, unsupported runtimes, shared drafts, conflict review and closing
views without execution. These checks establish UI behaviour only; real isolated
owner/API evidence is recorded separately below. Native service, live-provider,
SSH and reboot acceptance remain pending.

Verified 2026-11-08: all three huddle browser scripts passed against the UI-only
preview; seven huddle unit tests in three files passed. Shared/web TypeScript,
repository ESLint, Prettier and semantic-token/contrast checks passed. Reviewed
light-theme history and dark-theme narrow input screenshots. The `pnpm lint`
wrapper tried dependency installation and stopped before running checks; the
installed ESLint, Prettier and token-check commands were run directly instead,
without changing dependencies. No production daemon or native window was started.

## Implemented: local/SSH lifecycle admission and live history API

Application **28.2** adds the following placement-scoped routes under
`/api/huddle/:profile/sessions/:sid`. Source creation/opening and saving remain
inactive. These routes use the existing local/SSH lease and host-origin boundary;
remote profile leases and connector requests remain excluded.

| Route | Behaviour |
| --- | --- |
| GET `runtime` | Inspect the connected owner's target, build, lifetime, lifecycle and execution state. A disconnected owner exposes identity/build only. No owner plus unresolved ownership is distinct from a clean stopped placement. |
| POST `start` | Require an inspected saved-source digest and explicit variable bindings. Capture and validate source under the registered repository lock, admit one pinned owner, then arm it. No manual event is sent. |
| POST `apply` | Require the same source inputs plus the reviewed owner/activation target. Publish captured source, then activate it against that target. Previously accepted executions retain their original revision/bindings. |
| POST `rearm` | Arm the reviewed retained activation; do not capture changed source or replay interrupted inputs. |
| POST `run` | Require the reviewed target, manual-trigger node, caller-generated UUID event id and explicit JSON data. Return execution acceptance/duplicate status separately from completion. |
| POST `interrupt` | Interrupt the reviewed owner, retaining its history. |
| POST `stop` | Review the exact owner/activation, consume durable Stop once and observe clean shutdown before reporting success. |
| POST `history` | Read one bounded page from an explicitly selected live runtime/incarnation. Execution pages may filter by revision; invocation/operation pages require an execution id. |

`huddle/execution/` owns placement authority, source admission, registered-worktree
binding and public projections. It shares `HuddleService.withSnapshot` rather than
duplicating source capture or repository locking. Every asynchronous admission and
private dispatch rechecks the profile, project, placement and request authority.
Start and Apply reject archived placements/projects, stale captured source,
invalid variables and unsupported execution modes. Concurrent Starts share the
repository lock and cannot replace a newly admitted owner. A lost launch/arm reply
leaves the actual owner observable; it never causes another launch. A later
explicit Start after clean Stop creates a new runtime.

This slice runs queued manual inputs, local script nodes and built-in result
readouts. Explicit literal/variable worktree settings resolve to canonical roots
registered to the definition's project. Agent-operation capabilities, account/
session/project/agent resource settings and local trigger/readout adapters are
rejected until their bridges are implemented. This is an implementation limit,
not the final scope of huddles. Cross-project binding and provider dispatch remain
required. Scripts retain the trusted-code execution model; these checks are not
an OS sandbox.

Installation event identity is a private `{ format: 1, id: UUID }` record in
`huddle-host.json`, created once under a host claim with durable publication. It
is not a credential. Corrupt/symlinked records are refused rather than replaced.
Ordinary runtime 1.1, private huddle contracts and database schema are unchanged.
Changing the selected default to an unsupported runtime blocks new Start, but does
not replace or disable an existing capable owner. Missing/symlinked source blocks
new work; inspection, history, Interrupt and Stop do not require source files.

History projections omit private ledger keys/limits, invocation activation tokens,
operation input/target data and all owner secrets, launch paths and process data.
Node inputs/results remain visible as workflow data. Bound pages retain the
existing 256-row/1 MiB private-ledger limits. Their cursor enumerates rows, not
changes: refresh earlier pages for mutable outcomes. Public inspection identifies
the active activation, but does not yet expose its revision digest/binding details.
Retained history after owner shutdown, reboot recovery, auto-start controls,
provider-backed nodes remain unfinished; the IDE integration is documented above.

Verification: **377 tests in 53 files** passed across the shared schemas, complete
huddle suite, daemon profile-authority tests and connector policy tests. Six new
API tests use in-process Hono routes with real isolated owner/worker processes,
an installed-release fixture and a fake supervisor. They cover saved Start without
input, exact Run deduplication and result observation, Apply to changed script
bytes, stale targets, Interrupt/Rearm/Stop, concurrent Starts, lost arming/Run
replies, later explicit Start, unsupported defaults, missing source, wrong/remote
profiles, revoked authority and changed worktree bindings after storage admission.
Additional tests cover public projections, bounded requests, empty-graph variable
validation, unsupported adapters and persistent host identity. Shared, daemon, web,
CLI and desktop TypeScript builds, scoped ESLint and formatting passed. This is
isolated API/runtime evidence, not IDE interaction, native service supervision,
live-provider, SSH or reboot acceptance. No production daemon was launched.

## Implemented: reviewed-owner commands and bounded history reads

The internal daemon controller now requires an inspected runtime id, incarnation,
control generation and activation id for Apply, Arm, Run and Interrupt. Activation
identity binds both the captured revision and its resolved settings. The controller
pins the owner before queueing, inspects and compares the activation inside the
queue, then rechecks authority and consumed Stop immediately before dispatch.
A queued Run cannot silently follow an earlier Apply to another activation.
Request values are copied before queueing; callers cannot replace reviewed input
by mutating their objects. Existing session kill/archive and reviewed host removal
retain their exact-owner Stop policy and durable consumption.

`HuddleRuntimeControls.records` reads executions, invocations and operations from
one explicitly selected live owner, with query/record validation in
`runtime/huddle/controller/history.ts`. Invocation/operation queries require an
execution id; execution queries may filter by revision. Pages retain the ledger's
256-row/1 MiB bounds and validate row ordering, identities, schemas and parent
filters. Responses are discarded after authority loss or owner replacement.
These are retained-row cursors, not a stream of updates: refresh a previous page
to observe its mutable outcomes. An empty page retains the requested cursor.
Unknown operations remain unknown.

This controller increment originally added no HTTP routes or UI controls; the
28.2 routes above now reuse it. It does not read stopped owners' ledgers or change
private owner contracts, ordinary runtime 1.1, or remote protocol 5. Retained/offline
history projection remains pending; the IDE now uses the 28.2 APIs above.

Verification: **184 tests in 31 files** passed across shared/huddle and
daemon/huddle, including five new real isolated-owner controller tests and four
history validation tests. They cover stale owner/incarnation/activation/generation,
Apply before queued Run, observable results and mutable-page refresh, lost Run
acknowledgement without redispatch, authority loss, Stop during inspection, and
copied queued activation inputs. The existing pinned-launch, archive/removal,
daemon replacement and host-update tests passed. Shared/daemon TypeScript and
scoped ESLint passed. The first restricted run could not create temporary sockets;
the successful run used isolated test processes with socket permission. No
production daemon or native desktop was launched.

## Implemented: editable manifest graph and shared source drafts

Graph views now edit the same Monaco text model as their `huddle.json` source tab.
Add node offers searchable Run/Result built-ins and references to local component
contracts. Connections have labelled output/input selectors and explicit
disconnect controls, usable with keyboard or touch. Delete node removes its
incident edges while retaining component files. Each graph edit is an undo step;
Undo/Redo also traverses edits made in the ordinary JSON source editor. Invalid
JSON, future formats and mismatched directory ids disable graph edits without
rewriting the source. Graph validation displays diagnostics for incomplete drafts.

The inspector generates literal/variable binding controls from component parameters:
text, booleans and general JSON values, with declared variable choices, explicit
Apply/Clear and visible defaults. Worktree fields retain explicit roots or variable
references. Node colours use the existing swatches/custom picker and icons use the
profile catalogue in the existing popover. Resource-specific pickers, richer
prompt/enum controls, variable declaration editing and feedback-edge controls are
still pending. Adding a local node references its contract; it does not generate
its script or template files.

Save and the normal save shortcut use the **existing editor file save path**, with
its loaded mtime, stale-file rejection, opt-in comparison and reconciliation.
The separate application-28.1 full-capture digest save API remains available for
structured authoring; this UI increment does not route ordinary source buffers
through it or claim whole-component-bundle compare-and-swap. Saving never applies
a revision or runs a node. Clean manifests follow the editor's focus-aware file
refresh; dirty manifests keep their text when an agent changes disk. Newly
referenced local component contracts load after Save/Refresh. Live component-file
observation remains pending.

The existing IndexedDB draft writer and native buffer capture retain edits.
Huddle tabs count as holders of their manifest even with no source tab open:
pane/tab/project transfers, arrangement planning, orphan recovery, native close
review and model lifetimes recognise that relationship. Separate source tabs
or duplicate huddle views retain a copy during transfer. Divergent native drafts
still refuse a silent merge. Closing one of multiple views does not discard shared
edits; closing the final view uses the existing Keep editing/Discard dialogue.
Save is available in the editor before closing; a Save choice inside that close
dialogue remains pending. Archive retains a source tab so removing the session
view cannot silently discard its buffer. App/runtime protocols and desktop storage
format are unchanged. The save registry now retains all mounted holders, restoring
the surviving graph/source saver when the newest holder unmounts.

Built-in contracts now live in `shared/huddle/components/core.ts`, used by both
the runtime and UI; the daemon forwarding path was removed. New UI logic is
grouped under `huddle/documents/` and `huddle/inspector/`.

Evidence: 474 shared/workspace/window/editor unit tests passed in 63 files, plus
38 isolated daemon authoring/source/scheduler tests in 3 files. The headless
`test/huddle/editing.browser.mjs` passes node/connection edits, undo/redo,
icon/colour changes, keyboard Save, shared JSON edits, stale-save comparison,
custom string/boolean/JSON/worktree-variable settings, and duplicate-view/final
view close review. It asserts no Start/Run/Resume request. The existing huddle
creation/inspection/narrow-view browser check also passed. All 13 existing headless
window acceptance cases passed in one run, including transfers, arrangements,
workspace continuity and component regressions. Native OS transfer,
browser reload and complete graph view-state acceptance remain separate work.

## Implemented: revision-checked source saves

Application **28.1** adds `PUT /api/huddle/:profile/definitions/:id` for local/SSH
authoring. The body is `{ project_id, worktree, expected_digest, edit }`, where
`edit` is either `{ file: "huddle.json", value: <format-1 definition> }` or
`{ file: "layout.json", value: <format-1 layout> }`. The response uses the existing
document/digest/diagnostics shape. Other files and arbitrary paths are not accepted.
Unknown fields/formats are rejected rather than dropped, and the definition id
must match the directory. Structurally valid drafts may have graph diagnostics;
saving them never activates them or creates an owner/session/provider operation.
Editing an existing definition requires no capable runtime selection.

The service holds the existing repository mutation lock, checks profile/worktree
scope and request authority, captures current source, compares `expected_digest`,
and performs storage admission. Before publication, the writer rechecks authority,
ordinary directories, every captured file's bytes and absent-layout state. Changed
source returns `409 huddle_source_changed`, including edits to captured scripts.
The byte/file bounds remain enforced. One exclusively created sibling file is
flushed, checked again, renamed over the target and followed by a directory flush.
Existing file permission bits survive the process umask. Failure before rename
leaves the target intact and removes the staging file. Identical source is a no-op.

Manifest and layout writes are **separate publications**, not a multi-file
transaction. The final comparison/rename is synchronous inside this daemon, but
does not lock external editors: an external process can still race the filesystem
operations. A failure after rename, including failed response capture or directory
flush, may mean the source was saved. Inspect before reconciling or attempting a
new edit; do not substitute a fresh digest and blindly replay. Source saves have
no rollback of an already published file and no automatic retries.

Verification covers competing service saves; source/layout edits, revocation,
archive and storage failure during admission; script-dependency changes; symlink
rejection; staging/rename failures; permission preservation; id/schema/size bounds;
and publication followed by failed response observation. Runtime binding tables
remain empty during these authoring tests. The graph UI's shared editor-buffer
integration is described above; the full-capture digest API is a separate save path.

Validation: **219 tests in 30 files passed** across shared contracts, huddle
authoring/placement boundaries, source capture and controller integration. The
expanded source-writer suite then passed **12 tests**, adding directory-flush
failure and file-count/bundle-size boundary checks. The controller tests initially
hit sandbox `EPERM` when opening their temporary sockets; the same suite passed
with socket access. Shared/daemon/web/desktop TypeScript builds, scoped ESLint and
formatting checks passed. These are isolated fixtures, not production daemon or
native desktop runs.

## Implemented: sidebar creation and huddle views

Application **28.0** extends the closed `TabRef` union with
`{ type: 'huddle', session: <placement UUID> }`. This requires a coordinated
frontend/daemon update; ordinary runtime 1.1 and the huddle owner contract are
unchanged. Huddles use `huddle:<session>` keys in pane trees and their own native
lookup identity. They never enter xterm keep-alive, terminal attachment, prompt
paste, captured-environment controls, ordinary Resume or runtime restart.

The right sidebar creation tray, collapsed rail and project context menus offer
**New huddle**, using the existing Puddle glyph. The local/SSH dialog names the
project worktree explicitly, creates a blank inactive graph, and lists discovered
huddles for opening. Runtime support is checked before enabling Create. An
unsupported runtime still permits inspecting/opening an already installed huddle.
Create mutations have no automatic retry; a failed/uncertain create refreshes
saved definitions for inspection. The worktree picker ignores empty internal
Select events so loading its primary-root default does not clear that selection.

Huddle tabs use ordinary preview/pin, close/reopen, split, drag, project layout,
archive and window-transfer paths. Multiple panes may view one placement; closing
a view does not stop its owner. Opening source leaves its huddle tab available.
The graph pane displays saved node positions (or a simple initial arrangement),
labelled input/output ports and connections, node selection, zoom and scrolling.
A node-list view exposes connections without precise pointer positioning. The
inspector shows parameter bindings and opens local contracts/scripts through the
existing editor. Open definition opens `huddle.json`; Refresh captures its latest
saved contents. Missing definitions report errors without discarding the tab.
The local narrow layout displays huddle content without a terminal composer or
PTY attachment. Remote authoring remains disabled.

Desktop recovery **format 4** migrates versions 2 and 3 without changing their
existing content. The preload advertises `windows.huddles`; older shells cannot
create/open huddle content or accept a huddle-containing working-set seed, including
parked project slices. They receive an update-required error before restore/write.
Named layouts continue using their existing envelope with the application-28 tab
union. Native persistence, project partition, tab/pane transfer and active-session
restoration preserve the huddle identity independently from agent/terminal tabs.

Code is grouped under web `features/huddle/{documents,canvas}/`, with pane
composition at its root and navigation integrations beside existing workspace and
window code. Graph code loads lazily. UI primitives, glyphs, icon catalogue and
appearance colours reuse the existing Puddle components and semantic tokens.

Verification: **491 tests passed in 63 files** across shared contracts, workspace,
window transfers/state, huddle navigation and desktop persistence. Shared, daemon,
web and desktop TypeScript builds passed. Token checks passed both themes and all
70 contrast pairs per theme. The isolated browser check
`PREVIEW_URL=http://127.0.0.1:5194/ node packages/web/test/huddle/authoring.browser.mjs`
passed creation, saved-graph opening, inspection/list/zoom, source navigation,
collapsed-rail creation, unavailable-runtime gating and the narrow view. It asserts
one create request and no huddle terminal attachment or Start/Run/Resume request.
This uses in-memory HTTP/WS fixtures, not a real daemon or provider.
All 13 existing headless window cases also passed across the initial run and a
targeted rerun. The initial `browser-workspace` case observed three unexpected
tab-entry animations; it passed unchanged in isolation, followed by
`browser-components`. This intermittent animation result remains recorded here;
no assertion was weakened. Light and dark huddle screenshots were inspected.

Later manifest editing is documented above. Still pending: node movement and wire
dragging, complete generated settings and component-change observation,
retained graph camera/selection across transfers, templates, IDE execution
controls/history and authoring assistance. This is an initial inspectable pane,
not acceptance of the complete IDE. Native OS focus/drag and packaged continuity
remain separate pending checks.

## Implemented: inactive authoring API

Application **27.1** adds local/SSH routes under `/api/huddle/:profile`:

| Method/path | Behaviour |
| --- | --- |
| `GET /availability` | Reports installed huddle support, selected build and service/host-session lifetime; no launch. |
| `GET /definitions?project_id=…&worktree=…` | Bounded data-only discovery, including separate malformed-sibling errors. |
| `GET /definitions/:id?project_id=…&worktree=…` | Captured definition, layout, resolved component contracts, digest and diagnostics; no module evaluation or source bundle in the response. |
| `POST /definitions` | `{ project_id, worktree, name }` creates a blank definition and stopped placement, returning HTTP 201. |
| `POST /open` | `{ project_id, worktree, huddle_id }` opens a saved definition, returning its unique placement and document. |

Shared schemas live under `api/huddle/authoring.ts`; thin routes compose
`huddle/control/service.ts`. Caller authority and profile/project membership are
checked before work and after asynchronous resolution, storage admission and
capture. The worktree must be an explicit absolute root from the project's
registered repository. Aliases canonicalise to the same placement. Repository
locking serialises these actions with managed worktree mutations. Archived
projects require unarchiving; opening an archived placement does not unarchive it.

Creation checks the installed runtime's exact huddle metadata/helpers and available
lifetime before any source write, then rechecks selection before source publication
and placement insertion. Storage admission covers the project root and private
home. Missing support never falls back to a daemon-owned process. Existing
placements remain openable after the selected default loses huddle support;
read-only discovery and inspection require no runtime support. Creating a new
placement from existing source still requires capable runtime support.

Each definition gets a server-generated random 32-character lowercase hex id in
`.puddle/huddle/<id>/huddle.json`. Exclusive directory/file creation never replaces
another definition; symlinked collection directories are refused. The initial
graph is blank, with explicit finite execution defaults. Creation/opening adds no
runtime binding, PTY, account, provider conversation or branch ownership. The
existing `sessions-changed` notification invalidates other views when a placement
is created. No trigger is armed and no agent prompt is sent.

Filesystem publication and SQLite placement insertion are separate operations.
If publication succeeds but later admission/insertion fails, source remains for
explicit discovery/open. A lost create reply must be observed by discovery; do
not automatically retry creation, because each create is a distinct definition.
Repeated open is idempotent at the placement key, including concurrent requests.
Remote profile leases are denied both by the existing profile middleware and the
huddle routes; the connector allowlist and remote protocol remain unchanged.

Automated coverage uses temporary Git repositories, SQLite and passive installed
release fixtures. It exercises distinct definitions, alias/concurrent opens,
unsupported runtime and default changes, authority revocation before writes and
after capture, project archival, selection changes, storage rejection, foreign
profiles, invalid roots, symlinked collections, retained-source recovery, strict
HTTP inputs and remote-lease denial. These checks do not launch an owner or prove
native supervision, provider orchestration or UI acceptance.

Verification: **238 tests passed in 31 files** across shared contracts, huddle
control/controller, definition capture, runtime selection, HTTP and profile
security. The first sandboxed attempt passed 225 checks; 13 owner-process checks
could not bind private Unix sockets (`EPERM`). The same suite passed with the
required socket permission using isolated fixture homes. Shared/daemon/web
TypeScript builds, scoped lint, formatting and whitespace checks passed.

Still pending for the authoring API: source/graph conflict-aware editing,
templates and IDE Start/Run (the 28.2 HTTP controls above are implemented). Sidebar opening and initial tab integration are
recorded above.

## Implemented: application placements and runtime inventory

Application protocol **27.0** adds `Session.kind = 'huddle'` and its `huddle_id`.
This is a coordinated frontend/daemon major transition because older clients
validate a closed kind enum. Agent/terminal runtime protocol **1.1**, the huddle
owner's unshipped contract 1 and remote transport protocol 5 are unchanged.
Earlier foundation entries below describe their own increments, which added no
application wire changes.

Migration **43** adds a unique project/canonical-worktree/definition placement.
The internal `db/stores/huddle/placements.ts` opens one stopped identity, canonicalises
worktree aliases and returns the existing identity on repeated opens, including
an archived one. Different definitions in one worktree and the same portable
definition in different worktrees remain independent. Opening does not write
definition files, unarchive, arm triggers or launch an owner. The public authoring
service authorises the project/worktree and validates installed huddle support
before creating a placement; this helper grants neither scope nor runtime admission.

Database guards forbid provider/account/conversation attachment, branch ownership,
implicit cwd, conversion of an ordinary placement and relocation of a huddle's
identity. Huddle projections omit agent mode. Ordinary session creation retains
the agent/terminal-only request and UI types; ordinary resume, shell creation
and runtime inspection/restart refuse huddles before launch effects. A stopped
placement can use reversible archive/unarchive without registering onboarding.
Running huddle kill/archive now uses the controls described below; creation and
Start/Run routes are now implemented in application 28.2 as described above.

`RuntimeStore.prepare` records the huddle role, id and required capabilities in the
existing runtime inventory, checks that they match the placement and preserves
all ordinary launch fingerprints. Huddle bindings have no active terminal segment,
terminal-placement row or provider identity. Shared worktree/release retention
sees their prepared/running owners. Ordinary terminal observations cannot attach
segments to them. Migration retains historical agent/terminal records as role
`session`; it does not restart or rewrite their owners. Role-aware connections and
daemon projection and update checkpoints are implemented below; these internal
records do not enable public huddle launches.

The shared session glyph renders the Puddle mark and sidebar labels/search identify
the huddle kind. This is presentation groundwork; there is no creation tray action,
canvas, huddle tab or window content yet.

Verification: **269 tests in 39 files** passed across shared schemas, placement and
database migrations, ordinary runtime ownership, session runtime maintenance,
puddlang outcome migration and web session/glyph helpers. A separate real-store
session-boundary test passed, proving ordinary controls create no PTY/owner and
archive/unarchive adds no onboarding. Schema-42 migration coverage verifies
unchanged agent/terminal identities, fingerprints, cursors and terminal history,
including idempotent preparation with the old launch inputs. Older migration
fixtures now seed historical columns independently of the current session writer.
Shared/daemon/web TypeScript, scoped ESLint and changed-file formatting checks passed.

## Implemented: daemon adoption and lifecycle projection

`runtime/huddle/controller/` now owns discovery, coarse session projection and
retirement, composed by the ordinary runtime connection/reconciliation services
and wired into daemon startup/shutdown. Both roles share the existing exclusive
controller claim; `getHuddle` never exposes a graph owner through terminal controls.
Adoption validates the exact private launch, committed placement, build, huddle
scope and capabilities, without consulting the newly selected default runtime.

The unshipped owner contract 1 adds a persisted monotonic `observation` version,
`persistencePending`, `executing` and bounded `changed` notifications. Observation
versions are distinct from consumed command sequences. The owner publishes a
notification after persisting state; the daemon coalesces notifications and
inspects asynchronously. Settled idle owners have no polling timer. Failed
observations retry with bounded backoff; no mutation is retried. An armed owner
projects `running`, a stopped owner projects `exited`, and interrupted/failed
control projects `interrupted`. Detailed execution state and result history remain
in the private owner protocol/ledger; no public huddle projection endpoint exists.

`RuntimeStore.observeHuddle` checks scope, rejects pending persistence and backwards
versions, and commits the observation cursor with session status in one transaction.
A failed write preserves the prior cursor. Host maintenance pause/drain and daemon
shutdown include the huddle projector; release inspects changes accumulated while
paused. Disconnecting a daemon leaves independent graph workers running. The next
controller observes their results without sending Run or rearming triggers.

Retirement holds the existing launch, dispatch, execution and process-memory claims,
validates exact retained state, and writes the durable delayed-launch fence. Only
a clean exited state with stopped control, no active execution/workers and no
failure releases the binding and memory grant. A crash becomes `interrupted` while
retaining unresolved worktree, release and memory references; recovery still needs
descendant/service fencing. Corrupt, missing previously observed or mismatched
records remain unavailable. Boot reconciliation excludes huddles from ordinary
auto-resume and onboarding. This does not implement a new owner after a crash,
native service recovery or public Start at that increment; see the later 28.2 API
evidence above. Host-update checkpoint compatibility is
implemented in the later increment below.

Verification: the expanded shared/huddle and ordinary discovery, daemon adoption,
ownership, host-memory retirement, maintenance and compatibility suites passed
**334 tests in 50 files**. The subsequent **six-test huddle adoption suite** also
passed, adding real isolated daemon replacement: two daemon processes successively
adopt the same live owner, a script finishes across the handoff, and its effect
occurs once. Other cases cover mixed owner roles, controllerless completion,
pause/catch-up, no idle polls, failed projection rollback, forged/incomplete
observations, mismatched live metadata, clean shutdown and crash retention.
These fixtures use temporary homes, sanitized environments and deterministic
independent processes; they establish no native supervision or reboot promise.
Shared/daemon/web TypeScript, scoped ESLint and changed-file formatting checks passed.

## Implemented: pinned launch and exact-owner lifecycle controls

`RuntimeLauncher.launchHuddle` shares the ordinary launch admission, maintenance
pause, pending-attempt limit and independent supervisor. Its role-specific code
lives in `runtime/huddle/lifecycle/`. Only a capable installed runtime is accepted;
the ordinary explicit executable override does not silently imply huddle support.
The launcher captures the selected release, validates source/activation/bindings,
publishes an immutable revision, writes one launch intent, reserves host memory
and dispatches the common supervisor once. Authority and exact selection are
rechecked before intent/dispatch, including between systemd commands. Revoked
authority, changed selection, archived placement and unresolved prior ownership
refuse launch. An accepted or uncertain dispatch never falls back or redispatches.
Readiness requires authenticated adoption and committed projection. New owners
remain stopped until explicitly armed; launch alone executes no graph.

`runtime/huddle/controller/controls.ts` supplies queued Inspect, Apply, Arm, Run,
Interrupt and Stop. Each queued operation retains its original owner/client and
rechecks authority before dispatch; it cannot target a later owner. Commands wait
for durable projection where relevant, while unknown outcomes stay explicit.
Apply expects its revision already published by the authorised source service.
Run carries a stable caller event id and observes duplicate acceptance rather
than creating another execution. Resource bindings remain supplied by a trusted
caller; public project/account/worktree resolution is not enabled by these helpers.

Migration **44** adds `huddle_stop_requests`, without a terminal segment. Stop is
consumed durably before shutdown, so a repeated request only observes the exact
owner's outcome. Kill and Archive on existing huddle sessions use this path; Archive
waits for verified clean shutdown and refuses unresolved crashed ownership. It
keeps definition/worktree files and session history. These controls share ordinary
maintenance pause/drain. Changing the selected default to an unsupported runtime
does not block Stop on an existing capable owner.

A launch which has neither retained state nor a consumption marker can retire
under all launch/dispatch/execution/memory claims and a durable delayed-start fence.
This permits a new explicit attempt after pre-dispatch memory refusal. Missing state
after consumption does not prove that scripts never started. Automatic service
cleanup now excludes interrupted huddles; their memory/worktree/release references
remain protected until descendant recovery is proven.

Lifecycle verification uses a temporary installed layout containing the bundled
owner/helpers and a copied Node executable, with a deterministic supervisor runner.
It covers inactive launch, pinned selection, a lost supervisor reply, stable Run
deduplication, interruption, lost Stop acknowledgement, consumed Stop, authority
revocation while queued, unsupported/default changes, invalid activation and memory
refusal. A real isolated daemon HTTP Archive request stops a busy huddle before
archiving its placement. This establishes backend integration, not native manager
or reboot acceptance. Historical migration fixtures now build actual schema-36/38/39/40
databases from the ordered migrations instead of relabelling current tables.

Verification: the expanded shared/huddle, runtime controller/lifecycle, host-memory,
maintenance, database and puddlang outcome run covered **492 tests in 74 files**.
It passed 488 tests and exposed four historical-fixture failures; after the fixture
corrections, all **34 tests in those four files** passed. Shared/daemon/web
TypeScript, scoped ESLint and changed-file formatting checks passed. Native service
manager and reboot acceptance remain unperformed.

## Implemented: host-update compatibility, checkpoints and adoption

Archives now include a separate `DAEMON_RUNTIME_CAPABILITIES.json`, generated by
`puddled --daemon-runtime-capabilities`. Format 1 binds the daemon build and
application protocol to supported huddle owner/definition/component/ledger
contracts. Runtime execution support in `RUNTIME_CAPABILITIES.json` does not imply
daemon adoption support. Historical `HOST_CAPABILITIES.json` remains unchanged;
ordinary owners need neither new declaration. Readers inspect at most 32 KiB,
reject symlinks/non-files/malformed metadata, and validate the exact staged
receipt, generation, version and application protocol without executing candidates.
A missing declaration supplies no huddle support.

Daemon-update preflight inspects huddles through their own authenticated clients,
requiring matching launch/scope/capabilities, durable progress and service lifetime.
It checks explicit candidate support, fingerprints role/id/contracts with ownership,
and binds daemon role metadata into approval. It rejects unresolved interrupted
huddle inventory; runtime-default updates still leave existing owners alone.
Shutdown checkpoints retain optional `huddle: {id, capabilities}` beside each
huddle owner's existing identity, pinned build/release and committed observation
cursor. Ordinary checkpoint entries keep their existing shape. The existing raw
checkpoint digest includes this metadata.

Activation, stopped-update continuation and explicit restart recovery all require
candidate huddle support before selection/start. Recovery reads current committed
SQLite/WAL and the huddle's own launch/state format without migrating it; owners
created after the original checkpoint require support too. It retains the exact
huddle identity/contracts across subsequent recovery attempts and rejects lost
or incomplete committed progress. Fresh adoption checks the same live huddle,
matching scope/build/contracts and settled durable projection under a newer daemon
controller. A terminal journal or changed runtime default cannot stand in for that
proof. Neither inspection nor adoption sends Run, rearms a graph or replays a
completed invocation.

Verification includes real independent ordinary and huddle owners in temporary
homes: mixed shutdown checkpoint capture, read-only recovery, absent/incompatible
candidate support, changed huddle identity/contracts, incomplete persistence and
controller replacement while a script completes. Fresh adoption observes one
completion with one side effect. Candidate metadata tests cover old releases,
version/protocol mismatch, bounds, symlinks, non-files and changed stage receipts.
These fixtures simulate service lifetime and use metadata-only candidate paths;
they establish neither native supervision nor packaged upgrade/reboot acceptance.
Public creation/Start and fenced recovery of a crashed huddle remain unfinished;
removal/collection and stopped-host startup integration follow below.

The expanded shared, host-update and huddle-controller regression run passed
**488 tests in 66 files**, with **4 tests in 2 files skipped** by their existing
historical-upgrade/native-supervisor gates. Shared/daemon/web TypeScript, scoped
ESLint and formatting checks passed. The compiled daemon's passive role inspection
also returned the declared contracts with an empty isolated home remaining empty.
No host archive was built or native service started for this increment.

## Implemented: host removal, purge fencing and release references

The offline removal controller adopts huddles through their own connection and
projector beside ordinary runtimes. Internal review/inspection code lives under
`host/removal/runtimes/`. A huddle review binds its immutable placement, release,
contract requirements, current activation/control generation, executing/live-worker
state and failure. It targets the entire owner and work admitted under that
activation. Retain sends no lifecycle command. Stop re-inspects inside the existing
huddle control queue, rechecks participating authority and consumes durable Stop
only after the review still matches. A changed activation/impact or unresolved Stop
refuses dispatch; no command moves to a replacement owner. The existing public
removal reply remains unchanged: a huddle is an owner with zero terminal PTYs.
A richer huddle-specific review presentation remains part of product UI integration.

Shared exact-binding and retained-state validation now lives under
`runtime/huddle/ownership/`, used directly by adoption, update recovery, removal
and collection. Purge fencing requires a clean exited huddle (or positively
never-consumed launch) before unregistering its runtime service. Missing previously
observed state, pending persistence, mismatched identities/contracts and live or
unresolved workers cannot prove retirement. The existing ownership claims and
permanent launch fence still exclude running or delayed owners. Purge continues
to require the separate later-boot barrier and worktree review before data deletion.

Release collection retains all live and unresolved huddle bindings and their pinned
software. Clean exit alone does not retire executable references: the unchanged
launch/consumption/final-state/service evidence must span the existing later-boot
barrier. Collection fingerprints the huddle evidence as well as the binding,
assets and supervisor, and charges reads to the common bounded inventory budget.
Changed final-state evidence restores the release pin. Executable reference
retirement preserves source definitions, revisions, execution ledger and session
history. Ordinary-owner fingerprints and public protocol shapes remain unchanged.

Verification uses independent huddle/ordinary processes in temporary homes. It
covers offline Retain/Stop, changed activation inside the Stop queue, revoked
authority before Stop intent, consumed Stop without redispatch, purge refusal for
unresolved workers, ownership exclusion and retained release pins until a simulated
later boot. Definition files and `huddle.sqlite` survive runtime disposition and
reference retirement. Metadata-only release files and simulated boot UUIDs are
not native manager, installed-release deletion or reboot acceptance.

The focused lifecycle/removal run passed **39 tests in 7 files**. The expanded
removal, collection, huddle-controller/lifecycle and memory-retirement run passed
**227 tests**, skipped **1** existing gated test, and found two process tests using
a stale protocol-26 CLI bundle. Rebuilding the local CLI and rerunning those two
tests passed **2/2**. Shared/daemon/web TypeScript, scoped ESLint and formatting
checks passed. No production daemon or native supervisor was started.

## Implemented: selected-daemon startup compatibility

`host/startup/huddles.ts` checks committed huddle requirements before the selected
service is started. It opens an existing owned application database read-only,
observes committed WAL state without migrations, and bounds inspection to 4,096
huddle bindings with at most 1 KiB of contract metadata per binding. Unknown newer
schemas, malformed/oversized contracts, missing adoption support, mismatched
selected VERSION/metadata and an insufficient database schema ceiling refuse
startup. The shared passive reader validates the selected daemon's version and
application protocol with `DAEMON_RUNTIME_CAPABILITIES.json`, just as staged
update inspection does.

The check runs within the existing controller/update/installer claims, before
idle-launchd unload or systemd rate-limit reset and again after asynchronous
supervisor work before releasing the controller for startup. It does not alter
selectors, control epochs, application rows, owner state or launch intent. Fresh
homes and historical schemas without huddles retain their previous startup path;
ordinary-only databases require no huddle capability metadata. Existing owners do
not acquire a dependency on the currently selected default runtime's huddle support.

This is compatibility admission, not proof that any huddle has recovered. A
compatible daemon can start with interrupted huddle bindings so users can inspect
and recover them; the check does not replay, rearm or restart their work. Retained
huddle references require support even when their owner is no longer running.
New-owner recovery, auto-start after reboot and native service supervision remain
separate acceptance gates.

Verification uses live isolated ordinary/huddle owners with scripted systemd
commands. It verifies no replay or database/launch changes, rejection before
service mutation for missing/unknown contracts or schema/version mismatch,
reinspection after rate-limit reset, and successful controller startup admission
with an interrupted huddle still marked interrupted. The synthetic service start
does not establish native manager or reboot acceptance.

The expanded startup, restoration, candidate-reader and huddle-update regression
run passed **92 tests in 9 files**. Shared/daemon/web TypeScript, scoped ESLint and
changed-file formatting checks passed. No production daemon or service manager
was started.

## Implemented: definition and validation foundation

- Shared format-1 document, layout, component, port, parameter and binding schemas
  live under `packages/shared/src/api/huddle/`, exported through the existing
  shared package entry point. They are local document contracts, not new wire
  messages. Application, runtime and remote protocol versions are unchanged.
- Each definition is `.puddle/huddle/<32-lowercase-hex-id>/huddle.json` in an
  explicitly selected worktree. The manifest id must match its directory. Display
  names can duplicate or change without changing identity. Creation will generate
  16 random bytes and check collisions; production creation is not implemented.
- Nodes select either `{ kind: 'builtin', component, version }` or
  `{ kind: 'local', manifest }` in their `source`. Local manifests declare `entry`
  and an explicit `dependencies` list, relative to that manifest. Input/output
  contracts and metadata are read as JSON; discovery never imports source.
- Parameter bindings are `{ kind: 'literal', value }` or
  `{ kind: 'variable', name }`. Variables and parameters declare a JSON Schema
  `schema`, `required`, optional `default`, and an `editor` hint. File/Git/session
  components declare a `worktree` parameter, and instances must bind it explicitly.
  JSON binding resolution does not grant host authority or resolve actual resources.
- The supported JSON Schema subset is type (including type arrays), enum,
  properties/required/additionalProperties, items, min/maxItems, min/maxLength and
  minimum/maximum, plus title/description. Unknown keywords fail. No remote `$ref`,
  executable expression, implicit coercion or regex execution is supported.
- `shared/src/huddle/validation/` checks component identities, duplicate ids/routes,
  port existence/types, required inputs/settings, resource variable kinds,
  reachability and cycles. Unproved port compatibility is a warning requiring
  runtime value validation; incompatible types are errors.
- Two-agent A → B → A graphs are accepted when the feedback edge declares
  `maxRounds` and a `while` condition selecting a boolean output property. Removing
  feedback edges must leave an acyclic graph. This establishes static admission,
  not execution or budget enforcement; the runtime phase must implement both.
- Prompt templates replace named paths such as `{{input.task}}`. Missing paths,
  expressions and prototype names fail; replacement text is never evaluated or
  recursively interpolated. Explicit unavailable bindings never fall back to a
  different account/session/default.
- Daemon `huddle/definitions/` discovers sibling huddles independently and captures
  source/contract snapshots with SHA-256 digests. Capture rejects traversal,
  symlinks, non-regular files, invalid UTF-8, oversize files and detected concurrent
  edits. Builtin contracts enter the digest; future runtime code must also remain
  pinned to its release. Discovery returns metadata/diagnostics, not all siblings'
  source bundles. These helpers take a worktree supplied by their caller; the
  future authorised service must validate profile/project/worktree ownership.

## Implemented: node and extension boundary

Shared `api/huddle/events.ts` defines version-1 scoped source events, extension
emissions/cursors, readout deliveries/results and trigger health. A turn-completion
resource requires its worktree, placement, runtime, segment, native conversation
and exact turn number. Extensions can supply source event ids/data/cursors but
cannot select host scope or execution identity. Delivery carries its immutable
revision, invocation and idempotency key; `unknown` remains distinct from success.
These contracts are not yet sent over application/runtime transports.

Daemon `puddlang/huddle/` now contains the inert `HuddleNode` declaration, typed
trigger/readout adapter interfaces and the node execution boundary. It supplies
immutable input/setting snapshots, validates required/unknown ports and values,
checks cancellation before work and before completion, and admits only declared
event ports through the injected emission callback. A pending unacknowledged
emission prevents node completion; late emissions after the invocation closes fail.
The callback contract requires durable acknowledgement, but the durable owner
implementation is still pending. There is no automatic repair or retry.

The executor now runs inside the isolated worker described below, where
`puddlang/huddle` is registered. It is not wired into `pudl run`; no code executes
on discovery and no application capability is advertised by these helpers.

## Implemented: private execution ledger

`runtime/huddle/state/` now owns a separate private `huddle.sqlite` under the
runtime directory. It is not the application's SQLite database. A permanent host
claim excludes concurrent ledger writers; the ledger binds the host, profile,
project, placement, huddle and runtime identities. Its initial retained format is
SQLite `user_version = 1`; an unknown newer version is rejected before write
pragmas or migrations. No application database migration or wire change is added.

Transactions commit trigger admission, execution identity and cursor together.
Stable event ids return the original execution after a lost reply; changed data
conflicts, and observing an older duplicate never rewinds the current cursor.
Admission enforces queue length and daily execution limits. Executions retain
deadlines and turn/spawn/invocation budgets, with spending committed alongside
dispatch intent. Daily limits use retained UTC date buckets. Node starts enforce
their supplied concurrency limit, defaulting to one, across the same revision/node.

Node activation identities deduplicate routing. Completion and its outgoing
ports commit in one transaction. Routing acknowledges an emission only in the
same transaction as downstream queue admission. A persistent emission watermark
rejects gaps/conflicting sequences; late duplicate observations do not route again.
The graph router described below supplies validated edges, causal iterations and
contracts; the low-level store does not itself interpret graph wiring.

External operations retain exact target/input, invocation and execution identity.
Dispatch consumption commits before the caller can send the operation. Repeating
dispatch is refused, including after close/reopen or an unknown reply. Readout or
agent observation can settle that exact outcome later without reopening dispatch.
Prepared, unconsumed operations can be cancelled; consumed operations cannot be
reset to prepared. Unresolved operations prevent node/execution completion.

The ledger reserves outcome bytes before operations and both result bytes and
completion-row capacity before node execution. Capacity failure rolls back the
entire admission, including cursor/budget changes. Logical state is capped at
64 MiB and 16,384 records including reservations; reads are capped at 256 rows
and 1 MiB per page. These are retained-payload limits, not a claim of physical
SQLite/WAL disk accounting or integration with host memory grants. Those remain
owner integration work. Retained rows are not automatically expired or pruned.

Recovery, after the caller has fenced the outgoing workers, interrupts running
executions without replaying script bodies. It cancels queued descendants and
unrouted emissions, cancels unsent operations and retains consumed operations as
unknown. Unstarted root events remain pending. Explicit cancellation also removes
an unstarted execution from pending inbox state. Late exact external outcomes
remain readable, but do not restart the interrupted graph. These methods record
intent/state; they do not themselves terminate workers or agents.

## Implemented: durable graph routing

`runtime/huddle/execution/graph.ts` interprets validated captured graph contracts
against the ledger. Starting a root execution and admitting its trigger fan-out
commit together. Output routing commits downstream join/input records, invocation
admission, budget spending and acknowledgement together; a failed destination or
capacity/budget check rolls back the entire fan-out. Repeated starts and routed
emissions are observation-only, including after close/reopen. Both source and
destination values are validated; the router rejects a completion record for an
event port and pending output from an unsuccessful invocation.

Join identity includes execution, destination node and causal activation. Ordinary
completion fan-out retains that activation. Each explicit event emission creates
a separate activation shared by its descendants; two emissions cannot contribute
one input each to a join. Required inputs must all be present. Optional inputs
received before admission are included; later optional inputs cannot modify an
already admitted invocation. A node with `activation: "any"` admits each incoming
alternative independently, validates supplied ports and does not require absent
alternatives. Downstream joins must follow those distinct causal activations.

Feedback checks the declared boolean path against each actual output, advances
to a new activation and increments the path's iteration. The initial pass is
round one; `maxRounds: 5` permits at most five passes, including the initial pass.
The count covers feedback boundaries along that causal path, so multiple different
boundaries do not reset it. Distinct feedback edges create distinct activations.
A false continuation condition exits that edge. A still-true condition at the
limit raises `HuddleFeedbackLimitError`, leaves the emission unacknowledged and
admits no next invocation; the scheduler records failure and cancels dependent
work. An incomplete join or failed invocation cannot be reported as
successful execution completion. Interrupt/recovery also cancels waiting joins.

Routing composes with the scheduler and launch path below. Public lifecycle admission,
non-manual trigger subscriptions and live-agent dispatch remain unimplemented;
these internal helpers alone do not expose huddles in the application.

## Implemented: captured-source node workers

`runtime/huddle/workers/` runs one local script component per Node child process.
The owner supplies a pinned Node/worker path and explicit cwd/environment; the
worker does not inherit the parent's environment by default. Transport reuses
the existing bounded runtime framing over a private inherited descriptor, not
Node's unbounded structured IPC. These helper messages belong to one pinned
runtime build; no independently negotiated huddle-owner protocol is enabled yet.

Worker jobs select one component's exact manifest, entry and declared dependency
closure from the captured revision. Preparation rechecks the revision digest and
the parsed graph against captured `huddle.json`; changes to either source or
settings reject preparation. It resolves variables/settings without reading live
source. Both sides validate the manifest against the resolved contract. The worker
loads TypeScript/JavaScript/JSON modules from its captured in-memory closure and
rejects undeclared local, absolute, file-URL and bare package imports.
`puddlang/huddle`, `puddlang`, `zod` and explicit `node:` imports are available.
`HuddleNode.contract` is relative to the component root and must match the exact
manifest before the node body runs. This is deterministic import handling for
trusted host code, not a security sandbox; Node built-ins retain the OS user's
authority.

The puddlang `Agent` client is shared with the existing single-file runner. Huddle
calls carry unique request ids, bounded operation values and scoped owner
callbacks. The parent requires a declared sessions capability and a resolved
explicit worktree before accepting agent requests; the future host bridge must
still authorise exact accounts, placements, worktrees and operations at dispatch.
No production agent bridge is connected here. Emission promises resolve only
after the owner callback acknowledges; unawaited calls/emissions prevent success.
Disconnects are not retried.

Workers have a 128 MiB V8 old-space cap, 64 pending/4,096 cumulative requests,
1 MiB combined stdout/stderr limit and an explicit deadline. These do not establish
a total RSS/child-process limit. Parent transport allocations can share the host
allowance; the owner now charges worker and retained-source capacity as described below.
Cancellation aborts callback signals, sends termination and escalates to SIGKILL
for a CPU-bound child. Success requires both a validated result and observed
exit. Failure to confirm termination within five seconds remains a distinct
unknown outcome, with a separate exit-observation promise; it never authorises a
replacement attempt. Service-scope descendant fencing and owner-crash recovery
remain unfinished.

Archive builds include `daemon/huddle/runner.js` and `sdk.js` with their shared
chunks, using `scripts/lib/puddlang-build.mjs`. The archive smoke check loads a
captured helper, HuddleNode and zod under the archive's pinned Node without
starting a daemon or agent. Fixture builds use the same entry layout. The
independent owner service and live provider dispatch are still needed to expose
this functionality in the application.

## Implemented: retained revisions and activation

`state/revisions.ts` publishes immutable, content-addressed source documents under
each runtime's private `huddle-revisions/`. Publication validates the full graph
closure, component contracts and digest without loading code, serialises publishers
with a permanent claim and syncs the atomic file publication. Repeated publication
observes the existing document; corruption is rejected, never repaired in place.
Restoration derives graph/layout metadata from retained files and verifies scope,
dependencies and types again. Source quotas are 32 documents, 32 MiB per encoded
document and 128 MiB retained bytes, independently of the execution ledger.
Interrupted staging files count towards limits; collection is not implemented.

`state/activation.ts` and `control/revisions.ts` separate publication from Apply.
Activation records pin source revision, canonical source worktree, variable values
and per-node resource bindings. Apply validates settings and requires explicit
resolved resource bindings; the application host resolver must still authorise
those resources. A compare-and-swap generation prevents stale Apply/control writes.
Repeated activation ids return the original record and current pointer without
rewinding it; changed payloads conflict. A failed ledger transaction leaves the
published bundle inactive. Saving or publishing never arms a huddle.

Managed trigger admission commits its activation id alongside the event/cursor
and execution. It refuses a stale or unarmed activation. Queued/running work keeps
its original source and binding values through later Apply operations. Retained
armed/stopped/interrupted intent and auto-start preference do not themselves
create subscriptions or implement machine-reboot recovery. Subscription fencing
and cursor hand-off remain the future owner's responsibility.

## Implemented: scheduler core and manual execution

The internal `HuddleScheduler` drives durable executions, routing and isolated
workers without renderer participation. `control/manual.ts` admits idempotent
manual events; `shared/huddle/components/core.ts` provides the initial Run trigger and
result readout contracts. The scheduler runs local script components and stores
result-readout input in the retained invocation. It refuses unsupported built-in
contracts and local trigger/readout adapters. Coalescing/drop admission is refused
until those policies are implemented. The independent owner entry point below
now composes these helpers; public creation/Run commands remain unimplemented.

Scheduling honours root/node concurrency and shared execution limits, with four
worker slots by default (configurable from one to sixteen). Event outputs wake
downstream scheduling before their source worker finishes; result readouts need
no worker slot. Ready work, output acknowledgements and the nearest deadline
drive the loop; idle graphs have no scheduler polling timer. Active executions
share a captured graph per revision, with caches released after completion.
Script failures, missing required join values, deadline expiry and feedback
exhaustion fail the root and cancel remaining work. Stop/interruption fences new
admission first, cancels queued roots and waits for actual child termination;
re-arming never replays those cancelled roots. Unknown child termination blocks
further scheduling and remains distinct from confirmed shutdown.

Failure recording also reserves 32 KiB for root and queued-node outcomes and small
state-transition reservations for armed control, joins and emissions, so saturated queues can still
record bounded, JSON-escaped cancellation reasons. These are logical capacity
reservations; physical ENOSPC still requires storage recovery.

The scheduler can call an injected host operation bridge, but a production bridge
with account/session/worktree authorisation and exact dispatch is not installed.
Existing-agent cleanup, external adapter shutdown, native supervision and
public launch admission remain integration work. Application-side daemon adoption is
implemented above. The stored auto-start setting is not proof of restart/reboot continuity.

## Implemented: independent owner process and private controller

`runtime/huddle/owner.ts` composes the ledger, immutable revisions, scheduler and
workers in a separate `puddler` process. The ordinary runtime entry point selects
the huddle role only from a strict private huddle launch record. It requires the
exact build, runtime/incarnation/launch identity, profile/project/session scope,
definition worktree and an already published initial revision. Initial activation
stays stopped until an explicit private Arm command. It creates no agent PTY and
never opens application SQLite.

The owner reuses the existing permanent runtime claim, separate process-memory
claim, pre-dispatch host grant and lifetime checks. The common service dispatcher
can address the same entry point without new service arguments. The launch is
exclusively consumed and synced before activation/listening: a duplicate process
cannot take live ownership, and a consumed incarnation cannot restart or replay
work after exit. This is launch fencing, not automatic owner-crash recovery.

`runtime/huddle/transport/` uses existing bounded framing and request/transport
allowances. Its unshipped role contract 1 authenticates the exact runtime identity,
private per-owner secret and current host controller id/epoch. Scope and selected
build are checked on adoption. At most 16 sockets and 64 queued requests share
the owner's allowance. Controller replacement fences the old connection; a
monotonic command cursor survives controller disconnects. Lost replies and
timeouts never retry a command. Inspection, bounded execution/invocation/operation
pages, Apply, Arm, Run, Interrupt and Shutdown are private internal commands.
Record pages are observation only. The daemon now projects versioned owner
snapshots as described above; execution/outcome journal replication and
acknowledgement are still pending.

Local scripts continue when the controller disconnects or releases its epoch.
Shutdown acknowledgement means acceptance, not confirmed termination. The owner
disarms admission, cancels work, waits for worker exit and pending controls, syncs
its final `huddle-owner.json`, then releases execution ownership. Interruption
keeps the owner available. Unknown termination retains ownership and failure
evidence instead of claiming successful shutdown. Retained state alone is never
proof that a process is alive or dead.

Transport, bounded source-read workspaces, cached graphs/activation values and
160 MiB per live script worker charge the common host allowance. A worker's charge
is held until positive exit, including unknown completion. Host refusal prevents
that worker from starting. These managed charges include the configured 128 MiB
worker heap plus overhead; they do not enforce total RSS or fence arbitrary OS
descendants. Complete resource accounting/measurement and supervised descendant
recovery remain acceptance gates.

This owner increment left application and agent/terminal runtime versions unchanged;
the later placement increment introduced application 27.0. Runtime-role
capabilities are described below. The launcher increment above now supplies private
launch records; public creation/Start APIs remain unfinished. Application admission,
complete public lifecycle/provider admission,
provider-operation dispatch and fenced owner replacement/reboot recovery must be
connected before enabling creation. Do not infer production support from this
entry point or its private schemas.

## Implemented: explicit runtime-role capability admission

Host archives include `RUNTIME_CAPABILITIES.json`, generated by the newly built
`puddler --runtime-capabilities` inspection mode without opening a home or starting
an owner. Format 1 binds the exact release version and ordinary runtime protocol
to bounded role capabilities. The huddle role declares owner-control, definition,
component and retained-ledger contract versions (currently all 1). Missing role
metadata means unsupported. These are separate from the existing closed
`HOST_CAPABILITIES.json` contract, so historical host/update metadata readers are
unchanged; agent/terminal protocol 1.1 remains unchanged too.

`runtime/huddle/control/release.ts` reads at most 32 KiB of passive metadata from
one resolved immutable runtime selection. It requires matching build/protocol,
supported complete huddle contracts and readable runner/SDK files inside that
exact release. Symlinks escaping the helper directory, missing files and unknown
contracts refuse admission without executing the candidate. The selection
recheck compares exact release/helper paths as well as capabilities, detecting a
same-version generation change before future launch intent. Ordinary agent and
terminal selection does not require this new file.

Private huddle launches now retain the required capabilities. The owner refuses
unsupported requirements before consumption, and its authenticated state reports
actual capabilities. The client compares them with the pinned launch before
adoption. Changing the default to an unsupported release does not invalidate a
capable live owner. This guards the runtime boundary; the production creation and
Start paths must call the selection guard when they are implemented. It is not
yet frontend gating or a declaration of daemon maintenance/adoption support.

## Bounds and defaults

Document limits: 256 nodes, 1,024 edges, 64 ports/parameters per component,
128 captured files, 256 KiB per file and 4 MiB per source bundle. Runtime JSON
values are limited to 256 KiB, depth 16 and 8,192 visited values. Discovery scans
at most 4,096 directory entries and accepts at most 512 huddle ids per worktree.
Graph diagnostics are bounded; source discovery reports a malformed sibling
without hiding healthy definitions.

Execution settings already have validated defaults: one concurrent execution,
50 turns, eight cumulative agent spawns, one hour, 128 queued events, 100 daily
executions, 32 daily spawns and 512 invocations per execution. Queuing defaults to
`queue`, cleanup to `stop-owned`. The ledger enforces admission, deadline,
concurrency and cumulative turn/spawn/invocation bounds. The router enforces
feedback rounds. Coalescing/drop policies, provider dispatch and full lifecycle
cleanup still need owner/control integration. Blank graphs can be saved as documents but fail
activation validation until a trigger exists.

## Automated evidence

The foundation's targeted suite covers document/schema/value limits, bounded
feedback versus unbounded cycles, worktree declarations and resource-variable
types, literal/default resolution, prompt interpolation, duplicate identities,
source digests, concurrent edits, multiple sibling huddles, unsupported formats,
missing components, symlink/path escapes and data-only inspection of source that
would throw if imported.

Run from the repository root with the installed dependencies:

```sh
node node_modules/vitest/vitest.mjs run packages/shared/test/huddle packages/daemon/test/huddle
node node_modules/typescript/bin/tsc -b packages/shared packages/daemon
node node_modules/eslint/bin/eslint.js packages/shared/src/api/huddle packages/shared/src/huddle packages/shared/test/huddle packages/shared/test/helpers/huddle.ts packages/daemon/src/huddle packages/daemon/src/puddlang/huddle packages/daemon/test/huddle
node node_modules/eslint/bin/eslint.js packages/shared/src/runtime/huddle packages/daemon/src/runtime/huddle packages/daemon/test/helpers/huddle
node node_modules/vitest/vitest.mjs run packages/daemon/test/huddle/workers packages/daemon/test/puddlang
```

Verified 2026-11-08: the expanded shared-package plus huddle-definition run passed
171 tests in 21 files. Shared/daemon TypeScript builds and the scoped ESLint check
passed. The roadmap's JSON example parses with the implemented definition schema.
The subsequent node/event increment passed 32 huddle tests across six files,
shared/daemon TypeScript builds and its scoped ESLint check. Tests include exact
turn identity, forged extension scope rejection, unknown delivery, invalid node
ports/settings/approval, immutable inputs, unacknowledged/late emissions and
cancellation. Test fixtures
live in `shared/test/helpers/huddle.ts` and are not installed components.
The ledger increment passed the expanded shared/huddle suite: **197 tests in
27 files**, including **17 new ledger tests**. Shared/daemon TypeScript and scoped
ESLint passed. Tests cover cursor/queue rollback, duplicate/conflicting events,
writer exclusion and identity, daily/cumulative/concurrency limits, byte-bounded
pagination, reserved outcomes under pressure, atomic completion/routing rollback,
cancelled/unknown operation distinctions and late outcomes after interruption.
An isolated subprocess recorded dispatch, wrote one test file and killed itself
with SIGKILL. Reopening retained consumption; recovery refused redispatch and the
file still contained exactly one write. A separate check rejected a newer ledger
version without changing its database bytes. These checks establish ledger
durability, not complete runtime/service/provider continuity. There are no
operational huddle commands or application migrations yet.

The routing increment passed **211 tests across 30 files** in the expanded
shared/huddle suite, plus shared/daemon TypeScript and scoped ESLint. Its fake
coder/reviewer graph completes three rounds across repeated ledger reopen, exits
on approval and refuses further admission after a configured round limit.
Interleaved root events and explicit event emissions retain separate join inputs;
partial joins survive reopen; repeated delivery does not add invocations; budget
exhaustion and invalid destinations roll back fan-out and acknowledgement together.
Further checks cover alternatives, late optional inputs, forged emission kinds,
failed branches and cancellation of incomplete joins. This is no evidence of
provider-native turn completion or daemon-replacement continuity.

Worker verification uses real child processes with bundled runtime helpers. It
covers captured local imports, wrong manifests/wrappers, undeclared imports,
runtime port checks, acknowledged emissions, correlated fake agent requests,
missing worktree/capability refusal, unawaited calls, deadlines, cancellation,
runaway logging and child crashes. A graph/ledger integration fixture captures a
multi-file component, changes its worktree source, then executes the original
captured bytes and retains one downstream result across ledger reopen. The
archive-layout smoke runs in this fixture suite. The expanded shared, huddle,
puddlang and runtime framing/encoding/decoding suite passed **279 tests in 38
files**, with shared/daemon TypeScript and scoped ESLint passing. Additional
worker checks cover a positively failed spawn and observe entry into the busy
script before deadline termination. A full isolated `build-tarball.mjs --stage-only`
build on macOS arm64 passed executable metadata, the existing puddlang smoke and
the new multi-file worker smoke under pinned Node **22.21.1**. This is staged
archive evidence; no archive was published or installed, no daemon service was
started, and native supervision remains unverified. Existing puddlang
tests also cover the shared client extraction. A stale schema-39 migration fixture
was corrected to remove the later window-arrangement column before replaying
migrations.

The retained-revision and scheduler increment passed **298 tests in 41 files**
across shared, huddle, puddlang and runtime framing/encoding/decoding suites, plus
shared/daemon TypeScript and scoped ESLint. Revision tests cover immutable
publication, corruption/symlink refusal, closure validation, quotas, stale Apply,
duplicate activation and failed activation without pointer changes. Real worker
tests cover manual execution through a result readout, queued source retained
across Apply, feedback exit and exhaustion, script failure, event readouts while
the source worker remains active, and busy-worker interruption with queued-root
cancellation. A saturated-ledger check proves control interruption and root/node
cancellation can still record a maximally JSON-escaped bounded reason. These
checks run the scheduler in an isolated test owner; they do not establish an
independent installed service or daemon-replacement continuity.

The owner-process increment passed **377 tests in 50 files** across shared,
huddle, puddlang, framing/encoding/decoding, host-memory, lifetime and daemon-ownership
regression suites. After fixing active-scheduler wake-up on new admission, all
**16 owner/scheduler tests** passed again. Seven owner tests use real isolated
processes: controllerless script completion
and replacement adoption, deliberately discarded Run acknowledgement, wrong
secret/scope and stale epoch refusal, busy-worker interruption, missing host-grant
refusal, pinned-build refusal and concurrent admission while another root is active.
They also verify consumed-launch replay refusal
and exclusive runtime ownership. Two scheduler checks verify refusal before
worker start under memory pressure and release of managed charges after exit.
Existing agent/terminal daemon-ownership and detached-lifetime checks passed.
Shared/daemon TypeScript, scoped ESLint and formatting checks passed. An earlier
focused run also passed 159 tests with the opt-in native launchd default-launch
test skipped; no native huddle
supervision, packaged huddle launch or production daemon adoption is claimed.

Capability admission tests cover missing role metadata, each unsupported contract,
build/protocol mismatch, oversized/symlink metadata, absent/escaped helpers and
selector replacement within the same version. The process fixture also refuses
unsupported launch requirements and adopts a live owner after its default changes
to an older unsupported runtime. The expanded shared/huddle, installed-release
and historical host-capability suite passed **290 tests in 40 files**; shared/daemon
TypeScript, scoped ESLint and formatting checks passed. A fresh isolated macOS arm64 archive staging run
emitted the new passive file and passed executable metadata, puddlang runner and
huddle worker smoke checks under Node 22.21.1. It neither installed nor published
software and did not start a service.

## Remaining implementation and acceptance

Phase 0 remains open for the full component catalogue and resource admission.
Phase 1 has retained revisions/activation, the ledger, routing, workers and a manual
scheduler composed in an independent owner process, now exposed through local/SSH
lifecycle and live-history APIs with IDE controls. Next complete retained/offline
history, active-revision detail, the exact-operation
bridge, host resource accounting and lifecycle fencing. Finish node movement and
settings, actual trigger/readout adapters, provider-backed lifecycle nodes,
authoring tools/docs/skills and packaged integration.

All live provider, SSH, native window, supervisor, complete owner crash/reboot, trigger cadence,
readout reconciliation, permission/takeover, persistence/retention and installation
acceptance is **Pending**. No fake fixture, static validator or TypeScript build
establishes those behaviours. Maintain the roadmap's complete acceptance list as
these features ship; do not reduce the goal to this preparatory layer.
