# Private runtime protocol

Status: implementation for the standard runtime backend in **0.4.0**. Daemon
composition defaults to installed independent runtimes without a user-facing
enable/disable option. Native platform, provider, reboot and resource acceptance
remain release gates; the legacy backend is an internal fixture override.
The full delivery scope is tracked in
[the persistent runtimes roadmap](../../docs/roadmap/persistent-runtimes.md).

`RUNTIME_PROTOCOL_VERSION` is **1.1**, independently of application
`PROTOCOL_VERSION`, `REMOTE_PROTOCOL_VERSION` and component release versions.
Executable schemas are in `src/runtime/protocol.ts`; local record formats are in
`src/runtime/storage.ts`. Do not reuse REST session/account schemas here.

The initial implementation covers authenticated controller adoption, inspection,
terminal snapshots/output, input/resize, extra shells, retained terminal/shell observations,
acknowledgement and explicit termination. Optional provider launches instantiate
the existing adapter's live resources inside the runtime, retaining its hook
endpoint and native conversation claims through controller outages. Runtime IPC
also admits exact provider turns and retains their outcomes independently of the
controller. Runtime-owned helper copies and stable account dispatch preserve
managed hook/plugin code across account updates. Immutable release retention,
placement switching and programme reconciliation use these same owner identities;
the roadmap records their implementation and remaining acceptance evidence.

## Compatibility

The unshipped huddle role has a separate strict private launch/control contract
under `runtime/huddle/owner.ts` (contract 1). The runtime entry point can compose
it without changing agent/terminal launch records or their protocol 1.1 messages.
It shares permanent runtime and process-memory claims, lifetime validation,
pre-dispatch grants and bounded framing. Its handshake binds the exact scoped
identity, secret, build and current controller epoch; command sequences survive
controller replacement. A consumed launch cannot restart the same incarnation.
Persisted observation versions and bounded `changed` notifications drive daemon
projection without idle polling. Command cursors and observation versions are
separate. The daemon rejects incomplete/backwards observations and commits the
coarse session status with its observation cursor; detailed execution records
stay in the owner ledger. Shared discovery keeps huddle clients separate from PTY
clients, under one controller claim. Pause/drain includes both projectors.
Retirement requires the launch/dispatch/execution/memory claims and exact retained
state. A clean exit releases the owner; crash/unknown state leaves an interrupted
placement with unresolved resources retained and never invokes ordinary auto-resume.
Archives now carry a separate `RUNTIME_CAPABILITIES.json` with exact build/protocol
and role contract versions. The bounded huddle selection reader requires owner,
definition, component and ledger support plus pinned helper files, then rechecks
the exact selection before launch intent. Private huddle launches retain those
requirements and live adoption verifies actual capabilities. Ordinary owners need
no new metadata and historical `HOST_CAPABILITIES.json` readers are unchanged.
The daemon launcher now selects and pins capable installed releases, publishes a
validated initial revision and uses the common supervisor/grant path once. Owners
start stopped. Exact-owner controls retain authority across queueing and never
redirect a queued command to a replacement. Application migration 44 records Stop
consumption separately from terminal stop records; lost replies are observation-only.
Ordinary kill/archive delegates to this path. Never-consumed launches can retire
under all ownership claims and a durable fence; interrupted consumed owners retain
their resource references and are excluded from automatic service cleanup.
No production creation path is enabled yet. Daemon launch/adoption/projection is wired;
host-update checkpoints retain huddle id/contracts and preflight, activation and
restart recovery require explicit daemon adoption support from
`DAEMON_RUNTIME_CAPABILITIES.json`. This separate bounded passive declaration
binds the candidate version/application protocol; ordinary host metadata is unchanged.
Missing metadata is not huddle support. Fresh adoption checks the authenticated
huddle state and settled committed observation, including after controllerless
completion. Recovery retains immutable role requirements across later attempts.
Offline removal now adopts both roles and reviews huddle activation/impact inside
its Stop queue. Purge fencing and release collection share exact binding and clean
final-state evidence under `runtime/huddle/ownership/`. Live/unresolved workers keep
references pinned; the existing later-boot barrier still gates executable retirement.
Source revisions and execution history remain intact. Public admission and
stopped-host startup integration must precede product enablement; executable presence or the ordinary runtime protocol alone is not huddle admission evidence.
See [huddle acceptance](../../docs/acceptance/huddle.md) for the tested scope.

