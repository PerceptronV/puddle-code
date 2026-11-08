# The puddle communication protocol

Application **28.20** adds explicit same-execution native feedback behind optional
owner **`nativeFeedback: 1`**, requiring operations-2, completionEvents-1 and
completionPlans-1. Script manifests may declare `nativeCompletion`, the name of a
string parameter selecting a Turn completed node. `agent.askNative()` sends the
ordinary ask through the existing session/turn bridge, then waits for both its
retained result and the selected native source's matching automation event.
Standalone puddlang rejects native confirmation; ordinary asks are unchanged.

The private ask input retains its source generation, activation, cursor and exact
agent/conversation/segment. The existing operation intent transaction reserves a
bounded `native-completions` evidence row before dispatch. Native page admission
retains the terminal native turn identity and reply digest atomically with cursor
advancement. It never creates an automated root. Result and event may arrive in
either order; matching origin, turn number, conversation and reply produce one
worker response in the original invocation/execution. Existing turn/round/time
budgets, takeover handling, cancellation and owner-loss interruption apply.
Stopping/replacing a subscription rejects pending native waits without replay.
No new agent detector, agent protocol, HTTP route or database migration is added.
Old runtimes retain existing graphs; native-feedback source requires supporting
capabilities. Editable native prompt/review templates and their completion-trigger
selector are available on 28.20; generated authoring types include askNative.

Application **28.19** adds bounded automatic Linux huddle crash recovery behind
optional owner **`automaticRecovery: 1`**, requiring crashRecovery-1. The existing
private recovery provenance adds optional `automaticAttempts` (1–3), requiring
containment and a supporting replacement. Its value must advance the predecessor's
counter exactly; explicit/reboot recovery omits it and resets this automatic budget.
Older owners without the capability stay explicit-only. Public recovery request
and response shapes, database schema and agent runtime protocol are unchanged.

The daemon consumes existing authoritative huddle owner-loss reconciliation, then
uses the existing recovery launcher for armed same-boot interrupted owners only.
Stop/archive/placement/maintenance/storage checks apply before dispatch and under
source claims. Durable replacement intent prevents replay after a lost reply.
A serial, paginated coordinator shares placement checks with opted-in reboot
recovery and drains before launcher maintenance/shutdown. Reboot policy is separate.
Real Linux acceptance and macOS/detached descendant fencing remain pending.

Application **28.18** adds optional `after: "reboot" | "owner-crash"` to the
existing huddle recovery request; absent means reboot-only. CLI/MCP gate explicit
modes on 28.18. Opt-in `include_crash_recovery=true` alongside `include_recovery=true`
adds optional `recovery.crash_recovery: true` only when retained Linux containment
metadata matches the host. This offer is not proof of exit or replacement authority.

Optional owner **`crashRecovery: 1`**, requiring recovery-1, records a private
format-1 cgroup-v2 containment record before project execution. The existing private
recovery provenance may carry `containment` only for a same-boot recovery; a launch
with it requires crashRecovery-1. It binds full original identity, boot, kernel
cgroup path/device/inode and namespace. Source claims, seed copying and replacement
startup require unchanged proof of an empty/removed cgroup. Ordinary reboot recovery
keeps its existing provenance shape. Older owners/clients retain their previous
contracts. No application database, owner ledger or agent runtime protocol change.
Application 28.19 extends this with bounded automatic Linux recovery; other
platform descendant fencing remains unfinished.

Application **28.17** adds read-only local/SSH `POST
/api/huddle/:profile/sessions/:sid/triggers` with `{target}`. Optional owner
**`triggerInspection: 1`** accepts private `trigger-inspect` with exact generation
and activation and returns `trigger-report`. Public runtime inspection exposes
`trigger_inspection: true` only when requested with
`include_trigger_inspection=true` and supported by the owner. Older clients and
owners keep their existing shapes. CLI/MCP gate on 28.17.

Reports project installed source health, retained accepted-work counts and timer
progress without private cursors/event payloads, external polling, subscription
refresh or new persistent state. Per-source counts cover the inspected activation;
global backlog includes older activations. Inspection tolerates a failed owner or
missing project source but rejects a changed target. No database, ledger or agent
runtime protocol change.

Application **28.16** adds local/SSH `POST
/api/huddle/:profile/sessions/:sid/auto-start` with `{target, expected, enabled}`.
`expected` is the inspected setting. Opt-in `include_auto_start=true` adds
`owner.auto_start` only for owners advertising **`autoStart: 1`**, which requires
`recovery: 1`. Private `auto-start` checks the exact generation, activation and
previous value, then changes only the retained preference. It does not arm a
stopped graph, advance generation or reset schedules/cursors. Old clients and
owners keep their previous shapes and controls.

The daemon's paginated startup pass recovers only opted-in, armed owners from a
verified earlier boot. It excludes archived placements/projects and retained Stop
requests, rechecks source/placement/storage and verifies the opt-in again under
recovery claims. Existing replacement intent prevents another launch after a lost
reply. Same-boot daemon replacement adopts surviving owners normally. The setting
belongs to the current run: Apply and Interrupt/Resume preserve it; Stop suppresses
auto-start, and a fresh Start defaults off. Agent `autoResume` configuration remains
independent. No database or ledger migration is needed. CLI/MCP gate on 28.16.

Application **28.15** adds explicit local/SSH huddle reboot recovery, `POST
/api/huddle/:profile/sessions/:sid/recover` with `{owner: {runtimeId, incarnation}}`.
Runtime inspection includes optional `recovery: {owner}` only when requested with
`include_recovery=true`; older clients keep the previous response shape. The target
is recorded evidence, not proof recovery is available. CLI/MCP gate on 28.15.

Optional owner `recovery: 1` accepts private launch `recovery` provenance: source
identity, source/current boot UUIDs, bounded ancestor identities and a SHA256 seed
digest. A verified later boot and existing retirement/state/revision claims fence
the source; its permanent retired record is preserved. Migration **51** records one
successor and ends predecessor resources atomically with replacement preparation.
The new owner verifies the pristine copied ledger before opening it and interrupts
in-flight scripts before scheduler construction. Pending roots, captured revisions,
trigger cursors, budgets and receipts survive. Historical operations retain their
original callers and are observation-only through descendants. No agent runtime
protocol or ledger format bump is needed. Application 28.16 adds explicit auto-start
as described above. Application 28.18 adds explicit Linux same-boot recovery;
automatic Linux recovery follows in 28.19; native platform acceptance remains unfinished.

Application **28.14** adds `resume-agent`/`restart-agent` source templates and an
optional component `lifecycle: "resume" | "restart"` declaration. The declared
session binding captures conversation/account/provider/mode/worktree and the exact
outgoing runtime for restart. These graphs require optional owner `lifecycle: 1`,
which depends on operations-2 and spawns-1. Older graphs/agent owners are unchanged.
Private `lifecycle-page`, `lifecycle-claim`, `lifecycle-settle` and
`lifecycle-unavailable` messages share the existing bounded authenticated owner
transport and daemon dispatch queue. Worker `resume`/`restart` operations carry a
declared reference; standalone puddlang runners reject these operations for now.

Migration **50** retains host lifecycle intent, restart impact review, replacement
runtime and readiness outcome. Existing runtime preparation atomically binds the
new owner before launch; only a fresh owner claim may call the ordinary session
resume/restart service. Retained outcomes bind the original scope, request and
agent handle by receipt. An unlaunched lifecycle attempt suppresses boot auto-resume
for its original placement until a separate explicit launch changes ownership.
Uncertain calls are observation-only; they never restart
or resume again. Lifecycle results permit same-execution handle use without
spawn-cleanup ownership. The existing private ledger/caller-origin formats and
agent runtime protocol remain unchanged.

Huddle ask/spawn intent now has an additive owner-private `operation-origins`
collection in the existing ledger-1 generic records table. Format-1 rows retain
caller `RuntimeIdentity` plus invocation id under the operation key and execution
parent. They commit atomically with intent and share existing byte/count bounds.
No public/owner message, capability, schema version or `operations` row shape
changes; older readers ignore the separate collection. Legacy rows are not
backfilled during ordinary operation and continue to use their original immutable
launch identity. Explicit 28.15 recovery derives missing legacy origins only from
the verified source launch. Provenance alone never authorises replacement.

Application **28.13** adds local/SSH read-only `POST
/api/huddle/:profile/sessions/:sid/revision/retained`. Input is
`{owner, revision?, expected_digest?, entry?}`. `owner` names the exact recorded
runtime/incarnation. Without `revision`, inspect the last recorded activation;
with an explicit digest, inspect that immutable retained source bundle. Historical
source does not imply particular activation settings: the response's `activation`
is null when a digest was supplied. Optional `entry` selects exact file/contract
text; optional `expected_digest` compares with that exact saved source capture.

The response is `{source: "retained-revision", observed_at, owner, revision,
activation, saved, entries, content?}`. Activation uses the existing deliberate
public projection. Entries/content reuse the bounded revision-review shape;
recorded data is not a live control target or Apply authority. No owner contact,
execution, replay, directory creation or migration occurs. Identity/launch checks
and immutable bundle digest validation precede inspection; last-activation reads
also verify ledger identity through the 28.12 snapshot reader. History/review share
the existing one-workspace/eight-request limit. Saved comparison retains repository
locking and authority/placement rechecks. Missing project source still permits
retained-only reads. A supporting daemon remains necessary.

CLI `retained-revision` and read-only MCP `huddle_retained_revision` gate on 28.13
and verify owner/revision/saved digest/entry correspondence. History offers Recorded
activation and Execution source, sharing the read-only source viewer. Selected
source requests pin the returned revision instead of following a later activation.
Recorded views do not offer Apply or retry a failed read automatically. Existing
live revision/diff APIs and all runtime, ledger and database versions are unchanged.

Application **28.12** adds local/SSH read-only POST
`/api/huddle/:profile/sessions/:sid/history/owners` and `/history/retained`.
The owner catalogue takes `{after?: {created_at, runtime_id}}` and returns
`{source: "recorded-bindings", records, next}` with at most 64 newest-first
recorded runtime identities/builds/states/timestamps. The cursor orders timestamp
and runtime id together; these states are not live owner evidence.

Retained pages take the existing exact `owner`, `collection`, `after` and required
execution `parent`, without `include_readout_observation`. They return
`{source: "retained-ledger", observed_at, history}`; history uses the existing
bounded public record projection and cursor. Reads work with a stopped or
unconnected owner and missing project source, while the supporting daemon is
available. They never connect/start/reconcile an owner, invoke a readout or change
an execution outcome. Existing live `/history` semantics are unchanged.

The controller rechecks profile/placement authority and binds private launch and
ledger identity to the exact recorded runtime/incarnation. History and revision
reads share one workspace with at most eight queued/active requests. Snapshot
readers never open the original with SQLite: stable main/WAL copies use private
scratch, and a checkpointed main file uses an immutable in-memory copy. Bounds are
128 MiB main, 256 MiB WAL and the existing 256-row/1 MiB history page; actual SQL
body sizes are checked before materialisation. Missing/changed/unsupported state
fails without creation, migrations, retry or owner recovery. Scratch is removed
on normal success/failure; crash-orphaned OS temporary files remain a resource
acceptance consideration. No owner protocol, ledger or application database
migration is added.

