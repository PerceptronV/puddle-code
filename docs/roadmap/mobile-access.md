# Mobile access

Status: implemented for self-hosting. Remote protocol 2 sits outside daemon
protocol 19.0 (the host-authority foundation shipped in 18.0). Deployment instructions are in [self-hosted mobile access](../mobile-access.md).
Automated tests and the remaining physical-device/security review gates are in
[mobile acceptance](../acceptance/mobile-access.md).

## Architecture and trust

The trusted web application and relay use distinct HTTPS origins under the same
site. The application is built with one service origin; an invitation cannot
change it. The connector runs under systemd/launchd on the agent host, independently
of the launching laptop. Both browser and connector initiate outbound WSS.
The daemon still accepts loopback traffic only. No VPN, public daemon listener,
router forwarding, hosted identity server or default hosted service is required.

The relay embeds Better Auth for Google/GitHub OAuth only and optional
passwordless authenticator MFA with recovery codes. At least one provider must
be configured. Every sign-in requires the provider's verified-email claim;
registration is closed to an email allowlist unless the operator explicitly
opens signup. There is no password login, email delivery or email recovery.
Service cookies are Secure, HttpOnly, host-only, SameSite=Lax; exact Origin checks
protect browser upgrades and mutations. MFA is also required after social sign-in
before a session can register hosts or open pipes. Authentication endpoints have
an explicit allowlist; provider account linking is unavailable. Recover the
original provider account through Google/GitHub; matching email addresses cannot
claim another provider identity's host records. Recovering service login grants
no new host authority.

The browser and connector use the maintained `@chainsafe/libp2p-noise` Noise XX
implementation, without discovery or a libp2p network stack. Ed25519 identities
authenticate the Noise handshake; its prologue binds the protocol, configured
service, host registration, pinned host identity and fresh relay connection id.
The library owns encryption, key agreement, forward secrecy and ordered record
authentication. Application chunks and request ids provide bounded framing, not
cryptography. The relay forwards opaque binary frames; it never receives daemon
credentials or application plaintext through the remote protocol.

This boundary depends on the application distributor. Application JavaScript
handles private keys and plaintext; a compromised distributor can steal them.
Separate origins are necessary but insufficient if the relay operator can also
replace the application files, TLS configuration or build. Deploy the static
application on separately controlled infrastructure when protecting against a
relay operator. No service worker caches source, output or credentials.

## Host approval and recovery

Desktop/local and SSH cockpits expose **Settings → Remote access** for registration,
status, pairing, exact-browser approval, revocation, disablement and confirmed
identity reset. These controls use the authenticated cockpit's existing host
transport and remain available independently of the relay. They are not added
to the encrypted remote allowlist. Only public connector metadata returns to
the cockpit; registration codes travel through stdin and are not persisted there.

`puddle remote enable` redeems a five-minute service registration code from hidden
stdin. Routing credentials stay in the host's private remote configuration; the
service stores their hashes. The host keeps its Ed25519 identity in a private
file and device records/revocations in private SQLite storage.

`puddle remote pair` or an approved browser issues a five-minute, single-use
invitation. Its link/QR contains the host identity and secret in the fragment.
The application removes the fragment before rendering and retains it only in
sessionStorage for a provider redirect. A new browser generates a key and saves
it to IndexedDB before enrolment. Storage failure blocks pairing. The host
atomically reserves the invitation for that exact Noise-authenticated browser
identity. The enrolling browser receives no daemon authority until local/SSH
`remote approve <id>` or an already approved browser approves its displayed key.
A relay cannot substitute the pinned host. An intercepted invitation cannot
approve its own browser.

Device grants expire after 30 days of inactivity or 90 days absolutely.
Re-pairing requires another explicit approval. Revocation is persisted before
affected viewers are disconnected; every dispatch checks current approval.
Local `remote disable` works without the relay, including an offline private-file
fallback observed by the connector within 500 ms. Revoking a viewer never kills
its agent. Requests already executed cannot be undone.