Runtime 1.1 adds exact attachment to Claude-owned background jobs. Before writing
launch intent, the daemon checks the provider's requirement against the pinned
runtime's minor capability. A live native job cannot be resumed through runtime
1.0 because it would create duplicate foreground execution. Ordinary launches
and adoption of existing major-1 owners remain supported; IPC and retained-state
shapes are unchanged.

The same major is compatible; additive minor capabilities must be detected before
use. This guarantee covers IPC and the retained state needed for adoption. Local
format markers remain validation details, not independent compatibility contracts.
The candidate daemon declares its supported runtime majors; preflight compares
them with every live runtime without requiring matching release versions.
A different unsupported major is an adoption error, never proof of runtime death. New
required fields, removed operations, changed meanings and authentication changes
require a new major once this contract has shipped. The initial unshipped 1.0
contract is developed together with its first owner/client implementation.

Launch records optionally retain `boot_id` and `lifetime`; new dispatches declare
`service` or `host_session`, with kernel boot evidence required for the latter.
An owner validates a recorded boot before consuming intent or starting a provider.
Detached owners must prove their own process group and ignore terminal hangup;
neither establishes survival of host session teardown. Authenticated runtime state
reports that lifetime, or `unknown` for earlier records. Daemon replacement requires
`service`; limited/unknown owners remain running and block that update. Changing
only the installed runtime default does not restart owners, but managed software
updates still require a usable host service manager. Detached registration cleanup
uses existing launch/dispatch/owner claims and retirement fencing; it never signals
a recorded PID or claims provider descendants have ended. These additions develop
the initial unshipped 1.0 contract alongside its first implementation.

The host presents runtime id, incarnation, launch id and build independently of
its current controller. The controller proves the private runtime secret plus
its current host-controller id/epoch. Application/browser credentials, remote
leases and provider hook nonces cannot authenticate this socket.

Installed runtime selection reads bounded `VERSION`/`RUNTIME_PROTOCOL` metadata
from one resolved immutable release. The launch intent records that build and
protocol exactly; a later selector change cannot affect its executable paths.
Unsupported majors fail before launch, while owner adoption still authenticates
and verifies the actual reported build/protocol. Installer smoke checks do not
replace adoption or all-owner update preflight. Runtime-only installation changes
the default for future launches without restarting existing owners.

## Framing and bounds

Each frame is a four-byte unsigned big-endian byte length followed by one UTF-8
JSON object. Length and UTF-8 are validated before schema dispatch. Frame and
queue limits are exported as `RUNTIME_LIMITS`; receivers bound both pending
request count and encoded bytes. An owner shares one 16 MiB/64-request allowance
across all connections, while each connection retains its own execution order.
Closed connections retain their charges until queued closures settle; their
undispatched requests are discarded. A slow controller is disconnected without
blocking PTY drainage. No unbounded replay queue is maintained for disconnected
controllers; terminal attachment obtains a new snapshot.

The initial unshipped runtime 1.0 sender also limits JSON encoding to nesting depth
128 (root depth zero) and 65,536 traversal visits, counting object keys and values,
including omitted properties and array holes. Exceeding either produces an explicit
`Runtime JSON depth capacity exceeded` or `Runtime JSON traversal capacity exceeded`
error before serialisation. These are additional encoding limits: an otherwise
schema-valid deeply nested `output_schema` below its 64 KiB bound can still be refused.
Senders accept plain schema JSON, including sparse arrays and shared acyclic children,
but reject accessors, proxies, custom `toJSON` functions and non-plain objects without
executing them. They count exact UTF-8 JSON bytes, including escapes and lone
surrogates, before reserving queued-frame capacity and serialising. Preflight bounds
visited work and avoids an explicit full key array; it does not promise allocation-free
JavaScript property enumeration. A separate transient encoding allowance is released
before socket completion; queued small frames retain only their exact encoded charge.

Canonical emulators share an owner-local 128 MiB retained allowance (96 MiB
geometry, 24 MiB variable text/link state and 8 MiB control state), plus a 16 MiB
parse/reflow working allowance. Initial geometry reserves viewports and a cached
blank row; history grows in precharged blocks of at most 64 rows up to the existing
20,000-line ceiling. Admission trims only necessary old scrollback for new
viewports; unavailable optional growth uses normal whole-line rollover. History
capacity changes preserve cursor wrap and scroll regions. Combined cells,
hyperlinks and partial collected control sequences have
explicit limits. REP expansion is admitted before upstream allocation. Bounded
write batches retain working capacity until their actual callbacks settle.
Exhaustion leaves live PTY delivery running and marks the canonical screen
unavailable, preserving its last durable snapshot. These charged allowances do
not measure RSS or establish aggregate host admission.

