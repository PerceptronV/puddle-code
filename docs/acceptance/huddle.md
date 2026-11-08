# Huddle implementation and acceptance

Status: foundation in progress, 2026-11-08. The full objective remains the
[huddle roadmap](../roadmap/huddle.md). Application 27.1 exposes inactive definition
creation/opening through local/SSH HTTP. Application 28.0 adds the sidebar entry
and graph panes. Manifest editing now shares ordinary editor drafts, undo and
conflict review. Layout drafts now support pointer/touch and keyboard node movement,
position fields, pan/fit, direct socket connections and shared-source close/transfer handling. The IDE includes reviewed
manual execution controls and live history.
Application 28.2 exposes local/SSH manual execution and live-owner history APIs.
Application 28.3 adds editable agent templates and feedback settings.
Application 28.4 adds guarded absent-file creation and layout editing.
Application 28.5 adds local readout delivery declarations and execution.
Application 28.6 adds explicit readout observation and the history action.
Application 28.7 adds local custom trigger workers and opt-in source health.
Runtime archives declare their internal huddle-role contracts;
application 27.0 now includes huddle session identity and migration 43 records
placements/owner roles. The daemon launcher and lifecycle controls now integrate
with session kill/archive; migration 44 retains Stop intent. Migration 45 adds
host-side agent-turn identities; the owner mailbox now has private transport,
and production daemon dispatch now supports declared attach/ask scripts. Migration
46 retains exact cancellation attempts. Optional runtime `timers: 1` now admits
interval events without a controller. Optional `calendar: 1` adds timezone calendar
and one-off date triggers. Optional `filetree: 1` adds regular-file observation.
Optional `git: 1` adds worktree HEAD and repository ref observation.
Migration 47 retains bounded host session observations. Optional `sessionEvents: 1`
now delivers them to independent owners through durable subscriptions; Session
lifecycle nodes and stopped/archived session selectors are available in the IDE.
Runtime protocol 1.2 now retains an independent native-turn source for hook-based
interactive, structured Codex and command-correlated headless controls. Automatic
delivery and the Turn completed node's editor settings are implemented; explicit
bounded native feedback remains pending.
No user CLI command is enabled yet.

## Implemented: automatic daemon spawn dispatch

The production daemon now composes `HuddleAgentSpawns` with the existing huddle
operation dispatcher. On an owner declaring `spawns: 1`, the dispatcher scans
separate ask/spawn pages through one admission gate, sharing the existing four-scan,
four-page-pass and 64-task bounds. It validates the authenticated owner and captured
node declarations before accepting work. Prompt and spawn execution live separately
under `huddle/operations/dispatch/turns.ts` and `spawns.ts`; scheduling, maintenance
and connection ownership remain in `service.ts`.

Only a fresh matching owner claim calls SessionService creation. Reconnection,
dispatcher replacement and later scans observe the retained host mapping/readiness;
missing host state after a consumed claim never grants another creation. The owner
stores readiness before the script receives its handle, and its next attach/ask
uses the same retained execution-owned target. Host prompt admission continues to
check the live profile/project/worktree, runtime incarnation and placement. A lost
settlement reply causes a ledger read before any further settlement attempt.

A host call that has ended without an admitted or still-pending creation can report
a definite refusal. An accepted or unresolved creation stays unknown until readiness
can be observed. Maintenance/controller loss aborts dispatcher waiting without
stopping an accepted agent; after release/replacement, the recorded operation is
observed. Successful graph completion retains its agents. Ended invocations remain
eligible for late result observation, without starting another script or agent.

This is still gated by the **unadvertised** spawn contract. Start/Apply resource
resolution, owned-agent cleanup on Interrupt/Stop/deadline and node templates remain
required before user-facing spawn support is enabled. Automatic cleanup is not
implied by the dispatcher; tests explicitly stop their fixture-owned agents. Native
providers, supervisor replacement, SSH/reboot and packaged continuity still need
acceptance.

Verification, 2026-11-08: **204 tests in 29 files** passed across huddle operations,
execution/routing/feedback, owner controllers and update preflight. The seven new
automatic-spawn cases cover graph completion, dispatcher replacement, full controller
connection/reconciler replacement, lost claim and settlement replies, maintenance
pause and account refusal. Pending creation cannot be misreported as a definite
refusal. The replacement fixture includes production exit/retirement callbacks,
so explicit teardown checks positive shutdown rather than assuming disconnected
means stopped. Shared/daemon/CLI TypeScript, scoped ESLint, formatting and diff
checks passed. All owners/providers were isolated test processes; no production
daemon or native UI was used.

## Implemented: private spawn transport in the independent owner

The independent huddle process now composes the spawn outbox and shares pending
worker admission with attach/ask. Authenticated owner IPC adds separate
`spawn-page`, `spawn-claim`, `spawn-settle` and `spawn-unavailable` commands, leaving
the existing ask contracts unchanged. Replies carry bounded pages, exact claimed
intent or the durably saved readiness receipt. The normal private controller
identity/epoch, command sequence, frame and queue bounds apply. Claiming is blocked
during lifecycle changes or owner failure; late settlement remains available while
the owner is connected, without resuming cancelled script bodies.

The proposed optional `spawns: 1` contract requires `operations: 2`. Schemas and
owner/client gates understand it, but **default runtime and daemon metadata still
omit it**: Start/Apply resource resolution and owned-agent cleanup must be completed before advertising spawn support. Older
owners retain their original capabilities and ask messages. The client refuses
spawn commands locally when unsupported, preserving the connection; the server
independently enforces its launch capability. Adoption metadata that lacks spawn
support cannot claim compatibility with a spawn-requiring owner. Application 28.7,
ordinary runtime 1.2, remote 5, database 49 and owner/ledger versions are unchanged.

The new integration launches an actual independent huddle owner, node workers and
agent runtimes with the test adapter/fake supervisor. Its explicit test controller
drives the private spawn protocol and host service. It covers a lost creation reply,
reconnection, saved readiness, one subsequent agent prompt and graph completion;
lost claims without dispatch; claimed versus unclaimed work on Interrupt; late
settlement without script continuation; exact scope/receipt refusal; unknown versus
definite failure; and older-owner capability rejection. Agent cleanup in these
checks is explicit test-controller work, not evidence of implemented automatic
lifecycle cleanup. Real-provider/native-supervisor/SSH/reboot acceptance remains open.

Verification, 2026-11-08: all **201 tests in 37 files** passed across shared huddle
contracts, host/owner operations, update compatibility, owner processes/releases,
launch, adoption, controls, history and removal. This includes the five new real
owner spawn cases and three shared contract checks. Shared/daemon/CLI TypeScript,
scoped ESLint, formatting and diff checks passed. No production daemon, native UI
or real-provider sessions were used.

## Implemented: owner spawn outbox and execution-scoped handles

`runtime/huddle/operations/spawns/` now validates script spawn requests against the
captured node's declared account/provider/project/worktree bindings and records
intent in the owner ledger. Account ids must already be resolved; there is no
implicit account, project or worktree selection. The ordinary puddlang default
mode remains interactive; an omitted title uses the component title. Path-based
creation is unavailable through this bridge.

A bounded outbox exposes exact scope/request records, single-consumption claims
and retained outcomes. Claiming spends both the execution and daily spawn budgets
in the existing ledger transaction. A lost claim is never reoffered. A known
readiness result must match the project/worktree and host receipt for the original
request; the owner saves it before returning the worker handle. Definite refusals
and unknown outcomes remain distinct. A late readiness result can settle unknown
creation after cancellation without resuming the interrupted script.

Completed spawns can supply handles to attach/ask in the same execution, including
later invocations, with an explicitly declared matching worktree and session
capability. They do not become implicit bindings in another execution. The existing
host turn path still checks current agent incarnation, placement and availability.
Spawn and ask queues share bounded worker waits, cancellation and memory admission
through `operations/pending.ts`. Result settlement and handle lookup survive ledger
reopen; Apply keeps existing executions on their captured activation.

An isolated integration drives a real node worker through spawn, simulated lost
creation reply, host-service replacement/observation, handle return and one real
agent ask, then exact cleanup. The source owner is composed in the test process;
the agent and node workers run as separate child processes. This proves the queue
and host-service composition, **not** production owner IPC or native-provider
acceptance. The private owner transport is now implemented as described above;
resource resolution on Start/Apply and lifecycle cleanup remain required before advertising spawn support or enabling templates.
This earlier owner-local increment introduced no wire change.

Verification, 2026-11-08: **112 tests in 18 files** passed across huddle operations,
owner scheduler/ledger and session creation, including the real worker spawn-to-ask
round trip and existing two-agent exchange. All **11 owner spawn mailbox cases**
passed again after bounding failure messages before persistence. Cases include lost
claims, one-time budget consumption, resource-scope refusal, ledger reopen, late
settlement after cancellation, changed Apply bindings, persistence failure,
cross-execution handle refusal and memory admission/cancellation. Shared/daemon/CLI
TypeScript, scoped ESLint and formatting checks passed.

## Implemented: host spawn readiness and cleanup

`huddle/operations/spawns/service.ts` now composes the existing SessionService,
RuntimeLauncher, exact native-turn inspector and RuntimeControls. Fresh dispatch
creates one independent agent using the retained account/provider/mode/project/
worktree choices. Duplicate or already admitted operations are refused. A copied
scope and frozen request survive asynchronous creation. At most 64 host spawn
calls may wait; readiness waiting is bounded to two minutes after creation returns.
The normal launcher retains its own startup deadline.

Readiness requires the original runtime identity, current bound placement/segment,
reconciled provider control and no pending stop. Migration **49** adds a bounded
retained readiness outcome and a consumed cleanup-attempt flag. The result and
receipt are stored before returning a handle. Later inspection returns the same
historical result, even after the runtime ends; it does not grant a new prompt or
claim current liveness. An accepted launch survives controller disconnection and
can acquire its readiness result under a later authorised observer, without another
creation. Storage failure leaves readiness unknown until a later valid observation
can persist it.

Explicit cancellation fences an in-process pending creation and records durable
stop intent for an admitted placement. Before-placement cancellation stays pending
until its creation call exits; an unbound admitted placement cannot subsequently
bind a runtime. Cleanup targets the exact original runtime, following its current
placement only within that same owner identity. The existing queued stop control
rechecks private authority and consumes the huddle stop attempt immediately before
its stop request. Lost/uncertain replies never grant another stop send. Positive
clean-exit evidence can subsequently confirm completion; an unrelated replacement
in the original placement remains untouched. A readiness timeout or controller
loss alone does not issue cleanup; lifecycle integration must still apply the
execution's explicit cancellation/retention policy.

The service now has owner-local queue, dynamic handle and private transport
and automatic dispatch composition verified above; lifecycle cleanup policy and
node templates remain pending before spawn
support can be advertised. There is no new network message, capability or
application protocol bump in this slice; application 28.7, ordinary runtime 1.2,
remote 5 and huddle owner/ledger contracts are unchanged.

