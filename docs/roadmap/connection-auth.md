# Connection authentication

Status: the local/SSH foundation is implemented in protocol 18.0. Self-hosted
mobile access is implemented in the separately versioned remote protocol 2. The [implementation contract](short-lived-connection-tokens.md)
records concrete lifetimes, migration and verification; this document retains
the architectural rationale and shared transport boundary.

## First-phase scope

Deliver this foundation independently of mobile access. Keep the host master
credential on the host, issue short-lived connection tokens backed by
host-enforced leases, and separate browser authorisation from upstream
connection lifetime. Cover the existing CLI and desktop cockpits, local and
SSH connections, REST, WebSockets, and proxy paths, including migration from
the currently distributed master token.

The foundation shipped independently. The [mobile implementation](mobile-access.md)
now adds phone input/layout, host device approval, an outbound connector and a
self-hosted encrypted relay around that authority. Tunnel/Access and hosted
operation remain outside the implementation.

## Compatibility and change boundaries

The foundation fits the existing daemon/web split. The daemon continues to own
Puddle placements, live runtimes, PTYs, worktrees, SQLite, and replay. Existing
React views and API operation meanings can largely remain. First-phase changes
belong around authentication, connection management, and the current HTTP/WS
transport. The relay/connector subsystem builds on those boundaries.

| Area                                                       | Expected work                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Session/worktree services, agent adapters, PTY persistence | Reuse existing ownership and behaviour; remote access must not create a competing lifecycle                                                  |
| Daemon authentication                                      | Add one consistent connection-authority model for REST, WS, and proxy paths                                                                  |
| CLI/desktop cockpit                                        | Replace transparent credential forwarding with an authenticated browser boundary and upstream credential management                          |
| Web data transport                                         | Update `api.ts`, `ws.ts`, and auth/bootstrap for the new credentials; audit binary transfers, direct fetches, downloads, previews, and links |
| Web presentation                                           | Preserve existing desktop views; narrow presentation uses kept-alive terminals and local drafts                                                       |
| Relay, host connector, remote enrolment, service operation | Implemented self-hosted subsystems reusing the completed host authentication boundary                                                                    |

A conventional HTTP tunnel can preserve the browser's same-origin request
shape. An opaque end-to-end encrypted relay also needs a browser transport
that encodes API requests, responses, binary transfers, and terminal messages
inside the authenticated encrypted channel. It is not merely a reverse-proxy
configuration change. Upload/download streaming, cancellation, ordering, and
backpressure are part of that later transport work, not prerequisites for
shipping the authentication foundation.

## Implemented local and SSH boundary

- Daemon `security/leases.ts` owns hashed connection tokens, monotonic leases
  and explicitly renewed stream resources. `security/control.ts` accepts only
  private local IPC; the SSH helper relays client participation, never renews
  autonomously and never exports the host master credential.
- CLI `lib/auth/` owns control channels, host-only legacy inspection and
  launcher IPC. `lib/serve/` authenticates browser requests, substitutes current
  connection credentials and bridges both WebSocket authentication handshakes.
- Browser `auth.ts` exchanges single-use invitations for cockpit credentials.
  Cockpit storage persists verifiers scoped to origin and target for 30 days
  of inactivity. Upstream loss preserves login; correlated refresh waits for
  a replacement instance to complete its daemon handshake.
- Proxy links use a trusted cockpit landing page and an isolated `127.0.0.1`
  application origin with target-scoped HttpOnly cookies. Application requests
  never receive Puddle credentials, and application scripts cannot read the
  cockpit's `localhost` localStorage.
- Tunnel availability is separate from debounced notifications and SSH child
  lifetime. Closing control revokes immediately; silent partitions expire in
  45 seconds. Fresh generations revalidate the daemon before reopening access.

## Agreed credential separation

Distinguish three lifetimes. These are authentication concepts, not new Puddle
sessions or native conversations.

A connection token is the short-lived credential presented to the host. Its
connection lease is the host-enforced authority record governing scope,
generation, renewal, expiry, and revocation. Token possession alone must not
allow the holder to renew that authority.