Owner screen persistence keeps parsing separate from disk writes. Its parser
queue charges 16 MiB/2,048 actions; captures have a separate 16 KiB/64-action
pool. Capture is enqueued synchronously at the caller's output cursor, before
later PTY bytes, and never waits for disk I/O. Two transient operations share a
96 MiB charged allowance; at most 32 metadata-only waiters await capacity. Saves
coalesce to the latest revision and final files are capped at 4 MiB. Preflight
uses the pinned serialiser's whole-scrollback-line option to retain complete
visible normal/alternate buffers and modes without truncating ANSI. An oversized
viewport refuses capture; actual lost parser input makes the canonical screen
unavailable while live PTY output continues. Exited gaps retain only a tombstone
for the store's lifetime. Last-good disk screens remain intact. These limits
bound managed buffers/files, not total RSS, all owner processes or accumulated
temporary files from earlier crashes. No runtime wire shape changes.

New persistence attempts use finite exclusive scratch names, shared across all
destinations in each pool: one journal slot, one state slot, 64 checkpoint slots
and two screen slots. An existing file, changed inode, failed cleanup or uncertain
descriptor close retains capacity; retries cannot create another scratch identity
to bypass that debt. Byte limits are checked before creation, and checkpoint
attempts retain their existing cumulative lifetime charge. Exhaustion degrades
persistence while live PTYs continue. Historical orphan files are neither assumed
absent nor automatically removed by these writers.

Every admitted post-handshake request carries a monotonic command sequence.
The runtime remembers its high-water mark through controller disconnects and
reports it on adoption. Old sequences are rejected, including commands whose
acknowledgements were lost. A new controller starts above that mark. Requests
are ordered on each control stream; uncertain input and asks are never retried
automatically. Request UUIDs correlate responses rather than authorising replay.

Terminal generation is required for input, resizing, snapshots and termination.
Reusing a shell's display id creates a new generation. A stale generation cannot
address the replacement process. Snapshot replies carry an output cursor captured
before awaiting the emulator's existing queue. The attaching client buffers live
events until the snapshot arrives, then applies only events beyond that cursor.
Snapshots use the owner's existing grid and never resize it; resizing requires
an explicit placement-scoped mutation.
Runtime exit records remain on disk after the owner shuts down.

## Essential event retention

Terminal creation/exit, exact native lifecycle and collision observations share
the live event cursor with output and replaceable agent status, but only essential
observations enter `events.json`. Output/status-only cursor gaps are normal;
output recovery uses the terminal snapshot and current agent state is inspected
on adoption. The journal holds at most
4,096 events and 2 MiB of encoded data. `events` returns at most 256 events, a
`through` boundary, a `more` flag and journal health. Controllers must reject a
page with `gap: true`; it means history was lost or their cursor predates already
acknowledged history. It is never permission to synthesise missing observations.

Commit application effects and their cursor together in SQLite, then send
`ack-events`. A controller can acknowledge only a boundary offered on its current
connection. Acknowledged entries are removed, retaining the high-water mark.
If acknowledgement is lost, read again from the committed database cursor; never
repeat application effects or commands. A replacement connection starts with no
offered boundary, even when it uses the same controller epoch.

The single journal writer uses asynchronous atomic replacement, file and directory
fsync, and bounded coalescing. Failed writes remain in memory with a visible
`persistence_pending` flag and exponential retry from one to thirty seconds.
Acknowledgement replies do not imply a successful disk write: database effects
are already committed, and an older on-disk journal can safely contain duplicate
observations. Never replay user input while retrying journal persistence.

When the journal fills, retain existing unacknowledged observations and a sticky
`lost_through` marker. Stop ordinary acknowledgement/adoption of that incomplete
history, while continuing to drain PTYs. Segment-to-placement binding commits
through the daemon; incomplete history remains an explicit reconciliation problem.
Normal shutdown reaps terminal exits and flushes the
journal before releasing runtime ownership. Confirmed-owner-loss discovery reads
the private journal alongside final state so exits during an outage can be
reconciled after the owner has gone; missing/corrupt history must not be treated
as an empty, successfully reconciled journal.

