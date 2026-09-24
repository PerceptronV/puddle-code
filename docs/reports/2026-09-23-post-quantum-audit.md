# Post-quantum cryptography audit

Reviewed 2026-09-23 at commit `10a67ac`. This is a source and dependency review,
supported by existing tests, not an independent cryptographic certification.
No implementation, dependency, deployment or protocol version was changed.

Puddle's remote end-to-end encryption is **not post-quantum secure**. Both its
key agreement and its identity authentication rely on elliptic curves. The
immediate migration priority is confidentiality of traffic recorded today;
resistance to future active impersonation also requires changing authentication.
The supplied ML-KEM/Noise example is incorrect and must not be deployed.

## Scope and evidence

Inspected the remote transport, connector admission and device stores, browser
identity storage and pairing, relay and service authentication, shared security
helpers and schemas, CLI SSH transport and tunnels, deployment TLS configuration,
installers and desktop updates. Inspected the installed Noise implementation and
relevant Better Auth cryptographic paths. Searched application and deployment
sources for cryptographic algorithms and APIs; no application PQ key agreement
or PQ identity implementation was found.

The pinned transport is `@chainsafe/libp2p-noise` **17.0.0**, not the
`noise-protocol` package used in the example. Its installed
`src/performHandshake.ts`, `src/protocol.ts`, `src/crypto/js.ts`, `src/noise.ts`
and `src/utils.ts` establish the suite and identity mechanism below.

`pnpm test:remote`: **59 tests passed in 13 files**. The first run encountered
sandbox restrictions on temporary Unix/loopback sockets; the rerun with local
socket access passed. The transport tests cover host substitution, altered
connection context, ciphertext tampering, record replay and encrypted Unicode
traffic. These establish useful classical regression coverage, not PQ security.
No installed daemon was launched. Deployed TLS/SSH negotiation, external OAuth
providers, browser side channels and production binaries were not measured.

## Findings

| Surface | Finding | Evidence |
| --- | --- | --- |
| Remote content confidentiality | Confirmed exposure to harvest-now-decrypt-later attacks | [channel.ts](../../packages/remote-transport/src/channel.ts), Noise 17.0.0 `performHandshake.ts` |
| Host and browser authentication | Confirmed exposure to future active quantum impersonation | [identity.ts](../../packages/remote-transport/src/identity.ts), [admission.ts](../../packages/connector/src/admission.ts), [devices.ts](../../packages/connector/src/devices.ts) |
| SSH cockpit, bootstrap, transfer and forwarding | PQ key agreement depends on the deployed SSH pair and configuration; Puddle does not require it | [ssh.ts](../../packages/cli/src/lib/transport/ssh.ts), [tunnel.ts](../../packages/cli/src/lib/tunnel.ts) |
| HTTPS/WSS, OAuth and browser delivery | PQ protection is not established by this repository; deployment and provider dependencies remain | [Caddyfile](../../deploy/remote/Caddyfile), [compose.yaml](../../deploy/remote/compose.yaml), [auth.ts](../../packages/remote/src/auth.ts) |
| Install/update authenticity | HTTPS and the release service are the trust anchor; downloaded checksums provide no independent publisher authentication | [install.sh](../../scripts/install.sh), [install-cli.sh](../../scripts/install-cli.sh), [desktop-update.ts](../../packages/cli/src/lib/desktop-update.ts) |
| Symmetric secrets and hashes | No Shor-type failure identified in these uses; retain adequate entropy and evaluate each hash's purpose | [security.ts](../../packages/shared/src/node/security.ts), [leases.ts](../../packages/daemon/src/security/leases.ts) |
| Stored content and private identities | OS/browser storage protection, rather than application encryption of all data | [identity-store.ts](../../packages/web/src/features/remote/identity-store.ts), [runtime.ts](../../packages/connector/src/runtime.ts), SPEC §4 |

### Recorded remote traffic

The exact suite is `Noise_XX_25519_ChaChaPoly_SHA256`: X25519 key agreement,
ChaCha20-Poly1305 record protection and SHA-256/HKDF key derivation. There is no
PSK or KEM input. The wrapper supplies a public prologue binding the remote
protocol, service, host, host peer and connection id (`channel.ts:23–47`).