Verification, 2026-11-08: all **24 focused spawn tests** passed, followed by
**112 tests in 19 files** across huddle operations, database migration, session
creation, programme spawns and compatibility preflight. The final eight host-service
cases passed again after adding the post-stop authority check. Coverage includes
lost creation replies, retained readiness after database/service replacement,
cancel-before-creation, bounded readiness waiting, one consumed uncertain stop,
queued/post-stop authority loss, a resumed replacement staying alive, persistence
failure rollback and schema-48 migration without invented outcomes. Shared/daemon/
CLI TypeScript, scoped ESLint and formatting checks passed.
The source huddle in the host-service fixture is a synthetic private caller;
agent runtime creation, provider control, session/launch stores and stop controls
are real isolated processes using the test adapter and fake supervisor. These
checks do not establish full huddle-owner IPC, real-provider, native-supervisor,
SSH or reboot acceptance.

## Implemented: host spawn admission foundation

Migration **48** adds `huddle_runtime_spawns`, separate from single-file puddlang
runs. `huddle/operations/spawns/store.ts` binds the exact huddle owner, execution,
invocation, operation, activation and revision to resolved project/worktree/account/
provider/mode/title settings. Request copies are frozen. Private bridge authority
is required in addition to retained owner identity. Dispatch rechecks owner/project
archive/stop state, account/provider/profile and canonical worktree identity.
Ordinary session creation retains the binary, login, permissions and registered
worktree checks. This foundation currently permits existing worktrees in the
huddle's project; cross-project binding remains unfinished.

Private `sessions/creation/caller.ts` hooks join the existing SessionStore creation
and RuntimeStore preparation transactions. A rejected/failed mapping rolls back the
new session. Runtime consumption commits with its exact launch identity, segment
and terminal ownership before supervisor dispatch. Uncertain replies cannot mint
another placement/runtime for that operation. Existing programme spawn fingerprints
are unchanged; callers cannot combine programme and huddle creation authority.
Managed SessionService creation requires an independent agent and explicit existing
worktree. Initial task prompts are separate exact asks, not part of this spawn call.

Bindings retain at most 32 spawns per execution, 1,024 per owner and 10,000 per
host; exhaustion refuses further admission without evicting replay protection.
Observation and stop intent retain the original runtime identity even if the user
later resumes the same placement. An undispatched placement becomes interrupted
on boot and is excluded from automatic resume; boot cannot turn a consumed huddle
operation into another launch. Stop intent recorded before preparation rejects the
launch. The durable flag is cleanup intent, not proof that a runtime stopped.

The new shared scope/request schemas are internal building blocks, not newly sent
network messages. Application 28.7, ordinary runtime 1.2, remote 5 and existing
huddle role capabilities remain unchanged. No spawn capability is advertised yet.
Spawn mailbox/dispatcher, result settlement, dynamic agent handles, owned-agent
cleanup and authoring templates still need integration before users can run spawn
nodes. Resume/restart nodes remain unfinished too.

Verification, 2026-11-08: **138 tests in 19 files passed** across huddle operations,
session creation, runtime launch/programme spawns and database migrations. New
checks cover placement/binding storage-failure rollback, database reopen, duplicate
and changed intent refusal, authority/account/archive/stop changes before launch,
retention pressure, replacement-runtime identity and boot resume exclusion.
SessionService tests verify caller propagation, rollback, post-worktree authority
checks and refusal of legacy/implicit-worktree/combined-prompt creation. Existing
isolated programme cancellation and runtime launch tests still pass. Shared/daemon/
CLI TypeScript, scoped ESLint and formatting checks passed. No live-provider,
native-supervisor, SSH or reboot acceptance is claimed here.

## Implemented: custom trigger subscriptions

Application **28.7** and optional `customTriggers: 1` admit local HuddleTrigger
components. Their captured manifests declare `trigger.resume: continue|fresh`;
source/settings reads stay data-only. `puddlang/huddle/trigger.ts` and
`execute-trigger.ts` validate inert adapters, immutable settings/bindings/cursors,
output contracts and acknowledged emit/checkpoint/health calls. The existing
captured-source runner owns subscriptions, with no new package entry or arbitrary
uncaptured dependency loading. See [authoring guide](../huddle/triggers.md).

`runtime/huddle/triggers/custom/` owns at most eight independent source workers,
separate from graph concurrency. Each shares host admission through a 160 MiB
managed allowance, with 128 MiB heap, ten-second startup deadline, bounded framing,
64 pending calls, 64 SDK requests per second and 1 MiB logging per minute. The
receiver permits two sender bursts per second for unaligned windows. Once opened,
idle sources have no lifetime deadline and no growing request-id set. Unknown
termination retains resources/ownership; Interrupt, Stop and Apply invalidate
callbacks before cancellation and require positive exit before replacement.

Eight fixed private `custom-sources` slots retain exact subscription identity,
activation, generation, revision, cursor and health. Emissions hash stable external
ids with the retained subscription identity. Scope and applicable worktree come
from the retained activation, never adapter input. Validated root events, budgets
and cursor progress commit atomically. Duplicate acknowledgements never rewind
cursors; conflicting repeated payload/cursor is refused. Checkpoints allow
baselines/empty pages without executions. Cursors are limited to 64 KiB. Continue
resumes retained progress after Interrupt/Resume; fresh creates a new namespace
with null cursor. Apply always creates a new activation namespace. Source gaps and
closed health are terminal until explicit rearm; a failed adapter does not stop
healthy sources. Persistence/termination uncertainty blocks clean owner retirement.

Triggers cannot call agent operations. File/Git/session capabilities still require
an explicit registered worktree. Session selectors are observational bindings.
No new HTTP mutation is introduced. Runtime inspection requires
`include_custom_triggers=true` to expose cursor-free node health; ordinary/older
strict responses remain unchanged. The IDE displays custom source health beside
the execution controls and opens the details for gaps.

Verification, 2026-11-08:

- Seventeen focused custom-trigger tests passed: atomic rollback on injected
  persistence failure, deduplication after ledger reopen, cursor policies and stale
  callback refusal; real worker admission/cleanup, bad-output/crash/gap/flood/agent
  refusal and healthy-source isolation; startup timeout, idle lifetime and frozen
  settings; bounded pending calls and 5,000 acknowledged sequential calls.
- The isolated HTTP/runtime test checks capability refusal before launch, opt-in
  health and older response shape, source events after controller disconnection,
  retained cursor on Resume and cleanup on Interrupt/Stop. It uses a staged test
  runtime and temporary project, never the user's daemon.
- Headless UI preview verifies visible gaps alongside healthy sources, health
  refresh and unchanged lifecycle dispatch. A collapsed-list locator was corrected
  to await refreshed hidden content; this was a test-fixture failure.
- The final combined worker/readout, scheduler, owner/adoption, binding and
  shared-schema regression run passed **206 tests in 41 files**, including all
  custom-trigger checks. Shared/daemon/CLI and web TypeScript, repository ESLint,
  Prettier and semantic colour/contrast checks passed. Earlier multi-source
  fixture errors were corrected before this run.

This does not establish real integration/provider, SSH, native supervision,
owner-crash replacement or reboot continuity. Managed integration secrets, unified
built-in source health/backlog UI and agent-authoring skills remain unfinished.

## Implemented: explicit readout observation

Application **28.6** exposes local/SSH
`POST /api/huddle/:profile/sessions/:sid/readouts/observe` with an exact reviewed
owner target and `operation_id`. Optional runtime `readoutObservation: 1` gates the
private `readout-observe` command independently of delivery support. Connected
runtime inspection and eligible unknown operation history expose optional
`readout_observation: true`; old delivery-only owners receive no new command.
These fields require explicit `include_readout_observation` requests so older
strict clients retain their runtime/history response shapes.
The history panel offers **Check delivery** only for a matching supporting owner.
Commands share placement authority, queued target review, Stop/maintenance admission
and the existing no-retry mutation path. Owner-side generation/activation checks
also reject stale private requests.

`runtime/huddle/readouts/observation.ts` reconstructs the exact original delivery
from its retained execution, activation and source, comparing the complete envelope
and policy with recorded intent before source evaluation. Only consumed unknown
readouts in ended executions, with a declared `observe` method, are eligible.
Later source edits or Apply cannot substitute code, inputs, parameters or bindings.
Observation shares the existing worker pool and 160 MiB managed child allowance,
bounded transport/logs, cancellation and positive-exit retention. It has a 30-second
deadline. Concurrent observation of the same operation is refused, as is exhausted
worker capacity. Interrupt/Stop cancel observations even though their graph executions
have already ended. Unknown child termination retains ownership and blocks dispatch.

The observer can acknowledge only a readout result; agent operations and event
emissions are rejected. It never dispatches the delivery or resumes graph routing.
Receipts/refusals update only the operation, leaving its execution and invocations
ended. A receipt committed before acknowledgement loss or worker failure remains
known. Observation may prove delivery with a receipt alone; optional supplied outputs
are validated but never routed. Inconclusive/failed observation retains uncertainty
without automatic retries.
Acceptance is asynchronous; losing the control reply causes inspection, not another
worker launch. History refresh is read-only. A later explicit check may query again
after an inconclusive outcome. Custom source remains trusted host code, so read-only
destination behaviour is part of its adapter contract rather than an OS sandbox.

Verification: **53 tests passed across 7 files** covering readout workers, ledger
settlement, owner/HTTP controls, application protocol and role capabilities.
Real isolated owner/worker processes and a loopback HTTP destination verify lookup
after a lost delivery reply, single dispatch after a lost observation acknowledgement,
stale target refusal, captured-source use after edits, old-owner gating, cancellation,
known refusal, inconclusive outcomes and retained receipts. Headless Chromium checks
the actual history action, supporting-owner visibility, pending-button exclusion,
lost-reply inspection and unchanged ended graph state against UI-only fixtures.
Shared/daemon/CLI and web TypeScript checks and repository ESLint passed.
The broader regression run passed **412 of 413 tests across 83 files**; the one
completion integration refusal was host memory admission. A single-worker rerun,
including final opt-in response compatibility and owner/API controls, passed
**22 tests across 4 files**, including that completion case. After receipt-only
observation and shared-capacity/forbidden-operation coverage, the final readout run
passed **26 tests across 4 files**. The final headless history check, formatting,
semantic-colour/contrast and diff checks passed.
Destination-specific, installed-provider, native supervisor/SSH/reboot acceptance,
offline-owner reconciliation and automatic owner-crash recovery remain pending.

## Implemented: project-local readout delivery

Local `readout` components now execute captured source through the existing bounded
worker pool. They export the inert `HuddleReadout` wrapper from `puddlang/huddle`.
Application **28.5** adds the optional manifest `readout` declaration with explicit
idempotency, reconciliation and cancellation support. Local readout entries require
it; script and built-in contracts retain their existing shapes. Runtime capability
`readouts: 1` gates host launch/Apply and adoption, preserving older owners.