CLI `pudl huddle history-owners|retained-history SESSION_ID --request JSON` and MCP
`huddle_history_owners`/`huddle_retained_history` require 28.12. They are read-only
and verify exact owner/collection/page correspondence. The IDE's History action
opens recorded runtimes when no connected owner is available; live history offers
Recorded runtimes navigation. Recorded views label provenance/read time, do not
poll copied ledgers or clear uncertain-command review, and expose no readout
reconciliation controls. Older hosts retain connected-owner history.

Application **28.11** adds local/SSH `GET/PUT
/api/huddle/:profile/definitions/:id/source`. GET takes the existing explicit
project/worktree query and returns `{document, files}` from one verified capture;
files map relative source paths to exact UTF-8 text, including referenced scripts.
PUT takes `{project_id, worktree, expected_digest, edit: {file, content}}`, with
file restricted to `huddle.json` or `layout.json`. Strict current JSON validation
does not reserialize content: whitespace, CRLF, key order, Unicode and omitted
defaults remain as submitted. Unknown/future document fields and lossy Unicode
are rejected. JSON documents must have no BOM; script BOMs remain captured bytes.

Source limits remain 128 files, 256 KiB per file and 4 MiB per closure. The source
PUT body permits JSON escaping overhead (six times the per-file limit plus 16 KiB),
while decoded text retains the ordinary byte bound. Both old structured saves and
new text saves share the repository lock, registered worktree/profile authority,
whole-capture digest comparison, storage admission and final synchronous source
rechecks before publication. Each save changes one file. The reply is a fresh
observed capture after publication; failed observation/lost replies never imply
that nothing was saved, and may not be retried automatically. Reads and saves
need no owner or supporting installed runtime and never evaluate/activate code.

CLI `pudl huddle source|save-source HUDDLE_ID --project ID --worktree ABSOLUTE`
and MCP `huddle_source`/`huddle_save_source` require 28.11. Save-source additionally
takes `--request JSON` with exactly `expected_digest` and `edit`; MCP includes the
explicit location/id in its strict arguments. Clients verify source/document
identity and SHA-256 using the unchanged canonical revision encoding, and a save
reply must contain exactly the submitted file text. Stale, mismatched or uncertain
replies trigger no lookup/retry/fresh digest substitution. Old document routes and
response shapes remain unchanged. No runtime, remote, database, owner or ledger
version changes. The IDE now selects this transport for manifest/layout buffers
on supporting local/SSH hosts. Optional private `DesktopBufferSnapshot.baseRevision`
contains format-1 scoped identity, digest and per-file/contract hashes; malformed
or unknown metadata is discarded without discarding text. Missing metadata
requires explicit source review before a guarded save. The native format remains
4; older shells may omit the field and thereby require review after restoration.
No metadata is source or execution authority. Ordinary older-host file saves
remain available, but captured drafts cannot silently downgrade to them.

Client-local `pudl huddle authoring [asset-path]` and stdio MCP `huddle_authoring`
now list/read the bundled authoring kit. MCP takes strict `{path?: string}`;
an exact inventory name selects a schema, declaration, template or fixture.
Replies label `format: 1`, `application` (the bundled client protocol), and
`source: "bundled-client"`, plus `files: [{path, bytes}]` or `{path, content}`.
The CLI performs no connection setup; MCP reads require no host capability and
perform no host calls. Source validation/activation remain separate. No HTTP/WS,
application/runtime/remote protocol, database or owner-ledger format changes.

Application **28.10** adds local/SSH read-only
`POST /api/huddle/:profile/sessions/:sid/revision` and `/diff`.
Both take an exact `target`; diff additionally requires `expected_digest` from
saved-source inspection. Optional `entry: {kind: 'file' | 'component', path}`
selects one retained source file or resolved node contract. The response projects
`target`, `active: {id, revision, worktree, variables, bindings, appliedAt}`,
`saved: {digest, diagnostics} | null`, and a bounded `entries` inventory with
before/after SHA-256/byte counts and retained/unchanged/added/removed/modified status.
Optional `content` contains the selected entry's before/after text (null for an
absent side). Source bytes stay exact; resolved contracts use canonical JSON.
No modules execute, revisions publish, source saves or activation occur.

The controller verifies a bounded read-only snapshot of existing ledger-1 identity,
control and activation records, then reads the verified retained revision. It
creates no ledger/revision directories and performs no migrations. One review
workspace runs at a time, with at most eight pending reviews. Saved capture uses
the existing registered worktree/repository lock; authority and the full owner
control target are rechecked after asynchronous work. Source deletion does not
block retained-only inspection. Stopped/disconnected owners remain unavailable.
Inventory size is bounded by both source closures; selected text cannot exceed
the existing 32 MiB retained record bound (ordinary source files remain 256 KiB).

CLI `pudl huddle revision|diff SESSION_ID --request JSON` and MCP
`huddle_revision|huddle_diff` (`{session_id, request}`) gate at 28.10 and advertise
read-only behaviour. Clients reject substituted targets/digests/selected entries.
The IDE gates Active revision and Apply comparison at the same floor, preserving
older hosts' existing Apply flow. Existing runtime inspection shapes and all
ordinary runtime (1.2), remote (5), database (49), owner and ledger versions remain
unchanged; no new owner capability is required.

CLI/MCP placement tools now expose `huddle_session`, `huddle_archive` and
`huddle_unarchive` with strict `{session_id}` arguments under
`api/huddle/tools/placement.ts`. The CLI spelling is `pudl huddle
session|archive|unarchive SESSION_ID`. They require the existing 28.2 feature floor.
The client first verifies the huddle kind and selected profile through the scoped
runtime inspection route, then uses existing ordinary session GET/archive/unarchive
routes under the same local/SSH authority. Archive targets the placement's current
owner through normal session lifecycle; it does not promise exact-incarnation
semantics. Unarchive returns stopped. Mutations are never retried automatically.
This additive stdio catalogue changes no HTTP/WS, application/runtime/remote,
database or owner-ledger version.

CLI/MCP now also expose inactive huddle create/open and the existing runtime,
Start/Apply/Run/Interrupt/Resume/Stop/history/readout-observation controls. Shared
tool contracts live under `api/huddle/tools/{source,execution,placement}.ts`; MCP execution
arguments contain explicit `session_id` and `request`, matching the current HTTP
body. Runtime inspection takes only the session id. Source/placement tools use
the 27.1 feature floor; core execution requires 28.2, readout observation requires
28.6, and custom-trigger inspection opts in only on 28.7+. Resume maps to `rearm`.
Tool metadata describes JSON values while actual dispatch retains the existing
bounded JSON custom validator. No HTTP/WS schemas, application/runtime/remote
versions, database or ledger formats change. Tools never infer a newer target,
generate a replacement event id or retry an uncertain mutation.

The CLI now exposes huddle source discovery/inspection/validation through
`pudl huddle list|inspect|validate` and additive stdio MCP tools
`huddle_list`, `huddle_inspect`, `huddle_validate`. Their shared strict arguments
live in `api/huddle/tools/`: explicit project id, absolute host worktree and
huddle id for inspect/validate. Validation projects the existing document's
digest/diagnostics to `{valid, digest, diagnostics}`; it is not runtime admission.
The selected local/SSH authority/profile and existing inactive GET routes are
reused. Capability gating requires a compatible current-major daemon and the
existing 27.1 feature floor. No application HTTP/WS, runtime, remote, database or
ledger version changes are introduced; the stdio tool catalogue is additive.

Application **28.9** adds `prompt-spawned-agent` and `review-spawned-agent` to the
existing local component-template request. Optional input `scope: "execution"`
declares one immutable retained delivery per execution/node/port. Omitted scope
and explicit `activation` preserve ordinary join matching. Outputs cannot declare
scope. Execution inputs must be required on an `all` component that also has a
normal required input, and cannot be feedback destinations.

Optional runtime/daemon `executionInputs: 1` gates launch, Apply, owner admission
and adoption. Default metadata advertises it; older owners keep their existing
graphs but reject the new contract before activation. Private `execution-inputs`
ledger rows retain the exact delivery/value; pinning and readiness fan-out are
atomic with emission acknowledgement. No IPC command or public response addition
is needed. Template UI requires 28.9; existing template gates remain unchanged.
Database 49, ordinary runtime 1.2, remote 5 and huddle owner/ledger versions remain
unchanged. The private ledger's existing generic collection storage needs no schema
migration; the capability prevents an older controller adopting the new owner.

Application **28.8** adds `spawn-agent` to local/SSH component-template requests.
The UI gates this option on 28.8 while retaining Prompt/Review on 28.3. Response
shapes are unchanged. Runtime/daemon metadata now advertises optional `spawns: 1`
with `operations: 2`; older owners remain supported without spawn operations.
Private cleanup state additionally admits `released`, derived only from an
execution’s captured `retain-owned` policy. It is not host exit evidence and
cannot be supplied as a cleanup settlement outcome. Database 49, ordinary runtime
1.2, remote 5 and huddle owner/ledger versions are unchanged.

Private owner IPC now carries the bounded spawn outbox contracts through separate
`spawn-page`, `spawn-claim`, `spawn-settle` and `spawn-unavailable` commands and
`spawn-page`, `spawn-claim`, `spawn-settled` replies. Spawn pages also carry separate
retained/pending/confirmed/released cleanup state. `spawn-cleanup-settle` accepts exact
unadmitted/unlaunched/stopped evidence and replies `spawn-cleaned`;
`spawn-cleanup-unavailable` retains a bounded failure without clearing intent.
These extend the spawn contract. Existing ask schemas are unchanged.
Both client and owner require optional `spawns: 1`, which requires `operations: 2`.
This contract is now advertised in default runtime/daemon metadata. Lifecycle cleanup is now connected through
the retained owner ledger and exact host stop service. Start/Apply resolve explicit
account/provider/project resources and canonical registered worktrees, rechecking
admission after asynchronous work. Graphs declaring these resource editors require
the spawn capability at host and independent owner admission; ordinary scripts and
existing ask bindings keep their original requirements. The daemon
now composes automatic host dispatch under this gate. Unsupported owners are rejected locally before writing a spawn
command; the owner independently checks its launch capability. Existing strict
older-owner state/launch shapes remain unchanged when the optional capability is
absent. The original private transport added no public HTTP/WS message. Application 28.8
adds the template request above; ordinary runtime 1.2, remote 5,
database 49 and huddle owner/ledger versions remain unchanged.

Database **49** adds retained huddle spawn readiness outcomes (bounded to 32 KiB)
and consumed cleanup attempts. The internal `huddleSpawnOutcomeSchema` binds an
exact agent target and receipt. These records support host observation after lost
replies. They now also participate in the gated private owner protocol above;
there was no public HTTP addition in that slice. Spawn rollout is described above.

Database **48** adds private host huddle spawn mappings. Internal
`runtime/huddle/operations/spawns.ts` defines exact owner/execution/invocation
scope and resolved creation settings for the host admission foundation. These
schemas now also participate in the gated private owner protocol above. The
original admission slice changed no wire shapes. The automatic dispatcher is now
composed alongside resource admission, lifecycle cleanup and the 28.8 template rollout.
Selected-daemon database compatibility uses the existing migration-version gate.

