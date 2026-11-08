# Huddle implementation and acceptance

Status: foundation in progress, 2026-11-08. The full objective remains the
[huddle roadmap](../roadmap/huddle.md). Huddles cannot yet be created or run through
the application. Runtime archives declare their internal huddle-role contracts;
application 27.0 now includes huddle session identity and migration 43 records
placements/owner roles. The daemon launcher and lifecycle controls now integrate
with session kill/archive; migration 44 retains Stop intent. No huddle creation
route, user CLI command or IDE is enabled yet.

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
definition files, unarchive, arm triggers or launch an owner. The future public
service must authorise the project/worktree and validate installed huddle support
before calling this store; this helper grants neither scope nor runtime admission.

Database guards forbid provider/account/conversation attachment, branch ownership,
implicit cwd, conversion of an ordinary placement and relocation of a huddle's
identity. Huddle projections omit agent mode. Ordinary session creation retains
the agent/terminal-only request and UI types; ordinary resume, shell creation
and runtime inspection/restart refuse huddles before launch effects. A stopped
placement can use reversible archive/unarchive without registering onboarding.
Running huddle kill/archive now uses the controls described below; creation and
Start/Run routes remain pending.

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
native service recovery or public Start. Host-update checkpoint compatibility is
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
Public creation/Start, stopped-host startup, removal/collection integration and
fenced recovery of a crashed huddle remain unfinished.

The expanded shared, host-update and huddle-controller regression run passed
**488 tests in 66 files**, with **4 tests in 2 files skipped** by their existing
historical-upgrade/native-supervisor gates. Shared/daemon/web TypeScript, scoped
ESLint and formatting checks passed. The compiled daemon's passive role inspection
also returned the declared contracts with an empty isolated home remaining empty.
No host archive was built or native service started for this increment.

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
manual events; `huddle/components/core.ts` provides the initial Run trigger and
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
host removal/collection integration,
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

Phase 0 remains open for the full component contract catalogue and lifecycle
admission. Phase 1 has retained revisions/activation, the ledger, routing, workers
and a manual scheduler composed in an independent owner process. Next connect
authorised public lifecycle admission and the exact-operation bridge, including
complete host resource accounting and lifecycle fencing. Connect the implemented
runtime capability checks and application placements to authorised creation;
build the IDE and normal windows; actual trigger/readout adapters; provider-backed
lifecycle nodes; authoring
tools, docs/skill and packaged integration.

All live provider, SSH, native window, supervisor, complete owner crash/reboot, trigger cadence,
readout reconciliation, permission/takeover, persistence/retention and installation
acceptance is **Pending**. No fake fixture, static validator or TypeScript build
establishes those behaviours. Maintain the roadmap's complete acceptance list as
these features ship; do not reduce the goal to this preparatory layer.