`puddlang/huddle/execute-readout.ts` validates immutable named inputs, settings,
bindings and the exact delivery envelope before invoking custom code. The formerly
unused delivery SDK now carries all joined input ports in `inputs`; its root event
retains the source port, scope and revision. It also binds node/invocation identity
and a stable SHA-256 idempotency key. The declared dependency closure, pinned SDK,
source digest, transport/log bounds, 128 MiB heap setting, worker deadline and
managed child allowance are shared with scripts. Graph inspection does not load
project modules, and this trusted-code path is not an OS sandbox.

`runtime/huddle/readouts/delivery.ts` consumes one `readout` operation before
evaluating project source. It retains the exact envelope and declared delivery
policy. `delivered` stores a bounded receipt and validated completion outputs;
`failed` records a known refusal; `unknown`, exceptions, missing/invalid replies,
or cancellation preserve consumed intent without retry. The public operation
history exposes the existing result/error projection. The owner compares worker
outputs with the acknowledged receipt and waits for successful child exit before
publishing them. A worker crash after receipt does not erase known delivery, and a
zero exit without a receipt cannot claim success.

Readouts may use declared attach/ask resources through the existing operation
bridge and budgets. File/Git/session resources still require explicit worktree
bindings. Network/file operations made directly by trusted source are represented
by the enclosing delivery operation. `signal` cancellation gives bounded best-effort
cleanup before forced exit; it is never proof that a destination received nothing.

The worker supports a separate `observe` mode and verifies its exported method
against the captured declaration. Tests prove that this mode does not invoke
`deliver`. Owner/API controls now expose this mode as described above. Custom
trigger subscriptions, managed integration-secret references and destination-specific
conformance/acceptance remain unfinished. No automatic retry is enabled merely
because a component declares idempotency support.

Verification: the broader huddle/shared run passed **251 tests**, with one older
readout-source fixture missing the newly required delivery declaration. After
correcting that fixture and adding lost-receipt-acknowledgement coverage, the final
focused run passed **18 tests across 4 files**. These cover real isolated workers,
immutable envelopes, durable consumption before source evaluation, receipt routing,
failed/unknown outcomes, cancellation, reopening without replay, separate observation,
and HTTP Start/Run/history with a loopback destination that can drop its reply after
receiving a delivery. Shared/daemon/CLI TypeScript, web typechecking, repository
ESLint/Prettier and diff checks passed. Destination-specific, installed-provider,
native supervisor, SSH and reboot acceptance remain pending.

## Implemented: completion node authoring and public execution

`puddle.trigger.turn-completed@1` now belongs to the shared built-in catalogue used
by source capture, the editor and owner execution. The temporary private catalogue
has been removed. Add node exposes **Turn completed**; its inspector uses existing
explicit worktree/live-agent selectors and displays the component description.
Terminal, archived and huddle placements are excluded. Saving never arms the graph.

Host binding resolution treats this source as observation, so no automated ask
bridge or idle-agent control readiness is needed. Before launching or applying a
completion graph, host admission requires both completion-event and read-only plan
capabilities. Existing event-only owners retain their private protocol compatibility;
ordinary agent/terminal sessions and other graph features are unchanged. Arming
still verifies a connected exact native source and provider availability.
No new public route, database migration or protocol version is introduced.

An isolated integration now exercises the actual authoring inspection and HTTP
Start/Interrupt/Resume/Stop handlers with a staged huddle release, a separate
hook-based fixture agent owner, native source journal, real application database,
reconciliation and completion dispatcher. It verifies both missing-capability
launch refusals before dispatch, exact reply routing through a captured script,
and exclusion of paused native history on Resume. Provider signals are simulated;
this is not installed-provider or native-supervisor acceptance.

Headless Chromium verifies adding the node, required empty worktree/agent fields,
live-agent choices, exclusion of an archived terminal, the description, and saving
literal bindings without executing a lifecycle command. See
`packages/web/test/huddle/completions.browser.mjs` and
`packages/daemon/test/huddle/triggers/completions/execution.test.ts`.

Verification: **176 tests passed across 38 files** for shared contracts, huddle
authoring/control/lifecycle, completion and session dispatch, and web graph helpers.
The completion editor headless check passed against the UI-only preview.
Shared/daemon/CLI TypeScript builds, web typechecking, repository ESLint/Prettier,
semantic colour/contrast and diff checks passed. The staged-release test requires
current shared build output; its initial stale-build failure was resolved by
building that output before rerunning. The final regression run also includes the
updated catalogue expectation and project source files in the launch fixture.

## Implemented: automatic native completion delivery

Production daemon composition now starts and closes
`huddle/triggers/completions/dispatcher.ts` alongside the existing session feed
dispatcher. It discovers supporting huddle owners and reads their durable source
cursors before delivering native pages. Each source remains pinned to its exact
runtime incarnation, placement, segment and native conversation. Retained node,
profile, project, worktree, definition and owner authority are checked before
delivery; asynchronous reads repeat the authority and target checks.

One host timer observes active subscriptions at a one-second cadence. Inactive
huddles stop polling; lifecycle changes and native reconnects wake observation.
At most four owners scan concurrently, with four page passes per scan and eight
sources per owner. Reads are sequential within a scan and use the existing bounded
native pages. An unchanged native head needs one inspection and no page read.
The dispatcher has no per-view timer and does not start or prompt agent sessions.

Disconnects, refused observations and pending persistence retain the cursor and
retry observation with backoff capped at 30 seconds. A confirmed scope/identity
change or retention/epoch gap fails the exact subscription visibly. Nothing
silently changes its baseline. Lost delivery acknowledgements require observing
the owner's durable cursor before another delivery. Automated and unknown-origin
completions advance that cursor without creating fresh execution roots.

Maintenance pauses fence in-flight reads and drain delivery while runtime
connections remain available. Shutdown closes admission and drains before closing
runtime observation. A lifecycle notification arriving during a released pause
still gets a fresh inspection; work from the old pause epoch cannot deliver.

Verification: **65 tests passed across 11 files**, covering automatic captured-script
execution, lost acknowledgement without duplicate admission, dispatcher replacement
catch-up, maintenance fencing and phase ordering, transient disconnect/persistence,
confirmed identity/retention failures, stopped-owner inactivity, baseline capture,
owner lifecycle and legacy capability gates. Integration uses real isolated huddle
owner processes and the real native journal with a controlled native transport.
Shared/daemon/CLI TypeScript builds and repository ESLint, Prettier and diff checks passed.
It does not establish real-provider, native-service, SSH or reboot acceptance.
Public catalogue/editor enablement is covered above; same-execution native feedback
remains unfinished.

## Implemented: host completion baseline capture

Optional `completionPlans: 1` adds private read-only `completion-plan`. It returns
at most eight resolved node/session/worktree selections, the retained activation
and revision, and the current generation. A proposed Apply activation can be
inspected without changing intent. Resume plans come from the retained activation,
not stale launch settings. Older `completionEvents: 1` owners remain compatible;
controllers require the separate plan capability before requesting it or capturing
baselines through this path. No application/runtime/remote or ledger version changes.

Production host controls now compose `huddle/triggers/completions/baselines.ts`
after queued review for Arm and armed Apply. Stopped Apply stays inactive. The
capture checks the exact huddle owner connection/identity, project/profile,
unarchived placement and definition location. Plans must match the reviewed
generation and intended activation. Failure leaves lifecycle intent unchanged.

`reader.ts` pins the selected agent's owner incarnation/launch, placement, worktree,
native conversation and segment. It requires native-source support on runtime 1.2+
and the provider's explicit availability; terminal placements, foreign scope,
archived targets/projects, Stop intent and pending identity persistence are refused.
The reader performs inspect, durable source read and reinspection, rechecking caller
authority and target identity after each await. It neither prompts nor restarts an
agent and can observe a busy agent without requiring automated-turn readiness.
Pending source persistence and unexpected baseline/epoch changes cannot arm a source.
All captured targets receive another synchronous check before the lifecycle send;
a lost read never authorises a mutation or retry. Public capture failures return a
bounded conflict without exposing private filesystem errors.

Automatic native-event dispatch and editor enablement are covered by the later
milestones above. The reader supports retained page reads, preserving explicit gaps
without rebasing. Tests use controlled native observation clients plus real isolated huddle
owners; they do not establish live provider, native supervisor or reboot acceptance.

Verification: **145 tests passed across 30 files** in the broader huddle control,
controller, completion and shared-contract run. After adding the separate plan
capability, **51 tests passed across 8 files** in the final focused run. Coverage
includes read-only retained/proposed plans, busy-agent observation, authority/native
identity changes at each awaited read, undurable baselines, old-owner request gating,
final dispatch checks and real owner arming with a captured target. Shared/daemon/CLI
TypeScript builds and repository ESLint, Prettier and diff checks passed.

## Implemented: owner completion subscription protocol

Optional `completionEvents: 1` now exposes private `completion-sources`,
`completion-events` and `completion-unavailable` controls. Arm and Apply accept
optional bounded `completionBaselines`; completion graphs require one exact baseline
per declared node before becoming armed. Baseline/resource validation runs before
changing lifecycle intent, so a rejected Arm or armed Apply preserves the previous
activation and subscriptions. Resume and armed Apply establish fresh generations.
Old owners remain supported; candidates lacking the capability cannot adopt owners
that require it. Application 28.4, ordinary runtime 1.2, remote 5, database 47 and
huddle owner/ledger contract 1 are unchanged.

Owner lifecycle and memory admission live in `triggers/completions/controller.ts`.
Active subscriptions hold a 256 KiB managed allowance; each synchronous page admission
separately reserves validation/encoding workspace based on the bounded request size.
The existing transport owns queued request memory. Refusals retain cursor state,
and Stop/Interrupt/failure release subscription capacity. Each page rechecks the
definition location and canonical worktree. An exact current source is required
before entering the failure-reporting path: stale activation/generation/cursor
deliveries cannot poison newer subscriptions. A genuine current gap or unavailable
source stops automatic admission visibly. Owner refresh continuations check their
lifecycle epoch after asynchronous scans before enabling subscriptions.

The scheduler and feature gate share the completion contract (now in the public
`coreHuddleComponents` catalogue after the later enablement milestone). A successful external completion
drives a captured script through an independently running owner when supplied by
the private controller. The subsequent host capture milestone above adds target
validation and queued baseline capture. Automatic native-source delivery and editor
enablement are covered above; bounded native feedback opt-in remains unfinished. Delivery must never
admit pages whose persistence is pending. The existing ask-result feedback template
is unchanged.

Verification: **146 tests passed across 32 files**, including independent-process
completion execution and controller replacement, invalid Arm/Apply preservation,
fresh Resume/Apply cursors, stale failure rejection, visible retention gaps, old
owner controls, managed memory refusal/release and capability adoption. Existing
huddle owner, controller, scheduler, routing, session-trigger and shared-contract
tests also passed. Shared/daemon/CLI TypeScript builds and repository ESLint,
Prettier and diff checks passed. The first integration
run exposed a missing scheduler catalogue entry; the passing run includes its fix.