Application **28.7** adds optional local trigger manifest policy
`trigger: { resume: 'continue' | 'fresh' }`, required for local trigger entries.
Optional huddle role capability `customTriggers: 1` gates launch/Apply/adoption.
`GET /api/huddle/:profile/sessions/:sid/runtime?include_custom_triggers=true`
opts into `owner.custom_triggers` on supporting connected owners: at most eight
node/health entries, with messages but no private cursor. Omit the field unless
requested, preserving older strict clients and ordinary mutation response shapes.
The UI requires application 28.7 before requesting it.

Private worker transport adds `subscribe` jobs (captured closure, subscription id,
parameters/bindings and cursor), `opened` readiness, and acknowledged `trigger-emit`,
`trigger-checkpoint` and `trigger-health` calls. Subscription requests carry a
monotonic safe-integer sequence; bounded pending/rate windows replace the ordinary
script lifetime request-id set. Startup remains bounded; readiness clears that
deadline. Ordinary script/readout request bounds remain unchanged. Eight private
ledger source slots retain cursor, health and exact activation/generation. Emission
commits source progress with event/root admission, preserving deduplication after
lost acknowledgement. Interrupt/Stop/Apply fence callbacks and wait for worker exit.
A source failure is isolated; unknown termination/persistence prevents clean owner
retirement. Optional owner-state `customTriggers` contains only public health.
Application API additions are opt-in; ordinary runtime protocol 1.2, remote protocol
5, database 47 and huddle owner/ledger versions are unchanged. Old huddle owners
remain supported but cannot execute graphs requiring custom subscriptions.

Application **28.6** adds local/SSH
`POST /api/huddle/:profile/sessions/:sid/readouts/observe`, binding a reviewed owner,
activation/generation and operation id. The response acknowledges acceptance only.
Optional `readout_observation: true` on connected runtime inspection and eligible
unknown operation history enables the history action. An older runtime remains
inspectable and executable without this action. Emit these additions only when
the caller opts in with `include_readout_observation=true` on the runtime query or
`include_readout_observation: true` in the history request; older strict response
readers retain their previous shapes. Optional private capability
`readoutObservation: 1` requires `readouts: 1` and gates `readout-observe`; ordinary
agent/terminal IPC, remote protocol 5, database 47 and huddle owner/ledger versions
are unchanged.

Observation uses the operation's retained revision, activation, envelope and
declared `observe` method. It shares worker concurrency/memory admission, has a
30-second deadline, and participates in Interrupt/Stop and positive-exit fencing.
Only consumed unknown readouts in ended executions are eligible. No agent operation,
event emission, delivery resend or graph continuation is permitted through this
path. A known receipt survives lost acknowledgements. Lost command replies are
observation-only; neither reconnect nor history refresh schedules another worker.
Subsequent inconclusive observations require another explicit command. No offline
owner reconciliation or automatic owner-crash recovery is introduced.

Application **28.5** adds optional `readout` delivery declarations to local huddle
component manifests: idempotency support, `none|observe` reconciliation and
`none|signal` cancellation. Local readout entries must declare these fields;
existing script and built-in contracts are unchanged. Optional private huddle
capability `readouts: 1` gates launch/Apply and daemon adoption. Existing agent/terminal
IPC, remote protocol 5, database 47 and huddle owner/ledger versions are unchanged.

The previously unused delivery SDK envelope now contains the complete named
`inputs` map instead of a single `port/data` pair, preserving joined input ports.
It retains the root event, source port, scope, revision, invocation and idempotency
key. Delivery results may include completion `outputs` only with `delivered`.
This draft SDK change does not replace a previously sent application message.
Private worker jobs optionally carry the exact delivery and `deliver|observe` mode;
`readout-result` requests record outcomes before acknowledging the worker. A single
consumed `readout` operation precedes source evaluation. Unknown/failed outcomes
cannot publish completion outputs. Confirmed delivery and worker exit remain
separate evidence; no automatic delivery retry or completed-script replay exists.
Explicit owner/API reconciliation is available through application 28.6 above.

Private agent/terminal runtime protocol **1.2** adds a separate `native-turns`
read request/response, optional `state.native_turns` source status and optional
`agent.native_turn_events: 1` availability. Inspect both protocol and provider
availability before subscribing; an older owner or an unsupported adapter is not
upgraded or replaced automatically. The ordinary event union, acknowledgement
stream and launch seed are unchanged. Older controllers ignore the added fields
and never receive unsolicited new event kinds. Application 28.4, remote protocol 5,
database 47 and huddle owner/ledger contracts are unchanged.

Native observations use `runtime/native-turns.ts`: exact conversation and correlated
turn identity, segment id, currently bound placement (nullable before adoption),
owner observation timestamp, event/outcome and attribution. `start-turn.origin` is
optional huddle/execution/operation causation supplied by the trusted host caller
only for supporting runtime protocols. The accepted ask passes immutable context
into its adapter; completion/cancellation cannot borrow a later ask's identity.
External observations carry no automated context. Missing automation context is
explicitly unknown.

The owner retains at most 128 observations and 2 MiB in its private
`native-turns.json`, independently of ordinary event acknowledgement. Each source
has an epoch, monotonic head and conservative loss floor; pages contain at most
16 observations and 2 MiB. Null establishes a baseline. Epoch/retention/ahead gaps
are explicit, as is pending persistence. Memory/disk failures do not terminate an
unrelated agent PTY. Clients must not admit pending or gap pages as complete history.
The hook-based interactive control reports started/completed/failed/interrupted
observations, matching exact native turn ids and prompt hashes for automated asks.
Unmatched completion proves a gap unless a terminal observation is still retained.
Late acknowledgement of an already-ended ask retains its origin and reports
interruption. Exhausted retired attribution reports a gap and unknown origin;
it cannot reclassify a delayed automated prompt as external input.
Headless adapters use `command:<uuid>` turn keys from the exact private command
invocation; these are correlation keys, not claimed provider-issued turn ids.
Native identity must bind before publishing observations, and successful completion
requires both the bounded native result and exit 0. All headless invocations are
automated; missing caller context remains unknown. Cancellation, binding loss and
source memory refusal cannot become successful external-input events. This uses
the existing optional availability field without another protocol version change.
Interactive Codex owners now observe exact native turn ids on their existing
structured connection. Correlation waits for the matching injected RPC response;
cancelled/unanswered asks cannot become external input. Source buffers are bounded
separately from essential asks, with gaps and unknown attribution on loss. Trusted
in-process identity delivery preserves event/segment ordering inside native batches;
legacy loopback delivery remains available but does not advertise this observation path.
Automatic huddle completion-node delivery is implemented below; native-provider
acceptance remains pending.

Internal huddle completion subscription schemas now live in
`runtime/huddle/triggers/completions.ts`. Eight sources pin exact runtime identity,
selected session, native segment/conversation, activation/generation and cursor.
The owner ledger core admits only contiguous durable pages and external successful
completions, atomically with cursor advancement. Automated/unknown outcomes do not
start new executions. Optional `completionEvents: 1` now gates private
`completion-sources`, `completion-events` and `completion-unavailable` messages,
plus optional `completionBaselines` on Arm/Apply. Old owners remain supported and
must not receive these messages/fields. Baselines are checked before intent changes;
deliveries bind the complete retained source, including cursor. Stale replies cannot
fail a newer subscription. Private source replies are bounded to eight entries,
pages retain native limits, and gaps/pending persistence are never admitted.
Optional `completionPlans: 1` separately gates private read-only `completion-plan`.
The request can include a proposed Apply activation; otherwise it reads the current
retained activation, including while interrupted. Its bounded response identifies
generation/activation/revision and at most eight explicit node/session/worktree
selections. Host controls capture durable native baselines only after queued review,
rechecking target and caller authority after reads and immediately before dispatch.
Older completion-event owners receive no new plan request. The component is now
in the public creation catalogue. Host launch/Apply requires both capabilities;
existing event-only owners keep their supported private protocol. Automatic
delivery reads retained owner cursors and retries transient observation failures
without rebasing. The editor exposes explicit worktree/live-agent settings. Existing
application/runtime/remote and huddle owner/ledger versions remain unchanged.

Database **47** retains bounded host session observations. Optional private huddle
capability **`sessionEvents: 1`** enables `puddle.trigger.session@1`. Existing owners
without it remain supported; older candidates cannot adopt owners requiring it.
Shared cursor/page/record schemas live in `runtime/huddle/triggers/session-feed.ts`,
source/settings schemas in `triggers/sessions.ts`. Application 28.4, ordinary runtime
1.1 and huddle ledger format 1 remain unchanged; no new public route is added.
Existing host compatibility inspection also requires database-47 support.

The stream retains a random epoch, monotonic head and conservative loss floor.
Placement/status/audit observations commit with their source writes, retain exact
observed scope and omit arbitrary audit payloads. Explicit baseline reads do not
replay history; epoch mismatch, expired retention and ahead cursors report gaps.
Rows are bounded to 8 KiB and 4,096 sequence positions; pages to 64 rows and 128 KiB.
Readers must supply previously authorised profile/project/worktree scope. Status
observations are not exact native turn completions. The separate native source above
supplies the Turn completed trigger.

Private `session-sources`, `session-events` and `session-unavailable` messages are
gated on the capability. Up to eight `session-sources` ledger slots retain exact
node/revision/activation/generation, scope, status filters and cursor. Every page
and all its admitted executions commit together. Page requests bind the entire
retained source, including its cursor; stale deliveries reject without failing a
new activation. Genuine feed gaps fail the owner rather than silently resetting.
Arm and Apply accept an optional private `feedBaseline`, captured by host controls
after queued review. Session graphs require it before arming; older owners receive
no added field. Resume and armed Apply start fresh, while controller reconnect
continues retained progress. Delivery checks owner/profile/project/worktree scope,
excludes huddle observations and drains with host maintenance. A lost acknowledgement
requires re-reading owner cursors before subsequent delivery.

Optional private huddle capability **`git: 1`** enables `puddle.trigger.git@1`.
Launch/Apply and independent-owner validation require it; old owners remain
supported, while old candidates cannot adopt owners requiring it. Application
28.4, ordinary runtime 1.1, ledger format 1 and database schema 46 are unchanged.
The node uses existing explicit worktree bindings and event/parameter contracts.

Eight reusable private `git-sources` slots retain exact node/activation/generation,
canonical repository/common-directory identity, baseline/pending observations and
batch progress. Up to 64 ref changes carry old/new OIDs and symbolic targets,
with a worktree resource and no invented occurrence timestamp. Event/cursor/batch
progress commit together, advancing the baseline only after the final batch.
Start/Resume/armed Apply establish fresh baselines. Common-directory reads/watches
are shared across linked worktrees; worktree HEAD remains distinct. Cancellation
retains subprocess ownership through close and scan capacity through settlement.
This does not add a public command, remote authority or automatic crash recovery.

Optional private huddle capability **`filetree: 1`** enables
`puddle.trigger.filetree@1`. Older owners remain supported; selected runtime
launch/Apply and independent-owner validation require the capability before
observing files. Older daemon candidates cannot adopt owners requiring it.
Application 28.4, ordinary runtime 1.1, ledger format 1 and database schema 46
remain unchanged. The component uses existing worktree parameters and event shapes.

The owner ledger keeps at most eight reusable `filetrees` slots, each with exact
node/activation/generation, canonical worktree, bounded baseline/pending snapshots
and admission progress. Events carry a worktree resource and up to 64 regular-file
net changes; no exact filesystem occurrence time is invented. Batch cursor progress
commits with admission and the baseline advances after the last batch. Refusal
retains pending changes. Initial arming, Resume and armed Apply establish a fresh
baseline rather than replay paused activity. Cancellation fences async scans before
ledger access; clean owner shutdown requires their settlement. These records do
not add automatic owner-crash/reboot recovery or a public health/history command.