## Terminal history segments

Live PTYs and emulators remain keyed by runtime identity. Raw output is written
separately under `logs/<segment-id>/<term>.<generation>.log`; live emulator state
lives under `screens/`. The runtime is the only writer of both. Its initial
segment uses the runtime id and starts at cursor zero. The first exact native
binding labels that segment; a later change of native ref starts a fresh segment
at the lifecycle event's cursor. Repeated starts for the same ref and session-end
observations do not create an extra segment. Native lifecycle events carry the
current segment descriptor and the previous segment id when a boundary changed.

Every output event and live snapshot response carries its segment id. Consumers
must combine it with terminal generation and output cursor; they must not append
output from a new segment to an old placement merely because its runtime id is
unchanged. The private binding contract below fences these boundaries; production
session adoption and retained-history routing must still integrate it.

### Committed placement bindings

Inspection exposes `binding: { segment_id, session_id, through } | null`. The
initial segment is bound by the committed launch intent at cursor zero. A native
switch to a new segment clears the binding synchronously before publishing its
lifecycle event. The owner continues executing and retaining output while unbound.

Migration 030 adds `runtime_segments` and the active segment pointer to the
daemon's runtime bindings. New launch intent includes the initial segment. Ordered
observations commit segment boundaries, immutable placement mappings, application
effects and the event cursor in one SQLite transaction. A failed effect rolls back
all of them. Old experimental rows without segment evidence remain unbound; the
store does not fabricate their history. Confirmed owner loss closes the last known
segment at its committed cursor without claiming an exact unobserved exit cursor.

After committing, the daemon derives `bind-placement` from the store's committed
binding. The owner requires its current segment and a cursor already offered to
that controller connection, at or beyond the segment's start. A journal gap blocks
binding. An acknowledged segment cannot change placement or regress its cursor.
If another native switch races the commit, binding fails; reconcile the next
events before trying the newly committed binding. A lost binding response is
resolved by inspection and database comparison, never replaying application effects.
Journal acknowledgement follows the database commit and binding reconciliation.

Every input, resize, shell creation, terminal/runtime stop, provider turn admission
or cancellation, capture-policy change and environment purge requires an explicit
`placement: { segment_id, session_id }`. A stale or absent binding yields
`stale_placement` before effects. Admission rechecks placement after asynchronous
journal work as well as checking controller epoch and terminal generation. The
client must retain the caller's resolved placement address; it must never fill it
from whichever placement happens to be current when dispatch occurs. Inspection,
snapshot/history reads and retained turn-result lookup remain available while
unbound. These private contracts are still part of the unshipped runtime 1.0
foundation; application/remote wire shapes are unchanged.

At a boundary, the owner schedules a checkpoint of each live terminal's existing
emulator queue before accepting later bytes into the new segment. It neither
restarts PTYs nor resets emulators, so shell variables, alternate buffers, mouse
modes and the actual visible screen continue. A checkpoint is a physical terminal
screen at that boundary, not a native transcript: it can still contain visible
content from earlier segments. Raw logs contain only the bytes attributed to
their segment. Exited terminals get a final checkpoint for their exact generation.

Checkpoint format 1 carries immutable runtime identity, segment descriptor,
terminal generation/geometry, a `through` cursor and serialised screen data.
Private atomic files under `segments/` are keyed by segment, terminal and
generation. Authenticated `segment-snapshot` reads validate all those fields and
the runtime identity, use bounded asynchronous file IO, and recheck controller
authority before responding. Missing, oversized or invalid records fail explicitly;
they never fall back to a different segment's screen. Normal shutdown drains
pending checkpoint writes before releasing ownership.

The foundation bounds in-flight checkpoints to 64 captures and 16 MiB of encoded
writes. It conservatively budgets 256 segments, 1,024 distinct raw-log files,
64 MiB of raw output and 64 MiB of encoded checkpoints over an owner's lifetime.
Empty output consumes no file slot; existing streams may keep recording when
new streams are refused. Exceeding those budgets or failing
a checkpoint write sets sticky `history.gap`; PTY drainage, current snapshots,
native events and process continuity remain independent. These are temporary
foundation bounds, not the completed retention policy. Production acknowledgement,
archive retention and host-wide storage accounting must reclaim history budgets
without deleting live resources. Essential journal gaps still block safe event
reconciliation independently of missing bulk history.