## Implemented: completion subscription admission core

The internal `runtime/huddle/triggers/completions.ts` contracts describe eight
bounded node subscriptions, each pinned to the exact target runtime identity
(including incarnation and launch), selected placement, native conversation and
segment. The selected placement can differ from the runtime's original launch
placement. Definition resolution requires explicit literal/variable session and
canonical worktree bindings. Baselines must match the huddle profile/project and
resolved resources; the owner cannot subscribe to itself.

`runtime/huddle/state/completions.ts` retains eight reusable `completion-sources`
slots in the existing private ledger. Initialisation requires the exact retained
activation. The same generation preserves progress and refuses target changes;
a new explicit arming generation permits a fresh target and cursor. Scope changes
partway through initialising multiple sources roll back the whole transaction.

Admission validates an unfiltered, contiguous native page and exact record scope.
Pending persistence, epoch/retention/ahead gaps, missing positions and changed
placement/segment/native identity cannot advance the cursor. Only successful
external completions create root executions. Started/failed/interrupted records,
automated completions (including known huddle origins) and unknown-origin results
advance source progress without creating a root or spending its daily budget.
Automated feedback must eventually continue the original bounded execution; this
core does not allow automation to reset limits by starting another root.

Each page's cursor and all admitted roots commit together. Queue/storage refusal
and an oversized result roll back the whole page. The emitted data includes exact
native identity, observed time, origin, reply, runtime and worktree. The existing
256 KiB **encoded JSON value** limit includes that envelope and escaping, so a
native reply within its own 256 KiB text limit can still be refused; it is never
silently truncated. Reopening the ledger retains progress, and graph start retains
its existing single-admission semantics after a lost acknowledgement.

This milestone established the internal admission core; the later milestones above
enable `puddle.trigger.turn-completed@1` in the creation catalogue.
The subsequent owner protocol milestone above adds private
delivery/lifecycle/resource admission without a protocol/database version change.
Host-authorised baseline capture and live target/provider availability checks are
covered by the subsequent milestones above, including automatic delivery and editor
settings. Explicit bounded native feedback routing remains unfinished; the
admission-core tests do not establish those missing paths.

Verification: **97 tests passed across 17 files**, including 16 new completion
cases plus existing huddle revision, state, routing, scheduler, definition and
session-trigger integration suites. Cases exercise atomic rollback, ledger reopen,
lost-reply observation, exact scopes, variable bindings, baseline changes, missing
history, persistence refusal, envelope limits, automation suppression and admission
into the real captured graph. Shared/daemon/CLI TypeScript builds and repository
ESLint, Prettier and diff checks passed.

## Implemented: interactive Codex native turn observation

`agents/codex/turns/` observes exact native `turn/started`, final agent messages and
`turn/completed` events on the existing app-server connection. Commentary and side
threads do not become replies. A correlated injected `turn/start` response also
proves admission; final completion still needs the native completion notification.
Early results wait for the matching RPC identity before receiving immutable
ask/huddle attribution. External turns carry no automation context. Cancellation,
human takeover and native switches cannot turn late automated results into human
input or donate a later ask's identity.
Interruption ends the admitted observation; it is not proof that the native process stopped.

Optional source capacity is separate from essential ask/result retention: at most
64 unanswered contexts/512 KiB, eight active buffered source turns/8 MiB and 128
recent terminal ids/2 MiB. Replies remain bounded to 256 KiB. Missing admission,
lost scope and refused retention report gaps. Lost attribution makes subsequent
unmatched origins unknown instead of guessing external input. Buffer refusal and
observer failure do not stop the ordinary PTY or replay a command.
Contradictory/malformed acknowledgements and returning to a conversation whose
pending request lost its original scope also retain unknown attribution.

Independent owners provide a trusted synchronous `receiveSignal` adapter callback.
Codex delivers identity/status in native frame order, finishing the old observation
before switching the runtime segment. Each frame retains its observation position
through capacity pauses, so resumption does not repeat the already-observed prefix.
Legacy contexts retain loopback HTTP lifecycle delivery but do not advertise this
Codex source; the existing 0.159+ exact-control version gate remains required.
No application/runtime/remote protocol or database/ledger format changes are added.

Tests cover human/native turns, duplicate outcomes, early completion, both cancellation
orders, human takeover before acknowledgement, native switches, missing admission,
reply overflow, bounded unanswered contexts and memory refusal. Real WebSocket
fixtures use an isolated native-protocol executable to prove multi-conversation
batch ordering, no private RPC leakage and partial-capacity retry progress. An
independent-owner fixture retains external completion while disconnected and exact
huddle attribution after controller replacement through the production Codex bridge.
These fixtures do not call installed Codex or establish native-provider acceptance.

Verification on 2026-11-08: the agent/runtime-execution/huddle-operation/programme
regression run passed **361 tests in 56 files**, with four opt-in native tests skipped
across three files. After the final ambiguous-attribution safeguard, all **34 tests
in six Codex control, buffering, signal, bridge and owner files** passed again.
Shared/daemon/CLI TypeScript, repository ESLint, formatting and diff checks passed,
with scoped checks repeated for the final edits.

Huddle completion subscriptions/delivery and editor controls are covered by the
later milestones above. Live provider, SSH and reboot acceptance remain pending.

## Implemented: headless native turn observation

The existing Claude Code, Codex, Gemini CLI and OpenCode headless drivers now feed
the native-turn stream. `agents/headless/native-turn.ts` retains immutable admitted
ask/huddle context for one command invocation. `command:<uuid>` is the exact private
invocation correlation, explicitly not a provider-issued turn id. Every headless
invocation is automated; absent caller context remains unknown.

Native conversation identity is bounded and must bind before observations are
published. A successful result alone does not complete the source turn: exit 0 is
also required. Cancellation after a result but before exit remains interrupted;
missing results, nonzero exits and provider errors remain failed. Binding failure
keeps later asks unavailable rather than reusing an unbound native ref. Interruption
before binding produces a gap when an exact ref is known. Missing native identity
does not fabricate a placement or a completed turn. A managed 4 KiB observation
charge is released with the settled ask; capacity refusal and optional observer
errors do not own the ordinary command's lifetime.

Provider decoder fixtures execute through the real private terminal bridge, covering
two distinct correlated turns, immutable attribution, missing caller context,
native result/exit ordering, cancellation, delayed/rejected binding, disposal,
memory refusal and bounded identity. Independent owner fixtures use the same
headless control and a fixture executable to retain success or interruption across
controller disconnection/replacement with the original huddle origin. These do not
use installed provider CLIs or establish native/SSH/reboot acceptance.

Verification on 2026-11-08: **75 tests in 18 files** passed across runtime execution,
programme replacement and huddle-operation suites. The final headless bridge,
observation and independent-owner recheck passed **41 tests in four files**, including
failed-binding admission, oversized native identities and observer failure isolation.
Shared/daemon/CLI TypeScript, repository ESLint, formatting and diff checks passed.

Huddle completion subscriptions/delivery and editor controls are covered above.
Application/runtime/remote protocol versions and
database/ledger formats are unchanged by this provider integration.

## Implemented: native turn source retention

This milestone established the source foundation for selected-agent completion
triggers; the later milestones above enable **Turn completed**. Agent/terminal runtime protocol **1.2**
adds private `native-turns` reads and optional source status/provider availability.
Application 28.4, database 47, remote protocol 5 and huddle owner/ledger contracts
remain unchanged. No new unsolicited ordinary-runtime event is introduced, and
ordinary event acknowledgement cannot discard native source history. Older owners
remain usable for existing operations; callers must inspect protocol and explicit
`agent.native_turn_events: 1` before relying on this observation path.

`runtime/state/native-turns/` owns `native-turns.json`, with exact owner identity,
epoch, monotonic head, loss floor and at most 128 records/2 MiB (including encoded
JSON escaping). Private pages contain at most 16 records/2 MiB. Records retain native
conversation/turn ids, segment id, currently bound Puddle session (null before
placement adoption), owner observation time, outcome and attribution. Hook-derived
turn ids correlate native admission/completion; they are not claimed to be a
provider-issued id where that provider supplies none. Replies are bounded to 256 KiB.

The hook-based InteractiveControl used by supported Claude Code, Gemini CLI and
OpenCode integrations now emits started/completed/failed/interrupted observations.
Foreign conversations and unmatched turns never become successful completions.
Repeated active starts and retained outcomes do not create duplicates. Missing
native admission followed by completion marks a gap; late completions of retained
interrupted/completed turns are ignored. Missing reply data is a failed observation.
Human input, cancellation, replacement turns and native conversation switches end
the previous observation. Native-provider versions still need the existing adapter
support checks and live acceptance; fake hooks do not establish installed-provider
behaviour. Unsupported adapters do not advertise the availability flag.

Automated `start-turn` requests may carry huddle/execution/operation ids from the
trusted host caller, gated to protocol 1.2+. Immutable context follows the admitted
ask into its adapter and survives cancellation. A later active ask cannot donate
its identity to an earlier callback. External turns are explicit; automation without
known context is unknown. No prompt, nonce or environment is retained in this stream.
Rejected asks whose native start has not arrived retain up to 64 bounded, managed
attribution records in the hook control. Delayed acknowledgement retains the original
context and records interruption, never a successful result for the ended ask.
If this attribution history cannot be retained, subsequent unmatched starts report
a gap and unknown origin instead of being labelled human input.
Future huddle delivery must suppress automation/unknown echoes by default and use
explicit bounded feedback opt-in, as required by the roadmap.

Retention and write buffers spend the owner memory allowance. Record or byte
pressure evicts bounded oldest history with a durable conservative loss floor;
invalid/conflicting observations and capacity refusal also report loss. Disk/write
capacity failures remain `persistencePending` and retry with bounded backoff.
A page with pending persistence cannot establish durable huddle admission. Source
failures do not terminate the ordinary agent or reset essential turn dispatch.
Writes use a separate bounded atomic-file slot, preserving normal runtime journal
and checkpoint ownership. Close drains native observation persistence after adapter
shutdown; passive reads validate exact owner identity and byte bounds.
Runtime storage inventory accounts the source file as metadata and its single
atomic-write slot as temporary storage; classification does not grant reclamation.

Evidence includes actual private-file persistence, independent reader
cursors, byte/count eviction, duplicate/conflicting observations, malformed outcomes,
write failures/backoff, concurrent append during flush and memory refusal. Interactive
control tests cover external turns, exact automated matching, takeover, cancellation,
conversation switches, missing replies, delayed acknowledgement after timeout or
interruption, and attribution retention exhaustion. Isolated independent-owner tests send
native hooks while the controller is absent, reconnect and read retained completion,
acknowledge ordinary events without consuming it, and verify exact huddle attribution,
cancellation origin and unmatched-completion gaps.