Optional private huddle capability **`calendar: 1`** enables the version-1
`puddle.trigger.calendar` and `puddle.trigger.date` built-ins. Older owners without
this capability remain supported; older candidates cannot adopt owners requiring
it. Launch/Apply and independent owner validation check the exact capability.
Application 28.4, ordinary runtime 1.1, ledger format 1 and database schema 46 are
unchanged. Components use existing parameter/event shapes; no public message changes.

The bounded `schedules/current` ledger record holds calendar progress and one-off
pending/admitted/skipped disposition. Admission, source cursor and schedule progress
commit together. Event identity includes source, activation and scheduled instant;
it excludes control generation so Resume cannot replay a consumed occurrence.
Calendar Resume excludes paused time without moving progress backwards. One-offs
retain consumption within an activation. New Apply/Start intent creates a fresh
activation and can fire a past one-off again. Calendar conversion uses an explicit
IANA timezone, skips missing civil times and selects the earlier repeated time;
coalesce/skip/catch-up count actual instants. Observation gaps over 366 days block
until explicit lifecycle recovery. These records do not enable automatic reboot
or owner-crash recovery.

Optional private huddle capability **`timers: 1`** enables the version-1
`puddle.trigger.interval` built-in. Launch/Apply and owner validation require this
capability before arming interval graphs. Existing owners without timers remain
supported; daemon adoption metadata must cover every retained owner capability.
Ordinary agent/terminal runtime 1.1 and application 28.4 are unchanged: this adds
no REST/WS field or command. The built-in uses existing component/parameter shapes.

The owner ledger retains one bounded `intervals/current` record under ledger
format 1. Schedule generation, anchor and occurrence progress are written with
normal durable admission; advancing a timer and admitting its event are atomic.
Arming after interruption and applying a revision start new schedule anchors.
Trigger missed-occurrence policies are distinct from the graph queue policy,
which currently still requires `queue`. Owner/controller loss is not permission
to replay an admitted occurrence or resume an arbitrary script body.

Application **28.4** reserves `expected_mtime_ms: -1` on the existing worktree-file
PUT for exclusive creation of an absent file. The host uses `wx`; an existing file
or symlink returns `409 stale_file` without replacement. Other conditional and
unconditional saves retain their existing semantics. Frontends must check 28.4
before requesting absent-file creation; older hosts reject a missing-file
conditional write. No message shape, runtime contract or database change is made.

The IDE now treats an absent `.puddle/huddle/<id>/layout.json` as a clean virtual
layout only after reading a valid sibling definition. Its draft baseline is -1;
opening does not publish files. Huddle tabs hold both manifest and layout buffers
for dirty review, recovery and transfer. Layout/source saves remain independent
file writes, not a multi-file transaction. Graph movement uses shared editor drafts
and separate layout undo, with pointer cancellation and layout-version checks.

Application **28.3** adds local/SSH
`POST /api/huddle/:profile/definitions/:id/components`. Its strict body contains
`project_id`, `worktree`, `template` (`prompt-agent` or `review-agent`) and a
`component` directory key. It returns `{ manifest, component }` after materialising
ordinary `node.json`, `run.ts` and `prompt.ts` files in that huddle's
`nodes/<component>/`. The request uses existing project/worktree authority and
storage admission; remote profile leases remain denied. Identical existing files
may be retained and missing files filled; different existing source is never
overwritten. Publication is separate from graph editing and activation. A lost
reply requires source inspection; clients never automatically retry. Partial
publication can leave unreferenced source files. The editor resolves saved local
contracts through existing worktree file reads. Agent templates use the existing
`operations: 2` execution capability; no runtime contract, database migration or
remote protocol change accompanies this application addition.

Application **28.2** adds local/SSH huddle execution under
`/api/huddle/:profile/sessions/:sid`: GET `runtime`; POST `start`, `apply`, `rearm`,
`run`, `interrupt`, `stop` and `history`. The placement supplies its immutable
project/worktree/definition scope. Start accepts an inspected `expected_digest`
and explicit `variables`, captures saved source, launches one capable owner and
arms it without sending input. Apply additionally requires the inspected owner,
incarnation, generation and activation id. Rearm, Run, Interrupt and Stop require
that same target; Run also carries a caller-generated UUID `event_id`, node id
and explicit JSON data. Reconnection never authorises automatic mutation retries.
Start after uncertain launch/arming must first inspect the retained owner.

History is a bounded read submitted with POST: select one runtime/incarnation,
collection and ordinal cursor, with an execution id required for invocation and
operation records. Refresh earlier pages for mutable outcomes. Explicit public
projections omit private owner identity/launch data and operation inputs/targets.
Disconnected owners have no actionable target or invented lifecycle state.
Schemas live in `api/huddle/execution.ts`; clients feature-detect 28.2. The IDE
execution UI now uses these APIs; stopped-owner history and active-revision detail
remain pending.
Manual input, local scripts and result readouts are executable. Supporting owners
now also accept declared session bindings for attach/ask scripts; unsupported
selectors and external adapters are rejected before launch. Existing owners
remain usable if the selected default loses huddle support. Remote profile leases
and the connector still deny all huddle routes. Ordinary runtime 1.1, private
huddle contracts, database schema and remote protocol 5 are unchanged.

Private database migration **45** adds host-side huddle caller/agent-turn mappings
and exact owner-result receipts. The internal dispatcher shares ordinary agent
runtime 1.1 without new agent IPC or public routes. Release capability metadata
advertises the new database requirement through the existing schema boundary.

The optional private huddle **`operations: 1`** capability introduced
`operation-page`, `operation-claim` and `operation-settle` in owner contract 1.
Pages bound agent-operation scope, request, state and outcome to 16 records/1 MiB.
Claims consume intent before external dispatch and never grant a second send.
Settlement stores the exact terminal result/receipt before confirmation; lost
replies require observation. Legacy owners without this capability retain their
original metadata and refuse these commands; adoption metadata must cover every
required capability. Shared contracts live in `runtime/huddle/operations/`.
Puddlang attach references now accept 4,096 characters for resolved huddle agent
bindings; references alone grant no authority. Application, ordinary runtime,
and ledger versions are unchanged.

Private huddle **`operations: 2`** adds `operation-unavailable` with exact scope,
a bounded error and an explicit positively-unsent flag. An unsent operation stores
`{ rejected: string }` as a failed outcome; uncertain sends retain unknown state
and fail the waiting node. Automatic host dispatch and agent-capable Start/Apply
require capability 2. New daemons adopt capability 1 and legacy owners too; older
candidates cannot adopt capability-2 owners. Migration **46** retains one exact
cancellation attempt per huddle agent turn. Production dispatch shares ordinary
puddlang busy admission, drains through host maintenance and preserves admitted
turns on daemon shutdown. No new public route or ordinary agent IPC is added.

Application **28.1** adds local/SSH `PUT /api/huddle/:profile/definitions/:id`.
The body contains an explicit project/worktree, `expected_digest` from inspection,
and one `edit`: `{ file: 'huddle.json' | 'layout.json', value: <matching document> }`.
The directory id comes from the route and cannot change. A stale captured source
returns `409 huddle_source_changed`; successful saves return the observed document
and diagnostics. Each request publishes one file, never an activation. Inspect
after an uncertain reply; do not retry using a substituted digest. Clients must
feature-detect 28.1. Existing read/create/open shapes, runtime contracts, desktop
format and remote access remain unchanged.

Application **28.0** adds `huddle` to the closed workspace tab union. Frontend and
daemon must upgrade together; existing session kinds and ordinary runtime 1.1
remain unchanged. Huddle tabs bind a placement UUID, have their own layout/native
identity and never attach a PTY. Sidebar creation uses the existing 27.1 inactive
authoring API. Desktop recovery format **4** migrates versions 2 and 3; old readers
reject it. The optional private `windows.huddles` capability gates opening and
working-set writes, including seeds with parked huddle tabs. Named layout envelopes
remain unchanged, with their tab content governed by application 28. No runtime
execution or remote-operation contract changes in this increment.

Application **27.1** adds local/SSH inactive huddle authoring under
`/api/huddle/:profile`: GET availability, GET definitions and individual captured
documents, POST definitions and POST open. Creation requires an explicit registered
project/worktree and capable installed runtime. It saves a random-id blank graph
and stopped placement without launching or arming an owner. Repeated open returns
one placement; creation is not automatically retried after a lost reply. Read-only
inspection and existing-placement opens remain available with an unsupported
runtime default. Inputs and replies are defined in `api/huddle/authoring.ts`.
Remote profile access is denied; remote/runtime protocols and database schema are
unchanged. Frontends must feature-detect 27.1 before using these routes.

Application **27.0** adds `huddle` to the closed session-kind enum and an optional
`huddle_id` definition identity on session projections. Old clients cannot safely
interpret that kind, so frontend and daemon require a coordinated major update.
Migration 43 retains one huddle placement per project/canonical worktree/definition
and records huddle owners in the common runtime inventory without terminal segments.
The existing create-session request still accepts only agent/terminal kinds;
huddle creation uses its separate 27.1 routes; public Start/Run remain pending.
Independent-owner adoption, lifecycle controls and host maintenance integration are tracked in
[huddle acceptance](../../docs/acceptance/huddle.md).
Agent/terminal runtime protocol 1.1 and remote transport protocol 5 are unchanged.

Application **26.23** names the UI frontend throughout current application code.
Private host-update inspect/apply commands accept canonical `frontend` version
fields and normalize the historical `cockpit` spelling on receipt. Mixed spellings
remain invalid. New clients retain the historical spelling on the private wire
so existing hosts can process exactly one request without retry or fallback.
The frontend gateway serves `/frontend/*` and retains authenticated legacy route
aliases for already-running clients. Authority and remote framing are unchanged.
Release manifests separately use format 2 with a `frontend` component; readers
normalize historical format 1, and publishers retain a format 1 compatibility asset.

Application **26.22** adds private native pane-close review dispatch and optional
`closeReviewedPane` completion. User review does not hold a command reply open.
Only a registered same-origin pane main frame can request completion; main still
checkpoints and rejects closure while dirty buffers or untitled tabs remain.
App-wide quit cancels pending review and preserves the normal reopen arrangement.
No daemon/runtime/remote message or persistence format changes.

Application **26.21** adds optional private native host-effect ownership and
notification claims. Only registered same-origin main frames can use them; main
chooses eligible windows from their existing host connection. One window runs
automatic host-update offers/polling, preferring a host window and handing over
to a detached window when needed. One app-wide owner presents desktop-update
offers, retaining ordinary React-remount dismissal state. Attention events are
claimed once per host,
preferring its focused renderer so existing recent-interaction suppression still
applies. Claims are bounded and uncertain replies never authorise another sound
or notification. Legacy status-only events have a short duplicate-delivery window;
modern unique event ids remain consumed until bounded eviction. Notification
objects live with the host's window set and route clicks through a surviving
window, resolving the target project's actual profile, preferring an existing
detached session pane, then using normal native project routing. Older shells
omit the capability and keep existing behaviour.
No daemon/runtime/remote message or recovery format changes.

