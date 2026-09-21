# Connection authority acceptance (protocol 18.0)

Keep automated evidence and manual results separate. Node HTTP/WebSocket tests
check server enforcement and production client logic; they do not establish
browser cookie policy, rendering, keyboard activation or Electron behaviour.

## Automated checks

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm test:e2e`, `pnpm test:ssh` and `pnpm build:tarball`. The process suite
uses temporary Puddle homes/repositories, sanitised subprocess environments
and deterministic fake agents. It runs built cockpit processes and real
replacement, including canonical terminal replay, upstream recovery with a
changed daemon port, uploads/downloads, local sync, proxy HTTP/WebSockets and
streams lasting beyond the first connection token. No installed daemon is
started or changed and no browser package is required.

`test:ssh` additionally requires `/usr/sbin/sshd`, `ssh`, `ssh-keygen` and a
permitted local account. CI installs OpenSSH server and creates `/run/sshd`;
the suite supplies temporary keys, pinned known-hosts and loopback listeners.
It tests shared-master and non-multiplexed channels plus host-only legacy
inspection. Controlled-clock unit tests cover expiry boundaries, rotation,
late timers, explicit resource renewal and browser inactivity. Client logic
tests cover invitation clearing, error audiences and refresh readiness.

Process assertions scan browser/verifier state, registry records, captured
application requests and process logs for credential leakage. Review any new
subprocess arguments or diagnostic paths when changing authentication.

## Manual setup

Use a **plain shell**, never an agent terminal, for real-agent verification
(see CLAUDE.md's orchestration-environment warning). Use a disposable home and
repository. Build first; start a daemon in that shell and launch the built CLI
with the same `PUDDLE_HOME` in another plain shell:

```sh
pnpm build
export PUDDLE_HOME=$(mktemp -d)
node packages/daemon/dist/index.js
# In another plain shell, export the same PUDDLE_HOME, then:
node packages/cli/dist/index.js launch --foreground --no-upgrade
```

Do not read `PUDDLE_HOME/token` into browser tools: it is host-only authority,
not a browser credential. For manual API probes, copy an authorised request
from the cockpit's Network panel; keep its browser credential private and
include the exact cockpit Origin for writes. Use `localhost`, not `127.0.0.1`,
for cockpit routes. Remote and desktop checks require a disposable host/home
and the normal SSH credentials; do not substitute the installed personal daemon.

## Browser and refresh

1. Launch, confirm the invitation fragment disappears immediately, then reload.
   Login remains; localStorage contains only a `br_` browser credential under
   `puddle.browser-authorisation`, never a master or `cn_` credential. Reusing
   the invitation fails. A pre-upgrade tab with `puddle.token` or `#token=` asks
   for `puddle launch` once and never converts its old credential.
2. Open a sibling tab and a separate browser profile. Closing one tab leaves
   the others working. Repeated launch supplies a fresh invitation through
   launcher IPC; registry JSON and background logs contain no invitation URL.
   `--no-browser` prints an invitation only in the requesting terminal.
3. Keep an unsaved editor draft, several terminal tabs, a resized layout and a
   non-default route. Activate **⌘K/Ctrl+K → Refresh connection**, then repeat
   with the connection-banner action after an upstream outage. Check pending
   state, duplicate suppression, automatic reload, retained login, draft,
   route and layout. Terminal replay restores the canonical screen once;
   previously sent input never executes twice.
4. Delay replacement startup. The old process, rejected requests or an
   unrelated replacement must not trigger reload. Watch `/cockpit/status`:
   the matching refresh id, a new instance and `upstream: ready` are required.
5. Kill/restart only the disposable cockpit; retained browser login works.
   Stop the disposable daemon: local sync and authenticated status/refresh
   remain available, and login is retained. Restart it, including with its old
   port occupied: the cockpit recovers with fresh authority. Input attempted
   while disconnected is never replayed later.
6. Revoke one browser through authenticated `POST /cockpit/logout`. Its active
   terminal and proxy streams close; the separate browser remains authorised.
   Browser inactivity expiry asks for a fresh launch, while upstream expiry
   only reconnects. Do not change the machine clock to simulate lease expiry;
   the automated controlled-clock tests cover that boundary.

## Forwarded applications

1. On a disposable SSH session, start an HTTP/WebSocket app and click its port
   or a terminal localhost link. The reusable link is a trusted cockpit
   `/forward/…` route; final application content runs on `127.0.0.1` while the
   cockpit remains on `localhost`. Neither address retains a credential.
2. Inspect browser cookies: the proxy grant is HttpOnly, host-only and scoped
   to `/proxy/<placement>/<port>/`, with SameSite=Strict. Reload the app, use
   its own authentication headers/cookies, and exercise WebSockets/HMR.
   A copied landing link works from an already authorised cockpit browser.
3. In application devtools, confirm the cockpit's localStorage is unavailable.
   Foreign/null-origin attempts to bootstrap, refresh, mutate the API or open
   cockpit WebSockets fail. A proxy page cannot serve its HTML at `localhost`.
   HTML editor previews retain their iframe sandbox.
4. Check absolute asset-path recovery under the proxy prefix; an unobserved
   port remains forbidden. Inspect application request logs: no Puddle bearer,
   resource id, browser credential, proxy grant or legacy query credential
   reaches the app. Application headers and query parameters remain intact.
5. Keep a download, terminal and proxy WebSocket active for more than 60 seconds.
   Rotation preserves them. Stop their cockpit/control channel: those streams
   close, while another cockpit and daemon-owned agents continue.

## Real SSH, desktop and migration

- Repeat with multiplexing and without it. Interrupt the control channel and
  then a silent network partition: known closure revokes immediately; missing
  participation expires by 45 seconds. Restore the network and verify a fresh
  generation/handshake, retained browser login and no duplicated mutations.
  Interactive password/MFA recovery remains a plain-shell or desktop-askpass check.
- In Electron, repeat banner and command-palette refresh, then **File → Refresh
  Connection**. Ordinary refresh keeps the origin. Occupy its old port during
  replacement and verify a new invitation preserves the workspace route.
  Reopen windows and confirm drafts/layouts survive ordinary refresh.
- On disposable legacy installations, try `--no-upgrade`, a failed upgrade,
  successful protocol-18 upgrade and restart. Refusal/failure leaves legacy
  state recoverable. Success retires the old master once, closes legacy
  connections and requires one fresh launch; another restart does not rotate
  host authority again. A newer unsupported protocol requests a compatible CLI.

Record platform, browser/Electron version, scenario and observed result for
manual runs. An automated green suite must not be reported as these checks
having been performed.