Verification on 2026-11-08: a fresh final execution/interactive-control/huddle-operation
and native-schema run passed **105 tests in 20 files**, including cancellation before
native acknowledgement and the two-agent feedback fixture. Storage inventory/retention
checks passed **28 tests in two files**. Shared/daemon/CLI TypeScript, repository ESLint
and formatting passed, followed by scoped checks for the final edits.
The broader runtime/agents/huddle/updates/shared run passed **1,423 tests in 230 files**
with 13 tests skipped across nine files. Five newly added attribution cases saw an
earlier transformed control module in that running process; all passed in the fresh
final run above. Its separate resource-ceiling suite could not collect because this
checkout lacks `docs/reports/persistent-runtimes/resources/2026-11-04-native.json`
and the other recorded native report fixtures. This remains missing regression
evidence; no fabricated resource report or native acceptance result substitutes for it.

Pending: scoped native
source subscriptions/delivery into huddle owners, the completion-node UI and bounded
feedback/echo policy, stopped-source inspection and full provider/SSH/native/reboot
acceptance. Unreceived hooks cannot be reconstructed; detected missing admission is
a gap, never a fabricated completion. Owner crash is a separate incarnation/recovery
boundary, not automatic continuation of this process.

## Implemented: durable host session observations

Database migration **47** adds `huddle_session_feed` and its
singleton epoch/head/loss-floor checkpoint. SQL triggers capture placement
creation, actual status changes and the existing audit events `resumed`,
`interrupted`, `exited`, `killed`, `archived`, `unarchived` and `spawn_failed`.
The observation commits or rolls back with the originating session/audit write,
including writes outside SessionService. Equal-status updates emit nothing.
The old audit `created` event is excluded because placement insertion already
records creation. Existing sessions and audit history are not backfilled.

Every row freezes observed profile/project/session/worktree identity, session kind,
event, provenance (`placement`, `status`, `audit`), previous/current status and host
observation timestamp. It does not copy arbitrary audit payloads, session environment,
prompts or credentials. A created placement does not establish successful launch;
`waiting_input` does not establish turn completion. Sequence order is independent
of wall-clock timestamps. This feed does not yet retain general native-hook turn
identities/results; exact completion subscriptions require that separate runtime
integration rather than status heuristics.

Retention is bounded to the latest 4,096 sequence positions, with at most 8 KiB of
encoded observation data per retained row (at most 32 MiB of row JSON, excluding
SQLite/index/WAL overhead). A generated byte count includes JSON escaping and UTF-8.
Oversized metadata and empty/overlong worktree paths are removed while advancing the durable
loss floor; it does not roll back the originating session operation. Deleting any
feed row advances that floor conservatively. The checkpoint survives a fully empty
feed, and AUTOINCREMENT prevents reuse of deleted event sequence identities.

`huddle/triggers/sessions/feed.ts` supplies private bounded reads using a single
SQLite read transaction. Shared contracts live under
`shared/runtime/huddle/triggers/session-feed.ts`. Callers must separately establish
current profile/project/resource authority; the internal store is not an endpoint.
Reads filter exact profile/project/worktree, optional selected/excluded session,
session kinds and event kinds. Each page has at most 64 records and 128 KiB encoded
size. A page advances past unrelated records without exposing their content, while
byte-limited pages retain the last delivered sequence so later matches are not skipped.

A null cursor explicitly establishes a fresh baseline at the current head.
Otherwise epoch mismatch, retention loss and a cursor ahead of the host checkpoint
return a typed gap, never a silent rebase. The loss floor is host-wide: unrelated
activity can conservatively expire an idle filtered cursor. Reading a page is not
event admission or acknowledgement; owner admission is described below.

Evidence: actual SQLite fixtures cover atomic status/audit rollback, duplicate
status suppression, audit recordOnce semantics, scoped filtering, byte/count
pagination, durable reopening, retention/deletion/epoch/ahead gaps and oversized
metadata. The historical migration fixture opens a real schema-46 database,
preserves its sessions/audit rows, establishes an empty new stream and then records
a new transition. Shared tests reject forged provenance, completion claims,
unordered pages, invalid checkpoint bounds and oversized encoded observations.

Verification (2026-11-08, Node 22.21.1): the expanded database/session/runtime,
huddle, host-update and installation suites passed **1,019 tests in 159 files**,
with four pre-existing skips in two files. Shared/daemon/CLI builds, web typechecking,
repository ESLint/Prettier and `git diff --check` passed. The focused schema/feed and
database suite passed 36 tests in nine files.

```sh
node node_modules/vitest/vitest.mjs run packages/shared/test/huddle/session-feed.test.ts packages/daemon/test/huddle/triggers/sessions packages/daemon/test/db
node node_modules/typescript/bin/tsc -b packages/shared packages/daemon packages/cli
```

`puddle.trigger.session@1` is now available with explicit registered worktree,
optional selected session, agent/terminal kind filters, lifecycle/status events and
status targets. Selected stopped/archived terminals and agents are accepted without
requiring the agent-operation bridge. Huddles are excluded to prevent lifecycle
self-observation. Session settings use the shared inspector and existing worktree/
session queries; Clear setting preserves an unset optional session. Save stays inactive.

Optional `sessionEvents: 1` gates selected-runtime launch, Apply and owner handling.
Older owners remain supported; older candidates cannot adopt owners requiring it.
Private `session-sources` returns at most eight current subscriptions;
`session-events` and `session-unavailable` bind the exact source, including its
revision, activation, generation, scope and cursor. Eight reusable `session-sources`
ledger slots retain progress. Each page and all admitted root executions commit in
one transaction; status filtering still advances the cursor. Queue/storage refusal
rolls back the page and produces a visible owner failure. Genuine retention/epoch/
ahead gaps stop triggers. Stale source requests after Apply/Interrupt reject without
failing a newer activation.

Host controls capture `feedBaseline` after queued target/authority review immediately
before Arm/Apply. A session graph cannot arm without it. Start/Resume/armed Apply
establish fresh source cursors; a reconnected dispatcher reads existing cursors.
`huddle/triggers/sessions/dispatcher.ts` checks exact authenticated owner and retained
node, current profile/project/session/worktree resources and source scope before each
page. One shared one-second checkpoint poll drives up to four concurrent owner scans,
each bounded to four passes. Lost replies cause source/cursor re-observation before
further delivery. Maintenance pauses admission and drains accepted calls; shutdown
removes observers. Owners reserve bounded subscription memory. No public route or
application/ordinary-runtime protocol change is introduced.

New isolated fixtures verify whole-page rollback, cursor persistence across reopen,
status filtering, foreign scope and stale generations, selected capability gating,
archived terminal observation, real independent-owner script completion, dispatcher
replacement, lost acknowledgement, maintenance pause/release, Resume/Apply baselines,
missing-baseline refusal and visible retained-gap failure. The headless session editor
fixture verifies an explicit worktree, archived terminal selection, clearing the
optional selector, filter persistence and inactive saves.

Verification of session delivery (2026-11-08, Node 22.21.1): **1,037 tests passed in
165 files**, with four pre-existing skips in two files, across huddle, database,
sessions, runtime controller, updates, shared huddle/installation and web huddle
suites. The headless browser check below passed against the UI-only preview.
Shared/daemon/CLI builds, web typechecking, repository ESLint/Prettier and
`git diff --check` passed.

```sh
node node_modules/vitest/vitest.mjs run packages/daemon/test/huddle packages/daemon/test/db packages/daemon/test/sessions packages/daemon/test/runtime/controller packages/daemon/test/updates packages/shared/test/huddle packages/shared/test/installation packages/web/test/huddle
PREVIEW_URL=http://127.0.0.1:5194 node packages/web/test/huddle/sessions.browser.mjs
```

Pending: richer per-source health/backlog, retained native turn events, exact
completion echo suppression and packaged/provider acceptance. Catch-up covers recorded
host observations only, not native transitions the daemon never received. Reboot and
owner-crash recovery remain separate unfinished work.

## Implemented: Git ref and worktree HEAD observation

`puddle.trigger.git@1` requires an explicit registered `worktree`. `repository`
is a relative exact Git root (default `.`); ordinary subdirectories of a repository
are rejected. Nested repositories may be selected within the bound worktree.
`refs` defaults to `["refs/heads/**", "refs/tags/**"]`; patterns may select heads,
tags or remotes. An empty list selects only HEAD, provided `head` remains true.
The inspector reuses ordinary worktree, text, JSON, boolean and duration settings.
Saving does not arm observation. `debounceMs` defaults to 250 (50–10,000), and
`reconcileMs` to 30,000 (1,000–300,000). The owner shares one scan cadence across
its Git sources, using the shortest configured debounce/reconcile values.

`runtime/huddle/triggers/git/` owns bounded Git reads, metadata watches and
reconciliation. Canonical Git common-directory identity groups linked worktrees:
one ref read per common directory per scan, with worktree-specific HEAD reads.
Native notifications invalidate observations; repeated notifications and packed-ref
rewrites with unchanged values emit nothing. Two deliberately configured nodes
may each receive the same shared ref change once. Filesystem events are never
translated directly into commit events, and Git mutations from external tools
are observed through the same path. Metadata watchers exclude objects, reflogs
and ordinary working files. Periodic scans recover net changes after silent
notification loss. Root identity is rechecked before admission; moved/unavailable
repositories, source loss, watch failures and exhausted bounds report an observation
gap and stop automatic triggers.