## Terminal titles

Retained `osc-title` observations carry an exact segment id, main-terminal
generation and the existing normalised 80-character title. The owner parses only
the main PTY, retains at most 4 KiB of a partial sequence and resets parsing and
deduplication at native switches. Title observations coalesce within the trailing
observation run; lifecycle/control events preserve earlier placement titles.
The daemon validates segment and generation before committing `osc_title` with
the observation cursor. User overrides and native conversation names are untouched.
Existing session invalidation refreshes frontend labels; extra-shell titles are
excluded. This addition is part of the initial unshipped private 1.0 contract and
changes neither public protocol.

## Terminal colours

Optional launch `theme` seeds the latest frontend foreground/background before
the main PTY starts. Owner state exposes `theme: null` until a report exists, then
the bounded `#RRGGBB` pair. Omission identifies older experimental owners without
this support. Private `theme` requests require the current controller sequence and
exact placement, and replace the owner's colours without sending unsolicited
terminal input. The PTY manager answers OSC 10/11 queries from that state for the
main terminal and extra shells, including while puddled is absent.

The daemon coalesces current frontend reports into ordinary owner reconciliation.
It inspects after uncertain acknowledgements; a matching state requires no resend.
A replacement daemon with no report leaves retained owner colours untouched.
Colours are replaceable state, not essential lifecycle journal entries. The new
private fields are part of the unshipped runtime 1.0 contract; the existing public
theme message and application/remote protocol versions are unchanged.

## Current attention

Owner state optionally exposes `attention`, null or one bounded condition with
UUID, exact segment, reason (`waiting_input`/`exited`) and timestamp. Older owners
omit it. `attention-state` is a disposable change signal that prompts inspection;
it is not retained in the essential event journal. Providers entering idle create
a fresh condition; resumed work, a native switch and deliberate termination clear
it. Natural main-agent exit replaces it. The final owner state retains the last
condition for exclusive retirement/reconciliation after exit.

Private `attention-preview` reads require the exact attention UUID and committed
placement. The owner returns at most 4,096 characters of terminal text, rechecking
controller, placement and attention after the asynchronous capture. No snapshot
from a replacement condition is substituted.

Migration 038 stores only current attention metadata, its observed cursor and a
delivery claim per owner. Older inspections cannot regress it. The daemon waits
for settled reconciliation, checks current placement/status and explicit stop
intent, and coalesces outages to the latest condition, expiring delivery after
five minutes. Four bounded preview reads may run concurrently. Claiming before
emission prevents repeat alerts after restart; a crash between claim and emission
can lose an alert. There is no historical backlog, exactly-once delivery promise
or automatic resend. Existing provider-owned native previews and public
profile-filtered notification paths remain in use. These initial private 1.0
fields change neither application nor remote wire shapes.

Terminal owners optionally expose `terminal_agent`, a bounded provider-id hint or
null. `terminal-agent-state` is a replaceable inspection signal, outside essential
journal retention. Older owners omit the field. Only the selected, authenticated
live owner supplies the existing public terminal hint; disconnect removes it.
The owner restricts process inspection to its main PTY, never extra shells or a
host-wide scan per owner. Existing adapter patterns and foreground ancestry rules
apply. Busy evidence arms one idle attention condition; successful inspection can
prove child exit while the shell remains live. Changed identities, lost hints and
resumed work clear prior attention. Suspension, backgrounding and failed scans
cannot establish exit. A terminal stays `running` while its main shell is live,
including when its child emits attention; no native conversation is adopted.
These additions remain within the initial unshipped runtime 1.0 contract.

## Provider execution

The private launch may select a provider, its config directory, execution mode,
permission choice and exact resume ref. It does not embed the application's
mutable `Account` object. The runtime uses the shared built-in adapter registry;
flags, version checks, native parsers and lifecycle resources remain provider-owned.
Failed interactive integration launches with `native_sync: fallback`; failed or
absent headless control refuses the launch and retains a failed final record.

Provider hooks use the existing nonce-based signal contract at a runtime-owned
loopback endpoint. It accepts only its one nonce, bounds simultaneous requests and
body bytes, rejects browser Origins, and closes when the main agent exits. Neither
the nonce nor the hook URL is returned through runtime discovery. Internal hook
and sidecar ports are reported as hidden ports to the adopting controller.