A recorder with the handshake and subsequent ciphertext can later use a
cryptographically relevant quantum computer to recover the X25519 ephemeral
secrets, reconstruct the handshake keys and decrypt the application stream.
Classical forward secrecy does not prevent this: the recorded public ephemerals
are themselves vulnerable. A later protocol upgrade cannot protect recordings
made before that upgrade.

This exposes whatever traversed the channel: terminal input/output, source and
previews, images, metadata and secrets visible through those interfaces. The
relay has both handshake and ciphertext bytes after TLS termination, even if an
honest deployment does not persist them. PQ TLS on the two relay legs therefore
does not repair E2EE against a recording relay. A passive observer outside the
relay additionally has to defeat the outer TLS protection on the recorded leg.

Short-lived authority tokens and invitation expiry limit later credential reuse;
they do not prevent later disclosure of the associated content. The 30-second
host token rotation is not a Noise key exchange or a PQ ratchet.

### Identity authentication

Both endpoints generate Ed25519 identities (`identity.ts:4–10`), and
`secureChannel` explicitly requires Ed25519 (`channel.ts:42–43`). Libp2p signs
its X25519 static handshake key using that identity. The browser pins the host
peer; the connector admits the exact peer/account recorded in its device store
(`admission.ts:60–83`, `devices.ts:103–113`). These are valuable classical checks.

Ed25519 is also vulnerable to Shor's algorithm. A future active adversary with
the relevant public identity and access to a relay path could forge an approved
browser or pinned host. Adding only an ephemeral ML-KEM secret leaves this
authentication issue unresolved. A service login is still a separate gate, so
forging a browser key is not by itself proof that an unauthenticated Internet
client can reach the host. The threat includes a malicious relay, which E2EE is
intended to withstand.

Host/browser PQ authentication needs an authenticated PQ identity binding, or an
appropriately reviewed symmetric authentication design. Merely signing new KEM
keys with Ed25519 provides classical authentication, not authentication against
an already-capable quantum attacker.

### SSH, TLS and software delivery

