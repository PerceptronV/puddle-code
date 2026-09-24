# Post-quantum hardening

Status: draft, revised 2026-09-24. None of the proposed settings, flags, cryptographic
suites or migrations in this document is implemented. The baseline is daemon
protocol 22.0, remote protocol 3 and `@chainsafe/libp2p-noise` 17.0.0.

This roadmap covers three stages: require hybrid SSH key exchange, introduce
hybrid browser-to-connector encryption, then migrate host and browser identities
to post-quantum authentication. Findings and source evidence are in the
[post-quantum audit](../reports/2026-09-23-post-quantum-audit.md); the existing
authority model is described in [mobile access](../mobile-access.md) and
[SPEC](../../SPEC.md).

## Security goals and delivery order

Protect newly transmitted sensitive content against an adversary recording it
today and decrypting it later with a cryptographically relevant quantum
computer. Subsequently protect host and browser authentication against an active
quantum attacker. Classical authentication is assumed secure during the initial
migration; stage 3 must remove that assumption from remote device authentication.

| Stage | Deliverable | Intended protection | Remaining limitation |
| --- | --- | --- | --- |
| 1. Hybrid SSH | Optional enforced PQ key-exchange policy for CLI and desktop SSH connections | Recorded SSH traffic, including bootstrap, terminal traffic, transfers and forwards | SSH host/user authentication remains classical; relay/mobile access is unaffected |
| 2. Hybrid remote transport | Reviewed X25519 plus ephemeral ML-KEM-768 handshake at `secureChannel` | Recorded browser-to-connector traffic, including recordings by the relay | Existing Ed25519 host/browser authentication remains classical |
| 3. PQ remote identities | Reviewed hybrid authentication and explicit pairing migration | Future active impersonation of a pinned host or approved browser | Trusted application delivery, endpoint integrity and external service authentication remain dependencies |

Stages 1 and 2 can proceed independently. Design stage 3 alongside stage 2, so
the new transport can accommodate it without redesigning the authority model.
Ship stage 2 once its own security and interoperability requirements are met;
identity migration need not delay protection of newly transmitted content.

Use precise descriptions of each stage's guarantee. Avoid labelling the whole
application “quantum-safe”. Existing recordings cannot be protected retroactively.
PQ TLS to the relay cannot protect against a relay recording the inner E2EE
handshake and ciphertext.

### Threat model and security targets

For stages 2 and 3, the content guarantee covers application messages inside the
browser-to-connector channel. It assumes authentic endpoint software, secure
pairing and uncompromised endpoints while handling protected traffic. The relay
is untrusted: it may record, replace, replay, delay and route handshake or
transport messages. Neither relay login nor outer TLS may substitute for channel
authentication.
Application delivery, service credentials outside that channel and other network
connections remain outside this guarantee, as described under Boundaries.

Stage 2 assumes classical authentication resists active attacks during the
exchange; later quantum recovery of classical keys must not disclose recorded
application content. Stage 3 additionally assumes an active attacker can recover
X25519 private keys from public keys and forge Ed25519 signatures during the
exchange. Its authentication must still hold under the reviewed PQ assumptions.
Analyse later long-term-key compromise separately from live endpoint compromise;
these stages do not promise recovery of secrecy after theft of live traffic keys.

