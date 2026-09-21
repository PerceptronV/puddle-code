# Mobile access implementation review

This is the implementation's internal review record, not an independent audit.
Remote protocol 2 and daemon/cockpit protocol 19.0 have separate version boundaries.
The OAuth-only revision removes email delivery and password authentication; tests
exercise provider callbacks, verified claims, admission, blocked credential routes
and legacy password cleanup.

The host dispatch path is deliberately small: `connector/src/admission.ts`
checks exact Noise peer/account approval and participation; `policy.ts` owns the
complete route/message allowlist; `upstream.ts` alone constructs loopback
requests with the shared `HostControlClient`. Neither relay cookies nor routing
credentials enter the daemon. Approval/revocation and invitations live in host
SQLite. Renewal requires a fresh browser challenge response with explicit
resource ids; monotonic deadlines are checked before dispatch independently of
timer callbacks. Browser and connector watchdogs recover silent transports.

The relay handles login, registration and bounded binary splicing. Noise XX is
supplied by the maintained library, with no custom encryption or key agreement.
Debug configuration cannot enable transport payload logging. The application
origin and build are a separate trust decision; application compromise is outside
the content-secrecy claim. Source is rendered as text and the connector denies
executable previews and proxy routes.

Review and test findings fixed during implementation:

- Pending invitations must still have approved, unexpired device records when
  admission creates host authority, including interruption during approval.
- Better Auth responses need final-response CORS/security headers. The real
  browser caught missing authentication CORS that ordinary HTTP tests missed.
- Initial authenticator enrolment rotates the session cookie while the response
  body can reference the previous token. MFA confirmation now resolves the newly
  issued signed cookie through Better Auth. Real TOTP and single-use recovery-code
  tests cover this transition and the social-session gate.
- Composer input waits for the terminal's paste encoder and authenticated stream.
  Acknowledgements clear drafts; uncertain sends retain them.
- Ordinary terminal keys use bounded writes rather than exhausting the eight
  concurrent HTTP/composer acknowledgement slots.
- Hidden/background viewers cannot reclaim PTY size. Host switching clears
  caches/registrations and scopes drafts and scroll positions.
- Offline disable is checked from private host state even when IPC is unavailable.
  Reconnect cannot silently enable it. Newer database versions fail closed instead
  of being relabelled by an older binary.
- Identity reset and new host registration invalidate outstanding invitations as
  well as device grants. Registration responses are bounded before JSON parsing.
- Terminal messages have an explicit allowlist so additions to the local daemon
  protocol do not silently expand the remote surface.
- The service image includes shared-package dependency links and checks module
  loading and the native SQLite binding during its build.

Automated evidence includes the repository suite, local built-process and loopback
SSH suites, focused transport/authority/identity tests and a real HTTPS Chromium
flow against built connector/daemon processes with a fake agent. The browser
verifies exact approval, Unicode input arriving once across reconnect, retained
drafts, inert HTML diff review and live revocation without stopping work. Tarball
smoke testing loads both daemon and connector with the shipped runtime.

The Compose configuration validates. Docker image execution was not verified here
because the Docker daemon is unavailable; CI includes both image builds. Real
OAuth-provider registration, deployed systemd/launchd restart,
iOS/Android keyboards and independent security review remain explicit
[acceptance gates](../acceptance/mobile-access.md).