Puddle delegates to system `ssh`/`scp` and user configuration. It neither forces
classical key exchange nor guarantees a hybrid exchange. Modern OpenSSH offers
hybrid KEX; both peers and the effective configuration must support it. Verify
the negotiated algorithm on a fresh connection, including jump-host legs and
reused ControlMaster connections. Updating a binary does not change an existing
master's handshake. SSH host/user signatures remain a separate migration.
[OpenSSH's PQ guidance](https://www.openssh.org/pq.html).

The deployment requires HTTPS origins and uses Caddy defaults, with a floating
`caddy:2-alpine` tag. This is insufficient evidence to label deployed TLS either
classical-only or PQ-protected. Current Caddy supports `x25519mlkem768`; actual
negotiation depends on its build and the browser/Node/curl peer. Inspect the
negotiated group rather than inferring PQ protection from TLS 1.3 or a cipher
suite name. Hybrid key exchange does not also replace Web PKI signatures.
[Caddy TLS documentation](https://caddyserver.com/docs/caddyfile/directives/tls).

Service cookies, OAuth exchanges, registration verifiers and connector routing
credentials travel outside the application Noise channel. Their transport and
provider authentication require their own migration. Better Auth's configured
Google provider also contains RS256 ID-token verification; this is an external
classical signature dependency, not the host device approval mechanism.
Expired captured tokens do not become valid again merely because TLS is later
decrypted, but disclosed long-lived secrets can remain useful.

Application delivery is especially consequential: malicious JavaScript served
from the trusted app origin can read the stored identity and plaintext before
any E2EE. The browser store contains serialised private key bytes. Separating
the app origin from the relay is useful and must be preserved; it does not make
application delivery independent of HTTPS and the build/update trust chain.

The installers fetch archives and `SHA256SUMS` from the same release origin.
The desktop updater documents that same trust model (`desktop-update.ts:13–21`).
A party able to substitute both can bypass the checksum without breaking SHA-256.
This is an existing publisher-authentication limitation, with future quantum
attacks on TLS authentication adding another route. Plan independently verified
release manifests and a PQ-capable trust-anchor migration before claiming PQ
software authenticity; a checksum algorithm replacement alone does not solve it.

### Symmetric cryptography and storage

The shared `secret()` helper generates 32 random bytes and `digest()` uses
SHA-256. Invitations, routing credentials and connection tokens use this helper;
browser registration uses `crypto.getRandomValues` for a 32-byte verifier.
These are not elliptic-curve systems and are not broken by Shor's algorithm.

Generic quantum search affects security margins: idealised search over a
256-bit secret takes approximately 2^128 oracle queries. That is not a reason
to replace these random secrets with public-key cryptography. SHA-256 preimage
security, collision resistance, and HMAC/HKDF security are different properties;
do not describe all of them as uniformly providing 128-bit quantum security or
change a standard protocol's hash without analysing its use. NIST likewise
distinguishes symmetric/hash migration from public-key replacement.
[NIST PQ FAQ](https://csrc.nist.gov/Projects/Post-Quantum-Cryptography/faqs).

The inspected Better Auth paths use HMAC-SHA-256 and symmetric protection,
including XChaCha20-Poly1305 for MFA secrets/recovery codes. Their security still
depends on a high-entropy `BETTER_AUTH_SECRET`: the configuration's minimum
character count does not establish entropy. MFA's online checks are not PQ
host identity authentication.

Puddle does not encrypt all workspace files, terminal history or database values
at rest. Host identity files use private filesystem permissions; browser
identities use origin-scoped IndexedDB. This is a separate endpoint/backup risk,
not a quantum-only cryptographic failure. OS disk and backup encryption, and
agent-provider network connections, lie outside the transport's guarantee.

## Assessment of the supplied advice

The useful premise is that a properly composed hybrid exchange can combine
classical and PQ protection, and that a genuinely secret PSK can protect suitable
Noise traffic. ML-KEM is a real standardised KEM. Neither fact validates this
particular composition. [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final).

The example has independently fatal errors:

- **Wrong Noise API.** `noise-protocol` accepts a supported pattern name such as
  `IK`, not this full suite string. Its documented initialiser has no PSK array
  parameter: argument seven is the remote ephemeral public key. Its message
  writer needs an output buffer; its reader does not return the claimed payload
  length. [Package API](https://github.com/emilbayes/noise-protocol#api).
- **Missing keys.** IK requires the responder's static public key to be known
  to the initiator and the required local static keypairs. Passing `null` does
  not establish authenticated IK. The implementation checks these requirements.
  [Initialiser source](https://raw.githubusercontent.com/emilbayes/noise-protocol/master/handshake-state.js).
- **Wrong PQ API.** The current documented identifiers are `ml_kem768`,
  `keygen()`, `secretKey` and `cipherText`, with the `.js` subpath. The example
  uses different identifiers. The package provides primitives, not this entire
  authenticated transport. Its security documentation says it has not received
  an independent audit and makes no constant-time JS execution claim.
  [Library documentation](https://github.com/paulmillr/noble-post-quantum).
- **False completion and confidentiality claims.** IK has two messages; the
  example executes only the first. `psk2` mixes the PSK at the end of message
  two, before that message's payload. It cannot retroactively protect the first
  payload shown in the example. [Noise specification](https://noiseprotocol.org/noise.html#pre-shared-symmetric-keys).
- **Missing protocol design.** The demo gives both parties the same in-process
  secret. It provides no secure network binding of the KEM key/ciphertext to the
  peers, context and Noise transcript, or completed-handshake key confirmation.
  An unauthenticated KEM exchange alone is susceptible to substitution. Correct
  Noise authentication and transcript binding may address classical attackers;
  they do not make classical identities PQ-authenticated. A reused static KEM
  key also needs an explicit later-compromise analysis: later theft of that
  decapsulation key can recover recorded KEM secrets. If the classical component
  is subsequently broken, the recordings lose both protections. Prefer a reviewed
  exchange with fresh ephemeral PQ secrets and a defined destruction lifecycle
  when PQ forward secrecy after long-term-key compromise is required.

The screenshot's claim about “Signal's PQ3” confuses protocols: PQ3 is used by
iMessage; Signal documents PQXDH and separately discusses its classical
authentication assumption. [PQ3](https://security.apple.com/blog/imessage-pq3/),
[PQXDH](https://signal.org/docs/specifications/pqxdh/).

The memory advice is incomplete. Wiping one buffer does not wipe its copies,
strings, engine temporaries or library state. Wiping immediately after initialisation
can break a library that retains the caller's buffer until a later PSK token.
Use a documented ownership/destruction lifecycle. Puddle's WSS transport already
uses bounded framing; a UDP MTU warning is not the central integration problem.
Handshake size, buffering and denial-of-service costs still require testing.

These defects establish that the advice is unreliable; they do not establish
malicious intent.

## Recommended migration

1. **Define the first guarantee precisely:** hybrid protection against recorded
   traffic, with the remaining classical authentication limitation stated
   explicitly. Plan PQ authentication in the same design, even if delivered
   separately. Existing recordings cannot be repaired.
2. **Evaluate native hybrid Noise first.** The closest upstream work is
   [ChainSafe PR #665](https://github.com/ChainSafe/js-libp2p-noise/pull/665),
   proposing XXhfs with X25519 and ML-KEM-768. At review time it is a draft,
   explicitly research/WIP, and absent from installed 17.0.0. It is a useful
   integration candidate, not a production security endorsement. Evaluate an
   exact reviewed revision and interoperation before adoption.
3. **Compare alternatives if that route cannot meet the required assurance.**
   [Clatter](https://github.com/jmlepisto/clatter) supports PQ/hybrid Noise but
   explicitly reports no formal audit.
   [libcrux-psq](https://cryspen.com/post/psq-announce/) is a real Rust protocol
   with transport/export APIs and authentication options; it is not an npm
   PSK adapter for Puddle. The [libcrux project](https://github.com/celabshq/libcrux)
   remains pre-release and scopes verification by component. Verify the selected
   suite's authentication, ephemeral-key/forward-secrecy properties, fixed
   advisories and browser/WASM support. A primitive's verification does not
   establish security of a new wrapper or composed protocol.
4. **Keep the migration at the transport boundary.** `secureChannel` is the
   existing seam. The installed library has no PSK setting; its public prologue
   is not a secret-key input. Do not smuggle a secret into the prologue or replace
   X25519 with a KEM through the crypto callback. Preserve pinning, exact device
   approval, profile/account scope, expiry, revocation, bounded queues and
   the rule against replaying uncertain writes. Keep new cryptographic secrets
   separate from pairing invitations, routing credentials and host lease tokens;
   these existing credentials have different audiences and lifecycles.
5. **Version and migrate identities deliberately.** Bind suite/version, roles,
   service, host/profile, connection, both identities and all KEM material into
   the reviewed handshake. Permit no silent classical fallback. A PQ identity
   must be approved or bound over a still-trusted channel; an unauthenticated
   relay key substitution is not a migration. The current Ed25519 serialisation
   and schemas (`remoteIdentitySchema` and peer/invitation records) require
   explicit evolution. Follow `packages/shared/PROTOCOL.md` for the remote
   protocol bump and any daemon/cockpit auth or invitation contract changes.
6. **Validate before deployment.** Require published vectors and independent
   interoperation, full two-way transport after handshake, tamper/substitution,
   wrong-context, replay, downgrade, malformed KEM, failed confirmation and
   reconnect tests. Exercise secret destruction and later-key-compromise
   assumptions, plus real mobile latency, bundle size and pre-authentication
   CPU/memory limits. Run the existing authority and browser suites and obtain
   independent protocol/integration review. Passing a same-library round trip
   alone is insufficient.
7. **Improve the surrounding channels in parallel.** Verify or require hybrid
   SSH KEX on deployments needing confidentiality now. Verify PQ TLS support
   on all relevant legs, retain separately trusted app delivery, and plan
   release-authentication and external-provider migrations. None substitutes
   for hybrid encryption between the browser and connector.

The recommended next implementation task is a bounded hybrid-transport prototype
and reviewed migration design at `secureChannel`, followed by explicit identity
migration. It is not a patch to the supplied example.