Application **26.20** adds optional private desktop layout apply/observation
capabilities and a bounded renderer planning command/reply. Only a host window
can apply a profile/project arrangement. Main matches logical slots within its
registered host/profile, seals live participants, requests structure/draft planning,
stages destinations and verifies every live participant before the atomic commit.
Operation ids are observed after lost replies, never blindly replayed. Failed
sealing/planning also records a cancellation. A new destination which acquired late
edits during cancellation remains as a durable recovery window. Layout mode belongs
to the restored native working set; applying it does not rewrite client preferences.
New seeds and explicit preference changes still use the existing conversion.
The named-layout popover now uses coordinated save/load.
Recovery format 3, saved arrangement version 1 and daemon/runtime/remote operations
are unchanged.

Application **26.19** adds private renderer arrangement commands to seal an
original working set, stage an exact prepared revision, verify the mounted
presentation and adopt its durable commit/cancellation. A separate optional
`stagingArrangement` context keeps prepared renderers fenced without entering
the two-window transfer acknowledgement flow. Readiness comes from the shared
Workspace/dashboard; a missing mount acknowledgement times out. Verification
releases models again before voting, rejecting late changes. The native apply
planner/coordinator and Layouts popover integration remain pending; these commands
alone cannot commit ownership or expose named window loading. No daemon,
runtime, remote operation or recovery-format change is added.

Application **26.18** adds an optional private desktop layout-capture capability
and revisioned multi-window transaction records. Only a registered host renderer
can capture its host/profile or project; live participants checkpoint together
and resume before the capture returns. Returned projects contribute their retained
snapshot without a live renderer. The reply omits draft buffers, native placement
and transport targets. Recovery state version 3 retains prepared arrangements and
bounded committed/cancelled outcomes beside existing pane handoffs; version 2
records migrate on read. Version-2 working-set readers reject version 3; do not
downgrade a shell over these records. Preparation leaves old ownership intact; restart cancels
uncommitted arrangements. Native apply and layout-menu integration remain pending.
No daemon, runtime or remote operation changes in this increment.

Application **26.17** adds optional version-1 `window_arrangement` data to saved
layouts and their existing create/patch requests. The descriptor contains logical
window slots and pane trees only; drafts, credentials and native placement remain
outside named records. New writers must gate this field on 26.17. Every saved
arrangement retains a single-tree fallback for browsers and older clients, whose
load never creates native windows. Renames preserve the arrangement; an explicit
tree overwrite without it replaces the row with an ordinary layout. Null on PATCH
also clears it. Migration 42 leaves existing rows as single-tree layouts. No new
route, runtime or remote operation is added. Native capture/apply integration is
still in progress; the additive storage contract alone does not expose that UI.

Application **26.16** adds optional private project drag registration, drop and
live return capabilities. A single-use offer binds the registered project window;
only a host window on the same host/profile can receive its source-directed move.
The renderer releases its models before final capture, and the existing handoff
commits destination content and source closure together. Lost replies never
authorise another move. Older shells omit these controls. No daemon, runtime or
remote operation changes.

Application **26.15** exposes optional private project-window prepare/focus/route
capabilities and bounded native open/navigation commands. Main resolves the
registered sender's host and unique project owner; renderers never choose a host
transport. Project close records a durable return, while Command-Q retains open
ownership. Ordinary navigation can consume returned state through the existing
handoff. Older shells omit the capability and retain local project navigation.
No daemon, runtime or remote operation changes.

Application **26.14** adds a private project merge-planning command and an optional
returned-project flag in desktop working-set records. A closed project's retained
revision can join the existing destination acknowledgement flow without a live
source renderer. These are preparatory internals: project menus, navigation and
native close integration are not yet exposed. No daemon, runtime or remote
operation changes. Older records omit the flag; pane/tab capabilities retain their
existing behaviour. Older shells must not be relied on to consume returned-project
records, although the workspace and draft fields remain readable.

Application **26.13** adds optional native file/session drag registration, source
commands and tab merge planning through the existing window handoff. A destination
may be a pane, project or host window on the same host/profile. Tab placements add
centre insertion with an optional index. Window-scoped companion drag payloads
keep filesystem moves, archive batches and sidebar reorder actions local; only
the registered tab offer can cross windows. No document text travels in drag data,
and no daemon, runtime or remote operation changes. Older shells omit tab transfer
capabilities and retain local drag behaviour.

Application **26.12** adds optional private native pane-drag registration and drop
capabilities. A short-lived, single-use offer binds the registered source, pane
and profile. Only a live destination on the same host/profile may request its
source-directed move command; a lost acknowledgement never reissues that command.
The existing staged handoff remains responsible for ownership. Drag data contains
bounded identities and a nonce, never drafts, paths or credentials. An optional
destination project selects the visible host-window slice for a positioned drop.
No daemon, runtime or remote operation changes; older shells omit the controls.

Application **26.11** adds optional private desktop pane docking capabilities.
Destination commands return a bounded revisioned plan, remount prepared content,
and restore the original presentation on cancellation. Main validates same-host
and same-profile participants, persists the destination route with ownership,
and retires only an acknowledged source pane with no remaining tabs or drafts.
Native targets and dirty content never select transports or grant host authority.
Older shells omit these capabilities; daemon/runtime/remote operations are unchanged.

Application **26.10** adds an optional private desktop reload capability. The
registered window checkpoints its working set before native reload; ordinary
browser refresh retains its existing path. Native host refresh checkpoints all
of that host's windows, serialises with reload and drains before app quit. No
daemon, runtime or remote protocol operation changes.

Application **26.9** adds private desktop lookup and activation of a file/session
in an existing pane window. Lookup is bounded to the caller's host/profile and
activation uses the registered renderer's correlated command channel. File and
session windows reuse the existing pane handoff; the optional source route keeps
cross-project opens from changing the source's project. No daemon operation,
runtime identity or remote grant changes.

Application **26.8** adds the optional private desktop lifecycle and pane-transfer
bridges. Bounded checkpoint/resume commands retain exact-window replies. A pane
destination stages read-only content, then the source confirms its unchanged
capture before ownership commits. Transfer references bind window/profile identity;
lost replies are observed rather than replayed. These capabilities are detected
on the preload bridge and add no daemon REST/WS, runtime or remote operation.
The existing read-only observation accepts either exact transfer participant,
returning only that participant's working-set revision. Destination recovery after
a lost acceptance reply does not repeat acceptance, commit or cancellation. Source
mutation checks remain source-only; sibling windows and other profiles are
rejected. This correction adds no wire field or protocol-version change.

Application **26.7** adds shared private desktop window identities, revisioned
working-set snapshots and acknowledged transfer records. The desktop shell owns
host association and durable state; renderer identities do not select transports
or grant authority. These records add no daemon REST/WS operation and do not
change the remote or runtime protocol. Renderer window capabilities must be
detected through the preload bridge; older shells retain their existing UI.

Runtime **1.1** advertises exact Claude-owned background job attachment. The
application and remote protocols, IPC shapes and retained-state formats are
unchanged; major-1 owners remain adoptable. Before dispatching a resume that
would attach a live native job, the daemon inspects its provider requirement and
checks the exact pinned runtime's protocol. Runtime 1.0 refuses that launch
instead of starting duplicate foreground execution. Ordinary launches do not
require the capability, and installed release names are not compatibility checks.

Application **26.6** allows six-digit `#RRGGBB` project colours alongside
existing presets and null, on create, patch and project responses. Clients gate
custom project colour writes on 26.6. Storage remains the existing nullable TEXT
column; routes, authority, runtime and remote protocol versions are unchanged.

Application **26.5** allows a six-digit `#RRGGBB` value for profile settings
`hostColour`, alongside the existing preset keys and null. New clients gate
custom host colour writes on 26.5. Profile `icon_colour` already accepts bounded
strings. No route, authority or remote envelope changes; remote protocol stays 5.

Application **26.4** adds local/SSH `POST /api/worktrees/:sid/git-restore`
for one exact unstaged file. Tracked files restore from the index, preserving
staged changes; deleting an untracked file requires `delete_untracked: true`.
The host rechecks current status under the repository mutation lock and rejects
directories, conflicts and stale deletion intent. New clients gate the control
on 26.4. The remote write allowlist and remote protocol 5 remain unchanged.

Application **26.3** adds optional `known` run identity/revision (or null for no
run) to local/SSH notebook execution observation. Only callers supplying this
field may receive `{ unchanged: true }`; omission always returns the original
full snapshot. New browsers feature-detect 26.3, retain full cached snapshots
and request full observation after reconnect/invalidation. Notebook execution,
input, kernel control and remote authority are unchanged; remote protocol is 5.

Application **26.2** adds opt-in component release catalogues. Private status and
remote maintenance status accept `include_component_releases: true`; supporting
frontends/connectors request it only for opted-in reads (`?components=1`). Older
readers receive the original strict catalogue shape. `releases.components`
contains separate daemon/runtime version and platform-asset availability; the
legacy unified offer is disabled when components do not share the release tag.
No mutation authority, approval, remote framing or runtime protocol changes.
Release manifests live in GitHub assets, not in the wire authority boundary.

The unreleased application **26.1** contract also includes read-only
`GET /api/release-notes`, returning at most two installed release documents:
the running daemon and selected runtime build. The shared `releaseNotesSchema`
defines their component, version and Markdown fields. The connector permits this
public release content through its read-only allowlist; it adds no maintenance
authority or remote-envelope change. Major 26 already requires an approved daemon
upgrade from released application 25; no further major bump is needed for 0.4.0.

Application **26.1** adds local/SSH programme outcome inspection and exact explicit
read/discard actions under `/api/puddlang/:profile/runs/:id/outcomes`. Bounded
metadata lists contain no replies or native references. A disposition binds the
inspected immutable result fingerprint and exact admitted programme operation,
requires a finished run and current profile authority, and atomically records an
immutable audit while marking its terminal result consumed. Explicit reads alone
return retained reply/error text; discards and public audit events never do.
The disposition commits before response delivery and can allow reclamation even
when a read reply is lost. Repeated identical dispositions observe the same audit,
including after result reclamation; an unavailable reply is never reconstructed or
replayed. The audit does not assert delivery. Running or
unknown outcomes remain protected. Migration 040 retains one disposition per
existing operation mapping. Existing runner consumption stays running-programme
only. There is no automatic expiry, programme resume, provider dispatch or remote
connector expansion. Remote protocol 5 and runtime protocol 1.0 are unchanged.

Application **26.0** and remote **5** introduce explicit host-approved device
maintenance authority. Existing approved devices receive no maintenance grant.
Only local/SSH host controls can grant or revoke it; the encrypted remote
administration union cannot. A grant binds an approved Noise device and host
registration to a fresh grant identity. Revocation and re-grant cannot revive an
older participating lease.

The connector derives the private claim from the admitted device and host state.
The daemon independently reads the enabled registration, device approval, expiry
and exact grant on admission and maintenance checks. New bounded
`host-maintenance` private control messages expose status, host-owned preparation,
inspection, exact interruption approval/application, cancellation and online
recovery through the existing coordinator. They accept no stage receipts, host
paths, credentials or caller-selected identity. Ordinary profile HTTP/WS authority
is unchanged; connector-local `/api/host/updates` bridges to private control, and
the daemon's profile HTTP allowlist still denies that path. Offline recovery
continues to require local/SSH authority.