Provider-owned source maps are copied once into the runtime's private `helpers/`
directory before launch. Files are read-only, bounded to 16 files, 512 KiB each
and 1 MiB in total. `assets.json` format 1 records their SHA-256 digests and the
real path of the owner's Node executable. This is a private inventory, not a
separate communication protocol or permission to recreate a lost owner.

Claude/Gemini account hook commands use a stable V1 shell dispatcher; OpenCode's
account plugin uses a stable V1 module loader. Both select the runtime's helper
directory from its owned environment. The shell dispatcher also uses its pinned
Node executable. Captured environment variables cannot override these paths.
Missing pinned assets fail rather than executing a newer account helper. Legacy
in-process launches without runtime asset variables retain account-local helpers.
Dispatcher names, arguments and selection semantics must remain compatible with
all retained builds when shared account configuration is rewritten.

Mutable turn-correlation records live under `hook-state/`, separately from helper
sources; control disposal removes its nonce-specific record there. Claude's
status-line telemetry remains in the managed account so existing usage readers
can find it. Only the owned legacy status-line command is migrated; custom
commands and extra status-line settings are preserved. Release packaging and
collection must still keep the recorded Node/native dependencies available for
the runtime's entire lifetime; helper copies alone do not establish that guarantee.

## Private shell observations

The optional launch `capture_env` carries the profile's capture policy and a
bounded private seed map, separately from command environment overrides. Omission
disables capture. The owner enforces the existing denylist, 128-variable limit,
32 KiB UTF-8 value limit and bounded warning deduplication. Empty values remain
distinct from unsets. Disabled capture neither consumes reports nor injects saved
values; it retains the saved map for re-enabling. Inspection exposes only the gate
and count. The owner caches current accepted values for future PTY spawns:
process environment → captured map → explicit adapter/hook command overrides.
Callers must not put a stale captured map in command overrides. Provider launch
resources receive the same initial captured environment as their main PTY.

OSC filtering happens before logs, terminal emulators and output events. Accepted
reports become private `env-delta`/`cwd` events with terminal generations. Values
may appear in the owner-only launch/journal files and authenticated controller IPC,
never in ordinary inspection, terminal replay or public event broadcasting.
Directory reports remain private absolute observations; the daemon must apply
its existing placement-kind, filesystem and worktree-relative validation before
changing the application's public cwd field.

Repeated reports coalesce within the journal's trailing observation run: by
variable name across shell tabs, and by terminal generation for cwd. Every other
retained event is a barrier, including native lifecycle, terminal exit, capture
policy and purge. A newer report cannot erase a previous placement's environment
before its lifecycle event. Returned pages are immutable copies, replacement
reports receive newer cursors, and acknowledging an earlier offered page does
not remove its newer replacements. Reconciliation applies accepted observations
in order with its database cursor; it must not re-run launch-time admission checks
against intermediate states of a coalesced page. Journal pressure still leaves a
sticky gap and blocks complete adoption rather than stopping the PTY.

Explicit `capture-env` and `clear-env` commands use normal controller fencing and
sequence admission. They reserve journal capacity before changing the gate or
clearing the saved map, and retain the corresponding decision as an event. They
do not edit already-running shell processes, replay uncertain requests or write
the application database. Transactional application of these observations now precedes binding and
acknowledgement. `clear-env` replies with `env-cleared`, the exact removed-variable
count and the retained event cursor (`through`). The daemon waits for that cursor
to commit before returning the existing application purge response. This is part
of the initial unshipped runtime 1.0 contract; application and remote shapes do
not change. Profile capture policy converges through inspect/change/reconcile;
uncertain shell creation and purge requests are never retransmitted.

## Native conversation ownership

Native conversation claims are keyed by profile/provider/native ref, independent
of account and placement. Each owner acquires the new claim before releasing the
previous one; a session-end hook alone does not release a claim while the agent
can still switch. A collision records the exact ref and stops the incoming
runtime. The daemon must resolve the surviving owner through authenticated
adoption, not a stale PID or guessed catalogue entry. These locks use the same
OS-released claim primitive as runtime ownership, without a central broker.

## Automated turns

`start-turn` admits one provider operation and returns its running state promptly.
The operation belongs to the runtime; controller disconnection does not cancel it.
Its identity is `(runtime id, incarnation, turn number)`. Turn numbers must exceed
the runtime's previous admitted number, independently of request UUIDs and the
runtime command sequence. Numbers already admitted remain rejected even
after their events have been acknowledged. There is no automatic resubmission.

