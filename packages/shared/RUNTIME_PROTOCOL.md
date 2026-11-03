# Private runtime protocol

Status: runtime foundation under development; production sessions still use the
in-process daemon backend. The full delivery scope is tracked in
[the persistent runtimes roadmap](../../docs/roadmap/persistent-runtimes.md).

`RUNTIME_PROTOCOL_VERSION` starts at **1.0**, independently of application
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
placement switching and production programme reconciliation are still required
before enablement.

## Compatibility

The same major is compatible; additive minor capabilities must be detected before
use. A different major is an adoption error, never proof of runtime death. New
required fields, removed operations, changed meanings and authentication changes
require a new major once this contract has shipped. The initial unshipped 1.0
contract is developed together with its first owner/client implementation.

The host presents runtime id, incarnation, launch id and build independently of
its current controller. The controller proves the private runtime secret plus
its current host-controller id/epoch. Application/browser credentials, remote
leases and provider hook nonces cannot authenticate this socket.

## Framing and bounds

Each frame is a four-byte unsigned big-endian byte length followed by one UTF-8
JSON object. Length and UTF-8 are validated before schema dispatch. Frame and
queue limits are exported as `RUNTIME_LIMITS`; receivers bound both pending
request count and encoded bytes. A slow controller is disconnected without
blocking PTY drainage. No unbounded replay queue is maintained for disconnected
controllers; terminal attachment obtains a new snapshot.

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
history, while continuing to drain PTYs. Production segment-to-placement binding
and a deliberate recovery flow for incomplete history remain required before enabling
the production backend. Normal shutdown reaps terminal exits and flushes the
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
writes. It conservatively budgets 256 segments, 64 MiB of raw output and 64 MiB of
encoded checkpoints over an owner's lifetime. Exceeding those budgets or failing
a checkpoint write sets sticky `history.gap`; PTY drainage, current snapshots,
native events and process continuity remain independent. These are temporary
foundation bounds, not the completed retention policy. Production acknowledgement,
archive retention and host-wide storage accounting must reclaim history budgets
without deleting live resources. Essential journal gaps still block safe event
reconciliation independently of missing bulk history.

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
That production caller integration is not enabled by this private IPC foundation.

## Private records and ownership

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
routing, theme/notification integration and retention remain separate gates.

Port scanning uses authenticated `inspect` results to obtain current terminal and
provider-sidecar roots and exclude advertised hidden ports. It never trusts disk
state for process liveness. Scans retain a committed placement/segment and owner
connection; lifecycle/process changes invalidate both pending and cached results.
Unbound, historical and disconnected owners expose no ports. Existing application
port discovery and proxy routes consume these results without a wire-shape change.

Confirmed loss is recorded under the runtime's own exclusive claim. A durable
retirement marker fences any delayed launcher before releasing that lock. A
failed socket connection, permission error, malformed record or protocol mismatch
alone cannot trigger interruption or auto-resume. SQLite runtime bindings retain
launch identity and commit an observation cursor with its application effects in
one transaction; acknowledgement follows commit.
