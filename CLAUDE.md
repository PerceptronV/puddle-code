# CLAUDE.md — puddle

Puddle is a self-hosted orchestrator for CLI coding agents with first-class SSH support: a persistent daemon (`puddled`) runs on whatever machine hosts the work — your own laptop (`puddle launch`) or a remote box (`puddle launch user@host`) — and owns git worktrees and session state; one independent `puddler` per runtime owns agent PTYs and sidecars; a web UI provides project workspaces with terminals, editing, diffs, git history, and port forwarding. The full design is in `SPEC.md` — read it before making architectural changes.

**Read `HUMANS.md` at the start of every session.** It is the human-authored design brief for the UI's feel (minimalism, transparency, no boxes/borders, hover responsiveness) and it overrides SPEC §12 and any framework default wherever they conflict. Any UI work that ignores it is wrong by definition.

## Repo map

```
packages/
├── shared/    # the protocol package: zod schemas for REST + WS messages (the single source of
│              # truth for API shapes) + PROTOCOL_VERSION — read its PROTOCOL.md before schema changes
├── daemon/    # puddled: Hono HTTP/WS server, PTY manager, worktree manager, SQLite
│   ├── src/storage/      # capacity monitoring, admission checks and bounded runtime persistence recovery
│   ├── src/security/     # private host control, process claims, connection leases and resource revocation
│   ├── src/updates/operations/ # durable host-update state, exact approval/dispatch and bounded history
│   ├── src/updates/worker/ # pinned one-shot updater and exact component activation
│   ├── src/updates/verification/ # shared execution/recovery adoption, service and selection evidence
│   ├── src/updates/recovery/ # explicit completion recovery under dispatch/execution claims
│   ├── src/updates/preflight/ # compatibility, interruption, capacity and supervision inspection
│   ├── src/updates/coordinator.ts # private host-authorised preparation, review and dispatch
│   ├── src/host/         # shared service definitions/commands plus supervision/ identity inspection
│   ├── src/agents/       # adapters own flags, cached native catalogue discovery, and exact lifecycle integration
│   ├── src/puddlang/     # trusted TypeScript runner, bounded operations and durable run/event records
│   ├── src/huddle/       # definitions/, components/, control/: inactive authoring and bounded source capture
│   ├── src/compilation/  # provider-neutral compile modes, scheduling, dependency observation, and artefacts
│   ├── src/code/         # manual single-file execution recipes, host tool discovery and managed output
│   ├── src/latex/        # local TeX discovery/recipes, managed outputs, and inverse SyncTeX
│   ├── src/notebooks/    # daemon-owned Jupyter kernels, bounded bridge and explicit lifecycle
│   ├── src/host/         # lifecycle admission, supervision, installation exclusion, startup and removal
│   ├── src/sessions/     # placement service, shared environment/identity and watched conversation catalogue
│   │   └── legacy/       # daemon-owned PTYs, nonce/conversation indexes, signals and exit handling
│   ├── src/runtime/      # puddler entry point and owner composition (standard backend for 0.4.0)
│   │   ├── ownership/   # claims, private records and owner discovery/retirement
│   │   ├── transport/   # bounded IPC framing, client and controller connections
│   │   ├── execution/   # provider resources, turns, signals and pinned helpers
│   │   ├── state/       # retained journal/segments, shell observations, titles and attention
│   │   ├── controller/  # daemon reconciliation, placement controls, viewers and notifications
│   │   ├── lifecycle/   # launch, supervision and ended-service cleanup
│   │   └── huddle/      # owner composition; transport/, control/, state/, execution/, workers/
│   └── src/worktrees/    # worktree lifecycle plus repository-aware Git inspection/mutations
├── web/       # React UI: Tailwind v4 + owned shadcn-style components (src/components/ui/)
│   ├── src/styles/tokens.css   # THE colour source; scripts/check-tokens.mjs guards it in lint/CI
│   ├── src/lib/       # transport/, queries/, settings/, persistence/, appearance/, navigation/, notifications/, hooks/
│   ├── src/features/  # dashboard, workspace (sidebar/tabs/xterm), editor/explorer/changes/search/worktrees
│                      # (Monaco tabs + drafts + dirty-diff gutter, file tree + transfer, repository-aware
│                      #  source control + commit-graph SVG, filename+content search), scratchpad + layouts (top-bar
│                      #  popovers), settings, ⌘K palette
│   ├── src/features/editor/ # buffers/, conflicts/, compilation/, monaco/, notebooks/ (including widgets/),
│   │                       # previews/ (html/, markdown/, pdf/), tabs/; pane composition stays at the root
│   ├── src/features/workspace/ # layout/, panes/, sessions/, sidebar/, tabs/; Workspace and shared context at the root
│   ├── src/features/windows/ # state/, transfers/content/, arrangements/, drag/, navigation/, lifecycle/, effects/, recovery/, menus/;
│   │                        # native window context and renderer composition stay at the root
│   ├── src/features/terminal/ # clipboard/, input/, links/, rich-output/, scroll/; terminal composition at the root
│   ├── src/features/guide/ # public deployed-app /guide; edit guide.md for setup/upgrade instructions
│   └── src/features/remote/ + mobile/ # remote account/pairing/settings + host-grouped project cards,
│                                     # Files/Terminals workspace, session rail and touch terminal keys
├── remote-transport/ # standalone Noise XX + bounded encrypted framing (remote protocol 5)
├── connector/ # outbound host connector: exact device approval, route allowlist, manual host leases
├── remote/    # self-hosted Better Auth service + opaque bounded WSS relay; no host content storage
├── cli/       # @puddle-code/cli (the command is `puddle`): serves the UI at localhost:7433 and
│   │          # proxies /api + /ws + /proxy to the daemon on 127.0.0.1:7434 (through the ssh
│   │          # tunnel remotely); bootstrap/handshake/attach live in src/lib/ (no process/TTY
│   │          # access there — the desktop shell reuses it; src/lib/index.ts is the deliberate
│   │          # embedder surface), the bin in src/cli/
│   ├── src/lib/auth/    # connection authority, host-only inspection and protected launcher IPC
│   ├── src/lib/connection/ # attach, frontend lifecycle, daemon connection and compatibility handshake
│   ├── src/lib/installation/ # bootstrap, releases, component versions, upgrades and removal
│   ├── src/lib/host/    # host-side file-manager and remote-registration controls
│   ├── src/lib/transport/ + serve/ # local/SSH transport and browser gateway integrations
│   └── scripts/build.mjs   # esbuild bundle + embeds both installers + copies web assets into dist/
└── desktop/   # @puddle-code/desktop (private): the Electron shell — a thin main process calling
               # startLocal() from @puddle-code/cli/lib and opening a BrowserWindow on the
               # embedded frontend. Shell concerns only (windows, OS links, notification raise);
               # anything both shells need goes in cli/src/lib, NEVER here. Build mirrors the
               # CLI's (scripts/build.mjs); `pnpm --filter @puddle-code/desktop dist` packages it.
               # src/windows/ groups hosts/, persistence/, lifecycle/, transfers/ and arrangements/;
               # project routing and private state IPC compose these at its root.
deploy/remote/       # self-hosted service/static app images, Caddy TLS ingress and private env example
scripts/build-tarball.mjs   # self-contained host archive: puddled, puddler and connector, CURRENT platform
scripts/build-cli-tarball.mjs # self-contained CLI archive; shares scripts/lib/node-runtime.mjs
scripts/install.sh          # internal daemon bootstrap, embedded in CLI/desktop; never published alone
scripts/install-cli.sh      # public CLI installer, published as install.sh
scripts/stage-installers.mjs # stage only the public CLI installer as install.sh
docs/assets/          # README imagery: frontend hero screenshots (dark chromeless, light in Mac chrome)
docs/changelogs/      # archived per-version changelogs (see Changelog discipline)
docs/acceptance/      # manual per-phase acceptance scripts (real-agent verification CI can't do)
docs/roadmap/         # deferred feature designs with resolved decisions and implementation seams
docs/reports/         # dated investigation write-ups (root cause + measurements), e.g. perf/battery
```

Explorer composition stays in `web/features/explorer/explorer-context.tsx`;
`use-explorer-navigation.ts` owns tree/selection state, `use-explorer-actions.ts`
owns file-operation intent and clipboard policy, and `use-explorer-interaction.ts`
arbitrates gestures and shortcuts. Header controls use their separate stable
context. Session sidebar presentations live under `workspace/sessions/sidebar/`,
sharing the workspace-owned selection controller and session action policy.

Within `shared/src/api/`, schemas are grouped into `agents/`, `connection/`,
`huddle/` (documents and inactive authoring contracts),
`notebooks/`, `workspace/` and `worktrees/`; common and smaller host/execution
schemas remain at the root. `shared/src/index.ts` remains the public export surface.
Daemon HTTP routes group worktree handlers under `http/routes/worktrees/` and
compilation, LaTeX, notebooks and puddlang under `http/routes/execution/`.
Web, daemon and CLI tests live under `test/<feature>/`, mirroring the source
responsibility; reusable fixtures stay in `test/helpers/`. Existing recursive test
discovery includes these directories. Numbered database migrations remain together
in their ordered directory.

Private desktop window contracts live under `shared/src/desktop/windows/`, grouped
into identities, content, persistence, transfers, drag, project navigation, commands
and the composed bridge. Export them through the existing package entry point.
Window tests mirror the source responsibility directories.

Keep components and their supporting logic beside the feature they serve. Split a
crowded directory by responsibility, retain composition modules at its root, and
import implementation files directly; avoid forwarding modules just to preserve
old internal paths. Keep package entry points stable and update asset paths,
fixtures, build tooling and current documentation whenever files move.

## Commands

```
pnpm install            # workspace install
pnpm dev                # daemon TypeScript watch + web (Vite); start daemon separately
pnpm --filter @puddle/web dev:preview # UI with sample data, no daemon; localhost:5174
pnpm --filter @puddle/web test:preview # browser checks against the running preview
pnpm --filter @puddle/web test:windows:headless # window flows in headless Chromium; requires UI preview
pnpm build              # all packages; web assets land inside the CLI (packages/cli/dist/public)
pnpm test               # vitest across workspaces
pnpm lint               # eslint + prettier check
pnpm test:e2e           # after build: isolated daemon/frontend process tests, no browser download
pnpm test:remote        # transport, host authority and live relay authentication tests
pnpm test:mobile        # after build: isolated HTTPS browser/connector/daemon flow (Playwright Chromium)
pnpm test:ssh           # after build: loopback OpenSSH integration (sshd + ssh-keygen required)
pnpm build:tarball      # self-contained puddled tarball for this platform (dist-release/)
pnpm build:cli-tarball  # standalone CLI archive (after build; same output directory)
pnpm --filter @puddle-code/desktop start   # run the Electron shell (after pnpm build; NOT from
                                      # inside an agent session — see the puddled warning below)
pnpm --filter @puddle-code/desktop dist    # package it (dmg/zip/AppImage via electron-builder)
pnpm --filter @puddle-code/desktop test:native-key-release # macOS; requires running UI preview
pnpm --filter @puddle-code/desktop test:native-windows # isolated Electron; requires UI preview
pnpm --filter @puddle-code/desktop test:native-window-transfers # isolated native transfer faults; UI preview
```