Remote presentation contains aggregate component versions and interruption counts,
with private stage/worker evidence, blocker paths, operation messages and release
repository configuration removed. Dedicated manual-participation child channels
bind cancellation and grant revocation to uncommitted work. Already accepted
operations survive viewer/connector loss; reconnect only observes them. Combined
preparation has a bounded five-minute request window while every host installer
stage retains its two-minute limit; this never extends the participating lease.
Release offers use the existing per-window state and a bounded remote status poll.

Update daemon, connector, remote service and browser application together across
the authority boundary. Compatible application release skew remains supported;
reconnection never upgrades or downgrades the host. Runtime protocol remains 1.0.

Application 25.20 adds optional runtime lifetime presentation (`service`,
`host_session`, `unknown`) to placement-scoped runtime inspection. Authenticated
runtime lifetime also gates daemon-update preflight; limited or unknown owners
block replacement without being stopped. Runtime-default selection is independent.
Local/SSH purge helpers add exact inspection/preparation/application records after
completed removal and separate runtime stop consent. Approval binds the removal id,
review fingerprint and fresh attempt id. A kernel boot barrier precedes deletion,
followed by a fresh dirty/unpushed worktree review and bounded deletion of exact
quarantined roots. Lost replies permit observation only. Existing host OS/SSH
authority reaches these helpers; there are no new browser routes or relay grants.
Permanent control/lock namespaces, pinned releases and recovery evidence remain.
Active purge records fence startup/installation until the completed hand-off is
archived. Remote remains 4; runtime remains the initial unshipped 1.0 contract.
Completed purge is projected through existing removal/restoration status and helper
flags. A private restoration `purge_digest` binds archived prior-boot proof and an
additional `restore-supervisor` action. Original service evidence remains unchanged;
historical ordinary restoration plans remain readable. Read-only inspection never
republishes configuration. No additional public protocol shape or flag is introduced.

Application 25.19 adds trusted local/SSH prepare/finish removal helpers and a bounded
runtime interruption review. Prepare requires explicit daemon-removal consent, records
remote disablement before service stops, then reviews runtimes under the offline
controller. The public review contains placement/runtime ids, build, terminal count,
stop blockers and an exact fingerprint; native references and pinned paths remain private.
Finish binds the removal id, fingerprint, retain/stop choice and a fresh attempt id.
Its durable receipt is written only after disposition, verified service unregistration
and controller drainage. A lost reply is inspected against that exact attempt plus the
completed removal record; a previous successful receipt cannot complete a later attempt.
No failed mutation is automatically repeated. Existing runtime stop intent prevents
replay across explicit continuation. Passive metadata gates these new helper commands;
older persistent installations cannot use legacy recursive deletion. There are no new
browser routes or relay grants. Remote 4 and runtime 1.0 remain unchanged.
The optional private `disable-remote` service action preserves older internal journals;
public removal requires it. The selected connector's host-only disable/verification
entries reuse existing profile administration. Configuration enablement and connector
startup are fenced during removal; disablement remains available for recovery.
The selected connector also accepts explicit continuation bound to the exact active
removal id, selected release and started disable action. Under existing profile writer
locks it observes/syncs disabled registrations and disables those still enabled.
Lost live replies inspect an already-persisted disabled result without rewriting it.
This host-only desired-state reconciliation adds no network shape, journal format,
lease or grant; all three protocol versions remain unchanged. Finished disable steps
are observation-only and never permit re-enablement to be silently overwritten.

Private removal service records under `installation/removal/` validate retained
service reviews, original definitions and serial action intent. They are host-only
storage, with no browser/connector request or new transport. They do not change
the application, runtime or remote protocols, and are not authority to remove runtime
files or restart a service. New journals separate unregistration into disable/reset/
delete/reload actions on systemd and deletion on launchd after its recorded stop.
Exact plans derive from the retained service inventory; mixed, reordered and
incomplete plans are invalid. Explicit continuation can dispatch planned actions
but only observe consumed ones. Older coarse unregistration records remain readable
and cannot be expanded after an attempted action. File deletion and its recovery
observation sync the owned service directory before completing the step. Public
removal/reinstallation is integrated; collection/purge and full platform acceptance
remain in progress.
The shared Node helper also supplies passive removal fencing for host startup and
updates. Active records block mutation regardless of whether their contents parse;
cancelled reviews are kept separately. This adds no wire shape or permission.
Private restoration records bind the completed removal review to publication/reload/
enable intent. They permit no runtime commands, selector changes, database rollback
or remote registration changes. Explicit verified hand-off clears the removal fence
for ordinary startup. These private records alone do not change the three protocols.

Application 25.18 adds trusted local/SSH helper removal inspection and explicit
service restoration, used by `puddle install daemon`. Passive selected-release
metadata must advertise compatible application 25.18 or newer before invoking
the new flags. The bounded status contains only `state` and an exact removal id
when present; original service definitions, environment values and host paths stay
private. Recorded restoration completion is not service health or runtime-adoption
proof. Restoration requests bind the exact removal id and distinguish a new attempt
from explicit continuation of an existing journal. After a lost reply, the client
inspects that exact hand-off before using existing authenticated startup/readiness.
This adds no browser route, relay permission, runtime command or new transport;
remote 4 and runtime 1.0 remain unchanged. Application 25.19 adds public removal
orchestration; full platform/provider acceptance, reference-aware collection and purge
remain open.

Protocol 25.17 adds the explicit `continue-offline` frontend update action and optional
`offline_continuation` capability. The action carries only an exact operation id/revision;
it uses the selected local/SSH transport and existing frontend browser authority/Origin
checks. It never follows automatically from a failed live request. Compatible staged
daemon metadata must advertise 25.17 or newer before invoking the pinned participating
recovery entry. Earlier staged builds retain CLI recovery but are not offered this action.

The existing private host-update request/reply envelope travels over a dedicated helper
channel whose input stays open through validation. EOF, browser/request cancellation,
helper interruption or frontend reconnection revokes uncommitted dispatch. The worker
checks participation immediately before durable acceptance; accepted independent work
continues even when the viewing request ends. Exact repeated accepted requests observe
their recorded result. No daemon lease is minted or renewed, no browser/host credential
flow changes, and no relay grant or operation is added. The capability is an offer,
not fresh admission or service-health proof. Application 25.17 is additive; remote 4
and runtime 1.0 remain unchanged.

Protocol 25.16 adds optional `observation: live | recorded` to local/SSH frontend
host-update status. When the daemon connection is unavailable, the selected
transport's existing OS/SSH helper reads the bounded operation ledger, including
the requested historical operation. Public projection still excludes private
stage/worker evidence. Browser authority is required before and after the read;
cancelled requests and connection changes discard the response. Recorded state
does not prove service health, adoption or current completion. Live mutation capabilities
are false while disconnected. No mutation falls back to this reader, and no new
permission is granted. Explicit offline continuation is added separately in 25.17.
This additive application change leaves remote 4 and runtime 1.0 unchanged.

Protocol 25.15 adds local/SSH `GET /api/sessions/:id/runtime` and
`POST /api/sessions/:id/runtime/restart`. Inspection reports the placement's current
runtime build/protocol, connected live terminal ids, installed default and either a
bounded restart blocker or an exact approval fingerprint. It omits private paths,
owner credentials, process ids and environment values. Restart carries only that
fingerprint and returns the usual Session response. It rechecks runtime identity,
placement/conversation, shell generations, selected release and request authority
before stopping, then requires confirmed clean exit before normal exact resume.
The launch path rechecks authority, placement and the selected release before
replacement intent. Lost replies are inspected, never retried; boot does not replay
an interrupted restart. New clients capability-detect this surface. Remote profile
leases and connector routes still exclude it pending explicit remote integration.
Application 25.15 is additive; runtime 1.0 and remote 4 are unchanged.

Protocol 25.14 adds optional `include_catalogue: true` to private host-update status.
Only requesting clients receive the bounded `catalogue`: running daemon version,
selected runtime default, grouped committed runtime builds (running, starting and
unavailable), read completeness and timestamped latest-stable release discovery.
This is display metadata, never compatibility, liveness or update-admission proof.
The daemon lazily starts one 30-minute poller, persisting its last attempt/result
across replacement and retaining last-known success after failed checks. Lookup
uses the shared bounded CLI/desktop GitHub helper, never downloads or activates,
and reports host archive/checksum availability separately from verified staging.
An unconfigured build performs no lookup. Host archives now embed the publishing
repository in both platform release jobs; frontend preparation obtains that source
from private host status rather than a browser field or client-side override.

Frontend status optionally carries the catalogue after capability detection.
`host-updates-changed` invalidates host-wide status viewers after release discovery
or control mutations. Profile-scoped remote leases receive neither the catalogue
nor this event, and no remote maintenance permission is added. Older status requests
retain their exact reply shape. Settings controls and window offers consume these reads;
remote 4 and runtime 1.0 are unchanged.

Protocol 25.13 adds capability-detected local/SSH `GET/POST /frontend/updates`.
GET returns daemon availability/version, supported approval/recovery actions and a
bounded public operation summary. POST accepts preparation of exact release targets,
inspection, exact-fingerprint application, cancellation and supported live recovery.
Preparation reuses the CLI's staging code and does not activate a release. The
gateway stamps its own protocol and excludes browser-supplied receipts, paths,
tarballs, commands and host selection. It strips private stage/worker evidence and
blocker target paths from replies. Browser authority and exact mutation Origin are
required. Each request opens a cancellable channel through the existing host-control
client, bounded by the original frontend connection and browser request lifetime;
revocation before host dispatch closes that lease without revoking other viewers.
Accepted host dispatch remains durable. Lost replies are observed, never retried or
sent through an offline fallback. Older compatible daemons remain usable and expose
only supported actions; old frontends return 404. Offline frontend recovery remains
unfinished. This is an additive application route,
not a new maintenance protocol; remote 4 and runtime 1.0 are unchanged.
Concurrent reads are bounded separately from mutations. Short-lived status channels
avoid consuming the long-lived viewing connection's bounded request-id history.

The private daemon/runtime contract for the standard 0.4.0 backend is versioned separately in
[`RUNTIME_PROTOCOL.md`](RUNTIME_PROTOCOL.md). Adding that contract does not change
this application's protocol or the remote protocol. Default daemon composition uses
independent terminal (including code execution) and interactive/headless agent owners,
with durable private programme-turn mappings. Detached/attached host lifetimes and
transactional daemon upgrades remain release gates. Existing REST/WS shapes are unchanged.