Events carry a canonical worktree resource plus `data.repository`, `changes`,
`reconciled: true`, `observedAt`, `batch` and `final`. Each change has `ref`,
`oldOid`, `newOid`, `oldTarget` and `newTarget` (nullable). This preserves creations,
deletions and force updates. HEAD includes its symbolic branch target, so switching
between branches at the same OID still emits a change. Unborn HEAD has a null OID;
detached HEAD has a null target. Annotated tags retain the tag object's OID,
not a substituted peeled commit. These are bounded net observations, not a complete
reflog/commit stream or an atomic multi-ref snapshot. No exact `occurredAt` is invented.
The command semantics follow Git's [ref fields](https://git-scm.com/docs/git-for-each-ref),
[repository path reporting](https://git-scm.com/docs/git-rev-parse) and
[symbolic-ref status](https://git-scm.com/docs/git-symbolic-ref).

`state/git.ts` keeps eight reusable `git-sources` slots in private ledger format 1.
Each retains node, generation, activation, canonical worktree/repository/common
directory, baseline, pending observation and batch progress. Admission of at most
64 changes, event cursor and batch progress commit atomically. Queue/storage refusal
retains the pending observation; baseline replacement happens only after the final
batch. Start/Resume/armed Apply establish fresh baselines and exclude paused changes.
Same-generation reopening retains unfinished batches and rejects changed repository
identity. These records do not implement automatic owner-crash/reboot recovery.

Limits: eight Git sources per owner, 4,096 refs in each group's selected namespaces,
1,024 matched refs plus HEAD per node, 256 KiB per snapshot and 256-character ref
names. A namespace limit applies before glob filtering. Across the owner, metadata
scans allow 128 directories and 8,192 entries. Each command has a five-second deadline
and 2 MiB output limit; a scan has a fifteen-second deadline. The owner reserves
2 MiB plus 4 MiB per source from its existing memory allowance. Observer processes
strip inherited `GIT_*` overrides, disable optional locks/prompts and use argument
arrays without a shell. Cancellation kills only the owned Git child; the common Git
runner now waits for its `close` event even when abort delivers an earlier callback.
The owner retains claims and capacity until asynchronous observation has settled.

Optional private role capability `git: 1` gates selected runtime launch/Apply and
independent-owner validation. Older owners remain supported; older daemon candidates
cannot adopt owners requiring Git observation. Application 28.4, ordinary runtime
1.1, database schema 46 and ledger format 1 are unchanged. No new public endpoint
or remote authority is introduced.

Automated evidence (2026-11-08):

- Temporary real Git repositories exercise unborn/detached HEAD, same-OID branch
  switches, linked-worktree identity, packed refs, annotated tags, deletion, force
  updates, inherited-placement isolation and command cancellation.
- Durable ledger tests exercise queue refusal/reopen, 64-change batching, full
  snapshot replacement, generation fencing and repository identity mismatch.
- Native-watch tests exercise commits/tags, shared common-directory reads, duplicate
  invalidation, Stop/Resume, missing source, capability rejection and memory refusal.
  A separate missed-notification fixture verifies periodic net reconciliation.
- Deferred-read tests verify timeout/cancellation fencing and retained allocation
  until actual settlement. A subprocess test verifies abort does not release an
  unclosed child. Namespace/matched-ref overflow is rejected, never truncated.
- The independent process fixture disconnects its controller, observes external
  Git changes, reconnects, Interrupts/Resumes and Stops with exit code zero.
  Execution API tests verify selected-capability gating and changed filters on Apply.
- `web/test/huddle/git.browser.mjs` passes in headless Chromium against the existing
  UI-only preview: explicit worktree, repository/ref/debounce edits, saved source
  and no execution request. It uses existing inspector/canvas components.

Verification used Node 22.21.1 and Git 2.53.0. The expanded huddle, installation,
update, worktree and Git-route suite passed **755 tests in 117 files**, with four
pre-existing skips in two files. After the loose-ref pruning fix, the focused
Git/owner suite passed 28 tests; its added pruning fixture passed separately after
correcting the test's native-module mock. Shared/daemon/CLI builds, web typechecking,
repository ESLint/Prettier, token/contrast checks and `git diff --check` passed.

To repeat the Git checks from the repository root:

```sh
node node_modules/typescript/bin/tsc -b packages/shared packages/daemon packages/cli
node node_modules/vitest/vitest.mjs run packages/daemon/test/huddle/triggers/git packages/shared/test/huddle/git.test.ts packages/daemon/test/huddle/owner/process.test.ts packages/daemon/test/huddle/control/execution.test.ts packages/daemon/test/worktrees/git-exec.test.ts
PREVIEW_URL=http://127.0.0.1:5194/ node packages/web/test/huddle/git.browser.mjs
```

The browser command requires an existing UI-only preview; native-watch/process tests
require permission to open temporary watches/sockets. They never start a production
daemon. For packaged acceptance, create a Git → script → Result graph with an
explicit worktree, Start, then create/delete tags and commit from an external shell.
Verify payload OIDs, branch switches, linked-worktree deduplication and retained
history. Disconnect/reconnect the controller and repeat. Interrupt, make changes,
Resume and verify paused changes do not replay; Apply changed ref filters and Stop.
Repeat on supported platforms/filesystems and under the independent supervisor.

Pending: packaged macOS/Linux supervisor and SSH watcher behaviour, reftable-backed
repositories, network filesystems, host sleep/reboot, complete owner-crash recovery
and the richer trigger health/backlog inspector. Passing local fixtures does not
establish those release gates.

## Implemented: bounded Filetree observation

`puddle.trigger.filetree@1` exposes required `worktree`, relative `directory`
(default `.`), `include`/`exclude` glob lists, declared `outputPaths`, `debounceMs`
(50–10,000, default 250) and `reconcileMs` (1,000–300,000, default 30,000).
The inspector reuses project worktree selection and ordinary parameter bindings.
Globs are relative to Directory; output paths and emitted paths are relative to
the canonical worktree. The built-in always excludes Git metadata and every
`.puddle/huddle` subtree, and excludes `node_modules` by default. It skips symlinks
and special files; empty-directory changes are not file events. File contents
are not read. Hidden files require explicit dot globs.

`runtime/huddle/triggers/filetree/` owns settings/resource validation, streamed
bounded scans, native directory watches and lifecycle composition. It follows the
existing dependency observer's invalidation/reconciliation approach while retaining
its own durable source state. Node's [watch caveats](https://nodejs.org/api/fs.html#caveats)
mean notifications are not a complete edit log; periodic snapshots reconcile net
changes, and inode-aware directory observations renew replaced watches. Native
notifications never directly become trigger events. Include/exclude matching uses
[Node's stable path glob matcher](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern),
available in the required Node 22.21.1 runtime. There is no new dependency.

Start/Resume/armed Apply establish a baseline and finish initial scan admission
before returning their arming response. Existing files and paused changes do not
produce runs. A same-generation retained baseline/pending observation is preserved,
but automatic owner-crash recovery is not yet wired. Live subscriptions continue
through controller loss. Watch invalidation uses a bounded debounce window and
periodic reconciliation; atomic saves usually produce a change, and renames are
net remove/create. Metadata-only changes can also produce change events. The
snapshot is not a filesystem transaction and cannot reconstruct intervening edits.

`state/filetrees.ts` keeps eight reusable ledger slots across Apply, each bound to
node, activation, generation and worktree. A slot retains a baseline snapshot,
one pending snapshot and its admitted batch offset. Admission commits an event,
execution, source cursor and batch progress together. The baseline advances on
the final batch. Pending observations cannot be replaced before draining; refusal
preserves both the pending snapshot and consumed batch offset. Event ids bind
activation/generation/sequence within source identity. Payloads contain up to 64
`{path, kind}` changes, `reconciled: true`, observation time, batch number and
`final`. The envelope binds the worktree resource and deliberately omits an exact
`occurredAt`. Ledger reopening drains remaining batches without duplicate events.

Bounds: eight sources per owner; 128 watched directories, 8,192 visited entries,
1,024 matched files, 256-character relative paths and 256 KiB per snapshot per
source. Include globs do not prune traversal; Directory/exclusions do. Each source
reserves 4 MiB from the common host allowance. Admission yields between at most
32 batches for one reconciliation. A watchdog reports scans stalled beyond ten
seconds, stops subscriptions and retains capacity until the read settles. Watch
errors, missing/substituted roots, missing definitions, scan bounds and exhausted
queue/storage/daily budgets report a visible observation gap; all automatic
triggers stop. Cancellation closes watches/timers immediately and fences callbacks
before ledger access. Shutdown cancels the scheduler before waiting for scans;
unknown scan settlement blocks clean owner retirement rather than releasing claims.

Optional **`filetree: 1`** gates Start/Apply and independent-owner validation.
Older owners remain supported; older daemon candidates cannot adopt Filetree
owners. No REST/WS, ordinary runtime, SQLite schema or desktop format changes.
The existing failure inspector exposes gaps. Rich per-trigger ready/degraded state,
backlog inspection and automatic crash/reboot recovery remain unfinished; an
explicit Stop/Start acknowledges a new baseline, not replay of missing edits.

Verification: bounded scan tests cover glob/default/output exclusions, symlinks,
atomic save, rename, remove, file limits and replaced roots. Ledger tests retain
130 changes through queue refusal/reopen and replace two complete 1,024-file
snapshots within bounded state. Watcher tests cover new directories, cancellation,
source loss and memory refusal; a silent-watch fixture verifies periodic net-change
reconciliation. Delayed-read tests verify fencing, watchdog faults and retained
capacity. An isolated owner admits/completes changes without a controller, rearms
with a fresh baseline and exits after Stop. The public API refuses unsupported
runtime metadata before intent and replaces watched scope on Apply. Native watch
checks require unsandboxed temporary-directory access on this macOS host; the
sandbox otherwise reports EMFILE. The focused source/API/capability suite passed
22 tests, and both delayed-read checks pass. Headless UI checks verify explicit
worktree/settings/save without execution; light/dark settings were visually reviewed.
The final huddle, installation and host-update regression suite passed **647 tests
in 104 files**, with **4 tests skipped in 2 files**. Shared/daemon/CLI TypeScript
builds, web typechecking, repository ESLint/Prettier, 70 contrast pairs per theme,
semantic-colour checks and `git diff --check` pass. A final equivalent glob-control
validation lint fix also passed its focused shared checks. Native/platform
filesystem matrices, packaged supervisor/SSH/reboot and real-provider acceptance
remain open.

## Implemented: calendar and one-off date triggers

`puddle.trigger.calendar@1` exposes `timeZone` (named IANA zone, default UTC),
`time` (24-hour HH:mm, default 09:00), unique ISO `weekdays` (1–7, default every
day), `missed` and `maxCatchUp`. Calendar has the same coalesce/skip/bounded
catch-up policy and event payload as Interval. Counts cover actual scheduled
instants, excluding nonexistent civil times. The initial recurrence surface is
daily or selected weekdays, not arbitrary cron/monthly/yearly rules.

`puddle.trigger.date@1` takes required ISO `at` with seconds, optional milliseconds
and an explicit Z/offset, on or after the Unix epoch. `past` defaults to `fire`;
`skip` records a consumed skip if the date is already past when armed. A date
that was future when armed still fires after a delayed wake. Its event uses the
same four fields, with occurrences 1 and skipped 0. Node settings and the execution
review explain activation behaviour. Creating/editing/saving never arms a trigger.

Civil-time logic lives under `daemon/runtime/huddle/triggers/calendar/` using
`@js-temporal/polyfill@0.5.1`, a daemon-only dependency. It picks the earlier
ambiguous instant and compares the resulting local time to the requested time;
nonexistent times are skipped rather than shifted. This follows the
[Temporal disambiguation contract](https://tc39.es/proposal-temporal/docs/zoneddatetime.html#static-methods).
Timezone conversion uses the pinned Node runtime's timezone database, not the
renderer or the host's default timezone. Settings are validated before activation,
including independent-owner requests. Existing active captured code is unaffected
by source edits until Apply.

`state/schedules.ts` retains one bounded `schedules/current` record under ledger
format 1: exact activation/generation, calendar `through` instant, or date
pending/admitted/skipped disposition. Source identity plus activation/scheduled
instant deduplicates events. Admission, inbox/execution/source cursor and schedule
progress commit together. Queue refusal preserves both durable progress and the
prepared plan. Reopen retains consumption. Calendar Resume excludes paused time
without moving an already-consumed instant backwards. Date Resume retains admitted
or skipped disposition. **Apply, including unchanged source, or Start after Stop
creates a new activation and may fire a past date again.** Stopped-owner recovery
and reboot are not inferred from ledger persistence.

One owner timer serves intervals and up to 32 calendar/date nodes. Calendar owners
reserve 1 MiB from the common allowance for bounded plans; interval-only owners
retain their 64 KiB reservation. Deadlines cache by consumed progress, so interval
wake-ups do not repeatedly convert future calendar dates. Each source plan has at
most 64 events; each wake admits at most 64 total. There is no timer after the last
one-off is consumed. Long future deadlines are rechecked at most once per day.
Calendar lookback is limited to 366 elapsed days, with a bounded civil-date scan;
a larger observation gap reports a fault without advancing progress. Inspect
accepted work, then explicitly Stop/Start to schedule from now. Missing source,
resource exhaustion and persistence failure retain the existing visible-fault path.

Optional **`calendar: 1`** gates launch/Apply and independent owner admission.
Existing owners without calendar support remain supported. Older candidate daemons
cannot adopt calendar-capable owners. No public protocol, ordinary runtime, ledger
SQLite version, application migration or desktop persistence change is needed.

Verification: deterministic tests cover New York spring/fall DST,
Lord Howe's half-hour shift, Apia's skipped date, local weekdays, bounded catch-up,
coalesced counts, rollback and excessive gaps. Ledger tests cover reopen/Resume,
past-date dispositions, real queue refusal, stale plans and validation before
activation. An isolated owner fires and completes a date without a controller,
then preserves it through reconnect/Resume. Headless authoring tests verify calendar
and date settings, saved source and absence of execution requests; light/dark
screenshots were visually reviewed after shared theme transitions settled.
The final huddle, shared installation and host-update regression suite passed
**631 tests in 98 files**, with **4 tests skipped in 2 files**. Public API tests
refuse an unsupported date runtime before launch intent and verify schedule
replacement on Apply. A deterministic owner-timer test admits once across a
repeated hour. Existing execution-review and interval browser checks pass.
Shared/daemon/CLI TypeScript builds, web typechecking, repository ESLint/Prettier,
70 contrast pairs in each theme, semantic-colour checks and `git diff --check` pass.
Native sleep, supervisor/SSH continuity, owner-crash/reboot recovery, real-provider
completion and full packaged release acceptance remain open.

## Implemented: independent interval triggers

The `puddle.trigger.interval@1` built-in exposes `intervalMs` (1,000–86,400,000),
`missed` (`coalesce`, `skip`, `catch-up`) and `maxCatchUp` (1–64). Defaults are one
minute, coalesce and ten catch-up events. Editor duration fields are numeric and
schema enums are selectors. Creating/editing/saving this node never arms it;
the execution review explains automatic activation.

`runtime/huddle/triggers/` validates captured built-ins, resolves interval settings
and runs one deadline timer per owner, with at most 32 interval nodes and 64
admissions per wake-up. It reserves 64 KiB from the common host memory allowance
and releases it when disarmed. No renderer or controller timer is involved. The
next wake-up is the nearest occurrence (capped at one day), not idle polling.
Schedule calculation uses UTC instants; clock rollback never repeats an ordinal.
Clock jumps are reconciled at the next wake-up. Calendar/timezone/DST schedules
and one-off dates are described in the newer implementation section above.

`state/intervals.ts` stores one bounded `intervals/current` record in ledger
format 1. Activation/generation, anchor and last admitted ordinal are retained.
One transaction commits event inbox, execution, source cursor and timer progress;
queue/storage/daily-budget failures roll back progress. Event ids include the
activation, generation and ordinal. Coalesce emits the newest due ordinal with
its covered count. Skip emits that newest occurrence and reports older skipped
ones. Catch-up delivers the most recent bounded set in order, reporting skipped
older occurrences in the first event. Event data includes UTC `scheduledAt` and
`firstScheduledAt`, plus `occurrences` and `skipped`.

Start/Resume and armed Apply initialise a fresh anchor. Interrupt/Stop disarm
before waiting on workers; old callbacks cannot admit against a new generation.
Paused/stopped periods are not caught up. A missing canonical definition location
or failed admission stops timers and reports owner failure; accepted work remains
recorded. Inspection and Stop remain available. Recovery is explicit Stop/Start,
not automatic replay. File/source presence checking is shared with host admission.

Launch, Apply and the owner independently require optional **`timers: 1`** for
interval graphs. New runtimes still support owners without that capability;
older daemon candidates cannot adopt timer-capable owners. Passive release and
adoption metadata carry the requirement. No REST/WS shape, application version,
ordinary runtime contract, SQLite schema version or desktop format changes.

Verification: deterministic tests cover policies, rollback, retained
progress after ledger reopen, interrupt/rearm, one deadline timer, memory refusal,
source failure and capability skew. Isolated owner processes admit and complete
interval events with no controller, reconnect under a replacement, interrupt,
rearm and stop. The public API test refuses an unsupported selected runtime before
launch intent and verifies automatic execution plus replacing the schedule on
Apply. Headless UI tests cover interval creation, defaults/settings/save without
arming and existing execution controls; agent-template settings also pass. Light
and dark interval settings screenshots were visually reviewed. The broader huddle,
shared installation and host-update suite passed **611 tests in 95 files**, with
**4 tests skipped in 2 files**. After final failure/shutdown refinements, all
**24 owner/API/timer tests in 3 files** passed; the focused policy/timer suite also
passed its 10 checks. Shared/daemon/web/CLI TypeScript builds, repository ESLint,
Prettier, token checks and `git diff --check` pass. These checks do not prove native
supervision, host sleep/reboot, owner-crash recovery or real-provider completion.

## Implemented: direct canvas connections

`canvas/connections/` owns transient output-to-input gestures and selectable wire
rendering; `canvas/NodeIsland.tsx` separates movable headers from labelled socket
buttons. Mouse and touch drags preview a wire without changing source. Releasing
on an input adds one manifest edit. Clicking an output and then an input, or using
Tab/Enter, provides the same connection path. Escape, pointer cancellation, lost
capture and an off-socket drop cancel. A changed manifest model invalidates an
in-progress gesture before commit. Failed edits cannot report successful connection.
Sockets highlight admissible targets and report rejection text through a live region.

`documents/graph-connections.ts` is shared with the selector inspector. It rejects
missing endpoints, duplicate routes and definitely incompatible types. Unknown
schema relationships retain runtime validation. Cycles and ambiguous joins remain
editable drafts with existing validation diagnostics; the inspector can configure
bounded feedback, and execution still requires a valid saved graph. Selecting a
wire exposes Disconnect selected; a focused wire accepts Delete/Backspace. These
changes use existing manifest Undo/Redo, drafts, save/conflict handling and never
execute nodes. No application/runtime protocol or storage format changes are made.

Verification: the dedicated headless wire check covers mouse/touch/keyboard creation,
zoom, duplicate rejection, Escape, touch cancellation, off-socket drop, concurrent
source edits, undo/redo, wire selection/removal and saved round-trip without execution.
Existing canvas movement/conflict and graph/source editing browser checks pass.
Unit coverage includes missing endpoints, duplicate and incompatible routes, unknown
runtime-validated schemas and drafting a feedback cycle without bypassing validation.
The focused web/shared huddle suite passes **39 tests in 11 files**. Web TypeScript,
repository ESLint/Prettier, token contrast checks and `git diff --check` pass. Light
and dark canvas screenshots were visually inspected; the authoring browser check
also covers collapsed/narrow presentations. The agent-template browser regression
passes, including unresolved component labels, resource/prompt settings, bounded
feedback and script navigation. These five browser checks use isolated fixtures;
they do not establish native-provider or supervisor acceptance.

## Implemented: movable nodes and shared layout drafts

The canvas supports primary-pointer and touch dragging, keyboard arrows (10 units,
50 with Shift), X/Y position fields, background panning, zoom and fit graph/selection.
Pointer previews stay local until release; one finished drag adds one layout undo
step. Escape, pointer cancellation and lost capture discard the preview. A gesture
checks the layout model version before commit and cannot replace a concurrent source
edit. Negative coordinates and schema bounds remain supported. Position edits retain
all current node positions and discard orphan positions; graph/node execution is
unchanged.

`documents/use-source-buffer.ts` shares ordinary editor state for `huddle.json` and
`layout.json`. Graph Undo/Redo and layout Undo move/Redo move are separate histories;
Cmd/Ctrl-Z on a focused node uses layout history. Save and the huddle save shortcut
save both documents through their individual file guards. A partial save can leave
one file saved and the other conflicted; there is no multi-file transaction claim.
Open layout uses the same Monaco model. Dirty markers, refcounts, duplicate-view
close review, browser recovery drafts, desktop capture/transfer/arrangement helpers
and archive source retention now include both files. Unsaved layout content with an
absent-file baseline remains a normal transferable draft.

An absent optional layout is represented as clean default text only after a valid
sibling definition is read. Opening does not write source or create an owner.
Application **28.4** reserves `expected_mtime_ms: -1` on worktree-file PUT for
exclusive creation. Existing files and symlinks return `409 stale_file` without
replacement. Client creation requires advertised 28.4 support; ordinary saves keep
their existing mtime guards. Layout movement is gated on that host floor. Runtime
contracts, database schema and private desktop content format are unchanged.

The canvas conflict check exposed a shared Monaco issue when adopting a shorter
disk document while old diff gutter ranges remained mounted. ConflictView now
detaches its models before Take disk replacement while keeping the widget alive.
A failed read restores the comparison without replacing its context services.
It keeps the shared draft/model and normal conditional reconciliation path.

Verification: **562 tests passed in 77 files** across shared huddle/window contracts,
worktree-file routes, web editor/workspace/window helpers and huddle navigation.
Tests include competing absent-file creators, existing-file/symlink preservation,
two-document transfer/capture and last-holder accounting. The headless canvas check
covers zoom-aware mouse dragging, real browser touch events, keyboard movement,
undo/redo, Escape, a concurrent source edit during a drag, panning, fit controls,
guarded creation, save conflict, failed Take disk read and successful retry, and
duplicate layout-source close review. It also verifies older-host gating and makes
no execution request. All five huddle browser scripts (authoring, editing, templates,
execution and canvas) and ordinary duplicate-file close checks pass. Three headless
window regressions pass: pane return, file menus and project layouts. Shared, daemon,
web and CLI TypeScript builds, repository ESLint/Prettier, token contrast checks and
`git diff --check` pass. Light and dark canvas screenshots were visually reviewed.

Retained camera/selection, viewport culling/large-graph measurement,
unified graph/layout undo and full native window gestures remain unfinished. These
checks use the UI-only preview and isolated file-route fixtures, not native desktop
input or production agents.

## Implemented: editable agent templates and feedback settings

Application **28.3** adds strict local/SSH template publication under
`POST /api/huddle/:profile/definitions/:id/components`. Source assets live in
`shared/huddle/templates/`; `daemon/huddle/templates/` publishes `node.json`,
`run.ts` and `prompt.ts` under the chosen `nodes/<component>/`. Existing project,
worktree, request authority and storage admission apply. Publication checks ordinary
directories and files, uses exclusive writes, retains identical files and refuses
different user source. Partial identical publication may be completed by an explicit
same-key request. It does not change the graph, create an owner or send a prompt.
Lost replies and graph insertion failures can leave unreferenced source; the UI
does not retry automatically or delete these files on graph Undo.

The IDE adds Prompt agent and Review agent templates as local graph nodes, with
explicit prompt defaults. Saved local contracts resolve through ordinary worktree
file queries even before graph save, and invalid settled reads do not reuse stale
captured contracts. Worktree/session selectors use existing project resource queries;
variable bindings remain available. Literal worktrees filter agent choices, while
activation still validates exact live ownership. Prompt fields accept multiline text
and `{{input}}` / `{{input.field}}` substitution with own-property lookup; missing
fields and UTF-8 expansions above 128 KiB fail before agent dispatch. Prompt agent
returns text, Review agent returns
strict `{complete: boolean, feedback: string}`. Both emit an optional `turn` event
after the ask completes, separately from their returned `completed` output.

Connection settings expose declared boolean output fields, expected boolean value
and finite round limit for feedback edges. The default is five rounds, continuing
while the first selected boolean field is false. Limits are failures on exhaustion,
not implicit approval. These nodes use existing operation-capability-2 attach/ask;
runtime contracts, ledger format and database schema are unchanged. Spawn/resume,
account selection for launching new agents, external triggers and native-provider
acceptance remain pending. See the [usage guide](../huddle.md).

Verification in this increment includes service/HTTP checks for scope, revocation,
symlink escape refusal, strict inputs, identical publication, edited-file preservation
and inactive authoring. A real isolated owner/worker test runs both shipped templates
against two separate test-adapter agent owners: each takes two turns, exact reply
content feeds the next prompt, four test-adapter turn results are consumed once, and the
root completes when the second review approves. This establishes the full runtime
path with a fake provider, not acceptance against a live external provider.
Headless browser checks create both templates, select distinct sessions, edit the
prompt, connect feedback, save the graph and open generated source in Monaco without
any execution request. Additional browser checks verify visible effective prompt
defaults after Clear, saved invalid contracts becoming unresolved, normalized source
paths in Monaco and hiding templates on application-28.2 hosts.

The final shared/huddle, daemon huddle/puddlang/programme-turn and web huddle suite
passed **328 tests in 53 files**. The template, existing editing and existing
execution-control headless browser scripts passed against the UI-only preview.
Shared/daemon/web/CLI TypeScript builds, repository ESLint/Prettier, semantic-colour
checks and `git diff --check` passed. No production daemon, external provider,
native interactive window or installed service was used for these checks.

## Implemented: automatic agent dispatch and declared session bindings

`huddle/operations/dispatch/` now drives the owner mailbox from the production
daemon composition. It shares the same `RuntimeProgrammeTurns` instance and
busy gate as ordinary puddlang.
Authenticated owner operations must match the immutable runtime identity and a
captured script component declaring session/worktree resources. The host rechecks
profile, target incarnation, placement, worktree and Stop/archive constraints at
dispatch. Scripts receive no host credential.

Start/Apply admit local script components with `sessions` capability and explicit
`worktree` and `session` resource parameters. Session values are Puddle placement
UUIDs, supplied literally or through variables. The selected agent must already
have a supported live runtime in the same project and declared canonical worktree.
Activation captures its exact runtime/incarnation; later admission rechecks reject
changed bindings. Busy agents can be selected but refuse concurrent asks. Other
account/project/provider selectors and spawn/resume/stop operations remain
unfinished. Agents in distinct registered worktrees can be selected by distinct
nodes; one node's session resources must share its declared worktree.

Runtime capability **`operations: 2`** adds `operation-unavailable` and retained
`{ rejected: string }` outcomes for positively unsent asks. Unknown sends remain
unknown while the waiting node fails; they never become retry permission. New
controllers can still adopt capability-1 owners and owners without operations;
automatic dispatch and agent-capable Start/Apply require capability 2. Existing
local-only graphs remain usable on older huddle owners. Application 28.2, ordinary
runtime 1.1 and owner/ledger format 1 remain unchanged.

Database migration **46** adds `cancellation_attempted` to the immutable huddle
turn mapping. Cancellation checks the original placement/segment and consumes
this intent immediately before one `cancel-turn` send. Replacement dispatchers
cannot repeat an uncertain cancellation or target a replacement agent. User
interruption and root deadlines cancel admitted turns; daemon shutdown or
maintenance suspension preserves them for later observation. The dispatcher
participates in maintenance pause/drain before runtime connections and projection
pause, and drains before SQLite closes.

Owner invalidations schedule bounded scans (four concurrent scans, four pages per
pass). At most 64 operation tasks are retained across the daemon. Pending admitted
turns observe committed results at 250 ms intervals; settled/idle graphs do not
poll. Daemon/controller replacement reads consumed operations and retained agent
results, saves exact outcomes in the live owner, then acknowledges host retention.
It never resumes a script stack or resends an accepted prompt. Unknown claims
without host admission remain unresolved until owner failure/deadline handling;
no absence inference permits another send.

An outcome exceeding the huddle JSON envelope fails the waiting node, retains the
unknown operation and leaves the full host result unacknowledged. Explicit
retained-result disposition remains unfinished. Host-side reconstruction after a
huddle owner crash, packaged/SSH/reboot continuity and real-provider acceptance
remain separate gates. Shipped agent-node templates, spawn/resume and external
triggers/readouts are still required by the roadmap.

Verification: **462 tests in 67 files** passed across all shared tests and the
huddle, puddlang, startup, update-checkpoint/maintenance, migration and ordinary
programme-turn suites. After tightening lost-settlement handling and adding
schema-45 migration coverage, **18 focused tests in two files** passed. The new
process checks cover automatic completion, busy refusal, maintenance admission,
exact interruption, dispatcher handoff, replacement controller/reconciler
connections and observation after a lost settlement reply. These use isolated real
owners with a test provider, not production accounts or native windows.
Shared/daemon/CLI TypeScript builds, repository ESLint, Prettier and colour-token
checks passed.

## Implemented: private owner agent-operation mailbox

`runtime/huddle/operations/` connects captured script workers to an owner-local,
durable ask queue. Attach resolves only explicitly declared session resources in
the node's declared absolute worktree; an arbitrary worker handle cannot select
another agent. Resolved activation references retain the exact target runtime,
incarnation, placement, project and canonical worktree as bounded, inspectable
`huddle-agent:` JSON strings. These strings grant no host authority. The shared
puddlang attach field now permits up to 4,096 characters for these references;
ordinary puddlang attach resolution is unchanged.

The original optional **`operations: 1`** huddle capability introduced private
`operation-page`, `operation-claim` and `operation-settle` commands. Existing
owners without it remain adoptable and retain their original handshake metadata;
they refuse mailbox commands. Candidate daemons lacking the capability cannot
adopt owners that require it. Application 28.2, ordinary runtime 1.1, private owner
contract 1 and ledger format 1 remain unchanged; the dispatcher above requires
database schema 46 and operation capability 2.

Ask intent enters the ledger before the controller can claim it. A claim consumes
the operation and root turn budget before any external send. Repeated claims only
observe; a lost reply never permits redispatch, even when no agent turn was sent.
The worker waits across controller disconnect within its existing deadline and
cancellation policy. Unclaimed cancellation is positively unsent; cancellation
after consumption preserves an unknown outcome. Owner crash still interrupts
arbitrary TypeScript rather than reconstructing its stack.

Settlement binds the exact retained operation scope and stores the complete agent
outcome and host receipt before replying to the worker or controller. Repeated
equal settlement observes the saved result; conflicting scope, outcome or receipt
is refused. Late results can settle an interrupted operation without restarting
the graph or emitting its outputs. Only confirmed durable settlement permits the
host adapter to acknowledge and reclaim the corresponding agent result.

Pages contain at most 16 records and 1 MiB of JSON, with ordered unique ordinals.
Cursors enumerate rows; refresh earlier pages to observe outcome changes. Pending
asks reserve shared owner memory within a 16 MiB/64-request local allowance before
recording intent. Agent outcomes must fit the existing 256 KiB huddle JSON value
limit, including JSON escaping and receipt overhead. A reply fitting the agent's
raw-text limit may exceed this envelope; it is rejected without truncation or host
acknowledgement. The dispatcher fails the waiting node and retains this result;
explicit disposition remains unfinished.

Tests drive a private controller explicitly against real isolated huddle/script
and test-provider agent processes. They cover durable settlement before host
acknowledgement, controller reconnect, consumed claims after a lost reply,
conflicting/late settlement and legacy capability adoption. Unit checks cover
binding scope, memory refusal, cancellation, single-spend root budgets and bounded
wire contracts. This is not native-provider or production application acceptance.
The automatic dispatcher and resource admission are described above. Spawn/resume
operations and shipped agent nodes remain pending.

Verification for this increment: 340 automated tests across 50 files passed
(shared huddle/installation, daemon huddle/puddlang/startup/checkpoints and ordinary
programme turns). Shared, daemon and CLI TypeScript builds, repository ESLint and
Prettier checks passed. Native-provider and packaged continuity acceptance remain
outstanding.

## Implemented: host-side exact agent-turn admission

`huddle/operations/turns/` now supplies a host-side ask/observe/acknowledge adapter
for huddle callers. It is an internal building block: the private huddle-owner
transport and production composition are implemented above. Shipped spawn/attach/
resume nodes remain pending; custom scripts can attach to declared sessions.

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
The mailbox and automatic dispatcher increments above add owner intent, exact
settlement and consumed-operation observation; their evidence is separate from
these original host-adapter tests.

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
registered to the definition's project. Supporting owners now also admit declared
session resources and attach/ask scripts. Account/project/provider selectors remain
rejected; custom trigger subscriptions and readouts are covered above. Cross-project binding remains
unfinished. Scripts retain the trusted-code execution model; these checks are not
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

Later manifest/layout editing, templates and execution controls are documented above.
Still pending: complete generated settings and component-change
observation, retained graph camera/selection across transfers and authoring assistance.
This remains partial IDE implementation,
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
contracts; custom trigger workers and readouts are covered above. Coalescing/drop admission is refused
until those policies are implemented. The independent owner entry point below
now composes these helpers; public creation/Run and interval triggers are documented above.

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
bridge, host resource accounting and lifecycle fencing. Finish settings,
additional integration adapters, provider-backed lifecycle nodes,
authoring tools/docs/skills and packaged integration.

All live provider, SSH, native window, supervisor, complete owner crash/reboot, trigger cadence,
readout reconciliation, permission/takeover, persistence/retention and installation
acceptance is **Pending**. No fake fixture, static validator or TypeScript build
establishes those behaviours. Maintain the roadmap's complete acceptance list as
these features ship; do not reduce the goal to this preparatory layer.