Mac desktop builds compile `desktop/native/command-key-up.m` with Xcode command-line
tools and the build-only `node-api-headers` dependency. The universal Node-API
module is unpacked with the app; its AppKit monitor forwards app-local Command
key releases that NSApplication otherwise swallows. The native regression check
uses an isolated UI-only Electron window and real AppKit key events, never a daemon.

The native window check bundles the real main process/preloads with a compile-time
preview host replacement, rejecting CLI library inputs. It uses temporary app data,
never starts a daemon, and intentionally crashes only its own test processes.
Set `PREVIEW_URL` (default `http://127.0.0.1:5186/`); optionally set
`PUDDLE_NATIVE_REPORT` to write idle/editor-work process measurements. See
`docs/acceptance/windows.md` for scope and remaining native checks.
`PUDDLE_NATIVE_RECOVERY_ONLY=1` explicitly omits OS focus/fullscreen assertions
while exercising lifecycle and missing-resource recovery; it does not replace
the full native acceptance run.
The full run checks macOS console lock state before launching and requires an
unlocked desktop for focus/fullscreen evidence. It never unlocks the session or
silently substitutes recovery-only acceptance.

The native transfer check uses the same isolated build and `PREVIEW_URL`. Its
test-only IPC interceptor pauses or rejects selected replies around the real
handlers, verifying renderer-crash rollback and observation after a lost commit
reply. It does not require native focus and does not establish OS drag coverage.

For non-disruptive window verification, use `test:windows:headless` with
`PREVIEW_URL` set to a UI-only preview. It runs headless Chromium against the real
window coordinators and renderer components, with synthetic native bridges; it
never launches Electron or moves the OS pointer. Optional case-name arguments
select individual checks. The separate `test:native-*` commands open real windows,
change focus and may enter fullscreen; do not run them while the user is working
on that desktop unless the user explicitly requests those interactive checks.

