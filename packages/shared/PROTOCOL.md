# The puddle communication protocol

Application **26.2** adds opt-in component release catalogues. Private status and
remote maintenance status accept `include_component_releases: true`; supporting
cockpits/connectors request it only for opted-in reads (`?components=1`). Older
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

Protocol 25.17 adds the explicit `continue-offline` cockpit update action and optional
`offline_continuation` capability. The action carries only an exact operation id/revision;
it uses the selected local/SSH transport and existing cockpit browser authority/Origin
checks. It never follows automatically from a failed live request. Compatible staged
daemon metadata must advertise 25.17 or newer before invoking the pinned participating
recovery entry. Earlier staged builds retain CLI recovery but are not offered this action.

The existing private host-update request/reply envelope travels over a dedicated helper
channel whose input stays open through validation. EOF, browser/request cancellation,
helper interruption or cockpit reconnection revokes uncommitted dispatch. The worker
checks participation immediately before durable acceptance; accepted independent work
continues even when the viewing request ends. Exact repeated accepted requests observe
their recorded result. No daemon lease is minted or renewed, no browser/host credential
flow changes, and no relay grant or operation is added. The capability is an offer,
not fresh admission or service-health proof. Application 25.17 is additive; remote 4
and runtime 1.0 remain unchanged.

Protocol 25.16 adds optional `observation: live | recorded` to local/SSH cockpit
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
repository in both platform release jobs; cockpit preparation obtains that source
from private host status rather than a browser field or client-side override.

Cockpit status optionally carries the catalogue after capability detection.
`host-updates-changed` invalidates host-wide status viewers after release discovery
or control mutations. Profile-scoped remote leases receive neither the catalogue
nor this event, and no remote maintenance permission is added. Older status requests
retain their exact reply shape. Settings controls and window offers consume these reads;
remote 4 and runtime 1.0 are unchanged.

Protocol 25.13 adds capability-detected local/SSH `GET/POST /cockpit/updates`.
GET returns daemon availability/version, supported approval/recovery actions and a
bounded public operation summary. POST accepts preparation of exact release targets,
inspection, exact-fingerprint application, cancellation and supported live recovery.
Preparation reuses the CLI's staging code and does not activate a release. The
gateway stamps its own protocol and excludes browser-supplied receipts, paths,
tarballs, commands and host selection. It strips private stage/worker evidence and
blocker target paths from replies. Browser authority and exact mutation Origin are
required. Each request opens a cancellable channel through the existing host-control
client, bounded by the original cockpit connection and browser request lifetime;
revocation before host dispatch closes that lease without revoking other viewers.
Accepted host dispatch remains durable. Lost replies are observed, never retried or
sent through an offline fallback. Older compatible daemons remain usable and expose
only supported actions; old cockpits return 404. Offline cockpit recovery remains
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
  remote protocol remains 2 and daemon/cockpit protocol remains 19.0.
- **Follow-clone default (2026-09-30)**: repository registration now defaults
  to the already supported empty base-branch setting, and migration 023 resets
  existing saved defaults once. Explicit empty/non-empty values, PATCH omission,
  session requests and response shapes are unchanged. This changes the default
  policy, not the meaning of a supplied value; daemon/cockpit remains 22.0 and
  remote protocol remains 3.

## Remote transport

`REMOTE_PROTOCOL_VERSION = 5` versions the separate service/connector/browser
contract in `src/remote/`. Its strict envelopes and Noise prologue require an
exact match; incompatible peers fail closed. Its introduction did not change
daemon protocol 18.0. Turning the existing server WS union into an equivalent
zod schema did not change that wire contract. Protocol 18.1 adds local/SSH
`/cockpit/remote` administration; it does not change the remote envelope or
host-authority semantics. Older connector builds are capability-detected before
the cockpit invokes their administrative commands.

Breaking changes to daemon operations exposed by the remote allowlist also
require a remote protocol bump: an unchanged envelope does not make changed
application messages compatible with a previously deployed browser build.

Remote protocol 2 removes email login from the service discovery/auth contract.
Daemon/cockpit protocol 19.0 accompanies its changed pairing invitation literal
in `/cockpit/remote`; host lease and operation semantics remain unchanged.
Deploy the service, browser and host connectors together.

Daemon/cockpit protocol 19.1 adds local/SSH registration deletion and an optional
capability in cockpit status. Older connectors keep their existing controls;
deletion is hidden and rejected until the host advertises support. The encrypted
remote admin schema excludes deletion, so remote protocol remains 2.

Daemon/cockpit protocol 20.0 adds desktop-initiated registration: an authenticated
cockpit polls a machine-only service endpoint with an ephemeral verifier, while
the signed-in application approves its public SHA-256 hash. This is a new token
flow, so the cockpit major advances. The existing connector code redemption,
Noise envelopes, pairing and host leases are unchanged; remote protocol remains 2.
The service and application must be updated to expose the new handoff endpoints.

Daemon/cockpit protocol 21.0 adds host-authenticated registration retirement via
machine-only `POST /remote/unregister`. The existing routing credential authorises
removal of its own service record only; browser Origin/cookies are rejected and
retries are idempotent. This adds an authentication flow, so the cockpit major
advances. Noise envelopes, pairing and host leases are unchanged; remote protocol
remains 2. Update the service and host connector for automatic cleanup; an older
service leaves private retirement requests queued until it is upgraded.