Lost browser storage requires new pairing. Losing every paired browser requires
local/SSH host access. `remote reset` is local/SSH only: disable access, revoke all
devices, and rotate the host identity. Re-enable and pair each browser afresh.
The application rejects changed host pins until the old local pairing is
explicitly forgotten. Back up the host's entire private remote directory together;
restoring an old device database can restore old grants, so rotate after uncertain
recovery. Service database recovery cannot recreate browser keys or host grants.

## Small authority boundary

`packages/connector/src/policy.ts` is the complete remote HTTP/terminal allowlist.
It rejects unreviewed paths, normalisation tricks, supplied upstream URLs and
browser credentials. Only the connector constructs loopback destinations, headers
and host credentials. Local/SSH and remote connections share `HostControlClient`
and the daemon's existing connection authority. The remote client uses manual
participation: an encrypted, fresh host challenge every 15 seconds must return
within 15 seconds with explicit resource ids. Replies are single-use, generation
bound and anchored to the challenge issue time. The connector cannot renew a
viewer's lease merely because its own relay connection is healthy. Lease expiry
is 45 seconds; token rotation/lifetime remain 30/60 seconds. Reconnect creates a
new generation, obtains snapshots and never retries uncertain writes.

The first remote surface includes project/session selection, session creation,
rename/resume/stop/archive, agent and shell terminal input/output, directory/text
reading, diffs and Git inspection. It excludes file writes/transfers, Git
mutations, account login terminals, host shell, `/proxy`, previews, cockpit refresh
and local synchronisation. Pairing still grants owner-level terminal control;
these exclusions do not make a sandbox or restricted account.

Limits are executable in `REMOTE_POLICY`: 48 KiB wire frames, 1 MiB stream queues,
16 MiB reassembled responses, 256 KiB request/input bodies, eight concurrent
requests, eight viewers per host, sixteen per account, 128 relay pipes and 64 MiB
aggregate relay write buffering. Handshake/first-frame deadlines are ten seconds;
HTTP operations and client waits are thirty seconds. Overload closes viewers
instead of accumulating unbounded output. Authentication, pairing, connection and
registration attempts are rate/capacity limited. The relay retains account/routing
state and MFA session confirmations, never terminal history or source. Access
logging is off; debugging cannot enable transport payload logging. The operator
still observes addresses, timings, sizes and availability and can deny service.

## Phone interaction

The remote application shows one terminal or read-only text review. The local
narrow workspace adopts the existing kept-alive terminal DOM instead of
flattening the desktop layout. Phone selection and drafts stay local; remote
storage/cache keys include service, account and host. Terminal instances survive
selection and breakpoint changes. Hidden viewers detach and do not send resizes.
The existing single-PTY-size rule remains: the last active viewer's attach/resize
wins. Remote host switching clears terminal registrations and query caches.

A native multiline textarea supports ordinary paste, Unicode, IME and dictation.
Send uses xterm's current bracketed-paste mode and an explicit Enter. Escape, Tab,
arrows, Enter and Ctrl-C are visible touch controls. Acknowledged sends clear the
draft; disconnects retain it with an uncertain-delivery message and never queue
resends. The remote viewport follows VisualViewport and safe-area insets. Source
is escaped text only, including HTML/SVG; there are no executable previews.

## Deferred work and release gates

Hosted operation, Cloudflare Tunnel/Access, generic OIDC, passkeys, PWA/offline
caching, transfers, rich source editing and isolated executable previews are not
part of this implementation. No provider-specific deployment is required.

Automated browser coverage is not physical iOS/Android acceptance. Test keyboard,
rotation, IME/dictation, long output, concurrent viewers, sleep and Wi-Fi/cellular
changes on real devices. Independent security review must assess the complete
Noise integration, web distribution, recovery and deployment before making a
reviewed production-security claim. See the acceptance checklist for evidence.