| Credential/authority     | Holder and verifier                                        | Lifetime                                                                                                               |
| ------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Host bootstrap authority | Trusted local host process; daemon or local access service | Long-lived, host-only; used to establish delegated authority                                                           |
| Connection lease         | CLI/connector; verified by host access service             | Short-lived, scoped to one logical connection and generation; renewable only through its authenticated control channel |
| Browser authorisation    | Browser; verified by its cockpit or paired host connector  | Independently bounded and revocable; may survive transport reconnection                                                |

The implementation uses OS-protected local IPC as host bootstrap authority.
The migrated master remains host-local and is not accepted on data paths. Neither is a browser
credential. In SSH mode a host-side helper obtains a lease through the local
authority and returns only that delegated credential over the authenticated
SSH channel. Stop fetching the master token onto the client.

The local cockpit authenticates its browser, then substitutes its current
connection credential when talking to the host. That credential stays in the
cockpit process, never in browser storage or a copied URL. Browser bootstrap
uses a separate one-time secret, exchanged for cockpit-scoped authorisation.
The local HTTP credential mechanism needs its own review: cookies are not
isolated by localhost port, so HTTPS remote cookie assumptions cannot simply
be copied to every localhost cockpit.

Local mode uses the same lease rules with a local control channel instead of
SSH. Each cockpit/viewer connection has its own authority; closing one must
not invalidate other clients.

The relay path checks the Noise-authenticated browser identity against durable
host approval; a relay login cookie authenticates the service account separately.
The connector obtains daemon authority only after approval, using the shared
manual-participation HostControlClient. Fresh encrypted browser challenges renew
explicit resource ids; a healthy connector cannot renew an absent browser.
The master token never enters the relay. See [mobile access](mobile-access.md)
for pairing, recovery, encryption and the separately trusted application origin.

A bearer lease returned over SSH is still a credential that can be replayed
while valid if stolen. Labelling it with a tunnel id does not cryptographically
bind it to that tunnel: the daemon sees loopback connections from forwarding,
not the original SSH identity. If strict channel binding is required, carry
requests over the authenticated channel that owns the lease, or use a reviewed
proof-of-possession design. If the requirement is that no daemon-accepted
credential may leave the host at all, terminate client authorisation in a
host-side broker and keep its daemon credential behind that boundary.

## SSH loss and reconnection

Connection lifecycle:

1. After SSH authentication, open a dedicated application control channel and
   have the host create a connection lease. Associate it with a specific
   cockpit connection and generation, not a local port, SSH child pid, or the
   entire shared ControlMaster.
2. Renew the lease through authenticated control-channel heartbeats. API calls
   or possession of the data credential alone cannot renew or mint leases.
   A host-side monotonic expiry deadline bounds orphaned authority if a helper
   crashes or the network partitions. Participation is every 15 seconds with a 45-second monotonic lease; tokens
   rotate every 30 seconds and expire absolutely after 60 seconds. Notification
   debounce is not part of the security budget.
3. On known channel closure or explicit disconnect, revoke that lease and
   reject new operations immediately. Stop forwarding on the client as soon
   as it detects loss. On an undetected partition, host-side lease expiry
   supplies the bound: instantaneous detection of network loss is impossible.
   A timer that simply keeps renewing on the host despite no client responses
   would not provide that guarantee.
4. On revocation/expiry, close all associated REST streams, WS attachments,
   and proxy connections. Guard message dispatch as well as handshake entry;
   discard unsent work from that generation. Already-dispatched operations may
   have taken effect and cannot be assumed undone.
5. Re-establish SSH, verify the expected host, acquire fresh authority, and
   complete the protocol handshake before reopening the data path. When replacing
   a lease, invalidate the predecessor atomically. Late cleanup from the old
   generation must not revoke the new one, and a still-valid stale bearer must
   not acquire replacement authority.
6. Keep the browser's cockpit authorisation through this transient outage,
   subject to its own expiry. Show reconnecting, replace the upstream lease
   inside the cockpit, and restore terminal attachments/snapshots. Do not
   reinterpret upstream unavailability as browser logout: only `browser_rejected` clears browser credentials; upstream failures have
   separate error codes. Never silently replay stdin or ambiguous mutations.