Before adopting a suite, record quantitative classical and quantum security
targets for confidentiality, peer authentication, identity commitments and
transcript binding. Identify the required preimage, second-preimage or collision
resistance for each hash use, and state forgery bounds and per-key usage limits
for authentication tags. Include the assumed number of peers, sessions and
attacker attempts. A primitive's NIST category does not establish the strength
of a composed protocol; do not infer a uniform quantum bit strength from hash
output length. The review must assess the complete construction against these
targets. Undefined targets or an unmet target block production adoption; changing
a target requires a documented review, not an implicit implementation exception.
[NIST security-strength guidance](https://csrc.nist.gov/Projects/Post-Quantum-Cryptography/faqs).

## Stage 1 — require hybrid SSH key exchange

### Proposed behaviour

Add an optional **Require post-quantum key exchange** connection policy, exposed
through the CLI and desktop connection flow. Proposed CLI spelling:
`--require-pq-kex`. This is a proposed interface, not a command available today.
The default continues to use system SSH policy. Explicit strict mode must fail
closed if it cannot establish an allowed hybrid exchange.

The policy belongs in `packages/cli/src/lib/transport/ssh.ts` and the shared
connection options. Desktop supplies the preference and displays errors through
its existing connection UI; it must not implement a second SSH policy engine.
Persist only the policy in the client-side connection record. Carry it through
background launch, reconnect, refresh and desktop reopen.

Modern OpenSSH supports hybrid KEX, including `mlkem768x25519-sha256` and
SNTRUP/X25519 variants. Exact supported names differ by installed version. Choose
from an explicit reviewed allowlist intersected with local support, and require
successful negotiation using that list. Listing supported algorithms or printing
an SSH version does not establish what a connection negotiated.
[OpenSSH PQ guidance](https://www.openssh.org/pq.html).

### Implementation requirements

- Set the strict KEX policy before any remote bootstrap, inspection, credential
  exchange or command. Do not open an unrestricted connection merely to discover
  whether the server supports PQ KEX.
- Apply the same policy to every SSH/SCP operation associated with the connection:
  the master, authority helper, tunnel, callback forwards, transfers and attached
  daemon fallback. Inventory standalone management and remote-administration
  entry points as well as `connectRemote()`.
- Separate strict and default ControlMaster socket namespaces. A strict request
  must never attach to an existing master whose original KEX policy is unknown
  or classical. Bind reuse to the policy version; reconnect after policy changes.
  Do not terminate unrelated user SSH masters.
- Handle Windows and other configurations without multiplexing: every new
  connection must independently enforce the policy. A successful earlier probe
  does not authorise an unrestricted later connection.
- Distinguish the destination SSH connection from ProxyJump/ProxyCommand legs.
  Destination options do not necessarily govern those subprocesses. The initial
  guarantee covers the end-to-end destination SSH connection; claim protection
  for jump-host authentication and traffic only when those legs are separately
  enforced or verified. Custom proxy paths with unknown properties remain
  explicitly outside that broader claim.
- Report unsupported local clients and servers without an allowed exchange as
  connection failures with actionable upgrade/configuration guidance. Never
  retry with classical algorithms automatically. Policy choice must be explicit.
- Keep diagnostics free of credentials and remote command contents. If selected
  KEX is exposed, derive it from the relevant connection, not a separate probe or
  the absence of an SSH warning. Strict enforcement must not depend solely on
  parsing human-readable debug output.

Host-key checking, SSH agents, askpass, passwords and MFA keep their existing
roles. Hybrid KEX does not convert SSH host/user signatures into PQ signatures.
Retain system SSH and its configuration support.

### Acceptance

Use deterministic fake-SSH tests for option propagation and error handling,
plus isolated loopback OpenSSH integration for real negotiation. Cover:

- An allowed hybrid exchange succeeds; a classical-only server fails before
  bootstrap or host-authority access.
- An unsupported client produces a clear failure without classical retry.
- A pre-existing unrestricted master cannot satisfy a strict connection.
- Strict policy survives background launch, refresh, reconnect, desktop reopen
  and transfers; non-multiplexed subprocesses receive the same restrictions.
- Proxy/jump cases have an accurate scope of protection, and ordinary host-key
  verification and authentication still function.

Deliver the shared library policy, shell interfaces, tests and operator guidance
as a bounded change. No daemon wire change is expected solely for SSH KEX policy;
review any launcher/registry contract changes separately.

## Stage 2 — hybrid browser-to-connector encryption

### Transport choice and prototype

Target a maintained, reviewed hybrid Noise handshake combining X25519 with fresh
ephemeral ML-KEM-768 material. Keep Ed25519 identity authentication for this stage.
The first candidate is the native XXhfs integration in
[ChainSafe PR #665](https://github.com/ChainSafe/js-libp2p-noise/pull/665).
As checked on 2026-09-23, it remains a research draft and is not part of Puddle's
installed library. Its existence is a starting point for evaluation, not approval
to ship that branch.

The prototype must answer whether an exact library revision can provide the
required handshake, authenticated context, ordered transport and browser/Node
support without application-owned cryptographic machinery. Record its protocol
specification, dependency versions, review status and reproducible test results.
Prefer an upstream maintained implementation over a Puddle fork. If the candidate
cannot meet the requirements, compare the alternatives recorded in the audit;
do not replace the evaluation with an ad hoc KEM-to-PSK composition.

Integrate at `packages/remote-transport/src/channel.ts:secureChannel`. The relay
continues to forward bounded opaque bytes; admission, leases, application schemas
and request dispatch retain their existing responsibilities. The prototype must
not alter production defaults until the release criteria below are satisfied.

### Required properties

- Generate fresh ephemeral PQ key material for each handshake. Document which
  party owns each secret, when it is consumed and how it is discarded. Evaluate
  forward secrecy after later compromise of long-term identity keys; do not
  silently substitute a reusable static KEM key for an ephemeral exchange.
- Use the reviewed protocol's hybrid combiner and key schedule. Specify the
  classical/PQ failure assumptions and verify that both contributions reach the
  transport keys. The current library's prologue and crypto callback are not
  substitutes for a KEM-aware handshake.
- Authenticate the negotiated suite/version, roles, current service/host/profile
  context, connection id, peer identities and KEM material through the reviewed
  transcript binding. Preserve existing host pin validation before sensitive
  application traffic.
- Complete the handshake and its required key confirmation before sending
  invitations, terminal data, files or credentials. No sensitive early data.
  Unknown browser identities may reach pairing-only admission, never daemon
  authority without approval.
- Require the hybrid suite for the new remote protocol. Reject missing,
  malformed or incompatible protocol inputs and do not reconnect using classical
  Noise after a timeout or handshake failure. Validate public lengths, encodings
  and keys as required by the selected primitive. Preserve ML-KEM's implicit
  rejection for invalid, correctly sized ciphertexts: decapsulation returns a
  replacement secret, and the reviewed confirmation/authentication mechanism
  rejects the exchange. Never expose the internal rejection flag through an API,
  logs, responses or secret-dependent timing, or invent a ciphertext-validity
  check. Public framing errors need not be indistinguishable from secret-dependent
  failures. Keep future suite changes explicit and authenticated; avoid an
  unnecessary general negotiation framework.
  [FIPS 203, sections 6.3 and 7.3](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.203.pdf).
- Preserve nonce uniqueness, direction-specific transport keys, ordered record
  authentication and failure handling. Bound unauthenticated handshakes, message
  sizes, queues, CPU work and deadlines on the host, independently of an honest
  relay's limits.
- Keep PQ secrets separate from invitations, routing credentials, browser
  authorisation and host lease tokens. No logging, persisted ephemeral keys or
  claims of complete JavaScript memory erasure based on wiping one buffer.
- Preserve exact peer/account/profile approval, expiry, revocation, manual
  browser participation and reconnect behaviour. Uncertain writes remain
  uncertain and are never automatically resent.

### Compatibility and rollout

Allocate a new `REMOTE_PROTOCOL_VERSION` when the implementation is ready.
The new browser and connector require the same hybrid protocol. Update service
discovery and strict envelopes consistently; old cached applications must fail
with a clear update requirement. A feature flag or version response supplied by
the relay cannot authorise a cryptographic downgrade.

Stage 2 may retain existing Ed25519 identities and device grants because their
meaning is unchanged, provided the implementation proves identity continuity
and preserves account/profile scope. Outstanding invitations carry protocol
versions and must be reissued when incompatible. Never extend grant expiry
merely because the transport upgraded.

Apply [shared protocol rules](../../packages/shared/PROTOCOL.md) to any changed
invitation literals or cockpit authentication contracts; a daemon/cockpit major
bump may accompany the remote change. Allocate actual version numbers at
implementation time. Update SPEC, deployment/acceptance documentation, release
compatibility metadata and the changelog in the implementation change.

A supported operational rollback must retain each registration's minimum
accepted protocol and identity format, established when it migrates. Persist
that floor with its authority state; do not infer it from relay discovery. If a
rollback cannot honour the floor, leave remote access disabled. An older binary
that cannot enforce the floor is not a supported rollback target. Neither a
binary downgrade nor database restoration may automatically reuse retired grants
or relabel a classical connection as hybrid. The recovery contract below defines
supported restores and the limits of detecting arbitrary snapshot rollback.

### Cryptographic backend assurance

Review the exact backend for each supported Node/browser execution path, including
JavaScript, native and WASM variants and any runtime fallback. Record dependency
revisions, build options, runtime versions, audit scope, unresolved findings and
the production artefacts to which the evidence applies. A reviewed primitive or
successful interoperability test does not establish assurance of every backend.
An unreviewed fallback must fail closed rather than silently change the security
profile. Changes affecting these assumptions require renewed review.

The backend review must cover:

- OS/browser cryptographic randomness, entropy-failure handling and fresh
  per-operation randomness where required by the primitive. Deterministic test
  seeds and injected compromise hooks must never reach production builds.
- Secret-dependent branches, memory access, decapsulation comparisons, signing
  rejection loops, errors and timing. Remote chosen-input and repeated-handshake
  observations are in scope, including before device approval.
- Whether hostile co-tenancy, shared hardware and high-resolution local timing
  observers are in scope for each supported deployment. Exclusions must be
  explicit in the security claim and operator guidance; endpoint integrity alone
  is not a reason to omit this analysis. If an included adversary exceeds a
  backend's assurance, require a reviewed mitigation/backend or block that path.
- Secret ownership and lifetime across library buffers, engine temporaries and
  native/WASM boundaries; memory-clearing claims must respect those limits.

As checked on 2026-09-24, the candidate's JavaScript primitive library reports no
independent audit and does not claim constant-time execution. Native or WASM
execution alone is not evidence of constant-time behaviour either. Resolve
findings for the exact selected revision and declared adversary model before
release; a self-audit or timing benchmark alone is not that evidence.
[Backend security documentation](https://github.com/paulmillr/noble-post-quantum#security).

### Prototype and release evidence

The prototype delivers a comparison against current Noise on the same crypto
backend and hardware: handshake latency, connection-ready latency, transmitted
bytes, bundle size, peak memory and concurrent-handshake CPU cost. Measure both
Node and representative mobile browsers, including cold loads and sleep/network
reconnection. Preserve the current ten-second handshake deadline and bounded
capacity unless measurements justify an explicit change. Record device/browser
versions and agree performance thresholds before production adoption.

Before release, require published known-answer vectors where available and
independent implementation interoperability in both roles, including application
messages in both directions. Same-library round trips alone are insufficient.
Test key/ciphertext substitution, invalid lengths, changed context, replay,
unknown suites, classical-only peers, failed confirmation, incomplete handshakes,
queue exhaustion and reconnect. Confirm by inspection and tests that no
application payload crosses the boundary before the required protection exists.
Include invalid, correctly sized ML-KEM ciphertexts that exercise implicit
rejection, as well as public length/key-validation failures. Verify that the
former cannot produce an admitted channel or expose the internal rejection flag;
inspect error paths and backend side-channel evidence rather than treating a
passing functional or timing test as proof of constant-time execution.

Run the existing remote/authority suites, built cockpit/SSH suites and real
browser flow, following their isolated-home and sanitised-environment rules.
Obtain independent review of the selected handshake and Puddle integration,
including the later-key-compromise model, quantitative security targets and every
supported backend's declared side-channel assumptions.
Record unresolved findings and resolve those affecting the claimed guarantee
before enabling the production protocol.

## Stage 3 — PQ host and browser authentication

### Proposed identity design

Evaluate hybrid Ed25519 plus ML-DSA-65 authentication as the initial candidate,
within a reviewed protocol/library construction. The exact suite and identity
encoding remain decisions for the design review. Both components must verify
for a hybrid identity; accepting either one would preserve a downgrade path.
Retaining Ed25519 provides a classical hedge, not permission to omit PQ checks.
ML-DSA's primitive specification is [FIPS 204](https://csrc.nist.gov/pubs/fips/204/final);
standardisation of the primitive does not validate this proposed composition.

The reviewed construction must bind the complete identity bundle, roles,
handshake context and ephemeral exchange together, rejecting mixtures of keys
from different peers. The current libp2p signature authenticates a static Noise
key; adding a second disconnected signature does not by itself establish all
these properties. Verify support in the selected library before committing to
its public-key or peer-id format.

In particular, replacing the signature on a static X25519 key with a hybrid
signature is insufficient: an attacker can obtain a valid signed static key,
recover its classical private key and reuse the signed key in a fresh handshake
with an attacker-controlled KEM exchange. No PQ-signature forgery is needed.
The [libp2p static-key authentication rules](https://github.com/libp2p/specs/blob/master/noise/README.md#static-key-authentication)
therefore cannot simply be reused as the stage-3 authentication proof.

Require fresh, session-bound proof of possession of the PQ identity in both
roles, even with all classical authentication compromised. Specify the exact
authenticated bytes, domain separation, freshness source and point at which
each peer verifies the proof. Bind the complete identities, roles, context and
ephemeral exchange through the reviewed construction; matching public keys or
replaying a valid old attestation is not proof of participation in this session.
Do not release sensitive application traffic or create daemon authority before
this verification and the required key confirmation. Selecting and independently
reviewing this construction is a release gate, not subsequent key-format work.

Keep a stable, canonical identifier for the approved identity bundle. The
identifier must commit to algorithm identifiers and the complete public keys
using the selected encoding/hash under the documented security targets. The host
approves that identity for one account/profile; a device label is never an
authentication identifier. The application must verify possession of all
required private keys, not merely receipt of matching public bytes.

### Storage and explicit pairing migration

Version host identity storage, browser IndexedDB records and device grants.
Update shared schemas rather than declaring new wire shapes in individual
packages. Current Ed25519 protobuf assumptions, identity-array bounds, peer-id
fields and invitation encodings need deliberate review; simply increasing a
size limit is not an identity migration.

For the first stage-3 release, **require explicit re-pairing of existing remote
devices**. This is simpler to review than silently granting new PQ keys the
authority of old Ed25519 records:

1. Durably mark the registration as migrating, stop admission and disconnect its
   existing viewers before changing authority state. Generate the host's new
   identity material locally and persist it atomically in that profile's private
   registration. Never obtain it from the relay.
2. Retire legacy grants and invitations durably at the migration boundary. Keep
   revoked records for audit. Preserve service account ownership and profile
   isolation; migration cannot copy grants across profiles or extend their
   lifetimes. Resume pairing-only admission once identity, grants, minimum
   security floor and migration state form one consistent generation. Define
   the crash-safe commit point across files and databases; atomicity of one
   file is insufficient.
3. Present a new host pin through trusted local/SSH administration. The browser
   must explicitly accept that pin; a changed relay response cannot replace it.
   Resolve whether invitations carry a compact commitment to a separately
   transmitted bundle to keep QR/link sizes practical. Verify the full bundle
   against the commitment before trusting it.
4. Generate browser keys locally, prove possession through the reviewed handshake
   and require approval of the exact new identity before granting authority.
   An already migrated, approved browser may approve further browsers under the
   existing host policy.
5. Make interrupted migration recoverable from trusted local administration.
   Partial state or a failed browser save must leave the affected access disabled,
   never accept legacy keys, trust an unpinned identity or approve keys automatically.

Hybrid SSH still has classical authentication after stage 1. Using it to approve
new identities is justified during the transition while that authentication is
trusted. If an active quantum attacker is already in scope, bootstrap new trust
through trusted local access or an independently PQ-authenticated channel;
hybrid SSH KEX alone is insufficient.

### Recovery and backup contract

For the first stage-3 release, supported recovery from missing/compromised identity
material or a backup requires trusted local administration and new pairing:

- Keep the connector disabled before restored state can accept any connection.
  A supported restore procedure must durably establish this before starting the
  supervisor; importing a backup must never restore an enabled registration.
- Retire all restored grants and invitations, including pending approvals, and
  generate a new host identity locally. Retain historical records for audit only.
  Re-establish the minimum security floor and a consistent authority generation
  before explicit re-enablement. Browsers must accept the new pin over a trusted
  path and receive new explicit approvals; old browser storage is not authority
  to bypass either step. Apply the active-quantum bootstrap restriction above.
- Define restore ordering and interruption handling in the implementation and
  operator instructions. Failure or repeated recovery must leave access disabled
  until the current recovery completes. Reset remains local/SSH administration,
  never an unauthenticated relay operation.

This contract deliberately does not infer freshness from a valid backup. A
snapshot taken before revocation can restore both an approved grant and the
identity that accepted it, erasing all local evidence of revocation. Atomic
writes, signed backups, schema versions and a migration marker or counter in the
same snapshot cannot detect that rollback.

Arbitrary filesystem/whole-machine snapshot restoration followed by automatic
startup is outside the supported recovery guarantee. Document that operators
must prevent connector startup and run the recovery procedure first; do not
claim that the application can detect such restoration unaided. Any future
design promising automatic rollback detection must specify and review an
independently retained, authenticated freshness/revocation anchor that cannot
be rolled back with the snapshot, and fail closed when it is unavailable. This
also applies to already migrated backups, not only legacy Ed25519 state.

### Integration and acceptance

Primary seams are `remote-transport/src/identity.ts`, `secureChannel`, the shared
remote schemas, connector identity/device stores and admission, browser identity
storage, pairing UI and host-control pairing commands. The cryptographic layer
returns only a fully verified canonical identity to admission. The daemon keeps
using host-issued leases; it does not gain a second PQ credential mechanism.

Stage 3 requires a remote protocol bump and reviewed storage migrations. Follow
the daemon/cockpit major-version rules for changed authentication and invitation
contracts. Once migrated, a peer must reject classical-only identities even if
the relay advertises an older capability. Recovery must not be an automatic
downgrade route.

Acceptance must cover valid hybrid authentication, either signature failing,
classical-only proofs, swapped key bundles, stale pins, transcript/context
substitution, grant revocation/expiry, cross-account/profile attempts and lost
browser storage. Additionally require:

- Test adversaries that possess the victim's test X25519 static and ephemeral
  private keys and can forge its Ed25519 proofs, while lacking its PQ private
  identity key. Exercise both host and browser impersonation with fresh attacker
  KEM exchanges and recorded valid identity attestations. Neither side may admit
  the impostor or disclose sensitive application data. Use test fixtures/hooks
  to model the classical break; keep real PQ verification and admission enabled.
- Replay proofs across fresh connections, changed roles, peers and contexts,
  including both individually valid hybrid signatures belonging to different
  sessions. Valid fresh authentication must still succeed in both roles. These
  tests supplement independent analysis; they do not prove quantum security.
- Exercise interrupted migration/restore at every persistent transition,
  mismatched identity/database generations, mixed binaries, rollback below the
  security floor, lost browser saves and repeated recovery. Include an already
  migrated backup taken before a device's later revocation, while that device's
  original grant has not expired. Supported restoration must keep remote access
  disabled until recovery, reject the old grant afterwards and require new pins
  and approvals. Record the arbitrary-snapshot limitation in acceptance guidance.
- Exercise approval via a migrated browser and re-evaluate backend assurance for
  PQ signing as well as key exchange, under the declared side-channel model.

Re-run stage 2 interoperability and mobile resource measurements with the larger
identity material. Independent review must cover both authentication and its trust
bootstrap, not just the signature primitive.

## Boundaries and next work

These stages do not encrypt stored workspaces/history, migrate agent-provider
connections, replace OAuth/Web PKI, or establish independent release signatures.
Track TLS negotiation, trusted application delivery, release authentication and
backup encryption as the separate follow-ups identified in the audit. The recovery
contract above governs restored authority; it does not encrypt stored data or
provide automatic snapshot-rollback detection. Keep the current random 256-bit
credentials and symmetric cryptography unless a specific review finding requires
a change.

The next two bounded changes are stage 1's shared SSH policy and stage 2's
transport prototype with reproducible measurements. Before stage 2 ships,
resolve the exact maintained library revision, complete handshake specification,
quantitative security targets, backend assurance and protocol migration. Before
stage 3 ships, resolve the fresh PQ authentication construction, identity
commitment/encoding, atomic re-pairing design and supported restore procedure.
Draft decisions belong here; implemented behaviour must also be reflected in
SPEC, shared protocol documentation and the changelog.
