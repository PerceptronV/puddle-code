# Mobile access acceptance

Remote protocol 2; daemon/cockpit protocol 19.0. Run in isolated homes with fake agents.
Never launch an installed daemon from a coding-agent environment. Deployment and
recovery instructions: [self-hosted mobile access](../mobile-access.md).

## Automated evidence

- `pnpm test:remote`: real Noise handshakes, host substitution, authenticated
  record tampering, Unicode/order, host invitation consumption and exact device
  approval, expiry/revocation persistence, stale/replayed participation, route
  denials, real Better Auth OAuth callbacks/cookies/MFA session gates, service
  registration replay and account isolation, real HTTP/WS origin checks and live
  sign-out revocation.
- `pnpm test:mobile` after `pnpm build`: real Chromium against temporary HTTPS
  application/service endpoints, the built connector and isolated built daemon
  with a deterministic fake agent. Cover login, fragment removal, exact-key
  approval from desktop Settings → Remote access, QR/link generation, Unicode
  composer input, draft retention through resize/reconnect, desktop revocation/
  disablement and continued local agent access. A separate UI fixture covers
  registration/re-enablement and explicit identity-reset confirmation without
  installing a supervisor. This suite requires a locally
  installed Playwright Chromium; no browser download occurs as part of the test.
- `pnpm test:e2e` and `pnpm test:ssh`: preserve local/SSH foundation behaviour,
  cockpit replacement, connection leases and isolated loopback SSH integration.
- `pnpm build:tarball`: bundle/smoke-test daemon and connector against the shipped
  Node/native runtime. `pnpm lint` includes hook order and design-token checks.

Tests demonstrate the covered behaviours. They are not independent security
review, production OAuth-provider acceptance or physical-phone acceptance.

## Deployment and recovery

- In local and SSH Electron windows, use Settings → Remote access to register,
  enable, pair, inspect/approve/revoke browsers and disable. Confirm the window's
  host is the target, secrets do not enter settings/logs, and unsupported older
  connectors request an upgrade. Verify offline disable/revoke and confirmed
  identity reset. Test actual systemd/launchd enablement on disposable hosts.
- Build the example images from a clean checkout and launch with distinct real
  app/relay HTTPS origins. Confirm only ingress ports are published; the daemon
  remains unreachable directly. Check CSP, framing, MIME and cache headers.
- Complete Google and GitHub login against operator-owned applications; verify
  provider-verified email admission, optional TOTP and a recovery code. Confirm
  email/password/recovery endpoints return 404 and provider account linking is
  unavailable. With MFA enabled, a fresh social session must not list/register
  hosts, attach pipes or disable MFA until verification completes.
- Use two accounts and two hosts. Attempt cross-account host selection and pipe
  attachment, wrong host pins, expired/reused invitations and wrong-browser
  approval. None may acquire host authority.
- Pair via copyable link on a desktop browser and QR on a phone. Compare the exact
  identity before approval. Lose browser storage, then lose all paired devices;
  confirm recovery requires another paired browser or local/SSH host access.
- Disable locally during a relay outage, restart the connector, reconnect and
  verify old grants remain unusable. Revoke while output is buffered and while an
  HTTP response streams. No undispatched input may execute afterwards.
- Suspend browser/network beyond 45 seconds while leaving the connector online.
  Its host lease must expire; restoring the browser creates a new generation and
  snapshot. No terminal input or session mutation is automatically resent.
- Test systemd boot/linger, launchd login/restart, daemon upgrade/removal and an
  externally managed supervisor. Closing the initiating laptop must not affect
  independent host execution. Reset identity locally and require fresh pins and
  approvals. Verify logs/registry records do not contain credentials/invitations.
- Saturate handshake, connection, request and output limits with slow peers;
  memory remains bounded and local cockpit operations remain available.

## Physical phones (manual; not established by browser emulation)

Run on current iOS Safari and Android Chrome, recording versions and results:

| Scenario | Required result |
| --- | --- |
| Portrait/landscape; keyboard open/closed | Composer and essential controls fit the visible viewport and safe areas |
| IME composition, Unicode, dictation, multiline paste | Native composition remains intact; Send follows terminal paste mode and submits once |
| Escape, Tab, arrows, Enter, Ctrl-C | Visible touch controls deliver the intended sequence |
| Long output and text selection | Terminal remains responsive; selection/scroll position survives switching |
| Desktop and phone on the same PTY | Active viewer claims size; hidden/background phone does not repeatedly resize |
| Lock/suspend; Wi-Fi to cellular; offline during Send | Draft survives, uncertain outcome is visible, no automatic replay |
| Return to existing runtime after expiry | Fresh admission and canonical snapshot; agent continues on the host |
| File/HTML/SVG review | Text only; no repository-controlled script or preview gains application authority |
| Breakpoint and project/session changes | Terminal identity and unsent text survive; desktop layout seed stays unchanged |

## Independent review gate

Before describing this deployment as security-reviewed, review the selected
Noise library and standalone adapter, identity storage, channel binding,
record replay/order, challenge deadlines/generations, every allowlisted route,
revocation/recovery and stale-backup behaviour. Inspect application build and TLS
control separately from the relay. A compromised application distributor can
capture plaintext and keys; document that assumption explicitly. Review dependency
updates, OAuth registration/provider recovery, admission limits and metadata retention.

Record actual reviewer findings and physical-device results here when performed;
do not convert an automated test result into a claim that either review occurred.