This offers seamless reconnection without handing the browser a new daemon
credential on every network hiccup. Independently revoked/expired browser
authorisation must still require valid reauthentication; an expired token
cannot itself be the authority for obtaining its successor. Automatic SSH
reconnect also remains contingent on available credentials: a detached CLI
cannot satisfy a fresh interactive password/MFA prompt.

OpenSSH's own liveness checks are timeout-based. The current client requests
`ServerAliveInterval=15` and `ServerAliveCountMax=3`; that does not establish
a host-side revocation deadline. The distinction between client and server
checks is documented in [ssh_config](https://man.openbsd.org/ssh_config#ServerAliveInterval)
and [sshd_config](https://man.openbsd.org/sshd_config#ClientAliveInterval).
For live-connection invalidation, see
[OWASP WebSocket session management](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html#session-management).

## Authority and process lifetime

Revoking a viewer lease detaches the viewer; it does not terminate the agent,
delete its placement, or discard terminal history. Keep this separate from
the existing `DaemonLease`, which describes the SSH-attached daemon's process
lifetime. That fallback still stops when its owning cockpit closes; changing
credentials alone does not make that daemon persistent.

Short-lived credentials reduce accidental exposure and continuing reuse of a
stolen credential. They do not sandbox a fully authorised shell: someone able
to execute arbitrary commands as the host user may read host secrets or
establish persistent access before revocation. Profiles remain organisational;
permission scopes cannot promise isolation while granting unrestricted PTY
input as that same OS user.

## Agreed delivery summary

The [implementation contract](short-lived-connection-tokens.md#acceptance-and-delivery)
expands the following sequence into workstreams and verification criteria.

1. Establish the shared host authority and lease lifecycle for existing local
   and SSH cockpits. Update REST, main WS, proxy HTTP/WS, cockpit controls,
   terminal attachment, CLI status/log commands, bootstrap, and desktop
   consumers together where they rely on the current token flow.
2. Migrate browser authentication and bootstrap. Replace token-bearing proxy
   links, clear old browser storage, and remove persisted master-token URLs.
   Rotate the previously distributed host master token during migration, with
   coordinated client reconnection; stopping future distribution does not
   revoke copies that already exist. Keep local administrative recovery.
3. Complete foundation acceptance before beginning mobile access or relay
   implementation. Test normal close, silent partitions, helper/client crashes, ControlMaster
   reuse, port changes, daemon restart, concurrent cockpits, stale callbacks,
   old credential rejection, and revocation of already authenticated sockets.
   Verify transport loss preserves daemon-owned work and never repeats writes.
4. The implemented [mobile access extension](mobile-access.md) follows this foundation. Relay connections reuse the same
   host authority model. Connector/relay cryptography remains a separate
   transport layer with its own review gate, not something lease tokens provide by themselves.

The foundation is complete when local and SSH CLI/desktop workflows use the
new short-lived connection tokens; master credentials no longer leave the host
through Puddle's bootstrap or serving paths; old distributed credentials are
invalidated; expiry/revocation close existing streams; and reconnect obtains
fresh authority without logging out a still-authorised browser or replaying
uncertain writes. Browser authorisation retains its own expiry and revocation.
No mobile, relay, or provider deployment is required to meet this milestone.

Changing existing daemon authentication/token flow requires a major protocol
bump under `packages/shared/PROTOCOL.md`, even if API operation payloads remain
unchanged. The implementation must define shared schemas and update SPEC and
the changelog together. Lease durations, private IPC and browser credential
storage are resolved in the implemented [connection-token contract](short-lived-connection-tokens.md).
The independently versioned remote transport reuses that authority without
changing the protocol-18 host authority contract. Protocol 18.1 adds authenticated
local/SSH cockpit administration for the desktop remote-access settings.

The OAuth-only service revision uses remote protocol 2 and daemon/cockpit protocol
19.0 for the changed pairing invitation contract. Host-authority semantics remain
unchanged; account login supports Google/GitHub, with no email/password machinery.