Admission checks the exact expected native conversation and the adapter control's
readiness. A new headless conversation may start with a null expected ref; its
first exact binding is accepted and a subsequent native switch interrupts the
operation. Human input takes over, and explicit cancellation addresses only the
specified turn. Cancellation settles the automated operation and signals the
adapter; it does not assert that the native agent is idle or terminate its runtime.
Late completion/rejection cannot overwrite cancellation or interruption.

`turn-result` inspects the latest admitted turn, including after controller
replacement. Older results are recovered through retained events until database
commit and acknowledgement. An unavailable result never authorises replay.
Runtime inspection includes the latest turn's identity and status without copying
its reply into every state response. Provider exceptions, oversized replies and
runtime exit produce bounded failed/interrupted outcomes.

Prompts and output-schema JSON are each bounded to 64 KiB; replies are bounded to
256 KiB of UTF-8. Before dispatch, the owner verifies journal persistence and
reserves space for the admission and worst-case JSON-escaped result. Admission is
refused when capacity is unavailable. Other essential traffic cannot consume that
reservation; unacknowledged results can therefore block further automated turns
until the daemon commits and acknowledges them. Journalling still reports actual
disk failures and history gaps; reserved memory is not a disk-space guarantee.

The journal records `turn-started` and `turn-finished` exactly once for an admitted
operation. The daemon must persist its mapping from programme/run operation to
runtime/turn identity before dispatch. Reconnection inspects that identity and
never restarts an interrupted puddlang programme or submits its prompt again.
The runtime backend routes programme asks through this contract.
Migration 035 reserves the exact run/operation/runtime/turn/placement/segment/ref
mapping before one dispatch. Admission loss observes committed private outcomes;
it never resends the prompt. Daemon shutdown interrupts the programme without
cancelling accepted external turns. Explicit user cancellation addresses only its
original turn and placement, and is never retargeted after a native switch.
Migration 036 records programme spawn ownership with placement creation and binds
the exact owner with launch intent. Durable cancellation fences undispatched
spawns; boot never auto-resumes an unstarted programme spawn. Cleanup targets the
recorded runtime even if its former placement has a replacement, and programme
events report unconfirmed stops. Explicit cancellation can retry those stops after
runner loss; daemon boot does not replay them. These application-side mappings
change neither public wire contract.

Migration 037 bounds application-side results to 128 records/16 MiB per owner.
Exact authorised programme reads mark terminal outcomes consumed; this is not a
runner-delivery acknowledgement. Capacity pressure reclaims the oldest consumed
outcomes, retaining unread and running results. Admission reserves worst-case JSON
reply bytes before sending a prompt; a full unread store refuses dispatch.
Reclamation shares the intent/observation transaction, so failed commits retain
old results. A separate monotonic watermark prevents identity reuse after pruning;
existing results migrate as unread. There is no expiry or automatic disposal of
unread outcomes, even after their programme ends. Application 26.1/migration 040
adds exact explicit local/SSH read/discard dispositions for finished programmes,
with transactional consumption and metadata-only audit. It does not assert reply
delivery or replay execution. Host-wide accounting remains a rollout gate.
No runtime wire fields change.

## Private records and ownership

