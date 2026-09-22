# Mobile access acceptance

Remote protocol 2; daemon/cockpit protocol 21.0. Run in isolated homes with fake agents.
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
  approval from desktop Settings → Remote & Sync, QR/link generation, Unicode
  composer input, draft retention through resize/reconnect, desktop revocation/
  disablement and continued local agent access. Browser-level touch gestures cover
  terminal scrollback, SGR mouse reporting, alternate-screen scrolling, tap-to-type,
  and native file scrolling while the surrounding page stays fixed. Image-picker
  coverage verifies exact small-image bytes, repeat selection, large-image resizing
  under the production CSP, unsubmitted path insertion and retained composer drafts.
  Header coverage verifies saved desktop project/session order, touch selection from
  the shared title dropdown, archived-session filtering, the home breadcrumb and
  the single-row file toolbar. Five-letter rail labels fit without clipping, rail controls
  use the desktop gold token, file/title bars align with the collapse toggle, and the
  Files return action uses a computer icon.
  Host disclosures collapse without losing cards. Path checks cover current-directory
  and filename prefills, invalid input, nested files, and files outside the project.
  Held touch drags select and copy file text and Unicode across terminal rows in normal,
  mouse-reporting and alternate-screen modes; quick swipes still scroll. Revoked browser rows disappear
  from desktop settings while their host records remain revoked. Shared browser cards
  keep approved identities collapsed and pending identities visible; desktop wraps
  the cards in an initially collapsed disclosure.
  A separate UI fixture covers
  in-place registration editing, editable defaults, synchronous UI-client tab opening
  with its challenge prepared before the click, cancellation and quiet polling during sign-in,
  re-enablement, explicit identity-reset confirmation, and registration
  deletion beside the other registration actions with cancellation/error recovery, chevron keyboard toggling, legacy
  settings links and quiet status polling without
  installing a supervisor. This suite requires a locally
  installed Playwright Chromium; no browser download occurs as part of the test.
  A desktop handoff test follows real HTTPS approval/status/redemption across OAuth,
  then starts the built connector under fixture-owned supervision; no OS service is installed.
  Verify that the URL contains only the hash, the private verifier is not persisted,
  redemption is single-use and no browser grant is created by account registration.
- `pnpm test:e2e` and `pnpm test:ssh`: preserve local/SSH foundation behaviour,
  cockpit replacement, connection leases and isolated loopback SSH integration.
- `pnpm build:tarball`: bundle/smoke-test daemon and connector against the shipped
  Node/native runtime. `pnpm lint` includes hook order and design-token checks.

Tests demonstrate the covered behaviours. They are not independent security
review, production OAuth-provider acceptance or physical-phone acceptance.

## Deployment and recovery

- In local and SSH Electron windows, use Settings → Remote & Sync to register,
  enable, pair, inspect/approve/revoke browsers and disable. Confirm the window's
  host is the target, secrets do not enter settings/logs, and unsupported older
  connectors request an upgrade. Verify offline disable/revoke and confirmed
  identity reset. Delete enabled and disabled registrations: cancelling preserves
  access, confirming clears settings and revokes all browsers/invitations while
  agents continue. Confirm the relay row disappears and re-registration leaves one
  current entry. Repeat with the relay offline, then restart the connector without
  a saved config and restore relay connectivity: queued cleanup must finish.
  Disable alone must retain the account row. Remove legacy offline entries with
  Settings → Hosts → Remove, checking cancellation and same-named host isolation.
  With an older relay, keep cleanup queued until upgrade. After deletion, fresh registration must require
  a new sign-in handoff (or CLI code) and new approvals. Older connectors must hide deletion. Test actual
  systemd/launchd enablement on disposable hosts.
- Confirm new desktop settings pre-fill the application/relay addresses. Edit a disabled
  registration in place, cancel to restore saved values, then sign in to replace it.
  Confirm sign-in opens the browser on the machine displaying the UI, including
  from an SSH Electron window, without launching a browser on the remote host.
  Match the request identifier in the external browser and verify OAuth/MFA returns
  to the pending confirmation. Cancel or close desktop settings before confirming:
  no connector must be enabled. Repeat after expiry and with an older/unavailable
  service; surface an error without retrying an uncertain enablement.
- Build the example images from a clean checkout and launch with distinct real
  app/relay HTTPS origins. Confirm only ingress ports are published; the daemon
  remains unreachable directly. Check CSP, framing, MIME and cache headers.
- Complete Google and GitHub login against operator-owned applications; verify
  public signup for unrelated verified provider identities, rejection of unverified
  email claims, optional TOTP and a recovery code. Confirm
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
| Portrait/landscape; keyboard open/closed | Terminal key strip sits above the keyboard; shared dialogues fit the visible viewport and safe areas |
| IME composition, Unicode, dictation, multiline paste | Native composition remains intact; Send follows terminal paste mode and submits once |
| Direct terminal typing; Escape, Tab, arrows, Enter, Ctrl/Opt chords | Tapping xterm opens the keyboard; touch controls retain focus and deliver hardware-equivalent sequences; one-shot modifiers clear after use |
| Image picker and desktop clipboard image paste | Image button opens the native picker; accepted images appear in the host worktree and their paths are inserted once without submitting or clearing the composer; larger photos fit the remote limit with a resize notice; unsupported images fail visibly, cancellation sends nothing, and selecting the same image twice works |
| Long output and text selection | Terminal remains responsive; hold-and-drag selects Unicode text across rows, Copy writes only on tap, edge dragging scrolls history, and quick swipes remain scrolling; file text supports native selection handles and Copy |
| Terminal swipes, including scrollback boundaries and keyboard open/closed | History scrolls in both directions without moving the page or opening the keyboard; agent-owned mouse/alternate-screen scrolling works; a subsequent tap still opens the keyboard and pinch zoom remains available |
| Long file tree, file contents, session rail, settings and project dashboard | Each surface scrolls independently; gestures at either boundary do not move the surrounding workspace |
| Desktop and phone on the same PTY | Active viewer claims size; hidden/background phone does not repeatedly resize |
| Lock/suspend; Wi-Fi to cellular; offline during Send | Draft survives, uncertain outcome is visible, no automatic replay |
| Return to existing runtime after expiry | Fresh admission and canonical snapshot; agent continues on the host |
| Project cards and session rail | Hosts have separate card groups; only the active project’s non-archived sessions appear; tap switches, hold opens details, archive/restore and rail expansion work |
| Files and custom paths | Double-tap opens text, Back returns to the same directory, path dialogue starts at the current directory/file, typed file paths open the viewer, and custom host roots and projects without sessions can be browsed |
| Disconnect in settings | Viewer closes without stopping agents; the host stays disconnected until Connect during this visit |
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