Daemon/cockpit protocol 21.1 adds `GET /api/worktrees/:sid/preview-asset`:
bounded base64 JSON for read-only remote previews. It uses the existing browse
root and host lease; the connector explicitly allowlists it. Existing operations
and remote envelopes are unchanged, so remote protocol remains 2. Update the
host daemon, connector and static app (including the sandboxed preview shell's
response CSP); newer clients hide the toggle below daemon 21.1.

Daemon/cockpit protocol 21.2 adds connector-local chunked image uploads and the
optional `remote_image_uploads` version capability. New browsers check that flag
before calling `/api/worktrees/:sid/paste-upload`; older connectors retain small
legacy pastes. Each chunk uses the existing bounded encrypted request envelope,
and finish uses the existing host-local paste route. Noise, authentication and
host leases are unchanged; remote protocol remains 2.

Daemon/cockpit protocol 21.3 accepts an empty `default_base_branch` on repository
creation and update to follow the clone's current branch for each new session.
At introduction, this added a previously rejected request value while non-empty
values and omitted fields retained their existing meaning (registration captured
the clone's branch; PATCH left it unchanged). Registration now defaults to empty
as described in the follow-clone default note above. Settings only offers clearing
the default on 21.3 or newer. Session requests, remote operations and authentication
were unchanged, so remote protocol remained 2.

Daemon/cockpit protocol 22.0 adds an optional profile to host-control `open` and
binds that profile to every resource in the lease. Remote connectors always
request this scope; local/SSH cockpit leases remain host-wide. The daemon filters
discovery and WebSocket events and checks direct session/project operations.
`/cockpit/remote` requires a profile query parameter; connector administration
uses validated profile envelopes on stdin (`cockpit controls 2`). This changes
authority semantics, so the daemon major advances. Remote protocol 3 accompanies
the change from host-wide to profile-only access. Upgrade the service, app,
daemon and connector together. Legacy host-wide registrations are deleted and
their approvals revoked; users register and pair each profile afresh.

Daemon/cockpit protocol 22.1 adds optional `Session.detected_agent_type`: a
transient icon hint for a recognised foreground agent inside a terminal session.
It leaves session kind, account, conversation identity and status unchanged.
Updates reuse the profile-filtered `sessions-changed` event; no remote operation
or authority changes, so remote protocol remains 3. Older daemons omit the hint
and newer clients retain the terminal glyph.

Daemon/cockpit protocol 22.2 adds the optional `notifications.when_focused`
profile preference (default true). Older peers retain their existing policy;
native notification delivery and its bounded result use capability-detected
desktop IPC only. Remote envelopes and host authority are unchanged.

Daemon/cockpit protocol 22.3 adds the `agent-notification` WS event for waiting
and unrequested agent exits, including observed agents in terminal placements.
It shares the existing session/profile-filtered status subscription. Older clients
ignore it; newer clients use status transitions on daemons below 22.3. Remote
protocol remains 3: envelopes, authority and allowed operations are unchanged.

Daemon/cockpit protocol 22.4 adds capability-detected connector-local push
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

Daemon/cockpit protocol 22.5 adds optional bounded content to `agent-notification`,
validated project/session notification destinations, and capability-detected
end-to-end encrypted push previews. New browsers send a preview key only when
the connector advertises `remote_notification_previews` and the service advertises
`push_encrypted_previews`; service registration explicitly rejects those keys.
The private connector IPC retries the legacy id-only request only after an explicit
rejection. Old clients ignore optional event content; old subscriptions retain generic
push. Noise admission, remote envelopes and host leases are unchanged (remote 3).

Daemon/cockpit protocol 23.0 adds local/SSH puddlang context, submission, status,
events and cancellation endpoints. Shared schemas also define runner IPC and
stdio MCP inputs. Existing authority/token flows are reused; remote profile
leases and the connector allowlist reject this namespace (remote protocol 3).
The major boundary is intentional for the puddlang rollout, despite the additive
endpoints. Upgrade daemon, CLI/desktop, and the remote connector/application to
matching daemon protocol 23.0. Existing launcher upgrade approval still applies;
puddlang itself requires an already compatible daemon and never upgrades one.

Daemon/cockpit protocol 23.1 adds optional `Session.agent_mode`, optional per-spawn
Puddlang `mode` (omission retains interactive), advertised adapter modes and
bounded native turn signals under the existing per-runtime nonce. Migration 025
preserves existing placements as interactive. `pudl` requires 23.1 so older runners
cannot silently discard the requested mode. Session creation through the public
REST API remains interactive; no remote operation or authority is added. Remote
protocol remains 3 and Puddlang remains excluded from remote leases/allowlists.

Daemon/cockpit protocol 24.0 renames the execution mode enum value `scripted` to
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

Protocol 24.2 adds cockpit-local `GET /cockpit/file-manager` capability discovery
and `POST /cockpit/file-manager` with a bounded absolute path to reveal. Both
require browser authorisation; POST also requires the exact cockpit Origin.
Only local-host cockpits advertise or invoke a file manager. SSH cockpits refuse
the operation even though their UI also lives on localhost; remote browser
transports never call these routes. Older cockpits return 404 and the UI omits
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