For manual testing before a release exists: `pnpm build && pnpm build:tarball`, then
`node packages/cli/dist/index.js launch --tarball dist-release/puddled-v*.tar.gz` (or
`launch user@host --tarball …`). The daemon default port is 7434; the CLI serves the
UI at 7433. `launch` backgrounds itself once ready — pass `--foreground` when
developing so the frontend stays attached to your terminal (`puddle list` / `puddle
kill` manage backgrounded ones; `puddle refresh` is kill-then-launch in one step, also
reachable from the UI's connection banner).

`puddle install <daemon|runtime|desktop>[@version] [user@host]`,
`puddle upgrade [cli|daemon|runtime|desktop][@version] [user@host]`, and
`puddle remove <cli|daemon|desktop> [user@host]`
manage installed components (SPEC §10): install ensures presence, upgrade
moves to newest (or the named version; bare `upgrade` covers the installed local
daemon, runtime default and macOS desktop, then the CLI), remove uninstalls behind y/N confirmations — daemon
removal keeps ~/.puddle's data unless purged, and sweeps worktrees for
uncommitted/unpushed work first. cli/desktop are client-machine only;
`upgrade desktop` still installs the macOS app when none exists (writable
`/Applications`, else `~/Applications`); Linux desktop stays in-app-update
only (an AppImage has no fixed install path).

Standalone CLI installs live under `~/.local/share/puddle/cli` (XDG/`--prefix`
overrides supported), with a `~/.local/bin/puddle` wrapper. CLI upgrade/removal
uses the actual installation channel; daemon removal cannot delete the CLI.
Keep old standalone release trees during upgrades: live frontends serve their assets.
Host bootstrap stages immutable `bin/versions/<release>~<generation>` trees and
atomically selects `bin/current` (daemon) or `bin/runtime-current` (runtime); never
overwrite a published tree, including a
same-version repair. Keep old trees until reference-aware collection proves them unused.
Read release identity from `VERSION`, with fixed-version symlink fallback only
for legacy installations. The bootstrap lock serialises installers alongside the
durable runtime-aware update coordinator. Runtime bootstrap
uses the same implementation with explicit component selection and never starts or
restarts a service. The default launcher uses `installed: true` to resolve and pin
one complete runtime release at each launch; reject unsupported metadata before
recording intent. Runtime install/upgrade uses the coordinator through a running
25.7+ host and an available user service manager; it never restarts existing owners.
Local runtime archives require an explicit `@version` and verified checksums.
`puddle updates [user@host] [--operation <id>]` observes durable state;
`--cancel` requires the exact id and only cancels before dispatch. Runtime removal
uses coordinated daemon removal with reviewed retain/stop choices and reference-aware
collection; there is no standalone `remove runtime` command or backend-disable option.
Retain live owners' records and pinned software. Host staging and exact activation
reuse the embedded installer: a private receipt fingerprints the complete candidate;
activation rechecks it and never re-downloads a substitute. Keep stage receipts
separate from update approval and single-use operation state. Retain failed/unselected
stages until reference-aware collection can prove they are unused.
Host-update operation state lives under daemon `updates/operations/`; do not equate
its private ledger with host authority, preflight or completed adoption. Keep unknown
execution nonterminal until positively verified recovery. Claim release after a crash
never resets dispatch consumption. Shared host claims live in `security/claims.ts`;
retain the historical `runtime-claims` directory and hashed lock filenames so older
live owners keep excluding newer controllers.
The coordinator uses the existing private host-control channel (application 25.7),
with bounded correlated calls and participating authority. Local/SSH leases are
host-wide; ordinary profile-scoped connector leases and HTTP tokens cannot enter
maintenance. Application 26.0 adds the separately granted exact-device private
maintenance bridge described below, without widening ordinary profile access.
Maintenance traffic never renews a lease. Recheck authority after async work and before durable dispatch;
after consumption, lost replies are observation-only. CLI preparation reuses the
existing transport and installer, and only the caller that created the operation
stages its files. Runtime-default apply reinspects exact approval evidence. Application
25.10 adds separate interruption consent bound to the exact release/impact fingerprint;
missing consent never permits daemon-owned work to be stopped. Older clients retain
the blocked review shape. Production daemon activation uses
`updates/maintenance/daemon.ts` to drain writers before pausing discovery/reconciliation.
Retain the hold after accepted or uncertain
dispatch; release only after an unaccepted attempt or positively fenced recovery.
Application 25.11 adds explicit completion recovery through `puddle updates --operation <id> --recover`.
Hold dispatch/execution claims, fence the old worker and verify its recorded process
group has ended before completing from fresh adoption/selection evidence. Record the
worker's own group durably before any activation; its commands must not detach.
Maintenance release after worker execution requires ended-group evidence too. Missing
records, permission errors or reused groups retain the hold; never signal a stored
group to recover it. Completion verification never continues an incomplete installation.
Ordinary daemon upgrades share runtime updates' `cli/src/lib/installation/host/upgrade.ts`
and `apply.ts`, including exact interruption approval through a shell-owned callback.
Recheck participating authority after prompts; missing consent leaves staged work intact.
Observe lost activation replies without retry, and never fall back to bootstrap after
a coordinator/inspection failure. Passive modern metadata also blocks blind installation
when the daemon cannot connect. `installation/host/start.ts` and `auth/readiness.ts`
share selected-service startup and authenticated observation between launch and explicit
stopped-host upgrades. The selected pinned updater's `--start-daemon` mode uses
`daemon/src/host/startup/` with existing claims and installer exclusion, requiring
unchanged supervision and the selected executable. Release only the controller before
one start; never rewrite configuration, selectors or controller records. A dispatched
unfinished update requires recovery, while undispatched preparation may survive startup.
Retain ended-worker checks for completed operations. Lost startup replies never cause
another start, legacy installation or attached fallback. Share supervisor marker and
definition readers under `host/supervision/`. Explicit startup/recovery may reset only
the exact positively stopped systemd unit's `start-limit-hit` result. Keep controller
exclusion through reset and repeat current configuration/database/runtime checks before
start; lost reset replies must not dispatch a start. Share stopped-service parsing in
`host/supervision/stopped.ts`. Loaded-idle launchd recovery shares
`host/supervision/launchd.ts` with running inspection: verify GUI context and exact list
columns, retain controller/update exclusion,
recheck the idle job, unload it once and prove removal before bootstrapping the validated
plist. Never trust the previously loaded definition or treat idle as shutdown proof;
lost unload replies stop the attempt. Database/runtime checks still precede controller
release. `host/installation/lock.ts` and `scripts/install.sh` share a permanent private
regular `bin/.install-lock` inode and non-blocking flock (Linux's flock command/macOS's
system Perl). Never unlink it during operation. Pass its descriptor to bounded commands
so surviving children retain exclusion after parent SIGKILL; close it for long-lived
nohup daemon launches. Stage scratch files under `cache/install/`. Legacy directory
locks have no owner proof and must not be automatically removed. Coordinated
removal/purge is implemented; native removal and reboot acceptance remain required.
Application 25.13 exposes local/SSH `GET/POST /frontend/updates` through the existing
gateway, including Vite. Keep browser schemas in `shared/api/connection/frontend-updates.ts`
and control/projection beside the existing `cli/lib/host/updates/` helpers. Preparation
reuses `installation/host/updates.ts`; activation remains a separate exact approved
request. Never accept browser-selected transports, receipts, paths, tarballs or commands.
Require exact Origin/browser authority. Give each mutation a cancellable existing
host-control channel tied to the parent frontend lease and browser request lifetime,
so pre-dispatch revocation reaches the coordinator without revoking other windows.
Do not retry an uncertain mutation or fall back to offline dispatch. Public replies
omit private stage/worker evidence and blocker paths. Supporting local/SSH frontends
now expose recorded status and explicit offline continuation. Remote maintenance
uses the separate application 26.0 grant; offline continuation stays local/SSH.
Application 25.14 adds optional host-update catalogue reads. `daemon/updates/catalogue/`
owns bounded runtime-build presentation and one lazy 30-minute release poller, retaining
timestamped last-known results and cadence across daemon replacements. Share latest-stable
lookup/source parsing in `shared/node/releases/` with CLI/desktop; do not add per-window
GitHub polling or native-store scans. Publish the repository in host archive builds too.
Frontend staging takes its source from private host catalogue metadata, never browser data
or an unrelated client override. Availability is not checksum verification or admission;
discovery must never activate, restart or silently advance a pinned version. Keep
`host-updates-changed` host-wide and excluded from profile leases, and send catalogue
fields only to callers requesting them. Browser controls and window offers live together
in `web/features/host-updates/`. Share one status query between Settings and shell offers;
refresh on host invalidations/reconnect, never retry or queue a mutation for reconnect.
Keep preparation, impact review and apply separate; match the current operation revision
and exact interruption fingerprint before exposing approval. Preserve dismissal across
React remounts in the same window. Compatible release skew must not become an update
condition. Keep recorded/offline recovery distinct from fresh service proof;
native desktop-dialog and remaining platform recovery acceptance remain open.
Application 25.15 adds local/SSH session runtime inspection/restart. Keep orchestration
in `sessions/runtime/`, reusing RuntimeControls' queue/clean-exit observation and normal
SessionService resume. Fingerprints bind the exact owner, placement, native ref, shell
generations and selected release. Recheck authority and selection before replacement
intent; stale/lost replies never authorise another restart. The inspector lives beside
workspace session actions under `sessions/runtime/`; it lists affected terminals and
lost process state. Remote profile leases/connector operations remain excluded pending
their explicit integration. Never restart existing runtimes as part of installation.
Application 25.16 adds optional live/recorded observation provenance to frontend update
status. Disconnected reads reuse the trusted local/SSH helper, retain browser authority
checks and discard replies after cancellation or connection changes. Never present a
recorded operation as fresh service/adoption proof.
Application 25.17 adds explicit `continue-offline` through the selected OS/SSH helper
under the existing frontend browser authority/Origin boundary. Keep it separate from
live recovery; never fall back after a lost mutation. Require supporting staged metadata
and the pinned participating dispatcher. Input/channel closure and signals revoke pending
acceptance, while accepted independent jobs continue. Reuse the existing private envelope
and correlated requests; do not issue or renew a daemon lease or expose this to the relay.
Read-only `puddle updates` falls back to the existing local/SSH bootstrap helper
when authority cannot connect. Share bounded ledger validation through
`shared/src/node/installation/updates.ts`; label recorded evidence and never use
it for fresh adoption, cancellation or dispatch. Inspection must not open SQLite
or start a service.
Application 25.12 adds explicit `--continue`, using private authority online and the
separate `--continue-update` OS/SSH helper offline. `cli/src/lib/host/updates/continuation.ts`
validates the staged daemon's capabilities and pinned worker before invoking its
exact revision once. Share passive metadata, executable and attempt readers under
`shared/src/node/installation/`; never copy daemon mutation logic into the CLI.
Inspect recorded acceptance after a lost reply without redispatch. Status includes
public recovery ids/revisions/consumption only when `include_recovery` is requested;
consumption is not proof of liveness or completion. Never fall back to offline
dispatch after an uncertain live mutation. This offline helper remains local/SSH;
granted remote maintenance uses online private control only.
Worker step intent lives in `updates/worker/actions.ts` with private shared schemas
under `installation/actions.ts`. Persist intent before any stop/select/start step;
never overwrite an existing journal or infer replay permission from started steps. Finished entries do
not substitute for fresh service/adoption checks, and missing old journals cannot
prove a command was never attempted. Use the existing installer and supervisor
helpers inside these boundaries.
Shutdown observation is shared through `updates/verification/shutdown.ts`; normal
updates and internal recovery must verify the exact service definition, checkpoint
and released original controller before retaining its claim. Recovery's common
dispatch/execution exclusion lives in `updates/recovery/claim.ts`. Recheck authority
and ended-worker evidence after asynchronous probes; never mint a new controller
epoch or issue another stop to recover a lost reply. Candidate compatibility uses
the same checkpoint gate as ordinary execution. Public continuation reuses this gate.
Recovery worker dispatch/execution lives under `updates/recovery/worker/`, sharing
the original updater's pinned executable checks, service definitions, journal writer
and completion verifier. Persist each accepted attempt before dispatch and its process
group before component commands. Fence pending attempts and check every consumed
group before completion recovery or maintenance release. `recovery/actions.ts`
merges every consumed journal and validates historical acceptance fingerprints;
never let a later early failure reset earlier attempted work. `recovery/continuation.ts`
retains either the original stopped hand-off or fresh replacement adoption, sharing
`verification/daemon.ts` with completion. Running continuation never stops/restarts
the replacement or changes its controller. Recheck current adoption before commands;
connector startup needs an unattempted stopped service or separately accepted restart evidence.
`recovery/restart/` handles a fresh explicit daemon start after confirmed service
loss. Hold the existing controller claim, read current SQLite/WAL data without
migrations, and bind current schema, runtime inventory/default and selectors into
the accepted attempt. Reinspect before releasing the controller for startup; never
infer absence from an active flag, failed HTTP probe or stale PID. Share bounded
inventory inspection with preflight. `checkpoints/requirements.ts` retains original
and restart-observed owners for fresh adoption, including later launches. Packaged
crash/start-limit acceptance remains unfinished. A fresh explicit recovery can accept
`connector_restart` evidence for an attempted connector start only after unchanged
service, ended outgoing PID and absent manager checks. Bind the approved service and
selected generation, recheck before startup/after any rate-limit reset, and never turn
an observation-only attempt into permission to start. Healthy replacements need no
restart. Native connector recovery acceptance remains open. These private records add
no network protocol.
Runtime owners and update workers share `host/services.ts`; neither service may
inherit puddled's restart or termination boundary. Systemd `WorkingDirectory`
uses a literal specifier-escaped path, not `ExecStart` argument quoting; validate
generated definitions with the native unit parser. The packaged one-shot updater
composes runtime-default and daemon/combined selection using its pinned copy of the
canonical installer, exact connector/service replacement, shutdown checkpoints and
fresh adoption verification. Exact `--select-only` activation preserves supervisor metadata;
`--no-supervisor` remains the bootstrap choice that records `none`. Release continuity
promises still require packaged upgrades and recovery paths to pass acceptance.
Service identity inspection lives under `host/supervision/`, sharing the bounded
command runner. An installer marker is not live supervision evidence. Do not parse
launchctl diagnostic output as an API; preserve exact PID/service checks and verify
the updater's own independent service scope before enabling daemon replacement.
The remote app and new GitHub releases publish only the CLI installer at
`/install.sh`. Install daemon/desktop components through the CLI; the embedded
daemon bootstrap still fetches GitHub archives automatically on first local/SSH
connection. Rebuild the app when installer logic changes. See SPEC §10 and
`docs/mobile-access.md`.

On an SSH host where the installer selected `nohup` but the host reaps that
child as soon as its exec channel closes, `puddle launch` falls back to an
SSH-attached daemon for the frontend's lifetime. Closing that frontend stops the
daemon and detaches independent owners. Host-session runtimes may survive, or the
host's SSH/login teardown policy may stop them; do not promise either outcome.
SQLite state, worktrees, logs, agent configuration and native session refs remain
under `~/.puddle`. Reconnection adopts surviving owners; ended owners reconcile
to interrupted placements and auto-resume by default, or remain resumable when
host auto-resume is disabled. The fallback is allowed only after the
recorded nohup PID is dead — never start a competing daemon beside a live or
supervised one.

> **Never launch `puddled` from inside a coding-agent session** (e.g. a Claude Code terminal, including these dev sessions). The daemon inherits that agent's orchestration env vars — `CLAUDECODE=1`, `CLAUDE_CODE_*` — and passes them to the agents it spawns (PtyManager uses `{...process.env}` by design). A `claude` that sees `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` treats itself as a nested child and **does not write a resumable conversation transcript**, so `--resume` silently fails with "no conversation found" (verified against Claude Code 2.1.209: the identical session persists a transcript with these unset and writes nothing with them set). Start the daemon from a plain shell (systemd/launchd does this in production, so real deployments are unaffected). If a session won't resume during development, check the daemon's env first (`ps eww <pid> | tr ' ' '\n' | grep CLAUDE`).

## Conventions

- UI iteration: apply the requested visual change to the live development preview first, then review related surfaces and suggest consistency improvements before broadening the change. Related header/sidebar action groups share `web/src/components/ui/control-tray.tsx` and its theme-token CSS, including vertical collapsed-rail layouts. Use unfilled action groups in headers/notebooks and filled trays for sidebar controls; navigator selections follow the host accent (gold when unset), and PDF overlays retain a legible backing. Island outlines, radii and tray fills come from shared tokens; overlays keep their shadows. Host accents change palette values, never component-to-surface relationships: pane frames alias sidebar surfaces, and reading areas/active tabs keep the default theme background. Preserve the original default palette; only preset/custom accents add softened island and nested-tray depth. Shared `--ui-*` geometry tokens govern row/control/tab sizes and rounded insets. `recipes.ts` owns common fields/actions/overlays, and `components/ui/island-resize-edges.tsx` owns facing-edge resize feedback. Persistent tray identities are scoped with `TrayMotionProvider`; accessible labels are not cache keys. Desktop prompt builds embed the same palette. The token checker also guards application chrome against literal colours.

- **0.4.0 release requirement:** persistent runtimes and frontend-managed host
  updates are standard functionality for all users, with no enable/disable setting
  or user-selectable legacy backend. Production composition defaults to independent
  ownership; `DaemonOptions.runtime: false` is an internal legacy fixture override.
  Hosts without a usable service manager permit limited `host_session` owners only
  for explicit `nohup`/`none` installations; other unavailable lifetimes refuse launches.
  Legacy ownership remains for migration/recovery. Runtime-protocol compatibility
  covers both IPC and retained state; use supported runtime majors, not per-file
  compatibility declarations or matching release versions.

- Independent runtime status broadcasts follow committed observations and confirmed
  placement/acknowledgement. Browser resume reattaches the main terminal to its new
  generation and waits for replay before input; never buffer keystrokes across a
  replacement or reattach auxiliary shells that restart does not recreate. A
  restored, confirmed-exited viewer retains its transcript through owner shutdown
  without closing the shared socket. Only geometry failures after confirmed exit
  are harmless; uncertain input and incomplete snapshots still require recovery.

- Independent runtime PTYs use `PtyManager.spawnPrepared`: admit the canonical
  viewport and initial parser action, then await restore/geometry before native
  dispatch. Only unresolved durable admission may retry, under existing bounded
  waits and queues; definitive exhaustion refuses the new PTY. Fence pending
  launches per terminal, recheck controller/socket/placement after awaits, cancel
  preparations on release/forget/shutdown, and release unused screen allocations
  after failed dispatch. Never turn admission contention into an apparently
  healthy launch with a permanently missing canonical screen.

- The `pudl` command ships with the CLI and executes puddlang programmes as trusted single-file TypeScript on an existing local/SSH daemon (protocol 24.0, host Node 22.21.1+). Agent control belongs in provider folders under `agents/`: all four supported agents offer persisted interactive/headless modes. Codex interactive control uses its existing proxy; other interactive controls correlate prompt hashes through native hooks/plugins. Headless control resumes exact native refs and requires a successful structured result plus exit zero. Keep flags and parsers provider-owned; never infer replies from terminal quietness or catalogue discovery. Human input takes over hook-driven asks; custom stop hooks may continue past interactive completion (see the usage guide). Keep runs distinct from placement/conversation/runtime identities, recheck profile ownership per operation, retain account selection without fallback and never replay interrupted runs. Remote leases and the connector allowlist exclude puddlang. Automatic agent MCP binding, delegated credentials and descendant budgets remain deferred; see `docs/puddlang.md`.

- **British English everywhere**: comments, documentation, commit messages, UI copy, and identifiers you choose (`colour`, `initialise`, `behaviour`, `licence` as the noun). Exception: never rename third-party API surface — CSS `color`, `Array.prototype.normalize`-style library methods, and external config keys keep their canonical spelling.
- TypeScript strict; no `any` without a comment justifying it.
- Every REST/WS shape is a zod schema in `packages/shared`; daemon validates input, web imports the inferred types. Never define an API shape locally. The schemas are a versioned protocol: any wire-shape change bumps `PROTOCOL_VERSION` per `packages/shared/PROTOCOL.md` in the same commit (additive → minor, breaking → major).
- Launcher compatibility and daemon-update approval share `cli/src/lib/connection/handshake.ts`, reached through host control/inspection before API access. Desktop and CLI supply confirmation callbacks; background CLI launches relay the prompt over private parent/child IPC. Cancellation, missing approval and `--no-upgrade` never update an older live daemon. Later HTTP/reconnect checks only verify; never add a second upgrader or bypass the host authority boundary.
- Host maintenance and runtime inspection gates use shared `supportsApplicationFeature` with a fixed introduction version. Keep current-major compatibility separate from that floor: a later major resets its minor but retains existing features. This check never grants authority or replaces the handshake.
- Ordinary daemon bootstrap initialises the mandatory runtime default only when no runtime selector exists and the archive includes runtime support. Validate both executables, publish the initial runtime before the daemon and retain generations referenced by either selector after interruption. Preserve existing runtime pins; staged activation selects only explicitly reviewed components.
- Bootstrap and staging verify/extract/hash the same private archive snapshot and share the bounded receipt writer. Stamp only newly extracted supported generations; never rewrite or retrospectively verify reused trees. Unchecked local archives retain `checksum_verified: false`. Preserve a durably receipted generation after later failure for retention/collection.
- Remote maintenance requires a separate host-approved exact-device/registration/grant identity. Pairing grants none; only `connectorLocalRequestSchema` can mutate it, never remote administration. The daemon independently checks private registration/device/grant state on every maintenance authority check and invalidation is permanent for that control lease. Connector `/api/host/updates` bridges to bounded private control, never ordinary daemon HTTP. Reuse host-owned staging and the existing coordinator; redact private evidence, paths, free-form messages and repository configuration. Dedicated child channels renew only with browser participation and close on cancellation/revocation. Keep ordinary profile HTTP/WS permissions unchanged, offline recovery local/SSH and reconnect observation-only.
- Independent terminal monitors own a `TerminalProcessReader` for their exact main PTY generation. Cache only a verified TTY, recheck the root in every scoped snapshot, and discard the cache on replacement, inspection failure or monitor disposal. Failed scans must not become successful empty snapshots that imply child exit.
- Connection authority lives in daemon `security/` and CLI `lib/auth/`; browser credentials, connection tokens, host authority and agent signal nonces have separate audiences. Never read a remote master token into the client, persist a connection token, or put invitations in registry records/background logs. Renew streams only through explicit resource ids on the client-participating control channel. Revocation detaches viewers without stopping agents; reconnect never replays uncertain writes. The shared production browser gateway also fronts Vite. Settings → Remote & Sync uses frontend-local `lib/host/remote-access.ts` over the current local/SSH transport; registration secrets travel through stdin and host inspection returns public metadata only.
- Mobile access uses self-hosted Better Auth Google/GitHub OAuth only (at least one provider, public signup with provider-verified email, no email/password delivery or recovery), separately trusted application delivery, maintained Noise XX and exact host-approved browser keys. Remote protocol 5 is separate from application protocol 26.1 and runtime protocol 1.0. Each host/profile has an independent registration, account binding, identity and browser grants under `remote/profiles/<profile_id>/`; the single supervised connector reloads only changed profiles. Remote leases carry a host-selected profile; daemon `security/profile-access.ts` checks HTTP access and filters WS events. Local/SSH leases stay host-wide. Profiles still share OS-level terminal/filesystem authority. Startup deletes legacy host-wide registrations and revokes their grants; no profile inherits them. Desktop-led account registration uses a five-minute browser-approved hash; its one-use verifier remains in frontend memory and goes only to the machine status/redemption endpoints. Host identity generation and browser approval remain on the host. `puddle remote … --profile <profile-id>` and Settings → Remote & Sync manage host registration, pairing, approval/revocation, disable and local/SSH-only identity reset; desktop settings also delete saved registrations, revoking browsers while retaining the host identity and revoked audit records. Deletion/replacement retires the old relay record through machine-only `/remote/unregister`; private `retired/` files under each registration retain at most 32 routing contexts for bounded, idempotent retry, including supervisor starts without an active config. Disable/offline hosts remain registered; never deduplicate by label. Deletion is capability-detected and never exposed through the encrypted remote admin protocol; configuration lives in `~/.puddle/remote`. The complete remote operation allowlist is `connector/src/policy.ts`. New remote operations require review there and in daemon `security/profile-access.ts`; never bypass the shared host lease boundary. See `docs/mobile-access.md` and `docs/acceptance/mobile-access.md`.
- Authentication verification uses isolated temporary homes, sanitised subprocess environments and deterministic fake agents. `test:e2e` exercises actual built frontend replacement; `test:ssh` provisions an ephemeral loopback SSH server. Browser/desktop rendering and interactive SSH acceptance remain manual in `docs/acceptance/connection-authority.md`.
- Puddle home initialisation migrates owned legacy `0755` directories to `0700` before authority access; never rely on `mkdir`'s mode to change an existing directory. Keep `scripts/install.sh` aligned with shared `initialisePrivateHome`; symlinked, foreign-owned and group/other-writable homes remain rejected, and authority subdirectories retain strict validation. Migration tests must include legacy permissions, not only private `mkdtemp` homes.
- Agent-specific behaviour (flags, env vars, session-file locations, status regexes, foreground process recognition) lives ONLY in that agent's folder under `packages/daemon/src/agents/<id>/`; `index.ts` exports its adapter. Shared contracts and provider-neutral helpers stay at the `agents/` root. Core session logic must stay agent-agnostic. When you verify a CLI flag against an installed agent version, record the version you checked in a comment in the adapter.
- Terminal-session agent icons are transient hints from `sessions/terminal-agent-monitor.ts`, using the main PTY’s foreground process ancestry and adapter-owned `matchesProcess` hooks. Never convert the placement to an agent, adopt its conversation, change its activity status, or inspect extra shell tabs to choose the session icon; clear hints on exit/suspension and retain terminal-blue styling. A separate notification observation uses the recognised main-PTY agent’s adapter patterns: explicit busy evidence arms one idle notification; a successful process scan can establish child exit, whereas suspension, backgrounding and inspection failure cannot.
- Desktop SSH authentication keeps only the latest askpass request per original SSH target; replace visible and queued stale requests, cancel on helper disconnect/SSH parent exit, and keep distinct hosts serial. Attach prompts to the target's frontend window (the connect dialogue/picker during initial connection), display the target, and cancel queued/visible requests and reject late helpers when that host closes. Never infer host identity from password/2FA prompt text or the focused window.
- Native file-manager reveal belongs in `cli/src/lib/host/file-manager.ts`, shared by local browser and desktop frontends. `GET/POST /frontend/file-manager` requires frontend browser authority and exact mutation Origin; advertise and dispatch only for the actual local target, never from a localhost URL heuristic. Keep paths bounded and absolute, pass literal OS arguments without a shell, recheck authority after filesystem inspection, and never open a file through its associated application. File rows, folders, empty tree space and path-backed tabs share the menu action; remote transports and older frontends omit it.
- Desktop forwarding links obtain an application-scoped proxy invitation in the authorised renderer before opening the system browser, which does not share Electron's login. Terminal links and port chips share `ports/forward-link.ts`; browser frontends keep the reusable landing page and synchronous tab opening.
- Desktop notification focus requires trusted typing, pasting or clicks inside the notifying session’s main terminal within five seconds; passive window/tab focus, scrolling and PTY output never suppress alerts. Desktop clicks explicitly activate or open the exact session tab even when its URL is already selected. Desktop notifications use bounded main-frame IPC and native Electron delivery; never treat the preload bridge as an OS permission grant. All desktops show host/project, session and preview in that order: native subtitle on macOS, escaped ToastGeneric text blocks on Windows (retain silent audio), and session-first body on Linux. Capability-detect `notificationSubtitles` before sending the optional subtitle to older shells. Settings exposes a test and the last delivery result, with permission/signing guidance for macOS `UNErrorDomain` code 1. macOS releases without a Developer ID certificate use an ad-hoc app signature, verified during release; unset empty `CSC_LINK`/`CSC_KEY_PASSWORD` before packaging and pass `--publish never` so only the release job publishes artefacts; never disable signing with `identity=null`, which leaves an unbound Electron linker signature. Notification delivery still requires system approval; removing quarantine is not notification authorisation, local ad-hoc delivery and click handling were verified manually; release signature checks never emit test notifications.
- Terminal URL and file-path links share `terminal/links/link-buffer.ts` for bounded wrap reconstruction and cell coordinates. Keep URL joins conservative (there is no host existence check); file paths retain resolve-validated alternatives. Standalone copied links are normalised in `terminal/clipboard/copy-text.ts`, preserving surrounding prose and other Markdown.
- Terminal Mermaid/LaTeX rendering reads bounded xterm buffer regions through `terminal/rich-output/rich-output-buffer.ts` and fits overlays to the original cells. Reuse the Markdown renderers and theme/security settings; never rewrite PTY bytes or resize its grid for rich output. Keep source toggles, selection, redraw invalidation, scrollback and alternate buffers covered.
- Experimental Ripple lives under `terminal/ripple/`: a bounded reading projection above the unchanged native input path. Share Markdown parsing and rich-content rendering with existing previews/overlays; keep session overrides local, the Appearance default off, and shell terminals native. It is not a conversation parser or a second terminal log.
- Terminal clipboard handling lives in `terminal/clipboard/clipboard.ts`: unsolicited OSC 52 writes are stashed; explicit copy gestures may accept one delayed reply. Keep replay/focus cancellation, clipboard-read denial and Command+C versus interrupt semantics covered. Agent-owned mouse selection remains intact.
- Outside tmux, Codex 0.157.1 skips OSC 52 after a successful native clipboard write unless an SSH marker exists. Its adapter supplies an empty `SSH_TTY` when absent (preserving real values); the separate lifecycle app-server retains its own environment. Clipboard acceptance must use separate host/client clipboards: same-machine native copying can mask missing terminal output. See `docs/reports/2026-09-26-codex-clipboard.md`.
- Terminal attach and disk snapshots must preserve mouse encoding as well as tracking. The pinned xterm serialiser omits encoding; `pty/xterm-mouse-encoding.ts` restores it from emulator state. Keep normal/alternate buffers, disabled tracking and encoding resets covered when changing this boundary.
- Compilable file support uses providers under `packages/daemon/src/`: generic mode/watch/run orchestration stays in `compilation/`, while tool discovery, command arguments, dependency parsing, artefact promotion, and source navigation stay in the provider (LaTeX in `latex/`). The web consumes advertised extensions, actions, eager support and artefacts; never hard-code a generic compile path to TeX. Code providers in `code/` run only on demand. Their only execution path is a terminal (25.0): clients open a fresh terminal placement in the source project/worktree, run from the source directory, and retain a shell after exit/interrupt. Compiled recipes build in that same terminal and execute a fresh managed binary only after a successful build. Never replay the command on resume; retain active run directories until their terminal exits. There is no captured-output fallback for programming languages. Notebook cells use Puddle Monaco editors over the shared JSON buffer, drafts, undo and conflict handling. Protocol 25.2 adds explicit cell/range execution and live output; header/open-tab Run All shares that path, while Run to Executed Copy retains compilation artefacts. Apply results by stable cell id and source snapshot without replacing newer edits, and preserve outputs during typing. `notebooks/` owns persistent Jupyter kernels keyed by canonical notebook path until explicit restart/shutdown or daemon exit; Interrupt preserves variables, dead kernels never replay a run, and live execution reuses the same bounded Jupyter bridge. Notebook Python selection (25.1) discovers incomplete environments too; only explicit installation invokes fixed packages through that interpreter's pip. Private temporary kernelspecs pin the exact Python, preserving venv symlinks; never overwrite host kernelspecs. New blank `.ipynb` files receive a version 4 notebook template, while saves of existing files remain literal. Shared bounded process execution lives in `compilation/process.ts`. Settings → Editor uses a language picker and the same command form as per-file tab settings. Resolve commands as file override → profile language default → source-aware provider default; preserve existing file overrides and keep host-specific commands out of portable settings sync.
- Agent storage lookup hooks, including `usageStats`, may be asynchronous. Any account-wide discovery must yield to the daemon event loop, bound file reads to the metadata actually needed, and reuse unchanged results across polls; putting synchronous filesystem work inside a background promise still freezes every API and PTY.
- Native conversation discovery returns normalised metadata only and never transcript bodies. The core owns eligibility, canonical-worktree mapping, watch debounce, adaptive fallback polling, missing confirmation, and placement materialisation; adapters own store roots and parsing. Exact live rebinding comes only from an adapter lifecycle channel — catalogue recency must never be used to guess the active conversation.
- Hook/plugin lifecycle channels declare an adapter-owned installed-version check; a failed or unsupported check must launch normally with `native_sync: fallback`, never claim full synchronisation optimistically.
- A live agent is an internal stable runtime whose `activeSessionId` may change after a native clear/resume/fork. Keep PTYs, shells, sidecars, environment, signal nonce, ports, logs/screens, and the one-runtime-per-conversation index together when changing this path; placement switching is serialised by the lifecycle mutex.
- Experimental external owners reuse `agents/defaults.ts` and adapter lifecycle resources. Runtime hook authority is separate from controller authority; only exact lifecycle observations can acquire profile/provider/native-ref claims. Codex disposal awaits app-server exit before ownership is released. Production sessions still use the in-process backend until the persistent-runtime roadmap gates pass.
- External runtime mutations carry the caller's explicit segment/placement address. Native switches clear the owner binding; commit segment history, placement effects and cursor in SQLite before `bind-placement`, then acknowledge events. Never fill a stale request from the client's latest state. Snapshot inspection preserves the owner's grid; resize is a separate fenced mutation.
- Daemon boot holds the runtime controller claim and reconciles authenticated external owners before legacy reconciliation. Commit retained events, immutable placement/segment changes, private environment/turn state and cursor together, then bind the owner and acknowledge history. Never expose private replies through public audit events or replay execution on failure. Durable prepared/running bindings stay protected even when an owner is unreachable; inspection alone never acknowledges events or proves owner death. Keep external ownership out of legacy PTY controls and auto-resume until their specific controls have external routing. Retry disconnected control streams without replaying commands; retire only under the exclusive owner claim, with delayed starts fenced and all final observations committed atomically. Missing/incomplete history cannot authorise resume. Confirmed terminal boot losses follow auto-resume; natural exits remain stopped. Agent loss stays explicitly resumable until supervisor cleanup proves provider descendants have ended. Release the controller only after application writers stop; daemon shutdown detaches external owners. Accepted update shutdowns also flush SQLite and persist their bounded exact-owner checkpoint before controller release. Invalidated dispatch, failed drainage or checkpoint publication must retain the controller and application storage; a checkpoint is not replacement-adoption proof. Application 25.8 exact-operation status nonces request fresh private adoption receipts. Require a newer controller, exact staged executables and all retained owner identities/cursors; interrupted owners never prove continuity. The worker also corroborates fresh host control and authenticated HTTP authority before accepting evidence; older receipts cannot satisfy a new nonce.
- Runtime helper sources stay provider-owned through `runtimeAssets`. External owners copy them once into private `helpers/`, record their digests and exact Node path, and keep mutable turn records in `hook-state/`. Shared account hook dispatchers and the OpenCode plugin loader must retain V1 selection/argument semantics for older live owners. Never fall back to mutable account code when a pinned helper is missing, and keep its executable/native release dependencies until the owner exits.
- Independent provider attention is one replaceable condition per owner, not an alert history. Clear it on resumed work, native switching and deliberate stop. Migration 038 commits exact condition/placement metadata and delivery claims; wait for settled reconciliation and recheck status, placement and stop intent after preview reads. Deliver only conditions at most five minutes old through existing profile-filtered notification paths. Claim before emitting to avoid restart duplicates; a lost delivery is not retried. Keep preview bodies out of runtime metadata/public audit, use adapter-owned native previews or an exact-condition bounded owner read, and suppress outstanding preview callbacks after daemon shutdown.
- Independent terminal owners reuse `TerminalAgentMonitor` with bounded process inspection of their main PTY only. Publish transient hints through authenticated owner state; disconnect clears the public hint. Busy evidence arms one idle condition; confirmed child exit may alert while the shell stays running. Clear prior attention on a changed foreground identity, lost hint or resumed work. Never infer child exit from suspension, backgrounding or inspection failure, inspect extra shells for the hint, convert terminal placement kind/status, or adopt a native conversation.
- Independent owners retain main-terminal OSC titles with exact segment/generation in the observation journal. Bound partial parsing, reset partial state and deduplication at native switches, and coalesce only within observation runs. Commit titles and cursors together; preserve historical placement titles, user overrides and native names. Extra shells must never rename the placement.
- Runtime service cleanup consumes migration 039's indexed queue of atomically ended bindings, at most 32 rows/four workers per pass. Acquire launch, dispatch and owner claims; validate the exact service target/user and retain retirement fences. Require positive registration absence through a reachable manager after unregistering, even after successful commands; errors remain pending. Reinspect historical removed records on repeated invocation. Completed database receipts suppress background repeats, but cannot prove current service absence for release collection. Drain cleanup before closing application writers. Keep registration removal distinct from orphan-descendant proof and reference-aware release/history collection; never delete pinned resources here or use cleanup receipts to auto-resume agents.
- The internal removal runtime phase under `host/removal/` acquires update/controller/installer exclusion before opening SQLite, requires an existing current schema without migration, and reuses runtime reconciliation and serial controls. Review binds exact owners, placements, native refs, terminal generations and pinned releases; output cursors and sizes do not change interruption impact. Keep retention distinct from stopping, refuse pending stop replay, and drain admitted work before releasing claims. Retain the outer removal guard across service shutdown and offline runtime handling; child commands inherit installation exclusion and the controller must drain before guard release. Internal service teardown reuses exact definition/process/shutdown checks, preserves definitions until confirmed shutdown, and requires controller ownership plus fresh supervisor absence before completing unregistration. The bounded private `installation/removal/services.json` record pins exact service reviews, original definition bytes and selected release; definitions may contain environment values and never leave host storage. Updates and removal share `host/installation/action-writer.ts` for durable serial intent. Reopening cannot repeat a consumed action; explicit inspection needs fresh process/service/source evidence. An active record fences daemon/selected-service startup, update ledger mutations and the embedded installer; status reads remain available, and missing selectors never authorise legacy bootstrap. Cancel only an entirely unattempted service plan under exclusion, atomically retaining one private cancelled review. Attempted removals require recovery. Internal `host/removal/restoration/` publishes and syncs original service definitions without replacement, records reload/enable intent and verifies consumed commands without replay. Retain controller/update/installer exclusion and the removal fence until fresh source/shutdown/enablement checks permit ordinary startup. Bound historical restoration records; never restore application data or change runtime selectors. Application 25.18 gates trusted local/SSH removal inspection and explicit restoration before `puddle install daemon` takes its already-installed shortcut. Export only bounded state/id; never private service sources. Pin the selected helper and exact removal id, require an existing journal for continuation, and observe an exact hand-off before ordinary authenticated startup. Application 25.19 connects public removal to durable remote disablement, service stops and a fresh offline runtime review. Retain by default; interactive approval or `--stop-runtimes` stops exactly reviewed owners. Record completion after controller drainage and bind it to a fresh attempt id so older receipts cannot complete failed attempts. Fence connector startup/re-enablement during removal. Keep persistent hosts out of legacy deletion. Application 25.20 adds coordinated `--purge` with separate runtime-stop consent, verified retirement and a kernel reboot barrier before fresh worktree review/deletion. Retain permanent locks/claims, pinned binaries and private recovery records; active purge fences installation/restoration even after data detachment. Continue bounded deletion only after positively acknowledged calls; lost replies are observation-only. Ordinary removal and upgrades need no reboot. Release collection runs through mandatory bounded maintenance outside the upkeep it pauses, retaining the current controller and update/installer claims. Reuse fresh reference review and exact inode quarantine. Runtime executable retirement requires an unchanged fence across verified kernel boots; update retirement requires ended groups and exact service removal. Preserve binding/native/replay data and archived terminal operations. Protect successful rollback history per component using ledger chronology; ambiguous archived ordering remains pinned. Full native platform/provider/reboot acceptance remains required. Runtime persistence health callbacks receive successful saves too; only actual degraded reports latch a failure, and one writer's success cannot clear another's failure.
- External runtime shell observations are private: never broadcast `env-delta` values to public subscribers or terminal output. The owner seeds capture separately from command overrides, enforces its gate/denylist/caps, and injects current values into new PTYs. Coalesce journal observations only between retained lifecycle/control barriers; commit their application effects and cursor before acknowledgement. Profile capture policy converges by inspecting owner state; extra shells take captured values from the owner. Purge returns the owner count only after its retained observation commits.
- Terminal and interactive/headless agent launches use `RuntimeLauncher` by default. Resolve the installed selector and inspect the host service manager before launch intent; missing support must not fall back to in-process PTYs. Only legacy migration fixtures supply `DaemonOptions.runtime: false`. Persist launch context and SQLite intent before one supervisor dispatch, hold the launch claim through adoption, and never fall back/replay after an uncertain reply. Retirement and service collection must acquire that claim too. Drain pending launches before closing writers. Pin per-runtime shell hooks once; missing pinned copies are errors. Seed terminal colours from the last frontend report before spawn; the owner answers OSC 10/11 for all its PTYs during controller loss. Reconcile newer colours through placement-fenced private updates, preserve them when a new daemon has no report, and capability-detect older owners by theme-state omission. Preserve baseline environment below captured values and explicit command overrides. Interactive launches seed exact preset refs or persist bounded pre-launch native-ref snapshots; ambiguous recovery fails and live rebinding requires exact lifecycle events. Owner version checks determine native synchronisation, never the presence of one hook event. Headless launches bind their initial native ref through the first structured turn; programme asks use durable operation-to-runtime/turn routing. Code-execution terminals use the same owners: commit canonical managed-run references with launch intent (migration 034), preserve them through failed/interrupted/unavailable owners, and prune only after confirmed clean owner exit. Explicit terminal resume never repeats the programme.
- External runtime controls retain the caller's placement through bounded serial queues and recheck request authority at dispatch, including project archive. Persist stop intent before sending once; lost acknowledgements require observation, never retransmission. Explicit stops suppress auto-resume. Archive waits for complete clean owner exit even after its main PTY has ended, and worktree pruning refuses unconfirmed external ownership/descendant cleanup even with force. Production creation/resume/migration and orphan cleanup remain enablement gates.
- External terminal viewers use the committed placement/segment/generation address. Preserve the snapshot cursor boundary, bound queued output/input, recheck lease/profile authority after awaits, and abandon queued commands after an uncertain response. Native switches or owner disconnection require a fresh attachment. Historical views read only their own immutable checkpoint. Keep `terminal_placements` ownership explicit when launching either backend; never choose an old external screen merely because a placement has runtime history.
- External runtime port discovery uses authenticated live inspection, exact committed placement/segment and current sidecar roots/hidden ports. Invalidate cached process scans on disconnect, native switches and terminal/provider changes; recheck validity after process listing. Historical or unavailable owners never fall through to saved PIDs or legacy roots. Bound cached owner references; forwarding uses the same scanner.
- External runtime live emulators keep runtime identity while raw logs use native-lifecycle segment ids and terminal generations. Boundary/exit checkpoints freeze the existing emulator queue; never reset terminal modes or move later output into an old segment. Missing checkpoints are explicit gaps, not permission to load another segment. Durable placement bindings, mutation fencing and production history-budget reclamation remain enablement gates.
- Runtime turn IPC uses monotonic runtime-local identities, exact native-ref admission and reserved result-journal capacity. Controller loss leaves accepted work running; recovery reads outcomes without resubmitting input. Migration 035 reserves private run/operation/runtime/turn/placement/segment/ref bindings before programme dispatch. Recheck profile and running-programme authority before sending or consuming results. Duplicate runner operations fail. Maintenance drains programme prompt dispatch separately from result observation; later runner RPCs wait within bounded admission and are discarded on shutdown. Daemon shutdown interrupts programmes while accepted external turns continue; explicit cancellation addresses only the original turn/placement and never retargets after native switching. Migration 036 records spawn ownership with its placement, then binds the exact runtime with launch intent. Durable programme stop requests fence pending spawns, and boot never automatically resumes an undispatched spawn. Cleanup targets recorded runtime ids, never a replacement in the old placement; report unconfirmed stops in programme events and retry only on explicit cancellation. Migration 037 marks only exact authorised programme reads consumed; this does not assert runner delivery. Reclaim oldest consumed terminal results under the 128-record/16 MiB owner limit, reserving worst-case reply bytes before dispatch. Keep unread/running outcomes protected and retain a durable monotonic turn watermark after pruning. Reclamation must roll back with failed intent/observation writes. Explicit unread-result disposition and host-wide storage accounting remain rollout gates.
- Codex 0.164+ interactive fallback uses `--no-daemon` when its lifecycle bridge cannot start. Keep it marked as degraded synchronisation and preserve older CLI arguments. A bare modern TUI may attach to a shared daemon that retains conversation ownership for 60 seconds after terminal exit; that lifetime must not escape a Puddle restart.
- OpenCode 2 interactive/headless launches use `--standalone`, including interactive integration fallback. OpenCode 1 keeps its existing private-server arguments. Never attach runtime work to an account-wide background server whose lifetime Puddle does not own.
- `AgentLaunchError` is a refusal, not an unavailable hook: runtime and legacy composition must propagate it without bare-CLI fallback. Use it when foreground-mode selection cannot verify the native CLI version.
- Adapters whose CLIs mint conversation ids (currently Codex and OpenCode) snapshot their existing account/cwd refs before spawn and resolve only a newly appeared ref; recovery validates cwd + native conversation creation time when catalogued, falling back to the placement creation time for legacy rows. Never recover them as merely "the newest conversation in this directory" — concurrent/shared-worktree sessions then collapse onto one agent session ref.
- **Resolved status finding (2026-08-03):** Codex 0.146.0's live idle composer is `› … <model> · <directory>` after ANSI stripping; the older `? for shortcuts` guess never appears. The adapter and Phase 7 acceptance table pin the observed regex. OpenCode and Gemini CLI status patterns remain awaiting live verification.
- Storage exhaustion must not interrupt live PTYs. `storage/` owns asynchronous capacity checks and bounded, coalesced runtime observation retries; log/snapshot writers own bounded history and retry backoff. User writes and native switches are never replayed. `logs/retention.ts` defaults inactive bulk logs to three days, preserving the exact replay tail, snapshots, shell history and terminal ids; never expire native conversations or worktrees. Keep GET `/api/storage` local/SSH-only (host-wide paths), and preserve 507 errors plus explicit unsaved-state warnings.
- Runtime lifetime lives in `runtime/lifecycle/`: prefer independent systemd/launchd jobs; an unavailable manager permits a detached owner only for an owned `nohup`/`none` installation marker. Label it `host_session`, verify its own process group and kernel boot before starting work, and block daemon replacement while limited/unknown owners run. Process-group separation and SIGHUP handling do not prove logout/cgroup survival. Never retry a recorded dispatch through another backend or signal arbitrary recorded PIDs during cleanup.
- SQLite is the source of truth for sessions; PTYs are ephemeral attachments. Schema changes require a migration in `packages/daemon/src/db/migrations/`.
- Independent runtimes share managed memory grants through `runtime/resources/host/`; initialise the sealed ledger before controller ownership, admit essential state before dispatch and retain the exact process-memory claim until OS exit. Screen, log, checkpoint, transport and adapter-owned bridge buffers spend that same allowance. Graceful runtime shutdown cannot refund a still-live process; only fenced exact retirement reclaims its grant. Idle returns and startup contention use bounded asynchronous retries. Adapter lifecycle contexts carry the allowance and an explicit unavailable-synchronisation report; memory pressure must not kill the native CLI or silently claim full synchronisation.
- Daemon release metadata derives its database ceiling from that migration list. Refuse opening a newer schema before writes; update preflight and the drained shutdown checkpoint must fit the candidate ceiling. This is existing SQLite migration evidence, not a fourth protocol or rollback permission. Never restore old application data over continuing runtime events.
- Every Git mutation shares the `WorktreeManager` mutex keyed by the canonical Git common directory (`gitMutexKey`), so linked worktrees, source-control actions, fetches, and worktree lifecycle commands cannot race Git's lock files.
- New repositories default to an empty `default_base_branch`; migration 023 clears all existing defaults once, preserving later explicit choices. An empty repository default follows the branch currently checked out at its registered clone path for each new agent/terminal (detached HEAD falls back to `main`). Resolve it under the Git mutex; keep the setting empty and existing placement branches fixed. Explicit session branches/directories take precedence. The new-session dialogue must not submit an automatic branch/directory preview as a fixed choice. Sharing the registered clone also accepts its current unborn branch before the first commit; resolve that directory before requiring a branch ref, without synthesising a commit.
- This is a public MIT repo: no company-, team-, or person-specific names anywhere (code, tests, docs, examples). Do not copy code from AGPL-licensed projects.
- **Terminology**: a "session" is always an immutable _Puddle placement_ (`sessions.id`: project + canonical worktree + conversation overlay). An agent's own thread is a "native conversation", stored in `agent_conversations`; its public identifier is the "agent session ref" joined onto `Session.agent_session_ref`. A live "runtime" owns the PTYs and may move between placements. Never conflate these three identities in code, comments, or UI copy.
- Design tokens in `packages/web/src/styles/tokens.css` are the single source for colour, type, radius, and spacing; the Tailwind config, xterm theme, and Monaco theme derive from them. Never hard-code a hex value or font stack in a component. UI conventions live in `SPEC.md` §12.
- Remote Web Push is an explicit device opt-in. Connector-local `/api/notifications/push` and `/test` bind to the admitted Noise device under its participating lease; browsers never supply a device id. The daemon sends a bounded conversation preview and exact placement ids over the owning profile’s private connector IPC after checking notification preferences and project mute. Adapter-owned `notificationOutput` reads exact bounded assistant text; other agents use the terminal emulator tail. Dispatch rechecks host enablement and exact device grants without creating or renewing a browser lease. The service stores private vendor subscriptions and VAPID keys, routes only opaque AES-GCM previews (legacy subscriptions retain generic alerts), restricts vendor destinations, and expires dead subscriptions. Capability-detect `remote_notifications`/`push_public_key`, then `remote_notification_previews` (daemon 22.5 plus connector) and `push_encrypted_previews` before exchanging a device preview key inside Noise. Keys never reach the service. Worker/native clicks carry validated project/session destinations and remote host ids across reloads. Every received push must show a notification (Safari’s visible-only requirement); opted-in mobile push also alerts while focused. Live delivery is suppressed for confirmed push bindings, and identical event tags replace racing alerts. Live web/mobile alerts and encrypted push use `[ABBRV] Session title`, sharing the project rail’s saved abbreviation or derived fallback through `shared/project-abbrev.ts` and the bounded title formatter. Prefix only the private push copy, preserving plain live event titles for native desktop subtitles. Never cache host content in the notification worker. Notification tests expose progress and results beside their controls, bound browser reads, and reconfirm the host subscription; late browser replies must not resume a timed-out test.
- Remote/mobile UI distils the frontend: reuse dashboard card content, session glyphs, shared dialogues and the new-session dialogue. Read each profile's desktop project/session order and use the shared ordering helper. The terminal title opens the shared dropdown for active-project sessions; the host/project breadcrumb returns home. Keep host catalogue connections separate from the singleton workspace transport, scope caches/drafts to service/account/host, and detach hidden terminals. The mobile session rail sits on the left and expands over the content from that edge; it fits five-character project labels, uses desktop gold controls with status-coloured session glyphs, and aligns its collapse control with the workspace toolbar. It shows only the active project's non-archived sessions; Files uses bounded tree/file reads and an eye toggle for the shared Markdown/HTML/media previews, including validated custom host roots. Long-pressing a file opens Download, using the same 8 MiB JSON `preview-asset` route as remote previews (21.1); pending saves cannot cross hosts or connection generations. PDF.js consumes fetched bytes directly because the remote CSP forbids blob requests; HTML scripts run only inside the sandboxed `/preview.html` shell with its separate response CSP, never by relaxing the app’s script policy. The terminal image picker shares desktop image paste, preserves images up to 4 MiB, recompresses larger originals up to 20 MiB with a notice, shows progress/cancellation, and inserts into the last-used input (composer draft or terminal) without submitting or crossing connection generations. Connector-local `paste-upload` stages at most one 4 MiB image per browser connection in acknowledged 64 KiB chunks, then dispatches the existing paste route under the host lease; feature-detect `remote_image_uploads` before calling it (21.2). Ordinary requests retain their 256 KiB cap. Remote allowlist additions belong in `connector/src/policy.ts` with denial tests for neighbouring operations.
- Collapsible disclosures use `components/ui/disclosure.tsx`: native keyboard semantics with a Lucide chevron, never browser triangle markers. Connected browsers share compact account-style cards; desktop wraps them in the shared disclosure, and pending identities remain visible before approval. Registration opens the browser directly from the UI click on the client machine, never through a daemon opener. Remote status polls must not disable or relabel controls; only explicit operations show pending state. Remote access and profile sync share Settings → Remote & Sync; both browser lists hide revoked records while the host retains the audit history.
- Shared terminal touch gestures distinguish quick scrolling from held local selection. Selection must never send agent mouse input or copy automatically; Copy requires an explicit tap. The same terminal menu offers Paste even on empty cells; read the clipboard only on tap, preserve xterm paste encoding without adding Enter, and cancel insertion after a terminal/host/connection change. Mobile file text uses native DOM selection with held-drag extension and the same Copy action, and its path dialogue resolves files/directories against the current browse root through the existing nil-session directory target.
- iOS terminal input lives in `terminal/input/ios-input.ts`: it keeps xterm's hidden textarea filled with blank padding (never typed text) so the spacebar trackpad requires two native caret steps per arrow key and ignores smaller movements, and forwards only keyless insertions/IME commits that would otherwise edit that padding. Never mirror or reconstruct the application's input; taps stay with xterm so mouse-aware applications receive them. Other platforms keep xterm's input unchanged. Key strips use `mobile/TerminalKey.tsx`: one-shot Ctrl/Opt/Shift modifiers live in `terminal/input/input.ts` and `touch-modifiers.ts`, accept CSI/SS3 arrows without consuming device replies, and unmodified arrows follow the live cursor mode. Keys activate on touch release, and `keepTerminalFocus` makes any strip tap keep or raise the keyboard.
- Editor view state lives in bounded browser-local stores under `features/editor/`, scoped to transport and tab/layout identity. Save Monaco state before model disposal; consume explicit source reveals once. Restore preview positions before publishing scroll, and terminal positions only after replay. PDF tabs use the owned PDF.js viewer; only generated LaTeX PDFs enable inverse SyncTeX. Restore after page geometry is ready, anchor pinch zoom after layout, and never capture loading or hidden zero-sized surfaces.
- Every hook in a React component runs **above** that component's loading gate. `pnpm lint` enforces `react-hooks/rules-of-hooks`: a hook after an early return changes the hook count when the gate flips and React blanks the whole page (this shipped once, in v0.0.22).
- Layout-tree node ids are **unique within a tree** (`layout-tree.ts` "Node identity"). Anything that COPIES a tree re-ids the copy (`reidNodes`) and anything that combines trees deduplicates (`dedupeIds`): ids are the tiling area's React keys and resizable-panel ids, so a repeat aliases panes and throws "Panel ids must be unique" mid-render (this shipped in v0.0.22–v0.0.23, when it blanked every window).
- A render throw is now caught (`components/error-boundary.tsx`, mounted around the routed view and at the root — SPEC §12), so a crash is a legible message rather than a white page. That is a net, NOT a licence: it neither fixes nor hides anything, the console still gets the error and component stack, and the two invariants above are still what keep the app rendering.
- Prefer small modules with one responsibility over utils grab-bags. If a file passes ~300 lines, look for a seam.
- Web production builds use `vite.build.config.ts` with only web dependencies; the default `vite.config.ts` adds the authenticated development frontend gateway. Keep CLI imports out of the production configuration so filtered Docker installs remain buildable.
- Remote runtime images explicitly make package metadata, configuration and public assets readable by their unprivileged users. The service's `/data` must start at mode `0700`, owned by UID 10001: Docker copies this metadata into fresh volumes. CI builds from a private checkout and runs `node deploy/remote/test-images.mjs` with a real service volume, read-only filesystems and dropped capabilities; never rely on the operator's umask or relax permissions on deployment secrets. The app's Caddy binary must have no privileged-port file capability: it serves port 8080.

- Remote Settings pairs this device through `PairDeviceDialog` (camera or pasted link); host registration starts on desktop. Keep scans inside the current app context so a Home Screen app uses its own IndexedDB identity. Validate invitations through the shared schema and retain exact host approval. Camera frames are decoded locally, and tracks stop on dismissal/backgrounding, including late permission grants. The application permits its own camera; sandboxed previews deny it.

## Housekeeping — read this, future agents

Huddle implementation follows `docs/roadmap/huddle.md`; record shipped contracts,
tests and open gates in `docs/acceptance/huddle.md`. Definitions live separately
under `.puddle/huddle/<random-hex-id>/` in the explicitly declared worktree. Shared
graph/value/binding validation lives in `shared/src/huddle/validation/`; keep it
data-only and do not infer runtime support from the existence of document schemas.
`runtime/huddle/state/` retains a separate private ledger with atomic cursor,
activation and operation records. Never reset dispatch consumption after a lost
reply, and reserve outcome storage before external work. Ledger recovery assumes
the lifecycle caller has fenced outgoing workers; it is not process-death proof.
`runtime/huddle/execution/` routes captured graphs with durable correlated joins;
never join different root events, event emissions or feedback activations, or
acknowledge fan-out before every downstream admission commits. The scheduler
records routing failures and cancels dependent work. `runtime/huddle/owner.ts`
composes an independent process with private control under `transport/`, sharing
runtime claims, host memory grants and lifetime checks. Public lifecycle
admission is exposed through the routes below; attach/ask dispatch now shares
the ordinary runtime turn service.
Do not infer support for an operation from entry-point existence.
Application 27.0 adds the closed `huddle` session kind. Migration 43 and
`db/stores/huddle/placements.ts` retain one immutable placement per
project/canonical worktree/definition. The common runtime inventory records its
role/capabilities without a terminal segment; preserve ordinary launch fingerprints
and protocol 1.1. Application 27.1 exposes local/SSH inactive authoring
through `huddle/control/service.ts` and `http/routes/execution/huddle/`. Require
explicit registered project/worktree roots, recheck request authority and selected
runtime support after async work, and never arm or launch during create/open.
Source publication may outlive a failed placement insertion; retain it for
discovery/open and never retry creation after a lost reply. Existing placement
opens and read-only inspection do not require a capable current default. Deny
remote profile leases. Callers must check scope and runtime support before new
placement intent; keep huddles out of ordinary session
creation, PTY controls and runtime restart. `runtime/huddle/controller/` supplies
role-aware discovery, observation and retirement. Keep huddle clients separate
from PTY clients under the existing controller claim. Persist observation versions
before notifying; project session status/cursor atomically and never replay work
on reconnect. Include this projector in maintenance pause/drain. Only exact clean
exit plus launch/owner/memory claims releases ownership; a crash retains unresolved
resources and never enters ordinary auto-resume or onboarding. Selected-daemon
startup uses `host/startup/huddles.ts` to check retained requirements read-only
before service mutations and after asynchronous supervisor probes. Bound the
inventory and per-row contract bytes, use passive metadata, and never migrate or
replay work during inspection. Compatible startup remains available for interrupted
owners' inspection/recovery; it is not proof that they recovered.
`RuntimeLauncher.launchHuddle` shares ordinary launch admission and supervision,
requires an installed capable release, validates captured activation before intent
and observes uncertain dispatch without fallback. `runtime/huddle/lifecycle/` owns
the role-specific preparation; `controller/controls.ts` serialises exact-owner
Apply/Arm/Run/Interrupt/Stop. Apply/Arm/Run/Interrupt require an inspected owner and
activation through `controller/observations.ts`; compare inside the queue and
recheck authority/Stop synchronously at dispatch. Copy queued inputs. The internal
`records` method binds one live owner and validates bounded history pages through
`controller/history.ts`; ordinal cursors enumerate rows, not outcome updates.
Refresh earlier pages for changed outcomes. Application 28.2 exposes local/SSH
lifecycle and history through `huddle/execution/` and `http/routes/execution/huddle/`.
Start/Apply use `HuddleService.withSnapshot` under the repository lock and require
an inspected saved digest. Rearm retains the current activation. Public schemas
explicitly project owner/ledger data; never return private launch evidence or
operation inputs/targets. Recheck declared worktree bindings after async admission.
The installation event id in `huddle-host.json` is not authority. Agent bridges,
custom trigger/readout adapters, stopped-owner history and active revision detail
remain pending; unsupported execution is rejected before launch.
Migration 45 adds `huddle_runtime_turns`. Host-side exact asks live under
`huddle/operations/turns/`, reusing `RuntimeProgrammeTurns.askFor` and the common
busy gate. Shared ordered allocation/result reservation lives in
`db/stores/runtime-results/admission.ts`; never allocate huddle and programme turn
numbers independently. Private bridge authority must bind the exact owner,
invocation, declared worktree/agent and request before using this adapter. Read
huddle outcomes without marking them consumed; acknowledge only after the owner
has durably stored the exact result. Preserve operation identity after rejection,
revocation, acknowledgement and reclamation. Observation/cancellation of admitted
work must not imply new-dispatch authority. `runtime/huddle/operations/` owns the
durable script ask queue and declared session/worktree resolution. Optional
`operations: 1` enables private page/claim/settle commands; preserve legacy owner
metadata and never claim twice after a lost reply. Store exact outcome/receipt
before replying, and retain late results without routing interrupted graph output.
`huddle/operations/dispatch/` now composes the automatic loop with the same
`RuntimeProgrammeTurns` instance as ordinary puddlang. Capability `operations: 2`
adds explicit unsent/unknown failures; only supporting owners admit agent graphs.
`huddle/execution/agents.ts` resolves explicit session UUIDs to exact live agents in
the declared project/worktree. Recheck bindings before activation. Migration 46
persists one cancellation attempt before its exact send. Pause/drain this dispatcher
before connections/projection; shutdown preserves admitted agent turns. Never
redispatch consumed operations during adoption. Spawn/resume remains unfinished.
Application 28.3 adds local/SSH component template publication. Keep editable agent
template assets in `shared/huddle/templates/`, publication in `daemon/huddle/templates/`
and graph insertion in the web document/inspector layer. Template publication never
changes the graph or starts an owner, and never overwrites differing user source.
Lost replies require source inspection. Prompt/review nodes declare worktree and
agent settings and use existing attach/ask; they require operation capability 2 at
activation. The inspector shares ordinary worktree-file queries for saved local
contracts; unresolved/invalid contracts must not silently fall back to stale captured
settings once the read settles. Resource choices come from existing project/worktree
queries; server activation still resolves exact bindings. See `docs/huddle.md`.
Migration 44 persists Stop consumption before sending
shutdown; repeat observation cannot send another Stop. The existing kill/archive
paths delegate to these controls and refuse unresolved owner cleanup. Keep huddle
controls in the common maintenance pause/drain. Automatic service cleanup excludes
interrupted huddles until descendant recovery is proven. A never-consumed attempt
can retire under all owner/launch claims and a durable fence; missing consumed-owner
state cannot. Application 28.0 adds huddle tabs and the initial sidebar/create/inspect UI under
`web/features/huddle/{documents,canvas}/`. Huddle refs use placement ids but never
enter terminal keep-alive, stdin, ordinary Resume or provider controls. Keep kind
selection in `sessionTabRef`, and preserve duplicate huddle views when closing one.
Desktop persistence is format 4 (migrate 2/3); require `windows.huddles` before
opening or saving huddle-containing working sets, including parked project slices.
Keep source links on the existing editor path. `web/features/huddle/execution/`
owns application-28.2 lifecycle/input reviews and paged live history. Start/Apply
use freshly inspected saved source; Run uses the reviewed active target without
saving. Local dirty definition buffers block source activation. Share pending and
uncertain-command state per placement within the renderer, and never retry or
queue mutations on reconnect. Explicit runtime/history inspection clears the
review barrier after a failure; failed observation leaves it intact. Poll only
focused runtime/visible history pages and stop polling after errors. Do not infer
that saved source is the active revision, or that acceptance means completion.
Manifest graph editing uses the shared `huddle.json` editor model, existing conditional file
saves/drafts/conflicts and undo history. `tabHoldsFile` recognises manifest ownership
for window transfers, close review, arrangements and model retention. Keep source
holders when a graph closes, and retain both source tabs when its session is archived.
The save registry retains every mounted holder. Application 28.4 makes `layout.json`
a second shared editor buffer: huddle tab dirty/close/transfer/arrangement ownership
must cover both files. Missing layouts use a clean virtual document with baseline
-1 only after validating the sibling definition. Worktree-file PUT with expected
mtime -1 uses exclusive creation; never silently overwrite a concurrent creator.
Feature-gate absent-file creation on 28.4. Keep pointer previews local until commit,
cancel stale-layout gestures and retain separate graph/layout undo histories.
Save both documents through ordinary file guards without claiming atomicity.
Canvas connection gestures live under `canvas/connections/`; node islands own
separate header and port buttons, never nested interactive controls. Socket and
selector edits share `documents/graph-connections.ts`, manifest undo and normal
source conflict handling. Reject stale gestures, duplicate routes and definitely
incompatible ports; retain validation for cycles so users can configure bounded
feedback. UI wiring must never execute a node. Full resource settings beyond
worktree/session selection, external component observation, large-graph culling
and retained graph camera/selection remain unfinished.
Optional huddle `timers: 1` supports fixed-duration interval triggers. Keep owner
scheduling under `runtime/huddle/triggers/`, durable progress in `state/intervals.ts`
and shared contracts under `runtime/huddle/triggers/`. Event admission and schedule
progress commit in one ledger transaction. One deadline timer serves at most 32
interval nodes; cap each wake-up at 64 admissions, charge retained timer memory and
share graph budgets. Stop timers before lifecycle waits and on persistence failure.
Validate selected/live timer support before launch/Apply, preserving old owners.
New arming generations reset anchors; never catch up stopped time or replay an
admitted occurrence. Reuse the source-location check before autonomous admission.
Optional `calendar: 1` adds one-off dates and daily/weekday timezone schedules.
Keep civil-time conversion under `triggers/calendar/` with daemon-only Temporal;
never use the renderer's timezone or hand-roll DST offsets. Skip missing local
times and select the earlier overlap. `state/schedules.ts` commits admitted instants
and one-off dispositions atomically with events. Preserve consumed dates across
Resume; only a new activation resets them. Calendar Resume skips paused time and
cannot move its cursor backwards. Bound lookback to 366 days, plans to 64 events
per source and 32 calendar/date sources; share the single timer and 64-admission
wake limit with intervals. Reserve calendar plan memory, release after the last
one-off, and cache deadlines between progress changes. Validate named zones and
exact date offsets before activation. Keep old owner capabilities supported and
require the new capability before launch/Apply. Do not claim reboot recovery.
Application 28.1 adds revision-checked `PUT /api/huddle/:profile/definitions/:id`:
one manifest/layout publication per request, under the repository mutation lock.
`huddle/definitions/save.ts` stages, rechecks captured source/authority and renames
without an intervening await. Never equate saving with activation, or retry a lost
save with a substituted digest; inspect the source first. External editors do not
participate in this lock. Use existing editor draft/conflict ownership for the IDE.
`runtime/huddle/ownership/` owns shared exact-binding and clean-retirement evidence;
import it directly from adoption, maintenance and collection. Offline removal adopts
both roles; `host/removal/runtimes/` separates their interruption reviews. Recheck
huddle activation/impact and authority inside its Stop queue before consuming intent.
Purge fencing and release collection require clean final or never-consumed evidence;
retain unresolved workers and bindings. The existing later-boot barrier still gates
reference retirement/deletion. Keep huddle source, revisions, ledger and history.
Host-update checkpoints retain each huddle's id and required contracts. Preflight,
activation and recovery require explicit candidate support from separate
`DAEMON_RUNTIME_CAPABILITIES.json`; keep historical `HOST_CAPABILITIES.json` closed.
Bind this metadata and owner role/contracts into approval. Fresh adoption inspects
huddle state and settled projection, never terminal history. Restart recovery uses
huddle launch/state readers and includes owners created after the original checkpoint.
Reject unresolved interrupted inventory; inspection never replays or rearms work.
Runtime-role metadata lives separately in `RUNTIME_CAPABILITIES.json`; huddle
selection must validate exact build/protocol/contracts/helpers and recheck the
selected generation before intent. Keep historical host capability and ordinary
runtime readers compatible. Live huddle adoption verifies pinned capabilities. A consumed
launch cannot restart without separately fenced recovery. Source publication is separate from Apply/arming;
keep accepted executions bound to their original activation through later edits.
`runtime/huddle/workers/` executes captured component closures in isolated children;
pin its runtime assets and preserve bounded owner acknowledgements. Unknown child
termination never permits replay. Shared agent client semantics live in
`puddlang/client.ts`; archive helper entries live in `scripts/lib/puddlang-build.mjs`.
The user permits breaking puddlang redesign during huddle work, while existing
agent/terminal runtime compatibility remains required. Organise each layer by
responsibility and keep UI, runtime, source definitions and private state separate.

Notebook widgets use a persistent, separately addressed Jupyter IOPub subscriber
alongside cell execution. Protocol 25.4 exposes bounded widget snapshots/events
and explicit comm writes tied to the current kernel generation; reconnect only
observes and must never replay a widget action. Keep Output capture owned by this
subscriber between runs, binary buffer paths intact, and remote notebook access
denied by both the connector and profile authority. The official HTML widget manager
runs only in an opaque-origin iframe with a validated comm-only MessagePort. Bundle
core controls locally; load compatible AMD extensions by their declared npm
module/version, requiring explicit consent for saved notebook extensions. Never
expose frontend credentials or execution APIs to widget code, relax the main CSP,
or execute widgets in remote/mobile previews. Persist state through the shared
notebook draft, including executed-copy metadata. See the Jupyter integration
audit in `docs/reports/2026-10-25-jupyter-integration.md`. CI provisions an isolated,
pinned Python environment for real-kernel and Chromium widget tests; keep saved
state, binary uploads, reconnect and echo-disabled persistence covered.

This file is living documentation and part of the definition of done for every change:

- If your change alters the repo map, commands, conventions, adapter interface, or resolves an open question from `SPEC.md` §15 — update this file (and `SPEC.md` where relevant) **in the same commit**.
- **`SPEC.md` must never drift from the code.** Any change to API surface, data model, behaviour, or design decisions updates the corresponding SPEC section in the same commit — an endpoint, flag, or colour that exists only in code (or only in SPEC) is a bug.
- Prune as you go: stale instructions are worse than missing ones. If you find a section here that no longer matches the code, fix it even if your task didn't touch it.
- Keep this file skimmable. Details belong in `SPEC.md` or code comments; this file is the map, not the territory.
- Record resolved design decisions (e.g. "codex resume verified as `codex resume <id>` on v0.x.y") in the place a future agent will look first: the adapter comment, and a line in the changelog.

## Changelog discipline

CI runs only on pushed release tags (`v*`) or explicit check tags (`ci` or
`ci/**`), not ordinary branch pushes or pull requests. To check a commit without
releasing, use a unique tag such as `git tag ci/check-name <commit>` followed by
`git push origin ci/check-name`. CI tags never invoke release publishing.

CI and release jobs install dependencies through `scripts/install-ci.mjs`, which
uses the running Node installation's bundled headers for native source builds.
Keep that header override scoped to installation so Electron packaging can use
its own headers; preserve the Linux release compiler and ABI settings.
Linux archive release jobs use a Rocky container with `--init` and
`procps-ng`. Run `scripts/check-runtime-test-host.mjs` before packaging and the
packaged runtime continuity test afterwards in the release workflow. Ordinary CI
retains archive smoke tests on its hosted Ubuntu runner. Detached fixture
services need actual orphan reaping; never accept a zombie PID/group as absent
or relax production lifetime checks to accommodate a container without an init.
Packaged continuity follows the archive's component manifest, installing the
published runtime before the daemon. Retained components use checksummed release
downloads from `GITHUB_REPOSITORY` (or `PUDDLE_REPO` for local acceptance); never
select an unpublished bundled component just to make the fixture pass.

The npm release job uses GitHub OIDC trusted publishing, with npm 11.21.0 and
job-scoped `id-token: write`; it never reads `NPM_TOKEN`. Configure the package's
trusted publisher for this repository and `release.yml`, with direct publishing
allowed and no environment name. Keep the source checkout on the triggering
release tag so npm provenance names the built commit. See SPEC §10 for recovery.

`CHANGELOG.md` in the repo root is the **rolling changelog for the next release**. Rules:

1. Every user-visible or behaviour-affecting change updates `CHANGELOG.md` **in the same commit/PR** as the change. Internal-only refactors with zero behaviour change may be skipped.
2. Keep one `## [Unreleased]` section grouped under `### Frontend`, `### Daemon`, `### Runtime` and `### Remote`, in that order. These component headings and their anchors are shared with the release-notes UI; preserve them. Within each component, nest the established change categories as `#### Added`, `#### Changed` and `#### Fixed`, in that order, omitting empty categories. Do not flatten the categories or replace the component headings. Put each user-visible item in its most relevant component once. Use one line per change, imperative mood, and reference the PR/issue when it exists.
3. **On publishing version X.Y.Z**:
   - Generate and review the canonical format 2 `release-manifest.json` with `node scripts/plan-release.mjs --version X.Y.Z --base v<previous-release> --components auto` (or `all` / an explicit component list). Release assets include canonical `release-manifest-v2.json` and a generated format 1 `release-manifest.json` for deployed clients; host archives embed both manifests for old installers. The first manifest-aware release must publish all components. CI validates the exact tag; frontend always publishes, skipped host components retain their previous versions. Compare changes against each component's last published tag, not merely the previous frontend release. Never omit shared protocol/build/helper changes without reviewing compatibility. See SPEC §10.
   - Append `X.Y.Z` and that release's exact protocol to `RELEASE_PROTOCOLS` in `packages/cli/src/lib/installation/component-versions.ts`; this immutable offline ledger identifies older installed components without executing them. Daemon archives also carry `CONNECTOR_PROTOCOL`; keep the historical connector lookup in that module accurate. The displayed `cN` suffix is informational and never enters CLI/desktop compatibility checks.
   - Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
   - Copy the file to `docs/changelogs/CHANGELOG-vX.Y.Z.md` (this is the permanent archive).
   - Reset the root `CHANGELOG.md` to the empty template (see the file's header comment), pointing at `docs/changelogs/` for history.
4. Never edit archived changelogs in `docs/changelogs/` except to fix factual errors.