Private host-update shutdown checkpoints live in `installation/checkpoint.ts`. They
record accepted dispatch identity, the outgoing controller and database schema, and
bounded runtime identities/builds/committed cursors. They are internal update evidence,
not a new network protocol, client approval or a replacement-adoption receipt.
The private pinned worker record may carry an outgoing PID/controller identity for
signal-driven checkpoint selection. It never crosses a client request/response or
runtime IPC boundary and adds no authority; the accepted operation remains required.
Private service replacement evidence records the exact supervisor target, process
identity and definition digest (plus launchd's existing plist path). Configuration
contents and environment values are not copied into the update record. These fields
are internal worker state, with no application, remote or runtime wire-shape change.

Private worker records also retain explicit absent/running connector replacement
evidence: its approved process identity and supervisor definition digest. Service
records distinguish daemon and connector executable layouts, with omitted component
retaining the daemon interpretation for existing records. These fields are internal
transaction evidence, not client commands or new IPC messages; they do not change
the application, remote or runtime protocol. Daemon transactions without explicit
connector evidence cannot execute.

Passive `HOST_CAPABILITIES.json` metadata optionally records
`database_schema_version`, the highest existing SQLite migration in the daemon
build. Older files remain readable but cannot establish safe daemon activation.
Preflight binds the observed host schema into approval and the worker rechecks its
shutdown checkpoint before selection. This field is private release evidence, not
a new network shape, storage protocol or permission to restore old data. All three
protocol versions are unchanged.

Protocol 25.10 adds optional exact `interruption_approval` to host-update apply
requests and `interruption_fingerprint` to reviews. Reviews still report
`can_apply: false` and a null ordinary fingerprint when daemon-owned work needs
confirmation. Only clients advertising 25.10 receive the additional fingerprint;
older clients retain the blocked review shape. A separate apply must match both
its ordinary fingerprint and explicit interruption approval against final inspection
under maintenance. Missing consent leaves the staged operation available for review;
changed evidence invalidates approval. The client refuses this request field on older
hosts. Existing host-wide lease authority is unchanged, and no remote permission is
added. Remote 4 and runtime 1.0 remain unchanged. The private pinned worker records
the exact interruption approval alongside its preflight evidence.

Protocol 25.12 adds the explicit local/SSH recovery strategy `continue` and optional
`include_recovery: true` on status requests. Continuation dispatches an independently
supervised worker against the exact operation revision, using the existing recovery
claims and journals. Replies may expose a bounded `recovery` record containing the
attempt id, requested/accepted revisions and whether a worker consumed the attempt.
Consumption proves neither current liveness nor completion. Status replies include
this record only when explicitly requested, preserving older strict reply readers;
clients refuse both new request forms on hosts older than 25.12. The CLI can also
use its trusted OS/SSH helper when the daemon is unavailable, invoking only the
verified staged worker and inspecting durable acceptance after a lost reply.
Neither path retries uncertain dispatch. No remote maintenance permission is added;
remote 4 and runtime 1.0 remain unchanged.

Protocol 25.11 adds private local/SSH `recover` with an exact operation revision
and the strategy `verify-completion`. The coordinator fences the old dispatch,
holds execution exclusion, confirms the recorded worker process group has ended,
then uses fresh completion evidence before marking the operation complete. Authority
is checked again before that transition. Unknown lifetime evidence, live/reused groups,
partial selection and failed adoption leave recovery pending. Already-complete
operations return their recorded result; no component command is replayed. Clients
refuse the request on older hosts. This adds no remote maintenance permission;
remote 4 and runtime 1.0 are unchanged. `installation/worker.ts` also defines the
private pre-activation lifetime record, bound to operation, dispatch and worker
identities. It is not a new wire or runtime-state version.

`installation/actions.ts` defines a private, bounded worker step journal with a
fixed plan and serial planned/started/finished states. Each stop, selection and
start step records durable intent before it may mutate a component. Lost replies
retain started; finished records a returned step, not current health or adoption.
Readers bind the exact plan to operation, dispatch, worker and approval identities.
Missing journals from older workers cannot prove that a step was never attempted.
This evidence is internal to host updates and changes none of the three protocols.

`installation/recovery.ts` records at most eight private recovery dispatches per
operation. Each pins its own service/executable, fences an exact operation revision
and binds the original worker and action journal. Its nullable execution record is
atomically replaced with a unique execution id and process group before component
commands. A later recovery must fence pending jobs and establish that every consumed
group has ended; ordinary maintenance release uses the same check. These records
are host-only worker evidence, not new application, remote or runtime messages.
An optional `connector_restart` fingerprint records separate permission within a
fresh explicit recovery attempt after confirmed connector loss. It binds the approved
service and selected generation; existing records without it cannot restart an attempted
connector. This private ledger extension changes none of the three network protocols.

Protocol 25.9 adds nonce-correlated, read-only process inspection on the connector
manager's existing exclusive private host socket. Replies contain bounded process,
release and protocol metadata only; profile configuration, grants and registration
secrets are excluded. Old managers which close the socket remain unknown, never
proof of absence. Preflight corroborates exact immutable executable paths and public
release metadata, and binds stable manager identity to update approval. This adds
no encrypted remote operation or maintenance permission; remote protocol 4 and
runtime protocol 1.0 are unchanged.

Protocol 25.8 adds an optional `adoption_nonce` to exact-operation host-update
status requests. It requests a fresh private replacement observation, without
authorising activation or returning runtime details to the caller. Older status
requests are unchanged; clients check 25.8 before sending the nonce. The worker
checks the matching private receipt, current controller identity, approved generation
and both private control and authenticated HTTP authority. Evidence readers ignore
additive metadata from compatible candidates; the checkpoint digest includes all
stored fields, including those the reader does not interpret. Receipt publication
flushes SQLite before promising committed cursors. Remote and runtime
protocols are unchanged.

The same nonce request may observe an exact `recovery_required` operation with a
recorded worker identity. It refreshes private adoption evidence only; it neither resolves
recovery nor authorises execution. Older daemons which cannot make this observation
produce no matching fresh receipt and cannot establish recovery completion. There
is no new wire shape or authority for observation; remote 4 and runtime 1.0 are unchanged.

Protocol 25.7 adds bounded local/SSH host-update requests and correlated replies on
the existing private host-control connection. Existing open/renew/token semantics
are unchanged. Profile-scoped connections cannot use this host-wide surface; no
HTTP route or remote connector permission is added. New clients detect 25.7 before
sending these requests and never replay a request after loss of its control channel.

Protocol 25.6 adds `logRetentionDays` to host configuration and its patch, defaulting
to three days when omitted (zero disables age-based cleanup). New clients gate the
setting on 25.6. Retention compacts inactive bulk output while preserving the entire
replay tail and all snapshots/history needed for archived terminal restoration.
Remote protocol and operation allowlists remain unchanged.

Protocol 25.5 adds local/SSH-only GET `/api/storage` with available space/inodes,
log and database persistence health, plus optional `Session.persistence_pending`
for observed runtime status awaiting persistence. New clients gate polling on
25.5. Remote profile leases and the connector deny host-wide storage paths;
remote protocol remains 4.

Protocol 25.4 adds local/SSH-only POST `/api/notebooks/widgets` for bounded
widget snapshots and incremental comm events, and POST `/widgets/comm` for
explicit widget actions bound to an exact kernel generation. Reconnects only
observe state; writes are never replayed. Remote leases and the connector
continue to deny the notebook namespace; remote protocol remains 4.

`@puddle/shared` is the protocol package: the zod schemas in `src/` are the
single, executable description of every REST shape and WebSocket message
exchanged between the `puddle` CLI (and the UI it serves) and `puddled`. There
is deliberately no prose copy of the schema — prose copies drift. This file
only defines how the protocol is versioned. The full design is SPEC §6,
"Protocol versioning and compatibility".

## Two version numbers

- **App version** — the npm/tarball semver. Says nothing about compatibility.
- **Protocol version** — `PROTOCOL_VERSION = {major, minor}` in
  `src/protocol.ts`, reported by `GET /api/version`. This is the
  compatibility contract.

## The rule

**Same `major` ⇒ compatible, in both directions.** Everything within a major
is additive-only. When the CLI's handshake finds an older daemon `major`, it
requires explicit approval before updating it; a newer daemon tells the user
to update the CLI. There are no compatibility shims: old majors are not served.

## When you change a schema in this package

| Change                                                       | Action                      |
| ------------------------------------------------------------ | --------------------------- |
| New endpoint, new WS message type                            | bump `minor`                |
| New **optional** request/response field                      | bump `minor`                |
| New enum value that peers may safely ignore                  | bump `minor`                |
| Removing or renaming an endpoint, field, or WS message       | bump `major`, reset `minor` |
| Changing a field's type, or the meaning of an existing value | bump `major`, reset `minor` |
| Changing auth, the token flow, or the WS handshake           | bump `major`, reset `minor` |
| Comment/doc-only edits, refactors with identical wire shapes | no bump                     |

Bump the constant **in the same commit** as the schema change, update the
current-version assertion in `test/api.test.ts`, and note the bump in
`CHANGELOG.md`.

## Wire rules that keep additive changes safe

Application feature gates use a fixed introduction version, separately from the
current client/daemon major compatibility check (`supportsApplicationFeature`).
A later compatible major starts at minor zero and retains previously introduced
controls; comparing its minor against a previous major's feature floor would hide
them. This helper grants no authority and never bypasses the application handshake.
Its introduction changes no wire shape or protocol version.

1. Receivers **ignore unknown WS message types** (an unrecognised `t` is
   dropped, not an error).
2. Receivers **tolerate unknown JSON fields** — schemas use loose objects
   wherever extension is expected.
3. A newer client on an older daemon **feature-detects** against the daemon's
   `minor` and hides what the daemon cannot do; it must not fail.

## Non-bumps worth recording

- **Huddle definition foundation (2026-11-08)**: new local document/component
  schemas and graph/binding validation are preparatory only. No existing REST,
  WS, runtime IPC, session-kind or saved-tab schema changes, and no huddle
  capability is advertised. Protocol versions remain unchanged until the
  corresponding application/runtime integration is implemented.

- **Phase 6 serving switch (2026-07-14)**: the CLI took over UI serving and
  the daemon's default port moved 7433 → 7434. Verified non-wire-affecting —
  no schema changed, ports are deployment configuration (the Host/Origin
  guard has always ignored them), and the `?host=`/`#token=` boot params are
  browser-side conventions that never reach the server. `PROTOCOL_VERSION`
  stayed 5.1.
- **SSH-attached daemon fallback (2026-08-13)**: the CLI now owns the daemon's
  process lifetime through an SSH exec channel when a host reaps detached
  `nohup` children. This changes bootstrap and transport lifecycle only; REST
  and WebSocket schemas, authentication, token flow, and the protocol
  handshake are unchanged. No protocol bump.
- **Public remote signup (2026-09-21)**: remove the deployment email allowlist
  and fix registration policy to the already supported open-signup behaviour.
  OAuth verification, cookies, host authority and all wire shapes are unchanged;
  remote protocol remains 2 and daemon/frontend protocol remains 19.0.
- **Follow-clone default (2026-09-30)**: repository registration now defaults
  to the already supported empty base-branch setting, and migration 023 resets
  existing saved defaults once. Explicit empty/non-empty values, PATCH omission,
  session requests and response shapes are unchanged. This changes the default
  policy, not the meaning of a supplied value; daemon/frontend remains 22.0 and
  remote protocol remains 3.

## Remote transport

`REMOTE_PROTOCOL_VERSION = 5` versions the separate service/connector/browser
contract in `src/remote/`. Its strict envelopes and Noise prologue require an
exact match; incompatible peers fail closed. Its introduction did not change
daemon protocol 18.0. Turning the existing server WS union into an equivalent
zod schema did not change that wire contract. Protocol 18.1 adds local/SSH
`/frontend/remote` administration; it does not change the remote envelope or
host-authority semantics. Older connector builds are capability-detected before
the frontend invokes their administrative commands.

Breaking changes to daemon operations exposed by the remote allowlist also
require a remote protocol bump: an unchanged envelope does not make changed
application messages compatible with a previously deployed browser build.

Remote protocol 2 removes email login from the service discovery/auth contract.
Daemon/frontend protocol 19.0 accompanies its changed pairing invitation literal
in `/frontend/remote`; host lease and operation semantics remain unchanged.
Deploy the service, browser and host connectors together.

Daemon/frontend protocol 19.1 adds local/SSH registration deletion and an optional
capability in frontend status. Older connectors keep their existing controls;
deletion is hidden and rejected until the host advertises support. The encrypted
remote admin schema excludes deletion, so remote protocol remains 2.

Daemon/frontend protocol 20.0 adds desktop-initiated registration: an authenticated
frontend polls a machine-only service endpoint with an ephemeral verifier, while
the signed-in application approves its public SHA-256 hash. This is a new token
flow, so the frontend major advances. The existing connector code redemption,
Noise envelopes, pairing and host leases are unchanged; remote protocol remains 2.
The service and application must be updated to expose the new handoff endpoints.

Daemon/frontend protocol 21.0 adds host-authenticated registration retirement via
machine-only `POST /remote/unregister`. The existing routing credential authorises
removal of its own service record only; browser Origin/cookies are rejected and
retries are idempotent. This adds an authentication flow, so the frontend major
advances. Noise envelopes, pairing and host leases are unchanged; remote protocol
remains 2. Update the service and host connector for automatic cleanup; an older
service leaves private retirement requests queued until it is upgraded.

Daemon/frontend protocol 21.1 adds `GET /api/worktrees/:sid/preview-asset`:
bounded base64 JSON for read-only remote previews. It uses the existing browse
root and host lease; the connector explicitly allowlists it. Existing operations
and remote envelopes are unchanged, so remote protocol remains 2. Update the
host daemon, connector and static app (including the sandboxed preview shell's
response CSP); newer clients hide the toggle below daemon 21.1.

Daemon/frontend protocol 21.2 adds connector-local chunked image uploads and the
optional `remote_image_uploads` version capability. New browsers check that flag
before calling `/api/worktrees/:sid/paste-upload`; older connectors retain small
legacy pastes. Each chunk uses the existing bounded encrypted request envelope,
and finish uses the existing host-local paste route. Noise, authentication and
host leases are unchanged; remote protocol remains 2.

Daemon/frontend protocol 21.3 accepts an empty `default_base_branch` on repository
creation and update to follow the clone's current branch for each new session.
At introduction, this added a previously rejected request value while non-empty
values and omitted fields retained their existing meaning (registration captured
the clone's branch; PATCH left it unchanged). Registration now defaults to empty
as described in the follow-clone default note above. Settings only offers clearing
the default on 21.3 or newer. Session requests, remote operations and authentication
were unchanged, so remote protocol remained 2.

Daemon/frontend protocol 22.0 adds an optional profile to host-control `open` and
binds that profile to every resource in the lease. Remote connectors always
request this scope; local/SSH frontend leases remain host-wide. The daemon filters
discovery and WebSocket events and checks direct session/project operations.
`/frontend/remote` requires a profile query parameter; connector administration
uses validated profile envelopes on stdin (`frontend controls 2`). This changes
authority semantics, so the daemon major advances. Remote protocol 3 accompanies
the change from host-wide to profile-only access. Upgrade the service, app,
daemon and connector together. Legacy host-wide registrations are deleted and
their approvals revoked; users register and pair each profile afresh.

Daemon/frontend protocol 22.1 adds optional `Session.detected_agent_type`: a
transient icon hint for a recognised foreground agent inside a terminal session.
It leaves session kind, account, conversation identity and status unchanged.
Updates reuse the profile-filtered `sessions-changed` event; no remote operation
or authority changes, so remote protocol remains 3. Older daemons omit the hint
and newer clients retain the terminal glyph.

Daemon/frontend protocol 22.2 adds the optional `notifications.when_focused`
profile preference (default true). Older peers retain their existing policy;
native notification delivery and its bounded result use capability-detected
desktop IPC only. Remote envelopes and host authority are unchanged.

Daemon/frontend protocol 22.3 adds the `agent-notification` WS event for waiting
and unrequested agent exits, including observed agents in terminal placements.
It shares the existing session/profile-filtered status subscription. Older clients
ignore it; newer clients use status transitions on daemons below 22.3. Remote
protocol remains 3: envelopes, authority and allowed operations are unchanged.

Daemon/frontend protocol 22.4 adds capability-detected connector-local push
subscription/test operations and private profile IPC attention signals. The remote
service adds optional `push_public_key` discovery and machine-only push operations
using the existing host routing credential; the connector binds registration to
its already-approved Noise device under the existing lease. No new authority,
token flow, handshake or strict envelope variant is introduced, so remote
protocol remains 3. Older services/connectors omit the capabilities; newer
browsers keep live notification delivery and explain why background push is
unavailable.

The daemon line in `puddle --version` may display `protocol 22.4c3`. The `c3`
reports the bundled connector's remote protocol, read from `CONNECTOR_PROTOCOL`
in the release archive (or a known historical release). It is display-only:
`PROTOCOL` remains the daemon's plain `major.minor`, and CLI/desktop handshake
comparisons never parse or compare the suffix. Unknown connector versions are
omitted rather than inferred from the running CLI.

Daemon/frontend protocol 22.5 adds optional bounded content to `agent-notification`,
validated project/session notification destinations, and capability-detected
end-to-end encrypted push previews. New browsers send a preview key only when
the connector advertises `remote_notification_previews` and the service advertises
`push_encrypted_previews`; service registration explicitly rejects those keys.
The private connector IPC retries the legacy id-only request only after an explicit
rejection. Old clients ignore optional event content; old subscriptions retain generic
push. Noise admission, remote envelopes and host leases are unchanged (remote 3).

Daemon/frontend protocol 23.0 adds local/SSH puddlang context, submission, status,
events and cancellation endpoints. Shared schemas also define runner IPC and
stdio MCP inputs. Existing authority/token flows are reused; remote profile
leases and the connector allowlist reject this namespace (remote protocol 3).
The major boundary is intentional for the puddlang rollout, despite the additive
endpoints. Upgrade daemon, CLI/desktop, and the remote connector/application to
matching daemon protocol 23.0. Existing launcher upgrade approval still applies;
puddlang itself requires an already compatible daemon and never upgrades one.

Daemon/frontend protocol 23.1 adds optional `Session.agent_mode`, optional per-spawn
Puddlang `mode` (omission retains interactive), advertised adapter modes and
bounded native turn signals under the existing per-runtime nonce. Migration 025
preserves existing placements as interactive. `pudl` requires 23.1 so older runners
cannot silently discard the requested mode. Session creation through the public
REST API remains interactive; no remote operation or authority is added. Remote
protocol remains 3 and Puddlang remains excluded from remote leases/allowlists.

Daemon/frontend protocol 24.0 renames the execution mode enum value `scripted` to
`headless` in Puddlang spawn/context and `Session.agent_mode`. This removes an
accepted value, so the major advances with no legacy wire alias. Migration 026
converts persisted placements and replaces the SQLite constraint; interactive
remains the default. Historical run source/events retain their original text.
Programmes using the old spelling must be updated explicitly.

Remote protocol 4 accompanies the renamed mode in allowlisted session responses.
Update CLI/desktop, daemon, connector, service and application together. Existing
registrations and device grants are retained; invitation/Noise admission requires
the new version. Puddlang remains local/SSH-only, with no allowlist or authority
expansion. The `scripted_turns` capability still describes automated turn support
in either mode; it is not an execution mode name.

Protocol 24.1 adds an optional bounded `subtitle` to the desktop notification
request schema. The desktop preload advertises `notificationSubtitles`; newer
renderers send a host/project title and session subtitle only with that capability.
macOS uses its native subtitle, Windows uses three native text blocks, and Linux
places the session on the first body line above the preview. Older shells and
browsers retain the session title and body. Daemon REST/WS
messages, remote envelopes and host authority are unchanged; remote protocol
remains 4.

Protocol 24.2 adds frontend-local `GET /frontend/file-manager` capability discovery
and `POST /frontend/file-manager` with a bounded absolute path to reveal. Both
require browser authorisation; POST also requires the exact frontend Origin.
Only local-host frontends advertise or invoke a file manager. SSH frontends refuse
the operation even though their UI also lives on localhost; remote browser
transports never call these routes. Older frontends return 404 and the UI omits
the menu action. No daemon or connector operation is added; remote protocol
remains 4.

Protocol 24.3 adds optional compilation-provider `action` (`compile` or `run`).
Older clients ignore it; newer clients treat omission as compilation. Code and
notebook providers reuse the existing capability/run/settings/status schemas,
with `eager: false` and explicit execution only. Their artefacts use existing
file targets. No remote allowlist, authority or envelope changes; remote
protocol remains 4.

Protocol 24.4 adds POST/PUT `/api/compilation/defaults` for profile language
commands and an optional nullable `inherited_command` on file command slots.
Existing per-file overrides remain authoritative; null language defaults retain
provider-owned source and engine selection. Newer clients show the language
picker only after confirming 24.4. Compilation routes remain local/SSH-only;
remote protocol remains 4.

Protocol 24.5 adds optional nullable project `colour` fields to project responses,
creation and updates, using the profile icon palette. Omission on update preserves
the saved colour; null restores default styling. Newer clients hide colour controls
until the host advertises 24.5. Existing project routes and authority are unchanged;
remote protocol remains 4.

Protocol 24.6 adds the local/SSH-only `/api/notebooks/kernels`, `/status`, and
`/kernel` endpoints for installed kernel discovery and explicit lifecycle
controls. Existing notebook runs retain their compilation request/result shapes
and managed artefacts while reusing a daemon-owned kernel. Newer clients hide
kernel controls until confirming 24.6. No connector allowlist or remote envelope
changes; remote protocol remains 4.

Protocol 25.0 makes programming-language execution terminal-only. Providers
advertise `terminal`, and every ordinary run launches a new terminal placement
returned in the result. Both compilation and programme execution happen in that
PTY; a successful response confirms launch, with completion and errors shown in
the terminal. There is no terminal-selection request flag or captured-output
fallback for programming languages. This changes the meaning of existing code
run requests/results, so the major advances. Upgrade daemon and CLI/desktop
together through the normal handshake. LaTeX and notebook providers retain their
previews. Compilation remains local/SSH-only, outside the connector allowlist;
remote protocol remains 4.

Protocol 25.1 adds local/SSH-only POST `/api/notebooks/environments`, optional
Python environment details in kernel status, and `select-python`/`install-python`
kernel actions. Newer clients gate these controls on 25.1; registered-kernel
controls remain available on older hosts. Selection retains incomplete environments
and installation requires an explicit action; fixed package names run through the
selected Python's pip without a shell. Installation includes the displayed Python path and rejects a changed selection. Remote profile leases and the connector
continue to deny this namespace, so remote protocol remains 4.

Protocol 25.2 adds local/SSH-only notebook `/execute`, `/execution` and `/input`
operations for bounded cell source snapshots, observable live results and exact
run/prompt input replies. New clients feature-detect interactive execution; older
hosts retain Run to Executed Copy. The existing compilation API and kernel
lifecycle are unchanged. Remote leases and the connector deny this namespace.

Protocol 25.3 adds local/SSH-only POST `/api/notebooks/intelligence` for bounded
completion and inspection. Requests use Unicode codepoint positions and existing
idle kernels only. Dedicated shell clients have unique routing identities so
assistance never consumes execution/input replies. Remote access remains denied.