The initial unshipped format-1 launch context now optionally carries `environment`
(the daemon's baseline, below captured values and command overrides) and
`shell_hooks: true` (private pinned shell scripts are required). New launcher
records set both. Earlier experimental records omit them. The shell-hook layout
and control-variable semantics must remain readable for live older owners; missing
pinned files are an error rather than permission to load mutable replacement code.
These private record additions do not change the application or remote contract.

The daemon's bounded launcher records context and SQLite intent before dispatch.
It holds a separate OS `runtime-launch` claim until adoption or an uncertain result;
retirement and supervisor collection acquire that claim before the owner claim.
This prevents recovery from fencing a queued launch while its initiating controller
is still waiting. A lost supervisor acknowledgement triggers inspection only.
Shutdown drains launcher operations before closing writers. Standard daemon
composition routes terminal and interactive/headless agent create/resume,
including code-execution terminals. Their canonical managed run directory is
referenced in application SQLite alongside launch intent, so cleanup retains it
through controller replacement and uncertain owner outcomes. Only a confirmed
clean owner exit releases that reference; the resumed terminal never repeats its
programme. These application-side references add no private wire fields. Default
launches resolve the installed runtime selector; no product backend toggle exists.

Provider context optionally carries `initial_ref` for a new preset-id launch or
`prior_refs` for a provider that mints its own ids (at most 16,384 ids, each at most
200 characters). Neither accompanies `resume_ref`. The declared initial/resume ref
must match the prepared placement. The owner claims it before spawning; adapters
still choose their own launch/resume flags. The initial unshipped runtime 1.0
contract evolves with both peers; these private fields do not alter the application
or remote protocols. Recovery reads the selected owner's identity-checked launch
record, excludes pre-existing ids and refuses multiple new candidates. Catalogue
recency never identifies a live native conversation.

A failed/exited private state record allows the launcher to release its launch
claim and attempt retirement. It does not prove process death: retirement still
requires the exclusive owner claim and complete final journal reconciliation.
Missing, incomplete or mismatched records retain uncertain ownership.

Launch records use format 1 and are read only from private host storage. They
contain the environment and per-runtime secret and must never be returned by
application discovery. Before starting a command, the owner consumes that launch
with an exclusive, fsynced marker. Neither supervisor restart nor lost startup
acknowledgement can start it again.

SQLite-backed, empty claim files provide OS process-lifetime locks for runtime
and controller ownership without heartbeat expiry or PID assumptions. They
contain no session data. Never unlink or replace a claim file while any process
can own it. The controller record's monotonically increasing epoch fences old
connections; the exclusive controller claim serialises its replacement.
The daemon now holds this claim for its application lifetime and opens known
owner connections before legacy boot reconciliation. Durable live bindings are
protected from blanket interruption and legacy controls, even after connection
failure. The reconciler commits retained observations and immutable segment
mappings before binding the placement and acknowledging journal pages. A confirmed
owner loss imports all final pages under the exclusive claim before closing its
binding; incomplete history leaves reconciliation pending. Shutdown detaches
owners and releases the controller after application writers have stopped.

Application terminal viewers now use these existing private messages without a
wire-shape change. Migration 032 retains exact segment/terminal generations and
explicit placement-to-backend selection. Viewers hold the resolved address for
snapshot/input/resize, buffer only bounded output behind the snapshot cursor and
recheck authority before dispatch. Native switches or disconnects invalidate the
attachment; uncertain commands and queued paste suffixes are never replayed.
Historical screens use the same validated immutable checkpoint reader when their
owner is absent. Extra-shell creation/termination, purge and explicit stop/archive
also route through the owner. Mutations retain their original placement through
bounded serial queues and recheck request authority at dispatch. Migration 033
persists stop intent before sending it once; the daemon observes a lost response
and requires complete clean exit before archive. Explicit stop intent suppresses
automatic recovery. Worktrees stay protected while external ownership or descendant
cleanup is unresolved. Production creation/resume/migration, provider-command
routing and theme/notification integration now use these owner controls. Native
provider acceptance and host-wide retained-storage accounting remain separate gates.

Port scanning uses authenticated `inspect` results to obtain current terminal and
provider-sidecar roots and exclude advertised hidden ports. It never trusts disk
state for process liveness. Scans retain a committed placement/segment and owner
connection; lifecycle/process changes invalidate both pending and cached results.
Unbound, historical and disconnected owners expose no ports. Existing application
port discovery and proxy routes consume these results without a wire-shape change.

Migration 039 atomically queues ended registrations for bounded daemon cleanup.
An indexed pending queue advances through 32-row pages with four concurrent
removals. Launch, dispatch and owner claims exclude pending launches and live
owners; the exact host/runtime service label is validated before any command.
Retirement markers fence delayed starts. Positive absence inspection handles
already-removed registrations after lost replies, while other errors retain the
pending row. Completion receipts survive daemon replacement. Shutdown drains
commands before database closure. Registration cleanup never collects private
records or pinned builds and does not prove unmanaged descendant cleanup.
No wire or private record schema changes are needed for this application-side queue.

Confirmed loss is recorded under the runtime's own exclusive claim. A durable
retirement marker fences any delayed launcher before releasing that lock. A
failed socket connection, permission error, malformed record or protocol mismatch
alone cannot trigger interruption or auto-resume. SQLite runtime bindings retain
launch identity and commit an observation cursor with its application effects in
one transaction; acknowledgement follows commit.
